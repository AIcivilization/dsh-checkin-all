// lib/providers/buddy-login.js — CodeBuddy / WorkBuddy 浏览器登录
//
// 不用手抠 access_token：点一下 → 打开浏览器授权 → 插件轮询拿 token → 写入凭据。
// 流程照 dsh-free-model 的 src/buddy-auth.ts（MIT）：
//
//   1. POST {endpoint}/v2/plugin/auth/state?platform=ide
//        → { state, authUrl }
//   2. 打开 authUrl（浏览器里登录腾讯账号并同意）
//   3. GET  {endpoint}/v2/plugin/auth/token?state=<state>     轮询，未就绪返回 code 11217
//   4. GET  {endpoint}/v2/plugin/login/account?state=<state>  拿账号信息，未就绪返回 code 12151
//   5. 拼成 { access_token, user_id, enterprise_id, ... } 存起来
//
// 注意这几步用的头和不带 token 的正常请求不同：要显式声明「没有授权/没有用户信息」，
// 否则服务端会按缺头处理。

import { randomUUID } from 'node:crypto'
import { openBrowser } from './codearts-login.js'

const STATE_PATH = '/v2/plugin/auth/state'
const TOKEN_PATH = '/v2/plugin/auth/token'
const ACCOUNT_PATH = '/v2/plugin/login/account'

/** 登录还在等你在浏览器点确认 */
const CODE_TOKEN_NOT_READY = 11217
/** 账号信息还没就绪 */
const CODE_ACCOUNT_NOT_READY = 12151

const REQUEST_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 2000
const LOGIN_TIMEOUT_MS = 300_000

export class BuddyLoginError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** 不带授权的请求头（登录阶段用） */
function anonHeaders(product, extra = {}) {
  return {
    'X-Domain': product.apiDomain,
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    'User-Agent': product.userAgent,
    ...extra,
  }
}

// 注意：这里**不能** unref()。登录时如果进程里没有别的活跃句柄，
// unref 的定时器会让 Node 直接退出，用户就永远等不到结果。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pickField(src, ...keys) {
  for (const k of keys) {
    if (src && src[k] !== undefined && src[k] !== null && src[k] !== '') return src[k]
  }
  return ''
}

async function callJson(url, { method = 'GET', headers, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let response
  try {
    response = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    return { ok: false, networkError: error.message }
  }
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { ok: response.ok, status: response.status, json, text }
}

/** 拿 state + 授权地址 */
export async function fetchAuthState(product, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const url = `${product.endpoint}${STATE_PATH}?platform=${encodeURIComponent(product.platform || 'ide')}`
  const r = await callJson(url, { method: 'POST', headers: anonHeaders(product), timeoutMs })
  if (r.networkError) {
    throw new BuddyLoginError('BUDDY_LOGIN_NETWORK', `连不上 ${product.apiDomain}：${r.networkError}`)
  }
  if (!r.ok || !r.json) {
    const msg = r.json ? (r.json.msg || r.json.message || '') : (r.text || '').slice(0, 100)
    throw new BuddyLoginError('BUDDY_LOGIN_STATE', `申请登录状态失败（HTTP ${r.status}）${msg ? `：${msg}` : ''}`)
  }
  const data = (r.json.data && typeof r.json.data === 'object') ? r.json.data : r.json
  const state = String(pickField(data, 'state') || '')
  const authUrl = String(pickField(data, 'authUrl', 'auth_url') || '')
  if (!state) throw new BuddyLoginError('BUDDY_LOGIN_STATE', '服务端没返回 state，登录流程无法继续')
  if (!authUrl) throw new BuddyLoginError('BUDDY_LOGIN_STATE', '服务端没返回授权地址')
  return { state, authUrl }
}

/** 轮询拿 token（未确认时服务端返回 11217） */
export async function pollToken(product, state, { timeoutMs = LOGIN_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS, signal } = {}) {
  const url = `${product.endpoint}${TOKEN_PATH}?state=${encodeURIComponent(state)}`
  const headers = { 'X-No-Authorization': 'true', 'User-Agent': product.userAgent }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal && signal.aborted) throw new BuddyLoginError('BUDDY_LOGIN_ABORTED', '登录已取消')
    if (Date.now() >= deadline) {
      throw new BuddyLoginError('BUDDY_LOGIN_TIMEOUT', `等授权超时（${Math.round(timeoutMs / 1000)} 秒），再试一次`)
    }
    await sleep(intervalMs)
    const r = await callJson(url, { headers, signal })
    if (r.networkError) continue
    if (r.ok && r.json) {
      const data = (r.json.data && typeof r.json.data === 'object') ? r.json.data : r.json
      const token = String(pickField(data, 'accessToken', 'access_token') || '')
      if (token) {
        return {
          accessToken: token,
          refreshToken: String(pickField(data, 'refreshToken', 'refresh_token') || ''),
          domain: String(pickField(data, 'domain') || ''),
          expiresAt: pickField(data, 'expiresAt', 'expires_at') || '',
        }
      }
      continue
    }
    const code = Number(r.json && (r.json.code ?? r.json.errorCode))
    if (code === CODE_TOKEN_NOT_READY) continue
    const msg = r.json ? (r.json.msg || r.json.message || '') : ''
    throw new BuddyLoginError('BUDDY_LOGIN_TOKEN', `取 token 失败（HTTP ${r.status}${code ? ` code ${code}` : ''}）${msg ? `：${msg}` : ''}`)
  }
}

