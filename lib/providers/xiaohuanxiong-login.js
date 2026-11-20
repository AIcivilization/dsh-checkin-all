// lib/providers/xiaohuanxiong-login.js — 小浣熊的弹出式登录
//
// 小浣熊只有网页登录，没有设备码/回调地址可走。所以这里的做法是：
//   1. 用**独立 user-data-dir** 起一个真的 Chrome 窗口（用户自己输账号密码，
//      插件全程不碰密码）；
//   2. 通过 CDP（Chrome DevTools Protocol）读这个窗口里 xiaohuanxiong.com 的
//      cookie，拿 xhx_token / raccoon_token；
//   3. 拿余额接口验证一次，真的通了才算登录成功，然后关窗口、把凭据写进
//      secrets.json。
//
// 为什么要独立 profile：默认 profile 正在被用户的日常 Chrome 占用，抢不过来；
// 而且我们不希望把用户的浏览数据一起读走。独立 profile 还能留着重用，
// 下次点「登录」时往往已经是登录态，直接就取到 token 了。
//
// CDP 只用两个命令：Network.enable / Network.getAllCookies。Node 22 自带
// 全局 WebSocket，不需要 puppeteer 这种重依赖。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const HOST = 'https://xiaohuanxiong.com'
// 直接开登录页，不要开 /work/home：那边进去是首页，得用户自己找到「登录」再点一下。
// product_code=work 让它登完回办公端（积分就挂在那边），redirect_url 一起带上。
export const LOGIN_PAGE_URL = `${HOST}/login?product_code=work&redirect_url=%2Fwork%2Fhome`
export const LOGIN_URL = LOGIN_PAGE_URL
export const LOGIN_TIMEOUT_MS = 300_000
const POLL_INTERVAL_MS = 1_500
const VERIFY_RETRY_MS = 10_000
const REPORT_INTERVAL_MS = 15_000
const CDP_TIMEOUT_MS = 20_000

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 找到本机的 Chromium 系浏览器（Chrome 优先，其次 Edge / Brave / Chromium） */
export function chromeExecutable(platform = process.platform) {
  if (platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ]
    for (const file of candidates) {
      if (file && existsSync(file)) return file
    }
    return null
  }
  if (platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']]
    const rels = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'Chromium\\Application\\chrome.exe',
    ]
    for (const root of roots) {
      if (!root) continue
      for (const rel of rels) {
        const file = join(root, rel)
        if (existsSync(file)) return file
      }
    }
    return null
  }
  const candidates = [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium',
  ]
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return null
}

/** 让系统挑一个空闲端口（和 Chrome 的 --remote-debugging-port=0 不同，这个能提前拿到号） */
async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** 起一个带调试端口的 Chrome；返回 { child, port } */
export async function launchChrome({ executable, profileDir, url = LOGIN_URL, port = null } = {}) {
  const exe = executable || chromeExecutable()
  if (!exe) {
    throw Object.assign(new Error('本机没找到 Chrome 或 Edge，装一个就能用「登录」按钮'), { code: 'XHX_NO_BROWSER' })
  }
  await mkdir(profileDir, { recursive: true, mode: 0o700 }).catch(() => {})
  // 上一次的窗口没关干净时，新进程会「附着」到旧实例上、调试端口根本不会开。
  // 先按 profile 路径收一遍残留（只匹配我们自己这个目录，不碰用户日常 Chrome）。
  if (process.platform !== 'win32') {
    try {
      spawn('pkill', ['-f', profileDir], { stdio: 'ignore' }).on('error', () => {})
      await new Promise((r) => setTimeout(r, 400))
    } catch { /* 尽力而为 */ }
  }
  const debugPort = port || await freePort()
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--window-size=520,820',
    '--new-window',
    url,
  ]
  const child = spawn(exe, args, { detached: false, stdio: 'ignore' })
  child.on('error', () => {})
  // DSH 被关掉时别把登录窗口留成孤儿（用户下次打开会看到一个没人管的 Chrome）
  const onExit = () => { try { child.kill('SIGTERM') } catch { /* 已退出 */ } }
  process.once('exit', onExit)
  child.once('exit', () => process.removeListener('exit', onExit))
  return { child, port: debugPort, executable: exe }
}

