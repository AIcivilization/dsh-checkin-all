// lib/runner.js — 一次签到：挑服务 → 拿凭据 → 看面板 → 需要就领 → 记账
//
// 多服务版：每个服务（MiniMax / 灵犀）都走同一套流程，结果分别记账。
// 存储结构见 lib/store.js：state.json 里按 provider id 分开存。

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
   * 给一个服务签一次。
   * @param {string} id 服务 id
   * @param {object} options
   */
  async run(id, { trigger = 'manual', dryRun = false } = {}) {
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
   * 一个失败不影响另一个；返回每个服务的结果。
   */
  async runAll({ trigger = 'auto', dryRun = false, only = null } = {}) {
    await this.ready()
    const results = []
    for (const provider of this.providers.list) {
      if (only && !only.includes(provider.id)) continue
      try {
        results.push(await this.run(provider.id, { trigger, dryRun }))
      } catch (error) {
        results.push(failure(provider.id, error, { trigger }))
      }
    }
    return results
  }

  // ── 登录（只有 MiniMax 支持脚本化登录） ──

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
