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
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
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
