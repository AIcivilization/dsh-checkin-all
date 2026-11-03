// plugin/index.js — dsh-checkin-all 的 DSH 插件（宿主端）
//
// 做三件事：
//   1. 每天到点自动给 MiniMax Code 签到（lib/scheduler.js），签完记一笔（lib/store.js）
//   2. 把状态面板挂到 DSH 的 webServer（/api-dsh-checkin-all/*）+ 对话页右侧栏 + 设置页
//   3. 注册 AI 工具：对话里说「帮我签到」「以后每天 8 点签」就能用
//
// 用的是 MiniMax Code 自己已经存好的登录凭据（~/.minimax/auth/...），不碰账号密码。
// access token 快过期时用 refresh token 自动续期并写回，App 那边不受影响。
//
// 可选配置（profile 的 cordis.patch.yml 里给 id: dsh-checkin-all 加 config）：
//   enabled      是否自动签到，默认 true
//   time         每天几点签，HH:MM，默认 09:00
//   timeZone     时区覆盖，默认跟随本机
//   catchUp      过了时间才开机是否补签，默认 true
//   notify       签完是否提示，默认 true

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Runner } from '../lib/runner.js'
import { createScheduler } from '../lib/scheduler.js'
import { createHandler, isLoopback } from '../lib/server.js'
import { loadConfig, loadState, saveConfig, providerConfig, DEFAULT_CONFIG } from '../lib/store.js'
import { buildToolDefinitions } from './tools.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const PREFIX = '/api-dsh-checkin-all'

export const name = 'dsh-checkin-all'

