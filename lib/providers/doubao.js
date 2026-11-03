// lib/providers/doubao.js — 豆包每日签到（「天天领额度」，每天 +200 体验额度）
//
// 协议照 dsh-model 的 src/checkin/doubao.ts（原自 techysy/CreditDaddy，MIT）：
//   POST https://www.doubao.com/alice/ug/campaign/v3/detail/        任务面板（含今天签没签）
//   POST https://www.doubao.com/alice/ug/campaign/landing/checkin   领取；服务端幂等，重复领返回 idempotent:true
// 鉴权只要 doubao.com 的登录 Cookie。请求带豆包电脑版网页的平台参数。
// 只支持个人账号：飞书企业账号的任务面板里没有签到任务。
// Cookie 由用户从浏览器复制一次（存 secrets.json，0600），或从本机浏览器自动读。

import { createHash } from 'node:crypto'
import { loadDoubaos } from '../checkin-secrets.js'
import { findDoubaoLogins, readDoubaoCookie } from './browser-cookies.js'
import { OUTCOME } from './base.js'

const DETAIL_URL = 'https://www.doubao.com/alice/ug/campaign/v3/detail/'
const CHECKIN_URL = 'https://www.doubao.com/alice/ug/campaign/landing/checkin'
const CAMPAIGN_GROUP = 'pc_incentive_task_mvp_v3'
const LOGIN_INVALID = 710012001
const TIMEOUT_MS = 20_000
const DOUBAO_TZ = 'Asia/Shanghai'

const CLIENT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DoubaoDesktop/2.32.6 Chrome/147.0.7727.149 Safari/537.36'
const COMMON_PARAMS = {
  version_code: '20800',
  language: 'zh',
  device_platform: 'web',
  doubao_device_platform: 'web',
  aid: '497858',
  real_aid: '497858',
  pkg_type: 'release_version',
  pc_version: '2.32.6',
  doubao_pc_version: '5.72.66',
  samantha_web: '1',
  web_platform: 'desktop',
  'use-olympus-account': '1',
  web_tab_id: '0',
}

export class DoubaoAuthError extends Error {}

/** 每个账号一组稳定的网页标识（由这个账号自己的随机种子派生，账号之间不同） */
export function deviceIdsFor(seed) {
  const h = createHash('sha256').update(`doubao-dev:${seed}`).digest()
  return {
    web_id: '76' + [...h.subarray(0, 8)].map((b) => b % 10).join(''),
    tea_uuid: [...h.subarray(8, 16)].map((b) => b % 10).join('').padEnd(16, '7'),
  }
}

function apiUrl(base, seed) {
  return `${base}?${new URLSearchParams({ ...COMMON_PARAMS, ...deviceIdsFor(seed), device_id: '', region: '', sys_region: '' })}`
}

/** 用户粘贴的可能是整行 "Cookie: a=b; c=d"，也可能带换行：规整成 "a=b; c=d" */
export function normalizeCookie(raw) {
  return String(raw || '').replace(/^\s*cookie\s*:\s*/i, '').replace(/[\r\n]+/g, ' ').replace(/\s*;\s*/g, '; ').replace(/;\s*$/, '').trim()
}

async function post(url, cookie, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.doubao.com/pc/agent-explore',
      Origin: 'https://www.doubao.com',
      'User-Agent': CLIENT_UA,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  try {
    const json = JSON.parse(text)
    if (json && typeof json === 'object') return json
  } catch {
    // 非 JSON
  }
  throw new Error(`豆包接口返回无法解析（HTTP ${res.status}）`)
}

/** 签到状态（detail 接口）。Cookie 不对抛 DoubaoAuthError */
export async function doubaoStatus(cookie, seed) {
  const body = await post(apiUrl(DETAIL_URL, seed), cookie, { campaign_group_code: CAMPAIGN_GROUP })
  const code = Number(body.code)
  if (code === LOGIN_INVALID) throw new DoubaoAuthError('豆包登录已过期（Cookie 失效）')
  if (code !== 0) throw new Error(`豆包任务面板返回异常：${String(body.msg ?? body.message ?? '')}（code ${code}）`)
  const data = body.data ?? {}
  const task = Array.isArray(data.tasks) ? data.tasks.find((t) => t?.task_kind === 'daily_signin') : undefined
  const c = task?.daily_checkin ?? {}
  return {
    checkedIn: task ? c.checked_in_today === true : null,
    continuousDays: Number(c.continuous_days) || 0,
    rewardAmount: Number(c.reward?.reward_amount) || 0,
    totalAmount: Number(data.progress?.total_amount) || 0,
  }
}

