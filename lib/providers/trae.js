// lib/providers/trae.js — Trae（国内版 / SOLO）每日签到
//
// 登录信息复用本机已登录的 Trae 桌面 App 或 CLI（只读，不落盘，只在内存里用）：
//   1) 桌面 App：<应用数据>/{TRAE SOLO CN | Trae CN | Trae | TRAE SOLO}/User/globalStorage/storage.json
//      里的 iCubeAuthInfo://icube.cloudide（加密信封）
//   2) CLI：~/.trae-cn/trae-jwt-token、~/.trae/trae-jwt-token
// 解密算法、接口与请求头照 dsh-model 的 src/checkin/trae.ts（原自 G57651/dsh-dual-checkin，MIT）。
//   POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status   今天签没签、能领多少
//   POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim    签到

import { createDecipheriv, createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OUTCOME } from './base.js'

const API = 'https://api.trae.cn'
const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide'
const DEVICE_PREFIX = 'iCubeAuthInfo://icube-dc:'
const APPS = ['TRAE SOLO CN', 'Trae CN', 'Trae', 'TRAE SOLO']
const TRAE_TZ = 'Asia/Shanghai'

const SALT_A = Uint8Array.from([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37])
const SALT_B = Uint8Array.from([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125])
const SALT_C = Uint8Array.from([191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209])
const SALT_D = Uint8Array.from([246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170])

const xor = (a, b) => Buffer.from(a.map((v, i) => v ^ (b[i] ?? 0)))

/** 解开 storage.json 里的加密信封。导出给测试 */
export function decryptStorageValue(encoded) {
  const buf = Buffer.from(encoded, 'base64')
  if (buf.length <= 102) throw new Error('Trae 登录信息太短')
  const header = buf.subarray(0, 6)
  const kind = header.equals(Buffer.from([116, 99, 5, 16, 0, 0])) ? 'aes' : header.equals(Buffer.from([18, 57, 32, 32, 2, 3])) ? 'aes-private' : null
  if (!kind) throw new Error('Trae 登录信息的加密格式不认识（Trae 可能又改版了）')
  const salt = kind === 'aes-private' ? xor(SALT_C, SALT_D) : xor(SALT_A, SALT_B)
  const first = createHash('sha512').update(buf.subarray(6, 38)).digest()
  const derived = createHash('sha512').update(Buffer.concat([first, salt])).digest()
  const decipher = createDecipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32))
  const out = Buffer.concat([decipher.update(buf.subarray(38)), decipher.final()])
  if (out.length < 64) throw new Error('Trae 登录信息解开后太短')
  const plain = out.subarray(64)
  if (!out.subarray(0, 64).equals(createHash('sha512').update(plain).digest())) throw new Error('Trae 登录信息校验不通过')
  return plain.toString('utf8')
}

/** JWT 里的账号 id（data.id）；读不出来返回 undefined */
export function tokenAccountId(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())
    const id = p.data?.id ?? p.sub
    return id === undefined || id === null || id === '' ? undefined : String(id)
  } catch {
    return undefined
  }
}

/** 各平台的应用数据目录 */
function appDataRoots(home, platform = process.platform, env = process.env) {
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support')]
  if (platform === 'win32') return [...new Set([env.APPDATA, join(home, 'AppData', 'Roaming')].filter(Boolean))]
  return [env.XDG_CONFIG_HOME || join(home, '.config')]
}

