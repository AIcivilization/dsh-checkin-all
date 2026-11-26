// lib/lock.js — 排队与锁：多账号、多入口同时签到时互不踩踏
//
// 会同时「读 → 改 → 写」同一个文件的地方很多：面板加账号、签到时写回续期令牌（MiniMax / CodeArts /
// OfficeAce 的 refresh token 只能用一次）、AI 工具改设置、定时器记账……不排队的话后写的会把先写的
// 整份盖掉（思路照 dsh-model 0.38.4 的 util/serial.ts + state.ts 的 withLock）。
//
// 两层：
//   serialized(key, fn)      本进程内按 key 排队，前一个失败不影响后一个
//   withFileLock(path, fn)   跨进程（DSH 里的插件 ↔ 终端里的 dsh-checkin-all 命令）：锁文件 + pid，
//                            对方进程已经退出、或锁太久没动，就当成残留锁清掉
//   exclusive(file, fn)      两层一起：改某个文件时用它
// 同一条异步调用链里嵌套拿同一把锁会直接放行（不然会等自己，永远等不到）。

import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const queues = new Map()
const holding = new AsyncLocalStorage()

/** 本进程内按 key 排队执行 */
export function serialized(key, fn) {
  const prev = queues.get(key) || Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 跨进程文件锁。拿不到就等（默认最多 60 秒），不直接报错：
 * 签到是后台的事，晚几秒没关系，丢改动才有关系。
 */
export async function withFileLock(lockPath, fn, { timeoutMs = 60_000, staleMs = 10 * 60_000, pollMs = 50 } = {}) {
  const held = holding.getStore()
  if (held && held.has(lockPath)) return fn()

  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`)
      await handle.close()
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = Number(String(await readFile(lockPath, 'utf8').catch(() => '')).split('\n')[0]) || 0
      const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs).catch(() => 0)
      const stale = (owner && owner !== process.pid && !isAlive(owner)) || age > staleMs
      if (stale) {
        await rm(lockPath, { force: true })
        continue
      }
      if (Date.now() > deadline) {
        throw Object.assign(
          new Error(`另一个 dsh-checkin-all 进程（pid ${owner || '?'}）正占着 ${lockPath}，等了 ${Math.round(timeoutMs / 1000)} 秒还没放`),
          { code: 'LOCKED' },
        )
      }
      await sleep(pollMs)
    }
  }

  const next = new Set(held || [])
  next.add(lockPath)
  try {
    return await holding.run(next, fn)
  } finally {
    await rm(lockPath, { force: true }).catch(() => {})
  }
}

/** 改某个文件：本进程排队 + 跨进程锁（锁文件是 <file>.lock） */
export function exclusive(file, fn, options) {
  const path = resolve(file)
  const lockPath = `${path}.lock`
  const held = holding.getStore()
  if (held && held.has(lockPath)) return fn()
  return serialized(`file:${path}`, () => withFileLock(lockPath, fn, options))
}

/** 并发跑一组任务，最多同时 limit 个；返回值顺序与输入一致 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}