/** 等 CDP 端口起来；超时返回 false（通常是 profile 被另一个 Chrome 占用） */
export async function waitForCdp(port, timeoutMs = CDP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/** 关掉这个 profile 对应的所有 Chrome 进程（主进程 + renderer/helper） */
export async function closeChrome({ child, profileDir } = {}) {
  try { if (child && !child.killed) child.kill('SIGTERM') } catch { /* 已退出 */ }
  // 主进程收到 SIGTERM 后 renderer/helper 可能还挂着，按 profile 路径再收一遍。
  // 模式用纯路径（不以前缀 -- 开头），免得 pkill 把它当成选项。
  try {
    if (profileDir && process.platform !== 'win32') {
      spawn('pkill', ['-f', profileDir], { stdio: 'ignore' }).on('error', () => {})
    }
  } catch { /* 尽力而为 */ }
  await new Promise((r) => setTimeout(r, 600))
}

/** 极简 CDP 客户端：只要 send(method, params) */
export async function connectCdp(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw Object.assign(new Error('浏览器窗口还没准备好，再试一次'), { code: 'XHX_NO_TARGET' })
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    let msg = null
    try { msg = JSON.parse(event.data) } catch { return }
    if (!msg || !msg.id || !pending.has(msg.id)) return
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message || 'CDP 调用失败'))
    else resolve(msg.result)
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接浏览器超时')), 5000)
    ws.onopen = () => { clearTimeout(timer); resolve() }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('连接浏览器失败')) }
  })
  // 窗口被用户关掉时，socket 会静默断开：不发 error、也不回任何响应。
  // 不在这里收尾的话，正在等响应的 send() 会永远挂着，调用方只能等超时。
  let closed = false
  const windowClosed = () => Object.assign(new Error('登录窗口被关掉了'), { code: 'XHX_WINDOW_CLOSED' })
  const failAll = (error) => {
    closed = true
    for (const [, { reject }] of pending) reject(error)
    pending.clear()
  }
  ws.onclose = () => failAll(windowClosed())
  const send = (method, params = {}) => {
    if (closed) return Promise.reject(windowClosed())
    return new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      try { ws.send(JSON.stringify({ id, method, params })) } catch (error) { pending.delete(id); reject(error) }
    })
  }
  return {
    send,
    close: () => { try { ws.close() } catch { /* 已关 */ } },
  }
}

/** 从 CDP 的 getAllCookies 结果里挑出 xiaohuanxiong 域的 cookie，拼成请求头用的串 */
export function cookieHeaderFrom(cookies) {
  const list = (Array.isArray(cookies) ? cookies : [])
    .filter((c) => c && typeof c.name === 'string' && /xiaohuanxiong\.com$/i.test(String(c.domain || '')))
  if (!list.length) return ''
  return list.map((c) => `${c.name}=${c.value}`).join('; ')
}

/** cookie 串里像不像有登录态（xhx_token，或长度正常的 *raccoon_token） */
export function looksLoggedIn(cookieHeader) {
  const text = String(cookieHeader || '')
  if (/(^|;\s*)xhx_token=[^;\s]{20,}/.test(text)) return true
  return /(^|;\s*)[a-z0-9_]*raccoon_token=[^;\s]{20,}/i.test(text)
}

/** 用 cookie 调一次余额接口，确认这个 token 真的能用 */
/** 从 cookie 串里取 xhx_token：小浣熊真正认的是 Bearer，光给 cookie 会 401。 */
function tokenOf(cookieHeader) {
  return (/(?:^|;\s*)xhx_token=([^;\s]+)/.exec(String(cookieHeader || '')) || [])[1] || ''
}

