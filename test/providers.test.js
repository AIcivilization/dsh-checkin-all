import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  beijingDayKey, normalizeLingxiPanel, describeLingxiPanel, pickDailyTask, LINGXI_TZ,
} from '../lib/providers/lingxi.js'
import { createProviders } from '../lib/providers/index.js'
import { providerConfig, recordAttempt, loadState, claimedToday, DEFAULT_CONFIG } from '../lib/store.js'

const lingxiTask = {
  task_key: 'daily_check_in',
  type: 'daily',
  title: '每日签到',
  reward_amount: 100,
  status: 'claimed',
  extra: {
    check_in_days: [
      { day: 1, date: '2026-11-02', reward: 100, status: 'claimed' },
      { day: 2, date: '2026-11-03', reward: 100, status: 'locked' },
      { day: 3, date: '2026-11-04', reward: 100, status: 'locked' },
      { day: 4, date: '2026-11-05', reward: 100, status: 'locked' },
      { day: 5, date: '2026-11-06', reward: 100, status: 'locked' },
      { day: 6, date: '2026-11-07', reward: 100, status: 'locked' },
      { day: 7, date: '2026-11-08', reward: 200, status: 'locked' },
    ],
    consecutive_days: 1,
    today_day: 1,
    today_reward: 100,
  },
}

test('灵犀按北京时间算「今天」，不是本机时区', () => {
  // 美西 11-01 19:20 = 北京 11-02 11:20
  const d = new Date('2026-11-02T03:20:00Z')
  assert.equal(beijingDayKey(d), '2026-11-02')
  // 同一时刻按美西算是 11-01
  assert.notEqual(beijingDayKey(d), '2026-11-01')
  assert.equal(LINGXI_TZ, 'Asia/Shanghai')
})

test('灵犀签到表归一化：状态映射、今天、本周、账户累计', () => {
  const panel = normalizeLingxiPanel(lingxiTask, 7000)
  assert.equal(panel.days.length, 7)
  assert.equal(panel.today.dayNo, 1)
  assert.equal(panel.today.status, 3)
  assert.equal(panel.claimable, false)
  assert.equal(panel.claimedDays, 1)
  // 本周只算这一周表里已领的（100），不是账户累计
  assert.equal(panel.totalPoints, 100)
  assert.equal(panel.accountCredits, 7000)
  assert.equal(panel.consecutiveDays, 1)
})

test('灵犀 status=claimable 时今天标成可领', () => {
  const task = {
    ...lingxiTask,
    status: 'claimable',
    extra: {
      ...lingxiTask.extra,
      check_in_days: lingxiTask.extra.check_in_days.map(d => ({ ...d, status: d.day === 1 ? 'locked' : d.status })),
    },
  }
  const panel = normalizeLingxiPanel(task, 7000)
  assert.equal(panel.claimable, true)
  assert.equal(panel.today.status, 2)
  assert.match(describeLingxiPanel(panel), /可以领/)
})

test('灵犀已签的说法', () => {
  const panel = normalizeLingxiPanel(lingxiTask, 7000)
  assert.match(describeLingxiPanel(panel), /已经签过了/)
})

test('灵犀从任务列表里挑出签到任务', () => {
  const tasks = [{ task_key: 'other' }, lingxiTask]
  assert.equal(pickDailyTask(tasks), lingxiTask)
  assert.equal(pickDailyTask([]), null)
  assert.equal(pickDailyTask(null), null)
})

test('注册表里有四个服务，元信息齐全', () => {
  const providers = createProviders({ log: () => {} })
  assert.deepEqual(providers.ids(), ['minimax', 'lingxi', 'dumate', 'astudio'])
  const meta = providers.meta()
  assert.equal(meta.length, 4)
  const lingxi = meta.find(m => m.id === 'lingxi')
  assert.equal(lingxi.name, 'WPS 灵犀')
  assert.equal(lingxi.timeZoneMode, 'fixed')
  assert.equal(lingxi.unit, '智点')
  const minimax = meta.find(m => m.id === 'minimax')
  assert.equal(minimax.timeZoneMode, 'local')
  assert.equal(minimax.unit, '分')
  const dumate = meta.find(m => m.id === 'dumate')
  assert.equal(dumate.name, '百度 DuMate')
  assert.equal(dumate.timeZoneMode, 'fixed')
  assert.equal(dumate.unit, '积分')
  const astudio = meta.find(m => m.id === 'astudio')
  assert.equal(astudio.name, 'AStudio')
  assert.equal(astudio.timeZoneMode, 'fixed')
  assert.equal(astudio.timeZone, 'Asia/Shanghai')
  assert.equal(astudio.unit, '积分')
})

