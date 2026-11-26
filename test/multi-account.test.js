// test/multi-account.test.js — 多账号、多入口同时签到时互不冲突
//
// 覆盖：凭据 / 状态文件并发读改写不丢改动（同进程 + 跨进程）、坏文件不清空、
// 同一服务同时只跑一次、不同服务并行、逐账号记账与重试、Trae CLI 与多令牌、OfficeAce（移植自 dsh-model）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  addAccount, addDoubao, addQoder, listAccounts, loadDoubaos, loadQoders, patchAccount, secretsPath, setManual,
} from '../lib/checkin-secrets.js'
import { exclusive, mapLimit, serialized } from '../lib/lock.js'
import { Runner } from '../lib/runner.js'
import { createScheduler } from '../lib/scheduler.js'
import { loadState, pendingAccounts, providerDoneToday, recordAttempt, saveConfig, loadConfig } from '../lib/store.js'
import { mergeAccountResults, OUTCOME } from '../lib/providers/base.js'
import { createTraeProvider } from '../lib/providers/trae.js'
import { createOfficeAceProvider, officeAceClaim, refreshOfficeAce, signApic, OfficeAceAuthError } from '../lib/providers/officeace.js'
import { beijingDayKey } from '../lib/tz.js'

const run = promisify(execFile)

async function tempEnv() {
  const dir = await mkdtemp(join(tmpdir(), 'dca-multi-'))
  return { dir, env: { ...process.env, HOME: dir, DSH_CHECKIN_ALL_HOME: join(dir, 'plugin'), DSH_CHECKIN_NO_APP_DISCOVERY: '' } }
}

const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

// ── 锁 ──

test('serialized：同一个 key 依次执行，前一个失败不影响后一个', async () => {
  const order = []
  const a = serialized('k', async () => { await new Promise(r => setTimeout(r, 30)); order.push('a'); throw new Error('x') })
  const b = serialized('k', async () => { order.push('b'); return 2 })
  await assert.rejects(a)
  assert.equal(await b, 2)
  assert.deepEqual(order, ['a', 'b'])
})

test('exclusive：嵌套拿同一把锁不会等自己（不死锁）', async () => {
  const { dir } = await tempEnv()
  const file = join(dir, 'f.json')
  const v = await exclusive(file, () => exclusive(file, async () => 42))
  assert.equal(v, 42)
  await rm(dir, { recursive: true, force: true })
})

test('mapLimit：最多同时跑 limit 个，结果按输入顺序', async () => {
  let live = 0
  let peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    live += 1; peak = Math.max(peak, live)
    await new Promise(r => setTimeout(r, 10))
    live -= 1
    return n * 10
  })
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60])
  assert.equal(peak, 2)
})

// ── 凭据文件 ──

test('凭据：同时加 30 个账号（三种存法混着来），一个都不丢', async () => {
  const { dir, env } = await tempEnv()
  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => addAccount('lingxi', { wps_sid: `sid-${i}`, name: `L${i}` }, env)),
    ...Array.from({ length: 10 }, (_, i) => addQoder({ pat: `pt-${i}`, region: 'cn' }, env)),
    ...Array.from({ length: 10 }, (_, i) => addDoubao({ cookie: `uid_tt=u${i}; a=b` }, env)),
  ])
  assert.equal((await listAccounts('lingxi', env)).length, 10)
  assert.equal((await loadQoders(env)).length, 10)
  assert.equal((await loadDoubaos(env)).length, 10)
  // id 各不相同
  assert.equal(new Set((await listAccounts('lingxi', env)).map(a => a.id)).size, 10)
  await rm(dir, { recursive: true, force: true })
})

