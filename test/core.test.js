import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CLIENT_ID, credentialAccount, credentialKey, listNamespaces, matrixOrigin, accountOrigin, namespacePaths,
} from '../lib/paths.js'
import { normalizePanel, describePanel, localTimeZone, DAY_STATUS } from '../lib/signin.js'
import { dayKey, claimedToday, DEFAULT_CONFIG } from '../lib/store.js'
import { nextRunAt, isDue } from '../lib/scheduler.js'
import { activeNamespace, readCredential, usableCredential, CredentialError } from '../lib/credentials.js'

const panel = {
  scene: 2,
  days: [
    { day_no: 1, points: 400, status: 3, is_today: false, bonus_points: 0 },
    { day_no: 2, points: 400, status: 3, is_today: false, bonus_points: 0 },
    { day_no: 3, points: 400, status: 3, is_today: false, bonus_points: 0 },
    { day_no: 4, points: 1000, status: 2, is_today: true, bonus_points: 50 },
    { day_no: 5, points: 400, status: 1, is_today: false, bonus_points: 0 },
    { day_no: 6, points: 400, status: 1, is_today: false, bonus_points: 0 },
    { day_no: 7, points: 1000, status: 1, is_today: false, bonus_points: 0 },
  ],
}

test('panel 归一化：今天、可领、已领天数与累计分', () => {
  const p = normalizePanel(panel)
  assert.equal(p.days.length, 7)
  assert.equal(p.today.dayNo, 4)
  assert.equal(p.claimable, true)
  assert.equal(p.claimedDays, 3)
  assert.equal(p.totalPoints, 1200)
  assert.equal(describePanel(p), '今天（第 4 天）可以领 1050 分')
})

test('panel 已领状态的说法', () => {
  const claimed = normalizePanel({
    scene: 2,
    days: panel.days.map(d => (d.is_today ? { ...d, status: 3 } : d)),
  })
  assert.equal(claimed.claimable, false)
  assert.match(describePanel(claimed), /已经签过了/)
})

test('panel 缺 days 也不炸', () => {
  const p = normalizePanel({})
  assert.deepEqual(p.days, [])
  assert.equal(p.today, null)
  assert.equal(describePanel(p), '签到表读不出来')
})

test('时区一定拿得到', () => {
  const tz = localTimeZone()
  assert.ok(typeof tz === 'string' && tz.length > 0)
})

test('凭据 key 的算法和 App 一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-'))
  const auth = join(dir, 'auth')
  const key = credentialKey('prod', 'en', auth)
  assert.equal(key, `com.minimax.mcode.oauth.prod.en\0${credentialAccount(auth)}`)
  await rm(dir, { recursive: true, force: true })
})

test('矩阵与 OAuth 主机按 region 分', () => {
  assert.equal(matrixOrigin('prod', 'en'), 'https://agent.minimax.io')
  assert.equal(matrixOrigin('prod', 'cn'), 'https://agent.minimax.cn')
  assert.equal(accountOrigin('prod', 'en'), 'https://account.minimax.io')
  assert.equal(accountOrigin('prod', 'cn'), 'https://account.minimax.cn')
})

test('能找到命名空间并读出凭据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-'))
  const ns = namespacePaths({ buildEnv: 'prod', region: 'en' }, dir)
  await mkdir(ns.home, { recursive: true, mode: 0o700 })
  const key = credentialKey('prod', 'en', ns.authHome)
  await writeFile(ns.credentialPath, JSON.stringify({
    schemaVersion: 1,
    records: {
      [key]: {
        schemaVersion: 1,
        accessToken: 'mmoat_test',
        refreshToken: 'mmort_test',
        tokenType: 'Bearer',
        clientId: CLIENT_ID,
        scopes: ['agent.default'],
        audience: 'agent-backend',
        expiresAtMs: Date.now() + 3_600_000,
        generation: 7,
        loginEpoch: 'epoch-1',
      },
    },
  }))

  const found = await listNamespaces(dir)
  assert.equal(found.length, 1)
  assert.equal(found[0].buildEnv, 'prod')
  assert.equal(found[0].region, 'en')

  const credential = await readCredential(found[0])
  assert.equal(credential.accessToken, 'mmoat_test')
  assert.equal(credential.generation, 7)

  const active = await activeNamespace(dir)
  assert.equal(active.loggedIn, true)

  // 还没到期的 token 直接用，不联网
  const { credential: usable, refreshed } = await usableCredential(found[0], { minValidityMs: 60_000 })
  assert.equal(refreshed, false)
  assert.equal(usable.accessToken, 'mmoat_test')

  await rm(dir, { recursive: true, force: true })
})

