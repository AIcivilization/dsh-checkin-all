#!/usr/bin/env node
// bin/dsh-checkin-all.js — 不开 DSH 也能用：查状态、签到、登录、改时间
//
//   dsh-checkin-all status              所有服务：登录状态 + 本周签到表 + 连续天数
//   dsh-checkin-all checkin [服务]      立刻签到（--dry 只看不领）；不指定服务就全签
//   dsh-checkin-all login               设备码登录 MiniMax Code
//   dsh-checkin-all time 08:30          改自动签到时间
//   dsh-checkin-all on | off            开 / 关自动签到
//   dsh-checkin-all cron                给系统 crontab 用的静默签到
//
// 服务名：minimax（MiniMax Code）/ lingxi（WPS 灵犀）/ dumate（百度 DuMate）/ astudio（AStudio）/ qoder（Qoder）/ trae（Trae）/ doubao（豆包）
//
// 系统 crontab 里可以这样挂（不想依赖 DSH 常驻时）：
//   0 9 * * * /path/to/dsh-checkin-all cron >> ~/.dsh/dsh-checkin-all/cron.log 2>&1

import { Runner } from '../lib/runner.js'
import { loadConfig, loadState, saveConfig, providerConfig } from '../lib/store.js'

const argv = process.argv.slice(2)
const command = (argv[0] || 'status').toLowerCase()
const flags = new Set(argv.slice(1).filter(a => a.startsWith('-')))
const rest = argv.slice(1).filter(a => !a.startsWith('-'))

const log = (message) => console.log(message)
const runner = new Runner({ log })

const STATUS_TAG = { 1: '未到', 2: '可领', 3: '已领', 4: '未开放' }

function printPanel(panel, unit) {
  if (!panel || !panel.days.length) return console.log('  签到表读不出来')
  // 「每日登录积分」型服务（AStudio）：只显示今天一天，不显示「本周 7 天」
  if (panel.style === 'daily') {
    const day = panel.days[0]
    const done = day.status === 3
    console.log(`  今天  +${String(day.points).padStart(5)}${done ? '  已到账' : '  可领取'}  ← 今天`)
    if (panel.accountCredits) console.log(`  账户累计 ${panel.accountCredits} ${unit}`)
    return
  }
  for (const day of panel.days) {
    const mark = day.isToday ? '  ← 今天' : ''
    const bonus = day.bonusPoints ? ` +${day.bonusPoints}奖励` : ''
    console.log(`  第 ${day.dayNo} 天  ${String(day.points).padStart(5)}${bonus.padEnd(9)}  ${STATUS_TAG[day.status] || day.status}${mark}`)
  }
  if (panel.consecutiveDays !== undefined) console.log(`  连续 ${panel.consecutiveDays} 天`)
  console.log(`  本周已领 ${panel.claimedDays} 天，共 ${panel.totalPoints} ${unit}`)
  if (panel.accountCredits) console.log(`  账户累计 ${panel.accountCredits} ${unit}`)
}

/** 按名字找服务 */
function findProvider(text) {
  const metas = runner.meta()
  if (!text) return null
  const t = String(text).toLowerCase()
  return metas.find(m => m.id === t || m.short === text || m.name.toLowerCase() === t
    || m.name.toLowerCase().includes(t) || m.short.includes(text)) || null
}