test('凭据：续期写回只改那一个账号，同时加的新账号不会被盖掉', async () => {
  const { dir, env } = await tempEnv()
  await addAccount('officeace', { cred: { refreshToken: 'rt-1' } }, env)
  await Promise.all([
    patchAccount('officeace', '1', { cred: { refreshToken: 'rt-2' } }, env),
    addAccount('officeace', { cred: { refreshToken: 'other' } }, env),
    setManual('trae', { token: 't' }, env),
  ])
  const list = await listAccounts('officeace', env)
  assert.equal(list.length, 2)
  assert.equal(list.find(a => a.id === '1').cred.refreshToken, 'rt-2')
  assert.equal((await listAccounts('trae', env)).length, 1)
  await rm(dir, { recursive: true, force: true })
})

test('凭据：secrets.json 坏了就拒绝写，不把已有账号清空', async () => {
  const { dir, env } = await tempEnv()
  await addAccount('lingxi', { wps_sid: 'keep-me' }, env)
  const broken = (await readFile(secretsPath(env), 'utf8')).slice(0, -5)
  await writeFile(secretsPath(env), broken)
  await assert.rejects(addAccount('lingxi', { wps_sid: 'new' }, env), (e) => e.code === 'SECRETS_CORRUPT')
  assert.equal(await readFile(secretsPath(env), 'utf8'), broken, '坏文件原样留着，等用户修')
  await rm(dir, { recursive: true, force: true })
})

test('凭据：两个进程同时加账号（插件 + 终端命令），一个都不丢', async () => {
  const { dir, env } = await tempEnv()
  const script = `
    import { addAccount } from ${JSON.stringify(new URL('../lib/checkin-secrets.js', import.meta.url).href)}
    const tag = process.argv[1]
    await Promise.all(Array.from({ length: 8 }, (_, i) => addAccount('dumate', { cookie: tag + '-' + i })))
  `
  await Promise.all(['p1', 'p2', 'p3'].map(tag => run(process.execPath, ['--input-type=module', '-e', script, tag], { env })))
  const list = await listAccounts('dumate', env)
  assert.equal(list.length, 24, '3 个进程 × 8 个账号')
  assert.equal(new Set(list.map(a => a.cookie)).size, 24)
  await rm(dir, { recursive: true, force: true })
})

// ── 状态 / 设置文件 ──

test('记账：几个服务同时记账，谁也不覆盖谁', async () => {
  const { dir, env } = await tempEnv()
  const day = beijingDayKey()
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  await Promise.all(ids.map(id => recordAttempt(id, { ok: true, outcome: OUTCOME.CLAIMED, points: 1, day }, env)))
  const st = await loadState(env)
  for (const id of ids) assert.ok(st.providers[id].days[day], `${id} 的记录不能丢`)
  await rm(dir, { recursive: true, force: true })
})

test('设置：同时改几个服务的单独设置，全部生效', async () => {
  const { dir, env } = await tempEnv()
  await Promise.all(['x', 'y', 'z'].map((id, i) => saveConfig({ providers: { [id]: { time: `0${i + 7}:00` } } }, env)))
  const cfg = await loadConfig(env)
  assert.deepEqual(Object.keys(cfg.providers).sort(), ['x', 'y', 'z'])
  await rm(dir, { recursive: true, force: true })
})

// ── 逐账号记账与重试 ──

