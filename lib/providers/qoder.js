// lib/providers/qoder.js — Qoder 每日签到（领取每日赠送积分）
//
// 协议照 dsh-model 的 src/checkin/qoder.ts（原自 G57651/dsh-dual-checkin，MIT），
// 与 Qoder 桌面端「用量面板」自己的领取链路一致：
//   个人访问令牌（PAT）→ POST {openApi}/api/v1/jobToken/exchange → 短期 jobToken
//   GET  {openApi}/sash/api/v1/me/campaigns                    找当天的 CLAIM_BENEFIT 活动
//   POST {openApi}/sash/api/v1/me/campaigns/{id}/claim         幂等：重复领取返回 replayed，不会多发
// PAT 存在 ~/.dsh/dsh-checkin-all/secrets.json（0600）；jobToken 只在内存里用，不落盘。
//
// 「今天」按北京时间算。一个服务一张卡片；多账号时 run() 逐个签，汇总结果。

import { execFile } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadQoders } from '../checkin-secrets.js'
import { OUTCOME } from './base.js'
import { CHECKIN_TZ, beijingDayKey } from '../tz.js'

const runExec = promisify(execFile)

/**
 * 读本机 Qoder 桌面 App 的登录（只读，不写回）。
 *
 * Qoder 把 OAuth 登录态存在 Electron safeStorage 里：
 *   <App Support>/com.qoder.app.stable/auth.v1.dat
 *   格式 v10/v11 + AES-128-CBC，密钥来自钥匙串「Qoder App Safe Storage」
 * 解出来 { token, refreshToken, expiresAt, user, authenticationContext }。
 * authenticationContext 里带 openapi.qoder.sh => 海外版。
 *
 * 读不到就返回 null，调用方回退到手工配置的 PAT。
 */
export async function readLocalQoderLogin(env = process.env, platform = process.platform) {
  if (platform !== 'darwin' && platform !== 'win32') return null
  const dir = platform === 'darwin'
    ? join(env.HOME || homedir(), 'Library', 'Application Support', 'com.qoder.app.stable')
    : join(env.APPDATA || join(env.HOME || homedir(), 'AppData', 'Roaming'), 'com.qoder.app.stable')
  let buf
  try {
    buf = await readFile(join(dir, 'auth.v1.dat'))
  } catch {
    return null
  }
  const tag = buf.subarray(0, 3).toString()
  if (tag !== 'v10' && tag !== 'v11') return null
  const body = buf.subarray(3)
  if (platform !== 'darwin') return null

  const password = await macSafeStorageKey()
  if (!password) return null

  for (const keyLen of [16, 32]) {
    try {
      const key = pbkdf2Sync(password, 'saltysalt', 1003, keyLen, 'sha1')
      const decipher = createDecipheriv(`aes-${keyLen * 8}-cbc`, key, Buffer.alloc(16, 0x20))
      const plain = Buffer.concat([decipher.update(body), decipher.final()])
      // Chromium 的 v10 可能带 32 字节 host 前缀，从第一个 { 开始解析
      const text = plain.toString('utf8')
      const start = text.indexOf('{')
      if (start < 0) continue
      const json = JSON.parse(text.slice(start))
      if (typeof json.token !== 'string' || !json.token) continue
      const ctx = String(json.authenticationContext || '')
      return {
        token: json.token,
        refreshToken: typeof json.refreshToken === 'string' ? json.refreshToken : '',
        expiresAt: json.expiresAt || '',
        email: (json.user && json.user.email) || '',
        region: /openapi[.]qoder[.]sh/.test(ctx) ? 'intl'
          : /openapi[.]qoder[.]com[.]cn/.test(ctx) ? 'cn'
            : 'intl',
      }
    } catch {
      // 换下一个密钥长度
    }
  }
  return null
}

/** macOS 钥匙串里那个 App 的 safeStorage 密码 */
async function macSafeStorageKey() {
  const name = 'Qoder'
  for (const service of [`${name} App Safe Storage`, `${name} Safe Storage`]) {
    try {
      const out = await runExec('/usr/bin/security', ['find-generic-password', '-w', '-s', service], { timeout: 30_000 })
      const v = (out.stdout || '').trim()
      if (v) return v
    } catch {
      // 换下一个服务名
    }
  }
  return null
}

export const QODER_REGIONS = {
  cn: { label: 'Qoder（国内版）', openApi: 'https://openapi.qoder.com.cn' },
  intl: { label: 'Qoder', openApi: 'https://openapi.qoder.sh' },
}

const TIMEOUT_MS = 20_000
const QODER_TZ = CHECKIN_TZ