async function readTraeCredentials(home, platform = process.platform, env = process.env) {
  if (process.env.DSH_CHECKIN_NO_APP_DISCOVERY && home === homedir()) return []
  const found = []
  for (const root of appDataRoots(home, platform, env)) {
    for (const app of APPS) {
      const file = join(root, app, 'User', 'globalStorage', 'storage.json')
      try {
        const storage = JSON.parse(await readFile(file, 'utf8'))
        const raw = storage[AUTH_KEY]
        if (typeof raw !== 'string' || !raw.trim()) continue
        const text = raw.trim().startsWith('{') ? raw : decryptStorageValue(raw)
        const auth = JSON.parse(text)
        const token = auth.token || auth.accessToken
        if (!token) continue
        const dc = Object.keys(storage).find((k) => k.startsWith(DEVICE_PREFIX))
        const accountId = auth.userId !== undefined && auth.userId !== null && auth.userId !== '' ? String(auth.userId) : tokenAccountId(token)
        found.push({ token, deviceId: dc ? dc.slice(DEVICE_PREFIX.length) : String(storage['telemetry.devDeviceId'] ?? ''), source: app, ...(accountId ? { accountId } : {}) })
      } catch {
        // 没装、读不了或解不开：看下一个
      }
    }
  }
  for (const dir of ['.trae-cn', '.trae']) {
    try {
      const text = (await readFile(join(home, dir, 'trae-jwt-token'), 'utf8')).trim()
      const token = text.startsWith('{') ? String((JSON.parse(text).token ?? '')) : text
      const accountId = tokenAccountId(token)
      if (token.split('.').length === 3) found.push({ token, deviceId: '', source: `~/${dir}`, ...(accountId ? { accountId } : {}) })
    } catch {
      // 没有
    }
  }
  return found
}

/** 几份登录里挑一份：没过期的优先 → 带设备 id 的（桌面 App）优先 → 到期最晚的。导出给测试 */
export function pickTraeCredential(list, now = Date.now()) {
  const exp = (t) => {
    const d = tokenDaysLeft(t, now)
    return d === null ? Number.POSITIVE_INFINITY : d
  }
  const ranked = [...list].sort((a, b) => {
    const live = Number(exp(b.token) >= 0) - Number(exp(a.token) >= 0)
    if (live) return live
    const desktop = Number(Boolean(b.deviceId)) - Number(Boolean(a.deviceId))
    if (desktop) return desktop
    return exp(b.token) - exp(a.token)
  })
  return ranked[0] ?? null
}

/** 令牌还剩几天（读 JWT 的 exp）；读不出来返回 null */
export function tokenDaysLeft(token, now = Date.now()) {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).exp
    return typeof exp === 'number' ? Math.floor((exp * 1000 - now) / 86_400_000) : null
  } catch {
    return null
  }
}

/** 本机的每个 Trae 账号各一份登录（同一个账号装了几个 Trae 只算一个），第一个是最该用的 */
export async function findTraeCredentials(home = homedir(), platform = process.platform, env = process.env) {
  const found = await readTraeCredentials(home, platform, env)
  const groups = new Map()
  for (const c of found) {
    const key = c.accountId ?? `?${c.source}`
    groups.set(key, [...(groups.get(key) ?? []), c])
  }
  const best = [...groups.values()].map((g) => pickTraeCredential(g)).filter(Boolean)
  const first = pickTraeCredential(best)
  return first ? [first, ...best.filter((c) => c !== first)] : []
}

function headers(c) {
  return {
    authorization: `Cloud-IDE-JWT ${c.token}`,
    'content-type': 'application/json',
    'user-agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
    'x-user-region': 'CN',
    'package-type': 'stable_cn',
    'x-lscbd-aid': '787976',
    'x-lscbd-platform': 'windows',
    'app-version': '0.1.51',
    accept: '*/*',
    'x-request-id': randomUUID().replace(/-/g, ''),
    'x-device-brand': 'To be filled by O.E.M.',
    'x-device-type': 'windows',
    'x-lgw-req-sdk-type': '3',
    ...(c.deviceId ? { 'x-device-id': c.deviceId } : {}),
  }
}

async function post(c, path) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: headers(c), body: '{}', signal: AbortSignal.timeout(20_000) })
  const text = await res.text()
  if (res.status === 401 || res.status === 403) throw new Error(`Trae 登录无效或已过期（HTTP ${res.status}）`)
  if (!res.ok) throw new Error(`Trae HTTP ${res.status}: ${text.slice(0, 160)}`)
  return text ? JSON.parse(text) : {}
}

/** 今天签没签、签到送多少 */
export async function traeStatus(c) {
  const r = await post(c, '/trae/api/v2/ug/checkin_credits/status')
  if (r.code && r.code !== 0) throw new Error(`Trae 查询签到状态失败（code ${String(r.code)}：${String(r.message ?? '')}）${/1001|authent/i.test(String(r.message ?? r.code)) ? '，令牌可能过期，请重新登录 Trae' : ''}`)
  const d = (typeof r.data === 'object' && r.data !== null ? r.data : r)
  const credits = (typeof d.credits === 'number' ? d.credits : 0) + (typeof d.extra_credits === 'number' ? d.extra_credits : 0)
  return { checkedIn: d.checked_in === true, ...(credits ? { credits } : {}) }
}

