// lib/scheduler.js — 每个服务每天到点签一次
//
// 不用系统 crontab：插件在 DSH 里跑着就够了（DSH 是常驻的），用 setTimeout 算到下一个 HH:MM。
// 每 60 秒核对一次「今天签了没」，所以：
//   - 电脑睡过了签到时间，醒来会补（catchUp）
//   - DSH 半夜才启动，也会补
//   - 手动签过之后不会重复签
// 定时器都 unref()，不阻止 DSH 退出。
//
// 多服务：每个服务有自己的「今天」（MiniMax 按本机时区，灵犀按北京时间）和自己的开关/时间，
// 所以按服务分别判断到点没、签过没。

import { claimedToday, providerConfig } from './store.js'

const TICK_MS = 60_000

/** 下一次 HH:MM 的时间戳（本机时区）；已过则返回明天 */
export function nextRunAt(time, now = new Date()) {
  const [hour, minute] = String(time || '09:00').split(':').map(Number)
  const target = new Date(now)
  target.setHours(Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 0, 0, 0)
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  return target
}

/** 现在到点了吗（今天的时间已过） */
export function isDue(time, now = new Date()) {
  const [hour, minute] = String(time || '09:00').split(':').map(Number)
  const target = new Date(now)
  target.setHours(Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 0, 0, 0)
  return now.getTime() >= target.getTime()
}

/** 今天 HH:MM 对应的时间戳 */
function dueAt(time, now = new Date()) {
  const [hour, minute] = String(time || '09:00').split(':').map(Number)
  const target = new Date(now)
  target.setHours(Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 0, 0, 0)
  return target
}

/**
 * 启动调度器。
 * @param {object} options
 * @param {() => Promise<object>} options.config 取当前设置
 * @param {() => Promise<object>} options.state 取当前状态
 * @param {(ids: string[], opts: object) => Promise<object[]>} options.run 执行签到
 * @param {() => Array<{id:string}>} options.providers 有哪些服务
 * @param {(id: string) => Promise<string>} [options.dayOf] 某服务的「今天」
 * @param {(msg: string, level?: string) => void} [options.log]
 * @param {(results: object[]) => void} [options.onResult] 签完的回调
 */
export function createScheduler({ config, state, run, providers, dayOf, log = () => {}, onResult = () => {} }) {
  let timer = null
  let stopped = false
  let running = null
  /** 今天已经自动签过的服务（避免同一分钟里反复触发） */
  const doneToday = new Map()

  const clear = () => {
    if (timer) { clearTimeout(timer); timer = null }
  }

  const schedule = async () => {
    clear()
    if (stopped) return
    const cfg = await config()
    // 有任何服务开着就继续轮询
    const anyOn = (providers() || []).some(p => providerConfig(cfg, p.id).enabled)
    if (!anyOn) return
    timer = setTimeout(() => { void tick() }, TICK_MS)
    timer.unref?.()
  }

  /** 一次检查：哪些服务到点了、今天还没签，就签它们 */
  const tick = async () => {
    if (stopped) return
    try {
      const cfg = await config()
      const st = await state()
      const now = new Date()
      const due = []
      for (const provider of providers() || []) {
        const own = providerConfig(cfg, provider.id)
        if (!own.enabled) continue
        if (!isDue(own.time, now)) continue
        // catchUp 关掉时，只在时间点后 30 分钟内签
        if (!own.catchUp && now.getTime() - dueAt(own.time, now).getTime() > 30 * 60_000) continue
        // 这个服务自己的「今天」
        const today = dayOf ? await dayOf(provider.id) : null
        if (today && doneToday.get(provider.id) === today) continue
        // 手动/App 里已经签过的不重复
        if (claimedToday(st, provider.id, cfg.timeZone || '')) {
          if (today) doneToday.set(provider.id, today)
          continue
        }
        due.push({ id: provider.id, today })
      }
      if (!due.length) return
      const results = await fire('auto', due.map(d => d.id))
      for (const d of due) if (d.today) doneToday.set(d.id, d.today)
      onResult(results)
    } catch (error) {
      log(`dsh-checkin-all: 定时检查失败 ${error.message}`, 'warn')
    } finally {
      void schedule()
    }
  }

  const fire = async (trigger, only = null) => {
    if (running) return running
    running = (async () => {
      try {
        return await run(only, { trigger })
      } finally {
        running = null
      }
    })()
    return running
  }

  return {
    start() {
      stopped = false
      // 启动后 8 秒先看一眼：别和 DSH 自己的启动抢资源
      const first = setTimeout(() => { void tick() }, 8_000)
      first.unref?.()
      void schedule()
    },
    stop() {
      stopped = true
      clear()
    },
    /** 手动签（可指定服务，不传就全部） */
    runNow(ids = null) {
      return fire('manual', ids)
    },
    /** 立刻重新算下一次时间（改了设置后调用） */
    reschedule: schedule,
    /** 现在在跑吗 */
    get busy() { return Boolean(running) },
    /** 某个服务今天是不是已经自动签过了 */
    doneTodayOf(id) {
      return doneToday.get(id) || ''
    },
  }
}
