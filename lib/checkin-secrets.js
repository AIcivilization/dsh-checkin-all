// lib/checkin-secrets.js — 签到凭据存储（手动配置 + Qoder PAT / 豆包 Cookie）
//
// 这些是用户填写的签到凭据，和设置/历史分开存，文件 0600。
//
// 结构（~/.dsh/dsh-checkin-all/secrets.json）：
//   { "checkin": {
//       "qoders": [{ id, pat, region, name?, savedAt? }],
//       "doubaos": [{ id, cookie, seed, name?, from?, savedAt? }],
//       "manual": {
//         "lingxi":  { wps_sid },
//         "dumate":  { cookie },                 // 完整 Cookie 串，含 bce-user-info（csrftoken）
//         "astudio": { accountId, token, ssoSessionId? },
//         "trae":    { token }                   // Cloud-IDE-JWT
//       }
//     } }
//
// manual 里的每项都能让服务独立配置，不依赖本机 App 文件（VPS 上也能用）。

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pluginHome } from './paths.js'

export function secretsPath(env = process.env) {
  return join(pluginHome(env), 'secrets.json')
}

async function writeAtomicPrivate(file, text) {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // mkdir 的 mode 对**已存在**的目录不生效（recursive 遇到已存在的直接跳过），
  // 所以每次写都显式收紧一次：这个目录里放的是凭据，不能让同机其他用户列出来。
  await chmod(dir, 0o700).catch(() => {})
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, text, { mode: 0o600 })
  await chmod(tmp, 0o600).catch(() => {})
  try {
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  await chmod(file, 0o600).catch(() => {})
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

export async function loadSecrets(env = process.env) {
  const doc = await readJson(secretsPath(env))
  return doc && typeof doc === 'object' ? doc : {}
}

export async function saveSecrets(secrets, env = process.env) {
  await writeAtomicPrivate(secretsPath(env), `${JSON.stringify(secrets, null, 2)}\n`)
  return secrets
}

/** Cookie 串里某一项的值 */
export function cookieValue(cookie, name) {
  for (const part of String(cookie || '').split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1)
  }
  return undefined
}

// ── 手动配置（灵犀 / 搭子 / AStudio / Trae 的独立凭据）──

export async function loadManual(env = process.env) {
  const secrets = await loadSecrets(env)
  return secrets.checkin?.manual ?? {}
}

/** 读某个服务的手动凭据；没有返回 null */
export async function getManual(provider, env = process.env) {
  const manual = await loadManual(env)
  return manual[provider] && typeof manual[provider] === 'object' ? manual[provider] : null
}

/** 写某个服务的手动凭据（传 null 删除） */
export async function setManual(provider, entry, env = process.env) {
  const secrets = await loadSecrets(env)
  const checkin = { ...(secrets.checkin || {}) }
  const manual = { ...(checkin.manual || {}) }
  if (entry === null) delete manual[provider]
  else manual[provider] = { ...(manual[provider] || {}), ...entry }
  if (Object.keys(manual).length) checkin.manual = manual
  else delete checkin.manual
  if (Object.keys(checkin).length) secrets.checkin = checkin
  else delete secrets.checkin
  await saveSecrets(secrets, env)
  return manual[provider] ?? null
}

// ── Qoder 令牌 ──

export async function loadQoders(env = process.env) {
  const secrets = await loadSecrets(env)
  const c = secrets.checkin
  if (c?.qoders?.length) return c.qoders
  // 旧版：只有一个令牌（qoder.pat），读出来当第一个
  return c?.qoder?.pat
    ? [{ id: '1', pat: c.qoder.pat, region: c.qoder.region, ...(c.qoder.savedAt ? { savedAt: c.qoder.savedAt } : {}) }]
    : []
}

async function saveQoders(list, env = process.env) {
  const secrets = await loadSecrets(env)
  const checkin = { ...(secrets.checkin || {}) }
  delete checkin.qoder
  if (list.length) checkin.qoders = list
  else delete checkin.qoders
  if (Object.keys(checkin).length) secrets.checkin = checkin
  else delete secrets.checkin
  await saveSecrets(secrets, env)
}

/** 加一个令牌：同一个令牌再加就是改名字 / 区域；返回 id */
export async function addQoder(entry, env = process.env) {
  const list = await loadQoders(env)
  const name = entry.name?.trim().slice(0, 20)
  const same = list.find((q) => q.pat === entry.pat)
  if (same) {
    same.region = entry.region
    if (name) same.name = name
    await saveQoders(list, env)
    return same.id
  }
  const used = new Set(list.map((q) => q.id))
  let n = list.length + 1
  while (used.has(String(n))) n++
  const id = String(n)
  list.push({ id, pat: entry.pat, region: entry.region, ...(name ? { name } : {}), savedAt: new Date().toISOString() })
  await saveQoders(list, env)
  return id
}

export async function removeQoder(id, env = process.env) {
  const list = await loadQoders(env)
  const target = id ?? list[0]?.id
  await saveQoders(list.filter((q) => q.id !== target), env)
}

// ── 豆包 Cookie ──

export async function loadDoubaos(env = process.env) {
  const secrets = await loadSecrets(env)
  return secrets.checkin?.doubaos ?? []
}

