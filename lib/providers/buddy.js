// lib/providers/buddy.js — 腾讯 WorkBuddy 每日签到（领取积分）
//
// 对外统一显示为 WorkBuddy；底层有两个产品线（国内 copilot.tencent.com / 国际 workbuddy.ai），
// 技术标识 productCode 分别是 codebuddy / workbuddy —— 那是发给服务端的，不能改。
//
// 协议来自 dsh-free-model 的 vendor/channel-pack/src/credits.ts（MIT）。
//
//   国内版：https://copilot.tencent.com      — 有每日领取
//   国际版（WorkBuddy）：https://www.workbuddy.ai         — 只有模型接入，无签到
//
// 三个接口：
//   POST /v2/billing/meter/checkin-activity-status   签到活动状态（active / today_checked_in / streak）
//   POST /v2/billing/meter/daily-checkin             领取
//   POST /v2/billing/meter/get-user-resource         余额（积分包明细）
//
// 认证是一串特别的头，缺了服务端只回 401 HTML：
//   Authorization: Bearer <access_token>
//   X-Domain: <apiDomain>            copilot.tencent.com / www.workbuddy.ai
//   X-Product: SaaS
//   X-Product-Code: codebuddy / workbuddy
//   X-User-Id / X-Enterprise-Id / X-Tenant-Id   有就带
//   User-Agent: CodeBuddyIDE/1.106.1 之类
//
// 错误码：10001 / 1001 = 今天已领；1002 = 无资格；1003 = 活动结束（后两个是「不是故障」）。
//
// 「今天」按北京时间算。

import { getManual, setManual } from '../checkin-secrets.js'
import { OUTCOME } from './base.js'
import { CHECKIN_TZ, beijingDayKey } from '../tz.js'
import { fetchAuthState, pollToken, runBuddyLogin, fetchAccount } from './buddy-login.js'

const BUDDY_TZ = CHECKIN_TZ
const TIMEOUT_MS = 30_000

const CHECKIN_STATUS_PATH = '/v2/billing/meter/checkin-activity-status'
const DAILY_CHECKIN_PATH = '/v2/billing/meter/daily-checkin'
const USER_RESOURCE_PATH = '/v2/billing/meter/get-user-resource'

const CODE_ALREADY_CLAIMED = 10001
const CODE_ALREADY_CLAIMED_ALT = 1001
const CODE_NO_QUALIFICATION = 1002
const CODE_ACTIVITY_ENDED = 1003

/** 两个产品线：国内版有签到，国际版没有 */
export const BUDDY_PRODUCTS = {
  cn: {
    id: 'codebuddy',
    label: 'WorkBuddy（国内版）',
    endpoint: 'https://copilot.tencent.com',
    apiDomain: 'copilot.tencent.com',
    productCode: 'codebuddy',
    userAgent: 'CodeBuddyIDE/1.106.1',
    platform: 'ide',
    pluginVersion: '1.106.1',
    appendSessionParams: true,
  },
  intl: {
    id: 'workbuddy',
    label: 'WorkBuddy（国际版）',
    endpoint: 'https://www.workbuddy.ai',
    apiDomain: 'www.workbuddy.ai',
    productCode: 'workbuddy',
    userAgent: 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
    platform: 'ide',
    pluginVersion: '5.5.2',
    appendSessionParams: true,
  },
}