async function main() {
  const metas = runner.meta()

  if (command === 'status') {
    const cfg = await loadConfig()
    const state = await loadState()
    for (const meta of metas) {
      const own = providerConfig(cfg, meta.id)
      const account = await runner.account(meta.id).catch(e => ({ loggedIn: false, detail: e.message }))
      const ps = (state.providers && state.providers[meta.id]) || {}
      console.log(`── ${meta.name} ──`)
      console.log(account.loggedIn
        ? `登录：已登录（${account.detail || ''}）`
        : `登录：未登录${account.detail ? `（${account.detail}）` : ''}`)
      console.log(`自动签到：${own.enabled ? `每天 ${own.time}` : '已关闭'}${meta.timeZoneMode === 'fixed' ? `（按 ${meta.timeZone} 算日期）` : ''}`)
      console.log(`连续 ${ps.streak || 0} 天`)
      if (ps.lastAttempt) console.log(`最近一次：${ps.lastAttempt.message}`)
      if (account.loggedIn) {
        try {
          const panel = await runner.panel(meta.id)
          printPanel(panel, meta.unit)
        } catch (error) {
          console.log(`  读签到表失败：${error.message}`)
        }
      }
      console.log('')
    }
    return
  }

  if (command === 'checkin' || command === 'sign' || command === '签到') {
    const target = findProvider(rest[0])
    const dryRun = flags.has('--dry') || flags.has('-d')
    if (target) {
      const result = await runner.run(target.id, { trigger: 'manual', dryRun })
      console.log(`${target.short}：${result.message}`)
      if (result.panel) printPanel(result.panel, target.unit)
      process.exitCode = result.ok ? 0 : 1
      return
    }
    const results = await runner.runAll({ trigger: 'manual', dryRun })
    for (const r of results) {
      const meta = metas.find(m => m.id === r.provider) || { short: r.provider, unit: '分' }
      console.log(`${meta.short}：${r.message}`)
      if (r.panel) printPanel(r.panel, meta.unit)
    }
    process.exitCode = results.every(r => r.ok) ? 0 : 1
    return
  }

  if (command === 'login' || command === '登录') {
    const info = await runner.loginStart('minimax')
    console.log(`在浏览器打开：${info.verificationUri}`)
    console.log(`设备码：${info.userCode}`)
    console.log(`（或直接打开 ${info.verificationUriComplete}）`)
    console.log(`等待确认…（${Math.round(info.expiresInSec / 60)} 分钟内有效）`)
    const result = await runner.loginWait('minimax', { timeoutMs: info.expiresInSec * 1000 })
    console.log(`登录成功，凭据已写回 MiniMax Code（${result.expiresAt} 过期）`)
    return
  }

  if (command === 'time' || command === '时间') {
    const value = rest[0]
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(value || ''))) {
      console.error('用法：dsh-checkin-all time 08:30')
      process.exitCode = 2
      return
    }
    const [hour, minute] = String(value).split(':')
    const time = `${hour.padStart(2, '0')}:${minute}`
    await saveConfig({ time, providers: null })
    console.log(`全部服务自动签到时间改为每天 ${time}`)
    return
  }

  if (command === 'on' || command === 'off') {
    await saveConfig({ enabled: command === 'on', providers: null })
    console.log(`全部服务自动签到已${command === 'on' ? '开启' : '关闭'}`)
    return
  }

  if (command === 'cron') {
    const cfg = await loadConfig()
    if (!cfg.enabled) return
    const results = await runner.runAll({ trigger: 'auto' })
    for (const r of results) {
      const meta = metas.find(m => m.id === r.provider) || { short: r.provider }
      console.log(`${new Date().toISOString()} ${meta.short} ${r.outcome} ${r.message}`)
    }
    process.exitCode = results.every(r => r.ok) ? 0 : 1
    return
  }

  console.log(`用法：
  dsh-checkin-all status              所有服务：登录状态 + 本周签到表
  dsh-checkin-all checkin [服务]      立刻签到（--dry 只看不领）
  dsh-checkin-all login               设备码登录 MiniMax Code
  dsh-checkin-all time 08:30          改自动签到时间
  dsh-checkin-all on | off            开 / 关自动签到
  dsh-checkin-all cron                给系统 crontab 用的静默签到

服务名：${metas.map(m => `${m.id}（${m.name}）`).join(' / ')}`)
}

main().catch((error) => {
  console.error(`出错：${error.message}`)
  if (error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID_GRANT' || error.code === 'AUTH_NO_REFRESH_TOKEN') {
    console.error('MiniMax 登录状态没了，跑一次：dsh-checkin-all login')
  }
  if (error.code === 'LINGXI_NOT_LOGGED_IN' || error.code === 'LINGXI_NO_COOKIE_DB') {
    console.error('灵犀没登录：打开 WPS 灵犀 App 登录一次')
  }
  if (error.code === 'ASTUDIO_NOT_LOGGED_IN' || error.code === 'ASTUDIO_SESSION_EXPIRED') {
    console.error('AStudio 没登录或登录失效：打开 AStudio App 登录一次')
  }
  if (error.code === 'QODER_NOT_CONFIGURED' || error.code === 'QODER_AUTH') {
    console.error('Qoder 没配置：在面板里添加个人访问令牌（PAT）')
  }
  if (error.code === 'TRAE_NOT_LOGGED_IN') {
    console.error('Trae 没登录：打开 Trae App 登录一次（要在装了 Trae 的电脑上签）')
  }
  if (error.code === 'DOUBAO_NOT_CONFIGURED') {
    console.error('豆包没配置：在面板里添加 Cookie（手动粘贴或从浏览器读）')
  }
  process.exitCode = 1
})