test('每个服务单独设置：没写就跟全局', () => {
  const cfg = { ...DEFAULT_CONFIG, enabled: true, time: '09:00', providers: { lingxi: { enabled: false, time: '08:30' } } }
  const lingxi = providerConfig(cfg, 'lingxi')
  assert.equal(lingxi.enabled, false)
  assert.equal(lingxi.time, '08:30')
  // minimax 没单独设置 → 跟全局
  const minimax = providerConfig(cfg, 'minimax')
  assert.equal(minimax.enabled, true)
  assert.equal(minimax.time, '09:00')
})

test('两个服务分别记账，互不干扰', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-p-'))
  const env = { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: join(dir, 'plugin') }
  try {
    await recordAttempt('minimax', {
      ok: true, outcome: 'claimed', points: 1000, dayNo: 4, day: '2026-11-01', timeZone: '',
    }, env)
    await recordAttempt('lingxi', {
      ok: true, outcome: 'claimed', points: 100, dayNo: 1, day: '2026-11-02', timeZone: LINGXI_TZ,
    }, env)

    const st = await loadState(env)
    assert.equal(st.version, 2)
    assert.equal(st.providers.minimax.totalPoints, 1000)
    assert.equal(st.providers.lingxi.totalPoints, 100)
    assert.equal(st.providers.minimax.days['2026-11-01'].points, 1000)
    assert.equal(st.providers.lingxi.days['2026-11-02'].points, 100)
    // minimax 的 day 是写死的 11-01，只有今天正好是那天才算「今天签过」
    const today = new Date()
    const pad = n => String(n).padStart(2, '0')
    const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
    assert.equal(claimedToday(st, 'minimax', ''), todayKey === '2026-11-01')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('老的单服务 state.json 自动迁移成 minimax', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-m-'))
  const home = join(dir, 'plugin')
  const env = { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: home }
  try {
    await mkdir(home, { recursive: true })
    // 老格式：days/streak 在顶层
    await writeFile(join(home, 'state.json'), JSON.stringify({
      version: 1,
      lastAttempt: { at: '2026-11-01T00:00:00.000Z', day: '2026-11-01', ok: true, outcome: 'claimed', points: 1000, message: 'ok' },
      lastClaim: { at: '2026-11-01T00:00:00.000Z', day: '2026-11-01', ok: true, outcome: 'claimed', points: 1000, message: 'ok' },
      days: { '2026-11-01': { day: '2026-11-01', outcome: 'claimed', points: 1000, dayNo: 4 } },
      streak: 5,
      totalPoints: 3200,
    }))
    const st = await loadState(env)
    assert.equal(st.version, 2)
    assert.equal(st.providers.minimax.streak, 5)
    assert.equal(st.providers.minimax.totalPoints, 3200)
    assert.equal(st.providers.minimax.days['2026-11-01'].points, 1000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── VPS 部署相关：凭据换目录、只读模式 ──

import { pickRecord, usableCredential, CredentialError } from '../lib/credentials.js'
import { credentialKey, CLIENT_ID } from '../lib/paths.js'
import { isReadOnly } from '../lib/providers/base.js'

test('凭据 key 依赖绝对路径：换目录后靠 service 前缀兜底', () => {
  const records = {}
  // 模拟：在 /Users/wf/.minimax/auth 下登录写的记录
  const localKey = `com.minimax.mcode.oauth.prod.en\0AAA`
  records[localKey] = { accessToken: 'mmoat_x', generation: 5 }

  // 同一个文件拷到 VPS（authHome 不同），算出来的 key 对不上
  const picked = pickRecord(records, 'prod', 'en', '/root/.minimax/auth')
  assert.ok(picked, '应该靠前缀兜底找到')
  assert.equal(picked.matched, 'prefix')
  assert.equal(picked.raw.accessToken, 'mmoat_x')
  assert.equal(picked.key, localKey)
})

test('多个候选记录时取 generation 最大的', () => {
  const records = {
    'com.minimax.mcode.oauth.prod.en\0OLD': { accessToken: 'old', generation: 3 },
    'com.minimax.mcode.oauth.prod.en\0NEW': { accessToken: 'new', generation: 9 },
  }
  const picked = pickRecord(records, 'prod', 'en', '/elsewhere')
  assert.equal(picked.raw.accessToken, 'new')
})

test('不同 region 的记录不会串', () => {
  const records = {
    'com.minimax.mcode.oauth.prod.en\0A': { accessToken: 'en-token', generation: 1 },
    'com.minimax.mcode.oauth.prod.cn\0B': { accessToken: 'cn-token', generation: 9 },
  }
  assert.equal(pickRecord(records, 'prod', 'en', '/x').raw.accessToken, 'en-token')
  assert.equal(pickRecord(records, 'prod', 'cn', '/x').raw.accessToken, 'cn-token')
})

test('没有记录时返回 null', () => {
  assert.equal(pickRecord({}, 'prod', 'en', '/x'), null)
})

test('只读模式：凭据还有效就照用，不动 refresh token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-ro-'))
  const ns = { buildEnv: 'prod', region: 'en', authHome: join(dir, 'auth') }
  const home = join(dir, 'auth', 'prod', 'en', 'mcode-public')
  await mkdir(home, { recursive: true, mode: 0o700 })
  const key = credentialKey('prod', 'en', ns.authHome)
  const original = {
    schemaVersion: 1, accessToken: 'mmoat_valid', refreshToken: 'mmort_must_not_change',
    tokenType: 'Bearer', clientId: CLIENT_ID, scopes: ['agent.default'],
    audience: 'agent-backend', expiresAtMs: Date.now() + 3_600_000, generation: 1,
  }
  await writeFile(join(home, 'auth.json'), JSON.stringify({ schemaVersion: 1, records: { [key]: original } }))
  ns.credentialPath = join(home, 'auth.json')
  ns.statePath = join(home, 'auth-state.json')
  ns.lockPath = join(home, 'auth.lock')

  const { credential, refreshed } = await usableCredential(ns, { readOnly: true })
  assert.equal(refreshed, false)
  assert.equal(credential.accessToken, 'mmoat_valid')
  // 文件没被改写
  const after = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))
  assert.equal(after.records[key].refreshToken, 'mmort_must_not_change')

  await rm(dir, { recursive: true, force: true })
})

