// lib/providers/teleagent.js — 天翼 AI（TeleAgent / agent.teleai.com.cn）每日签到
//
// TeleAgent 的签到在「积分福利社」里：服务端每天挂一条活动，用户点「立即领取」
// 才到账。前端（桌面端 ta-web / 门户 star-welfare）的做法是：
//   ① GET userCenter          读账户余额 current_points_balance
//   ② GET v3/checkDayTask     读活动列表 activity_data[]
//   ③ GET <activity.jump_url> 领取（jump_url 就是领取地址，去掉 /superCowork/sapi 前缀）
//   ④ 再 GET 一次 ② 刷新状态
// 这里完全照抄这套流程，另外把「首登礼 / 月度礼」的 checkTask 也顺带领一遍。
//
// 鉴权：头 `X-Token`。web 端取自 cookie `operationToken`，其次 localStorage 的
// user_token / sso_token / console_token；桌面端还会带一串 X-* 头（版本、设备、
// 时间戳、nonce），这里一并补上，服务端两种都认。
//
// 凭据：secrets.json 的 manual.teleagent.accounts[]，字段 cookie 或 token。

import { join } from 'node:path'
import { addAccount, listAccounts } from '../checkin-secrets.js'
import { pluginHome } from '../paths.js'
import { CHECKIN_TZ, beijingDayKey } from '../tz.js'
import { OUTCOME, mergeAccountResults } from './base.js'
import {
  API_PREFIX, LOGIN_TIMEOUT_MS, LOGIN_URL, ORIGIN, chromeExecutable, runBrowserLogin,
} from './teleagent-login.js'

const TIMEOUT_MS = 20_000

/** web 门户用的 API 前缀（和桌面端的 /superCowork/sapi 是同一批接口的两个门） */
export const WEB_PREFIX = '/meter/super-agent/user/portal'
/** 桌面端前缀；web 前缀不通时退回它 */
export const DESKTOP_PREFIX = `${API_PREFIX}/user/portal`

/** 活动状态里「可以领」的那几个（前端 Sfe() 用的就是这套值） */
export const CLAIMABLE_STATUS = ['incomplete', 'not_joined', 'fixed']
/** 已领 */
export const CLAIMED_STATUS = ['completed', 'claimed', 'received', 'done']

/** checkTask 的任务状态枚举（portal 里的 e8） */
export const TASK_STATUS = {
  DELIVERED: 1, USED: 2, WAIT_UNLOCK: 3, CAN_CLAIM: 4, CLAIMED: 5,
}

/** 从整条 Cookie 里挑出 token（operationToken 优先，其次 operToken / X-Token） */
export function tokenFromCookie(cookie) {
  const parts = String(cookie || '').split(/;\s*/)
  const get = (name) => {
    for (const part of parts) {
      const i = part.indexOf('=')
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
    }
    return undefined
  }
  for (const name of ['operationToken', 'operToken', 'X-Token', 'user_token']) {
    const value = get(name)
    if (value) return value
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
    return { cookie: `operationToken=${rawToken}`, token: rawToken }
  }
  return {}
}

function authHeaders(auth, extra = {}) {
  const headers = {
    accept: 'application/json',
    'accept-language': 'zh-CN,zh;q=0.9',
    origin: ORIGIN,
    referer: `${ORIGIN}/teleagent`,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'x-app-version': String((auth && auth.version) || '1.0.0'),
    'x-os-type': 'web',
    'x-channel-id': 'web',
    'x-runtime-env': 'prod',
    'x-timestamp': String(Math.floor(Date.now() / 1000)),
    'x-nonce': `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`,
    ...extra,
  }
  if (auth && auth.cookie) headers.cookie = auth.cookie
  if (auth && auth.token) headers['x-token'] = auth.token
  return headers
}

/**
 * 发一个请求。`path` 可以是 `http(s)://…` 完整地址，也可以是 `/…` 开头的路径。
 * 返回 { ok, status, json, text, code, message, unauthorized, notFound }
 */