test('逐账号：一个账号失败不会被另一个的成功盖住，今天还要重试它', async () => {
  const { dir, env } = await tempEnv()
  const merged = mergeAccountResults('demo', [
    { ok: true, key: 'm:1', label: '主号', result: { ok: true, outcome: OUTCOME.CLAIMED, points: 5, message: '+5' } },
    { ok: false, key: 'm:2', label: '小号', error: '网络超时' },
    { ok: true, key: 'm:3', label: '企业号', result: { ok: false, outcome: OUTCOME.NO_TASK, message: '没有签到任务' } },
  ])
  assert.equal(merged.ok, true, '整体算成功（有账号签上了）')
  assert.deepEqual(merged.perAccount.map(p => p.key), ['m:1', 'm:2', 'm:3'])
  await recordAttempt('demo', merged, env)
  let st = await loadState(env)
  assert.deepEqual(pendingAccounts(st, 'demo').map(p => p.key), ['m:2'], '只有小号要重试；企业号是没这玩法，不重试')
  assert.equal(providerDoneToday(st, 'demo'), false)

  // 重试：小号签上了
  await recordAttempt('demo', mergeAccountResults('demo', [
    { ok: true, key: 'm:1', label: '主号', result: { ok: true, outcome: OUTCOME.ALREADY, message: '今天已签' } },
    { ok: true, key: 'm:2', label: '小号', result: { ok: true, outcome: OUTCOME.CLAIMED, points: 5, message: '+5' } },
    { ok: true, key: 'm:3', label: '企业号', result: { ok: false, outcome: OUTCOME.NO_TASK, message: '没有签到任务' } },
  ]), env)
  st = await loadState(env)
  assert.equal(pendingAccounts(st, 'demo').length, 0)
  assert.equal(providerDoneToday(st, 'demo'), true)
  assert.equal(st.providers.demo.days[beijingDayKey()].outcome, 'claimed', '同一天先 claimed 后 already，保留 claimed')
  await rm(dir, { recursive: true, force: true })
})

test('定时器：有账号没签上就按失败退避，不标成今天已完成', async () => {
  const { dir, env } = await tempEnv()
  let calls = 0
  const scheduler = createScheduler({
    config: async () => ({ enabled: true, time: '00:00', catchUp: true, providers: {} }),
    state: () => loadState(env),
    providers: () => [{ id: 'demo' }],
    run: async () => {
      calls += 1
      const r = mergeAccountResults('demo', [
        { ok: true, key: 'm:1', label: '主号', result: { ok: true, outcome: OUTCOME.CLAIMED, points: 1 } },
        { ok: false, key: 'm:2', label: '小号', error: '超时' },
      ])
      await recordAttempt('demo', r, env)
      return [r]
    },
  })
  await scheduler.tick()
  assert.equal(calls, 1)
  assert.equal(scheduler.failuresOf('demo'), 1, '小号没签上：记一次失败，等退避后再签')
  scheduler.stop()
  await rm(dir, { recursive: true, force: true })
})

test('定时器：同时 fire 两组不同的服务，各自拿到自己的结果（以前第二组会拿到第一组的）', async () => {
  const seen = []
  const scheduler = createScheduler({
    config: async () => ({}),
    state: async () => ({ providers: {} }),
    providers: () => [],
    run: async (only) => {
      await new Promise(r => setTimeout(r, 20))
      seen.push(only.join(','))
      return only.map(id => ({ provider: id, ok: true }))
    },
  })
  const [a, b] = await Promise.all([scheduler.runNow(['lingxi']), scheduler.runNow(['qoder'])])
  assert.equal(a[0].provider, 'lingxi')
  assert.equal(b[0].provider, 'qoder')
  assert.deepEqual(seen.sort(), ['lingxi', 'qoder'])
  scheduler.stop()
})

// ── runner：同一服务只跑一次，不同服务并行 ──

function fakeRunner(env, providers) {
  const runner = new Runner({ env })
  const reg = { list: providers, get: id => providers.find(p => p.id === id) || null, meta: () => providers.map(p => ({ id: p.id })) }
  runner.providers = reg
  runner._ready = Promise.resolve(reg)
  return runner
}

test('runner：同一个服务同时被要求签三次，只真正签一次', async () => {
  const { dir, env } = await tempEnv()
  let calls = 0
  const runner = fakeRunner(env, [{
    id: 'demo',
    async run() {
      calls += 1
      await new Promise(r => setTimeout(r, 50))
      return { ok: true, outcome: OUTCOME.CLAIMED, points: 1, provider: 'demo' }
    },
  }])
  const results = await Promise.all([runner.run('demo'), runner.run('demo', { trigger: 'auto' }), runner.runAll({ only: ['demo'] })])
  assert.equal(calls, 1, '一次性的续期令牌不能被并发用两次；同一个账号也不能重复领')
  assert.equal(results[0], results[1])
  await rm(dir, { recursive: true, force: true })
})

