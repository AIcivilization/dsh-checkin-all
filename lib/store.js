// lib/store.js — 签到历史与设置（插件自己的小文件，不动任何 App 的东西）
//
// ~/.dsh/dsh-checkin-all/state.json    按服务分开记：{ version, providers: { minimax: {...}, lingxi: {...} } }
// ~/.dsh/dsh-checkin-all/config.json   设置（开关、每个服务几点签、时区覆盖、通知）
//
// 用「先写临时文件再改名」的原子替换：签到状态是钱（积分/智点）的账，不能写一半。
//
// 兼容老版本：老 state.json 是单服务的扁平结构（days/streak 在顶层），读的时候自动
// 当成 minimax 那一份，不会丢历史。

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pluginHome } from './paths.js'
import { beijingDayKey, pointsFromDays, recentDayKeys, streakFromDays } from './tz.js'
import { BENIGN_OUTCOMES, DONE_OUTCOMES, NEEDS_USER_OUTCOMES } from './providers/base.js'
import { exclusive } from './lock.js'

const KEEP_DAYS = 400

export const DEFAULT_CONFIG = {
  enabled: true,
  /** 每天几点签到（北京时间，24 小时制，00:00-23:59） */
  time: '09:00',
  /** 已废弃：签到一律按北京时间，这个字段只为兼容老配置文件保留 */
  timeZone: '',
  /** 起来晚于签到时间也补一次 */
  catchUp: true,
  /** 签完在 DSH 里提示一句 */
  notify: true,
  /** 每个服务单独开关，没写的按全局 enabled */
  providers: {},
}

export function statePath(env = process.env) {
  return join(pluginHome(env), 'state.json')
}

export function configPath(env = process.env) {
  return join(pluginHome(env), 'config.json')
}

async function writeAtomic(file, text) {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // 同 checkin-secrets：已存在的目录不会被 mkdir 的 mode 改，显式收紧一次。
  // 这个目录里同时放着 secrets.json，不能是 755。
  await chmod(dir, 0o700).catch(() => {})
  // 临时文件名带随机串：同一进程里两次写同一个文件（多个服务同时记账）不能共用一个 tmp
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  // 签到历史不算机密，但同目录里是凭据，顺手也收紧
  await chmod(file, 0o600).catch(() => {})
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 日期字符串 YYYY-MM-DD。
 * 签到一律按北京时间算，timeZone 参数只为兼容老调用保留（传了也会被忽略）。
 */
export function dayKey(date = new Date(), _timeZone = '') {
  return beijingDayKey(date)
}

export async function loadConfig(env = process.env) {
  const saved = await readJson(configPath(env), {})
  const merged = { ...DEFAULT_CONFIG, ...(saved && typeof saved === 'object' ? saved : {}) }
  if (!merged.providers || typeof merged.providers !== 'object') merged.providers = {}
  return merged
}

export async function saveConfig(patch, env = process.env) {
  // 读改写整段加锁：面板、AI 工具、终端命令同时改设置时谁也不盖掉谁
  return exclusive(configPath(env), () => saveConfigUnlocked(patch, env))
}

async function saveConfigUnlocked(patch, env) {
  const current = await loadConfig(env)
  const next = { ...current, ...(patch || {}) }
  // 时间必须是 HH:MM
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(next.time || ''))) next.time = DEFAULT_CONFIG.time
  if (typeof next.timeZone !== 'string') next.timeZone = ''
  // providers 按服务合并：面板只改一个服务时不能冲掉别的服务的单独设置。
  // 显式传 providers: null 才是「清空所有单独设置，回退到全局」。
  if (patch && patch.providers === null) {
    next.providers = {}
  } else if (patch && patch.providers && typeof patch.providers === 'object') {
    next.providers = { ...(current.providers || {}) }
    for (const [id, value] of Object.entries(patch.providers)) {
      if (value === null) {
        // 传 null = 删掉这个服务的单独设置，回退全局
        delete next.providers[id]
      } else if (value && typeof value === 'object') {
        next.providers[id] = { ...((current.providers && current.providers[id]) || {}), ...value }
      }
    }
  } else if (!next.providers || typeof next.providers !== 'object') {
    next.providers = {}
  }
  await writeAtomic(configPath(env), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/**
 * 某些服务的活动有固定的「换轮时间」，在那之前签不到。
 * 例：Qoder 每天 10:00（UTC+8）才出新一轮，10:00 之前看到的还是昨天那轮。
 * 这些服务即使全局设了更早的时间，也要等到这个点之后再签。
 */
export const PROVIDER_EARLIEST_TIME = {
  qoder: '10:00',
}

/** 某个服务的单独设置（没写就跟着全局） */
export function providerConfig(config, id) {
  const own = (config && config.providers && config.providers[id]) || {}
  const configured = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(own.time || ''))
    ? own.time
    : (config && config.time) || '09:00'
  // 用户没单独设过时，按服务的换轮时间抬高；设过就尊重用户（他可能知道自己在做什么）
  const earliest = PROVIDER_EARLIEST_TIME[id]
  const time = (!own.time && earliest && configured < earliest) ? earliest : configured
  return {
    enabled: own.enabled === undefined ? Boolean(config && config.enabled) : Boolean(own.enabled),
    time,
    catchUp: own.catchUp === undefined ? Boolean(config && config.catchUp) : Boolean(own.catchUp),
  }
}