async function call(path, { method = 'GET', auth, headers = {}, body } = {}) {
  const url = /^https?:\/\//i.test(path) ? path : `${ORIGIN}${path}`
  const init = {
    method,
    headers: { ...authHeaders(auth, headers) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers['content-type'] = 'application/json'
  }
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    return { ok: false, networkError: error.message, url }
  }
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON（SPA 壳之类） */ }
  const rawCode = json ? (json.code ?? json.status) : null
  const code = rawCode === null || rawCode === undefined ? null : rawCode
  const okFlag = Boolean(json) && (json.success === true || code === 0 || code === 200 || code === '0' || code === '200')
  const message = (json && (json.message || json.msg || json.detail)) || (text || '').slice(0, 200)
  const unauthorized = response.status === 401
    || String(code) === '4001'
    || /JWT 解析失败|令牌|未登录|token/i.test(String(message || ''))
  return {
    ok: response.ok && okFlag,
    status: response.status,
    json,
    text,
    code,
    message,
    unauthorized,
    notFound: response.status === 404,
    url,
  }
}

function needLogin(detail) {
  return Object.assign(
    new Error(`TeleAgent 登录已失效（${detail}）：点面板上的「登录」弹窗口登一次，或者把浏览器 Cookie 里的 operationToken 粘贴到「配置凭据」`),
    { code: 'TA_NEEDS_LOGIN' },
  )
}

/** 依次试 web 前缀与桌面端前缀，返回第一个给出 JSON 业务响应的 */
async function callBoth(rest, opts) {
  const attempts = [`${WEB_PREFIX}${rest}`, `${DESKTOP_PREFIX}${rest}`]
  let last = null
  for (const path of attempts) {
    const res = await call(path, opts)
    if (res.networkError) return res
    last = res
    if (res.unauthorized) return res
    if (res.json) return res
  }
  return last || { ok: false, networkError: '没有可用前缀' }
}

/** 账户中心：余额 current_points_balance 等 */
async function fetchUserCenter(auth) {
  const res = await callBoth('/companyStore/userCenter', { auth })
  if (res.networkError) {
    throw Object.assign(new Error(`连不上 TeleAgent：${res.networkError}`), { code: 'TA_NETWORK' })
  }
  if (res.unauthorized) throw needLogin(res.message || `HTTP ${res.status}`)
  if (!res.ok) {
    throw Object.assign(new Error(`TeleAgent 账户接口异常（HTTP ${res.status}）`), { code: 'TA_HTTP_ERROR', detail: res.text })
  }
  return res.json.data || {}
}

/** 福利社当日任务：{ brand_title, activity_data: [...] } */
async function fetchDayTask(auth, theme = 'light') {
  const res = await callBoth(`/companyStore/v3/checkDayTask?theme=${encodeURIComponent(theme)}`, { auth })
  if (res.networkError) {
    throw Object.assign(new Error(`连不上 TeleAgent：${res.networkError}`), { code: 'TA_NETWORK' })
  }
  if (res.unauthorized) throw needLogin(res.message || `HTTP ${res.status}`)
  if (!res.ok) {
    throw Object.assign(new Error(`TeleAgent 签到接口异常（HTTP ${res.status}）`), { code: 'TA_HTTP_ERROR', detail: res.text })
  }
  const data = res.json.data || {}
  return {
    brandTitle: data.brand_title || data.brandTitle || '',
    activities: Array.isArray(data.activity_data) ? data.activity_data
      : Array.isArray(data.activityData) ? data.activityData
        : Array.isArray(data) ? data : [],
    raw: data,
  }
}

/** 首登礼 / 月度礼：checkTask 列表 */
async function fetchCheckTasks(auth, type = '') {
  const query = type ? `?type=${encodeURIComponent(type)}` : ''
  const res = await callBoth(`/companyStore/checkTask${query}`, { auth })
  if (res.networkError) return []
  if (res.unauthorized) throw needLogin(res.message || `HTTP ${res.status}`)
  if (!res.ok) return []
  const data = res.json.data ?? res.json
  if (Array.isArray(data)) return data
  if (Array.isArray(data && data.tasks)) return data.tasks
  if (Array.isArray(data && data.task_list)) return data.task_list
  return []
}