test('没有凭据时报 AUTH_REQUIRED', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-'))
  const ns = namespacePaths({ buildEnv: 'prod', region: 'en' }, dir)
  await assert.rejects(() => usableCredential(ns), (error) => {
    assert.ok(error instanceof CredentialError)
    assert.equal(error.code, 'AUTH_REQUIRED')
    return true
  })
  await rm(dir, { recursive: true, force: true })
})

test('日期键按本地时区算', () => {
  const day = dayKey(new Date(2026, 10, 1, 23, 30), '')
  assert.equal(day, '2026-11-01')
})

test('claimedToday 认 claimed 和 already_claimed（按服务）', () => {
  const day = dayKey(new Date(), '')
  const st = { providers: { minimax: { days: { [day]: { outcome: 'claimed' } } } } }
  assert.equal(claimedToday(st, 'minimax', ''), true)
  const st2 = { providers: { minimax: { days: { [day]: { outcome: 'already_claimed' } } } } }
  assert.equal(claimedToday(st2, 'minimax', ''), true)
  assert.equal(claimedToday({ providers: { minimax: { days: {} } } }, 'minimax', ''), false)
  // 另一个服务不受影响
  assert.equal(claimedToday(st, 'lingxi', ''), false)
})

test('下一次签到时间在将来，且时间点正确', () => {
  const now = new Date(2026, 10, 1, 8, 0, 0)
  const at = nextRunAt('09:00', now)
  assert.equal(at.getHours(), 9)
  assert.equal(at.getMinutes(), 0)
  assert.equal(at.getDate(), 1)
  // 已经过了今天的时间点 → 明天
  const later = nextRunAt('09:00', new Date(2026, 10, 1, 10, 0, 0))
  assert.equal(later.getDate(), 2)
  assert.ok(later.getTime() > new Date(2026, 10, 1, 10, 0, 0).getTime())
})

test('isDue 判断到点没到点', () => {
  assert.equal(isDue('09:00', new Date(2026, 10, 1, 8, 59, 0)), false)
  assert.equal(isDue('09:00', new Date(2026, 10, 1, 9, 0, 1)), true)
  assert.equal(isDue('09:00', new Date(2026, 10, 1, 23, 0, 0)), true)
})

test('默认设置合理', () => {
  assert.equal(DEFAULT_CONFIG.enabled, true)
  assert.match(DEFAULT_CONFIG.time, /^\d{2}:\d{2}$/)
  assert.equal(DEFAULT_CONFIG.catchUp, true)
})

test('凭据文件是私密的 0600（App 会检查权限）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-'))
  const ns = namespacePaths({ buildEnv: 'prod', region: 'en' }, dir)
  await mkdir(ns.home, { recursive: true, mode: 0o700 })
  const key = credentialKey('prod', 'en', ns.authHome)
  await writeFile(ns.credentialPath, JSON.stringify({
    schemaVersion: 1,
    records: {
      [key]: {
        schemaVersion: 1, accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer',
        clientId: CLIENT_ID, scopes: ['agent.default'], audience: 'agent-backend',
        expiresAtMs: Date.now() + 1000, generation: 1,
      },
    },
  }), { mode: 0o600 })
  const info = await stat(ns.credentialPath)
  assert.equal(info.mode & 0o077, 0)
  await rm(dir, { recursive: true, force: true })
})

// ── 路由：/panel 是 HTML，签到数据在 /signin（曾经这两个撞在一起，前端 r.json() 炸了）──

import { createServer } from 'node:http'
import { createHandler } from '../lib/server.js'

