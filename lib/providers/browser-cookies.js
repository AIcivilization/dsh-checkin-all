// lib/providers/browser-cookies.js — 从本机已登录的豆包电脑版 / 浏览器里读 doubao.com 的登录 Cookie
//
// 豆包电脑版（DoubaoWork）和 Chrome、Edge、Brave 都是 Chromium，Cookie 存在
// <用户数据>/<配置>/Cookies（新版在 Network/Cookies）这个 SQLite 里，值是加密的：
//   macOS：v10 + AES-128-CBC，密钥 = PBKDF2(钥匙串里「<应用> Safe Storage」的密码, 'saltysalt', 1003, sha1)。
//          读钥匙串时 macOS 会弹窗问用户是否允许，用户点允许才读得到。
//   Windows：v10 + AES-256-GCM，密钥在 Local State 的 os_crypt.encrypted_key 里，用当前用户的 DPAPI 解开。
//            新版 Chrome 的 v20（应用绑定加密）读不了，跳过。
//   Linux：不读（VPS 上也没有这些应用）。
// Cookie 库版本 ≥ 24 时，解开的值前面多 32 字节（host 的 sha256），要去掉。
// 只读 doubao.com 的 Cookie，只在用户点「从本机找」时读；先只看有没有登录（不碰密钥），有才去解密。

import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runExec = promisify(execFile)

const HOSTS = ['doubao.com', '.doubao.com', 'www.doubao.com']
const SESSION_COOKIE = 'sessionid'

export class CookieAccessDenied extends Error {
  constructor() { super('没有允许读取钥匙串') }
}

export function cookieStores(home = homedir(), platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    const s = join(home, 'Library', 'Application Support')
    return [
      { label: '豆包电脑版', root: join(s, 'DoubaoWork'), services: ['DoubaoWork Browser Safe Storage', 'DoubaoWork Safe Storage'] },
      { label: '豆包', root: join(s, 'Doubao'), services: ['Doubao Browser Safe Storage', 'Doubao Safe Storage'] },
      { label: 'Chrome', root: join(s, 'Google', 'Chrome'), services: ['Chrome Safe Storage'] },
      { label: 'Edge', root: join(s, 'Microsoft Edge'), services: ['Microsoft Edge Safe Storage'] },
      { label: 'Brave', root: join(s, 'BraveSoftware', 'Brave-Browser'), services: ['Brave Safe Storage'] },
    ]
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const roaming = env.APPDATA || join(home, 'AppData', 'Roaming')
    return [
      { label: '豆包电脑版', root: join(local, 'DoubaoWork', 'User Data'), services: [] },
      { label: '豆包电脑版', root: join(roaming, 'DoubaoWork'), services: [] },
      { label: '豆包', root: join(local, 'Doubao', 'User Data'), services: [] },
      { label: 'Chrome', root: join(local, 'Google', 'Chrome', 'User Data'), services: [] },
      { label: 'Edge', root: join(local, 'Microsoft', 'Edge', 'User Data'), services: [] },
      { label: 'Brave', root: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'), services: [] },
    ]
  }
  return []
}

const exists = async (p) => stat(p).then(() => true, () => false)

async function cookieDbs(store) {
  let names
  try { names = await readdir(store.root) } catch { return [] }
  const out = []
  for (const profile of names.filter((n) => n === 'Default' || /^Profile \d+$/.test(n)).sort()) {
    for (const rel of [['Network', 'Cookies'], ['Cookies']]) {
      const file = join(store.root, profile, ...rel)
      if (await exists(file)) { out.push({ store, profile, file }); break }
    }
  }
  return out
}

const chromeTimeToMs = (t) => (t ? t - 11_644_473_600_000 : 0)

export async function readCookieDb(file) {
  const dir = await mkdtemp(join(tmpdir(), 'dshck-'))
  try {
    const copy = join(dir, 'Cookies')
    await copyFile(file, copy)
    for (const ext of ['-journal', '-wal']) await copyFile(file + ext, copy + ext).catch(() => {})
    return await querySqlite(copy)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const SQL_ROWS = `select host_key, name, value, hex(encrypted_value) as ev, expires_utc / 1000 as expires_utc from cookies where host_key in (${HOSTS.map((h) => `'${h}'`).join(',')})`
const SQL_VERSION = `select value from meta where key = 'version'`

async function querySqlite(file) {
  let raw
  let version
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      raw = db.prepare(SQL_ROWS).all()
      version = Number(db.prepare(SQL_VERSION).get()?.value) || 0
    } finally {
      db.close()
    }
  } catch (error) {
    if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && !/node:sqlite/.test(String(error))) throw error
    // 退回系统 sqlite3
    const a = await runExec('sqlite3', ['-readonly', '-json', file, SQL_ROWS], { timeout: 20_000 }).catch((e) => ({ stdout: '', stderr: String(e), code: 1 }))
    const b = await runExec('sqlite3', ['-readonly', file, SQL_VERSION], { timeout: 20_000 }).catch((e) => ({ stdout: '', stderr: String(e), code: 1 }))
    if (a.code !== 0) throw new Error(`读 Cookie 库失败：${a.stderr.trim()}`)
    raw = a.stdout.trim() ? JSON.parse(a.stdout) : []
    version = Number(b.stdout.trim()) || 0
  }
  return {
    rows: raw.map((r) => ({ host_key: r.host_key, name: r.name, value: r.value ?? '', encrypted_value: Buffer.from(r.ev ?? '', 'hex'), expires_utc: Number(r.expires_utc) || 0 })),
    version,
  }
}

