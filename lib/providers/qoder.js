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

import { loadQoders } from '../checkin-secrets.js'
import { OUTCOME } from './base.js'

export const QODER_REGIONS = {
  cn: { label: 'Qoder（国内版）', openApi: 'https://openapi.qoder.com.cn' },
  intl: { label: 'Qoder', openApi: 'https://openapi.qoder.sh' },
}

const TIMEOUT_MS = 20_000
const QODER_TZ = 'Asia/Shanghai'

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

/** 当天能领的 CLAIM_BENEFIT 活动 */
export function claimableCampaign(payload, now = Date.now()) {
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

/** 一个 Qoder 账号签到：signed（这次签上）/ already（今天已签）；返回送的积分 */
export async function qoderCheckin(pat, region) {
  const base = QODER_REGIONS[region].openApi
  const token = await exchangePat(pat, region)
  const list = await call(`${base}/sash/api/v1/me/campaigns`, { headers: headers(token) })
  if (list.status === 401 || list.status === 403) throw new QoderAuthError(`Qoder 登录无效（HTTP ${list.status}）`)
  if (list.status >= 400) throw new Error(`Qoder 活动列表 HTTP ${list.status}`)
  const campaign = claimableCampaign(list.json)
  if (!campaign) throw new Error('Qoder 现在没有可领取的签到活动（每天滚动发放，稍后会再试）')
  if (campaign.claimStatus === 'CLAIMED') return { state: 'already' }
  const claim = await call(`${base}/sash/api/v1/me/campaigns/${encodeURIComponent(String(campaign.campaignId ?? campaign.id ?? ''))}/claim`, {
    method: 'POST', headers: { ...headers(token), 'content-type': 'application/json' }, body: '{}',
  })
  if (claim.status >= 400) throw new Error(`Qoder 领取失败（HTTP ${claim.status}）：${String(claim.json?.message ?? '').slice(0, 120)}`)
  const body = (typeof claim.json.data === 'object' && claim.json.data !== null ? claim.json.data : claim.json)
  if (body.replayed === true) return { state: 'already' }
  if (body.status !== 'CLAIMED' && body.success !== true) throw new Error(`Qoder 签到返回异常：${JSON.stringify(claim.json).slice(0, 160)}`)
  const credit = amountOf(claim.json, campaign)
  return { state: 'signed', ...(credit !== undefined ? { credit } : {}) }
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
      const qoders = await loadQoders(env)
      if (!qoders.length) {
        return { loggedIn: false, label: '未配置', detail: '需要添加 Qoder 个人访问令牌', code: 'QODER_NOT_CONFIGURED' }
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
      const day = qoders.length
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
      if (!qoders.length) {
        throw Object.assign(new Error('没有配置 Qoder 个人访问令牌'), { code: 'QODER_NOT_CONFIGURED' })
      }
      const day = beijingDay()
      if (dryRun) {
        return {
          ok: true, outcome: OUTCOME.DRY, provider: 'qoder', trigger, timeZone: QODER_TZ,
          points: 0, day, message: `已配置 ${qoders.length} 个 Qoder 令牌（干跑，不真签）`,
        }
      }
      let signed = 0
      let already = 0
      let points = 0
      const messages = []
      for (const q of qoders) {
        try {
          const r = await qoderCheckin(q.pat, q.region)
          if (r.state === 'signed') { signed += 1; points += r.credit ?? 0; messages.push(`${q.name || `#${q.id}`}：+${r.credit ?? '?'} 积分`) }
          else { already += 1; messages.push(`${q.name || `#${q.id}`}：今天已签`) }
        } catch (error) {
          messages.push(`${q.name || `#${q.id}`}：失败（${error.message.slice(0, 80)}）`)
        }
      }
      const ok = signed + already > 0
      const outcome = signed > 0 ? OUTCOME.CLAIMED : already > 0 ? OUTCOME.ALREADY : 'failed'
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
function beijingDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: QODER_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
