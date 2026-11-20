// lib/providers/teleagent-login.js — 天翼 AI（TeleAgent）的弹出式登录
//
// TeleAgent 的 web 端只认 cookie `operationToken`（或 localStorage 里的
// user_token / sso_token / console_token），没有设备码可走。所以做法和小浣熊一样：
//   1. 用**独立 user-data-dir** 起一个真的 Chrome 窗口，开登录页，用户自己输账号密码
//      （插件全程不碰密码）；
//   2. 通过 CDP 读这个窗口里 teleai.com.cn 的 cookie（外加 localStorage 兜底）；
//   3. 拿 userCenter 接口验证一次，真通了才算登录成功，然后关窗口、把 token 写进
//      secrets.json。
//
// 为什么要独立 profile：默认 profile 正被日常 Chrome 占用，抢不过来；也不该把
// 用户的浏览数据一起读走。独立 profile 还能留着重用，下次点「登录」往往已经是
// 登录态，直接就能取到 token。
//
// CDP 只用三个命令：Network.enable / Network.getAllCookies / Runtime.evaluate。
// Node 22 自带全局 WebSocket，不需要 puppeteer 这种重依赖。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const ORIGIN = 'https://agent.teleai.com.cn'
/** 桌面端/网页端共用的业务前缀（jump_url 里出现的那个） */
export const API_PREFIX = '/superCowork/sapi'
/** 登录页。redirect_url 要双重编码，这是前端自己拼的写法 */
export const LOGIN_PAGE_URL = `${ORIGIN}/meter/teleagent-login/login?redirect_url=${encodeURIComponent(
  encodeURIComponent(`${ORIGIN}/teleagent`),
)}`
export const LOGIN_URL = LOGIN_PAGE_URL
export const LOGIN_TIMEOUT_MS = 300_000
const POLL_INTERVAL_MS = 1_500
const VERIFY_RETRY_MS = 10_000
const REPORT_INTERVAL_MS = 15_000
const CDP_TIMEOUT_MS = 20_000

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 前端里 localStorage 可能存 token 的三个键（顺序即优先级） */
export const TOKEN_STORAGE_KEYS = ['user_token', 'sso_token', 'console_token']

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
    throw Object.assign(new Error('本机没找到 Chrome 或 Edge，装一个就能用「登录」按钮'), { code: 'TA_NO_BROWSER' })
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
  // DSH 被关掉时别把登录窗口留成孤儿
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
  if (!page) throw Object.assign(new Error('浏览器窗口还没准备好，再试一次'), { code: 'TA_NO_TARGET' })
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
  // 窗口被用户关掉时 socket 会静默断开：不发 error、也不回响应。
  // 不在这里收尾，正在等响应的 send() 会永远挂着。
  let closed = false
  const windowClosed = () => Object.assign(new Error('登录窗口被关掉了'), { code: 'TA_WINDOW_CLOSED' })
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

/** 从 CDP 的 getAllCookies 结果里挑出 teleai 域的 cookie，拼成请求头用的串 */
export function cookieHeaderFrom(cookies) {
  // 注意要认**所有子域**：登录表单在 www.teleai.com.cn 的 iframe 里，
  // 有些 cookie 是挂在那个 host 上的（host-only cookie 的 domain 就是 www.…）。
  const list = (Array.isArray(cookies) ? cookies : [])
    .filter((c) => c && typeof c.name === 'string' && /teleai\.com\.cn$/i.test(String(c.domain || '')))
  if (!list.length) return ''
  return list.map((c) => `${c.name}=${c.value}`).join('; ')
}