test('runner：不同服务并行签，各自的记账都在', async () => {
  const { dir, env } = await tempEnv()
  const slow = (id) => ({
    id,
    async run() {
      await new Promise(r => setTimeout(r, 120))
      return { ok: true, outcome: OUTCOME.CLAIMED, points: 1, provider: id, day: beijingDayKey() }
    },
  })
  const runner = fakeRunner(env, ['a', 'b', 'c', 'd'].map(slow))
  const started = Date.now()
  const results = await runner.runAll()
  const elapsed = Date.now() - started
  assert.equal(results.length, 4)
  assert.ok(elapsed < 400, `4 个服务各 120ms，并行应该远小于 480ms（实际 ${elapsed}ms）`)
  const st = await loadState(env)
  for (const id of ['a', 'b', 'c', 'd']) assert.ok(st.providers[id].days[beijingDayKey()])
  await rm(dir, { recursive: true, force: true })
})

test('runner：一个服务抛错不影响别的服务', async () => {
  const { dir, env } = await tempEnv()
  const runner = fakeRunner(env, [
    { id: 'bad', async run() { throw Object.assign(new Error('坏了'), { code: 'BOOM' }) } },
    { id: 'good', async run() { return { ok: true, outcome: OUTCOME.ALREADY, provider: 'good' } } },
  ])
  const [bad, good] = await runner.runAll()
  assert.equal(bad.ok, false)
  assert.equal(bad.outcome, 'BOOM')
  assert.equal(good.ok, true)
  await rm(dir, { recursive: true, force: true })
})

// ── Trae：CLI 登录 + 多个手动令牌，按账号去重 ──

test('Trae：读 Trae CLI 的 auth.json；海外区账号不当签到账号', async () => {
  const { dir, env } = await tempEnv()
  const exp = Math.floor(Date.now() / 1000) + 86400
  await mkdir(join(dir, '.trae', 'cli'), { recursive: true })
  await writeFile(join(dir, '.trae', 'cli', 'auth.json'), JSON.stringify({
    trae: { access_token: jwt({ data: { id: '111' }, exp }), user_id: '111', region: 'CN', personal_device: { device_id: 'dev-1' } },
  }))
  await mkdir(join(dir, '.trae-cn', 'cli'), { recursive: true })
  await writeFile(join(dir, '.trae-cn', 'cli', 'auth.json'), JSON.stringify({
    trae: { access_token: jwt({ data: { id: '999' }, exp }), user_id: '999', region: 'SG' },
  }))
  const trae = createTraeProvider({ env: { ...env, TRAE_PLATFORM: 'linux' } })
  const account = await trae.account()
  assert.equal(account.loggedIn, true)
  assert.equal(account.accounts, 1, '只认国内区的那个')
  assert.match(account.detail, /Trae CLI/)
  await rm(dir, { recursive: true, force: true })
})

test('Trae：面板加的多个令牌都签，和本机同一个账号的不重复（以前加了也不签）', async () => {
  const { dir, env } = await tempEnv()
  const exp = Math.floor(Date.now() / 1000) + 86400
  await mkdir(join(dir, '.trae', 'cli'), { recursive: true })
  await writeFile(join(dir, '.trae', 'cli', 'auth.json'), JSON.stringify({
    trae: { access_token: jwt({ data: { id: '111' }, exp }), user_id: '111', region: 'CN' },
  }))
  await addAccount('trae', { token: jwt({ data: { id: '111' }, exp }), name: '和本机同一个' }, env)
  await addAccount('trae', { token: `Cloud-IDE-JWT ${jwt({ data: { id: '222' }, exp })}`, name: '小号' }, env)
  await addAccount('trae', { token: jwt({ data: { id: '333' }, exp }), name: '同事' }, env)
  const trae = createTraeProvider({ env: { ...env, TRAE_PLATFORM: 'linux' } })
  const account = await trae.account()
  assert.equal(account.accounts, 3, '本机 111 + 手动 222、333')
  assert.match(account.label, /3 个账号/)
  await rm(dir, { recursive: true, force: true })
})

