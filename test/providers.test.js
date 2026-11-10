import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from 'node:fs/promises'
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

test('灵犀 task.status=incomplete 但今天那格 available 时，必须判为可领', () => {
  // 实测灵犀就是这么返回的：task.status 是 incomplete，不是 claimable。
  // 旧代码只认 'claimable'，于是永远不签——灵犀断签就是这么来的。
  const task = {
    ...lingxiTask,
    status: 'incomplete',
    extra: {
      ...lingxiTask.extra,
      today_day: 2,
      check_in_days: lingxiTask.extra.check_in_days.map(d => ({
        ...d,
        status: d.day === 1 ? 'claimed' : d.day === 2 ? 'available' : 'locked',
      })),
    },
  }
  const panel = normalizeLingxiPanel(task, 7100)
  assert.equal(panel.claimable, true, 'incomplete + 今天 available 应该是可领')
  assert.equal(panel.today.dayNo, 2)
  assert.equal(panel.today.status, 2)
  assert.match(describeLingxiPanel(panel), /可以领/)
})

test('灵犀今天那格已 claimed 时不可领（不论 task.status 说什么）', () => {
  const task = {
    ...lingxiTask,
    status: 'claimable',
    extra: {
      ...lingxiTask.extra,
      check_in_days: lingxiTask.extra.check_in_days.map(d => ({ ...d, status: d.day === 1 ? 'claimed' : d.status })),
    },
  }
  const panel = normalizeLingxiPanel(task, 7000)
  assert.equal(panel.claimable, false, '已经 claimed 的不能再领')
  assert.equal(panel.today.status, 3)
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

test('注册表里有七个服务，元信息齐全', () => {
  const providers = createProviders({ log: () => {} })
  assert.deepEqual(providers.ids(), ['minimax', 'lingxi', 'dumate', 'astudio', 'qoder', 'trae', 'doubao', 'codearts', 'buddy'])
  const meta = providers.meta()
  assert.equal(meta.length, 9)
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
  const qoder = meta.find(m => m.id === 'qoder')
  assert.equal(qoder.name, 'Qoder')
  assert.equal(qoder.timeZoneMode, 'fixed')
  assert.equal(qoder.unit, '积分')
  const trae = meta.find(m => m.id === 'trae')
  assert.equal(trae.name, 'Trae')
  assert.equal(trae.timeZoneMode, 'fixed')
  assert.equal(trae.unit, '积分')
  const doubao = meta.find(m => m.id === 'doubao')
  assert.equal(doubao.name, '豆包')
  assert.equal(doubao.timeZoneMode, 'fixed')
  assert.equal(doubao.unit, '额度')
  const codearts = meta.find(m => m.id === 'codearts')
  assert.equal(codearts.name, '华为 CodeArts')
  assert.equal(codearts.timeZoneMode, 'fixed')
  assert.equal(codearts.unit, '积分')
  const buddy = meta.find(m => m.id === 'buddy')
  assert.equal(buddy.name, '腾讯 WorkBuddy')
  assert.equal(buddy.short, 'WorkBuddy')
  assert.equal(buddy.timeZoneMode, 'fixed')
  assert.equal(buddy.unit, '积分')
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

test('AStudio 签到表归一化：只有今天一天，不伪造过去 6 天', () => {
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
  assert.equal(pending.style, 'daily')
  assert.equal(pending.days.length, 1, '只显示今天一天，不伪造过去 6 天')
  assert.equal(pending.claimable, true)
  assert.equal(pending.today.status, 2)
  assert.equal(pending.dailyPoints, 100)
  assert.equal(pending.accountCredits, 3100)
  assert.match(describeAstudioPanel(pending), /待领取/)

  const claimed = normalizeAstudioPanel({ ...base, popups: [] }, now)
  assert.equal(claimed.claimable, false)
  assert.equal(claimed.today.status, 3)
  assert.equal(claimed.days.length, 1)
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

// ── Qoder / Trae / 豆包（从 dsh-model 移植的签到服务）──

import { claimableCampaign, QODER_REGIONS, qoderRefreshedToday, todaysBenefit, currentCampaignStart } from '../lib/providers/qoder.js'
import { pickTraeCredential, tokenDaysLeft, decryptStorageValue, tokenAccountId } from '../lib/providers/trae.js'
import { deviceIdsFor, normalizeCookie, doubaoStatus } from '../lib/providers/doubao.js'

test('Qoder 区域配置完整', () => {
  assert.equal(QODER_REGIONS.cn.openApi, 'https://openapi.qoder.com.cn')
  assert.equal(QODER_REGIONS.intl.openApi, 'https://openapi.qoder.sh')
})

test('Qoder 活动每天 10:00（UTC+8）才换新一轮', () => {
  // UTC 01:00 = UTC+8 09:00 -> 还没刷新，看到的是昨天那轮
  assert.equal(qoderRefreshedToday(Date.parse('2026-11-05T01:00:00Z')), false)
  // UTC 01:59 = UTC+8 09:59 -> 仍未刷新
  assert.equal(qoderRefreshedToday(Date.parse('2026-11-05T01:59:00Z')), false)
  // UTC 02:00 = UTC+8 10:00 -> 刷新了
  assert.equal(qoderRefreshedToday(Date.parse('2026-11-05T02:00:00Z')), true)
  // UTC 09:00 = UTC+8 17:00 -> 刷新了
  assert.equal(qoderRefreshedToday(Date.parse('2026-11-05T09:00:00Z')), true)
})

test('Qoder 从活动列表挑出当天能领的 CLAIM_BENEFIT', () => {
  const now = Date.now()
  const campaign = { actionType: 'CLAIM_BENEFIT', campaignId: 'c1', startAt: now - 1000, endAt: now + 1000, claimStatus: 'CLAIMABLE' }
  assert.equal(claimableCampaign({ campaigns: [campaign] }, now), campaign)
  // 已过期的活动不选
  const expired = { actionType: 'CLAIM_BENEFIT', campaignId: 'c2', startAt: now - 2000, endAt: now - 1000, claimStatus: 'CLAIMABLE' }
  assert.equal(claimableCampaign({ campaigns: [expired] }, now), undefined)
  // 非 CLAIM_BENEFIT 不选
  assert.equal(claimableCampaign({ campaigns: [{ actionType: 'OTHER', startAt: now - 1, endAt: now + 1 }] }, now), undefined)
})

test('Qoder 已领取（CLAIMED）的活动不能再当「可领」返回', () => {
  // 这是实际踩到的坑：以前只看时间窗口，不看 claimStatus，
  // 于是已领的活动也被返回，每次签到都白打一次 claim 接口。
  const now = Date.now()
  const claimed = {
    actionType: 'CLAIM_BENEFIT', campaignId: 'c1', claimStatus: 'CLAIMED',
    startAt: now - 1000, endAt: now + 1000, benefit: { amount: 100 },
  }
  assert.equal(claimableCampaign({ campaigns: [claimed] }, now), undefined, 'CLAIMED 不该返回')
  // 但要能通过 todaysBenefit 认出来「今天这一轮存在且已领」
  assert.equal(todaysBenefit({ campaigns: [claimed] }, now), claimed)
})

test('Qoder 当前轮次起点：UTC+8 10:00 换轮', () => {
  const fmt = (t) => new Date(t + 8 * 3600e3).toISOString().replace('Z', '').slice(0, 16)
  // 09:59 属于前一天 10:00 开始的轮次
  assert.equal(fmt(currentCampaignStart(Date.parse('2026-11-07T01:59:00Z'))), '2026-11-06T10:00')
  // 10:00 整换新一轮
  assert.equal(fmt(currentCampaignStart(Date.parse('2026-11-07T02:00:00Z'))), '2026-11-07T10:00')
  // 00:30 仍在 11-06 10:00 那一轮里（跨过午夜但没到新的 10:00）
  assert.equal(fmt(currentCampaignStart(Date.parse('2026-11-06T16:30:00Z'))), '2026-11-06T10:00')
  // 23:59 属于当天 10:00 那一轮
  assert.equal(fmt(currentCampaignStart(Date.parse('2026-11-07T15:59:00Z'))), '2026-11-07T10:00')
})

test('Trae JWT 账号 id 与剩余天数', () => {
  const payload = { data: { id: 'user-123' }, exp: Math.floor((Date.now() + 86_400_000 * 3) / 1000) }
  const token = `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`
  assert.equal(tokenAccountId(token), 'user-123')
  assert.equal(tokenDaysLeft(token), 2) // 3 天后过期，向下取整 2 天
  assert.equal(tokenAccountId('bad'), undefined)
  assert.equal(tokenDaysLeft('bad'), null)
})

test('Trae 挑登录：没过期优先，其次带设备 id', () => {
  const now = Date.now()
  const mk = (exp, deviceId, accountId) => ({ token: makeJwt(exp), deviceId, accountId, source: 'x' })
  const expired = mk(now - 1000, 'dev-1', 'a')
  const liveNoDevice = mk(now + 1000, '', 'a')
  const liveDevice = mk(now + 1000, 'dev-2', 'a')
  // 过期的被排到最后
  assert.equal(pickTraeCredential([expired, liveNoDevice], now), liveNoDevice)
  // 都活着时带设备的优先
  assert.equal(pickTraeCredential([liveNoDevice, liveDevice], now), liveDevice)
})

test('Trae 解密函数对坏输入抛错', () => {
  assert.throws(() => decryptStorageValue('bad'))
  assert.throws(() => decryptStorageValue('aGVsbG8='), /太短/)
})

test('豆包 Cookie 规整与设备标识派生', () => {
  assert.equal(normalizeCookie('Cookie: a=b; c=d\n'), 'a=b; c=d')
  assert.equal(normalizeCookie('  a=b ; c=d  '), 'a=b; c=d')
  const ids = deviceIdsFor('seed-1')
  assert.ok(ids.web_id.startsWith('76'))
  assert.equal(ids.tea_uuid.length, 16)
  // 同种子稳定，不同种子不同
  assert.deepEqual(deviceIdsFor('seed-1'), ids)
  assert.notEqual(deviceIdsFor('seed-2').web_id, ids.web_id)
})

// ── 手动凭据（独立配置，不依赖本机 App）──

import { setManual, getManual, loadManual } from '../lib/checkin-secrets.js'
import { parseCookieHeader } from '../lib/providers/dumate.js'

test('手动凭据存取：set / get / 删除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshmm-man-'))
  const env = { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: join(dir, 'plugin') }
  try {
    await setManual('lingxi', { wps_sid: 'sid-123' }, env)
    await setManual('dumate', { cookie: 'a=1; bce-user-info="tok"' }, env)
    await setManual('astudio', { accountId: 'acct', token: 'tok', ssoSessionId: 'sso' }, env)
    await setManual('trae', { token: 'jwt.token.sig' }, env)

    const manual = await loadManual(env)
    assert.equal(manual.lingxi.wps_sid, 'sid-123')
    assert.equal(manual.dumate.cookie, 'a=1; bce-user-info="tok"')
    assert.equal(manual.astudio.accountId, 'acct')
    assert.equal(manual.trae.token, 'jwt.token.sig')

    // 删除一个
    await setManual('lingxi', null, env)
    assert.equal(await getManual('lingxi', env), null)
    assert.equal((await getManual('dumate', env)).cookie, 'a=1; bce-user-info="tok"')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('搭子手动 Cookie 解析出 csrftoken 来源', () => {
  const cookies = parseCookieHeader('a=1; bce-user-info="2026-01-01|tok"; b=2')
  const csrf = cookies.find(c => c.name === 'bce-user-info')
  assert.equal(csrf.value, '"2026-01-01|tok"')
})

function makeJwt(exp) {
  return `h.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000), data: { id: 'u' } })).toString('base64url')}.s`
}

// ── CodeArts（华为云签名）/ CodeBuddy ──

import { sdkDate, signRequest, findDailyActivity } from '../lib/providers/codearts.js'
import { buddyHeaders, BUDDY_PRODUCTS } from '../lib/providers/buddy.js'
import { createHash, createHmac } from 'node:crypto'

test('CodeArts x-sdk-date 是 UTC 的 YYYYMMDDTHHMMSSZ', () => {
  const d = new Date('2026-11-05T09:43:33.123Z')
  assert.equal(sdkDate(d), '20261105T094333Z')
  // 冒号、横线、毫秒都要去掉
  assert.match(sdkDate(d), /^\d{8}T\d{6}Z$/)
})

test('CodeArts 签名：Authorization 结构与 SignedHeaders 排序正确', () => {
  const headers = signRequest({
    ak: 'AKIDTEST',
    sk: 'SECRETKEY',
    securityToken: 'TOKEN123',
    method: 'POST',
    url: 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/claim',
    body: JSON.stringify({ campaignId: '1', channel: 'IDE' }),
  })
  assert.equal(headers['x-security-token'], 'TOKEN123')
  assert.equal(headers['content-type'], 'application/json')
  // host 参与签名但不手动设
  assert.equal(headers.host, undefined)
  // POST 的 SignedHeaders 必须含 content-type，且按字典序
  const m = headers.Authorization.match(/SignedHeaders=([^,]+),Signature=([0-9a-f]{64})$/)
  assert.ok(m, `Authorization 格式不对：${headers.Authorization}`)
  assert.equal(m[1], 'content-type;host;x-sdk-content-sha256;x-sdk-date;x-security-token')
  // 以 Access= 开头（不是 AccessKey=）
  assert.match(headers.Authorization, /^SDK-HMAC-SHA256 Access=AKIDTEST,/)
})

test('CodeArts 签名：GET 不带 content-type', () => {
  const headers = signRequest({
    ak: 'AK', sk: 'SK', securityToken: 'T',
    method: 'GET',
    url: 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/delivery?channel=IDE',
  })
  assert.equal(headers['content-type'], undefined)
  const m = headers.Authorization.match(/SignedHeaders=([^,]+)/)
  assert.equal(m[1], 'host;x-sdk-content-sha256;x-sdk-date;x-security-token')
})

test('CodeArts 签名：payload hash 是 body 的 sha256 小写 hex', () => {
  const body = JSON.stringify({ campaignId: '1', channel: 'IDE' })
  const headers = signRequest({
    ak: 'AK', sk: 'SK', securityToken: 'T', method: 'POST',
    url: 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/claim', body,
  })
  const expected = createHash('sha256').update(body).digest('hex')
  assert.equal(headers['x-sdk-content-sha256'], expected)
})

test('CodeArts 签名：同一份输入签名可复现（除了时间）', () => {
  const args = {
    ak: 'AK', sk: 'SK', securityToken: 'T', method: 'POST',
    url: 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/claim', body: '{}',
  }
  const a = signRequest(args)
  const b = signRequest(args)
  // 时间戳同一秒内应一致；签名也必须一致
  if (a['x-sdk-date'] === b['x-sdk-date']) {
    assert.equal(a.Authorization, b.Authorization)
  }
  assert.equal(a['x-sdk-content-sha256'], b['x-sdk-content-sha256'])
})

test('CodeArts 找每日登录活动（type=USER_LOGIN）', () => {
  const items = [
    { campaignId: '9', type: 'OTHER', claimable: true },
    { campaignId: '1', type: 'USER_LOGIN', claimable: true, status: 'CLAIMABLE', amount: 1000 },
  ]
  const act = findDailyActivity(items)
  assert.equal(act.campaignId, '1')
  assert.equal(findDailyActivity([]), undefined)
  assert.equal(findDailyActivity(undefined), undefined)
})

test('CodeBuddy 认证头齐全（少一个服务端就回 401 HTML）', () => {
  const cred = { access_token: 'tok123', user_id: 'u1', enterprise_id: 'e1' }
  const headers = buddyHeaders(cred, BUDDY_PRODUCTS.cn)
  assert.equal(headers.Authorization, 'Bearer tok123')
  assert.equal(headers['X-Domain'], 'copilot.tencent.com')
  assert.equal(headers['X-Product'], 'SaaS')
  assert.equal(headers['X-Product-Code'], 'codebuddy')
  assert.equal(headers['X-User-Id'], 'u1')
  assert.equal(headers['X-Enterprise-Id'], 'e1')
  assert.equal(headers['X-Tenant-Id'], 'e1')
  assert.equal(headers['User-Agent'], 'CodeBuddyIDE/1.106.1')
})

test('CodeBuddy 没有 user_id / enterprise_id 时不带那些头', () => {
  const headers = buddyHeaders({ access_token: 't' }, BUDDY_PRODUCTS.intl)
  assert.equal(headers['X-User-Id'], undefined)
  assert.equal(headers['X-Enterprise-Id'], undefined)
  assert.equal(headers['X-Domain'], 'www.workbuddy.ai')
  assert.equal(headers['X-Product-Code'], 'workbuddy')
})

test('CodeArts 签名与华为云 SDK-HMAC-SHA256 规范逐字节一致', () => {
  // 用固定时间戳，独立按规范实现一遍，和 signRequest 的结果比对。
  // 这是整条 CodeArts 链路最容易错的地方（URI 补斜杠、headers 排序、7 段拼法）。
  const FIXED = new Date('2026-11-05T09:43:33.123Z')
  const RealDate = Date
  const ak = 'AKIDTEST'
  const sk = 'SecretKey123'
  const st = 'SecurityToken456'
  const method = 'POST'
  const urlStr = 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/claim'
  const body = JSON.stringify({ campaignId: '1', channel: 'IDE' })

  // 规范值：独立实现，不依赖被测代码
  const u = new URL(urlStr)
  const uri = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`
  const payloadHash = createHash('sha256').update(body).digest('hex')
  const date = '20261105T094333Z'
  const hdr = {
    host: u.host,
    'x-sdk-date': date,
    'x-sdk-content-sha256': payloadHash,
    'x-security-token': st,
    'content-type': 'application/json',
  }
  const keys = Object.keys(hdr).sort()
  const creq = [method, uri, '', keys.map(k => `${k}:${hdr[k]}`).join('\n'), '', keys.join(';'), payloadHash].join('\n')
  const sts = ['SDK-HMAC-SHA256', date, createHash('sha256').update(creq).digest('hex')].join('\n')
  const expected = createHmac('sha256', sk).update(sts).digest('hex')

  // 冻结时间后调用被测实现
  class FrozenDate extends RealDate {
    constructor(...a) { a.length === 0 ? super(FIXED.getTime()) : super(...a) }
    static now() { return FIXED.getTime() }
  }
  globalThis.Date = FrozenDate
  let got
  try {
    const headers = signRequest({ ak, sk, securityToken: st, method, url: urlStr, body })
    got = headers.Authorization.match(/Signature=([0-9a-f]+)$/)[1]
    assert.equal(headers['x-sdk-date'], date, 'x-sdk-date 格式必须是 YYYYMMDDTHHMMSSZ')
  } finally {
    globalThis.Date = RealDate
  }
  assert.equal(got, expected, '签名与华为云规范不一致')
})

test('CodeArts 签名里有内容时 payloadHash 不能是空串的 hash', () => {
  const emptyHash = createHash('sha256').update('').digest('hex')
  const withBody = signRequest({
    ak: 'AK', sk: 'SK', securityToken: 'T', method: 'POST',
    url: 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/claim',
    body: '{"campaignId":"1"}',
  })
  assert.notEqual(withBody['x-sdk-content-sha256'], emptyHash)
  // 无 body 的 GET 才应该是空串的 hash
  const noBody = signRequest({
    ak: 'AK', sk: 'SK', securityToken: 'T', method: 'GET',
    url: 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/delivery?channel=IDE',
  })
  assert.equal(noBody['x-sdk-content-sha256'], emptyHash)
})

// ── CodeArts 浏览器登录（不用手填 AK/SK）──

import {
  buildLoginUrl, parseCredentialResponse, expiresAtOf, startCallbackServer,
} from '../lib/providers/codearts-login.js'

test('CodeArts 登录 URL 结构正确（华为云授权页 + 回调地址）', () => {
  const url = buildLoginUrl(8791, 'TICKET-123')
  const u = new URL(url)
  assert.equal(u.host, 'auth.huaweicloud.com')
  assert.ok(u.searchParams.has('service'), '必须带 service 参数')

  const inner = new URL(u.searchParams.get('service'))
  assert.equal(inner.host, 'devcloud.cn-north-4.huaweicloud.com')
  assert.equal(inner.searchParams.get('auth_callback_url'), 'http://127.0.0.1:8791/authentication')
  assert.equal(inner.searchParams.get('plugin-name'), 'snap_jetbrains')
  assert.equal(inner.searchParams.get('ticket_id'), 'TICKET-123')
})

test('CodeArts 凭据解析认华为云的两种返回形状', () => {
  // 形状一：credential（下划线命名）
  const a = parseCredentialResponse({
    credential: { access: 'AK1', secret: 'SK1', securitytoken: 'ST1', expires_at: '2026-11-07T00:00:00Z' },
    user_name: 'alice',
  })
  assert.equal(a.access_key_id, 'AK1')
  assert.equal(a.secret_access_key, 'SK1')
  assert.equal(a.security_token, 'ST1')
  assert.equal(a.user_name, 'alice')

  // 形状二：result（驼峰命名）
  const b = parseCredentialResponse({
    result: { accessKeyId: 'AK2', secretAccessKey: 'SK2', securityToken: 'ST2', expiration: '2026-11-08T00:00:00Z' },
  })
  assert.equal(b.access_key_id, 'AK2')
  assert.equal(b.security_token, 'ST2')

  // 缺 security_token 的不能当有效凭据（签到签名用不了）
  assert.equal(parseCredentialResponse({ credential: { access: 'AK', secret: 'SK' } }), null)
  assert.equal(parseCredentialResponse({}), null)
  assert.equal(parseCredentialResponse(null), null)
})

test('CodeArts 凭据过期时间可解析，读不出来按一天兜底', () => {
  const withExp = parseCredentialResponse({
    credential: { access: 'AK', secret: 'SK', securitytoken: 'ST', expires_at: '2026-11-07T00:00:00Z' },
  })
  assert.equal(expiresAtOf(withExp), Date.parse('2026-11-07T00:00:00Z'))

  const noExp = parseCredentialResponse({ credential: { access: 'AK', secret: 'SK', securitytoken: 'ST' } })
  const fallback = expiresAtOf(noExp)
  assert.ok(fallback > Date.now() + 23 * 3600_000, '兜底应约一天后')
})

test('CodeArts 回调服务器：收到 secret 返回页面，缺 secret 拒绝', async () => {
  // pollAttempts: 1 —— 只打一次 ticket 接口就放弃，别在单测里真等 120 秒
  const { port, server, done } = await startCallbackServer('TICKET-X', 3000, { pollAttempts: 1 })
  try {
    // 不带 secret：拒绝
    const bad = await fetch(`http://127.0.0.1:${port}/authentication`)
    assert.equal(bad.status, 400)

    // 别的路径：404
    const other = await fetch(`http://127.0.0.1:${port}/whatever`)
    assert.equal(other.status, 404)

    // 带 secret：返回 200 的成功页（然后它会去换凭据，假 ticket 必然失败）
    const ok = await fetch(`http://127.0.0.1:${port}/authentication?secret=abc`)
    assert.equal(ok.status, 200)
    assert.match(await ok.text(), /已收到华为云授权/)
  } finally {
    // 假 ticket 换不到真凭据，reject 是预期的；关键是它 reject 而不是崩进程
    await done.catch(() => {})
    try { server.close() } catch { /* 已关 */ }
  }
})

test('CodeArts 回调服务器超时会 reject 而不是抛未捕获异常', async () => {
  const { server, done } = await startCallbackServer('TICKET-Y', 300, { pollAttempts: 1 })
  let caught = null
  try {
    await done
  } catch (error) {
    caught = error
  }
  assert.ok(caught, '超时必须 reject')
  assert.equal(caught.code, 'CODEARTS_LOGIN_TIMEOUT')
  try { server.close() } catch { /* 已关 */ }
})

// ── CodeBuddy 浏览器登录 ──

import { decorateLoginUrl, fetchAuthState } from '../lib/providers/buddy-login.js'

test('CodeBuddy 授权地址补 version 和 loginSessionId', () => {
  const product = BUDDY_PRODUCTS.cn
  const decorated = decorateLoginUrl('https://copilot.tencent.com/login?platform=ide&state=abc', product)
  const u = new URL(decorated)
  assert.equal(u.searchParams.get('version'), '1.106.1')
  assert.ok(u.searchParams.get('loginSessionId'), '要带 loginSessionId')
  assert.equal(u.searchParams.get('state'), 'abc', '原有参数不能丢')
  // 每次调用会话号不同
  const again = new URL(decorateLoginUrl('https://copilot.tencent.com/login?state=abc', product))
  assert.notEqual(again.searchParams.get('loginSessionId'), u.searchParams.get('loginSessionId'))
})

test('CodeBuddy 不补参数时原样返回', () => {
  const product = { ...BUDDY_PRODUCTS.cn, appendSessionParams: false }
  assert.equal(decorateLoginUrl('https://x/y?state=1', product), 'https://x/y?state=1')
})

test('CodeBuddy 两个产品线的登录身份不同', () => {
  const cn = BUDDY_PRODUCTS.cn
  const intl = BUDDY_PRODUCTS.intl
  assert.equal(cn.endpoint, 'https://copilot.tencent.com')
  assert.equal(intl.endpoint, 'https://www.workbuddy.ai')
  assert.equal(cn.platform, 'ide')
  assert.equal(intl.platform, 'ide')
  // 版本号必须各自正确，否则登录页会认成别的客户端
  assert.equal(cn.pluginVersion, '1.106.1')
  assert.equal(intl.pluginVersion, '5.5.2')
  assert.ok(cn.appendSessionParams && intl.appendSessionParams)
})

test('CodeBuddy 真实取 auth/state（端点在线时）', async () => {
  // 这条会打真实接口；网络不通就跳过，不让测试环境挂掉
  let r
  try {
    r = await fetchAuthState(BUDDY_PRODUCTS.cn)
  } catch (error) {
    if (/NETWORK|连不上/.test(error.message)) return
    throw error
  }
  assert.ok(r.state && r.state.length > 8, 'state 应该是一串 uuid')
  const u = new URL(r.authUrl)
  assert.equal(u.host, 'copilot.tencent.com')
  assert.ok(u.searchParams.get('state'), '授权地址要带 state')
})

// ── 多账号 ──

import { mergeAccountResults, OUTCOME } from '../lib/providers/base.js'
import { listAccounts, addAccount, removeAccount, saveAccounts } from '../lib/checkin-secrets.js'
import { mkdtemp as mkdtemp2, writeFile as writeFile2, readFile as readFile2 } from 'node:fs/promises'
import { tmpdir as tmpdir2 } from 'node:os'
import { join as join2 } from 'node:path'

test('多账号：老的单账号结构自动当成 1 个账号（不丢凭据）', async () => {
  const home = await mkdtemp2(join2(tmpdir2(), 'ma-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  await writeFile2(join2(home, 'secrets.json'), JSON.stringify({
    checkin: { manual: { lingxi: { wps_sid: 'OLD-SID' } } },
  }))
  const list = await listAccounts('lingxi', env)
  assert.equal(list.length, 1)
  assert.equal(list[0].wps_sid, 'OLD-SID')
  assert.equal(list[0].id, '1')
})

test('多账号：加 / 删 / 清空', async () => {
  const home = await mkdtemp2(join2(tmpdir2(), 'ma2-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }

  await addAccount('lingxi', { wps_sid: 'A', name: '主号' }, env)
  await addAccount('lingxi', { wps_sid: 'B', name: '小号' }, env)
  let list = await listAccounts('lingxi', env)
  assert.equal(list.length, 2)
  assert.equal(list[1].name, '小号')

  await removeAccount('lingxi', '1', env)
  list = await listAccounts('lingxi', env)
  assert.equal(list.length, 1)
  assert.equal(list[0].wps_sid, 'B')

  await saveAccounts('lingxi', [], env)
  assert.equal((await listAccounts('lingxi', env)).length, 0)
})

test('多账号：切到 accounts 结构后不留老扁平字段', async () => {
  const home = await mkdtemp2(join2(tmpdir2(), 'ma3-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  await writeFile2(join2(home, 'secrets.json'), JSON.stringify({
    checkin: { manual: { lingxi: { wps_sid: 'OLD' } } },
  }))
  await addAccount('lingxi', { wps_sid: 'NEW' }, env)
  const raw = JSON.parse(await readFile2(join2(home, 'secrets.json'), 'utf8'))
  const entry = raw.checkin.manual.lingxi
  assert.ok(Array.isArray(entry.accounts), '应该用 accounts 数组')
  assert.equal(entry.wps_sid, undefined, '老扁平字段要清掉')
  assert.equal(entry.accounts.length, 2, '老的也要迁移进来')
})

test('多账号汇总：两个都签上 → claimed，积分累加', () => {
  const r = mergeAccountResults('lingxi', [
    { ok: true, label: '主号', result: { ok: true, outcome: OUTCOME.CLAIMED, points: 100, consecutiveDays: 3 } },
    { ok: true, label: '小号', result: { ok: true, outcome: OUTCOME.CLAIMED, points: 100, consecutiveDays: 1 } },
  ], { unit: '智点' })
  assert.equal(r.outcome, OUTCOME.CLAIMED)
  assert.equal(r.points, 200)
  assert.equal(r.accounts, 2)
  assert.equal(r.consecutiveDays, 3, '连续天数取最大')
  assert.match(r.message, /2\/2 个账号/)
})

test('多账号汇总：一个成功一个失败 → 仍算成功，消息里点名失败的', () => {
  const r = mergeAccountResults('lingxi', [
    { ok: true, label: '主号', result: { ok: true, outcome: OUTCOME.CLAIMED, points: 100 } },
    { ok: false, label: '小号', error: 'cookie 过期' },
  ], { unit: '智点' })
  assert.equal(r.ok, true)
  assert.equal(r.outcome, OUTCOME.CLAIMED)
  assert.match(r.message, /小号/)
})

test('多账号汇总：全部失败 → failed', () => {
  const r = mergeAccountResults('lingxi', [
    { ok: false, label: '主号', error: 'x' },
    { ok: false, label: '小号', error: 'y' },
  ])
  assert.equal(r.ok, false)
  assert.equal(r.outcome, OUTCOME.FAILED)
})

test('多账号汇总：全部无任务 → no_task（不算失败）', () => {
  const r = mergeAccountResults('doubao', [
    { ok: true, label: '主号', result: { ok: true, outcome: OUTCOME.NO_TASK } },
    { ok: true, label: '小号', result: { ok: true, outcome: OUTCOME.NO_TASK } },
  ])
  assert.equal(r.ok, true)
  assert.equal(r.outcome, OUTCOME.NO_TASK)
})

test('多账号汇总：一个签一个已签 → 记 claimed（有新的就报新的）', () => {
  const r = mergeAccountResults('lingxi', [
    { ok: true, label: '主号', result: { ok: true, outcome: OUTCOME.ALREADY } },
    { ok: true, label: '小号', result: { ok: true, outcome: OUTCOME.CLAIMED, points: 100 } },
  ])
  assert.equal(r.outcome, OUTCOME.CLAIMED)
  assert.equal(r.points, 100)
})

test('多账号汇总：单账号时消息不啰嗦', () => {
  const r = mergeAccountResults('lingxi', [
    { ok: true, label: '主号', result: { ok: true, outcome: OUTCOME.CLAIMED, points: 100, message: '签到成功 +100' } },
  ], { unit: '智点' })
  assert.equal(r.message, '签到成功 +100', '单账号不要加 N/N 前缀')
})

// ── 自定义签到服务（AI 做完导入成卡片）──

import {
  normalizeCustomService, upsertCustomService, loadCustomServices,
  removeCustomService, pickPath, buildAddServicePrompt, CustomServiceError, BUILTIN_IDS,
} from '../lib/custom-services.js'
import { createProvidersAsync } from '../lib/providers/index.js'

test('自定义服务：pickPath 支持点号和数组下标', () => {
  const obj = { data: { list: [{ ok: true, pts: 10 }, { ok: false }], nested: { deep: 'x' } }, code: 0 }
  assert.equal(pickPath(obj, 'code'), 0)
  assert.equal(pickPath(obj, 'data.nested.deep'), 'x')
  assert.equal(pickPath(obj, 'data.list[0].ok'), true)
  assert.equal(pickPath(obj, 'data.list[1].ok'), false)
  assert.equal(pickPath(obj, 'data.list[5].ok'), undefined)
  assert.equal(pickPath(obj, 'nope.deep'), undefined)
  assert.equal(pickPath(obj, ''), undefined)
})

test('自定义服务：定义校验（非法 id / 重名 / 坏 URL 都要拒）', () => {
  assert.throws(() => normalizeCustomService({ id: 'x', checkin: { url: 'https://a.com' } }), CustomServiceError)
  assert.throws(() => normalizeCustomService({ id: '1abc', checkin: { url: 'https://a.com' } }), CustomServiceError)
  assert.throws(() => normalizeCustomService({ id: 'minimax', checkin: { url: 'https://a.com' } }), /重名/)
  assert.throws(() => normalizeCustomService({ id: 'okId', checkin: { url: 'ftp://a.com' } }), /http/)
  assert.throws(() => normalizeCustomService({ id: 'okId' }), /checkin/)
  // 合法的能过
  const ok = normalizeCustomService({ id: 'okId', checkin: { url: 'https://a.com/x' } })
  assert.equal(ok.id, 'okId')
  assert.equal(ok.checkin.method, 'POST', '默认 POST')
  assert.equal(ok.unit, '积分', '默认单位')
  assert.ok(BUILTIN_IDS.has('minimax'))
})

test('自定义服务：导入后出现在卡片列表里', async () => {
  const home = await mkdtemp2(join2(tmpdir2(), 'cs-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  await upsertCustomService({
    id: 'demoSite', name: '演示', short: '演示', color: '#10b981',
    checkin: { method: 'POST', url: 'https://demo.example.com/signin' },
    successPath: 'code',
  }, env)

  const providers = await createProvidersAsync({ log: () => {}, env })
  const meta = providers.meta()
  assert.equal(meta.length, 10, '9 内置 + 1 自定义')
  const card = meta.find(m => m.id === 'demoSite')
  assert.ok(card, '自定义卡片要出现')
  assert.equal(card.short, '演示')
  assert.equal(card.custom, true, '要标记成自定义，面板才能删')
})

test('自定义服务：删除后卡片消失', async () => {
  const home = await mkdtemp2(join2(tmpdir2(), 'cs2-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  await upsertCustomService({ id: 'tempSite', checkin: { url: 'https://a.com/x' } }, env)
  assert.equal((await loadCustomServices(env)).length, 1)
  assert.equal(await removeCustomService('tempSite', env), true)
  assert.equal((await loadCustomServices(env)).length, 0)
  // 删不存在的返回 false
  assert.equal(await removeCustomService('nope', env), false)
})

test('自定义服务：提示词包含 JSON 模板和内置 id 提醒', () => {
  const p = buildAddServicePrompt({ existingIds: ['minimax', 'lingxi'] })
  assert.match(p, /"checkin"\s*:/, '要有 checkin 模板')
  assert.match(p, /"successPath"/, '要有成功判定字段')
  assert.match(p, /minimax/, '要提醒别和内置重名')
  assert.match(p, /data\.list\[0\]/, '要说明数组下标写法')
})

test('自定义服务：凭据目录权限 600', async () => {
  const home = await mkdtemp2(join2(tmpdir2(), 'cs3-'))
  const env = { ...process.env, DSH_CHECKIN_ALL_HOME: home }
  await upsertCustomService({ id: 'permSite', checkin: { url: 'https://a.com/x' } }, env)
  const st = await stat(join2(home, 'custom-services.json'))
  assert.equal((st.mode & 0o777).toString(8), '600')
})
