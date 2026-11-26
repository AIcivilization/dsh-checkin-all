// lib/providers/officeace.js — OfficeAce（华为云 AgentArts 的办公助手）每日领积分（实验）
//
// 移植自 dsh-model 的 src/checkin/officeace.ts（同作者，MIT）。协议原自 Jet 的渠道包
// （iJetLi/dsh-providers-hub，MIT）里的 officeace-auth.ts，只搬「登录 + 续期 + 领每日奖励」：
//   登录：华为云账号在浏览器里正常登录（OAuth 授权码 + PKCE + DPoP），回调落在华为云的 AgentArts 服务上，
//         我们按 state 轮询取回授权码，再向 STS 换一组临时访问密钥（AK/SK + security token，约一天）和 refresh token。
//   续期：refresh token 只能用一次，换完要马上存新的——所以这份登录不能复制到别的机器（两边会互相顶掉）。
//   领取：POST /v1/subscription/bonus/claim，用华为云 APIG 的标准签名（V11-HMAC-SHA256）。
//
// 多账号：secrets.json 的 manual.officeace.accounts[]，每个 { id, name?, savedAt, cred }。
// 同一个华为云项目（projectId）再登录 = 换成新的登录，不会多出一个账号。
// 续期写回只改那一个账号（patchAccount，整段加锁），别的账号、同时在面板里加的账号都不受影响。

import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto'
import { addAccount, listAccounts, patchAccount } from '../checkin-secrets.js'
import { CHECKIN_TZ, beijingDayKey } from '../tz.js'
import { OUTCOME, isReadOnly, mergeAccountResults } from './base.js'

const CLAW_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com'
const TOKEN_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens'
const OFFICEACE_BASE = 'https://officeace.cn-southwest-2.huaweicloud-agentarts.com'
const CLIENT_ID = 'pdp5_for_agentarts'
const REDIRECT_URI = `${CLAW_BASE}/v1/claw/auth/callback`
const TIMEOUT_MS = 30_000
const LOGIN_TIMEOUT_MS = 300_000

export class OfficeAceAuthError extends Error {}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

async function dpopJwt(jwk, htm, htu, nowMs = Date.now()) {
  const key = await webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: jwk.kty, x: jwk.x, y: jwk.y, crv: jwk.crv } }
  const payload = { htm, htu, iat: Math.floor(nowMs / 1000), jti: randomBytes(16).toString('hex') }
  const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(input))
  return `${input}.${b64url(new Uint8Array(sig))}`
}

