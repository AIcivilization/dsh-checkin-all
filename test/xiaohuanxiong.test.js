// test/xiaohuanxiong.test.js — 商汤小浣熊：Cookie 解析、签到表归一化、签到流程（mock fetch）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  authOf, tokenFromCookie, deviceIdOf, findTodayGrant, findTodayExpire,
  normalizeXhxPanel, describeXhxPanel, createXiaohuanxiongProvider, FREE_DAILY_POINTS,
} from '../lib/providers/xiaohuanxiong.js'
import { cookieHeaderFrom, looksLoggedIn, chromeExecutable, waitForLogin } from '../lib/providers/xiaohuanxiong-login.js'
import { addAccount, listAccounts } from '../lib/checkin-secrets.js'
import { beijingDayKey, shiftDayKey } from '../lib/tz.js'
import { createProviders } from '../lib/providers/index.js'

// 用「今天」当基准：小浣熊只认北京时间今天那笔 daily_grant，写死日期会过期
const DAY = beijingDayKey()

function grantItem(points, grantAt = `${DAY}T00:05:00+08:00`) {
  return { biz_type: 'daily_grant', points, grant_at: grantAt, expire_at: `${DAY}T23:59:59+08:00`, display_name: '每日积分', source: 'daily' }
}

test('小浣熊：从整条 Cookie 里取 xhx_token（新版）', () => {
  const cookie = 'a=1; xhx_token=abc.def.ghi; b=2'
  assert.equal(tokenFromCookie(cookie), 'abc.def.ghi')
  assert.deepEqual(authOf({ cookie }), { cookie, token: 'abc.def.ghi' })
})

test('小浣熊：旧版 <prefix>raccoon_token 也认', () => {
  const cookie = 'foo=1; sraccoon_token=legacy-token; bar=2'
  assert.equal(tokenFromCookie(cookie), 'legacy-token')
})

test('小浣熊：只给裸 token 时同时塞进 cookie 和 Bearer', () => {
  const auth = authOf({ token: 'tok123' })
  assert.equal(auth.token, 'tok123')
  assert.equal(auth.cookie, 'xhx_token=tok123')
})

test('小浣熊：设备 ID 稳定，同一 token 每次一样', () => {
  const a = deviceIdOf({ token: 't1' }, {})
  const b = deviceIdOf({ token: 't1' }, {})
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.notEqual(a, deviceIdOf({ token: 't2' }, {}))
  assert.equal(deviceIdOf({ token: 't1' }, { device_id: 'given' }), 'given')
})

test('小浣熊：只认北京时间的「今天」那笔 daily_grant', () => {
  const items = [
    grantItem(300, '2026-11-13T00:05:00+08:00'),
    grantItem(300, `${DAY}T00:05:00+08:00`),
  ]
  assert.equal(findTodayGrant(items, DAY).grant_at, `${DAY}T00:05:00+08:00`)
  assert.equal(findTodayGrant(items, '2026-11-12'), null)
  // 美西 11-13 16:00 = 北京 11-14 08:00，算 11-14
  const edge = [grantItem(300, '2026-11-14T00:10:00+08:00')]
  assert.ok(findTodayGrant(edge, '2026-11-14'))
})

test('小浣熊：daily_expire 也能认出来', () => {
  const items = [{ biz_type: 'daily_expire', points: 300, grant_at: `${DAY}T23:59:00+08:00` }]
  assert.ok(findTodayExpire(items, DAY))
  assert.equal(findTodayExpire(items, '2026-11-13'), null)
})

test('小浣熊：签到表归一化——已到账', () => {
  const panel = normalizeXhxPanel({
    balance: { availablePoints: 1200, userCategory: 'toc' },
    bills: [grantItem(300)],
    day: DAY,
  })
  assert.equal(panel.style, 'daily')
  assert.equal(panel.days.length, 1)
  assert.equal(panel.today.status, 3)
  assert.equal(panel.today.points, 300)
  assert.equal(panel.claimable, false)
  assert.equal(panel.claimedDays, 1)
  assert.equal(panel.accountCredits, 1200)
  assert.equal(panel.dailyGrantPoints, 300)
  assert.match(panel.description, /今天已到账/)
})

test('小浣熊：签到表归一化——还没到账', () => {
  const panel = normalizeXhxPanel({ balance: { availablePoints: 0 }, bills: [], day: DAY })
  assert.equal(panel.today.status, 2)
  assert.equal(panel.claimable, true)
  assert.equal(panel.claimedDays, 0)
  assert.match(describeXhxPanel(panel), /还没确认到账/)
  assert.equal(FREE_DAILY_POINTS, 300)
})