// ── 状态 ──

function emptyProviderState() {
  return { lastAttempt: null, lastClaim: null, days: {}, streak: 0, totalPoints: 0, serverStreak: null }
}

/** 把老的单服务扁平结构搬成 providers.minimax */
function migrateLegacy(saved) {
  const looksLegacy = saved && (saved.days || saved.streak !== undefined || saved.lastAttempt)
    && !saved.providers
  if (!looksLegacy) return null
  return {
    version: 2,
    providers: {
      minimax: {
        lastAttempt: saved.lastAttempt || null,
        lastClaim: saved.lastClaim || null,
        days: saved.days && typeof saved.days === 'object' ? saved.days : {},
        streak: Number(saved.streak) || 0,
        totalPoints: Number(saved.totalPoints) || 0,
      },
    },
  }
}

export async function loadState(env = process.env) {
  const saved = await readJson(statePath(env), null)
  if (!saved || typeof saved !== 'object') {
    return { version: 2, providers: {} }
  }
  const migrated = migrateLegacy(saved)
  if (migrated) return migrated
  const providers = {}
  for (const [id, value] of Object.entries(saved.providers || {})) {
    providers[id] = {
      lastAttempt: value.lastAttempt || null,
      lastClaim: value.lastClaim || null,
      days: value.days && typeof value.days === 'object' ? value.days : {},
      streak: Number(value.streak) || 0,
      totalPoints: Number(value.totalPoints) || 0,
      // 服务端给的连续天数（没有这个概念的服务这里是 null）
      serverStreak: value.serverStreak === undefined || value.serverStreak === null
        ? null
        : Number(value.serverStreak) || 0,
      // 多账号：每个账号最近一次的结果（key 由 provider 给，稳定不随改名变）
      ...(value.accounts && typeof value.accounts === 'object' ? { accounts: value.accounts } : {}),
    }
  }
  return { version: 2, providers }
}

export async function saveState(state, env = process.env) {
  return exclusive(statePath(env), () => saveStateUnlocked(state, env))
}

async function saveStateUnlocked(state, env) {
  // 每个服务只留最近 400 天
  for (const value of Object.values(state.providers || {})) {
    const keys = Object.keys(value.days || {}).sort()
    if (keys.length > KEEP_DAYS) {
      for (const key of keys.slice(0, keys.length - KEEP_DAYS)) delete value.days[key]
    }
  }
  await writeAtomic(statePath(env), `${JSON.stringify(state, null, 2)}\n`)
  return state
}

/** 取某个服务的记录（没有就建一个空的） */
export function providerState(state, id) {
  if (!state.providers) state.providers = {}
  if (!state.providers[id]) state.providers[id] = emptyProviderState()
  return state.providers[id]
}

/**
 * 记一次签到尝试（成功 / 已签 / 失败都记）。
 *
 * 记账规则（这几条以前是错的，会把人骗了）：
 *   - 只有 claimed / already_claimed 才写进 days 并参与连续天数；dry-run、失败不写
 *   - 同一天重复记录是幂等的：不会把连续天数越加越多
 *   - 连续天数按 days 里的真实日期重算，不做累加
 *   - 累计积分按 days 里 claimed 的分重算，不做累加
 *   - 服务端给了连续天数（灵犀/DuMate）就以服务端为准，断了能立刻看出来
 *
 * @param {string} id 服务 id
 * @param {object} result provider 返回的结果
 */
export async function recordAttempt(id, result, env = process.env) {
  // 读改写整段加锁：几个服务并行签到、各自记账时不能互相覆盖
  return exclusive(statePath(env), () => recordAttemptUnlocked(id, result, env))
}

/** 把多账号的逐条结果整理成 { key: 最近一次结果 }（只保留这次跑到的账号 = 现在还在的账号） */
function accountsFrom(perAccount, day, at) {
  const out = {}
  perAccount.forEach((p, i) => {
    if (!p || typeof p !== 'object') return
    const key = String(p.key || p.label || i + 1)
    out[key] = {
      label: String(p.label || key),
      day,
      at,
      ok: Boolean(p.ok),
      outcome: String(p.outcome || (p.ok ? 'claimed' : 'failed')),
      points: Number(p.points) || 0,
      message: String(p.message || ''),
    }
  })
  return out
}

