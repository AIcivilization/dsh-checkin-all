// test/teleagent.test.js — 天翼 AI（TeleAgent）：Cookie 解析、签到表归一化、签到流程（mock fetch）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  authOf, tokenFromCookie, claimPathOf, statusOf, claimableOf,
  normalizeTaPanel, describeTaPanel, createTeleagentProvider, WEB_PREFIX, DESKTOP_PREFIX,
} from '../lib/providers/teleagent.js'
import {
  cookieHeaderFrom, looksLoggedIn, tokenFromSnapshot, chromeExecutable, waitForLogin,
} from '../lib/providers/teleagent-login.js'
import { addAccount, listAccounts } from '../lib/checkin-secrets.js'

const DAY = '2026-11-14'
const ORIGIN = 'https://agent.teleai.com.cn'

function activity(over = {}) {
  return {
    visible: true,
    is_main_activity: true,
    action_status: 'incomplete',
    action_text: '未领取',
    action_type: 'api',
    activity_title: '每日签到',
    activity_subtitle: '每天领一次',
    jump_url: `${ORIGIN}/superCowork/sapi/user/portal/companyStore/claimDaily?task=daily_login`,
    points_amount: 20,
    ...over,
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('TeleAgent：从整条 Cookie 里取 operationToken', () => {
  const cookie = 'a=1; operationToken=abc.def.ghi; b=2'
  assert.equal(tokenFromCookie(cookie), 'abc.def.ghi')
  assert.deepEqual(authOf({ cookie }), { cookie, token: 'abc.def.ghi' })
})

test('TeleAgent：operToken / X-Token 也认', () => {
  assert.equal(tokenFromCookie('operToken=tok-1'), 'tok-1')
  assert.equal(tokenFromCookie('X-Token=tok-2'), 'tok-2')
  assert.equal(tokenFromCookie('nothing=1'), undefined)
})

test('TeleAgent：只给裸 token 时同时塞进 cookie 和 X-Token', () => {
  const auth = authOf({ token: 'tok123' })
  assert.equal(auth.token, 'tok123')
  assert.equal(auth.cookie, 'operationToken=tok123')
})

test('TeleAgent：Bearer 前缀会被去掉', () => {
  assert.equal(authOf({ token: 'Bearer abc' }).token, 'abc')
})

test('TeleAgent：领取地址就是 jump_url 去掉 /superCowork/sapi', () => {
  assert.equal(
    claimPathOf(`${ORIGIN}/superCowork/sapi/user/portal/companyStore/claimDaily?task=daily_login`),
    '/user/portal/companyStore/claimDaily?task=daily_login',
  )
  assert.equal(claimPathOf('/user/portal/x'), '/user/portal/x')
  assert.equal(claimPathOf('user/portal/x'), '/user/portal/x')
  assert.equal(claimPathOf(''), '')
})

test('TeleAgent：活动状态归一化', () => {
  assert.equal(statusOf({ action_status: 'incomplete' }), 'claimable')
  assert.equal(statusOf({ action_status: 'not_joined' }), 'claimable')
  assert.equal(statusOf({ action_status: 'fixed' }), 'claimable')
  assert.equal(statusOf({ action_status: 'completed' }), 'claimed')
  assert.equal(statusOf({ claimed: true }), 'claimed')
  // 只给文案时的兜底
  assert.equal(statusOf({ action_text: '今日已领' }), 'claimed')
  assert.equal(statusOf({ action_text: '立即领取' }), 'claimable')
  assert.equal(statusOf({}), 'other')
})

test('TeleAgent：可领的只挑「非跳转、状态可领、有领取地址」的', () => {
  const list = [
    activity(),
    activity({ action_status: 'completed', jump_url: `${ORIGIN}/superCowork/sapi/x` }),
    activity({ action_type: 'web' }),
    activity({ visible: false }),
    activity({ jump_url: '' }),
  ]
  const picked = claimableOf(list)
  assert.equal(picked.length, 1)
  assert.equal(picked[0].activity_title, '每日签到')
})

test('TeleAgent：签到表归一化成「今天一格」', () => {
  const panel = normalizeTaPanel({
    userCenter: { current_points_balance: 1280 },
    dayTask: { activities: [activity()] },
    day: DAY,
  })
  assert.equal(panel.style, 'daily')
  assert.equal(panel.days.length, 1)
  assert.equal(panel.days[0].isToday, true)
  assert.equal(panel.days[0].status, 2)
  assert.equal(panel.claimable, true)
  assert.equal(panel.claimableCount, 1)
  assert.equal(panel.expectedPoints, 20)
  assert.equal(panel.accountCredits, 1280)
  assert.match(describeTaPanel(panel), /还有 1 个奖励没领/)
})

test('TeleAgent：全领完了 → 已领状态 + 累计', () => {
  const panel = normalizeTaPanel({
    userCenter: { current_points_balance: 1300 },
    dayTask: { activities: [activity({ action_status: 'completed' })] },
    day: DAY,
  })
  assert.equal(panel.claimable, false)
  assert.equal(panel.days[0].status, 3)
  assert.equal(panel.claimedDays, 1)
  assert.equal(panel.accountCredits, 1300)
  assert.match(describeTaPanel(panel), /已领完/)
})

test('TeleAgent：没有活动时不报「可领」', () => {
  const panel = normalizeTaPanel({ userCenter: {}, dayTask: { activities: [] }, day: DAY })
  assert.equal(panel.claimable, false)
  assert.equal(panel.activityCount, 0)
  assert.match(describeTaPanel(panel), /没有可领/)
})

test('TeleAgent：签到成功 → claimed，并且真的调了领取地址', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ta-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    await addAccount('teleagent', { cookie: 'operationToken=tok' }, env)
    let claimed = false
    const calls = []
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url).replace(ORIGIN, '')
      calls.push(`${init.method || 'GET'} ${path}`)
      if (path.endsWith('/companyStore/userCenter')) {
        return jsonResponse({ code: 0, data: { current_points_balance: claimed ? 1320 : 1300 } })
      }
      if (path.includes('/companyStore/v3/checkDayTask')) {
        return jsonResponse({
          code: 0,
          data: { brand_title: '积分福利社', activity_data: [activity({ action_status: claimed ? 'completed' : 'incomplete' })] },
        })
      }
      if (path.includes('/companyStore/claimDaily')) {
        claimed = true
        return jsonResponse({ code: 0, data: { points: 20 } })
      }
      if (path.includes('/companyStore/checkTask')) return jsonResponse({ code: 0, data: [] })
      return jsonResponse({ code: 404, message: 'not found' }, 404)
    }
    try {
      const r = await createTeleagentProvider({ env }).run({ trigger: 'manual' })
      assert.equal(r.ok, true)
      assert.equal(r.outcome, 'claimed')
      assert.equal(r.provider, 'teleagent')
      assert.equal(r.points, 20)
      assert.match(r.message, /每日签到/)
      assert.ok(calls.some(c => c.includes('/companyStore/claimDaily')), '应该调过领取地址')
      // 第一个请求走 web 前缀
      assert.ok(calls[0].includes(WEB_PREFIX), `第一个请求应该用 web 前缀，实际 ${calls[0]}`)
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('TeleAgent：已领完就不发领取请求 → already_claimed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ta-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    await addAccount('teleagent', { cookie: 'operationToken=tok' }, env)
    const calls = []
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const path = String(url).replace(ORIGIN, '')
      calls.push(path)
      if (path.endsWith('/companyStore/userCenter')) return jsonResponse({ code: 0, data: { current_points_balance: 1320 } })
      if (path.includes('/companyStore/v3/checkDayTask')) {
        return jsonResponse({ code: 0, data: { activity_data: [activity({ action_status: 'completed' })] } })
      }
      if (path.includes('/companyStore/checkTask')) return jsonResponse({ code: 0, data: [] })
      return jsonResponse({ code: 0, data: {} })
    }
    try {
      const r = await createTeleagentProvider({ env }).run({})
      assert.equal(r.outcome, 'already_claimed')
      assert.equal(calls.some(p => p.includes('claimDaily')), false)
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('TeleAgent：dry-run 只读不领', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ta-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    await addAccount('teleagent', { cookie: 'operationToken=tok' }, env)
    const calls = []
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const path = String(url).replace(ORIGIN, '')
      calls.push(path)
      if (path.endsWith('/companyStore/userCenter')) return jsonResponse({ code: 0, data: { current_points_balance: 1300 } })
      if (path.includes('/companyStore/v3/checkDayTask')) {
        return jsonResponse({ code: 0, data: { activity_data: [activity()] } })
      }
      return jsonResponse({ code: 0, data: {} })
    }
    try {
      const r = await createTeleagentProvider({ env }).run({ dryRun: true })
      assert.equal(r.outcome, 'dry-run')
      assert.equal(calls.some(p => p.includes('claimDaily')), false)
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('TeleAgent：401 转成 needs_login（定时器不再退避重试）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ta-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    await addAccount('teleagent', { cookie: 'operationToken=expired' }, env)
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => jsonResponse(
      { code: '4001', message: 'UserInfo JWT 解析失败', data: 'https://www.teleai.com.cn/login' },
      401,
    )
    try {
      const r = await createTeleagentProvider({ env }).run({})
      assert.equal(r.ok, false)
      assert.equal(r.outcome, 'needs_login')
      assert.equal(r.provider, 'teleagent')
      assert.match(r.message, /operationToken/)
      // 面板读不到签到表时仍然是抛错（面板要显示原因）
      await assert.rejects(
        () => createTeleagentProvider({ env }).panel(),
        (error) => error.code === 'TA_NEEDS_LOGIN',
      )
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('TeleAgent：web 前缀不通时退回桌面端前缀', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ta-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    await addAccount('teleagent', { cookie: 'operationToken=tok' }, env)
    const calls = []
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const path = String(url).replace(ORIGIN, '')
      calls.push(path)
      // web 前缀回 HTML（SPA 壳），桌面端前缀才回 JSON
      if (path.startsWith(WEB_PREFIX)) return new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      if (path.startsWith(DESKTOP_PREFIX) && path.endsWith('/companyStore/userCenter')) {
        return jsonResponse({ code: 0, data: { current_points_balance: 900 } })
      }
      if (path.includes('/companyStore/v3/checkDayTask')) {
        return jsonResponse({ code: 0, data: { activity_data: [activity({ action_status: 'completed' })] } })
      }
      return jsonResponse({ code: 0, data: [] })
    }
    try {
      const panel = await createTeleagentProvider({ env }).panel()
      assert.equal(panel.accountCredits, 900)
      assert.ok(calls.some(p => p.startsWith(DESKTOP_PREFIX)), '应该退回桌面端前缀')
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('TeleAgent：没配凭据时 account 明确说未配置', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ta-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    const a = await createTeleagentProvider({ env }).account()
    assert.equal(a.loggedIn, false)
    assert.equal(a.code, 'TA_NOT_CONFIGURED')
    await assert.rejects(
      () => createTeleagentProvider({ env }).run({}),
      (error) => error.code === 'TA_NOT_CONFIGURED',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('TeleAgent：多账号逐个签，汇总成一条结果', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ta-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    await addAccount('teleagent', { cookie: 'operationToken=tok-a', name: 'A 号' }, env)
    await addAccount('teleagent', { cookie: 'operationToken=tok-b', name: 'B 号' }, env)
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url).replace(ORIGIN, '')
      const token = (init.headers && (init.headers['x-token'] || init.headers['X-Token'])) || ''
      if (path.endsWith('/companyStore/userCenter')) {
        return jsonResponse({ code: 0, data: { current_points_balance: token === 'tok-a' ? 100 : 200 } })
      }
      if (path.includes('/companyStore/v3/checkDayTask')) {
        return jsonResponse({ code: 0, data: { activity_data: [activity({ action_status: 'completed' })] } })
      }
      return jsonResponse({ code: 0, data: [] })
    }
    try {
      const r = await createTeleagentProvider({ env }).run({})
      assert.equal(r.provider, 'teleagent')
      assert.equal(r.accounts, 2)
      assert.match(r.message, /A 号/)
      assert.match(r.message, /B 号/)
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ── 弹出式登录（浏览器窗口 → CDP 读 cookie / localStorage） ──

test('TeleAgent：cookieHeaderFrom 只挑 teleai 域，拼成 Cookie 头', () => {
  const cookies = [
    { domain: '.teleai.com.cn', name: 'operationToken', value: 'tok-a' },
    { domain: 'agent.teleai.com.cn', name: 'i18nextLng', value: 'zh' },
    { domain: '.google.com', name: 'NID', value: 'nope' },
    { domain: '.notteleai.com.cn.evil.com', name: 'x', value: 'nope' },
  ]
  assert.equal(cookieHeaderFrom(cookies), 'operationToken=tok-a; i18nextLng=zh')
  assert.equal(cookieHeaderFrom([]), '')
  assert.equal(cookieHeaderFrom(null), '')
})

test('TeleAgent：looksLoggedIn 认 operationToken，短值不算', () => {
  const long = 'x'.repeat(40)
  assert.equal(looksLoggedIn(`a=1; operationToken=${long}`), true)
  assert.equal(looksLoggedIn(`a=1; operToken=${long}`), true)
  assert.equal(looksLoggedIn('operationToken=short'), false)
  assert.equal(looksLoggedIn('i18nextLng=zh'), false)
  assert.equal(looksLoggedIn(''), false)
})

test('TeleAgent：tokenFromSnapshot 先 cookie 后 localStorage', () => {
  const long = 'c'.repeat(40)
  assert.equal(tokenFromSnapshot({ cookies: [{ domain: '.teleai.com.cn', name: 'operationToken', value: long }] }), long)
  assert.equal(tokenFromSnapshot({ cookies: [], storage: { user_token: long } }), long)
  assert.equal(tokenFromSnapshot({ cookies: [], storage: { sso_token: long } }), long)
  assert.equal(tokenFromSnapshot({ cookies: [], storage: {} }), '')
})

test('TeleAgent：chromeExecutable 在 macOS 上能找到 Chrome', () => {
  if (process.platform !== 'darwin') return
  const exe = chromeExecutable()
  assert.ok(exe === null || /Chrome|Edge|Brave|Chromium/.test(exe))
})

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

test('TeleAgent 登录：游客态不算登录，等到真 token 才返回', async () => {
  const guest = [{ domain: '.teleai.com.cn', name: 'i18nextLng', value: 'zh' }]
  const real = [{ domain: '.teleai.com.cn', name: 'operationToken', value: 'real'.repeat(20) }]
  const client = fakeClient([guest, guest, real])
  const phases = []
  const out = await waitForLogin({
    client,
    timeoutMs: 10_000,
    pollIntervalMs: 1,
    verifyRetryMs: 0,
    verify: async (token) => (token.startsWith('real') ? { current_points_balance: 520 } : null),
    onProgress: (p) => phases.push(p.phase),
  })
  assert.equal(out.token, 'real'.repeat(20))
  assert.equal(out.points, 520)
  assert.ok(phases.includes('verifying'))
  assert.equal(phases[phases.length - 1], 'done')
})

test('TeleAgent 登录：窗口关掉时报 TA_WINDOW_CLOSED，不会一直挂着', async () => {
  const client = { async send() { throw new Error('Target closed') }, close() {} }
  await assert.rejects(
    () => waitForLogin({ client, timeoutMs: 5_000, pollIntervalMs: 1, verify: async () => null }),
    (error) => error.code === 'TA_WINDOW_CLOSED',
  )
})

test('TeleAgent 登录：取消信号能立刻中止等待', async () => {
  const controller = new AbortController()
  const client = fakeClient([[{ domain: '.teleai.com.cn', name: 'other', value: '1' }]])
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(
    () => waitForLogin({ client, timeoutMs: 30_000, pollIntervalMs: 1, signal: controller.signal }),
    (error) => error.code === 'TA_LOGIN_ABORTED',
  )
})

test('TeleAgent 登录：一直没登录就超时', async () => {
  const client = fakeClient([[{ domain: '.teleai.com.cn', name: 'other', value: '1' }]])
  await assert.rejects(
    () => waitForLogin({ client, timeoutMs: 60, pollIntervalMs: 5, verify: async () => null }),
    (error) => error.code === 'TA_LOGIN_TIMEOUT',
  )
})

test('TeleAgent 登录：没有 pending 时 loginWait 明确报错（不会挂住）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ta-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    const p = createTeleagentProvider({ env })
    await assert.rejects(() => p.loginWait({}), (error) => error.code === 'TA_NO_PENDING_LOGIN')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('TeleAgent 登录：拿到 token 后写进凭据、同一个号重复登录不重复建号', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ta-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    let round = 0
    const loginRun = async () => {
      round += 1
      return {
        cookie: `operationToken=tok-${'x'.repeat(40)}`,
        token: `tok-${'x'.repeat(40)}`,
        name: '天翼主号',
        points: 520,
      }
    }
    const p = createTeleagentProvider({ env, loginRun })

    const first = await p.loginStart({})
    assert.equal(first.mode, 'browser-window')
    assert.equal(first.userCode, '')
    const r1 = await p.loginWait({})
    assert.equal(r1.ok, true)
    assert.equal(r1.account, '天翼主号')
    assert.equal(r1.points, 520)

    await assert.rejects(() => p.loginWait({}), (e) => e.code === 'TA_NO_PENDING_LOGIN')

    await p.loginStart({})
    await p.loginWait({})
    const list = await listAccounts('teleagent', env)
    assert.equal(list.length, 1, `应该只有 1 个账号，实际 ${list.length}`)
    assert.equal(list[0].name, '天翼主号')
    assert.ok(list[0].cookie.includes('operationToken='))
    assert.equal(round, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('TeleAgent 登录：浏览器启动失败时 loginWait 把错误抛给面板', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ta-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    const loginRun = async () => {
      throw Object.assign(new Error('浏览器没能启动调试端口'), { code: 'TA_CDP_UNREACHABLE' })
    }
    const p = createTeleagentProvider({ env, loginRun })
    await p.loginStart({})
    await assert.rejects(() => p.loginWait({}), (e) => e.code === 'TA_CDP_UNREACHABLE')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('TeleAgent 登录：轮询模式下「还没好」返回 pending，不是失败', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ta-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  try {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const loginRun = async () => {
      await gate
      return { cookie: `operationToken=${'y'.repeat(40)}`, token: 'y'.repeat(40), name: '慢号' }
    }
    const p = createTeleagentProvider({ env, loginRun })
    await p.loginStart({})
    const r = await p.loginWait({ poll: true, timeoutMs: 120 })
    assert.equal(r.ok, false)
    assert.equal(r.pending, true)
    assert.equal(r.code, 'TA_STILL_WAITING')
    release()
    const ok = await p.loginWait({ poll: true, timeoutMs: 5000 })
    assert.equal(ok.ok, true)
    assert.equal(ok.account, '慢号')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