/** 签到：先看今天签没签，没签才领 */
export async function doubaoCheckin(cookie, seed) {
  const st = await doubaoStatus(cookie, seed)
  if (st.checkedIn === null) throw new Error('这个豆包账号的任务面板里没有「每日签到」（飞书企业账号、或豆包没给这个账号开签到时都是这样）')
  if (st.checkedIn) return { state: 'already' }
  const body = await post(apiUrl(CHECKIN_URL, seed), cookie, { scene: CAMPAIGN_GROUP })
  const code = Number(body.code)
  if (code === LOGIN_INVALID) throw new DoubaoAuthError('豆包登录已过期（Cookie 失效）')
  if (code !== 0) throw new Error(`豆包签到失败：${String(body.msg ?? body.message ?? '')}（code ${code}）`)
  const d = body.data ?? {}
  if (d.idempotent === true) return { state: 'already' }
  const credit = Number(d.reward_amount) || st.rewardAmount || undefined
  return { state: 'signed', ...(credit ? { credit } : {}) }
}

export function createDoubaoProvider({ log = () => {}, env = process.env } = {}) {
  const platform = env.DOUBAO_PLATFORM || process.platform

  return {
    id: 'doubao',
    name: '豆包',
    short: '豆包',
    color: '#3a7afe',
    unit: '额度',
    timeZoneMode: 'fixed',
    timeZone: DOUBAO_TZ,

    async account() {
      const doubaos = await loadDoubaos(env)
      if (!doubaos.length) {
        return { loggedIn: false, label: '未配置', detail: '需要添加豆包 Cookie（手动粘贴或从浏览器读）', code: 'DOUBAO_NOT_CONFIGURED' }
      }
      return { loggedIn: true, label: '已配置', detail: `${doubaos.length} 个账号` }
    },

    async needsLogin() {
      return !(await this.account()).loggedIn
    },

    async panel() {
      const doubaos = await loadDoubaos(env)
      const day = doubaos.length
      return {
        style: 'daily',
        days: [{ dayNo: 1, date: beijingDay(), points: 200, bonusPoints: 0, status: day ? 2 : 1, isToday: true }],
        today: { dayNo: 1, date: beijingDay(), points: 200, bonusPoints: 0, status: day ? 2 : 1, isToday: true },
        claimable: day > 0,
        claimedDays: 0,
        totalPoints: 0,
        accounts: day,
        timeZone: DOUBAO_TZ,
        description: day ? `已配置 ${day} 个豆包账号` : '未配置豆包 Cookie',
      }
    },

    async run({ trigger = 'manual', dryRun = false } = {}) {
      const doubaos = await loadDoubaos(env)
      if (!doubaos.length) {
        throw Object.assign(new Error('没有配置豆包 Cookie'), { code: 'DOUBAO_NOT_CONFIGURED' })
      }
      const day = beijingDay()
      if (dryRun) {
        return {
          ok: true, outcome: OUTCOME.DRY, provider: 'doubao', trigger, timeZone: DOUBAO_TZ,
          points: 0, day, message: `已配置 ${doubaos.length} 个豆包账号（干跑，不真签）`,
        }
      }
      let signed = 0
      let already = 0
      let points = 0
      const messages = []
      for (const d of doubaos) {
        const label = d.name || `#${d.id}`
        try {
          const r = await doubaoCheckin(d.cookie, d.seed)
          if (r.state === 'signed') { signed += 1; points += r.credit ?? 0; messages.push(`${label}：+${r.credit ?? '?'} 额度`) }
          else { already += 1; messages.push(`${label}：今天已签`) }
        } catch (error) {
          messages.push(`${label}：失败（${error.message.slice(0, 80)}）`)
        }
      }
      const ok = signed + already > 0
      const outcome = signed > 0 ? OUTCOME.CLAIMED : already > 0 ? OUTCOME.ALREADY : 'failed'
      const result = {
        ok, outcome, provider: 'doubao', trigger, timeZone: DOUBAO_TZ, points, day,
        message: `豆包：${messages.join('；')}`,
      }
      log(`dsh-checkin-all: [豆包] ${result.message}`)
      if (!ok) throw Object.assign(new Error(result.message), { code: 'DOUBAO_ALL_FAILED' })
      return result
    },

    async loginStart() {
      throw Object.assign(new Error('豆包要在面板里添加 Cookie（手动粘贴或从浏览器读）'), { code: 'DOUBAO_MANUAL_CONFIG' })
    },
  }
}

/** 从本机浏览器/豆包电脑版自动读 doubao.com 登录 Cookie（供面板「从本机读」用） */
export async function readLocalDoubaoCookie() {
  const logins = await findDoubaoLogins()
  if (!logins.length) return null
  const cookie = await readDoubaoCookie(logins[0])
  return { cookie, label: logins[0].label }
}

function beijingDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: DOUBAO_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
