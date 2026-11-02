// lib/store.js — 签到历史与设置（插件自己的小文件，不动任何 App 的东西）
//
// ~/.dsh/dsh-checkin-all/state.json    按服务分开记：{ version, providers: { minimax: {...}, lingxi: {...} } }
// ~/.dsh/dsh-checkin-all/config.json   设置（开关、每个服务几点签、时区覆盖、通知）
//
// 用「先写临时文件再改名」的原子替换：签到状态是钱（积分/智点）的账，不能写一半。
//
// 兼容老版本：老 state.json 是单服务的扁平结构（days/streak 在顶层），读的时候自动
// 当成 minimax 那一份，不会丢历史。

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pluginHome } from './paths.js'

const KEEP_DAYS = 400

export const DEFAULT_CONFIG = {
  enabled: true,
  /** 每天几点签到（本机时区，24 小时制，00:00-23:59） */
  time: '09:00',
  /** 时区覆盖：空 = 跟随本机 */
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
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, text, 'utf8')
  try {
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 本机日期字符串 YYYY-MM-DD（按给定时区，默认本机） */
export function dayKey(date = new Date(), timeZone = '') {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit',
    })
    return fmt.format(date)
  } catch {
    const pad = n => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
}

export async function loadConfig(env = process.env) {
  const saved = await readJson(configPath(env), {})
  const merged = { ...DEFAULT_CONFIG, ...(saved && typeof saved === 'object' ? saved : {}) }
  if (!merged.providers || typeof merged.providers !== 'object') merged.providers = {}
  return merged
}

export async function saveConfig(patch, env = process.env) {
  const current = await loadConfig(env)
  const next = { ...current, ...(patch || {}) }
  // 时间必须是 HH:MM
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(next.time || ''))) next.time = DEFAULT_CONFIG.time
  if (typeof next.timeZone !== 'string') next.timeZone = ''
  if (!next.providers || typeof next.providers !== 'object') next.providers = {}
  await writeAtomic(configPath(env), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/** 某个服务的单独设置（没写就跟着全局） */
export function providerConfig(config, id) {
  const own = (config && config.providers && config.providers[id]) || {}
  return {
    enabled: own.enabled === undefined ? Boolean(config && config.enabled) : Boolean(own.enabled),
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(own.time || '')) ? own.time : (config && config.time) || '09:00',
    catchUp: own.catchUp === undefined ? Boolean(config && config.catchUp) : Boolean(own.catchUp),
  }
}

// ── 状态 ──

function emptyProviderState() {
  return { lastAttempt: null, lastClaim: null, days: {}, streak: 0, totalPoints: 0 }
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
    }
  }
  return { version: 2, providers }
}

export async function saveState(state, env = process.env) {
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
 * @param {string} id 服务 id
 * @param {object} result provider 返回的结果
 */
export async function recordAttempt(id, result, env = process.env) {
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
  if (result.ok) {
    const previous = own.days[day]
    own.days[day] = {
      day,
      outcome: result.outcome || 'claimed',
      points: Number(result.points) || 0,
      dayNo: Number(result.dayNo) || 0,
      at: own.lastAttempt.at,
    }
    // 领到了新的分才累加（重复签到不加）
    if (!previous || previous.outcome !== result.outcome) {
      own.totalPoints = (Number(own.totalPoints) || 0) + (Number(result.points) || 0)
    }
    // lastClaim 只记真的领到分的那次
    if (result.outcome === 'claimed' && (Number(result.points) || 0) > 0) {
      own.lastClaim = { ...own.lastAttempt }
    }
    // 连续天数：昨天有记录就 +1，否则从 1 开始
    const yesterday = dayKey(new Date(Date.now() - 86_400_000), result.timeZone || '')
    own.streak = own.days[yesterday] ? (Number(own.streak) || 0) + 1 : 1
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

/** 最近 N 天的记录（新的在前），给面板画表 */
export function recentDays(state, id, count = 14, timeZone = '') {
  const own = state && state.providers ? state.providers[id] : null
  const out = []
  const now = Date.now()
  for (let i = 0; i < count; i += 1) {
    const day = dayKey(new Date(now - i * 86_400_000), timeZone)
    const entry = (own && own.days && own.days[day]) || null
    out.push({ day, entry })
  }
  return out
}