/**
 * Qoder 的每日活动每天 10:00（UTC+8）换新一轮。
 * 早于这个点看到的还是昨天那轮：此时如果显示已领，不代表今天已经领过。
 */
const CAMPAIGN_REFRESH_HOUR_UTC8 = 10

/** 今天的活动已经刷新出来了吗 */
/**
 * Qoder 的每日活动每一轮从 UTC+8 的 10:00 开始，到次日 09:59 结束。
 * 所以「今天这轮开始了吗」= 现在是否已经过了最近一个 10:00。
 *
 * ⚠️ 不能只判 `hours >= 10`：那样凌晨 00:00–09:59 会被判成「没刷新」，
 * 但那段时间其实仍在上一轮（前一天 10:00 开始的）之内，新一轮早开了。
 */
export function qoderRefreshedToday(now = Date.now()) {
  const utc8 = new Date(now + 8 * 3600_000)
  return utc8.getUTCHours() >= CAMPAIGN_REFRESH_HOUR_UTC8
}

/**
 * 当前这一轮活动的起点（毫秒时间戳）。
 * 过了 10:00 就是今天 10:00，否则是昨天 10:00。
 */
export function currentCampaignStart(now = Date.now()) {
  const utc8 = new Date(now + 8 * 3600_000)
  const hour = utc8.getUTCHours()
  // 折回「北京时间当天 00:00」的 UTC 时间戳
  const dayStartUtc8 = Date.UTC(utc8.getUTCFullYear(), utc8.getUTCMonth(), utc8.getUTCDate()) - 8 * 3600_000
  if (hour >= CAMPAIGN_REFRESH_HOUR_UTC8) {
    return dayStartUtc8 + CAMPAIGN_REFRESH_HOUR_UTC8 * 3600_000
  }
  // 还没到今天的 10:00 → 当前这轮是昨天 10:00 开始的
  return dayStartUtc8 - 86_400_000 + CAMPAIGN_REFRESH_HOUR_UTC8 * 3600_000
}

async function call(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await res.text()
  let json = {}
  try { json = text ? JSON.parse(text) : {} } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

export class QoderAuthError extends Error {}

/** PAT 换短期 token；PAT 不对就抛 QoderAuthError */
export async function exchangePat(pat, region) {
  const r = await call(`${QODER_REGIONS[region].openApi}/api/v1/jobToken/exchange`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'cosy-clienttype': '5', 'cosy-version': '1.0.1', 'user-agent': 'Qoder' },
    body: JSON.stringify({ personal_token: pat }),
  })
  const token = typeof r.json.token === 'string' ? r.json.token : ''
  if (r.status >= 400 || !token) throw new QoderAuthError(`Qoder 个人访问令牌无效或已过期（HTTP ${r.status}）`)
  return token
}

const headers = (token) => ({ accept: 'application/json', authorization: `Bearer ${token}`, 'cosy-clienttype': '10', 'user-agent': 'Qoder' })

const epoch = (v) => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v >= 1e12 ? v : v * 1000
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

/**
 * 当天能领的 CLAIM_BENEFIT 活动。
 *
 * 两个条件都要满足：
 *   1) 在时间窗口内
 *   2) claimStatus 是 CLAIMABLE（没领过）
 *
 * ⚠️ 以前只判时间窗口，不判 claimStatus，于是**已经领过的活动也会被返回**，
 * 调用方就白白去 POST /claim 一次。服务端靠 `replayed` 兜住了，
 * 但那是运气——一旦服务端改成对重复领取回 4xx，签到就会变成失败。
 *
 * @param {object} payload campaigns 响应
 * @param {number} now 当前时间（毫秒）
 * @param {{includeClaimed?: boolean}} opts includeClaimed=true 时不过滤状态（调试用）
 */
export function claimableCampaign(payload, now = Date.now(), opts = {}) {
  const list = payload?.campaigns ?? payload?.data?.campaigns
  if (!Array.isArray(list)) return undefined
  for (const c of list) {
    if (!c || c.actionType !== 'CLAIM_BENEFIT') continue
    const start = epoch(c.startAt ?? c.beginAt)
    const end = epoch(c.endAt)
    if (start !== undefined && now < start) continue
    if (end !== undefined && now > end) continue
    // 已经领过的不算「可领」
    if (!opts.includeClaimed && c.claimStatus && c.claimStatus !== 'CLAIMABLE') continue
    return c
  }
  return undefined
}

/** 命中「今天这一轮」的 CLAIM_BENEFIT（不管领没领）。用来区分「已领」和「没这活动」 */
export function todaysBenefit(payload, now = Date.now()) {
  const list = payload?.campaigns ?? payload?.data?.campaigns
  if (!Array.isArray(list)) return undefined
  for (const c of list) {
    if (!c || c.actionType !== 'CLAIM_BENEFIT') continue
    const start = epoch(c.startAt ?? c.beginAt)
    const end = epoch(c.endAt)
    if (start !== undefined && now < start) continue
    if (end !== undefined && now > end) continue
    return c
  }
  return undefined
}

