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
import { exclusive } from './lock.js'
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

/**
 * 写之前读：文件不存在当空的；**存在但解不开就报错**，绝不当成空的往回写
 * （否则下一次写会把所有账号的凭据一起清掉。dsh-model 0.38.4 踩过）。
 */
async function loadSecretsForWrite(env) {
  let text
  try {
    text = await readFile(secretsPath(env), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
  try {
    const doc = JSON.parse(text)
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc
  } catch {
    // 落到下面
  }
  throw Object.assign(
    new Error(`凭据文件 ${secretsPath(env)} 读不出来（可能被手动改坏了）。为了不把已有账号清空，这次没有写入；修好或删掉这个文件后再试`),
    { code: 'SECRETS_CORRUPT' },
  )
}

/**
 * 读 → 改 → 写 secrets.json，整段加锁（本进程排队 + 跨进程锁文件）。
 * fn 直接改传进来的对象，返回值原样带出。多个账号同时续期写回、面板同时加账号都不会互相覆盖。
 */
export function updateSecrets(fn, env = process.env) {
  return exclusive(secretsPath(env), async () => {
    const secrets = await loadSecretsForWrite(env)
    const result = await fn(secrets)
    await writeAtomicPrivate(secretsPath(env), `${JSON.stringify(secrets, null, 2)}\n`)
    return result
  })
}

/** 整份覆盖（同样加锁）。改局部请用 updateSecrets */
export async function saveSecrets(secrets, env = process.env) {
  await exclusive(secretsPath(env), () => writeAtomicPrivate(secretsPath(env), `${JSON.stringify(secrets, null, 2)}\n`))
  return secrets
}

/** 改 secrets.checkin 里的一段；空了就把键删掉 */
function editCheckin(secrets, fn) {
  const checkin = { ...(secrets.checkin || {}) }
  const result = fn(checkin)
  for (const [k, v] of Object.entries(checkin)) {
    if (v === undefined || (Array.isArray(v) && !v.length) || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete checkin[k]
  }
  if (Object.keys(checkin).length) secrets.checkin = checkin
  else delete secrets.checkin
  return result
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
  return updateSecrets((secrets) => editCheckin(secrets, (checkin) => {
    const manual = { ...(checkin.manual || {}) }
    if (entry === null) delete manual[provider]
    else manual[provider] = { ...(manual[provider] || {}), ...entry }
    checkin.manual = manual
    return manual[provider] ?? null
  }), env)
}

/**
 * 读 → 改 → 写某个服务的手动凭据（整段加锁）。fn 拿到一份可改的对象（没有就是 {}），
 * 返回值原样带出；改完是空对象就把这个服务删掉。
 */
export async function editManual(provider, fn, env = process.env) {
  return updateSecrets((secrets) => editCheckin(secrets, (checkin) => {
    const manual = { ...(checkin.manual || {}) }
    const entry = manual[provider] && typeof manual[provider] === 'object' ? { ...manual[provider] } : {}
    const result = fn(entry)
    if (Object.keys(entry).length) manual[provider] = entry
    else delete manual[provider]
    checkin.manual = manual
    return result
  }), env)
}

// ── Qoder 令牌 ──

function qodersOf(c) {
  if (c?.qoders?.length) return c.qoders
  // 旧版：只有一个令牌（qoder.pat），读出来当第一个
  return c?.qoder?.pat
    ? [{ id: '1', pat: c.qoder.pat, region: c.qoder.region, ...(c.qoder.savedAt ? { savedAt: c.qoder.savedAt } : {}) }]
    : []
}

export async function loadQoders(env = process.env) {
  return qodersOf((await loadSecrets(env)).checkin)
}

/** 下一个没用过的 id（'1'、'2'…） */
function nextId(list) {
  const used = new Set(list.map((a) => String(a && a.id)))
  let n = list.length + 1
  while (used.has(String(n))) n += 1
  return String(n)
}

/** 改一组 Qoder 令牌（整段加锁） */
function editQoders(fn, env) {
  return updateSecrets((secrets) => editCheckin(secrets, (checkin) => {
    const list = [...qodersOf(checkin)]
    const result = fn(list)
    delete checkin.qoder
    checkin.qoders = list
    return result
  }), env)
}

/** 加一个令牌：同一个令牌再加就是改名字 / 区域；返回 id */
export async function addQoder(entry, env = process.env) {
  const name = entry.name?.trim().slice(0, 20)
  return editQoders((list) => {
    const same = list.find((q) => q.pat === entry.pat)
    if (same) {
      same.region = entry.region
      if (name) same.name = name
      return same.id
    }
    const id = nextId(list)
    list.push({ id, pat: entry.pat, region: entry.region, ...(name ? { name } : {}), savedAt: new Date().toISOString() })
    return id
  }, env)
}

export async function removeQoder(id, env = process.env) {
  await editQoders((list) => {
    const target = id ?? list[0]?.id
    const i = list.findIndex((q) => q.id === target)
    if (i >= 0) list.splice(i, 1)
  }, env)
}

// ── 豆包 Cookie ──

export async function loadDoubaos(env = process.env) {
  const secrets = await loadSecrets(env)
  return secrets.checkin?.doubaos ?? []
}

function editDoubaos(fn, env) {
  return updateSecrets((secrets) => editCheckin(secrets, (checkin) => {
    const list = [...(checkin.doubaos || [])]
    const result = fn(list)
    checkin.doubaos = list
    return result
  }), env)
}

/** 同一个豆包账号：uid_tt 一样（Cookie 里别的项每次都会变） */
function sameDoubaoAccount(a, b) {
  const x = cookieValue(a, 'uid_tt')
  return a === b || (Boolean(x) && x === cookieValue(b, 'uid_tt'))
}

/** 加一个豆包账号；同一个账号再加 = 换成新的 Cookie（和名字）。返回 id */
export async function addDoubao(entry, env = process.env) {
  const name = entry.name?.trim().slice(0, 20)
  return editDoubaos((list) => {
    const same = list.find((d) => sameDoubaoAccount(d.cookie, entry.cookie))
    if (same) {
      same.cookie = entry.cookie
      if (name) same.name = name
      if (entry.from) same.from = entry.from
      return same.id
    }
    const id = nextId(list)
    list.push({ id, cookie: entry.cookie, seed: entry.seed ?? randomBytes(16).toString('hex'), ...(name ? { name } : {}), ...(entry.from ? { from: entry.from } : {}), savedAt: new Date().toISOString() })
    return id
  }, env)
}

export async function removeDoubao(id, env = process.env) {
  return editDoubaos((list) => {
    const i = list.findIndex((d) => d.id === id)
    if (i < 0) return false
    list.splice(i, 1)
    return true
  }, env)
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

/** 凭据字段里哪些不算「身份信息」 */
const ACCOUNT_META_KEYS = new Set(['id', 'name', 'savedAt', 'from', 'accounts'])

/** 一个服务的手动凭据 → 账号数组（老的单账号扁平结构当成 1 个账号，不丢数据） */
function accountsOf(entry) {
  if (!entry || typeof entry !== 'object') return []
  if (Array.isArray(entry.accounts)) {
    return entry.accounts
      .filter((a) => a && typeof a === 'object')
      .map((a, i) => ({ id: String(a.id || i + 1), name: a.name || '', ...a }))
  }
  const flat = {}
  let has = false
  for (const [k, v] of Object.entries(entry)) {
    if (ACCOUNT_META_KEYS.has(k)) continue
    if (v === undefined || v === null || v === '') continue
    flat[k] = v
    has = true
  }
  return has ? [{ id: '1', name: entry.name || '', ...flat }] : []
}

/** 读某个服务的所有账号（统一成数组） */
export async function listAccounts(provider, env = process.env) {
  return accountsOf(await getManual(provider, env))
}

/** 改某个服务的账号数组（整段加锁）：fn 改传进来的数组 */
export function editAccounts(provider, fn, env = process.env) {
  return updateSecrets((secrets) => editCheckin(secrets, (checkin) => {
    const manual = { ...(checkin.manual || {}) }
    const list = accountsOf(manual[provider])
    const result = fn(list)
    const clean = list.filter((a) => a && typeof a === 'object').map((a, i) => ({ ...a, id: String(a.id || i + 1) }))
    // 用 accounts 整体替换，同时清掉可能残留的老扁平字段；空了就整个删掉
    if (clean.length) manual[provider] = { accounts: clean }
    else delete manual[provider]
    checkin.manual = manual
    return result
  }), env)
}

/** 覆盖写某个服务的全部账号 */
export async function saveAccounts(provider, accounts, env = process.env) {
  return editAccounts(provider, (list) => {
    list.splice(0, list.length, ...(Array.isArray(accounts) ? accounts : []))
    return list.filter((a) => a && typeof a === 'object').map((a, i) => ({ ...a, id: String(a.id || i + 1) }))
  }, env)
}

/** 加一个账号；给了 id 就是更新那个 */
export async function addAccount(provider, entry, env = process.env) {
  return editAccounts(provider, (list) => {
    const name = entry && entry.name ? String(entry.name).trim().slice(0, 24) : ''
    const id = entry && entry.id ? String(entry.id) : nextId(list)
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
    return record
  }, env)
}

/**
 * 只改一个账号的某几个字段（续期写回用：别的账号、名字都不动）。
 * 账号已经被删了就什么也不做，返回 false。
 */
export async function patchAccount(provider, id, patch, env = process.env) {
  return editAccounts(provider, (list) => {
    const a = list.find((x) => String(x.id) === String(id))
    if (!a) return false
    Object.assign(a, patch)
    return true
  }, env)
}

/** 删一个账号（按 id） */
export async function removeAccount(provider, id, env = process.env) {
  return editAccounts(provider, (list) => {
    const i = list.findIndex((a) => String(a.id) === String(id))
    if (i < 0) return false
    list.splice(i, 1)
    return true
  }, env)
}