test('只读模式：凭据过期就报 AUTH_READONLY_EXPIRED，不去刷新', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-ro2-'))
  const ns = { buildEnv: 'prod', region: 'en', authHome: join(dir, 'auth') }
  const home = join(dir, 'auth', 'prod', 'en', 'mcode-public')
  await mkdir(home, { recursive: true, mode: 0o700 })
  const key = credentialKey('prod', 'en', ns.authHome)
  await writeFile(join(home, 'auth.json'), JSON.stringify({
    schemaVersion: 1,
    records: {
      [key]: {
        schemaVersion: 1, accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer',
        clientId: CLIENT_ID, scopes: ['agent.default'], audience: 'agent-backend',
        expiresAtMs: 1000, generation: 1,
      },
    },
  }))
  ns.credentialPath = join(home, 'auth.json')
  ns.statePath = join(home, 'auth-state.json')
  ns.lockPath = join(home, 'auth.lock')

  await assert.rejects(() => usableCredential(ns, { readOnly: true }), (error) => {
    assert.ok(error instanceof CredentialError)
    assert.equal(error.code, 'AUTH_READONLY_EXPIRED')
    return true
  })
  await rm(dir, { recursive: true, force: true })
})

test('isReadOnly 认几种写法', () => {
  assert.equal(isReadOnly({ DSH_CHECKIN_ALL_READONLY: '1' }), true)
  assert.equal(isReadOnly({ DSH_CHECKIN_ALL_READONLY: 'true' }), true)
  assert.equal(isReadOnly({ DSH_CHECKIN_ALL_READONLY: 'YES' }), true)
  assert.equal(isReadOnly({ DSH_CHECKIN_ALL_READONLY: '0' }), false)
  assert.equal(isReadOnly({}), false)
})