/** 拿账号信息（未就绪返回 12151） */
export async function fetchAccount(product, state, token, { timeoutMs = 60_000, intervalMs = POLL_INTERVAL_MS } = {}) {
  const url = `${product.endpoint}${ACCOUNT_PATH}?state=${encodeURIComponent(state)}`
  const headers = {
    // token.domain 为空时回退到产品域名（服务端下发非空则以它为准）
    'X-Domain': token.domain || product.apiDomain,
    Authorization: `Bearer ${token.accessToken}`,
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'User-Agent': product.userAgent,
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (Date.now() >= deadline) return {}
    await sleep(intervalMs)
    const r = await callJson(url, { headers })
    if (r.networkError) continue
    if (r.ok && r.json) {
      const data = (r.json.data && typeof r.json.data === 'object') ? r.json.data : r.json
      return {
        userId: String(pickField(data, 'userId', 'user_id', 'uid') || ''),
        enterpriseId: String(pickField(data, 'enterpriseId', 'enterprise_id', 'tenantId') || ''),
        nickname: String(pickField(data, 'nickname', 'name', 'userName') || ''),
      }
    }
    const code = Number(r.json && (r.json.code ?? r.json.errorCode))
    if (code === CODE_ACCOUNT_NOT_READY) continue
    // 账号信息拿不到不算致命：token 已经在手，签到只要 access_token
    return {}
  }
}

/** 授权地址补两个参数（版本 + 会话号），和官方客户端一致 */
export function decorateLoginUrl(authUrl, product) {
  if (!product.appendSessionParams) return authUrl
  try {
    const url = new URL(authUrl)
    if (product.pluginVersion) url.searchParams.set('version', product.pluginVersion)
    url.searchParams.set('loginSessionId', randomUUID())
    return url.toString()
  } catch {
    return authUrl
  }
}

/**
 * 跑一次完整登录。返回可直接存进 secrets.json 的账号对象。
 */
export async function runBuddyLogin(product, { timeoutMs = LOGIN_TIMEOUT_MS, opener = openBrowser } = {}) {
  const { state, authUrl } = await fetchAuthState(product)
  const decorated = decorateLoginUrl(authUrl, product)
  const opened = opener(decorated)
  const token = await pollToken(product, state, { timeoutMs })
  const account = await fetchAccount(product, state, token).catch(() => ({}))
  return {
    entry: {
      access_token: token.accessToken,
      ...(account.userId ? { user_id: account.userId } : {}),
      ...(account.enterpriseId ? { enterprise_id: account.enterpriseId } : {}),
      ...(account.nickname ? { name: account.nickname } : {}),
    },
    authUrl: decorated,
    opened,
    state,
  }
}
