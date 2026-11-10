// lib/scheduler.js — 每个服务每天到点签一次
//
// 不用系统 crontab：插件在 DSH 里跑着就够了（DSH 是常驻的）。
// 每 60 秒核对一次「到点没 / 今天签了没」，所以：
//   - 电脑睡过了签到时间，醒来会补（catchUp）
//   - DSH 半夜才启动，也会补
//   - 手动签过之后不会重复签
// 定时器都 unref()，不阻止 DSH 退出。
//
// 「今天」和「到点没」一律按北京时间算，不跟随本机时区。
// 本机在美西时，晚上 8 点之后就已经是北京的第二天，跟着本机会错一天。
//
// 失败退避：同一个服务连续失败会逐次拉长重试间隔（1/2/4/8/16/32 分钟，封顶 60 分钟），
// 连续失败 6 次后当天不再重试——否则一个没登录的服务会被每天白试 1440 次。

import { claimedToday, providerConfig } from './store.js'
import { BENIGN_OUTCOMES, NEEDS_USER_OUTCOMES, OUTCOME } from './providers/base.js'
import { beijingDayKey, beijingMinutes, parseHHMM } from './tz.js'

const TICK_MS = 60_000
/** 连续失败这么多次，当天就不再试 */
const MAX_FAILURES = 6
/** 退避上限 */
const MAX_BACKOFF_MS = 60 * 60_000

/** 现在北京时间的分钟数 */
function nowMinutes(now = new Date()) {
  return beijingMinutes(now)
}

/** 现在到点了吗（北京时间的 HH:MM 已过） */
export function isDue(time, now = new Date()) {
  const target = parseHHMM(time)
  if (target === null) return nowMinutes(now) >= 9 * 60
  return nowMinutes(now) >= target
}

/** 今天 HH:MM 已过多少分钟 */
export function minutesPastDue(time, now = new Date()) {
  const target = parseHHMM(time)
  const t = target === null ? 9 * 60 : target
  return nowMinutes(now) - t
}

/**
 * 退避：连续失败 n 次后要等多久才再试
 * 0 次 → 0（立刻）、1 次 → 1 分钟、2 次 → 2 分钟、3 次 → 4 分钟 …
 */
export function backoffMs(failures = 0) {
  if (!failures || failures < 1) return 0
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (failures - 1))
}

/**
 * 启动调度器。
 * @param {object} options
 * @param {() => Promise<object>} options.config 取当前设置
 * @param {() => Promise<object>} options.state 取当前状态
 * @param {(ids: string[], opts: object) => Promise<object[]>} options.run 执行签到
 * @param {() => Array<{id:string}>} options.providers 有哪些服务
 * @param {(id: string) => Promise<string>} [options.dayOf] 某服务的「今天」（现在统一北京时间）
 * @param {(msg: string, level?: string) => void} [options.log]
 * @param {(results: object[]) => void} [options.onResult] 签完的回调
 */
export function createScheduler({ config, state, run, providers, dayOf, log = () => {}, onResult = () => {} }) {
  let timer = null
  let stopped = false
  let running = null
  /** 今天已经自动签过的服务（避免同一分钟里反复触发） */
  const doneToday = new Map()
  /** 每个服务的失败状态：{ day, failures, nextAt } */
  const failures = new Map()

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

  /** 这个服务现在能不能试（退避/当日放弃） */
  const canRetry = (id, today, now = Date.now()) => {
    const f = failures.get(id)
    if (!f || f.day !== today) return true
    if (f.failures >= MAX_FAILURES) return false
    return now >= f.nextAt
  }

  const noteFailure = (id, today, now = Date.now()) => {
    const f = failures.get(id)
    const failures_ = f && f.day === today ? f.failures + 1 : 1
    failures.set(id, { day: today, failures: failures_, nextAt: now + backoffMs(failures_) })
    if (failures_ === MAX_FAILURES) {
      log(`dsh-checkin-all: ${id} 今天已经连续失败 ${failures_} 次，今天不再试（明天到点会再来）`, 'warn')
    }
    return failures_
  }

  const noteSuccess = (id) => { failures.delete(id) }

  /** 一次检查：哪些服务到点了、今天还没签，就签它们 */
  const tick = async () => {
    if (stopped) return
    try {
      const cfg = await config()
      const st = await state()
      const now = new Date()
      const today = beijingDayKey(now)
      const due = []
      for (const provider of providers() || []) {
        const own = providerConfig(cfg, provider.id)
        if (!own.enabled) continue
        if (!isDue(own.time, now)) continue
        // catchUp 关掉时，只在时间点后 30 分钟内签
        if (!own.catchUp && minutesPastDue(own.time, now) > 30) continue
        // 这个服务今天已经处理过了
        if (doneToday.get(provider.id) === today) continue
        // 手动/App 里已经签过的不重复（北京时间，和记账口径一致）
        if (claimedToday(st, provider.id)) {
          doneToday.set(provider.id, today)
          noteSuccess(provider.id)
          continue
        }
        // 失败退避 / 当日放弃
        if (!canRetry(provider.id, today, now.getTime())) continue
        due.push({ id: provider.id, today })
      }
      if (!due.length) return
      const results = await fire('auto', due.map(d => d.id))
      for (const d of due) {
        const r = (results || []).find(x => x && x.provider === d.id)
        if (r && r.ok && r.outcome !== OUTCOME.NOT_YET) {
          doneToday.set(d.id, d.today)
          noteSuccess(d.id)
        } else if (r && r.outcome === OUTCOME.NOT_YET) {
          // 今天还没到轮次（如 Qoder 10:00 才换轮）：**不能标成今天已完成**，
          // 否则 10:00 之后就不会再试了。用退避拉长重试间隔，到点自然会签上。
          noteFailure(d.id, d.today, now.getTime())
          log(`dsh-checkin-all: ${d.id} 还没到轮次，稍后重试：${r.message || ''}`, 'info')
        } else if (r && NEEDS_USER_OUTCOMES.has(r.outcome)) {
          // 凭据过期，必须用户重新登录：重试没用，当天也别标成完成
          // （用户登录后当天还能补签）。只提示一次，不按失败退避刷屏。
          doneToday.set(d.id, d.today)
          noteSuccess(d.id)
          log(`dsh-checkin-all: ${d.id} 需要重新登录：${r.message || ''}`, 'warn')
        } else if (r && BENIGN_OUTCOMES.has(r.outcome)) {
          // 账号没这玩法：今天不用再试了，但也不当失败
          doneToday.set(d.id, d.today)
          noteSuccess(d.id)
          log(`dsh-checkin-all: ${d.id} 今天不签（${r.outcome}）：${r.message || ''}`, 'info')
        } else {
          noteFailure(d.id, d.today, now.getTime())
        }
      }
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
      // 手动签不受退避限制，顺手把失败计数清掉
      if (ids) for (const id of ids) noteSuccess(id)
      else failures.clear()
      return fire('manual', ids)
    },
    /** 立刻重新算下一次时间（改了设置后调用） */
    reschedule: schedule,
    /** 现在在跑吗 */
    get busy() { return Boolean(running) },
    /** 某个服务今天是不是已经自动签过了 */
    doneTodayOf(id) {
      return doneToday.get(id) || beijingDayKey()
    },
    /** 某个服务今天的失败次数（面板/调试用） */
    failuresOf(id) {
      const f = failures.get(id)
      return f && f.day === beijingDayKey() ? f.failures : 0
    },
    /** 直接跑一次检查（测试用） */
    tick,
  }
}