// ── DuMate（百度搭子）：cookie 解密、csrftoken、连续天数 ──

import {
  normalizeDumatePanel, countStreak, describeDumatePanel, beijingDayKey as dumateDayKey,
  cookiesForHost, csrfToken, decryptCookies, DUMATE_TZ,
} from '../lib/providers/dumate.js'
import { createCipheriv, randomBytes } from 'node:crypto'

test('DuMate 也按北京时间算日期', () => {
  const d = new Date('2026-11-02T03:20:00Z')
  assert.equal(dumateDayKey(d), '2026-11-02')
  assert.equal(DUMATE_TZ, 'Asia/Shanghai')
})

test('DuMate cookie 按域名过滤（和 App 的 buildCookieHeader 一致）', () => {
  const cookies = [
    { name: 'a', value: '1', domain: '.baidu.com' },
    { name: 'b', value: '2', domain: '.bce.baidu.com' },
    { name: 'c', value: '3', domain: 'other.com' },
    { name: 'd', value: '4', domain: '' },
  ]
  const matched = cookiesForHost(cookies, 'console.bce.baidu.com')
  const names = matched.map(c => c.name)
  assert.ok(names.includes('a'), '.baidu.com 应匹配')
  assert.ok(names.includes('b'), '.bce.baidu.com 应匹配')
  assert.ok(names.includes('d'), '空 domain 应匹配')
  assert.ok(!names.includes('c'), 'other.com 不该匹配')
})

test('csrftoken 来自 bce-user-info 且去掉引号', () => {
  const cookies = [
    { name: 'bce-user-info', value: '"2026-10-29T10:14:52Z|abc"', domain: '.bce.baidu.com' },
  ]
  assert.equal(csrfToken(cookies, 'console.bce.baidu.com'), '2026-10-29T10:14:52Z|abc')
  // 没有就返回空串
  assert.equal(csrfToken([], 'console.bce.baidu.com'), '')
})