/** 领取：jump_url 就是领取地址，去掉 /superCowork/sapi 前缀即可（前端就是这么干的） */
export function claimPathOf(jumpUrl) {
  const raw = String(jumpUrl || '').trim()
  if (!raw) return ''
  let path = raw
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      path = `${url.pathname}${url.search}`
    } catch {
      path = raw
    }
  }
  if (!path.startsWith('/')) path = `/${path}`
  // 桌面端的 jump_url 带业务前缀，web 端接口不带，所以统一剥掉
  if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
    path = path.slice(API_PREFIX.length) || '/'
  }
  return path
}

/**
 * 领取地址的候选列表（按顺序试，第一个给出业务 JSON 的算数）。
 * 前端两种写法都出现过：桌面端 jump_url 自带 `/superCowork/sapi`，
 * web 门户的是裸 `/user/portal/...`（它自己再拼 `/meter/super-agent`）。
 */
export function claimUrlsOf(jumpUrl) {
  const raw = String(jumpUrl || '').trim()
  if (!raw) return []
  if (/^https?:\/\//i.test(raw)) return [raw]
  const path = claimPathOf(raw)
  if (!path) return []
  const urls = [`${ORIGIN}${API_PREFIX}${path}`]
  // /meter/super-agent + /user/portal/... == web 门户的前缀
  urls.push(`${ORIGIN}/meter/super-agent${path}`)
  urls.push(`${ORIGIN}${path}`)
  return [...new Set(urls)]
}

async function claim(auth, jumpUrl) {
  const urls = claimUrlsOf(jumpUrl)
  if (!urls.length) {
    return { ok: false, message: '活动没给领取地址' }
  }
  let last = null
  for (const url of urls) {
    const res = await call(url, { auth })
    if (res.networkError) {
      last = { ok: false, message: `连不上 TeleAgent：${res.networkError}` }
      continue
    }
    if (res.unauthorized) throw needLogin(res.message || `HTTP ${res.status}`)
    if (!res.ok) {
      last = { ok: false, message: res.message || `HTTP ${res.status}` }
      continue
    }
    return { ok: true, data: (res.json && res.json.data) || null, message: res.message || '' }
  }
  return last || { ok: false, message: '领取接口没给出结果' }
}

function pointsOf(item) {
  const candidates = [
    item && item.points_amount, item && item.points, item && item.reward_points,
    item && item.points_value, item && item.amount,
  ]
  for (const value of candidates) {
    const num = Number(value)
    if (Number.isFinite(num) && num > 0) return num
  }
  return 0
}

/** 状态归一化：可领 / 已领 / 其他 */
export function statusOf(item) {
  const status = String((item && (item.action_status || item.status_text || item.status)) || '').toLowerCase()
  if (CLAIMABLE_STATUS.includes(status)) return 'claimable'
  if (CLAIMED_STATUS.includes(status)) return 'claimed'
  if (item && item.claimed === true) return 'claimed'
  // 文案兜底：有的活动不给 action_status，只给按钮字
  const text = String((item && (item.action_text || item.button_text)) || '')
  if (/已领|已领取|已完成|明日再来/.test(text)) return 'claimed'
  if (/立即领取|领取|未领取/.test(text)) return 'claimable'
  return 'other'
}

/** 只挑真正能在这里领的：不是纯跳转、且状态可领、且有领取地址 */
export function claimableOf(activities) {
  return (Array.isArray(activities) ? activities : []).filter((item) => {
    if (!item) return false
    if (item.visible === false) return false
    if (String(item.action_type || '').toLowerCase() === 'web') return false
    if (statusOf(item) !== 'claimable') return false
    return Boolean(claimPathOf(item.jump_url))
  })
}

/**
 * 归一化成面板认的「一天一张表」。
 * 福利社每天一条，所以 days 只有今天一条；可领的积分取活动里给的数。
 */
export function normalizeTaPanel({ userCenter, dayTask, day = beijingDayKey(), claimedItems = [] } = {}) {
  const activities = (dayTask && dayTask.activities) || []
  const visible = activities.filter((a) => a && a.visible !== false)
  const claimable = claimableOf(visible)
  const claimedToday = visible.filter((a) => statusOf(a) === 'claimed')
  const main = visible.find((a) => a.is_main_activity) || visible[0] || null
  const expected = claimable.reduce((sum, a) => sum + pointsOf(a), 0)
    || pointsOf(main)
    || 0
  const justClaimed = claimedItems.reduce((sum, a) => sum + (Number(a && a.points) || 0), 0)
  const done = claimable.length === 0
  const balance = Number((userCenter && (userCenter.current_points_balance ?? userCenter.points_balance)) || 0)
  const title = (main && (main.activity_title || main.title)) || (dayTask && dayTask.brandTitle) || '积分福利社'
  const subtitle = (main && (main.activity_subtitle || main.subtitle)) || ''
  const dayCell = {
    dayNo: 1,
    date: day,
    points: done ? (claimedToday.reduce((sum, a) => sum + pointsOf(a), 0) || justClaimed) : expected,
    bonusPoints: 0,
    status: done ? 3 : 2,
    isToday: true,
    // 福利社是「点一下才领」，不是自动到账，所以标签和文案跟小浣熊不一样
    tag: done ? '已领' : (claimable.length > 1 ? `${claimable.length} 个可领` : '可领取'),
  }
  let description
  if (claimable.length) {
    description = `${title}：今天有 ${claimable.length} 个待领奖励（约 ${expected} 积分）`
  } else if (visible.length) {
    description = `${title}：今天的奖励已经领完了${justClaimed ? `（本次 +${justClaimed} 积分）` : ''}`
  } else {
    description = `${title}：今天暂时没有可领的活动`
  }
  return {
    style: 'daily',
    days: [dayCell],
    today: dayCell,
    claimable: claimable.length > 0,
    claimedDays: done && visible.length ? 1 : 0,
    totalPoints: justClaimed || (done ? dayCell.points : 0),
    expectedPoints: expected,
    accountCredits: balance,
    timeZone: CHECKIN_TZ,
    description,
    // 面板底部那行小字（「今天可领取 +20 积分」对福利社不准确）
    noteText: description,
    title,
    subtitle,
    activityCount: visible.length,
    claimableCount: claimable.length,
    claimedCount: claimedToday.length,
    activities: visible.map((a) => ({
      title: a.activity_title || a.title || '',
      subtitle: a.activity_subtitle || a.subtitle || '',
      status: statusOf(a),
      statusText: a.action_text || a.button_text || '',
      actionType: a.action_type || '',
      points: pointsOf(a),
    })),
  }
}

export function describeTaPanel(panel) {
  if (!panel) return 'TeleAgent 签到表读不出来'
  if (panel.claimable) return `${panel.title || '积分福利社'}：还有 ${panel.claimableCount} 个奖励没领（约 ${panel.expectedPoints} 积分）`
  if (panel.activityCount) return `${panel.title || '积分福利社'}：今天的奖励已领完，账户余额 ${panel.accountCredits} 积分`
  return `${panel.title || '积分福利社'}：今天暂时没有可领的活动`
}

export function createTeleagentProvider({ log = () => {}, env = process.env, loginRun = runBrowserLogin } = {}) {
  const accountsOf = async () => listAccounts('teleagent', env)
  /** 登录用的 Chrome profile：留在插件目录里，下次登录往往还是登录态 */
  const loginProfileDir = (e = env) => join(pluginHome(e), 'browser', 'teleagent')
  /** 当前正在等的登录（loginStart 起，loginWait 收） */
  let pending = null

  const account = async () => {
    const accounts = await accountsOf()
    const usable = accounts.filter((a) => authOf(a).cookie || authOf(a).token)
    if (!usable.length) {
      return {
        loggedIn: false,
        label: '未配置',
        detail: '点「登录」弹窗口登一次，或把浏览器 Cookie 里的 operationToken 粘贴到「配置凭据」',
        code: 'TA_NOT_CONFIGURED',
      }
    }
    const names = usable.map((a) => a.name || `#${a.id}`).join('、')
    return {
      loggedIn: true,
      label: usable.length > 1 ? `已登录 ${usable.length} 个账号` : '已登录',
      detail: `operationToken · ${names}`,
      accounts: usable.length,
      accountList: usable.map((a) => ({ id: a.id, name: a.name || '' })),
    }
  }

  const panelOf = async () => {
    const accounts = await accountsOf()
    const first = accounts.find((a) => authOf(a).cookie || authOf(a).token)
    if (!first) {
      throw Object.assign(new Error('TeleAgent 还没配凭据'), { code: 'TA_NOT_CONFIGURED' })
    }
    const auth = authOf(first)
    const day = beijingDayKey()
    const userCenter = await fetchUserCenter(auth)
    const dayTask = await fetchDayTask(auth)
    const panel = normalizeTaPanel({ userCenter, dayTask, day })
    return { ...panel, description: describeTaPanel(panel) }
  }

  const runOne = async (account, { trigger = 'manual', dryRun = false, label = '' } = {}) => {
    const startedAt = Date.now()
    const prefix = label ? `${label}：` : ''
    const auth = authOf(account)
    if (!auth.cookie && !auth.token) {
      throw Object.assign(new Error('这个账号没填 cookie / token'), { code: 'TA_NO_CREDENTIAL' })
    }
    const day = beijingDayKey()
    try {
      return await runOneInner(account, auth, { trigger, dryRun, label: prefix, day, startedAt })
    } catch (error) {
      // token 失效不是故障，是「等用户重新登一次」：转成 needs_login，
      // 定时器才不会按失败退避反复重试。
      if (error && error.code === 'TA_NEEDS_LOGIN') {
        return {
          ok: false,
          outcome: OUTCOME.NEEDS_LOGIN,
          provider: 'teleagent', trigger, timeZone: CHECKIN_TZ,
          points: 0, day,
          message: `${prefix}${error.message}`,
        }
      }
      throw error
    }
  }

  const runOneInner = async (account, auth, { trigger, dryRun, label: prefix, day, startedAt }) => {
    // ① 读账户 + 当日活动（这一步同时也验证了 token）
    const userCenterBefore = await fetchUserCenter(auth)
    const dayTaskBefore = await fetchDayTask(auth)
    const before = normalizeTaPanel({ userCenter: userCenterBefore, dayTask: dayTaskBefore, day })
    log(`dsh-checkin-all: [TeleAgent] ${prefix}${describeTaPanel(before)}`)

    if (dryRun) {
      return {
        ok: true, outcome: OUTCOME.DRY, provider: 'teleagent', trigger,
        timeZone: CHECKIN_TZ, points: 0, day, panel: before,
        elapsedMs: Date.now() - startedAt,
        message: `${prefix}${describeTaPanel(before)}`,
      }
    }

    if (!before.claimable) {
      return {
        ok: true, outcome: OUTCOME.ALREADY, provider: 'teleagent', trigger,
        timeZone: CHECKIN_TZ, points: before.totalPoints, day, panel: before,
        elapsedMs: Date.now() - startedAt,
        message: `${prefix}今天的奖励已经领完了（账户余额 ${before.accountCredits} 积分）`,
      }
    }

    // ② 逐个领取福利社活动
    const targets = claimableOf(dayTaskBefore.activities)
    const claimed = []
    const failures = []
    for (const item of targets) {
      const title = item.activity_title || item.title || '每日奖励'
      try {
        const res = await claim(auth, item.jump_url)
        if (res.ok) {
          claimed.push({ title, points: pointsOf(item) || pointsOf(res.data) })
        } else {
          failures.push(`${title}（${res.message || '领取失败'}）`)
        }
      } catch (error) {
        if (error && error.code === 'TA_NEEDS_LOGIN') throw error
        failures.push(`${title}（${error.message}）`)
      }
    }

    // ③ 顺手把首登礼 / 月度礼也领一遍（领不到不影响主流程）
    try {
      const tasks = await fetchCheckTasks(auth)
      for (const task of tasks) {
        if (!task) continue
        const status = Number(task.status)
        const canClaim = status === TASK_STATUS.CAN_CLAIM
          || (task.claimed === false && Boolean(task.jump_url) && status !== TASK_STATUS.CLAIMED)
        if (!canClaim || !task.jump_url) continue
        const title = task.task_name || task.title || task.task_code || '任务奖励'
        const res = await claim(auth, task.jump_url).catch((error) => {
          if (error && error.code === 'TA_NEEDS_LOGIN') throw error
          return { ok: false, message: error.message }
        })
        if (res.ok) claimed.push({ title, points: pointsOf(task) || pointsOf(res.data) })
        else failures.push(`${title}（${res.message || '领取失败'}）`)
      }
    } catch (error) {
      if (error && error.code === 'TA_NEEDS_LOGIN') throw error
      log(`dsh-checkin-all: [TeleAgent] 任务奖励领取跳过：${error.message}`, 'warn')
    }

    // ④ 刷新状态
    const userCenterAfter = await fetchUserCenter(auth).catch(() => userCenterBefore)
    const dayTaskAfter = await fetchDayTask(auth).catch(() => dayTaskBefore)
    const after = normalizeTaPanel({
      userCenter: userCenterAfter, dayTask: dayTaskAfter, day, claimedItems: claimed,
    })
    const gained = Number(after.accountCredits) - Number(before.accountCredits)
    const claimedPoints = claimed.reduce((sum, item) => sum + (Number(item.points) || 0), 0)
    const points = claimedPoints || (gained > 0 ? gained : 0)
    const titles = claimed.map((item) => item.title).join('、')

    if (claimed.length) {
      const result = {
        ok: true, outcome: OUTCOME.CLAIMED, provider: 'teleagent', trigger,
        timeZone: CHECKIN_TZ, points, day, panel: { ...after, totalPoints: points },
        elapsedMs: Date.now() - startedAt,
        message: `${prefix}签到成功：领到 ${titles}${points ? `，+${points} 积分` : ''}（余额 ${after.accountCredits}）`,
      }
      log(`dsh-checkin-all: [TeleAgent] ${result.message}`)
      return result
    }

    if (!after.claimable) {
      // 服务端状态已变（可能别处领过了），当已领
      return {
        ok: true, outcome: OUTCOME.ALREADY, provider: 'teleagent', trigger,
        timeZone: CHECKIN_TZ, points: after.totalPoints, day, panel: after,
        elapsedMs: Date.now() - startedAt,
        message: `${prefix}今天的奖励已经领过了（余额 ${after.accountCredits} 积分）`,
      }
    }

    // ⑤ 有活动但没领到：不是故障，晚点再试
    const result = {
      ok: true, outcome: OUTCOME.NOT_YET, provider: 'teleagent', trigger,
      timeZone: CHECKIN_TZ, points: 0, day, panel: after,
      elapsedMs: Date.now() - startedAt,
      message: `${prefix}奖励还没领到：${failures.join('；') || '服务端没给出领取结果'}，稍后再试`,
    }
    log(`dsh-checkin-all: [TeleAgent] ${result.message}`, 'warn')
    return result
  }

  return {
    id: 'teleagent',
    name: '天翼 AI',
    short: 'TeleAgent',
    color: '#2B6CF6',
    unit: '积分',
    /** 福利社按北京时间 00:00 刷新 */
    timeZoneMode: 'fixed',
    timeZone: CHECKIN_TZ,

    account,
    needsLogin: async () => !(await account()).loggedIn,
    panel: panelOf,
    runOne,

    async run({ trigger = 'manual', dryRun = false } = {}) {
      const accounts = (await accountsOf()).filter((a) => authOf(a).cookie || authOf(a).token)
      if (!accounts.length) {
        throw Object.assign(
          new Error('TeleAgent 还没登录：点面板上的「登录」弹窗口自己登（也可以「配置凭据」粘贴 operationToken）'),
          { code: 'TA_NOT_CONFIGURED' },
        )
      }
      if (accounts.length === 1) {
        return this.runOne(accounts[0], { trigger, dryRun })
      }
      const results = []
      for (const a of accounts) {
        const label = a.name || `#${a.id}`
        try {
          results.push({ ok: true, label, result: await this.runOne(a, { trigger, dryRun, label }) })
        } catch (error) {
          results.push({ ok: false, label, error: error.message, code: error.code })
        }
      }
      return mergeAccountResults('teleagent', results, { trigger, dryRun, unit: '积分', tz: CHECKIN_TZ })
    },

    // ── 登录：起一个独立 Chrome 窗口，用户自己登，我们从窗口里取 token ──
    async loginStart({ executable = null } = {}) {
      if (pending) {
        try { pending.controller.abort() } catch { /* 已取消 */ }
        pending = null
      }
      const exe = executable || chromeExecutable()
      if (!exe) {
        throw Object.assign(
          new Error('本机没找到 Chrome / Edge，装一个就能用「登录」；也可以直接粘贴 operationToken'),
          { code: 'TA_NO_BROWSER' },
        )
      }
      const profileDir = loginProfileDir(env)
      const controller = new AbortController()
      let saidVerifying = false
      const started = loginRun({
        profileDir,
        executable: exe,
        signal: controller.signal,
        onProgress: ({ phase, elapsedMs }) => {
          if (phase === 'waiting' && elapsedMs) log(`dsh-checkin-all: [TeleAgent] 还在等登录…（${Math.round(elapsedMs / 1000)}s）`)
          // 只报第一次：验证失败会按 10s 节流重试，每轮都喊一句只会刷屏
          if (phase === 'verifying' && !saidVerifying) {
            saidVerifying = true
            log('dsh-checkin-all: [TeleAgent] 看到登录态了，正在确认…')
          }
        },
      })
      // 整个「等登录 + 存凭据」做成一个共享 promise：loginWait 会被面板轮询，
      // 每次都 await 同一个 promise，凭据只写一次，结果也只会拿到一次。
      const settled = started.then(async (credential) => {
        const entry = { token: credential.token, savedAt: new Date().toISOString() }
        if (credential.cookie) entry.cookie = credential.cookie
        if (credential.name) entry.name = credential.name
        // 同一个号重复登录要覆盖原来那条，不能越登越多（token 一样即同一个号）
        const existing = (await accountsOf()).find((a) => {
          const auth = authOf(a)
          return auth.token && credential.token && auth.token === credential.token
        })
        if (existing) entry.id = existing.id
        await addAccount('teleagent', entry, env)
        log(`dsh-checkin-all: [TeleAgent] 登录成功${credential.name ? `（${credential.name}）` : ''}，凭据已保存`)
        return {
          ok: true,
          userCode: '',
          ...(credential.name ? { account: credential.name } : {}),
          ...(Number.isFinite(credential.points) ? { points: credential.points } : {}),
        }
      })
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

    /** 面板是**轮询**这个方法（每 2 秒一次），不是发一次长请求 */
    async loginWait({ timeoutMs = LOGIN_TIMEOUT_MS, poll = false } = {}) {
      if (!pending) {
        throw Object.assign(new Error('没有正在进行的 TeleAgent 登录，先点一次「登录」'), { code: 'TA_NO_PENDING_LOGIN' })
      }
      const current = pending
      let timer
      try {
        const result = await Promise.race([
          current.settled,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Object.assign(new Error('等登录超时了，再点一次「登录」'), { code: 'TA_LOGIN_TIMEOUT' })),
              timeoutMs,
            )
          }),
        ])
        if (pending === current) pending = null
        return result
      } catch (error) {
        if (error && error.code === 'TA_LOGIN_TIMEOUT' && poll) {
          // 面板轮询模式：这一轮只是「还没好」，登录本身继续等，不作废
          return { ok: false, pending: true, code: 'TA_STILL_WAITING', message: '还在等你在窗口里登录' }
        }
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

    normalize: normalizeTaPanel,
  }
}
