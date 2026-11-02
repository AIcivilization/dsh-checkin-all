// plugin/tools.js — 给 DSH 对话里的 AI 用的工具（多服务）
//
// 用户在对话里说「帮我签个到」「灵犀连续多少天了」「以后每天 8 点自动签」，
// AI 直接调这些工具，不用打开面板。
//
// 直接写 DSH 工具注册表认的原始格式（标准 JSON Schema 子集），不依赖 @deepseek-ai/dsh-tools：
// 插件从自己的目录加载时 import 不到它。

const ANY_OBJECT = { type: 'object' }

function params(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec)) {
    const { required: req, ...rest } = value
    properties[key] = rest
    if (req) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}

const plain = value => JSON.parse(JSON.stringify(value == null ? null : value))

const DAY_STATUS_TEXT = { 1: '未到', 2: '可领', 3: '已领', 4: '未开放' }

function panelText(panel, unit = '分') {
  if (!panel || !panel.days || !panel.days.length) return '签到表读不出来'
  const rows = panel.days.map(day => {
    const mark = day.isToday ? ' ←今天' : ''
    const bonus = day.bonusPoints ? `+${day.bonusPoints}奖励` : ''
    return `第 ${day.dayNo} 天：${day.points}${bonus} ${unit}（${DAY_STATUS_TEXT[day.status] || day.status}）${mark}`
  })
  const bits = []
  if (panel.consecutiveDays !== undefined) bits.push(`连续 ${panel.consecutiveDays} 天`)
  bits.push(`本周已领 ${panel.claimedDays} 天，共 ${panel.totalPoints} ${unit}`)
  if (panel.accountCredits) bits.push(`账户累计 ${panel.accountCredits} ${unit}`)
  const summary = bits.join('，')
  return [`本周签到表（${summary}）：`, ...rows].join('\n')
}

/** 一个服务的一行状态（给模型看） */
function providerLine(meta, account, state, cfg) {
  const bits = [
    `${meta.name}（${meta.id}）`,
    account && account.loggedIn ? `已登录` : '未登录',
    cfg && cfg.enabled ? `每天 ${cfg.time}` : '自动签到已关闭',
    `连续 ${state.streak || 0} 天`,
  ]
  if (state.lastAttempt) bits.push(`最近：${state.lastAttempt.message}`)
  return `- ${bits.join(' · ')}`
}

