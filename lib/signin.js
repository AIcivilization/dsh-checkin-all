// lib/signin.js — 签到接口
//
// MiniMax Code 桌面端（MiniMax Code.app）自己用的就是这两个接口，这里原样调用：
//   GET  <matrix>/minimax-cloud/api/v1/signin/status?timezone_id=<IANA>
//   POST <matrix>/minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>
// 两个都要 `Authorization: Bearer <access token>`。matrix 主机按 region 分（agent.minimax.io / agent.minimax.cn）。
//
// 返回的 panel 是一周的签到表：days[7]，每天有 day_no / points / status / is_today / bonus_points。
//   status：1 未到（Upcoming）、2 可领（Claimable）、3 已领（Claimed）、4 不可用（Disabled）
// claim 返回 claim_result：1 领取成功、2 今天已经领过。
// 「今天」是按 timezone_id 算的，所以本机时区必须带上，否则服务端会报 invalid timezone_id。

import { matrixOrigin } from './paths.js'

export const DAY_STATUS = { upcoming: 1, claimable: 2, claimed: 3, disabled: 4 }
export const CLAIM_RESULT = { claimed: 1, alreadyClaimed: 2 }

export class SigninError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

/** 本机 IANA 时区（Node 一定有；拿不到就退回 UTC） */
export function localTimeZone(now = new Date()) {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz) return tz
  } catch { /* 落到下面 */ }
  const offset = -now.getTimezoneOffset()
  return offset === 0 ? 'UTC' : `UTC${offset > 0 ? '+' : '-'}${Math.abs(offset / 60)}`
}

function statusUrl(origin, timeZone) {
  return `${origin}/minimax-cloud/api/v1/signin/status?timezone_id=${encodeURIComponent(timeZone)}`
}

function claimUrl(origin, timeZone) {
  return `${origin}/minimax-cloud/api/v1/signin/claim?timezone_id=${encodeURIComponent(timeZone)}`
}

const HEADERS = {
  accept: 'application/json',
  'user-agent': 'MiniMaxCode',
  'x-mavis-desktop-channel': 'desktop',
}

async function call(url, { method = 'GET', token, body, timeoutMs = 20_000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...HEADERS,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
    ...(method === 'POST' ? { body: body ?? '{}' } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!response.ok) {
    throw new SigninError('HTTP_ERROR', `签到接口返回 HTTP ${response.status}`, text.slice(0, 300))
  }
  if (!json) {
    throw new SigninError('BAD_RESPONSE', '签到接口返回的不是 JSON', text.slice(0, 300))
  }
  const base = json.base_resp || {}
  const code = typeof base.status_code === 'number' ? base.status_code : 0
  if (code !== 0) {
    throw new SigninError('API_ERROR', base.status_msg || `签到接口报错（${code}）`, { statusCode: code, base })
  }
  if (!json.data || typeof json.data !== 'object') {
    throw new SigninError('BAD_RESPONSE', '签到接口没有返回 data')
  }
  return json.data
}

/** 一周签到表校验 + 归一化 */
export function normalizePanel(panel) {
  const days = Array.isArray(panel && panel.days) ? panel.days : []
  const list = days.map(day => ({
    dayNo: Number(day.day_no) || 0,
    points: Number(day.points) || 0,
    bonusPoints: Number(day.bonus_points) || 0,
    status: Number(day.status) || DAY_STATUS.disabled,
    isToday: Boolean(day.is_today),
  })).sort((a, b) => a.dayNo - b.dayNo)
  const today = list.find(day => day.isToday) || null
  return {
    scene: Number(panel && panel.scene) || 0,
    days: list,
    today,
    claimable: list.some(day => day.status === DAY_STATUS.claimable),
    claimedDays: list.filter(day => day.status === DAY_STATUS.claimed).length,
    totalPoints: list.filter(day => day.status === DAY_STATUS.claimed)
      .reduce((sum, day) => sum + day.points + day.bonusPoints, 0),
  }
}

/** 读签到面板 */
export async function fetchPanel({ buildEnv, region, token, timeZone, timeoutMs } = {}) {
  const origin = matrixOrigin(buildEnv, region)
  const tz = timeZone || localTimeZone()
  const data = await call(statusUrl(origin, tz), { token, timeoutMs })
  return { panel: normalizePanel(data), timeZone: tz, origin }
}

/** 领今天的分 */
export async function claim({ buildEnv, region, token, timeZone, timeoutMs } = {}) {
  const origin = matrixOrigin(buildEnv, region)
  const tz = timeZone || localTimeZone()
  const data = await call(claimUrl(origin, tz), { method: 'POST', token, timeoutMs })
  const result = Number(data.claim_result) || 0
  return {
    claimResult: result,
    claimed: result === CLAIM_RESULT.claimed,
    alreadyClaimed: result === CLAIM_RESULT.alreadyClaimed,
    claimId: typeof data.claim_id === 'string' ? data.claim_id : '',
    dayNo: Number(data.day_no) || 0,
    points: Number(data.points) || 0,
    expireAtMs: Number(data.expire_at_ms) || 0,
    panel: data.panel ? normalizePanel(data.panel) : null,
    timeZone: tz,
  }
}

/** 一句话描述今天的状态（给日志 / 面板 / 对话用） */
export function describePanel(panel) {
  if (!panel || !panel.days.length) return '签到表读不出来'
  const today = panel.today
  if (!today) return '签到表里没有今天'
  if (today.status === DAY_STATUS.claimed) {
    return `今天（第 ${today.dayNo} 天）已经签过了，+${today.points + today.bonusPoints} 分`
  }
  if (today.status === DAY_STATUS.claimable) {
    return `今天（第 ${today.dayNo} 天）可以领 ${today.points + today.bonusPoints} 分`
  }
  return `今天（第 ${today.dayNo} 天）现在不可领（status=${today.status}）`
}
