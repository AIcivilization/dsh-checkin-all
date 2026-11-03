// lib/server.js — 面板用的 HTTP 接口（多服务）
//
// 挂在 DSH 自己的 webServer 上（前缀 /api-dsh-checkin-all）。DSH 的插件路由不会自动过登录校验，
// 所以每个请求先问 connection.requestRejection()（Host/Origin 防 DNS 重绑定与跨站，再查登录令牌）；
// 老版本没有这个服务就只放行本机回环地址。
//
// 会改东西的请求一律 POST + JSON，并且要带自定义头 x-dsh-checkin-all：别的网站发不出带自定义头的跨站请求（要预检）。
//
// 路由：
//   GET  /status                所有服务概览（索引卡片用）
//   GET  /signin?id=            某个服务的签到表
//   POST /checkin {id?}         签到（不传 id 就全签）
//   GET  /config · POST /config 设置
//   POST /login/start|wait|cancel?id=   登录（只有 MiniMax 支持）
//
// /panel-data 是 /signin 的旧别名。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { recentDays, loadConfig, loadState, saveConfig, claimedToday, providerConfig } from './store.js'
import { localTimeZone } from './signin.js'

const MAX_BODY = 64 * 1024

export function isLoopback(ip) {
  if (ip === undefined || ip === null) return true
  return /^(127\.|::1$|::ffff:127\.)/.test(String(ip))
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { req.destroy(); resolve({}) } else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/** 静态文件（面板）：只放行白名单里的几个 */
const STATIC = {
  '/panel': ['web/panel.html', 'text/html; charset=utf-8'],
  '/panel.js': ['web/panel.js', 'text/javascript; charset=utf-8'],
  '/panel.css': ['web/panel.css', 'text/css; charset=utf-8'],
}

export function createHandler({ prefix, pkgRoot, runner, scheduler, version, log = () => {} }) {
  /** 会改东西的请求：必须 POST + JSON + 自定义头 */
  const isSafePost = (req) => {
    if (req.method !== 'POST') return false
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return false
    if (!req.headers['x-dsh-checkin-all']) return false
    const origin = req.headers.origin
    if (!origin) return true
    try { return new URL(origin).host === req.headers.host } catch { return false }
  }

  /**
   * 一个服务的完整状态（索引卡片 + 详情都用它）。
   *
   * `state.totalPoints` 是「插件自己记账累加的」（只算真领到的那几次），
   * `state.accountPoints` 是服务端返回的账户累计（灵犀的智点、搭子的积分、MiniMax 没有这个概念）。
   * 面板优先显示后者——前者只在「今天之前没记录」时才有意义，容易让人误以为没积分。
   */
  const providerStatus = async (id, meta, cfg, st) => {
    const own = providerConfig(cfg, id)
    const state = (st.providers && st.providers[id]) || {}
    let account
    try {
      account = await runner.account(id)
    } catch (error) {
      account = { loggedIn: false, label: '出错', detail: error.message, code: error.code }
    }
    // 按 provider 自己的时区算「今天」与最近记录（灵犀/搭子/AStudio 固定北京时间，
    // 和本地时区可能差一天），不能统一用 cfg.timeZone
    const tz = meta.timeZoneMode === 'fixed' ? (meta.timeZone || '') : (cfg.timeZone || '')
    return {
      ...meta,
      config: own,
      account,
      state: {
        streak: state.streak || 0,
        totalPoints: state.totalPoints || 0,
        // 服务端账户累计由 /signin 返回（面板详情里显示），这里不重复请求
        accountPoints: null,
        lastAttempt: state.lastAttempt || null,
        lastClaim: state.lastClaim || null,
        claimedToday: claimedToday(st, id, tz),
        recent: recentDays(st, id, 14, tz),
      },
    }
  }

  const status = async () => {
    const cfg = await loadConfig()
    const st = await loadState()
    const metas = runner.meta()
    const providers = []
    for (const meta of metas) {
      providers.push(await providerStatus(meta.id, meta, cfg, st))
    }
    return {
      version: typeof version === 'function' ? version() : version,
      config: cfg,
      timeZone: cfg.timeZone || localTimeZone(),
      providers,
      busy: scheduler ? scheduler.busy : false,
    }
  }

  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname.slice(prefix.length) || '/'
    const id = url.searchParams.get('id') || ''

    try {
      // 面板静态资源
      if (STATIC[path]) {
        const [rel, type] = STATIC[path]
        try {
          const buf = await readFile(join(pkgRoot, rel))
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
          return res.end(buf)
        } catch {
          return sendJson(res, 404, { error: `缺少 ${rel}` })
        }
      }

      if (path === '/status') return sendJson(res, 200, await status())

      if (path === '/checkin') {
        if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
        const body = await readJson(req)
        const target = typeof body.id === 'string' && body.id ? body.id : id
        try {
          if (target) {
            const result = await runner.run(target, { trigger: 'manual', dryRun: Boolean(body.dryRun) })
            return sendJson(res, 200, { ok: result.ok, result, status: await status() })
          }
          // 不指定就全部签
          const results = await runner.runAll({ trigger: 'manual', dryRun: Boolean(body.dryRun) })
          return sendJson(res, 200, { ok: results.every(r => r.ok), results, status: await status() })
        } catch (error) {
          return sendJson(res, 200, {
            ok: false,
            code: error.code || 'error',
            message: error.message,
            status: await status(),
          })
        }
      }

      // 签到表数据。/panel 已经被静态表占作面板 HTML，数据走 /signin
      if (path === '/signin' || path === '/panel-data') {
        try {
          const p = await runner.panel(id)
          return sendJson(res, 200, { ok: true, id, ...p })
        } catch (error) {
          return sendJson(res, 200, { ok: false, id, code: error.code || 'error', message: error.message })
        }
      }

      if (path === '/config') {
        if (req.method === 'GET') return sendJson(res, 200, await loadConfig())
        if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
        const body = await readJson(req)
        const next = await saveConfig(body)
        if (scheduler) scheduler.reschedule()
        return sendJson(res, 200, { ok: true, config: next })
      }

      if (path === '/login/start') {
        if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
        const info = await runner.loginStart(id || 'minimax')
        return sendJson(res, 200, { ok: true, ...info })
      }

      if (path === '/login/wait') {
        if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
        try {
          const info = await runner.loginWait(id || 'minimax')
          return sendJson(res, 200, info)
        } catch (error) {
          return sendJson(res, 200, { ok: false, code: error.code || 'error', message: error.message })
        }
      }

      if (path === '/login/cancel') {
        runner.cancelLogin(id || 'minimax')
        return sendJson(res, 200, { ok: true })
      }

      return sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      log(`dsh-checkin-all: ${path} 出错 ${error.message}`, 'warn')
      return sendJson(res, 200, { ok: false, code: error.code || 'error', message: error.message })
    }
  }
}