test('DuMate cookie 能用 AES-256-GCM 解开（格式 iv||tag||ciphertext）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-dm-'))
  try {
    const key = randomBytes(32)
    const cookies = [{ name: 'bce-user-info', value: 'x', domain: '.bce.baidu.com' }]
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const enc = Buffer.concat([cipher.update(JSON.stringify(cookies), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const encoded = Buffer.concat([iv, tag, enc]).toString('base64')

    await writeFile(join(dir, '.cookie-key'), key)
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ cookies: encoded }))

    const out = await decryptCookies({ ...process.env, DUMATE_DATA_DIR: dir })
    assert.equal(out.length, 1)
    assert.equal(out[0].name, 'bce-user-info')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('DuMate 签到表归一化：已签 / 可签', () => {
  const now = new Date('2026-11-02T03:20:00Z') // 北京 11-02
  const issued = normalizeDumatePanel({ hasIssued: true, totalTimes: 2, totalPoints: 1000, signInDays: ['2026-11-01', '2026-11-02'] }, now)
  assert.equal(issued.today.date, '2026-11-02')
  assert.equal(issued.today.status, 3)
  assert.equal(issued.claimable, false)
  assert.equal(issued.consecutiveDays, 2)
  assert.match(describeDumatePanel(issued), /已经签过了/)

  const pending = normalizeDumatePanel({ hasIssued: false, totalTimes: 1, totalPoints: 500, signInDays: ['2026-11-01'] }, now)
  assert.equal(pending.today.status, 2)
  assert.equal(pending.claimable, true)
  assert.match(describeDumatePanel(pending), /还没签/)
})

test('连续天数：今天没签也从昨天开始数', () => {
  const today = '2026-11-02'
  assert.equal(countStreak(['2026-11-01', '2026-11-02'], today), 2)
  // 今天没签，但昨天、前天签过 → 2
  assert.equal(countStreak(['2026-10-31', '2026-11-01'], today), 2)
  // 断了
  assert.equal(countStreak(['2026-10-29'], today), 0)
  assert.equal(countStreak([], today), 0)
  assert.equal(countStreak(['2026-11-02'], today), 1)
})

// ── AStudio（星火）：cookie 拼装、签到表归一化、注册表 ──

import {
  buildCookieHeader, normalizeAstudioPanel, pickDailyPopup, describeAstudioPanel,
  beijingDayKey as astudioDayKey, ASTUDIO_TZ, astudioStateDir, resolveClientType,
} from '../lib/providers/astudio.js'

test('AStudio 按北京时间算日期', () => {
  const d = new Date('2026-11-02T03:20:00Z')
  assert.equal(astudioDayKey(d), '2026-11-02')
  assert.equal(ASTUDIO_TZ, 'Asia/Shanghai')
})

test('AStudio cookie 拼装和桌面端一致', () => {
  const session = {
    ssoSessionId: 'sso-123', accountId: '2185', token: 'tok',
  }
  const cookie = buildCookieHeader(session)
  assert.match(cookie, /ssoSessionId=sso-123/)
  assert.match(cookie, /sso_sessionid=sso-123/)
  assert.match(cookie, /account_id=2185/)
  assert.match(cookie, /token=tok/)
  // 没有 ssoSessionId 时也不炸
  const minimal = buildCookieHeader({ accountId: 'a', token: 'b' })
  assert.equal(minimal, 'account_id=a; token=b')
})

test('AStudio 从 pending 里挑出每日积分弹窗', () => {
  const daily = { componentType: 'DAILY_REWARD_DIALOG', popupId: 1, instanceKey: 'k' }
  const other = { componentType: 'NEW_USER_DIALOG', popupId: 2, instanceKey: 'k2' }
  assert.equal(pickDailyPopup([other, daily]), daily)
  assert.equal(pickDailyPopup([other]), null)
  assert.equal(pickDailyPopup([]), null)
  assert.equal(pickDailyPopup(null), null)
})

test('AStudio 签到表归一化：有待领弹窗 vs 已到账', () => {
  const now = new Date('2026-11-02T03:20:00Z') // 北京 11-02
  const base = {
    balance: { totalBalance: 3100, sparkTotalBalance: 0, activityBalance: 3100 },
    membership: { planCode: 'TRIAL', planName: '体验版' },
    planConfig: {
      dailyLoginEnabled: true,
      dailyLoginValidDays: 31,
      plans: [
        { planCode: 'TRIAL', planName: '体验版', dailyLoginPoints: 100 },
        { planCode: 'PRO', planName: '高级版', dailyLoginPoints: 400 },
      ],
    },
  }
  const pending = normalizeAstudioPanel({
    ...base,
    popups: [{ componentType: 'DAILY_REWARD_DIALOG', popupId: 1, instanceKey: 'k', payload: { points: '100' } }],
  }, now)
  assert.equal(pending.claimable, true)
  assert.equal(pending.today.status, 2)
  assert.equal(pending.dailyPoints, 100)
  assert.equal(pending.accountCredits, 3100)
  assert.match(describeAstudioPanel(pending), /待领取/)

  const claimed = normalizeAstudioPanel({ ...base, popups: [] }, now)
  assert.equal(claimed.claimable, false)
  assert.equal(claimed.today.status, 3)
  assert.match(describeAstudioPanel(claimed), /已到账/)
})

test('AStudio clientType 按平台上报：win32=21，darwin=22', () => {
  assert.equal(resolveClientType('win32'), '21')
  assert.equal(resolveClientType('darwin'), '22')
  assert.equal(resolveClientType('linux'), '22')
})

test('AStudio 凭据目录：Windows 用 USERPROFILE/.acode，macOS 用 ~/.acode', () => {
  // macOS 默认候选
  const mac = astudioStateDir({ HOME: '/Users/wf' })
  assert.equal(mac, '/Users/wf/.acode/acode/userdata')
  // Windows：AStudio 用 %USERPROFILE%\.acode（Electron 惯例），不是 %APPDATA%
  const win = astudioStateDir({ USERPROFILE: 'C:\\Users\\wf', APPDATA: 'C:\\Users\\wf\\AppData\\Roaming' })
  assert.ok(win.includes('.acode'), 'AStudio 跨平台用 ~/.acode，不是 %APPDATA%')
  assert.ok(win.endsWith('acode/acode/userdata') || win.endsWith('acode\\acode\\userdata'), '应以 acode/userdata 结尾')
})