async function withServer(fn) {
  const PREFIX = '/api-dsh-checkin-all'
  const handle = createHandler({
    prefix: PREFIX,
    pkgRoot: new URL('..', import.meta.url).pathname,
    runner: {
      meta: () => [
        { id: 'minimax', name: 'MiniMax Code', short: 'MiniMax', color: '#2f6bff', unit: '分', timeZoneMode: 'local', timeZone: '' },
        { id: 'lingxi', name: 'WPS 灵犀', short: '灵犀', color: '#1F69E0', unit: '智点', timeZoneMode: 'fixed', timeZone: 'Asia/Shanghai' },
      ],
      account: async () => ({ loggedIn: true, label: '已登录', expiresInSec: 3600 }),
      panel: async () => ({ days: [], timeZone: 'UTC' }),
      run: async () => ({ ok: true, outcome: 'already_claimed', message: 'ok', provider: 'minimax' }),
      runAll: async () => ([{ ok: true, outcome: 'already_claimed', message: 'ok', provider: 'minimax' }]),
    },
    scheduler: null,
    version: () => '0.0.0-test',
    log: () => {},
  })
  const server = createServer((req, res) => { void handle(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await fn(`http://127.0.0.1:${port}${PREFIX}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('/panel 是面板 HTML，不是 JSON', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/panel`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /text\/html/)
    assert.match(await r.text(), /<!DOCTYPE html>/i)
  })
})

test('/signin 返回签到表 JSON（不和面板 HTML 抢路由）', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/signin`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /application\/json/)
    const body = await r.json()
    assert.equal(body.ok, true)
    assert.equal(body.id, '')
    assert.ok(Array.isArray(body.days), '/signin 直接返回签到表')
  })
})

test('/panel-data 是 /signin 的别名', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/panel-data`)
    assert.equal(r.status, 200)
    assert.equal((await r.json()).ok, true)
  })
})

test('/status 带版本号，且按服务列出', async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/status`)).json()
    assert.equal(body.version, '0.0.0-test')
    assert.ok(Array.isArray(body.providers))
    assert.ok(body.providers.length >= 2, '应该至少有 minimax 和 lingxi 两个服务')
    const ids = body.providers.map(p => p.id)
    assert.ok(ids.includes('minimax'))
    assert.ok(ids.includes('lingxi'))
    // 每个服务都带账号、状态、自己的设置
    for (const p of body.providers) {
      assert.ok(p.account, `${p.id} 缺 account`)
      assert.ok(p.state, `${p.id} 缺 state`)
      assert.ok(p.config, `${p.id} 缺 config`)
    }
  })
})

test('未知路由回 404 JSON，不是空响应', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/nope`)
    assert.equal(r.status, 404)
    assert.match(r.headers.get('content-type'), /application\/json/)
    assert.equal((await r.json()).error, 'not found')
  })
})

test('POST 缺自定义头 -> 403 JSON（CSRF 防护，且有 body 可解析）', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/checkin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(r.status, 403)
    const body = await r.json()
    assert.equal(body.ok, false)
  })
})

test('POST 带自定义头 -> 放行', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/checkin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-checkin-all': '1' },
      body: '{}',
    })
    assert.equal(r.status, 200)
    assert.equal((await r.json()).ok, true)
  })
})

// ── 客户端拼路径：曾经写成 BASE + path，api('status') 拼成 /api-dsh-checkin-allstatus → 404 ──

test('client.js 的接口地址拼接：带不带前导斜杠都拼对', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../plugin/client.js', import.meta.url), 'utf8')
  const start = src.indexOf("const BASE = '/api-dsh-checkin-all'")
  const end = src.indexOf('function Btn(')
  assert.ok(start > 0 && end > start, '找不到 api 定义')
  let body = src.slice(start, end)
  body = body.replace(/const L = .*\n/, '')
  const { url } = new Function('L', `${body}; return { url }`)(zh => zh)

  const BASE = '/api-dsh-checkin-all'
  for (const p of ['status', '/status', 'checkin', '/checkin', 'login/start', 'login/wait']) {
    const expected = `${BASE}/${p.replace(/^\/+/, '')}`
    assert.equal(url(p), expected, `api('${p}') 拼错了`)
    // 绝不能出现前缀和路径粘在一起的情况
    assert.ok(!url(p).includes(`${BASE}${p.replace(/^\/+/, '')}`) || p.startsWith('/'),
      `api('${p}') 把前缀和路径粘在一起了：${url(p)}`)
  }
})

test('client.js 里没有任何 BASE + path 的裸拼接', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../plugin/client.js', import.meta.url), 'utf8')
  assert.equal(/fetch\(\s*BASE\s*\+/.test(src), false, '还在用 BASE + path 拼地址')
})