export class BuddyError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** 拼认证头（少一个服务端就只回 401 HTML，很难排查） */
export function buddyHeaders(credential, product) {
  const headers = {
    Authorization: `Bearer ${credential.access_token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Domain': product.apiDomain,
    'X-Product': 'SaaS',
    'X-Product-Code': product.productCode,
    'User-Agent': product.userAgent,
  }
  if (credential.user_id) headers['X-User-Id'] = String(credential.user_id)
  if (credential.enterprise_id) {
    headers['X-Enterprise-Id'] = String(credential.enterprise_id)
    headers['X-Tenant-Id'] = String(credential.enterprise_id)
  }
  return headers
}

async function postJson(product, credential, path, body = {}) {
  let response
  try {
    response = await fetch(`${product.endpoint}${path}`, {
      method: 'POST',
      headers: buddyHeaders(credential, product),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new BuddyError('BUDDY_NETWORK', `连不上 ${product.apiDomain}：${error.message}`)
  }
  const text = await response.text()
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new BuddyError('BUDDY_AUTH', `登录已失效（HTTP ${response.status}），重新登录后更新 access_token`)
    }
    throw new BuddyError('BUDDY_HTTP', `HTTP ${response.status}：${text.replace(/\s+/g, ' ').slice(0, 120)}`)
  }
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!json || typeof json !== 'object') {
    throw new BuddyError('BUDDY_BAD_RESPONSE', '返回无法解析（多半是认证头不对，服务端回了 HTML）')
  }
  return json
}

const readBool = (src, key) => src && src[key] === true
const readNum = (src, key) => (src && typeof src[key] === 'number' ? src[key] : 0)

/** 签到活动状态 */
export async function fetchBuddyStatus(product, credential) {
  const json = await postJson(product, credential, CHECKIN_STATUS_PATH)
  if (Number(json.code) !== 0) return null
  const data = json.data && typeof json.data === 'object' ? json.data : {}
  return {
    active: readBool(data, 'active'),
    todayCheckedIn: readBool(data, 'today_checked_in'),
    streakDays: readNum(data, 'streak_days'),
    dailyCredit: readNum(data, 'daily_credit'),
    todayCredit: readNum(data, 'today_credit'),
    totalCredits: readNum(data, 'total_credits'),
    activityName: typeof data.activity_name === 'string' ? data.activity_name : '',
  }
}

/** 余额（积分包） */
export async function fetchBuddyBalance(product, credential) {
  const json = await postJson(product, credential, USER_RESOURCE_PATH)
  if (Number(json.code) !== 0) return null
  const data = json.data && typeof json.data === 'object' ? json.data : {}
  const packages = Array.isArray(data.packages) ? data.packages : Array.isArray(data.PackageList) ? data.PackageList : []
  let remaining = 0
  for (const p of packages) {
    const v = Number(p.CycleCapacityRemain ?? p.cycleCapacityRemain ?? p.remaining ?? 0)
    if (Number.isFinite(v)) remaining += v
  }
  return { remaining, count: packages.length }
}

/** 领一次 */
export async function buddyCheckin(product, credential) {
  const json = await postJson(product, credential, DAILY_CHECKIN_PATH)
  const code = Number(json.code)
  if (code === CODE_ALREADY_CLAIMED || code === CODE_ALREADY_CLAIMED_ALT) {
    return { state: 'already', message: json.msg || json.message || '今天已签到' }
  }
  if (code === CODE_NO_QUALIFICATION || code === CODE_ACTIVITY_ENDED) {
    // 没资格 / 活动结束：不是故障，别按失败重试
    return { state: 'inactive', message: json.msg || json.message || '当前无领取资格' }
  }
  if (code !== 0) {
    throw new BuddyError('BUDDY_API', json.msg || json.message || `领取失败（code ${code}）`)
  }
  const data = json.data && typeof json.data === 'object' ? json.data : {}
  return {
    state: 'signed',
    credit: readNum(data, 'credit'),
    streakDays: readNum(data, 'streak_days'),
  }
}

/**
 * 一个 provider 同时管两个产品线（国内 copilot.tencent.com / 国际 workbuddy.ai）。
 * 凭据存在 secrets.json 的 manual.buddy：{ accounts: [{ region, access_token, user_id?, enterprise_id?, name? }] }
 */
export function createBuddyProvider({ log = () => {}, env = process.env } = {}) {
  /** 正在进行的登录：{ product, state, authUrl, abort } */
  let pending = null

  const loadAccounts = async () => {
    const manual = await getManual('buddy', env)
    if (!manual || typeof manual !== 'object') return []
    const list = Array.isArray(manual.accounts) ? manual.accounts : []
    return list
      .filter((a) => a && a.access_token)
      .map((a, i) => ({
        region: a.region === 'intl' ? 'intl' : 'cn',
        access_token: String(a.access_token),
        ...(a.user_id ? { user_id: String(a.user_id) } : {}),
        ...(a.enterprise_id ? { enterprise_id: String(a.enterprise_id) } : {}),
        label: a.name || (a.region === 'intl' ? '国际版' : '国内版') || `#${i + 1}`,
      }))
  }

  return {
    id: 'buddy',
    name: '腾讯 WorkBuddy',
    short: 'WorkBuddy',
    color: '#0A7AFF',
    unit: '积分',
    timeZoneMode: 'fixed',
    timeZone: BUDDY_TZ,

    loadAccounts,

    async account() {
      const accounts = await loadAccounts()
      if (!accounts.length) {
        return {
          loggedIn: false,
          label: '未登录',
          detail: '点上面「登录」按钮，浏览器授权一次即可',
          code: 'BUDDY_NOT_CONFIGURED',
        }
      }
      return {
        loggedIn: true,
        label: '已配置',
        detail: `${accounts.length} 个账号（${accounts.map((a) => BUDDY_PRODUCTS[a.region].label).join('、')}）`,
      }
    },

    async needsLogin() {
      return !(await loadAccounts()).length
    },

    async panel() {
      const accounts = await loadAccounts()
      const day = beijingDayKey()
      if (!accounts.length) {
        return {
          style: 'daily',
          days: [{ dayNo: 1, date: day, points: 0, bonusPoints: 0, status: 1, isToday: true }],
          today: { dayNo: 1, date: day, points: 0, bonusPoints: 0, status: 1, isToday: true },
          claimable: false, claimedDays: 0, totalPoints: 0,
          timeZone: BUDDY_TZ, description: '未配置 WorkBuddy 凭据',
        }
      }
      // 只看第一个账号的状态画卡片，多账号在 run() 里逐个签
      const first = accounts[0]
      const product = BUDDY_PRODUCTS[first.region]
      let status = 1
      let description = ''
      let points = 0
      let remaining
      try {
        const st = await fetchBuddyStatus(product, first)
        if (!st) {
          status = 4
          description = '读不到签到活动状态'
        } else if (st.todayCheckedIn) {
          status = 3
          points = st.todayCredit || st.dailyCredit
          description = `今天已签${st.streakDays ? `（连续 ${st.streakDays} 天）` : ''}`
        } else if (st.active) {
          status = 2
          points = st.dailyCredit
          description = `今天可以领 ${st.dailyCredit} 积分`
        } else {
          status = 4
          description = '当前没有进行中的签到活动'
        }
        const bal = await fetchBuddyBalance(product, first).catch(() => null)
        if (bal) remaining = bal.remaining
      } catch (error) {
        status = 4
        description = `查询失败：${error.message.slice(0, 60)}`
      }
      return {
        style: 'daily',
        days: [{ dayNo: 1, date: day, points, bonusPoints: 0, status, isToday: true }],
        today: { dayNo: 1, date: day, points, bonusPoints: 0, status, isToday: true },
        claimable: status === 2,
        claimedDays: status === 3 ? 1 : 0,
        totalPoints: 0,
        accountCredits: remaining || undefined,
        accounts: accounts.length,
        timeZone: BUDDY_TZ,
        description,
      }
    },

    async run({ trigger = 'manual', dryRun = false } = {}) {
      const accounts = await loadAccounts()
      if (!accounts.length) {
        throw Object.assign(new Error('WorkBuddy 还没登录：点面板「登录」按钮，或跑 dsh-checkin-all login buddy'), { code: 'BUDDY_NOT_CONFIGURED' })
      }
      const day = beijingDayKey()
      if (dryRun) {
        return {
          ok: true, outcome: OUTCOME.DRY, provider: 'buddy', trigger, timeZone: BUDDY_TZ,
          points: 0, day, message: `${accounts.length} 个 WorkBuddy 账号（干跑，不真签）`,
        }
      }
      let signed = 0
      let already = 0
      let inactive = 0
      let points = 0
      let streak
      const messages = []
      for (const a of accounts) {
        const product = BUDDY_PRODUCTS[a.region]
        try {
          // 先看状态：已签就不打领取接口
          const st = await fetchBuddyStatus(product, a).catch(() => null)
          if (st && st.todayCheckedIn) {
            already += 1
            messages.push(`${a.label}：今天已签`)
            continue
          }
          const r = await buddyCheckin(product, a)
          if (r.state === 'signed') {
            signed += 1
            points += r.credit || 0
            if (r.streakDays) streak = r.streakDays
            messages.push(`${a.label}：+${r.credit || 0} 积分`)
          } else if (r.state === 'already') {
            already += 1
            messages.push(`${a.label}：今天已签`)
          } else {
            inactive += 1
            messages.push(`${a.label}：${r.message}`)
          }
        } catch (error) {
          messages.push(`${a.label}：失败（${error.message.slice(0, 80)}）`)
        }
      }
      const ok = signed + already > 0 || inactive === accounts.length
      const outcome = signed > 0 ? OUTCOME.CLAIMED
        : already > 0 ? OUTCOME.ALREADY
          : inactive > 0 ? OUTCOME.NO_TASK
            : OUTCOME.FAILED
      const result = {
        ok, outcome, provider: 'buddy', trigger, timeZone: BUDDY_TZ,
        points, day,
        ...(streak ? { consecutiveDays: streak } : {}),
        message: `WorkBuddy：${messages.join('；')}`,
      }
      log(`dsh-checkin-all: [WorkBuddy] ${result.message}`)
      if (!ok) throw Object.assign(new Error(result.message), { code: 'BUDDY_ALL_FAILED' })
      return result
    },

    /**
     * 浏览器登录：拿 state + 授权地址，打开浏览器，然后由 loginWait 轮询。
     * region 由 panel/config 传进来（cn = 国内版，intl = 国际版）。
     */
    async loginStart({ region = 'cn' } = {}) {
      const product = BUDDY_PRODUCTS[region === 'intl' ? 'intl' : 'cn']
      const { state, authUrl } = await fetchAuthState(product)
      const { decorateLoginUrl } = await import('./buddy-login.js')
      const { openBrowser } = await import('./codearts-login.js')
      const decorated = decorateLoginUrl(authUrl, product)
      const opened = openBrowser(decorated)
      pending = { product, state, authUrl: decorated, abort: false }
      return {
        // 浏览器授权式：没有设备码
        userCode: '',
        verificationUri: decorated,
        verificationUriComplete: decorated,
        expiresInSec: 300,
        opened,
        product: product.label,
      }
    },

    async loginWait({ timeoutMs = 300_000, region = 'cn' } = {}) {
      if (!pending) {
        throw Object.assign(new Error('没有正在进行的 WorkBuddy 登录，先点一次「登录」'), { code: 'BUDDY_NO_PENDING_LOGIN' })
      }
      const current = pending
      pending = null
      const token = await pollToken(current.product, current.state, {
        timeoutMs,
        signal: { get aborted() { return current.abort } },
      })
      const account = await fetchAccount(current.product, current.state, token).catch(() => ({}))
      const entry = {
        region: current.product.id === 'workbuddy' ? 'intl' : 'cn',
        access_token: token.accessToken,
        ...(account.userId ? { user_id: account.userId } : {}),
        ...(account.enterpriseId ? { enterprise_id: account.enterpriseId } : {}),
        ...(account.nickname ? { name: account.nickname } : {}),
      }
      // 追加到账号列表（同一个 token 视为更新）
      const manual = (await getManual('buddy', env)) || {}
      const accounts = Array.isArray(manual.accounts) ? [...manual.accounts] : []
      const same = accounts.findIndex(a => a && a.access_token === entry.access_token)
      if (same >= 0) accounts[same] = entry
      else accounts.push(entry)
      await setManual('buddy', { accounts }, env)
      log('dsh-checkin-all: [WorkBuddy] 登录成功，凭据已保存')
      return {
        ok: true,
        userCode: '',
        product: current.product.label,
        ...(account.nickname ? { account: account.nickname } : {}),
      }
    },

    cancelLogin() {
      if (pending) {
        pending.abort = true
        pending = null
      }
    },
  }
}