/** 开始登录：向 AgentArts 要一个 state，拼出华为云的授权页地址 */
export async function startOfficeAceLogin() {
  const r = await fetch(`${CLAW_BASE}/v1/claw/auth/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15_000) })
  if (!r.ok) throw new Error(`华为云没有返回登录状态（HTTP ${r.status}）`)
  const state = (await r.json()).state
  if (typeof state !== 'string' || !state) throw new Error('华为云没有返回登录状态')
  const codeVerifier = b64url(randomBytes(32))
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const dpopPrivateJwk = await webcrypto.subtle.exportKey('jwk', kp.privateKey)
  const params = new URLSearchParams({ client_id: CLIENT_ID, code_challenge: codeChallenge, code_challenge_method: 'SHA-256', state, scope: 'openid', redirect_uri: REDIRECT_URI, response_type: 'code' })
  const url = `https://auth.huaweicloud.com/authui/login.html?service=${encodeURIComponent(`https://auth.huaweicloud.com/authui/v1/oauth2/authorize?${params}`)}`
  return { url, state, codeVerifier, dpopPrivateJwk }
}

/** 用户在浏览器里登录完后，按 state 取回授权码；还没好返回 undefined */
export async function pollOfficeAceCode(state) {
  const r = await fetch(`${CLAW_BASE}/v1/claw/auth/code?state=${encodeURIComponent(state)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }).catch(() => null)
  if (!r || !r.ok) return undefined
  const j = await r.json().catch(() => ({}))
  const code = j.code ?? j.data?.code
  return typeof code === 'string' && code ? code : undefined
}

async function stsToken(body, jwk) {
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: await dpopJwt(jwk, 'POST', TOKEN_URL) }, body: body.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await r.text()
  if (!r.ok) {
    // refresh token 只能用一次：用过 / 过期都回 4xx，只能重新登录
    if (r.status >= 400 && r.status < 500) throw new OfficeAceAuthError(`华为云登录已失效（HTTP ${r.status}）`)
    throw new Error(`华为云换取临时密钥失败（HTTP ${r.status}）：${text.slice(0, 200)}`)
  }
  return JSON.parse(text)
}

function toCredential(t, prev) {
  const c = t.credentials ?? {}
  if (!c.access_key_id || !c.secret_access_key || !c.security_token) throw new Error('华为云返回的临时密钥不完整')
  return {
    access: c.access_key_id,
    secret: c.secret_access_key,
    securityToken: c.security_token,
    projectId: c.project_id ?? prev.projectId ?? '',
    expiresAt: c.expiration ?? new Date(Date.now() + 3600_000).toISOString(),
    refreshToken: t.refresh_token ?? prev.refreshToken ?? '',
    dpopPrivateJwk: prev.dpopPrivateJwk,
  }
}

/** 授权码换临时密钥 */
export async function exchangeOfficeAceCode(code, codeVerifier, dpopPrivateJwk) {
  const t = await stsToken(new URLSearchParams({ client_id: CLIENT_ID, code, code_verifier: codeVerifier, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI }), dpopPrivateJwk)
  return toCredential(t, { dpopPrivateJwk })
}

/** 临时密钥快到期（默认 10 分钟内）了吗 */
export const officeAceExpiring = (c, leadMs = 10 * 60_000, now = Date.now()) => {
  const exp = Date.parse(c && c.expiresAt)
  return !Number.isFinite(exp) || exp - now < leadMs
}

/** 续期。refresh token 只能用一次：调用方要马上把返回的新凭据存起来 */
export async function refreshOfficeAce(c) {
  if (!c.refreshToken) throw new OfficeAceAuthError('没有可用的续期令牌')
  const t = await stsToken(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: CLIENT_ID }), c.dpopPrivateJwk)
  return toCredential(t, c)
}

/** 华为云 APIG 签名（V11-HMAC-SHA256）。导出给测试 */
export function signApic(method, url, c, body, now = new Date()) {
  const region = 'cn-southwest-2'
  const service = 'apic'
  const pad = (n) => String(n).padStart(2, '0')
  const xdate = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
  const u = new URL(url)
  const path = u.pathname.split('/').map((s) => enc(decodeURIComponent(s))).join('/')
  const canonicalUri = path.endsWith('/') ? path : `${path}/`
  const query = [...u.searchParams].sort(([a, b], [x, y]) => (a === x ? b.localeCompare(y) : a.localeCompare(x))).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&')
  const headers = { 'x-subscription-type': 'v2', 'X-Sdk-Date': xdate, 'X-Security-Token': c.securityToken.trim(), Host: u.host }
  if (method === 'POST') headers['Content-Type'] = 'application/json;charset=utf8'
  if (c.projectId) headers['X-Project-ID'] = c.projectId
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ')
  const signed = Object.keys(lower).sort()
  const canonicalHeaders = signed.map((h) => `${h}:${lower[h]}\n`).join('')
  const payloadHash = createHash('sha256').update(body ?? '', 'utf8').digest('hex')
  const canonical = [method, canonicalUri, query, canonicalHeaders, signed.join(';'), payloadHash].join('\n')
  const scope = `${xdate.slice(0, 8)}/${region}/${service}`
  const toSign = ['V11-HMAC-SHA256', xdate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n')
  const k1 = createHmac('sha256', c.access).update(c.secret).digest()
  const derived = createHmac('sha256', k1).update(Buffer.concat([Buffer.from(scope, 'utf8'), Buffer.from([1])])).digest().subarray(0, 32).toString('hex')
  const signature = createHmac('sha256', Buffer.from(derived, 'utf8')).update(toSign).digest('hex')
  const { Host: _host, ...send } = headers
  return { ...send, Authorization: `V11-HMAC-SHA256 Credential=${c.access}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}` }
}

/** 领今天的奖励。返回领到的积分（领过了是 0）。登录失效抛 OfficeAceAuthError */
export async function officeAceClaim(c) {
  const url = `${OFFICEACE_BASE}/v1/subscription/bonus/claim`
  const r = await fetch(url, { method: 'POST', headers: signApic('POST', url, c, undefined), signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await r.text()
  if (r.status === 401 || r.status === 403) throw new OfficeAceAuthError(`OfficeAce 登录已失效（HTTP ${r.status}）`)
  if (!r.ok) throw new Error(`OfficeAce 领取失败（HTTP ${r.status}）：${text.slice(0, 200)}`)
  let skus = []
  try {
    skus = (text ? JSON.parse(text) : {}).bonus_skus ?? []
  } catch {
    // 空或非 JSON：当成没有新奖励
  }
  const points = skus.reduce((sum, s) => sum + (Number(s.points) || 0), 0)
  return points > 0 ? { state: 'signed', credit: points } : { state: 'already' }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const validCred = (c) => Boolean(c && c.access && c.secret && c.securityToken && c.dpopPrivateJwk)

export function createOfficeAceProvider({ log = () => {}, env = process.env, fetchImpl = null } = {}) {
  let pending = null
  const accountsOf = async () => (await listAccounts('officeace', env)).filter((a) => validCred(a.cred))
  // 测试可以注入假的领取 / 续期
  const claim = fetchImpl?.claim || officeAceClaim
  const refresh = fetchImpl?.refresh || refreshOfficeAce

  return {
    id: 'officeace',
    name: 'OfficeAce（华为云）',
    short: 'OfficeAce',
    color: '#c7000b',
    unit: '积分',
    timeZoneMode: 'fixed',
    timeZone: CHECKIN_TZ,

    async account() {
      const list = await accountsOf()
      if (!list.length) {
        return { loggedIn: false, label: '未登录', detail: '点「登录」用华为云账号在浏览器里登录一次（实验）', code: 'OFFICEACE_NOT_CONFIGURED' }
      }
      const noRefresh = list.filter((a) => !a.cred.refreshToken && officeAceExpiring(a.cred, 0))
      return {
        loggedIn: noRefresh.length < list.length,
        label: list.length > 1 ? `已登录 ${list.length} 个账号` : '已登录',
        detail: noRefresh.length ? `${noRefresh.length} 个账号的登录已过期，需要重新登录` : list.map((a) => a.name || `#${a.id}`).join('、'),
        accounts: list.length,
        accountList: list.map((a) => ({ id: a.id, name: a.name || '' })),
      }
    },

    async needsLogin() {
      return !(await this.account()).loggedIn
    },

    async panel() {
      const n = (await accountsOf()).length
      const today = { dayNo: 1, date: beijingDayKey(), points: 0, bonusPoints: 0, status: n ? 2 : 1, isToday: true }
      return {
        style: 'daily',
        days: [today],
        today,
        claimable: n > 0,
        claimedDays: 0,
        totalPoints: 0,
        accounts: n,
        timeZone: CHECKIN_TZ,
        description: n ? `${n} 个 OfficeAce 账号，每天领一次奖励` : '还没登录 OfficeAce',
      }
    },

    /** 一个账号签一次：快到期先续期，续期拿到的新 refresh token 立刻写回（它只能用一次） */
    async runOne(account, { trigger = 'manual', dryRun = false, label = '' } = {}) {
      const day = beijingDayKey()
      const base = { provider: 'officeace', trigger, timeZone: CHECKIN_TZ, day }
      if (dryRun) return { ...base, ok: true, outcome: OUTCOME.DRY, points: 0, message: `${label}：已登录（干跑，不真签）` }
      let cred = account.cred
      try {
        if (officeAceExpiring(cred) && !isReadOnly(env)) {
          cred = await refresh(cred)
          await patchAccount('officeace', account.id, { cred, savedAt: new Date().toISOString() }, env)
        }
        const r = await claim(cred)
        return r.state === 'signed'
          ? { ...base, ok: true, outcome: OUTCOME.CLAIMED, points: r.credit || 0, message: `${label}：+${r.credit || 0} 积分` }
          : { ...base, ok: true, outcome: OUTCOME.ALREADY, points: 0, message: `${label}：今天已领` }
      } catch (error) {
        if (error instanceof OfficeAceAuthError) {
          // 登录失效不是故障：要用户重新登录，重试没用
          return { ...base, ok: false, outcome: OUTCOME.NEEDS_LOGIN, points: 0, message: `${label}：${error.message}，点「登录」重新登录这个华为云账号` }
        }
        throw error
      }
    },

    async run({ trigger = 'manual', dryRun = false } = {}) {
      const accounts = await accountsOf()
      if (!accounts.length) {
        throw Object.assign(new Error('OfficeAce 还没登录：点面板上的「登录」，用华为云账号在浏览器里登录一次'), { code: 'OFFICEACE_NOT_CONFIGURED' })
      }
      const results = []
      for (const a of accounts) {
        const label = a.name || `#${a.id}`
        try {
          results.push({ ok: true, key: `m:${a.id}`, label, result: await this.runOne(a, { trigger, dryRun, label }) })
        } catch (error) {
          results.push({ ok: false, key: `m:${a.id}`, label, error: error.message, code: error.code })
        }
      }
      const merged = mergeAccountResults('officeace', results, { trigger, dryRun, unit: '积分', tz: CHECKIN_TZ })
      log(`dsh-checkin-all: [OfficeAce] ${merged.message}`)
      return { ...merged, day: beijingDayKey() }
    },

    /** 浏览器登录：拿 state + 授权地址，打开浏览器，然后由 loginWait 轮询授权码 */
    async loginStart() {
      const start = await startOfficeAceLogin()
      const { openBrowser } = await import('./codearts-login.js')
      const opened = openBrowser(start.url)
      pending = { ...start, abort: false }
      return {
        userCode: '',
        verificationUri: start.url,
        verificationUriComplete: start.url,
        expiresInSec: Math.round(LOGIN_TIMEOUT_MS / 1000),
        opened,
        product: 'OfficeAce（华为云）',
      }
    },

    async loginWait({ timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
      if (!pending) {
        throw Object.assign(new Error('没有正在进行的 OfficeAce 登录，先点一次「登录」'), { code: 'OFFICEACE_NO_PENDING_LOGIN' })
      }
      const current = pending
      const deadline = Date.now() + timeoutMs
      let code
      while (!code) {
        if (current.abort) throw Object.assign(new Error('登录已取消'), { code: 'OAUTH_ABORTED' })
        if (Date.now() > deadline) throw Object.assign(new Error('登录超时：5 分钟内没有在浏览器里完成华为云登录'), { code: 'OFFICEACE_LOGIN_TIMEOUT' })
        code = await pollOfficeAceCode(current.state)
        if (!code) await sleep(2000)
      }
      if (pending === current) pending = null
      const cred = await exchangeOfficeAceCode(code, current.codeVerifier, current.dpopPrivateJwk)
      // 同一个华为云项目再登录 = 换成新的登录（不多出一个账号）
      const sameId = cred.projectId
        ? (await listAccounts('officeace', env)).find((a) => a.cred && a.cred.projectId === cred.projectId)?.id
        : undefined
      const record = await addAccount('officeace', { ...(sameId ? { id: sameId } : {}), cred }, env)
      log(`dsh-checkin-all: [OfficeAce] 登录成功，账号 #${record.id} 已保存`)
      return { ok: true, userCode: '', account: record.name || `#${record.id}`, expiresAt: cred.expiresAt }
    },

    cancelLogin() {
      if (pending) pending.abort = true
      pending = null
    },
  }
}

