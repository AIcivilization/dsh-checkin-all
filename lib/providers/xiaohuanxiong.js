// lib/providers/xiaohuanxiong.js — 商汤小浣熊（xiaohuanxiong.com）每日积分
//
// 小浣熊没有「点一下签到」的按钮，它的打卡是**登录即发**：
//   每天 00:00（北京时间）服务端自动发当日额度（免费版 300 积分/日），
//   当日登录会把有效期从「当天 24:00」延长到 7 天。
// 所以这里的「签到」= 用已登录的身份调一次接口，把当日额度确认下来 + 续期。
//
// 接口（官网 web 端自己在用的，都在 https://xiaohuanxiong.com）：
//   GET  /api/web/points/v1/balance                     账户余额：available_points / enterprise_topup_points / user_category
//   GET  /api/web/points/v2/bills?paging.limit=N&type=all 积分流水：biz_type=daily_grant / daily_expire / …
//   POST /api/web/auth/v1/devices_current_heartbeat      登录心跳（X-Client-Platform / X-Client-Version / X-Client-Device-ID）
//
// 鉴权：cookie `xhx_token`（新版 IAM）或旧版 `<prefix>raccoon_token`；
//       也接受直接给 Bearer token。两条都发，服务端认哪个都行。
//
// 凭据：secrets.json 的 manual.xiaohuanxiong.accounts[]，字段 cookie 或 token。

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { addAccount, listAccounts } from '../checkin-secrets.js'
import { pluginHome } from '../paths.js'
import { CHECKIN_TZ, beijingDayKey } from '../tz.js'
import { OUTCOME, mergeAccountResults } from './base.js'
import { LOGIN_TIMEOUT_MS, LOGIN_URL, chromeExecutable, runBrowserLogin } from './xiaohuanxiong-login.js'

const HOST = 'https://xiaohuanxiong.com'
const TIMEOUT_MS = 20_000

const HEADERS = {
  accept: 'application/json',
  'accept-language': 'zh-CN,zh;q=0.9',
  origin: HOST,
  referer: `${HOST}/work/home`,
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}

/** 免费版每日额度，余额接口读不到时的兜底文案用 */
export const FREE_DAILY_POINTS = 300

/** 从整条 Cookie 里挑出 token（新版 xhx_token，旧版 *raccoon_token） */
export function tokenFromCookie(cookie) {
  const parts = String(cookie || '').split(/;\s*/)
  const get = (name) => {
    for (const part of parts) {
      const i = part.indexOf('=')
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
    }
    return undefined
  }
  const direct = get('xhx_token')
  if (direct) return direct
  for (const part of parts) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    if (/raccoon_token$/.test(part.slice(0, i).trim())) return part.slice(i + 1).trim()
  }
  return undefined
}

/** 一个账号的鉴权信息：cookie 整条 / token 裸串都认 */
export function authOf(account) {
  const cookie = String((account && account.cookie) || '').trim()
  const rawToken = String((account && account.token) || '').trim().replace(/^Bearer\s+/i, '')
  if (cookie) {
    return { cookie, token: rawToken || tokenFromCookie(cookie) || '' }
  }
  if (rawToken) {
    // 只给了 token：同时塞进 cookie，服务端两种都认
    return { cookie: `xhx_token=${rawToken}`, token: rawToken }
  }
  return {}
}