const alive = (r, now) => {
  const ms = chromeTimeToMs(r.expires_utc)
  return !ms || ms > now
}

/** 只看哪些地方登录着豆包（不解密、不碰钥匙串，不会弹窗） */
export async function findDoubaoLogins(home = homedir(), platform = process.platform, now = Date.now()) {
  const out = []
  for (const store of cookieStores(home, platform)) {
    const dbs = await cookieDbs(store)
    for (const db of dbs) {
      const { rows } = await readCookieDb(db.file).catch(() => ({ rows: [] }))
      if (rows.some((r) => r.name === SESSION_COOKIE && alive(r, now))) {
        out.push({ label: dbs.length > 1 && db.profile !== 'Default' ? `${store.label}（${db.profile}）` : store.label, db })
      }
    }
  }
  return out
}

async function macKey(services) {
  let last = ''
  for (const s of services) {
    const r = await runExec('/usr/bin/security', ['find-generic-password', '-w', '-s', s], { timeout: 120_000 }).catch((e) => ({ code: 1, stdout: '', stderr: String(e) }))
    if (r.code === 0 && r.stdout.trim()) return pbkdf2Sync(r.stdout.trim(), 'saltysalt', 1003, 16, 'sha1')
    last = r.stderr.trim()
    if (/cancel|denied|拒绝|取消/i.test(last) || r.code === 128) throw new CookieAccessDenied()
  }
  throw new Error(`钥匙串里没找到它的 Cookie 密钥${last ? `（${last}）` : ''}`)
}

async function winKey(root) {
  const state = JSON.parse(await readFile(join(root, 'Local State'), 'utf8'))
  const enc = Buffer.from(state.os_crypt?.encrypted_key ?? '', 'base64')
  if (enc.subarray(0, 5).toString() !== 'DPAPI') throw new Error('Local State 里没有能用的 Cookie 密钥')
  const script = "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:DSHM_BLOB); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))"
  const r = await runExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, DSHM_BLOB: enc.subarray(5).toString('base64') }, timeout: 30_000 }).catch((e) => ({ code: 1, stdout: '', stderr: String(e) }))
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(`解不开 Cookie 密钥：${r.stderr.trim() || `退出码 ${r.code}`}`)
  return Buffer.from(r.stdout.trim(), 'base64')
}

/** 解开一个 Cookie 值。读不了（如 v20）返回 null */
export function decryptCookie(enc, key, platform, dbVersion) {
  const tag = enc.subarray(0, 3).toString()
  if (tag !== 'v10' && tag !== 'v11') return null
  let plain
  if (platform === 'win32') {
    const nonce = enc.subarray(3, 15)
    const body = enc.subarray(15, enc.length - 16)
    const d = createDecipheriv('aes-256-gcm', key, nonce)
    d.setAuthTag(enc.subarray(enc.length - 16))
    plain = Buffer.concat([d.update(body), d.final()])
  } else {
    const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
    plain = Buffer.concat([d.update(enc.subarray(3)), d.final()])
  }
  return (dbVersion >= 24 ? plain.subarray(32) : plain).toString('utf8')
}

/** 读出一处登录的完整 Cookie 串（a=1; b=2）。macOS 会弹钥匙串授权 */
export async function readDoubaoCookie(login, platform = process.platform, now = Date.now(), testKey) {
  const { rows, version } = await readCookieDb(login.db.file)
  const key = testKey ?? (platform === 'darwin' ? await macKey(login.db.store.services) : await winKey(login.db.store.root))
  const byName = new Map()
  let unreadable = 0
  for (const r of rows.filter((x) => alive(x, now))) {
    let value = r.value
    if (!value && r.encrypted_value.length) {
      try { value = decryptCookie(r.encrypted_value, key, platform, version) } catch { value = null }
    }
    if (value === null) { unreadable++; continue }
    const prev = byName.get(r.name)
    if (!prev || r.host_key.length > prev.host.length) byName.set(r.name, { host: r.host_key, value })
  }
  if (!byName.get(SESSION_COOKIE)?.value) {
    throw new Error(unreadable ? `${login.label} 用的是新的加密方式，读不了：请用「手动粘贴 Cookie」` : `${login.label} 里的豆包登录不完整`)
  }
  return [...byName].map(([n, v]) => `${n}=${v.value}`).join('; ')
}
