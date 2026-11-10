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
import { CHECKIN_TZ, beijingDayKey } from '../tz.js'

const DETAIL_URL = 'https://www.doubao.com/alice/ug/campaign/v3/detail/'
const CHECKIN_URL = 'https://www.doubao.com/alice/ug/campaign/landing/checkin'
const CAMPAIGN_GROUP = 'pc_incentive_task_mvp_v3'
const LOGIN_INVALID = 710012001
/** 服务端认这个 cookie，但这个账号没有可领的签到活动 */
const NO_ACTIVITY = 710010702
const TIMEOUT_MS = 20_000
const DOUBAO_TZ = CHECKIN_TZ

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

/** 这个账号压根没有签到活动（不是 cookie 失效，也不是网络问题） */
export class DoubaoNoTaskError extends Error {
  constructor(message, detail) {
    super(message)
    this.code = 'DOUBAO_NO_TASK'
    this.detail = detail
  }
}

/** 签到状态（detail 接口）。Cookie 不对抛 DoubaoAuthError；没签到活动抛 DoubaoNoTaskError */
export async function doubaoStatus(cookie, seed) {
  const body = await post(apiUrl(DETAIL_URL, seed), cookie, { campaign_group_code: CAMPAIGN_GROUP })
  const code = Number(body.code)
  if (code === LOGIN_INVALID) throw new DoubaoAuthError('豆包登录已过期（Cookie 失效）')
  if (code !== 0) throw new Error(`豆包任务面板返回异常：${String(body.msg ?? body.message ?? '')}（code ${code}）`)
  const data = body.data ?? {}
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  const task = tasks.find((t) => t?.task_kind === 'daily_signin')
  if (!task) {
    // 有任务面板但没有 daily_signin：工作版/飞书企业账号是这样。
    // 把实际有哪些任务说出来，用户才知道是账号本身没有这个玩法。
    const kinds = [...new Set(tasks.map((t) => t?.task_kind).filter(Boolean))]
    throw new DoubaoNoTaskError(
      '这个豆包账号没有「每日签到」任务',
      { kinds, taskCount: tasks.length },
    )
  }
  const c = task?.daily_checkin ?? {}
  return {
    checkedIn: c.checked_in_today === true,
    continuousDays: Number(c.continuous_days) || 0,
    rewardAmount: Number(c.reward?.reward_amount) || 0,
    totalAmount: Number(data.progress?.total_amount) || 0,
  }
}

/** 签到：先看今天签没签，没签才领 */
export async function doubaoCheckin(cookie, seed) {
  const st = await doubaoStatus(cookie, seed)
  if (st.checkedIn) return { state: 'already' }
  const body = await post(apiUrl(CHECKIN_URL, seed), cookie, { scene: CAMPAIGN_GROUP })
  const code = Number(body.code)
  if (code === LOGIN_INVALID) throw new DoubaoAuthError('豆包登录已过期（Cookie 失效）')
  if (code === NO_ACTIVITY) {
    // 服务端认这个 cookie，但没有可领的签到活动
    throw new DoubaoNoTaskError('豆包说这个账号今天没有可领的签到活动', { code })
  }
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
      const names = doubaos.map(d => d.name || `#${d.id}`).join('、')
      // 顺手探一下有没有签到活动：工作版/飞书企业账号没有，
      // 提前说清楚，省得每天到点白试。
      let detail = `${doubaos.length} 个账号${names ? `（${names}）` : ''}`
      let noTask = false
      try {
        await doubaoStatus(doubaos[0].cookie, doubaos[0].seed)
      } catch (error) {
        if (error instanceof DoubaoNoTaskError) {
          noTask = true
          const kinds = error.detail?.kinds
          detail = `这个账号没有每日签到任务${kinds?.length ? `（现有：${kinds.join('/')}）` : ''}，换个人豆包账号`
        } else if (error instanceof DoubaoAuthError) {
          return { loggedIn: false, label: '登录已失效', detail: 'Cookie 过期了，重新登录豆包再复制', code: 'DOUBAO_AUTH' }
        }
      }
      return { loggedIn: true, label: noTask ? '已登录 · 无签到任务' : '已登录', detail, noTask, accounts: doubaos.length }
    },

    async needsLogin() {
      return !(await this.account()).loggedIn
    },

    async panel() {
      const doubaos = await loadDoubaos(env)
      const day = doubaos.length
      // 探一次有没有签到活动：没有就别假装「今天可领 +200」
      let noTask = false
      if (day) {
        try {
          await doubaoStatus(doubaos[0].cookie, doubaos[0].seed)
        } catch (error) {
          if (error instanceof DoubaoNoTaskError) noTask = true
        }
      }
      const status = !day ? 1 : noTask ? 4 : 2
      return {
        style: 'daily',
        days: [{ dayNo: 1, date: beijingDay(), points: 0, bonusPoints: 0, status, isToday: true }],
        today: { dayNo: 1, date: beijingDay(), points: 0, bonusPoints: 0, status, isToday: true },
        claimable: day > 0 && !noTask,
        claimedDays: 0,
        totalPoints: 0,
        accounts: day,
        timeZone: DOUBAO_TZ,
        description: !day
          ? '未配置豆包 Cookie'
          : noTask
            ? '这个豆包账号没有「每日签到」任务（工作版/飞书企业账号没有这个玩法）'
            : `已配置 ${day} 个豆包账号`,
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
      let noTask = 0
      let points = 0
      const messages = []
      for (const d of doubaos) {
        const label = d.name || `#${d.id}`
        try {
          const r = await doubaoCheckin(d.cookie, d.seed)
          if (r.state === 'signed') { signed += 1; points += r.credit ?? 0; messages.push(`${label}：+${r.credit ?? '?'} 额度`) }
          else { already += 1; messages.push(`${label}：今天已签`) }
        } catch (error) {
          if (error instanceof DoubaoNoTaskError) {
            // 账号本身没有这个玩法：说清楚，不当成故障重试
            noTask += 1
            const kinds = error.detail?.kinds
            messages.push(`${label}：${error.message}${kinds?.length ? `（这个账号现有任务：${kinds.join('/')}）` : ''}`)
          } else {
            messages.push(`${label}：失败（${error.message.slice(0, 80)}）`)
          }
        }
      }
      const ok = signed + already > 0 || noTask === doubaos.length
      const outcome = signed > 0 ? OUTCOME.CLAIMED
        : already > 0 ? OUTCOME.ALREADY
          : noTask > 0 ? OUTCOME.NO_TASK
            : OUTCOME.FAILED
      const result = {
        ok, outcome, provider: 'doubao', trigger, timeZone: DOUBAO_TZ, points, day,
        noTask, consecutiveDays: undefined,
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

const beijingDay = beijingDayKey