async function recordAttemptUnlocked(id, result, env) {
  const state = await loadState(env)
  const own = providerState(state, id)
  const day = result.day || dayKey(new Date(), result.timeZone || '')
  own.lastAttempt = {
    at: new Date().toISOString(),
    day,
    ok: Boolean(result.ok),
    outcome: result.outcome || '',
    points: Number(result.points) || 0,
    dayNo: Number(result.dayNo) || 0,
    message: result.message || '',
  }

  if (Array.isArray(result.perAccount) && result.outcome !== 'dry-run') {
    own.accounts = accountsFrom(result.perAccount, day, own.lastAttempt.at)
  }

  const done = Boolean(result.ok) && DONE_OUTCOMES.has(result.outcome)

  if (done) {
    const previous = own.days[day]
    // 同一天已经记过：保留更「有料」的那条（claimed 优于 already_claimed，且不丢分）
    const keepClaimed = previous
      && previous.outcome === 'claimed'
      && (result.outcome !== 'claimed' || (Number(previous.points) || 0) >= (Number(result.points) || 0))
    own.days[day] = {
      day,
      outcome: keepClaimed ? previous.outcome : (result.outcome || 'claimed'),
      points: keepClaimed ? (Number(previous.points) || 0) : (Number(result.points) || 0),
      dayNo: Number(result.dayNo) || Number(previous && previous.dayNo) || 0,
      at: own.lastAttempt.at,
    }
    // lastClaim 只记真的领到分的那次
    if (result.outcome === 'claimed' && (Number(result.points) || 0) > 0) {
      own.lastClaim = { ...own.lastAttempt }
    }
  } else if (result.outcome === 'dry-run') {
    // 只看没领：什么都不改，连失败计数都不动
    await saveState(state, env)
    return state
  }

  // 账本重算（不是累加）
  own.streak = streakFromDays(own.days)
  own.totalPoints = pointsFromDays(own.days)

  // 服务端连续天数优先：断了要立刻显示断，不能继续挂着旧数字。
  // 只认服务端真的报了数字的情况——AStudio 这类没有连续天数概念的压根不传，
  // 不能让它把本地重算出来的连续天数清零。
  const serverStreak = Number(result.consecutiveDays)
  const hasServerStreak = result.consecutiveDays !== undefined
    && result.consecutiveDays !== null
    && Number.isFinite(serverStreak)
    && serverStreak >= 0
  if (done && hasServerStreak) {
    own.serverStreak = serverStreak
    own.streak = serverStreak
  }

  await saveState(state, env)
  return state
}

/** 今天签过了吗（按天，按服务） */
export function claimedToday(state, id, timeZone = '') {
  const own = state && state.providers ? state.providers[id] : null
  if (!own || !own.days) return false
  const day = dayKey(new Date(), timeZone)
  const entry = own.days[day]
  return Boolean(entry && (entry.outcome === 'claimed' || entry.outcome === 'already_claimed'))
}

/**
 * 今天还要重试的账号：今天试过、没签上、也不是「没这玩法 / 没到轮次 / 要重新登录」。
 * 多账号时一个账号失败不该被别的账号的成功盖住（#多账号互不冲突）。
 */
export function pendingAccounts(state, id) {
  const own = state && state.providers ? state.providers[id] : null
  if (!own || !own.accounts) return []
  const today = dayKey()
  return Object.entries(own.accounts)
    .filter(([, a]) => a && a.day === today && !isSettled(a))
    .map(([key, a]) => ({ key, ...a }))
}

/** 这个账号今天的结果是不是不用再试了 */
export function isSettled(a) {
  const outcome = String((a && a.outcome) || '')
  return DONE_OUTCOMES.has(outcome) || BENIGN_OUTCOMES.has(outcome) || NEEDS_USER_OUTCOMES.has(outcome) || outcome === 'dry-run'
}

/** 这个服务今天彻底签完了吗：当天有成功记录，而且没有还要重试的账号 */
export function providerDoneToday(state, id) {
  return claimedToday(state, id) && pendingAccounts(state, id).length === 0
}

/** 最近 N 天的记录（新的在前），给面板画表。日期一律北京时间 */
export function recentDays(state, id, count = 14, _timeZone = '') {
  const own = state && state.providers ? state.providers[id] : null
  return recentDayKeys(count).map((day) => ({
    day,
    entry: (own && own.days && own.days[day]) || null,
  }))
}