export async function buildToolDefinitions({ runner, scheduler, config, state, providerConfig }) {
  const metas = () => runner.meta()
  const providerEnum = () => metas().map(m => m.id)

  return [
    {
      name: 'minimax_checkin',
      description:
        '自动签到领积分：给 MiniMax Code 和/或 WPS 灵犀签到。今天还没签就签，签过了就说已经签过。' +
        '用户说「签到」「帮我领积分」时用它；不指定服务就两个都签。',
      parameters: params({
        provider: {
          type: 'string',
          enum: providerEnum(),
          description: '只签某一个服务：minimax（MiniMax Code）或 lingxi（WPS 灵犀）；不填就全签',
        },
        dryRun: { type: 'boolean', description: '只看签到表、不真的领（默认 false）' },
      }),
      output: {
        schema: ANY_OBJECT,
        render: (_args, value) => [{
          type: 'text',
          text: (value.results || []).map(r => {
            const meta = metas().find(m => m.id === r.provider) || { short: r.provider, unit: '分' }
            return r.ok
              ? `${meta.short}：${r.message}\n${panelText(r.panel, meta.unit)}`
              : `${meta.short} 签到没成功：${r.message}`
          }).join('\n\n'),
        }],
      },
      async execute(args) {
        const only = typeof args.provider === 'string' && args.provider ? [args.provider] : null
        const results = await runner.runAll({ trigger: 'manual', dryRun: Boolean(args.dryRun), only })
        return plain({ results })
      },
    },

    {
      name: 'minimax_checkin_status',
      description:
        '查签到情况：每个服务（MiniMax Code / WPS 灵犀）的登录状态、连续签到天数、累计积分、本周签到表、下次自动签到时间。',
      parameters: params({
        provider: {
          type: 'string',
          enum: providerEnum(),
          description: '只看某一个服务；不填就全部',
        },
      }),
      output: {
        schema: ANY_OBJECT,
        render: (_args, value) => {
          const lines = []
          for (const item of value.providers) {
            lines.push(providerLine(item.meta, item.account, item.state, item.config))
            if (!item.account.loggedIn) {
              lines.push(item.meta.id === 'minimax'
                ? '  （要登录的话说「MiniMax 登录」，我会给一个设备码）'
                : '  （在 WPS 灵犀 App 里登录一次即可）')
            }
            if (item.panel) lines.push('', panelText(item.panel, item.meta.unit))
            lines.push('')
          }
          return [{ type: 'text', text: lines.join('\n').trim() }]
        },
      },
      async execute(args) {
        const cfg = await config()
        const st = await state()
        const only = typeof args.provider === 'string' && args.provider ? args.provider : null
        const out = []
        for (const meta of metas()) {
          if (only && meta.id !== only) continue
          const account = await runner.account(meta.id).catch(error => ({ loggedIn: false, detail: error.message }))
          const ps = (st.providers && st.providers[meta.id]) || {}
          let panel = null
          if (account.loggedIn) {
            try { panel = await runner.panel(meta.id) } catch { panel = null }
          }
          out.push({
            meta,
            account,
            config: providerConfig(cfg, meta.id),
            state: { streak: ps.streak || 0, totalPoints: ps.totalPoints || 0, lastAttempt: ps.lastAttempt || null },
            panel,
          })
        }
        return plain({ providers: out })
      },
    },

    {
      name: 'minimax_checkin_config',
      description:
        '改自动签到的设置：开关、每天几点签（本机时区 HH:MM）、是否补签。可以只改某一个服务，也可以改全局。',
      parameters: params({
        provider: {
          type: 'string',
          enum: providerEnum(),
          description: '只改某一个服务；不填就改全局默认（所有服务跟着走）',
        },
        enabled: { type: 'boolean', description: '是否开启自动签到' },
        time: { type: 'string', description: '每天几点签，24 小时制 HH:MM，例如 09:00' },
        catchUp: { type: 'boolean', description: '过了签到时间才开机，是否补签' },
        notify: { type: 'boolean', description: '签完是否在 DSH 里提示一句（只对全局有效）' },
      }),
      output: {
        schema: ANY_OBJECT,
        render: (_args, value) => [{
          type: 'text',
          text: value.scope === 'global'
            ? `已更新全局默认：自动签到${value.config.enabled ? `每天 ${value.config.time}` : '关闭'}；提示${value.config.notify ? '开' : '关'}。`
            : `已更新 ${value.scope}：自动签到${value.provider.enabled ? `每天 ${value.provider.time}` : '关闭'}；补签${value.provider.catchUp ? '开' : '关'}。`,
        }],
      },
      async execute(args) {
        const patch = {}
        for (const key of ['enabled', 'catchUp', 'notify']) {
          if (typeof args[key] === 'boolean') patch[key] = args[key]
        }
        if (typeof args.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(args.time)) patch.time = args.time

        const target = typeof args.provider === 'string' && args.provider ? args.provider : null
        let next
        if (target) {
          const current = await config()
          const own = { ...(current.providers && current.providers[target]) }
          for (const key of ['enabled', 'catchUp', 'time']) {
            if (patch[key] !== undefined) own[key] = patch[key]
          }
          next = await runner.saveConfig({ providers: { ...(current.providers || {}), [target]: own } })
        } else {
          next = await runner.saveConfig(patch)
        }
        if (scheduler) scheduler.reschedule()
        return plain({
          scope: target || 'global',
          config: next,
          provider: target ? providerConfig(next, target) : null,
        })
      },
    },

    {
      name: 'minimax_login',
      description:
        'MiniMax Code 登录状态失效时重新登录：返回一个设备码和网址，用户在浏览器里确认一次即可。' +
        '（WPS 灵犀不支持脚本登录，要在 App 里登录。）',
      parameters: params({}),
      output: {
        schema: ANY_OBJECT,
        render: (_args, value) => [{
          type: 'text',
          text: `在浏览器打开 ${value.verificationUri}，输入设备码 ${value.userCode}，确认授权。\n` +
            `（也可以直接打开 ${value.verificationUriComplete}）\n` +
            `确认后告诉我一声，或者等我在后台接住（${Math.round(value.expiresInSec / 60)} 分钟内有效）。`,
        }],
      },
      async execute() {
        const info = await runner.loginStart('minimax')
        // 后台接着轮询，用户确认后自动写回凭据
        void runner.loginWait('minimax', { timeoutMs: info.expiresInSec * 1000 }).catch(() => {})
        return plain(info)
      },
    },
  ]
}
