/* global window, document */
// plugin/client.js — dsh-checkin-all 的界面
//
// 手写单文件 bundle，没有构建链：由 dsh web 客户端的 ModuleLoader 注入（写法照 dsh-pick / dsh-tingdong）。
// 挂两处：
//   - 对话页右侧栏的一个页签（完整面板，iframe 指向 /api-dsh-checkin-all/panel）
//   - 「设置 → MiniMax 签到」（精简版：状态 / 立刻签 / 开关 / 打开面板）
// 硬约束：界面崩了不能影响 dsh，注册一律包在 try/catch 里。

window.__ModuleLoader__.load({
  id: 'dsh-checkin-all',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const isZh = () => {
      const l = (document.documentElement.lang || navigator.language || 'zh').toLowerCase()
      return l.startsWith('zh')
    }
    const L = (zh, en) => (isZh() ? zh : en)

    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      sub: 'var(--dsw-alias-label-secondary, #888)',
      faint: 'var(--dsw-alias-label-tertiary, #999)',
      border: 'var(--dsw-alias-border-l3, rgba(127,127,127,.25))',
      accent: 'var(--dsw-alias-link, #2f6bff)',
      danger: '#c94040',
      ok: '#0f9d58',
      warn: '#d97a06',
    }

    const BASE = '/api-dsh-checkin-all'

    /** 拼接口地址：调用方传 'status' 或 '/status' 都行，别拼成 /api-dsh-checkin-allstatus */
    const url = (path) => `${BASE}/${String(path || '').replace(/^\/+/, '')}`

    async function api(path, method = 'GET', body) {
      const r = await fetch(url(path), {
        method,
        credentials: 'same-origin',
        headers: method === 'POST' ? { 'content-type': 'application/json', 'x-dsh-checkin-all': '1' } : undefined,
        body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      })
      // DSH 鉴权失败是 401 + 空 body：直接 r.json() 会抛 "Unexpected end of JSON input"
      const text = await r.text()
      if (!text) {
        throw new Error(r.status === 401
          ? L('DSH 登录状态已失效，重新打开 DSH 后再试', 'DSH session expired; reopen DSH')
          : L(`接口没有返回内容（HTTP ${r.status}）`, `Empty response (HTTP ${r.status})`))
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(L(`接口返回的不是 JSON（HTTP ${r.status}）`, `Not JSON (HTTP ${r.status})`))
      }
    }

    function Btn({ onClick, disabled, primary, title, children }) {
      return h('button', {
        type: 'button', onClick, disabled, title,
        style: {
          appearance: 'none', fontFamily: 'inherit', fontSize: 12, lineHeight: '18px',
          padding: '3px 10px', borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1, whiteSpace: 'nowrap',
          border: '1px solid ' + (primary ? C.accent : C.border),
          background: primary ? C.accent : 'transparent',
          color: primary ? '#fff' : C.text,
        },
      }, children)
    }

    function Section({ title, children }) {
      return h('div', { style: { marginTop: 18 } },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, title),
        h('div', { style: { fontSize: 12.5, color: C.sub, lineHeight: 1.7 } }, children))
    }

    /** 一行状态：左边标签、右边值 */
    function Row({ label, value, tone }) {
      const color = tone === 'ok' ? C.ok : tone === 'warn' ? C.warn : tone === 'bad' ? C.danger : C.text
      return h('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          gap: 12, padding: '4px 0', borderBottom: '1px solid ' + C.border,
        },
      },
        h('span', { style: { fontSize: 12, color: C.faint, flex: 'none' } }, label),
        h('span', { style: { fontSize: 12.5, color, textAlign: 'right', wordBreak: 'break-word' } }, value))
    }

    /** 状态块（面板和设置页共用） */
    function useStatus() {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const reload = () => {
        api('status').then(j => { setStatus(j); setError('') }).catch(e => setError(e.message))
      }
      useEffect(() => { reload() }, [])
      return { status, error, reload, setStatus }
    }

    function StatusRows({ status }) {
      if (!status) return h('div', { style: { fontSize: 12, color: C.faint } }, L('读取中…', 'Loading…'))
      const { config, state, account, timeZone } = status
      const minutes = account && account.loggedIn ? Math.round((account.expiresInSec || 0) / 60) : 0
      return h('div', null,
        h(Row, {
          label: L('登录状态', 'Account'),
          value: account && account.loggedIn
            ? (minutes > 0 ? L(`已登录 · ${minutes} 分钟后过期`, `Signed in · expires in ${minutes} min`) : L('已登录', 'Signed in'))
            : L('未登录', 'Not signed in'),
          tone: account && account.loggedIn ? 'ok' : 'bad',
        }),
        h(Row, {
          label: L('自动签到', 'Schedule'),
          value: config.enabled ? L(`每天 ${config.time}（${timeZone}）`, `Daily ${config.time} (${timeZone})`) : L('已关闭', 'Off'),
          tone: config.enabled ? undefined : 'warn',
        }),
        h(Row, { label: L('连续签到', 'Streak'), value: state.streak ? L(`${state.streak} 天`, `${state.streak} days`) : '—' }),
        h(Row, { label: L('累计积分', 'Total points'), value: state.totalPoints ? `${state.totalPoints}` : '—' }),
        state.lastAttempt
          ? h(Row, {
              label: L('最近一次', 'Last run'),
              value: state.lastAttempt.message || state.lastAttempt.outcome,
              tone: state.lastAttempt.ok ? 'ok' : 'bad',
            })
          : null)
    }

    // —— 右侧栏的完整面板：标题行 + iframe ——
    function MiniMaxPanel() {
      const { status, error, reload } = useStatus()
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')

      const checkin = async () => {
        setBusy(true); setMsg('')
        try {
          const result = await api('checkin', 'POST')
          setMsg((result.result && result.result.message) || (result.ok ? L('完成', 'Done') : L('失败', 'Failed')))
          reload()
        } catch (e) {
          setMsg(L('请求失败：', 'Request failed: ') + e.message)
        } finally {
          setBusy(false)
        }
      }

      return h('div', {
        style: { color: C.text, height: '100%', display: 'flex', flexDirection: 'column', padding: '10px 12px', boxSizing: 'border-box' },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 15, fontWeight: 650 } }, L('自动签到', 'Auto check-in')),
          h(Btn, { onClick: checkin, disabled: busy, primary: true }, busy ? L('签到中…', 'Signing…') : L('立刻签到', 'Check in')),
          h('span', { style: { flex: 1 } }),
          error ? h('span', { style: { fontSize: 11.5, color: C.danger } }, error) : null),
        msg ? h('div', { style: { fontSize: 12, color: C.sub, marginBottom: 8 } }, msg) : null,
        h('iframe', {
          src: BASE + '/panel',
          title: 'dsh-checkin-all',
          style: {
            width: '100%', flex: '1 1 0', minHeight: 0,
            border: '1px solid ' + C.border, borderRadius: 10,
            background: 'transparent', display: 'block',
          },
        }))
    }

    // —— 设置页 ——
    let sidebarRightApi = null

    function SettingsSection() {
      const { status, error, reload } = useStatus()
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')
      const [openMsg, setOpenMsg] = useState('')

      const checkin = async () => {
        setBusy(true); setMsg('')
        try {
          const result = await api('checkin', 'POST')
          setMsg((result.result && result.result.message) || L('完成', 'Done'))
          reload()
        } catch (e) {
          setMsg(L('请求失败：', 'Request failed: ') + e.message)
        } finally {
          setBusy(false)
        }
      }

      const toggle = async (enabled) => {
        try {
          await api('config', 'POST', { enabled })
          reload()
        } catch (e) {
          setMsg(L('保存失败：', 'Save failed: ') + e.message)
        }
      }

      const openSidebar = () => {
        try {
          sidebarRightApi.openTab(SIDEBAR_KIND)
          setOpenMsg(L('已在右侧栏打开，关闭设置就能看到', 'Opened in the right sidebar; close Settings to see it'))
        } catch {
          setOpenMsg(L('先回到一个对话，再从右侧栏打开', 'Go back to a conversation first'))
        }
      }

      return h('div', { style: { color: C.text } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 15, fontWeight: 650 } }, L('自动签到', 'Auto check-in')),
          status && status.version ? h('span', { style: { fontSize: 12, color: C.sub } }, 'v' + status.version) : null,
          h(Btn, { onClick: checkin, disabled: busy, primary: true }, busy ? L('签到中…', 'Signing…') : L('立刻签到', 'Check in')),
          status
            ? h(Btn, { onClick: () => toggle(!status.config.enabled) },
                status.config.enabled ? L('关闭自动签到', 'Turn off auto check-in') : L('开启自动签到', 'Turn on auto check-in'))
            : null),
        msg ? h('div', { style: { fontSize: 12, color: C.sub, marginBottom: 8 } }, msg) : null,
        error ? h('div', { style: { fontSize: 12, color: C.danger, marginBottom: 8 } }, error) : null,

        h(StatusRows, { status }),

        h(Section, { title: L('怎么打开', 'How to open') },
          h('div', null, L(
            '签到面板在对话页的右侧栏：打开右侧栏，在引导页里点「MiniMax 签到」。',
            'The panel lives in the conversation\'s right sidebar: open the sidebar and choose "MiniMax check-in".')),
          sidebarRightApi
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                h(Btn, { onClick: openSidebar }, L('在右侧栏打开', 'Open in right sidebar')),
                openMsg ? h('span', { style: { fontSize: 12, color: C.faint } }, openMsg) : null)
            : null),

        h(Section, { title: L('它怎么工作', 'How it works') },
          h('div', null, L(
            '用本机 App 已经存好的登录凭据（MiniMax Code 的 ~/.minimax/auth/、WPS 灵犀的 Cookies）调用官方签到接口，每天到点签一次。' +
            'MiniMax 的登录过期会自动续期并写回，App 那边不受影响。不保存你的账号密码，也不上传任何东西。',
            'It calls the official check-in endpoints with the credentials the apps already store (MiniMax Code in ~/.minimax/auth/, WPS Lingxi in its Cookies), ' +
            'once a day at your chosen time. MiniMax tokens refresh and write back so the app keeps working. ' +
            'No password is stored and nothing is uploaded.'))),

        h(Section, { title: L('在对话里用', 'From the chat') },
          h('div', null, L(
            '直接说「帮我签到」「MiniMax 积分还有多少」「以后每天 8 点签」就行。命令：/minimax 状态｜签到｜时间 09:00｜开启｜关闭｜登录',
            'Just say "check in for me", "how many MiniMax points do I have", "sign me in at 8am daily". ' +
            'Commands: /minimax status | checkin | time 09:00 | on | off | login'))))
    }

    const SIDEBAR_TAB_ID = 'dsh-checkin-all/panel'
    const SIDEBAR_KIND = 'dsh-checkin-all'

    function MinimaxIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 32 32', fill: 'none' },
        h('rect', { x: 3, y: 3, width: 26, height: 26, rx: 7, stroke: 'currentColor', strokeWidth: 2.2 }),
        h('path', { d: 'M10 17l4 4 8-9', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    const injectSlots = ['slots']

    function apply(ctx) {
      try {
        ctx.inject && ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
          const right = (scope.get && scope.get('sidebarRight')) || scope.sidebarRight
          const tabs = (scope.get && scope.get('sidebarRightTabs')) || scope.sidebarRightTabs
          if (!tabs || typeof tabs.register !== 'function') return
          const effect = (fn, label) => (scope.effect ? scope.effect(fn, label) : fn())
          effect(() => tabs.register({
            id: SIDEBAR_TAB_ID,
            kind: SIDEBAR_KIND,
            priority: 'extension',
            keepMounted: true,
            title: () => L('自动签到', 'Auto check-in'),
            guide: [{
              id: 'dsh-checkin-all',
              order: 72,
              title: () => L('自动签到', 'Auto check-in'),
              description: () => L('MiniMax Code / WPS 灵犀 每天自动领积分', 'Auto-claim points for MiniMax Code and WPS Lingxi'),
              icon: MinimaxIcon,
            }],
          }), 'dsh-checkin-all: sidebar type')
          const slots = scope.slots || ctx.slots
          const body = () => slots.register({ name: 'sidebar.right.pane.tab', key: SIDEBAR_TAB_ID }, MiniMaxPanel)
          effect(() => (slots.inject ? slots.inject('sidebar.right.pane.tab', body) : body()), 'dsh-checkin-all: sidebar body')
          if (right && typeof right.openTab === 'function') {
            sidebarRightApi = right
            effect(() => () => { if (sidebarRightApi === right) sidebarRightApi = null }, 'dsh-checkin-all: sidebar api')
          }
        })
      } catch (error) {
        console.warn('[dsh-checkin-all] 右侧栏注册失败', error)
      }

      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-checkin-all', order: 31, label: () => L('自动签到', 'Auto check-in') },
            SettingsSection,
          ))
      } catch (error) {
        console.warn('[dsh-checkin-all] 设置页注册失败', error)
      }
    }

    module.exports = { name: 'dsh-checkin-all', inject: injectSlots, apply }
    return module.exports
  },
})