/** 从 cookie 串里取某个键的值 */
export function cookieValueOf(cookieHeader, name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;\\s]+)`).exec(String(cookieHeader || ''))
  return match ? match[1] : ''
}

/** cookie 串里像不像有登录态（operationToken 或 operToken / X-Token） */
export function looksLoggedIn(cookieHeader) {
  const text = String(cookieHeader || '')
  for (const name of ['operationToken', 'operToken', 'X-Token', 'user_token']) {
    if (new RegExp(`(?:^|;\\s*)${name}=[^;\\s]{20,}`).test(text)) return true
  }
  return false
}

/** 真正发给服务端的是 `X-Token`：cookie operationToken 优先，其次 localStorage 的几个键 */
export function tokenFromSnapshot({ cookies = [], storage = {} } = {}) {
  const header = Array.isArray(cookies) ? cookieHeaderFrom(cookies) : String(cookies || '')
  for (const name of ['operationToken', 'operToken', 'X-Token', 'user_token']) {
    const value = cookieValueOf(header, name)
    if (value && value.length >= 20) return value
  }
  const bag = storage && typeof storage === 'object' ? storage : {}
  for (const key of TOKEN_STORAGE_KEYS) {
    const value = String(bag[key] || '').trim()
    if (value.length >= 20) return value
  }
  return ''
}

/** 统一请求头：桌面端那套 X-* 头 + X-Token */
export function authHeaders(token, { extra = {} } = {}) {
  const headers = {
    accept: 'application/json',
    'accept-language': 'zh-CN,zh;q=0.9',
    origin: ORIGIN,
    referer: `${ORIGIN}/teleagent`,
    'user-agent': UA,
    'x-app-version': '1.0.0',
    'x-os-type': 'web',
    'x-channel-id': 'web',
    'x-runtime-env': 'prod',
    'x-timestamp': String(Math.floor(Date.now() / 1000)),
    'x-nonce': `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`,
    ...extra,
  }
  if (token) headers['x-token'] = token
  return headers
}

/** 两个接口前缀都试（web 门户 / 桌面端），任一通了就算登录态有效 */
const VERIFY_PATHS = [
  `${ORIGIN}/meter/super-agent/user/portal/companyStore/userCenter`,
  `${ORIGIN}${API_PREFIX}/user/portal/companyStore/userCenter`,
]

/** 用 token 调一次 userCenter，确认这个 token 真的能用 */
async function verifyToken(token) {
  if (!token) return null
  for (const url of VERIFY_PATHS) {
    try {
      const response = await fetch(url, { headers: authHeaders(token), signal: AbortSignal.timeout(12_000) })
      if (!response.ok) continue
      const json = await response.json().catch(() => null)
      if (!json) continue
      const ok = json.code === 0 || json.code === 200 || json.success === true
      if (!ok) continue
      return json.data || {}
    } catch { /* 换下一个前缀 */ }
  }
  return null
}

/** 顺手读一下昵称，给账号起个名字 */
function nicknameOf(userCenter) {
  const data = userCenter || {}
  const candidates = [
    data.nick_name, data.nickname, data.user_name, data.username, data.name,
    data.display_name, data.phone, data.mobile, data.email,
  ]
  for (const value of candidates) {
    const text = String(value || '').trim()
    if (text) return text.slice(0, 24)
  }
  return ''
}

/** 从窗口里读 localStorage 的三个 token 键 */
async function readStorage(client) {
  const expression = `(() => {
    const out = {};
    for (const k of ${JSON.stringify(TOKEN_STORAGE_KEYS)}) {
      try { const v = localStorage.getItem(k); if (v) out[k] = v; } catch (e) {}
    }
    return JSON.stringify(out);
  })()`
  try {
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true })
    const raw = result && result.result && result.result.value
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 轮询窗口里的 cookie / localStorage，直到拿到一个**验证能用**的 token。
 * 单独拆出来是为了能脱离浏览器测（client 只要有个 send 就行）。
 */
export async function waitForLogin({
  client,
  timeoutMs = LOGIN_TIMEOUT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  verifyRetryMs = VERIFY_RETRY_MS,
  verify = verifyToken,
  onProgress = () => {},
  signal = null,
  now = () => Date.now(),
} = {}) {
  const startedAt = now()
  const deadline = startedAt + timeoutMs
  // 未登录时浏览器也会有一堆 teleai cookie，但换不出 userCenter（401），
  // 所以「有 cookie」不等于「登录了」——必须验证通过才算。
  // 验证按时间节流：不少 cookie 会一直轮换，拿「变了就验」当触发条件等于每轮都打接口。
  let lastCheckedAt = 0
  let lastReport = startedAt
  while (now() < deadline) {
    if (signal && signal.aborted) {
      throw Object.assign(new Error('登录已取消'), { code: 'TA_LOGIN_ABORTED' })
    }
    let cookies = []
    try {
      const result = await client.send('Network.getAllCookies')
      cookies = (result && result.cookies) || []
    } catch {
      throw Object.assign(new Error('登录窗口被关掉了'), { code: 'TA_WINDOW_CLOSED' })
    }
    const header = cookieHeaderFrom(cookies)
    const storage = header && looksLoggedIn(header) ? {} : await readStorage(client)
    const token = tokenFromSnapshot({ cookies, storage })
    if (token && now() - lastCheckedAt > verifyRetryMs) {
      lastCheckedAt = now()
      onProgress({ phase: 'verifying' })
      const userCenter = await verify(token)
      if (userCenter) {
        const name = nicknameOf(userCenter)
        onProgress({ phase: 'done' })
        return {
          cookie: header,
          token,
          name,
          points: Number((userCenter && userCenter.current_points_balance) || 0),
        }
      }
    }
    if (now() - lastReport > REPORT_INTERVAL_MS) {
      lastReport = now()
      onProgress({ phase: 'waiting', elapsedMs: now() - startedAt })
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
  throw Object.assign(new Error('等登录超时了，再点一次「登录」'), { code: 'TA_LOGIN_TIMEOUT' })
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
  verify = verifyToken,
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
        { code: 'TA_CDP_UNREACHABLE' },
      )
    }
    client = await connectCdp(port)
    await client.send('Network.enable')
    if (onConnected) await onConnected(client)
    onProgress({ phase: 'waiting' })

    return await waitForLogin({ client, timeoutMs, verify, onProgress, signal })
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