export async function traeCheckin(c) {
  const st = await traeStatus(c)
  if (st.checkedIn) return { state: 'already' }
  const r = await post(c, '/trae/api/v2/ug/checkin_credits/claim')
  if (r.code !== undefined && r.code !== 0) throw new Error(`Trae 签到失败（code ${String(r.code)}：${String(r.message ?? '')}）`)
  return { state: 'signed', ...(st.credits ? { credit: st.credits } : {}) }
}

export function createTraeProvider({ log = () => {}, env = process.env } = {}) {
  const creds = () => findTraeCredentials(env.HOME || env.USERPROFILE || homedir(), env.TRAE_PLATFORM || process.platform, env)

  return {
    id: 'trae',
    name: 'Trae',
    short: 'Trae',
    color: '#6b3fa0',
    unit: '积分',
    timeZoneMode: 'fixed',
    timeZone: TRAE_TZ,

    async account() {
      const list = await creds()
      if (!list.length) {
        return { loggedIn: false, label: '未登录', detail: '这台机器没装/没登录 Trae', code: 'TRAE_NOT_LOGGED_IN' }
      }
      return { loggedIn: true, label: '已登录', detail: `${list.length} 个账号` }
    },

    async needsLogin() {
      return !(await this.account()).loggedIn
    },

    async panel() {
      const list = await creds()
      const day = list.length
      return {
        style: 'daily',
        days: [{ dayNo: 1, date: beijingDay(), points: 0, bonusPoints: 0, status: day ? 2 : 1, isToday: true }],
        today: { dayNo: 1, date: beijingDay(), points: 0, bonusPoints: 0, status: day ? 2 : 1, isToday: true },
        claimable: day > 0,
        claimedDays: 0,
        totalPoints: 0,
        accounts: day,
        timeZone: TRAE_TZ,
        description: day ? `本机有 ${day} 个 Trae 账号` : '这台机器没装/没登录 Trae',
      }
    },

    async run({ trigger = 'manual', dryRun = false } = {}) {
      const list = await creds()
      if (!list.length) {
        throw Object.assign(new Error('这台机器没装/没登录 Trae（要在装了 Trae 的电脑上签）'), { code: 'TRAE_NOT_LOGGED_IN' })
      }
      const day = beijingDay()
      if (dryRun) {
        return {
          ok: true, outcome: OUTCOME.DRY, provider: 'trae', trigger, timeZone: TRAE_TZ,
          points: 0, day, message: `本机有 ${list.length} 个 Trae 账号（干跑，不真签）`,
        }
      }
      let signed = 0
      let already = 0
      let points = 0
      const messages = []
      for (const t of list) {
        const label = t.accountId ? `…${t.accountId.slice(-4)}` : t.source
        try {
          const r = await traeCheckin(t)
          if (r.state === 'signed') { signed += 1; points += r.credit ?? 0; messages.push(`${label}：+${r.credit ?? '?'} 积分`) }
          else { already += 1; messages.push(`${label}：今天已签`) }
        } catch (error) {
          messages.push(`${label}：失败（${error.message.slice(0, 80)}）`)
        }
      }
      const ok = signed + already > 0
      const outcome = signed > 0 ? OUTCOME.CLAIMED : already > 0 ? OUTCOME.ALREADY : 'failed'
      const result = {
        ok, outcome, provider: 'trae', trigger, timeZone: TRAE_TZ, points, day,
        message: `Trae：${messages.join('；')}`,
      }
      log(`dsh-checkin-all: [Trae] ${result.message}`)
      if (!ok) throw Object.assign(new Error(result.message), { code: 'TRAE_ALL_FAILED' })
      return result
    },

    async loginStart() {
      throw Object.assign(new Error('Trae 的登录在 Trae App 里完成：打开 Trae 登录一次'), { code: 'TRAE_MANUAL_LOGIN' })
    },
  }
}

function beijingDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TRAE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
