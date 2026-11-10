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
import { CHECKIN_TZ } from './tz.js'
import { setManual, getManual, loadManual, loadQoders, addQoder, removeQoder, loadDoubaos, addDoubao, removeDoubao, listAccounts, addAccount, removeAccount } from './checkin-secrets.js'
import { exchangePat, QODER_REGIONS } from './providers/qoder.js'
import { readLocalDoubaoCookie } from './providers/doubao.js'
import {
  loadCustomServices, upsertCustomService, removeCustomService, buildAddServicePrompt, BUILTIN_IDS,
} from './custom-services.js'

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

export function createHandler({ prefix, pkgRoot, runner, scheduler, version, log = () => {}, env = process.env }) {
  /** 读某个服务的手动凭据（没有就当空对象，别让调用方处理 null） */
  const getManualOrEmpty = async (provider) => {
    const entry = await getManual(provider, env)
    return entry && typeof entry === 'object' ? entry : {}
  }

  /** 会改东西的请求：必须 POST + JSON + 自定义头 */
  const isSafePost = (req) => {
    if (req.method !== 'POST' && req.method !== 'DELETE') return false
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
    // 按 provider 自己的时区算「今天」与最近记录。现在已经全部统一北京时间，
    // tz 传空串即可（dayKey / recentDays 内部固定按北京算）
    const tz = meta.timeZoneMode === 'fixed' ? (meta.timeZone || '') : (cfg.timeZone || '')
    return {
      ...meta,
      config: own,
      account,
      state: {
        streak: state.streak || 0,
        // 本地只记「插件自己签到的那些」，口径窄；面板以 accountPoints 为准
        totalPoints: state.totalPoints || 0,
        // 服务端账户累计由 /signin 返回（面板详情里显示），这里不重复请求
        accountPoints: null,
        serverStreak: state.serverStreak ?? null,
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
    const metas = runner.metaAsync ? await runner.metaAsync() : runner.meta()
    const providers = []
    for (const meta of metas) {
      providers.push(await providerStatus(meta.id, meta, cfg, st))
    }
    return {
      version: typeof version === 'function' ? version() : version,
      config: cfg,
      timeZone: CHECKIN_TZ,
      timeZoneMode: 'fixed',
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
        const region = url.searchParams.get('region') || ''
        const info = await runner.loginStart(id || 'minimax', region ? { region } : {})
        return sendJson(res, 200, { ok: true, ...info })
      }

      if (path === '/login/wait') {
        if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
        const region = url.searchParams.get('region') || ''
        try {
          const info = await runner.loginWait(id || 'minimax', region ? { region } : {})
          return sendJson(res, 200, info)
        } catch (error) {
          return sendJson(res, 200, { ok: false, code: error.code || 'error', message: error.message })
        }
      }

      if (path === '/login/cancel') {
        runner.cancelLogin(id || 'minimax')
        return sendJson(res, 200, { ok: true })
      }

      // 豆包 Cookie：和别的服务结构不同（doubaos[]，多账号），单独一组路由
      if (path === '/doubao') {
        if (req.method === 'GET') {
          const list = await loadDoubaos(env)
          // 不回传完整 Cookie：面板只需要知道「配了没有、是哪个账号」。
          // 真要重新配就让用户重新粘贴，没必要时把凭据摆在前端内存里。
          return sendJson(res, 200, {
            ok: true,
            doubaos: list.map(d => ({
              id: d.id,
              name: d.name || '',
              from: d.from || '',
              savedAt: d.savedAt || '',
              cookieLength: String(d.cookie || '').length,
            })),
          })
        }
        if (req.method === 'DELETE') {
          if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
          const done = await removeDoubao(id || undefined, env)
          return sendJson(res, 200, { ok: done, id })
        }
        if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
        const body = await readJson(req)
        // 从本机豆包电脑版 / 浏览器读 Cookie（macOS 可能弹钥匙串授权）
        if (body.fromLocal === true) {
          try {
            const found = await readLocalDoubaoCookie()
            if (!found) return sendJson(res, 200, { ok: false, code: 'DOUBAO_NOT_FOUND', message: '这台电脑上没找到登录着的豆包：先在豆包或浏览器里登录 doubao.com' })
            const newId = await addDoubao({ cookie: found.cookie, from: found.label, ...(body.name ? { name: String(body.name) } : {}) }, env)
            return sendJson(res, 200, { ok: true, id: newId, from: found.label })
          } catch (error) {
            return sendJson(res, 200, { ok: false, code: error.code || 'DOUBAO_SCAN_FAILED', message: error.message })
          }
        }
        const cookie = String(body.cookie || '').trim()
        if (!cookie) return sendJson(res, 200, { ok: false, code: 'DOUBAO_NO_COOKIE', message: '请粘贴豆包 Cookie' })
        const newId = await addDoubao({ cookie, ...(body.name ? { name: String(body.name) } : {}) }, env)
        return sendJson(res, 200, { ok: true, id: newId })
      }

      // 自定义签到服务：GET 列表 / POST 导入（JSON 定义）/ DELETE 删除
      // POST { prompt: true } 时返回「让 AI 帮我做」的提示词
      if (path === '/custom') {
        if (req.method === 'GET') {
          const list = await loadCustomServices(env)
          return sendJson(res, 200, {
            ok: true,
            services: list.map((d) => ({
              id: d.id, name: d.name, short: d.short, color: d.color, unit: d.unit,
              addedAt: d.addedAt || '',
              checkin: { method: d.checkin && d.checkin.method, url: d.checkin && d.checkin.url },
              hasStatus: Boolean(d.status && d.status.url),
            })),
          })
        }
        if (req.method === 'DELETE') {
          if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
          const cid = url.searchParams.get('id') || ''
          const done = await removeCustomService(cid, env)
          if (done && runner.reload) await runner.reload()
          return sendJson(res, 200, { ok: done, id: cid })
        }
        if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
        const body = await readJson(req)

        // 要提示词
        if (body.prompt === true) {
          const existing = await loadCustomServices(env)
          return sendJson(res, 200, {
            ok: true,
            prompt: buildAddServicePrompt({
              existingIds: [...BUILTIN_IDS, ...existing.map((s) => s.id)],
            }),
          })
        }

        // 导入定义（支持直接给对象，或者粘贴的整段文本）
        let raw = body.service
        if (typeof body.text === 'string') {
          const m = body.text.match(/\{[\s\S]*\}/)
          if (!m) return sendJson(res, 200, { ok: false, code: 'CUSTOM_BAD_JSON', message: '没找到 JSON，把 AI 给的那段 { … } 整段粘进来' })
          try { raw = JSON.parse(m[0]) } catch (e) {
            return sendJson(res, 200, { ok: false, code: 'CUSTOM_BAD_JSON', message: `JSON 解析失败：${e.message.slice(0, 80)}` })
          }
        }
        try {
          const saved = await upsertCustomService(raw, env)
          if (runner.reload) await runner.reload()
          return sendJson(res, 200, { ok: true, id: saved.id, service: saved })
        } catch (error) {
          return sendJson(res, 200, { ok: false, code: error.code || 'CUSTOM_INVALID', message: error.message })
        }
      }

      // 通用多账号管理：GET 列表 / POST 新增或更新 / DELETE 删除
      // 各服务的凭据字段不同，这里只做「存什么就回什么（脱敏）」的通用层，
      // 字段校验交给各 provider。
      if (path === '/accounts') {
        const provider = url.searchParams.get('provider') || ''
        if (!provider) return sendJson(res, 200, { ok: false, message: '缺少 provider 参数' })

        if (req.method === 'GET') {
          const list = await listAccounts(provider, env)
          return sendJson(res, 200, {
            ok: true,
            provider,
            accounts: list.map(a => {
              // 脱敏：只回「哪些字段有值」，不回原文
              const fields = {}
              for (const [k, v] of Object.entries(a)) {
                if (k === 'id' || k === 'name' || k === 'savedAt' || k === 'from') continue
                if (v === undefined || v === null || v === '') continue
                fields[k] = { present: true, length: String(v).length }
              }
              return { id: a.id, name: a.name || '', savedAt: a.savedAt || '', fields }
            }),
          })
        }

        if (req.method === 'DELETE') {
          if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
          const accountId = url.searchParams.get('id') || ''
          const done = await removeAccount(provider, accountId, env)
          return sendJson(res, 200, { ok: done, provider, id: accountId })
        }

        if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
        const body = await readJson(req)
        const entry = body.entry && typeof body.entry === 'object' ? body.entry : null
        if (!entry) return sendJson(res, 200, { ok: false, message: '缺少 entry' })
        const record = await addAccount(provider, entry, env)
        return sendJson(res, 200, { ok: true, provider, id: record.id })
      }

      // WorkBuddy：多账号，存在 manual.buddy.accounts[]
      if (path === '/buddy') {
        if (req.method === 'GET') {
          const manual = await getManualOrEmpty('buddy')
          const accounts = Array.isArray(manual.accounts) ? manual.accounts : []
          return sendJson(res, 200, {
            ok: true,
            accounts: accounts.map(a => ({ region: a.region || 'cn', name: a.name || '', tokenTail: String(a.access_token || '').slice(-4) })),
          })
        }
        if (req.method === 'DELETE') {
          if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
          const idx = Number(url.searchParams.get('index'))
          const manual = await getManualOrEmpty('buddy')
          const accounts = Array.isArray(manual.accounts) ? [...manual.accounts] : []
          if (!Number.isInteger(idx) || idx < 0 || idx >= accounts.length) {
            return sendJson(res, 200, { ok: false, message: '账号不存在' })
          }
          accounts.splice(idx, 1)
          if (accounts.length) await setManual('buddy', { accounts }, env)
          else await setManual('buddy', null, env)
          return sendJson(res, 200, { ok: true })
        }
        if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
        const body = await readJson(req)
        const token = String(body.token || '').trim().replace(/^Bearer\s+/i, '')
        if (!token || token.length < 8) {
          return sendJson(res, 200, { ok: false, code: 'BUDDY_NO_TOKEN', message: '请粘贴 access_token（Bearer 后面那串）' })
        }
        const region = body.region === 'intl' ? 'intl' : 'cn'
        const manual = await getManualOrEmpty('buddy')
        const accounts = Array.isArray(manual.accounts) ? [...manual.accounts] : []
        const entry = { region, access_token: token, ...(body.name ? { name: String(body.name).slice(0, 20) } : {}) }
        const same = accounts.findIndex(a => a && a.access_token === token)
        if (same >= 0) accounts[same] = entry
        else accounts.push(entry)
        await setManual('buddy', { accounts }, env)
        return sendJson(res, 200, { ok: true })
      }

      // 手动凭据：GET 读（脱敏），POST 写，DELETE 删
      if (path === '/credential') {
        if (req.method === 'GET') {
          const manual = await loadManual(env)
          const meta = { ...manual }
          // 脱敏：不把 token/cookie 原样回传，只告诉「有没有配置」
          for (const key of Object.keys(meta)) {
            const v = meta[key]
            if (v && typeof v === 'object') {
              meta[key] = { configured: true, ...Object.fromEntries(Object.entries(v).map(([k, val]) => [k, val === undefined ? false : String(val).length > 0])) }
            }
          }
          return sendJson(res, 200, { ok: true, manual: meta })
        }
        if (req.method === 'DELETE') {
          if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
          await setManual(id, null, env)
          return sendJson(res, 200, { ok: true, id })
        }
        if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
        const body = await readJson(req)
        await setManual(id, body.entry || body, env)
        return sendJson(res, 200, { ok: true, id })
      }

      // Qoder：GET 列表（脱敏），POST 添加（验证 PAT），DELETE 删除
      if (path === '/qoder') {
        if (req.method === 'GET') {
          const qoders = await loadQoders(env)
          return sendJson(res, 200, {
            ok: true,
            qoders: qoders.map((q) => ({ id: q.id, region: q.region, name: q.name || '', savedAt: q.savedAt || '' })),
            regions: QODER_REGIONS,
          })
        }
        if (req.method === 'DELETE') {
          if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
          await removeQoder(id || undefined, env)
          return sendJson(res, 200, { ok: true, id })
        }
        if (!isSafePost(req)) return sendJson(res, 403, { ok: false, message: '只接受本页面发出的请求' })
        const body = await readJson(req)
        const pat = String(body.pat || '').trim()
        const region = body.region === 'intl' ? 'intl' : 'cn'
        const name = String(body.name || '').trim().slice(0, 20)
        if (!pat || /\s/.test(pat) || pat.length < 8) {
          return sendJson(res, 200, { ok: false, code: 'QODER_INVALID_PAT', message: '这看起来不是 Qoder 的个人访问令牌' })
        }
        try {
          await exchangePat(pat, region) // 换得到短期 token 才算可用
        } catch (error) {
          return sendJson(res, 200, { ok: false, code: 'QODER_AUTH', message: error.message })
        }
        const id2 = await addQoder({ pat, region, ...(name ? { name } : {}) }, env)
        return sendJson(res, 200, { ok: true, id: id2 })
      }

      return sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      log(`dsh-checkin-all: ${path} 出错 ${error.message}`, 'warn')
      return sendJson(res, 200, { ok: false, code: error.code || 'error', message: error.message })
    }
  }
}