test('小浣熊：注册表里出现，且是固定北京时区', () => {
  const { list, meta } = createProviders()
  const p = list.find(x => x.id === 'xiaohuanxiong')
  assert.ok(p, '应该注册了 xiaohuanxiong')
  assert.equal(p.name, '商汤小浣熊')
  assert.equal(p.short, '小浣熊')
  assert.equal(p.unit, '积分')
  assert.equal(p.timeZoneMode, 'fixed')
  assert.equal(p.timeZone, 'Asia/Shanghai')
  assert.ok(meta().some(m => m.id === 'xiaohuanxiong'))
})

test('小浣熊：心跳后到账 → claimed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xhx-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    await addAccount('xiaohuanxiong', { cookie: 'xhx_token=tok', name: '主号' }, env)
    const calls = []
    const origFetch = globalThis.fetch
    let granted = false
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url).replace('https://xiaohuanxiong.com', '')
      calls.push(`${init.method || 'GET'} ${path}`)
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (path.startsWith('/api/web/points/v1/balance')) {
        return json({ code: 0, data: { available_points: granted ? 300 : 0, user_category: 'toc' } })
      }
      if (path.startsWith('/api/web/points/v2/bills')) {
        return json({ code: 0, data: { items: granted ? [grantItem(300)] : [] } })
      }
      if (path.startsWith('/api/web/auth/v1/devices_current_heartbeat')) {
        assert.equal(init.headers['x-client-device-id'].length > 0, true)
        granted = true
        return json({ code: 0, data: {} })
      }
      return json({ code: 404, message: 'not found' }, 404)
    }
    try {
      const provider = createXiaohuanxiongProvider({ env })
      const r = await provider.run({ trigger: 'manual' })
      assert.equal(r.ok, true)
      assert.equal(r.outcome, 'claimed')
      assert.equal(r.points, 300)
      assert.equal(r.provider, 'xiaohuanxiong')
      // 顺序：先 balance → bills（判定未到账）→ 心跳 → 再查 bills/balance
      assert.deepEqual(calls.slice(0, 3), [
        'GET /api/web/points/v1/balance',
        'GET /api/web/points/v2/bills?paging.limit=20&type=all',
        'POST /api/web/auth/v1/devices_current_heartbeat',
      ])
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('小浣熊：已到账就不发心跳 → already_claimed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xhx-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    await addAccount('xiaohuanxiong', { cookie: 'xhx_token=tok' }, env)
    const calls = []
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url).replace('https://xiaohuanxiong.com', '')
      calls.push(path)
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (path.startsWith('/api/web/points/v1/balance')) return json({ code: 0, data: { available_points: 300 } })
      if (path.startsWith('/api/web/points/v2/bills')) return json({ code: 0, data: { items: [grantItem(300)] } })
      return json({ code: 500 })
    }
    try {
      const r = await createXiaohuanxiongProvider({ env }).run({})
      assert.equal(r.outcome, 'already_claimed')
      assert.equal(r.points, 300)
      assert.equal(calls.some(p => p.includes('heartbeat')), false)
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('小浣熊：401 转成 needs_login（定时器不再退避重试）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xhx-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    await addAccount('xiaohuanxiong', { cookie: 'xhx_token=expired' }, env)
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      JSON.stringify({ code: 200003, message: 'authorization_verify_error' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )
    try {
      const r = await createXiaohuanxiongProvider({ env }).run({})
      assert.equal(r.ok, false)
      assert.equal(r.outcome, 'needs_login')
      assert.equal(r.provider, 'xiaohuanxiong')
      assert.match(r.message, /xhx_token/)
      // 面板读不到签到表时仍然是抛错（面板要显示原因）
      await assert.rejects(
        () => createXiaohuanxiongProvider({ env }).panel(),
        (error) => error.code === 'XHX_NEEDS_LOGIN',
      )
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('小浣熊：没配凭据时 account 明确说未配置', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xhx-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    const a = await createXiaohuanxiongProvider({ env }).account()
    assert.equal(a.loggedIn, false)
    assert.equal(a.code, 'XHX_NOT_CONFIGURED')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ── 弹出式登录（浏览器窗口 → CDP 读 cookie） ──

test('小浣熊登录：cookieHeaderFrom 只挑小浣熊域，拼成 Cookie 头', () => {
  const cookies = [
    { domain: '.xiaohuanxiong.com', name: 'xhx_token', value: 'tok-a' },
    { domain: 'xiaohuanxiong.com', name: 'i18nextLng', value: 'zh' },
    { domain: '.google.com', name: 'NID', value: 'nope' },
    { domain: '.notxiaohuanxiong.com.evil.com', name: 'x', value: 'nope' },
  ]
  const header = cookieHeaderFrom(cookies)
  assert.equal(header, 'xhx_token=tok-a; i18nextLng=zh')
  assert.equal(cookieHeaderFrom([]), '')
  assert.equal(cookieHeaderFrom(null), '')
})

test('小浣熊登录：looksLoggedIn 认新版 xhx_token 和旧版 raccoon_token', () => {
  const long = 'x'.repeat(40)
  assert.equal(looksLoggedIn(`a=1; xhx_token=${long}`), true)
  assert.equal(looksLoggedIn(`a=1; raccoon_token=${long}`), true)
  assert.equal(looksLoggedIn(`a=1; abc_raccoon_token=${long}`), true)
  // 短值 / 只有别的 cookie 不算登录成功（避免把游客 token 当成登录态）
  assert.equal(looksLoggedIn('xhx_token=short'), false)
  assert.equal(looksLoggedIn('i18nextLng=zh; INGRESSCOOKIE=abc'), false)
  assert.equal(looksLoggedIn(''), false)
})

test('小浣熊登录：chromeExecutable 在 macOS 上能找到 Chrome', () => {
  if (process.platform !== 'darwin') return
  const exe = chromeExecutable()
  assert.ok(exe === null || /Chrome|Edge|Brave|Chromium/.test(exe))
})

test('小浣熊登录：provider 暴露 loginStart / loginWait / cancelLogin', () => {
  const p = createXiaohuanxiongProvider({})
  for (const name of ['loginStart', 'loginWait', 'cancelLogin']) {
    assert.equal(typeof p[name], 'function', `${name} 应该是函数`)
  }
})

test('小浣熊登录：没有 pending 时 loginWait 明确报错（不会挂住）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xhx-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    const p = createXiaohuanxiongProvider({ env })
    await assert.rejects(() => p.loginWait({}), (error) => error.code === 'XHX_NO_PENDING_LOGIN')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('小浣熊登录：cookie 挑出来能直接当凭据用（tokenFromCookie 认自己拼的头）', () => {
  const header = cookieHeaderFrom([
    { domain: '.xiaohuanxiong.com', name: 'xhx_token', value: 'abc.def.ghi' },
  ])
  assert.equal(tokenFromCookie(header), 'abc.def.ghi')
})


// ── 等待登录的轮询逻辑（用假 client，不碰真浏览器） ──

/** 假 CDP client：按顺序吐 cookie 快照，用完就一直重复最后一个 */
function fakeClient(snapshots) {
  let i = 0
  return {
    calls: 0,
    async send(method) {
      assert.equal(method, 'Network.getAllCookies')
      this.calls += 1
      const cookies = snapshots[Math.min(i, snapshots.length - 1)]
      i += 1
      return { cookies }
    },
    close() {},
  }
}

test('小浣熊登录：游客态不算登录，等到真 token 才返回', async () => {
  const guest = [{ domain: '.xiaohuanxiong.com', name: 'raccoon_token', value: 'g'.repeat(64) }]
  const real = [{ domain: '.xiaohuanxiong.com', name: 'xhx_token', value: 'real'.repeat(20) }]
  const client = fakeClient([guest, guest, real])
  const phases = []
  const out = await waitForLogin({
    client,
    timeoutMs: 10_000,
    pollIntervalMs: 1,
    verifyRetryMs: 0,
    // 游客 token 换不出余额 → null；真 token 才给数据
    verify: async (header) => (header.includes('xhx_token=') ? { available_points: 300 } : null),
    nickname: async () => '小浣熊用户',
    onProgress: (p) => phases.push(p.phase),
  })
  assert.equal(out.name, '小浣熊用户')
  assert.equal(out.points, 300)
  assert.equal(out.token, 'real'.repeat(20))
  assert.ok(out.cookie.includes('xhx_token='))
  assert.ok(phases.includes('verifying'))
  assert.equal(phases[phases.length - 1], 'done')
})

test('小浣熊登录：验证失败会按节流重试，不会每轮都打接口', async () => {
  const guest = [{ domain: '.xiaohuanxiong.com', name: 'raccoon_token', value: 'g'.repeat(64) }]
  const client = fakeClient([guest])
  let attempts = 0
  await waitForLogin({
    client,
    timeoutMs: 120,
    pollIntervalMs: 2,
    verifyRetryMs: 1_000,   // 一次都没到 1 秒 → 只该验一次
    verify: async () => { attempts += 1; return null },
    nickname: async () => '',
  }).catch(() => {})
  assert.ok(client.calls > 5, `应该轮询了很多次，实际 ${client.calls}`)
  assert.equal(attempts, 1, `verify 应该只被调 1 次，实际 ${attempts}`)
})

test('小浣熊登录：窗口关掉时报 XHX_WINDOW_CLOSED，不会一直挂着', async () => {
  const client = { async send() { throw new Error('Target closed') }, close() {} }
  await assert.rejects(
    () => waitForLogin({ client, timeoutMs: 5_000, pollIntervalMs: 1, verify: async () => null }),
    (error) => error.code === 'XHX_WINDOW_CLOSED',
  )
})

test('小浣熊登录：取消信号能立刻中止等待', async () => {
  const controller = new AbortController()
  const client = fakeClient([[{ domain: '.xiaohuanxiong.com', name: 'other', value: '1' }]])
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(
    () => waitForLogin({ client, timeoutMs: 30_000, pollIntervalMs: 1, signal: controller.signal }),
    (error) => error.code === 'XHX_LOGIN_ABORTED',
  )
})

test('小浣熊登录：一直没登录就超时', async () => {
  const client = fakeClient([[{ domain: '.xiaohuanxiong.com', name: 'other', value: '1' }]])
  await assert.rejects(
    () => waitForLogin({ client, timeoutMs: 60, pollIntervalMs: 5, verify: async () => null }),
    (error) => error.code === 'XHX_LOGIN_TIMEOUT',
  )
})

test('小浣熊登录：拿到 token 后写进凭据、同一个号重复登录不重复建号', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xhx-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    let round = 0
    const loginRun = async () => {
      round += 1
      return { cookie: `xhx_token=tok-${'x'.repeat(40)}`, token: `tok-${'x'.repeat(40)}`, name: '小浣熊主号', points: 300 }
    }
    const p = createXiaohuanxiongProvider({ env, loginRun })

    const first = await p.loginStart({})
    assert.equal(first.mode, 'browser-window')
    assert.equal(first.userCode, '')
    const r1 = await p.loginWait({})
    assert.equal(r1.ok, true)
    assert.equal(r1.account, '小浣熊主号')
    assert.equal(r1.points, 300)

    // 同一次登录只能认领一次，再问就是「没有正在进行的登录」
    await assert.rejects(() => p.loginWait({}), (e) => e.code === 'XHX_NO_PENDING_LOGIN')

    // 同一个 token 再登一次 → 还是 1 个账号（覆盖，不新增）
    await p.loginStart({})
    await p.loginWait({})
    const list = await listAccounts('xiaohuanxiong', env)
    assert.equal(list.length, 1, `应该只有 1 个账号，实际 ${list.length}`)
    assert.equal(list[0].name, '小浣熊主号')
    assert.ok(list[0].cookie.includes('xhx_token='))
    assert.equal(round, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('小浣熊登录：浏览器启动失败时 loginWait 把错误抛给面板', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xhx-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    const loginRun = async () => {
      throw Object.assign(new Error('浏览器没能启动调试端口'), { code: 'XHX_CDP_UNREACHABLE' })
    }
    const p = createXiaohuanxiongProvider({ env, loginRun })
    await p.loginStart({})
    await assert.rejects(() => p.loginWait({}), (e) => e.code === 'XHX_CDP_UNREACHABLE')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('小浣熊登录：轮询模式下「还没好」返回 pending，不是失败', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xhx-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const loginRun = async () => { await gate; return { cookie: 'xhx_token=' + 'y'.repeat(40), token: 'y'.repeat(40), name: '慢号' } }
    const p = createXiaohuanxiongProvider({ env, loginRun })
    await p.loginStart({})
    const r = await p.loginWait({ poll: true, timeoutMs: 120 })
    assert.equal(r.ok, false)
    assert.equal(r.pending, true)
    assert.equal(r.code, 'XHX_STILL_WAITING')
    // 用户后来登上了 → 下一轮轮询拿到成功
    release()
    const ok = await p.loginWait({ poll: true, timeoutMs: 5000 })
    assert.equal(ok.ok, true)
    assert.equal(ok.account, '慢号')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('小浣熊登录：轮询到窗口关闭立刻报错（不会挂到超时）', async () => {
  // 用户点窗口右上角关闭 → CDP socket 静默断开。waitForLogin 必须马上知道，
  // 不能等 5 分钟超时（那就是「卡住」的体感）。
  let closed = false
  const client = {
    async send() {
      if (closed) throw Object.assign(new Error('登录窗口被关掉了'), { code: 'XHX_WINDOW_CLOSED' })
      return { cookies: [{ domain: '.xiaohuanxiong.com', name: 'other', value: '1' }] }
    },
    close() {},
  }
  const p = waitForLogin({ client, timeoutMs: 30_000, pollIntervalMs: 5, verify: async () => null })
  setTimeout(() => { closed = true }, 20)
  const started = Date.now()
  await assert.rejects(p, (error) => error.code === 'XHX_WINDOW_CLOSED')
  assert.ok(Date.now() - started < 3_000, '应该在窗口关掉后马上返回')
})
