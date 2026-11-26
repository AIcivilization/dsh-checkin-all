// lib/runner.js — 一次签到：挑服务 → 拿凭据 → 看面板 → 需要就领 → 记账
//
// 多服务版：每个服务（MiniMax / 灵犀）都走同一套流程，结果分别记账。
// 存储结构见 lib/store.js：state.json 里按 provider id 分开存。
//
// 并发规则（多账号、多入口同时签也互不冲突）：
//   - 同一个服务同一时刻只跑一次：定时器、面板按钮、AI 工具同时要签，后来的直接等前一次的结果；
//     另一个进程（终端里的 dsh-checkin-all）也在签这个服务，就等它签完（锁文件）。
//     这样一次性的续期令牌不会被并发用两次，同一个账号也不会被重复领。
//   - 不同服务之间并行（默认最多 4 个，DSH_CHECKIN_ALL_CONCURRENCY 可调）。
//   - 同一个服务的多个账号在 provider 里逐个签：同一个 IP 短时间内并发打同一家的接口容易触发风控。

import { join } from 'node:path'
import { mapLimit, serialized, withFileLock } from './lock.js'
import { pluginHome } from './paths.js'
import { createProviders, createProvidersAsync } from './providers/index.js'
import { failure } from './providers/base.js'
import { loadConfig, recordAttempt, saveConfig } from './store.js'
import { CHECKIN_TZ, beijingDayKey } from './tz.js'

export class Runner {
  constructor({ log = () => {}, env = process.env } = {}) {
    this.log = log
    this.env = env
    // 先用内置服务顶上，异步加载自定义服务后再替换
    this.providers = createProviders({ log, config: () => this.config(), env })
    this._ready = null
    /** 正在跑的签到：`${id}:${dryRun}` → Promise */
    this.inflight = new Map()
  }

  /** 同时最多签几个服务 */
  concurrency() {
    const n = Number(this.env.DSH_CHECKIN_ALL_CONCURRENCY)
    return Number.isInteger(n) && n > 0 ? Math.min(n, 16) : 4
  }

  /**
   * 确保自定义服务已加载。首次调用会读 custom-services.json，
   * 之后直接返回缓存的 promise。加/删自定义服务后调 reload()。
   */
  async ready() {
    if (!this._ready) {
      this._ready = createProvidersAsync({ log: this.log, config: () => this.config(), env: this.env })
        .then((p) => { this.providers = p; return p })
        .catch((error) => {
          this.log(`dsh-checkin-all: 加载自定义服务失败 ${error.message}`, 'warn')
          return this.providers
        })
    }
    return this._ready
  }

  /** 加/删自定义服务后重新加载注册表 */
  async reload() {
    this._ready = null
    return this.ready()
  }

  async config() {
    return loadConfig(this.env)
  }

  /** 改设置（面板和 AI 工具都走这里） */
  async saveConfig(patch) {
    return saveConfig(patch, this.env)
  }

  /** 本机时区——签到已统一按北京时间，这里只为兼容旧调用保留 */
  localTimeZone() {
    return CHECKIN_TZ
  }

  /** 所有服务的元信息（索引卡片用，不联网）。注意：不含自定义服务，除非已 ready */
  meta() {
    return this.providers.meta()
  }

  /** 同上，但会先加载自定义服务（面板/工具用这个） */
  async metaAsync() {
    await this.ready()
    return this.providers.meta()
  }

  /** 某个服务的账号信息 */
  async account(id) {
    await this.ready()
    const provider = this.providers.get(id)
    if (!provider) throw Object.assign(new Error(`未知的签到服务：${id}`), { code: 'UNKNOWN_PROVIDER' })
    return provider.account()
  }

  /** 所有服务的账号信息 */
  async accounts() {
    await this.ready()
    const out = {}
    for (const provider of this.providers.list) {
      try {
        out[provider.id] = await provider.account()
      } catch (error) {
        out[provider.id] = { loggedIn: false, label: '出错', detail: error.message, code: error.code }
      }
    }
    return out
  }

  /** 某个服务的签到表 */
  async panel(id) {
    await this.ready()
    const provider = this.providers.get(id)
    if (!provider) throw Object.assign(new Error(`未知的签到服务：${id}`), { code: 'UNKNOWN_PROVIDER' })
    return provider.panel()
  }

  /** 某个服务的「今天」：全部按北京时间 */
  async dayOf() {
    return beijingDayKey()
  }

  /**
   * 给一个服务签一次。同一个服务已经在签了，就等那一次的结果（不重复打接口）。
   * @param {string} id 服务 id
   * @param {object} options
   */
  run(id, { trigger = 'manual', dryRun = false } = {}) {
    const key = `${id}:${dryRun ? 'dry' : 'real'}`
    const running = this.inflight.get(key)
    if (running) return running
    const job = serialized(`run:${id}`, () => withFileLock(
      join(pluginHome(this.env), 'locks', `run-${String(id).replace(/[^\w.-]/g, '_')}.lock`),
      () => this.runUnlocked(id, { trigger, dryRun }),
      { timeoutMs: 5 * 60_000, staleMs: 15 * 60_000 },
    ))
    const tracked = job.finally(() => { if (this.inflight.get(key) === tracked) this.inflight.delete(key) })
    this.inflight.set(key, tracked)
    return tracked
  }

  async runUnlocked(id, { trigger = 'manual', dryRun = false } = {}) {
    await this.ready()
    const provider = this.providers.get(id)
    if (!provider) throw Object.assign(new Error(`未知的签到服务：${id}`), { code: 'UNKNOWN_PROVIDER' })
    const startedAt = Date.now()
    try {
      const result = await provider.run({ trigger, dryRun })
      await recordAttempt(id, result, this.env)
      return result
    } catch (error) {
      const day = await this.dayOf(id)
      const result = failure(id, error, {
        trigger,
        timeZone: provider.timeZone || '',
        day,
        elapsedMs: Date.now() - startedAt,
      })
      await recordAttempt(id, result, this.env)
      throw error
    }
  }

  /**
   * 所有服务都签一次（定时器用）。
   * 不同服务并行；一个失败不影响另一个；返回每个服务的结果（顺序同服务列表）。
   */
  async runAll({ trigger = 'auto', dryRun = false, only = null } = {}) {
    await this.ready()
    const targets = this.providers.list.filter((p) => !only || only.includes(p.id))
    return mapLimit(targets, this.concurrency(), async (provider) => {
      try {
        return await this.run(provider.id, { trigger, dryRun })
      } catch (error) {
        return failure(provider.id, error, { trigger })
      }
    })
  }

  // ── 登录（设备码 / 浏览器授权 / 弹出窗口，由各 provider 自己实现） ──

  async loginStart(id, options = {}) {
    await this.ready()
    const provider = this.providers.get(id)
    if (!provider || typeof provider.loginStart !== 'function') {
      throw Object.assign(new Error(`${id} 不支持在这里登录`), { code: 'NO_LOGIN' })
    }
    return provider.loginStart(options)
  }

  async loginWait(id, options) {
    await this.ready()
    const provider = this.providers.get(id)
    if (!provider || typeof provider.loginWait !== 'function') {
      throw Object.assign(new Error(`${id} 不支持在这里登录`), { code: 'NO_LOGIN' })
    }
    return provider.loginWait(options)
  }

  cancelLogin(id) {
    const provider = this.providers.get(id)
    if (provider && typeof provider.cancelLogin === 'function') provider.cancelLogin()
  }
}