/** 设备 ID：同一个账号每次都一样，服务端才不会把心跳当新设备 */
export function deviceIdOf(auth, account) {
  const given = String((account && account.device_id) || '').trim()
  if (given) return given
  const seed = auth.token || auth.cookie || 'raccoon'
  const hex = createHash('sha256').update(`dsh-checkin-all:${seed}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function authHeaders(auth) {
  const headers = { ...HEADERS }
  if (auth.cookie) headers.cookie = auth.cookie
  if (auth.token) headers.authorization = `Bearer ${auth.token}`
  return headers
}

/** 发一个请求；返回 { ok, status, json, text, code, message } */
async function call(path, { method = 'GET', auth, headers = {}, body } = {}) {
  const init = {
    method,
    headers: { ...authHeaders(auth), ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers['content-type'] = 'application/json'
  }
  let response
  try {
    response = await fetch(`${HOST}${path}`, init)
  } catch (error) {
    return { ok: false, networkError: error.message }
  }
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  const code = json && typeof json.code === 'number' ? json.code : null
  const message = (json && (json.message || json.detail)) || (text || '').slice(0, 200)
  const unauthorized = response.status === 401
    || code === 200001 || code === 200003
    || /authorization/i.test(String(message || ''))
  return { ok: response.ok && !unauthorized, status: response.status, json, text, code, message, unauthorized }
}

function needLogin(detail) {
  return Object.assign(
    new Error(`小浣熊登录已失效（${detail}）：在浏览器打开 xiaohuanxiong.com 重新登录，把 Cookie 里的 xhx_token 复制到面板「配置凭据」`),
    { code: 'XHX_NEEDS_LOGIN' },
  )
}

/** 余额接口：available_points 等 */
async function fetchBalance(auth) {
  const res = await call('/api/web/points/v1/balance', { auth })
  if (res.networkError) {
    throw Object.assign(new Error(`连不上小浣熊：${res.networkError}`), { code: 'XHX_NETWORK' })
  }
  if (res.unauthorized) throw needLogin(res.message || `HTTP ${res.status}`)
  if (!res.ok || !res.json) {
    throw Object.assign(new Error(`小浣熊余额接口异常（HTTP ${res.status}）`), { code: 'XHX_HTTP_ERROR', detail: res.text })
  }
  const data = res.json.data || res.json
  return {
    availablePoints: Number(data.available_points) || 0,
    enterpriseTopupPoints: Number(data.enterprise_topup_points) || 0,
    userCategory: data.user_category || '',
    proExpiredAt: data.pro_office_expired_time || '',
  }
}

/** 积分流水：items[] */
async function fetchBills(auth, limit = 20) {
  const res = await call(`/api/web/points/v2/bills?paging.limit=${limit}&type=all`, { auth })
  if (res.networkError) {
    throw Object.assign(new Error(`连不上小浣熊：${res.networkError}`), { code: 'XHX_NETWORK' })
  }
  if (res.unauthorized) throw needLogin(res.message || `HTTP ${res.status}`)
  if (!res.ok || !res.json) {
    throw Object.assign(new Error(`小浣熊流水接口异常（HTTP ${res.status}）`), { code: 'XHX_HTTP_ERROR', detail: res.text })
  }
  const data = res.json.data || res.json
  return Array.isArray(data.items) ? data.items : []
}

/** 登录心跳：顺手把当日额度有效期续到 7 天 */
async function heartbeat(auth, account) {
  return call('/api/web/auth/v1/devices_current_heartbeat', {
    method: 'POST',
    auth,
    body: {},
    headers: {
      'x-client-platform': String((account && account.platform) || 'web'),
      'x-client-version': String((account && account.version) || ''),
      'x-client-device-id': deviceIdOf(auth, account),
    },
  })
}

/** 今天（北京时间）到账的那笔每日积分；没有就 null */
export function findTodayGrant(items, day = beijingDayKey()) {
  if (!Array.isArray(items)) return null
  for (const item of items) {
    if (!item || item.biz_type !== 'daily_grant') continue
    const at = item.grant_at || item.created_at
    if (!at) continue
    const ms = Date.parse(at)
    if (!Number.isFinite(ms)) continue
    if (beijingDayKey(new Date(ms)) === day) return item
  }
  return null
}

/** 今天到期的每日积分（服务端会另记一笔 daily_expire） */
export function findTodayExpire(items, day = beijingDayKey()) {
  if (!Array.isArray(items)) return null
  for (const item of items) {
    if (!item || item.biz_type !== 'daily_expire') continue
    const at = item.grant_at || item.created_at
    const ms = Date.parse(at || '')
    if (!Number.isFinite(ms)) continue
    if (beijingDayKey(new Date(ms)) === day) return item
  }
  return null
}

/**
 * 归一化成面板认的「一天一张表」。
 * 小浣熊只有「今日额度」这一个格子，所以 days 只有今天一条。
 */
export function normalizeXhxPanel({ balance, bills, day = beijingDayKey() } = {}) {
  const grant = findTodayGrant(bills, day)
  const expire = findTodayExpire(bills, day)
  const points = grant ? Number(grant.points) || 0 : 0
  const claimed = Boolean(grant)
  // 没到账时格子显示「今天该有多少」，不然「可领取 +0」看不出东西
  const displayPoints = claimed ? points : FREE_DAILY_POINTS
  const available = balance ? Number(balance.availablePoints) || 0 : 0
  const dayCell = {
    dayNo: 1,
    date: day,
    points: displayPoints,
    bonusPoints: 0,
    status: claimed ? 3 : 2,
    isToday: true,
  }
  const description = claimed
    ? `今天已到账 +${points || FREE_DAILY_POINTS} 积分${expire ? '，当日额度已清零（登录后有效期延长至 7 天）' : ''}`
    : '今天的每日积分还没到账（服务端 00:00 自动发），点「立刻签到」去确认一次'
  return {
    style: 'daily',
    days: [dayCell],
    today: dayCell,
    claimable: !claimed,
    claimedDays: claimed ? 1 : 0,
    totalPoints: points,
    expectedPoints: FREE_DAILY_POINTS,
    accountCredits: available,
    timeZone: CHECKIN_TZ,
    description,
    dailyGrantPoints: points,
    expireAt: (grant && grant.expire_at) || '',
    userCategory: balance ? balance.userCategory : '',
  }
}

export function describeXhxPanel(panel) {
  if (!panel) return '小浣熊签到表读不出来'
  if (panel.claimable) return '今天还没确认到账（每日积分 00:00 自动发，登录一次即可续期）'
  return `今天已到账 +${panel.dailyGrantPoints} 积分，账户可用 ${panel.accountCredits} 积分`
}

export function createXiaohuanxiongProvider({ log = () => {}, env = process.env, loginRun = runBrowserLogin } = {}) {
  const accountsOf = async () => listAccounts('xiaohuanxiong', env)
  /** 登录用的 Chrome profile：留在插件目录里，下次登录往往还是登录态 */
  const loginProfileDir = (e = env) => join(pluginHome(e), 'browser', 'xiaohuanxiong')
  /** 当前正在等的登录（loginStart 起，loginWait 收） */
  let pending = null

  const account = async () => {
    const accounts = await accountsOf()
    const usable = accounts.filter((a) => authOf(a).cookie || authOf(a).token)
    if (!usable.length) {
      return {
        loggedIn: false,
        label: '未配置',
        detail: '在「配置凭据」里粘贴 xhx_token（浏览器开发者工具 → Cookie）',
        code: 'XHX_NOT_CONFIGURED',
      }
    }
    const names = usable.map((a) => a.name || `#${a.id}`).join('、')
    return {
      loggedIn: true,
      label: usable.length > 1 ? `已登录 ${usable.length} 个账号` : '已登录',
      detail: `xhx_token · ${names}`,
      accounts: usable.length,
      accountList: usable.map((a) => ({ id: a.id, name: a.name || '' })),
    }
  }

  const panelOf = async () => {
    const accounts = await accountsOf()
    const first = accounts.find((a) => authOf(a).cookie || authOf(a).token)
    if (!first) {
      throw Object.assign(new Error('小浣熊还没配凭据'), { code: 'XHX_NOT_CONFIGURED' })
    }
    const auth = authOf(first)
    const day = beijingDayKey()
    const balance = await fetchBalance(auth)
    const bills = await fetchBills(auth)
    const panel = normalizeXhxPanel({ balance, bills, day })
    return { ...panel, description: describeXhxPanel(panel) }
  }

  const runOne = async (account, { trigger = 'manual', dryRun = false, label = '' } = {}) => {
    const startedAt = Date.now()
    const prefix = label ? `${label}：` : ''
    const auth = authOf(account)
    if (!auth.cookie && !auth.token) {
      throw Object.assign(new Error('这个账号没填 cookie / token'), { code: 'XHX_NO_CREDENTIAL' })
    }
    const day = beijingDayKey()
    try {
      return await runOneInner(account, auth, { trigger, dryRun, label: prefix, day, startedAt })
    } catch (error) {
      // token 失效不是故障，是「等用户重新贴一次」：转成 needs_login，
      // 定时器才不会按失败退避反复重试。
      if (error && error.code === 'XHX_NEEDS_LOGIN') {
        return {
          ok: false,
          outcome: OUTCOME.NEEDS_LOGIN,
          provider: 'xiaohuanxiong', trigger, timeZone: CHECKIN_TZ,
          points: 0, day,
          message: `${prefix}${error.message}`,
        }
      }
      throw error
    }
  }

  const runOneInner = async (account, auth, { trigger, dryRun, label: prefix, day, startedAt }) => {

    // ① 先看今天到账没有（读余额 + 流水，同时也算一次「登录」）
    const balanceBefore = await fetchBalance(auth)
    const billsBefore = await fetchBills(auth)
    const before = normalizeXhxPanel({ balance: balanceBefore, bills: billsBefore, day })
    log(`dsh-checkin-all: [小浣熊] ${prefix}${describeXhxPanel(before)}`)

    if (dryRun) {
      return {
        ok: true, outcome: OUTCOME.DRY, provider: 'xiaohuanxiong', trigger,
        timeZone: CHECKIN_TZ, points: 0, day, panel: before,
        elapsedMs: Date.now() - startedAt,
        message: `${prefix}${describeXhxPanel(before)}`,
      }
    }

    if (!before.claimable) {
      return {
        ok: true, outcome: OUTCOME.ALREADY, provider: 'xiaohuanxiong', trigger,
        timeZone: CHECKIN_TZ, points: before.dailyGrantPoints, day, panel: before,
        elapsedMs: Date.now() - startedAt,
        message: `${prefix}今天已到账 +${before.dailyGrantPoints} 积分（可用 ${before.accountCredits}）`,
      }
    }

    // ② 心跳：当日登录会把额度有效期延长到 7 天
    const beat = await heartbeat(auth, account).catch((error) => ({ ok: false, message: error.message }))
    if (beat.unauthorized) throw needLogin(beat.message || '心跳被拒')

    // ③ 再看一次流水（心跳可能触发当日发放）
    const billsAfter = await fetchBills(auth).catch(() => billsBefore)
    const balanceAfter = await fetchBalance(auth).catch(() => balanceBefore)
    const after = normalizeXhxPanel({ balance: balanceAfter, bills: billsAfter, day })

    if (!after.claimable) {
      const result = {
        ok: true, outcome: OUTCOME.CLAIMED, provider: 'xiaohuanxiong', trigger,
        timeZone: CHECKIN_TZ, points: after.dailyGrantPoints, day, panel: after,
        elapsedMs: Date.now() - startedAt,
        message: `${prefix}签到成功：今日 +${after.dailyGrantPoints} 积分，可用 ${after.accountCredits} 积分`,
      }
      log(`dsh-checkin-all: [小浣熊] ${result.message}`)
      return result
    }

    // ④ 服务端还没发：不是故障，晚点再试
    const result = {
      ok: true, outcome: OUTCOME.NOT_YET, provider: 'xiaohuanxiong', trigger,
      timeZone: CHECKIN_TZ, points: 0, day, panel: after,
      elapsedMs: Date.now() - startedAt,
      message: `${prefix}每日积分还没到账（服务端 00:00 自动发，额度已续期），稍后再试`,
    }
    log(`dsh-checkin-all: [xiaohuanxiong] ${result.message}`, 'warn')
    return result
  }

  return {
    id: 'xiaohuanxiong',
    name: '商汤小浣熊',
    short: '小浣熊',
    color: '#FF7A45',
    unit: '积分',
    /** 每日额度按北京时间 00:00 重置 */
    timeZoneMode: 'fixed',
    timeZone: CHECKIN_TZ,

    account,
    needsLogin: async () => !(await account()).loggedIn,
    panel: panelOf,
    runOne,

    async run({ trigger = 'manual', dryRun = false } = {}) {
      const accounts = (await accountsOf()).filter((a) => authOf(a).cookie || authOf(a).token)
      if (!accounts.length) {
        throw Object.assign(new Error('小浣熊还没登录：点面板上的「登录」弹窗口自己登（也可以「配置凭据」粘贴 xhx_token）'), { code: 'XHX_NOT_CONFIGURED' })
      }
      if (accounts.length === 1) {
        return this.runOne(accounts[0], { trigger, dryRun })
      }
      const results = []
      for (const a of accounts) {
        const label = a.name || `#${a.id}`
        try {
          results.push({ ok: true, key: `m:${a.id}`, label, result: await this.runOne(a, { trigger, dryRun, label }) })
        } catch (error) {
          results.push({ ok: false, key: `m:${a.id}`, label, error: error.message, code: error.code })
        }
      }
      return mergeAccountResults('xiaohuanxiong', results, { trigger, dryRun, unit: '积分', tz: CHECKIN_TZ })
    },

    // ── 登录：起一个独立 Chrome 窗口，用户自己登，我们从窗口里取 token ──
    // 全程不接触账号密码，只读登录成功后浏览器写的 cookie。
    async loginStart({ executable = null } = {}) {
      // 连点两次「登录」时先把上一次的等待收掉，别留下没人认领的窗口
      if (pending) {
        try { pending.controller.abort() } catch { /* 已取消 */ }
        pending = null
      }
      // 先确认本机有浏览器，别等用户盯着一个空弹窗
      const exe = executable || chromeExecutable()
      if (!exe) {
        throw Object.assign(
          new Error('本机没找到 Chrome / Edge，装一个就能用「登录」；也可以直接粘贴 Cookie'),
          { code: 'XHX_NO_BROWSER' },
        )
      }
      const profileDir = loginProfileDir(env)
      const controller = new AbortController()
      // loginRun 只是给测试替换用的，正常情况就是 runBrowserLogin
      let saidVerifying = false
      const started = loginRun({
        profileDir,
        executable: exe,
        signal: controller.signal,
        onProgress: ({ phase, elapsedMs }) => {
          if (phase === 'waiting' && elapsedMs) log(`dsh-checkin-all: [小浣熊] 还在等登录…（${Math.round(elapsedMs / 1000)}s）`)
          // 只报第一次：验证失败会按 10s 节流重试，每轮都喊一句只会刷屏
          if (phase === 'verifying' && !saidVerifying) {
            saidVerifying = true
            log('dsh-checkin-all: [小浣熊] 看到登录态了，正在确认…')
          }
        },
      })
      // 整个「等登录 + 存凭据」做成一个共享 promise：loginWait 会被面板轮询，
      // 每次都 await 同一个 promise，凭据只写一次，结果也只会拿到一次。
      const settled = started.then(async (credential) => {
        const entry = { cookie: credential.cookie, savedAt: new Date().toISOString() }
        if (credential.token) entry.token = credential.token
        if (credential.name) entry.name = credential.name
        // 同一个号重复登录要覆盖原来那条，不能越登越多（token 一样即同一个号）
        const existing = (await accountsOf()).find((a) => {
          const auth = authOf(a)
          return auth.token && credential.token && auth.token === credential.token
        })
        if (existing) entry.id = existing.id
        await addAccount('xiaohuanxiong', entry, env)
        log(`dsh-checkin-all: [小浣熊] 登录成功${credential.name ? `（${credential.name}）` : ''}，凭据已保存`)
        return {
          ok: true,
          userCode: '',
          ...(credential.name ? { account: credential.name } : {}),
          ...(Number.isFinite(credential.points) ? { points: credential.points } : {}),
        }
      })
      // 没人 await 时不要冒成 unhandledRejection
      settled.catch(() => {})
      pending = { settled, controller }
      return {
        userCode: '',
        verificationUri: LOGIN_URL,
        verificationUriComplete: LOGIN_URL,
        expiresInSec: Math.round(LOGIN_TIMEOUT_MS / 1000),
        opened: true,
        mode: 'browser-window',
        profileDir,
      }
    },

    /**
     * 等结果。面板是**轮询**这个方法（每 2 秒一次），不是发一次长请求：
     * 服务端的 requestTimeout 会把长请求掐断，轮询更稳，也能显示「还在等」。
     */
    async loginWait({ timeoutMs = LOGIN_TIMEOUT_MS, poll = false } = {}) {
      if (!pending) {
        throw Object.assign(new Error('没有正在进行的小浣熊登录，先点一次「登录」'), { code: 'XHX_NO_PENDING_LOGIN' })
      }
      const current = pending
      let timer
      try {
        const result = await Promise.race([
          current.settled,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Object.assign(new Error('等登录超时了，再点一次「登录」'), { code: 'XHX_LOGIN_TIMEOUT' })),
              timeoutMs,
            )
            // 刻意不 unref：这个定时器是「这一轮等待」的唯一凭据，
            // unref 掉之后事件循环一空，promise 就永远悬着（测试里直接卡死）。
          }),
        ])
        // 成功了就收掉这次登录：同一次登录只能被认领一次
        if (pending === current) pending = null
        return result
      } catch (error) {
        if (error && error.code === 'XHX_LOGIN_TIMEOUT' && poll) {
          // 面板轮询模式：这一轮只是「还没好」，登录本身继续等，不作废
          return { ok: false, pending: true, code: 'XHX_STILL_WAITING', message: '还在等你在窗口里登录' }
        }
        // 真的超时/取消/窗口被关：把这个登录作废，别让下一次点「登录」撞上死掉的 promise
        if (pending === current) pending = null
        try { current.controller.abort() } catch { /* 已取消 */ }
        throw error
      } finally {
        if (timer) clearTimeout(timer)
      }
    },

    cancelLogin() {
      if (pending) {
        try { pending.controller.abort() } catch { /* 已取消 */ }
        pending = null
      }
    },

    normalize: normalizeXhxPanel,
  }
}