// ── OfficeAce（华为云）：移植自 dsh-model ──

const fakeCred = (over = {}) => ({
  access: 'AK', secret: 'SK', securityToken: 'ST', projectId: 'p1',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(), refreshToken: 'rt-1',
  dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' }, ...over,
})

test('OfficeAce：APIG 签名格式（和 dsh-model 一致）', () => {
  const h = signApic('POST', 'https://officeace.cn-southwest-2.huaweicloud-agentarts.com/v1/subscription/bonus/claim', fakeCred(), undefined, new Date('2026-11-26T03:04:05Z'))
  assert.match(h.Authorization, /^V11-HMAC-SHA256 Credential=AK\/20261126\/cn-southwest-2\/apic, SignedHeaders=content-type;host;x-project-id;x-sdk-date;x-security-token;x-subscription-type, Signature=[0-9a-f]{64}$/)
  assert.equal(h['X-Sdk-Date'], '20261126T030405Z')
  assert.equal(h['X-Project-ID'], 'p1')
  assert.equal(h.Host, undefined, 'Host 参与签名但不手动发')
})

test('OfficeAce：领取接口的返回 → 签上 / 已领 / 登录失效', async (t) => {
  const real = globalThis.fetch
  t.after(() => { globalThis.fetch = real })
  const reply = (status, body) => { globalThis.fetch = async () => new Response(body, { status }) }
  reply(200, JSON.stringify({ bonus_skus: [{ points: 600 }, { points: 400 }] }))
  assert.deepEqual(await officeAceClaim(fakeCred()), { state: 'signed', credit: 1000 })
  reply(200, '')
  assert.deepEqual(await officeAceClaim(fakeCred()), { state: 'already' })
  reply(401, 'no')
  await assert.rejects(officeAceClaim(fakeCred()), OfficeAceAuthError)
  await assert.rejects(refreshOfficeAce(fakeCred({ refreshToken: '' })), OfficeAceAuthError)
})

test('OfficeAce：多账号——快到期的先续期并立刻写回自己那份，失效的标成要重新登录，互不影响', async () => {
  const { dir, env } = await tempEnv()
  await addAccount('officeace', { name: '快到期', cred: fakeCred({ expiresAt: new Date(Date.now() + 60_000).toISOString(), refreshToken: 'old' }) }, env)
  await addAccount('officeace', { name: '正常', cred: fakeCred({ projectId: 'p2' }) }, env)
  await addAccount('officeace', { name: '失效', cred: fakeCred({ projectId: 'p3' }) }, env)
  const refreshed = []
  const officeace = createOfficeAceProvider({
    env,
    fetchImpl: {
      refresh: async (c) => { refreshed.push(c.refreshToken); return { ...c, refreshToken: 'new', expiresAt: new Date(Date.now() + 86400_000).toISOString() } },
      claim: async (c) => {
        if (c.projectId === 'p3') throw new OfficeAceAuthError('OfficeAce 登录已失效（HTTP 401）')
        return c.projectId === 'p1' ? { state: 'signed', credit: 100 } : { state: 'already' }
      },
    },
  })
  const r = await officeace.run()
  assert.equal(r.ok, true)
  assert.deepEqual(refreshed, ['old'], '只有快到期的那个续期')
  assert.deepEqual(r.perAccount.map(p => [p.label, p.outcome]), [
    ['快到期', OUTCOME.CLAIMED], ['正常', OUTCOME.ALREADY], ['失效', OUTCOME.NEEDS_LOGIN],
  ])
  const saved = await listAccounts('officeace', env)
  assert.equal(saved.find(a => a.name === '快到期').cred.refreshToken, 'new', '一次性的 refresh token 换完马上存')
  assert.equal(saved.find(a => a.name === '正常').cred.refreshToken, 'rt-1', '别的账号不动')
  await rm(dir, { recursive: true, force: true })
})