async function saveDoubaos(list, env = process.env) {
  const secrets = await loadSecrets(env)
  const checkin = { ...(secrets.checkin || {}) }
  if (list.length) checkin.doubaos = list
  else delete checkin.doubaos
  if (Object.keys(checkin).length) secrets.checkin = checkin
  else delete secrets.checkin
  await saveSecrets(secrets, env)
}

/** 同一个豆包账号：uid_tt 一样（Cookie 里别的项每次都会变） */
function sameDoubaoAccount(a, b) {
  const x = cookieValue(a, 'uid_tt')
  return a === b || (Boolean(x) && x === cookieValue(b, 'uid_tt'))
}

/** 加一个豆包账号；同一个账号再加 = 换成新的 Cookie（和名字）。返回 id */
export async function addDoubao(entry, env = process.env) {
  const list = await loadDoubaos(env)
  const name = entry.name?.trim().slice(0, 20)
  const same = list.find((d) => sameDoubaoAccount(d.cookie, entry.cookie))
  if (same) {
    same.cookie = entry.cookie
    if (name) same.name = name
    if (entry.from) same.from = entry.from
    await saveDoubaos(list, env)
    return same.id
  }
  const used = new Set(list.map((d) => d.id))
  let n = list.length + 1
  while (used.has(String(n))) n++
  const id = String(n)
  list.push({ id, cookie: entry.cookie, seed: entry.seed ?? randomBytes(16).toString('hex'), ...(name ? { name } : {}), ...(entry.from ? { from: entry.from } : {}), savedAt: new Date().toISOString() })
  await saveDoubaos(list, env)
  return id
}

export async function removeDoubao(id, env = process.env) {
  const list = await loadDoubaos(env)
  const next = list.filter((d) => d.id !== id)
  if (next.length === list.length) return false
  await saveDoubaos(next, env)
  return true
}

// ── 多账号（每个服务可以存多份凭据）──
//
// 结构：manual[provider] = { accounts: [{ id, name, ...凭据字段 }], ...旧版单账号字段 }
//
// 兼容规则：
//   - 老数据是「单账号扁平结构」（如 manual.lingxi = { wps_sid }），
//     读的时候自动当成 1 个账号，id 用 '1'
//   - 新数据用 accounts 数组；写第一个账号时会把旧的扁平字段清掉
//
// 这样升级不会丢已有凭据，用户不用重新配。

/** 生成下一个可用账号 id（'1'、'2'…） */
function nextAccountId(list) {
  const used = new Set(list.map((a) => String(a && a.id)))
  let n = list.length + 1
  while (used.has(String(n))) n += 1
  return String(n)
}

/** 凭据字段里哪些不算「身份信息」 */
const ACCOUNT_META_KEYS = new Set(['id', 'name', 'savedAt', 'from', 'accounts'])

/**
 * 读某个服务的所有账号（统一成数组）。
 * 老的单账号结构会当成 1 个账号返回，不会丢数据。
 */
export async function listAccounts(provider, env = process.env) {
  const entry = await getManual(provider, env)
  if (!entry) return []
  if (Array.isArray(entry.accounts)) {
    return entry.accounts
      .filter((a) => a && typeof a === 'object')
      .map((a, i) => ({ id: String(a.id || i + 1), name: a.name || '', ...a }))
  }
  // 老结构：把除 meta 以外的字段当成一份凭据
  const flat = {}
  let has = false
  for (const [k, v] of Object.entries(entry)) {
    if (ACCOUNT_META_KEYS.has(k)) continue
    if (v === undefined || v === null || v === '') continue
    flat[k] = v
    has = true
  }
  if (!has) return []
  return [{ id: '1', name: entry.name || '', ...flat }]
}

/** 覆盖写某个服务的全部账号 */
export async function saveAccounts(provider, accounts, env = process.env) {
  const list = (Array.isArray(accounts) ? accounts : [])
    .filter((a) => a && typeof a === 'object')
    .map((a, i) => ({ ...a, id: String(a.id || i + 1) }))
  if (!list.length) {
    // 清空：整个服务的手动凭据都删掉
    await setManual(provider, null, env)
    return []
  }
  // 用 accounts 整体替换，同时清掉可能残留的老扁平字段
  const secrets = await loadSecrets(env)
  const checkin = { ...(secrets.checkin || {}) }
  const manual = { ...(checkin.manual || {}) }
  manual[provider] = { accounts: list }
  checkin.manual = manual
  secrets.checkin = checkin
  await saveSecrets(secrets, env)
  return list
}

/** 加一个账号；给了 id 就是更新那个 */
export async function addAccount(provider, entry, env = process.env) {
  const list = await listAccounts(provider, env)
  const name = entry && entry.name ? String(entry.name).trim().slice(0, 24) : ''
  const id = entry && entry.id ? String(entry.id) : nextAccountId(list)
  const idx = list.findIndex((a) => String(a.id) === id)
  const record = {
    ...(idx >= 0 ? list[idx] : {}),
    ...entry,
    id,
    ...(name ? { name } : {}),
    savedAt: new Date().toISOString(),
  }
  if (idx >= 0) list[idx] = record
  else list.push(record)
  await saveAccounts(provider, list, env)
  return record
}

/** 删一个账号（按 id） */
export async function removeAccount(provider, id, env = process.env) {
  const list = await listAccounts(provider, env)
  const next = list.filter((a) => String(a.id) !== String(id))
  if (next.length === list.length) return false
  await saveAccounts(provider, next, env)
  return true
}
