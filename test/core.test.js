import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CLIENT_ID, credentialAccount, credentialKey, listNamespaces, matrixOrigin, accountOrigin, namespacePaths,
} from '../lib/paths.js'
import { normalizePanel, describePanel, localTimeZone, DAY_STATUS } from '../lib/signin.js'
import { dayKey, claimedToday, DEFAULT_CONFIG, loadConfig, saveConfig, providerConfig, recordAttempt, loadState, statePath } from '../lib/store.js'
import { isDue, minutesPastDue, backoffMs } from '../lib/scheduler.js'
import { CHECKIN_TZ, beijingDayKey, shiftDayKey, streakFromDays, beijingMinutes } from '../lib/tz.js'
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

test('日期键固定按北京时间算，不随本机时区', () => {
  // UTC 2026-11-01 23:30 = 北京 2026-11-02 07:30
  assert.equal(dayKey(new Date('2026-11-01T23:30:00Z'), ''), '2026-11-02')
  // 传任何 timeZone 参数都不影响（老调用兼容）
  assert.equal(dayKey(new Date('2026-11-01T23:30:00Z'), 'America/Los_Angeles'), '2026-11-02')
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

test('isDue 按北京时间判断到点没到点', () => {
  // 北京时间 08:59 还没到 09:00
  assert.equal(isDue('09:00', new Date('2026-11-01T00:59:00Z')), false)
  // 北京时间 09:00:01 到了
  assert.equal(isDue('09:00', new Date('2026-11-01T01:00:01Z')), true)
  // 北京时间 23:00 当然也过了
  assert.equal(isDue('09:00', new Date('2026-11-01T15:00:00Z')), true)
})

test('本机在美西也不会错日：北京时间才是签到窗口', () => {
  // 美西 2026-11-04 21:00 = 北京 2026-11-05 12:00
  const la9pm = new Date('2026-11-05T05:00:00Z')
  assert.equal(beijingDayKey(la9pm), '2026-11-05')
  // 按北京已经是 12:00，09:00 的签到早就该做了
  assert.equal(isDue('09:00', la9pm), true)
  // 北京 13:00 - 09:00 = 240 分钟
  assert.equal(minutesPastDue('09:00', la9pm), 240)
})

test('beijingMinutes / shiftDayKey 跨月跨年正确', () => {
  assert.equal(beijingMinutes(new Date('2026-11-05T05:00:00Z')), 13 * 60)
  assert.equal(shiftDayKey('2026-11-01', -1), '2026-10-31')
  assert.equal(shiftDayKey('2026-01-01', -1), '2025-12-31')
  assert.equal(shiftDayKey('2026-12-31', 1), '2027-01-01')
})

test('连续天数按账本重算，不是累加（重复记录不会虚增）', () => {
  const days = {
    '2026-11-01': { outcome: 'claimed', points: 10 },
    '2026-11-02': { outcome: 'claimed', points: 10 },
    '2026-11-03': { outcome: 'claimed', points: 10 },
  }
  // 以 2026-11-03 为「今天」→ 连续 3 天
  assert.equal(streakFromDays(days, new Date('2026-11-03T04:00:00Z')), 3)
  // 同一天再记一次（对象还是那份），仍然是 3，不会变 4
  const again = { ...days, '2026-11-03': { outcome: 'claimed', points: 10 } }
  assert.equal(streakFromDays(again, new Date('2026-11-03T04:00:00Z')), 3)
})

test('断签一天连续天数归零重来', () => {
  const days = {
    '2026-11-01': { outcome: 'claimed', points: 10 },
    // 11-02 断了
    '2026-11-03': { outcome: 'claimed', points: 10 },
  }
  // 今天 11-03：只算 11-03 这一天
  assert.equal(streakFromDays(days, new Date('2026-11-03T04:00:00Z')), 1)
})

test('dry-run 和失败不算进连续天数', () => {
  const days = {
    '2026-11-02': { outcome: 'claimed', points: 10 },
    '2026-11-03': { outcome: 'dry-run', points: 0 },
  }
  // 11-03 只是看了没领 → 今天不算签过，从 11-02 往前数
  assert.equal(streakFromDays(days, new Date('2026-11-03T04:00:00Z')), 1)
  const failDays = { '2026-11-03': { outcome: 'failed', points: 0 } }
  assert.equal(streakFromDays(failDays, new Date('2026-11-03T04:00:00Z')), 0)
})

test('失败退避逐次拉长并封顶', () => {
  assert.equal(backoffMs(0), 0)
  assert.equal(backoffMs(1), 60_000)
  assert.equal(backoffMs(2), 120_000)
  assert.equal(backoffMs(3), 240_000)
  assert.ok(backoffMs(99) <= 60 * 60_000, '退避要封顶在 1 小时')
})

test('默认设置合理', () => {
  assert.equal(DEFAULT_CONFIG.enabled, true)
  assert.match(DEFAULT_CONFIG.time, /^\d{2}:\d{2}$/)
  assert.equal(DEFAULT_CONFIG.catchUp, true)
})

test('saveConfig 按服务合并 providers，不冲掉别的服务', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-cfg-'))
  const env = { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: join(dir, 'plugin') }
  try {
    // 逐个给三个服务设置单独时间（面板逐个保存的真实场景）
    await saveConfig({ providers: { minimax: { enabled: true, time: '08:00', catchUp: true } } }, env)
    await saveConfig({ providers: { lingxi: { enabled: false, time: '08:30', catchUp: false } } }, env)
    await saveConfig({ providers: { dumate: { enabled: true, time: '01:00', catchUp: true } } }, env)

    // 面板里只改 lingxi：其他两个服务的单独设置必须还在
    await saveConfig({ providers: { lingxi: { enabled: true, time: '10:00', catchUp: true } } }, env)
    const cfg = await loadConfig(env)
    assert.equal(providerConfig(cfg, 'minimax').time, '08:00', 'minimax 单独设置被冲掉了')
    assert.equal(providerConfig(cfg, 'dumate').time, '01:00', 'dumate 单独设置被冲掉了')
    assert.equal(providerConfig(cfg, 'lingxi').time, '10:00')
    assert.equal(providerConfig(cfg, 'lingxi').enabled, true)

    // 全局改时间 / 开关用 providers:null，意思是清空所有单独设置
    await saveConfig({ time: '07:00', providers: null }, env)
    const cleared = await loadConfig(env)
    assert.deepEqual(cleared.providers, {})
    assert.equal(providerConfig(cleared, 'minimax').time, '07:00')

    // 单个服务传 null = 只删它，回退全局，其他服务不受影响
    await saveConfig({ providers: { minimax: { time: '08:00' }, lingxi: { time: '08:30' } } }, env)
    await saveConfig({ providers: { minimax: null } }, env)
    const afterDrop = await loadConfig(env)
    assert.equal(afterDrop.providers.minimax, undefined)
    assert.equal(afterDrop.providers.lingxi.time, '08:30')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

async function withServer(fn, opts = {}) {
  const PREFIX = '/api-dsh-checkin-all'
  const handle = createHandler({
    prefix: PREFIX,
    pkgRoot: new URL('..', import.meta.url).pathname,
    env: opts.env || process.env,
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

test('/credential GET 脱敏返回，POST/DELETE 需自定义头', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-cred-'))
  const env = { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: join(dir, 'plugin') }
  try {
    await withServer(async (base) => {
      // GET 无凭据时返回空 manual
      const g = await fetch(`${base}/credential`)
      assert.equal(g.status, 200)
      const gb = await g.json()
      assert.equal(gb.ok, true)
      assert.deepEqual(gb.manual, {})

      // POST 缺自定义头 → 403
      const p1 = await fetch(`${base}/credential?id=lingxi`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entry: { wps_sid: 'secret' } }),
      })
      assert.equal(p1.status, 403)

      // POST 带自定义头 → 200
      const p2 = await fetch(`${base}/credential?id=lingxi`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-checkin-all': '1' },
        body: JSON.stringify({ entry: { wps_sid: 'secret' } }),
      })
      assert.equal(p2.status, 200)
      assert.equal((await p2.json()).ok, true)

      // GET 脱敏：不返回真实 sid，只返回 configured
      const g2 = await fetch(`${base}/credential`)
      const g2b = await g2.json()
      assert.equal(g2b.manual.lingxi.configured, true)
      assert.equal(g2b.manual.lingxi.wps_sid, true) // 只表示「有值」，不返回真实值

      // DELETE 带自定义头 → 200
      const d = await fetch(`${base}/credential?id=lingxi`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'x-dsh-checkin-all': '1' },
        body: '{}',
      })
      assert.equal(d.status, 200)
      assert.equal((await d.json()).ok, true)
    }, { env })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('/qoder GET 列表脱敏，POST 无效 PAT 返回错误', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-qoder-'))
  const env = { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: join(dir, 'plugin') }
  try {
    await withServer(async (base) => {
      // GET 空列表
      const g = await fetch(`${base}/qoder`)
      assert.equal(g.status, 200)
      const gb = await g.json()
      assert.equal(gb.ok, true)
      assert.deepEqual(gb.qoders, [])
      assert.ok(gb.regions.cn)

      // POST 无效 PAT（会触发真实 exchangePat 调用，走网络会失败；这里验证「没 PAT 或过短」先被拦）
      const p1 = await fetch(`${base}/qoder`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-checkin-all': '1' },
        body: JSON.stringify({ pat: 'short', region: 'cn' }),
      })
      assert.equal(p1.status, 200)
      const p1b = await p1.json()
      assert.equal(p1b.ok, false)
      assert.equal(p1b.code, 'QODER_INVALID_PAT')

      // 缺自定义头 → 403
      const p2 = await fetch(`${base}/qoder`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pat: 'valid-pat-123', region: 'cn' }),
      })
      assert.equal(p2.status, 403)
    }, { env })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

// ── 记账链路的集成回归（对应真实踩过的坑）──

test('同一天重复记不会虚增连续天数，也不会重复加分', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-rec-'))
  const env = { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: join(dir, 'plugin') }
  try {
    const day = dayKey(new Date(), '')
    const base = { ok: true, outcome: 'claimed', points: 50, dayNo: 1, day, timeZone: CHECKIN_TZ }
    await recordAttempt('t', base, env)
    let st = await loadState(env)
    assert.equal(st.providers.t.streak, 1)
    assert.equal(st.providers.t.totalPoints, 50)

    // 重复三次（auto + manual + 面板各点一次的真实情况）
    for (let i = 0; i < 3; i += 1) await recordAttempt('t', base, env)
    st = await loadState(env)
    assert.equal(st.providers.t.streak, 1, '同一天重复记录不能把连续天数加上去')
    assert.equal(st.providers.t.totalPoints, 50, '同一天重复记录不能重复加分')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dry-run 不写账本、不算已签', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-dry-'))
  const env = { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: join(dir, 'plugin') }
  try {
    const day = dayKey(new Date(), '')
    await recordAttempt('t', { ok: true, outcome: 'dry-run', points: 0, day, timeZone: CHECKIN_TZ }, env)
    const st = await loadState(env)
    assert.deepEqual(Object.keys(st.providers.t.days), [], 'dry-run 不该写进 days')
    assert.equal(st.providers.t.streak, 0)
    assert.equal(claimedToday(st, 't', CHECKIN_TZ), false, 'dry-run 不能算今天已签')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('失败不写 days，靠调度器退避兜住（不会每分钟重试到天亮）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-fail-'))
  const env = { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: join(dir, 'plugin') }
  try {
    await recordAttempt('t', { ok: false, outcome: 'ASTUDIO_NOT_LOGGED_IN', points: 0, message: '没登录' }, env)
    const st = await loadState(env)
    assert.deepEqual(Object.keys(st.providers.t.days), [])
    assert.equal(st.providers.t.lastAttempt.outcome, 'ASTUDIO_NOT_LOGGED_IN')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('服务端连续天数优先：服务端断了本地要跟着断', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-srv-'))
  const env = { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: join(dir, 'plugin') }
  try {
    const day = dayKey(new Date(), '')
    // 本地连续记了几天
    await recordAttempt('t', { ok: true, outcome: 'claimed', points: 10, day, timeZone: CHECKIN_TZ }, env)
    // 服务端说这次只有第 1 天（说明中途断过）
    await recordAttempt('t', {
      ok: true, outcome: 'already_claimed', points: 0, day, dayNo: 1, consecutiveDays: 1, timeZone: CHECKIN_TZ,
    }, env)
    const st = await loadState(env)
    assert.equal(st.providers.t.streak, 1, '服务端归零后本地不能还挂着旧数字')
    assert.equal(st.providers.t.serverStreak, 1)
    assert.equal(st.providers.t.totalPoints, 10, 'already_claimed 不能把之前的分抹掉')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('no_task / not_yet 不算今天签过，也不计连续天数', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-benign-'))
  const env = { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: join(dir, 'plugin') }
  try {
    const day = dayKey(new Date(), '')
    // 账号没有签到玩法
    await recordAttempt('t', { ok: true, outcome: 'no_task', points: 0, day, timeZone: CHECKIN_TZ }, env)
    let st = await loadState(env)
    assert.deepEqual(Object.keys(st.providers.t.days), [], 'no_task 不该写进 days')
    assert.equal(st.providers.t.streak, 0)
    assert.equal(claimedToday(st, 't', CHECKIN_TZ), false)

    // 今天还没到轮次
    await recordAttempt('t', { ok: true, outcome: 'not_yet', points: 0, day, timeZone: CHECKIN_TZ }, env)
    st = await loadState(env)
    assert.deepEqual(Object.keys(st.providers.t.days), [], 'not_yet 不该写进 days')
    assert.equal(claimedToday(st, 't', CHECKIN_TZ), false, 'not_yet 时不能标成今天已签')
    assert.equal(st.providers.t.lastAttempt.outcome, 'not_yet', '但要记住上次是「还没轮次」')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('服务端没给连续天数时不清零本地（AStudio 这类）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-nosrv-'))
  const env = { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: join(dir, 'plugin') }
  try {
    const day = dayKey(new Date(), '')
    await recordAttempt('t', { ok: true, outcome: 'claimed', points: 100, day, timeZone: CHECKIN_TZ }, env)
    await recordAttempt('t', { ok: true, outcome: 'already_claimed', points: 0, day, timeZone: CHECKIN_TZ }, env)
    const st = await loadState(env)
    assert.equal(st.providers.t.streak, 1, '没有服务端天数时用本地重算的结果')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── 凭据存储安全 ──

test('凭据目录和文件权限：700 / 600，且目录被改宽后会自动收紧', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-perm-'))
  const home = join(dir, 'checkin')
  const env = { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: home }
  try {
    const { setManual } = await import('../lib/checkin-secrets.js')
    await setManual('lingxi', { wps_sid: 'test-value' }, env)

    const dirMode = (await stat(home)).mode & 0o777
    const fileMode = (await stat(join(home, 'secrets.json'))).mode & 0o777
    assert.equal(dirMode.toString(8), '700', '凭据目录必须 700')
    assert.equal(fileMode.toString(8), '600', 'secrets.json 必须 600')

    // 模拟被人手动改成 755（真实踩到过：mkdir 的 mode 对已存在目录不生效）
    const { chmod } = await import('node:fs/promises')
    await chmod(home, 0o755)
    assert.equal(((await stat(home)).mode & 0o777).toString(8), '755')

    // 再写一次，应该自动收紧回 700
    await setManual('lingxi', { wps_sid: 'again' }, env)
    assert.equal(((await stat(home)).mode & 0o777).toString(8), '700', '写入时应重新收紧目录权限')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('签到历史里不含任何凭据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-state-'))
  const env = { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: join(dir, 'plugin') }
  try {
    await recordAttempt('lingxi', { ok: true, outcome: 'claimed', points: 100, day: '2026-11-07' }, env)
    const raw = await readFile(statePath(env), 'utf8')
    for (const word of ['wps_sid', 'cookie', 'access_token', 'secret_access_key', 'security_token', 'refresh_token']) {
      assert.ok(!raw.includes(word), `state.json 不该出现 ${word}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── 索引卡片：登录状态 + 今日签到（两行都要有）──

/** 复刻 panel.js renderIndex 里的判定，确保逻辑和面板一致 */
function cardText(p) {
  const st = p.state || {}
  const last = st.lastAttempt
  const todayDone = st.claimedToday
  const lastOutcome = (last && last.outcome) || ''
  const benign = lastOutcome === 'no_task' || lastOutcome === 'not_yet'
  const needsLogin = lastOutcome === 'needs_login'
  const loggedIn = Boolean(p.account && p.account.loggedIn)

  const loginText = loggedIn ? '已登录'
    : needsLogin ? '登录已过期'
      : (p.account && p.account.label === '登录已过期') ? '登录已过期' : '未登录'

  let checkText
  if (!loggedIn) checkText = '无法签到'
  else if (todayDone) checkText = last && last.points > 0 ? `今日已签 +${last.points}` : '今日已签'
  else if (benign) checkText = lastOutcome === 'no_task' ? '无签到任务' : '还没到轮次'
  else if (last && !last.ok) checkText = '上次失败'
  else checkText = '今日未签'

  return { loginText, checkText }
}

test('索引卡片：已登录且今天签过 → 两行都正确', () => {
  const c = cardText({
    account: { loggedIn: true },
    state: { claimedToday: true, lastAttempt: { ok: true, points: 400, outcome: 'claimed' } },
  })
  assert.equal(c.loginText, '已登录')
  assert.equal(c.checkText, '今日已签 +400')
})

test('索引卡片：凭据过期 → 登录状态要明说，签到栏不能装作正常', () => {
  const c = cardText({
    account: { loggedIn: false, label: '登录已过期' },
    state: { claimedToday: false, lastAttempt: { ok: false, outcome: 'needs_login' } },
  })
  assert.equal(c.loginText, '登录已过期')
  assert.equal(c.checkText, '无法签到')
})

test('索引卡片：账号没这玩法 → 已登录但不用签', () => {
  const c = cardText({
    account: { loggedIn: true },
    state: { claimedToday: false, lastAttempt: { ok: true, outcome: 'no_task' } },
  })
  assert.equal(c.loginText, '已登录')
  assert.equal(c.checkText, '无签到任务')
})

test('索引卡片：还没到轮次（Qoder 10:00 前）', () => {
  const c = cardText({
    account: { loggedIn: true },
    state: { claimedToday: false, lastAttempt: { ok: false, outcome: 'not_yet' } },
  })
  assert.equal(c.checkText, '还没到轮次')
})

test('索引卡片：已登录但今天没签过 → 今日未签（不是已签）', () => {
  const c = cardText({
    account: { loggedIn: true },
    state: { claimedToday: false, lastAttempt: null },
  })
  assert.equal(c.loginText, '已登录')
  assert.equal(c.checkText, '今日未签')
})

test('索引卡片：上次真失败 → 说失败，不说未签', () => {
  const c = cardText({
    account: { loggedIn: true },
    state: { claimedToday: false, lastAttempt: { ok: false, outcome: 'CODEARTS_HTTP_ERROR' } },
  })
  assert.equal(c.checkText, '上次失败')
})

test('索引卡片：未登录', () => {
  const c = cardText({ account: { loggedIn: false }, state: {} })
  assert.equal(c.loginText, '未登录')
  assert.equal(c.checkText, '无法签到')
})

// ── 详情卡片折叠 ──

test('详情折叠：除第一张概览卡外都可折叠，且默认折叠', async () => {
  // 直接从源码里核对 makeCollapsible 的规则，避免以后被改坏
  const src = await readFile('/Users/wf/dsh/dsh-checkin-all/web/panel.js', 'utf8')

  // 1) 第一张卡跳过
  assert.match(src, /if \(idx === 0\) return/, '概览卡不该被折叠')
  // 2) 默认折叠
  assert.match(src, /let open = false/, '默认应该是折叠（open=false）')
  // 3) 有橙色三角
  assert.match(src, /className = 'chev'/, '要有三角箭头')
  assert.match(src, /'▸'/, '折叠态用 ▸')
  assert.match(src, /'▾'/, '展开态用 ▾')
  // 4) 折叠样式挂在 card 上
  assert.match(src, /classList\.toggle\('collapsed'/, '要用 collapsed 类控制显示')
})

test('详情折叠：CSS 里三角是橙色、折叠时隐藏内容', async () => {
  const css = await readFile('/Users/wf/dsh/dsh-checkin-all/web/panel.css', 'utf8')
  assert.match(css, /\.card-head\.collapsible-head \.chev[\s\S]{0,200}color:\s*var\(--warn\)/, '三角要用橙色（--warn）')
  assert.match(css, /\.card\.collapsed \.card-body\s*\{\s*display:\s*none/, '折叠时内容要隐藏')
  assert.match(css, /justify-content:\s*flex-start/, '三角插到前面后要改左对齐')
})

test('详情折叠：head 里的按钮不会误触发折叠', async () => {
  const src = await readFile('/Users/wf/dsh/dsh-checkin-all/web/panel.js', 'utf8')
  assert.match(src, /e\.target\.closest\('button'\)/, '点刷新等按钮时不该折叠卡片')
})

test('顶部卡片布局：.index 是纵向流，卡片网格交给 .igroup', async () => {
  const css = await readFile('/Users/wf/dsh/dsh-checkin-all/web/panel.css', 'utf8')
  const idx = css.match(/\.index \{[^}]+\}/)
  assert.ok(idx, '找不到 .index 规则')
  // 踩过的坑：.index 用 grid 时，里面的 igroup / 折叠条 / 添加按钮
  // 会被各塞进一个窄格子，表现成「全挤在左边一列」
  assert.match(idx[0], /flex-direction:\s*column/, '.index 必须是纵向流')
  assert.ok(!/display:\s*grid/.test(idx[0]), '.index 不能是 grid（会把整块压进一列）')

  const group = css.match(/\.igroup \{[^}]+\}/)
  assert.ok(group, '找不到 .igroup 规则')
  assert.match(group[0], /display:\s*grid/, '.igroup 才是卡片网格')
  assert.match(group[0], /minmax\(148px/, '卡片最小宽度 148px')
})

test('顶部卡片布局：分组条和添加按钮占满整行', async () => {
  const css = await readFile('/Users/wf/dsh/dsh-checkin-all/web/panel.css', 'utf8')
  for (const cls of ['igroup-toggle', 'igroup-add']) {
    const rule = css.match(new RegExp(`\\.${cls} \\{[^}]+\\}`))
    assert.ok(rule, `找不到 .${cls}`)
    assert.match(rule[0], /width:\s*100%/, `.${cls} 要占满整行`)
  }
})