/** 带上 cookie + Bearer 两套头：cookie 是顺手给的，Authorization 才是生效的那条。 */
function authHeaders(cookieHeader) {
  const headers = {
    accept: 'application/json',
    'accept-language': 'zh-CN,zh;q=0.9',
    origin: HOST,
    referer: LOGIN_URL,
    'user-agent': UA,
    cookie: cookieHeader,
  }
  const token = tokenOf(cookieHeader)
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

async function verifyCookie(cookieHeader) {
  try {
    const response = await fetch(`${HOST}/api/web/points/v1/balance`, {
      headers: authHeaders(cookieHeader),
      signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) return null
    const json = await response.json().catch(() => null)
    if (!json || typeof json.code !== 'number' || json.code !== 0) return null
    return json.data || {}
  } catch {
    return null
  }
}

/** 顺手读一下昵称，给账号起个名字 */
async function fetchNickname(cookieHeader) {
  try {
    const response = await fetch(`${HOST}/api/web/auth/v1/user_info`, {
      headers: authHeaders(cookieHeader),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return ''
    const json = await response.json().catch(() => null)
    const data = (json && json.data) || {}
    const candidates = [
      data.nick_name, data.nickname, data.name, data.user_name, data.username,
      data.display_name, data.phone, data.email, data.mobile,
    ]
    for (const value of candidates) {
      const text = String(value || '').trim()
      if (text) return text.slice(0, 24)
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * 轮询窗口里的 cookie，直到拿到一个**验证能用**的登录态。
 * 单独拆出来是为了能脱离浏览器测（client 只要有个 send 就行）。
 */
export async function waitForLogin({
  client,
  timeoutMs = LOGIN_TIMEOUT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  verifyRetryMs = VERIFY_RETRY_MS,
  verify = verifyCookie,
  nickname = fetchNickname,
  onProgress = () => {},
  signal = null,
  now = () => Date.now(),
} = {}) {
  const startedAt = now()
  const deadline = startedAt + timeoutMs
  // 游客状态下浏览器也会发 raccoon_token，但它换不出余额（401），
  // 所以「有 cookie」不等于「登录了」——必须验证通过才算。
  // 验证按时间节流：INGRESSCOOKIE 这类 cookie 会一直轮换，拿「变了就验」
  // 当触发条件等于每 pollIntervalMs 就打一次接口。
  let lastCheckedAt = 0
  let lastReport = startedAt
  while (now() < deadline) {
    if (signal && signal.aborted) {
      throw Object.assign(new Error('登录已取消'), { code: 'XHX_LOGIN_ABORTED' })
    }
    let cookies = []
    try {
      const result = await client.send('Network.getAllCookies')
      cookies = (result && result.cookies) || []
    } catch {
      throw Object.assign(new Error('登录窗口被关掉了'), { code: 'XHX_WINDOW_CLOSED' })
    }
    const header = cookieHeaderFrom(cookies)
    if (header && looksLoggedIn(header) && now() - lastCheckedAt > verifyRetryMs) {
      lastCheckedAt = now()
      onProgress({ phase: 'verifying' })
      const balance = await verify(header)
      if (balance) {
        const name = await nickname(header)
        onProgress({ phase: 'done' })
        return {
          cookie: header,
          token: (/(?:^|;\s*)xhx_token=([^;\s]+)/.exec(header) || [])[1] || '',
          name,
          points: Number(balance.available_points || 0),
        }
      }
    }
    if (now() - lastReport > REPORT_INTERVAL_MS) {
      lastReport = now()
      onProgress({ phase: 'waiting', elapsedMs: now() - startedAt })
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
  throw Object.assign(new Error('等登录超时了，再点一次「登录」'), { code: 'XHX_LOGIN_TIMEOUT' })
}

/**
 * 打开窗口 → 等用户登录 → 取 token。
 * 返回 { cookie, token, name, points }，失败抛带 code 的错。
 */
export async function runBrowserLogin({
  profileDir,
  timeoutMs = LOGIN_TIMEOUT_MS,
  executable = null,
  url = LOGIN_URL,
  onProgress = () => {},
  onConnected = null,
  verify = verifyCookie,
  nickname = fetchNickname,
  signal = null,
} = {}) {
  if (!profileDir) throw new Error('缺少 profileDir')
  const { child, port } = await launchChrome({ executable, profileDir, url })
  let client = null
  try {
    const up = await waitForCdp(port)
    if (!up) {
      throw Object.assign(
        new Error('浏览器没能启动调试端口（可能这个登录窗口已经开着）。把多开的 Chrome 窗口关掉再点「登录」'),
        { code: 'XHX_CDP_UNREACHABLE' },
      )
    }
    client = await connectCdp(port)
    await client.send('Network.enable')
    if (onConnected) await onConnected(client)
    onProgress({ phase: 'waiting' })

    return await waitForLogin({ client, timeoutMs, verify, nickname, onProgress, signal })
  } finally {
    if (client) client.close()
    await closeChrome({ child, profileDir })
  }
}

/** 删掉登录用的 profile（换账号时用得到） */
export async function resetLoginProfile(profileDir) {
  if (!profileDir) return
  try { await rm(profileDir, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
}