async function readPkgJson() {
  try { return JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8')) } catch { return {} }
}

export function apply(ctx, config = {}) {
  const cfg = config || {}
  // 版本号异步读，读到了才填：接口每次现取，别在启动瞬间返回空串
  let version = ''
  const versionReady = readPkgJson().then(pkg => { version = pkg.version || '' })

  const log = (message, level = 'info') => {
    try {
      if (ctx.logger && typeof ctx.logger[level] === 'function') ctx.logger[level](message)
      else console[level === 'warn' ? 'warn' : 'log'](message)
    } catch { /* 日志不该影响签到 */ }
  }

  // 插件配置里的值当作默认值（用户没在面板里改过时生效）
  const seedConfig = async () => {
    const current = await loadConfig()
    const patch = {}
    if (typeof cfg.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.time) && current.time === DEFAULT_CONFIG.time) {
      patch.time = cfg.time
    }
    if (typeof cfg.enabled === 'boolean' && current.enabled === DEFAULT_CONFIG.enabled) patch.enabled = cfg.enabled
    if (typeof cfg.catchUp === 'boolean' && current.catchUp === DEFAULT_CONFIG.catchUp) patch.catchUp = cfg.catchUp
    if (typeof cfg.notify === 'boolean' && current.notify === DEFAULT_CONFIG.notify) patch.notify = cfg.notify
    if (typeof cfg.timeZone === 'string' && cfg.timeZone && !current.timeZone) patch.timeZone = cfg.timeZone
    if (Object.keys(patch).length) await saveConfig(patch)
  }

  const runner = new Runner({ log })

  const scheduler = createScheduler({
    config: () => loadConfig(),
    state: () => loadState(),
    providers: () => runner.meta(),
    dayOf: id => runner.dayOf(id),
    run: (only, { trigger }) => runner.runAll({ trigger, only }),
    log,
    onResult: (results) => {
      const claimed = (results || []).filter(r => r && r.ok && r.outcome === 'claimed')
      if (!claimed.length) return
      // 签完在 DSH 里说一句（拿得到提示服务就说，拿不到只写日志）
      try {
        void loadConfig().then((c) => {
          if (!c.notify) return
          const notice = ctx.get && ctx.get('notifications')
          if (notice && typeof notice.notify === 'function') {
            const body = claimed.map(r => {
              const meta = runner.meta().find(m => m.id === r.provider)
              return `${meta ? meta.short : r.provider}：${r.message}`
            }).join('\n')
            notice.notify({ title: '自动签到', body })
          }
        })
      } catch { /* 没有提示服务就算了 */ }
    },
  })

  ctx.effect(() => {
    void seedConfig()
      .then(() => {
        scheduler.start()
        return loadConfig()
      })
      .then((c) => {
        const names = runner.meta().map(m => m.short).join(' / ')
        log(`dsh-checkin-all: ${names} 自动签到${c.enabled ? `每天 ${c.time}` : '已关闭'}`)
      })
      .catch(error => log(`dsh-checkin-all: 启动失败 ${error.message}`, 'warn'))
    return () => scheduler.stop()
  })

  // ── 面板接口 ──
  let connection
  ctx.inject(['connection'], (c) => {
    c.effect(() => {
      connection = c.connection || (c.get && c.get('connection'))
      return () => { connection = undefined }
    })
  })

  const rejected = (req, res) => {
    let code
    if (connection && typeof connection.requestRejection === 'function') code = connection.requestRejection(req)
    else if (!isLoopback(req.socket && req.socket.remoteAddress)) code = 403
    if (code === undefined) return false
    res.statusCode = code
    res.end()
    return true
  }

  ctx.inject(['webServer'], (c) => {
    const ws = c.webServer || (c.get && c.get('webServer'))
    if (!ws || typeof ws.register !== 'function') return
    const handle = createHandler({
      prefix: PREFIX,
      pkgRoot: PKG_ROOT,
      runner,
      scheduler,
      version: () => version,
      log,
    })
    const guarded = (req, res) => (rejected(req, res) ? undefined : handle(req, res))
    const register = () => ws.register({ kind: 'prefix', path: PREFIX, handler: guarded })
    if (typeof c.effect === 'function') c.effect(register)
    else register()
  })

  // ── AI 工具 ──
  ctx.inject(['tools'], (c) => {
    const tools = c.tools || (c.get && c.get('tools'))
    if (!tools || typeof tools.register !== 'function') return
    buildToolDefinitions({
      runner,
      scheduler,
      config: () => loadConfig(),
      state: () => loadState(),
      providerConfig,
    }).then((definitions) => {
      const register = () => {
        for (const definition of definitions) tools.register(definition)
      }
      if (typeof c.effect === 'function') c.effect(register)
      else register()
    }).catch(error => log(`dsh-checkin-all: AI 工具注册失败 ${error.message}`, 'warn'))
  })

  // ── 命令：/checkin（/minimax 留作别名） ──
  ctx.inject(['commands'], (c) => {
    const commands = c.commands || (c.get && c.get('commands'))
    if (!commands || typeof commands.register !== 'function') return

    const usage = '/checkin [状态|签到 [服务]|时间 HH:MM|开启|关闭|登录]'
    const handler = async ({ rawInput }) => {
      const arg = String(rawInput || '').trim()
      const metas = runner.meta()
      const findProvider = (text) => metas.find(m =>
        text && (text === m.id || text === m.short || text === m.name
          || m.name.toLowerCase().includes(text.toLowerCase())
          || m.short.includes(text)))
      try {
        if (!arg || /^(状态|status)$/i.test(arg)) {
          const cfg2 = await loadConfig()
          const st = await loadState()
          const lines = []
          for (const meta of metas) {
            const own = providerConfig(cfg2, meta.id)
            const account = await runner.account(meta.id).catch(e => ({ loggedIn: false, detail: e.message }))
            const ps = (st.providers && st.providers[meta.id]) || {}
            lines.push(`${meta.name}${own.enabled ? ` · 每天 ${own.time}` : ' · 已关闭'}`)
            lines.push(`  登录：${account.loggedIn ? account.label : '未登录'}${account.detail ? `（${account.detail}）` : ''}`)
            lines.push(`  连续 ${ps.streak || 0} 天，累计 ${ps.totalPoints || 0} ${meta.unit}`)
            if (ps.lastAttempt) lines.push(`  最近：${ps.lastAttempt.message}`)
          }
          return { kind: 'success', text: lines.join('\n') }
        }
        if (/^(签到|签|checkin|check|sign)$/i.test(arg) || arg.startsWith('签到')) {
          const target = findProvider(arg.replace(/^(签到|签|checkin|check|sign)\s*/i, '').trim())
          if (target) {
            const result = await runner.run(target.id, { trigger: 'manual' })
            return { kind: result.ok ? 'success' : 'error', text: `${target.short}：${result.message}` }
          }
          const results = await runner.runAll({ trigger: 'manual' })
          return {
            kind: results.every(r => r.ok) ? 'success' : 'error',
            text: results.map(r => {
              const meta = metas.find(m => m.id === r.provider)
              return `${meta ? meta.short : r.provider}：${r.message}`
            }).join('\n'),
          }
        }
        if (/^(开启|打开|on|enable)$/i.test(arg)) {
          await saveConfig({ enabled: true, providers: null })
          scheduler.reschedule()
          return { kind: 'success', text: '全部服务自动签到已开启' }
        }
        if (/^(关闭|关|off|disable)$/i.test(arg)) {
          await saveConfig({ enabled: false, providers: null })
          scheduler.reschedule()
          return { kind: 'success', text: '全部服务自动签到已关闭' }
        }
        const timeMatch = arg.match(/^(?:时间\s*)?([01]?\d|2[0-3]):([0-5]\d)$/)
        if (timeMatch) {
          const time = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`
          await saveConfig({ time, providers: null })
          scheduler.reschedule()
          return { kind: 'success', text: `全部服务自动签到时间改为每天 ${time}` }
        }
        if (/^(登录|login)$/i.test(arg)) {
          const info = await runner.loginStart('minimax')
          void runner.loginWait('minimax', { timeoutMs: info.expiresInSec * 1000 }).catch(() => {})
          return {
            kind: 'success',
            text: `在浏览器打开 ${info.verificationUri}\n设备码：${info.userCode}\n（或直接打开 ${info.verificationUriComplete}）`,
          }
        }
        return { kind: 'error', text: `用法：${usage}` }
      } catch (error) {
        return { kind: 'error', text: `出错了：${error.message}` }
      }
    }

    const register = () => {
      const a = commands.register({
        name: 'checkin',
        description: '自动签到：看状态、立刻签、改时间、登录（MiniMax Code / WPS 灵犀）',
        input: { hint: '[状态|签到 [服务]|时间 HH:MM|开启|关闭|登录]' },
        handler,
      })
      // 老名字继续能用
      const b = commands.register({
        name: 'minimax',
        description: '自动签到（/checkin 的别名）',
        input: { hint: '[状态|签到|时间 HH:MM|开启|关闭|登录]' },
        handler,
      })
      return () => { a?.(); b?.() }
    }
    if (typeof c.effect === 'function') c.effect(register)
    else register()
  })

  log('dsh-checkin-all: 插件已加载')
}

export default { name, apply, PREFIX, __meta: { pkgRoot: PKG_ROOT } }