const amountOf = (claim, campaign) => {
  const n = Number(claim.data?.benefit?.amount ?? claim.benefit?.amount ?? campaign.benefit?.amount)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 一个 Qoder 账号签到：signed（这次签上）/ already（今天已签）；返回送的积分
 * @param {string} [pat] 个人访问令牌；没有时用 directToken（本机 App 的 OAuth token）
 * @param {'cn'|'intl'} region
 * @param {string} [directToken] 已经拿到的短期/长期 token，跳过 exchange
 */
export async function qoderCheckin(pat, region, directToken) {
  const base = QODER_REGIONS[region].openApi
  const token = directToken || await exchangePat(pat, region)
  const list = await call(`${base}/sash/api/v1/me/campaigns`, { headers: headers(token) })
  if (list.status === 401 || list.status === 403) throw new QoderAuthError(`Qoder 登录无效（HTTP ${list.status}）`)
  if (list.status >= 400) throw new Error(`Qoder 活动列表 HTTP ${list.status}`)

  const campaign = claimableCampaign(list.json)
  if (campaign) {
    // 有可领的：去领
    const claim = await call(`${base}/sash/api/v1/me/campaigns/${encodeURIComponent(String(campaign.campaignId ?? campaign.id ?? ''))}/claim`, {
      method: 'POST', headers: { ...headers(token), 'content-type': 'application/json' }, body: '{}',
    })
    if (claim.status >= 400) {
      throw new Error(`Qoder 领取失败（HTTP ${claim.status}）：${String(claim.json?.message ?? '').slice(0, 120)}`)
    }
    const body = (typeof claim.json.data === 'object' && claim.json.data !== null ? claim.json.data : claim.json)
    if (body.replayed === true) return { state: 'already' }
    if (body.status !== 'CLAIMED' && body.success !== true) {
      throw new Error(`Qoder 签到返回异常：${JSON.stringify(claim.json).slice(0, 160)}`)
    }
    const credit = amountOf(claim.json, campaign)
    return { state: 'signed', ...(credit !== undefined ? { credit } : {}) }
  }

  // 没有可领的，分情况说清楚（不能一律当「今天已签」）：
  const today = todaysBenefit(list.json)
  if (today) {
    // 窗口内确实有当前这一轮，但已经领过了。
    //
    // ⚠️ 但要确认这一轮**覆盖的是今天**：Qoder 的轮次是「10:00 → 次日 09:59」，
    // 所以在今天 10:00 之前看到的，是**昨天 10:00 开始**的那一轮——它已经领过，
    // 不代表今天领过了。这时候必须返回「还没到轮次」，否则当天会被错误地标成完成，
    // 10:00 新一轮出来后再也不会重试（这就是自动签到一直不生效的原因）。
    const start = epoch(today.startAt ?? today.beginAt)
    if (start !== undefined && start < currentCampaignStart(Date.now())) {
      throw Object.assign(
        new Error('Qoder 今天的活动还没开始（每天 10:00（UTC+8）换新一轮），到点后会自动签'),
        { code: 'QODER_NOT_REFRESHED' },
      )
    }
    return {
      state: 'already',
      credit: Number(today.benefit?.amount) || undefined,
      campaignStart: start,
    }
  }
  // 窗口内没有任何 CLAIM_BENEFIT：说明这个账号没有这个活动
  throw Object.assign(
    new Error('这个 Qoder 账号没有可领取的签到活动（可能还没在 Qoder 官方客户端登录过该账号以开通）'),
    { code: 'QODER_NO_CAMPAIGN' },
  )
}

export function createQoderProvider({ log = () => {}, env = process.env } = {}) {
  return {
    id: 'qoder',
    name: 'Qoder',
    short: 'Qoder',
    color: '#e05a1a',
    unit: '积分',
    timeZoneMode: 'fixed',
    timeZone: QODER_TZ,

    async account() {
      const local = await readLocalQoderLogin(env)
      const qoders = await loadQoders(env)
      if (!qoders.length && local) {
        return {
          loggedIn: true,
          label: `已登录 · 本机 Qoder${local.region === 'intl' ? '（海外版）' : '（国内版）'}`,
          detail: local.email || '读自 Qoder 桌面 App 的登录',
          fromLocal: true,
          region: local.region,
        }
      }
      if (!qoders.length) {
        return { loggedIn: false, label: '未配置', detail: '需要添加 Qoder 个人访问令牌，或在本机 Qoder App 里登录', code: 'QODER_NOT_CONFIGURED' }
      }
      const labels = qoders.map((q) => {
        const region = q.region === 'cn' ? '国内版' : ''
        const tag = q.name || (qoders.length > 1 ? `#${q.id}` : '')
        return tag ? `Qoder（${[tag, region].filter(Boolean).join(' · ')}）` : QODER_REGIONS[q.region].label
      })
      return { loggedIn: true, label: '已配置', detail: `${qoders.length} 个令牌`, accounts: labels }
    },

    async needsLogin() {
      return !(await this.account()).loggedIn
    },

    /** 面板：Qoder 每天都有签到活动，这里只显示「今天可领」，真正的幂等由上游保证 */
    async panel() {
      const qoders = await loadQoders(env)
      const local = qoders.length ? null : await readLocalQoderLogin(env)
      const day = qoders.length || (local ? 1 : 0)
      return {
        style: 'daily',
        days: [{ dayNo: 1, date: beijingDay(), points: 0, bonusPoints: 0, status: day ? 2 : 1, isToday: true }],
        today: { dayNo: 1, date: beijingDay(), points: 0, bonusPoints: 0, status: day ? 2 : 1, isToday: true },
        claimable: day > 0,
        claimedDays: 0,
        totalPoints: 0,
        accountCredits: undefined,
        accounts: day,
        timeZone: QODER_TZ,
        description: day ? `已配置 ${day} 个 Qoder 令牌` : '未配置 Qoder 令牌',
      }
    },

    async run({ trigger = 'manual', dryRun = false } = {}) {
      const qoders = await loadQoders(env)
      // 没配 PAT 就用本机 Qoder App 的登录（OAuth token，直接可用）
      const local = qoders.length ? null : await readLocalQoderLogin(env)
      if (!qoders.length && !local) {
        throw Object.assign(new Error('Qoder 没登录：在本机 Qoder App 里登录一次，或在面板添加个人访问令牌'), { code: 'QODER_NOT_CONFIGURED' })
      }
      const day = beijingDay()
      const accounts = qoders.length
        ? qoders.map(q => ({ label: q.name || `#${q.id}`, pat: q.pat, region: q.region }))
        : [{ label: '本机 Qoder', token: local.token, region: local.region }]
      if (dryRun) {
        return {
          ok: true, outcome: OUTCOME.DRY, provider: 'qoder', trigger, timeZone: QODER_TZ,
          points: 0, day, message: `${accounts.length} 个 Qoder 账号（干跑，不真签）`,
        }
      }
      let signed = 0
      let already = 0
      let notYet = 0
      let noCampaign = 0
      let points = 0
      const messages = []
      for (const q of accounts) {
        try {
          const r = await qoderCheckin(q.pat, q.region, q.token)
          if (r.state === 'signed') { signed += 1; points += r.credit ?? 0; messages.push(`${q.label}：+${r.credit ?? '?'} 积分`) }
          else { already += 1; messages.push(`${q.label}：今天已签`) }
        } catch (error) {
          if (error.code === 'QODER_NOT_REFRESHED') {
            // 今天这轮还没刷出来：不是失败，过一会儿再来
            notYet += 1
            messages.push(`${q.label}：${error.message.slice(0, 90)}`)
          } else if (error.code === 'QODER_NO_CAMPAIGN') {
            noCampaign += 1
            messages.push(`${q.label}：${error.message.slice(0, 90)}`)
          } else {
            messages.push(`${q.label}：失败（${error.message.slice(0, 80)}）`)
          }
        }
      }
      const ok = signed + already > 0 || notYet + noCampaign === accounts.length
      const outcome = signed > 0 ? OUTCOME.CLAIMED
        : already > 0 ? OUTCOME.ALREADY
          : notYet > 0 ? OUTCOME.NOT_YET
            : noCampaign > 0 ? OUTCOME.NO_TASK
              : OUTCOME.FAILED
      const result = {
        ok,
        outcome,
        provider: 'qoder',
        trigger,
        timeZone: QODER_TZ,
        points,
        day,
        message: `Qoder：${messages.join('；')}`,
      }
      log(`dsh-checkin-all: [Qoder] ${result.message}`)
      if (!ok) throw Object.assign(new Error(result.message), { code: 'QODER_ALL_FAILED' })
      return result
    },

    async loginStart() {
      throw Object.assign(new Error('Qoder 要在面板里添加个人访问令牌（PAT）'), { code: 'QODER_MANUAL_CONFIG' })
    },
  }
}

/** 北京时间的 YYYY-MM-DD */
const beijingDay = beijingDayKey
