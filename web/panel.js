/* dsh-checkin-all 面板 —— 顶部索引（每个签到服务一张卡）+ 下面切到对应详情 */

const $ = selector => document.querySelector(selector)
const BASE = '/api-dsh-checkin-all'

const esc = value => String(value == null ? '' : value)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(BASE + path, {
    method,
    credentials: 'same-origin',
    headers: method === 'POST'
      ? { 'content-type': 'application/json', 'x-dsh-checkin-all': '1' }
      : undefined,
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  })
  // DSH 的鉴权拦截器对未认证请求回 401 + 空 body：直接 r.json() 会炸成
  // "Unexpected end of JSON input"，这里先读文本再解析，空响应给一句人话
  const text = await response.text()
  if (!text) {
    throw new Error(response.status === 401
      ? 'DSH 登录状态已失效，刷新页面或重新打开 DSH 后再试'
      : `接口没有返回内容（HTTP ${response.status}）`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 120)}`)
  }
}

/* ── 状态 ── */

let STATUS = null
let CURRENT = ''        // 当前选中的服务 id
const PANELS = new Map() // id -> 签到表（缓存，切回不闪）

let bannerTimer = 0
function banner(text, kind = 'info', action) {
  const el = $('#banner')
  el.className = `banner ${kind}`
  el.innerHTML = esc(text)
  if (action) {
    const link = document.createElement('a')
    link.textContent = action.label
    link.onclick = action.onClick
    el.append(' ', link)
  }
  clearTimeout(bannerTimer)
  if (kind === 'ok') bannerTimer = setTimeout(() => el.classList.add('hidden'), 6000)
}
function hideBanner() { $('#banner').classList.add('hidden') }

const STATUS_TAG = { 1: '未到', 2: '可领', 3: '已领', 4: '未开放' }

/* ── 顶部索引卡片 ── */

function providerOf(id) {
  return (STATUS && STATUS.providers || []).find(p => p.id === id) || null
}

function renderIndex() {
  const box = $('#index')
  const list = (STATUS && STATUS.providers) || []
  if (!list.length) {
    box.innerHTML = '<div class="index-loading muted">没有可用的签到服务</div>'
    return
  }
  box.innerHTML = list.map(p => {
    const st = p.state || {}
    const last = st.lastAttempt
    const todayDone = st.claimedToday
    const on = p.config && p.config.enabled
    const dot = !p.account || !p.account.loggedIn
      ? '<span class="cdot bad" title="未登录"></span>'
      : todayDone
        ? '<span class="cdot ok" title="今天已签"></span>'
        : '<span class="cdot warn" title="今天还没签"></span>'
    const line = last
      ? (last.ok
          ? (last.points > 0 ? `+${last.points} ${p.unit}` : todayDone ? '今天已签' : '已签')
          : '上次失败')
      : (on ? `${p.config.time} 自动` : '未开启')
    const streak = st.streak ? `连续 ${st.streak} 天` : ''
    return `<button type="button" class="icard${p.id === CURRENT ? ' on' : ''}" data-id="${esc(p.id)}"
        style="--brand:${esc(p.color)}">
      <div class="icard-top">
        <span class="iavatar">${esc(p.short.slice(0, 1))}</span>
        ${dot}
      </div>
      <div class="iname">${esc(p.short)}</div>
      <div class="iline">${esc(line)}</div>
      <div class="imeta">${esc(streak)}</div>
    </button>`
  }).join('')
  for (const btn of box.querySelectorAll('.icard')) {
    btn.onclick = () => select(btn.dataset.id)
  }
}

/* ── 详情：和原来那张卡一致 ── */

function renderDetail() {
  const p = providerOf(CURRENT)
  const box = $('#detail')
  if (!p) {
    box.innerHTML = '<div class="detail-loading muted">选一个签到服务</div>'
    return
  }
  const st = p.state || {}
  const account = p.account || {}
  const minutes = account.loggedIn ? Math.round((account.expiresInSec || 0) / 60) : 0

  const accountValue = account.loggedIn
    ? `${account.label}${minutes > 0 ? ` · ${minutes} 分钟后过期` : account.detail ? ` · ${account.detail}` : ''}`
    : (account.label || '未登录') + (account.detail ? `（${account.detail}）` : '')

  const last = st.lastAttempt
  const lastText = last
    ? `${new Date(last.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${last.message || last.outcome}`
    : ''

  const canLogin = p.id === 'minimax'

  box.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h2>${esc(p.name)}</h2>
        <div class="head-actions">
          ${canLogin && !account.loggedIn ? '<button class="btn tiny" id="btn-login">登录</button>' : ''}
          <button class="btn tiny primary" id="btn-checkin">立刻签到</button>
        </div>
      </div>
      <div class="row"><span class="label">登录状态</span>
        <span class="value ${account.loggedIn ? 'ok' : 'bad'}">${esc(accountValue)}</span></div>
      <div class="row"><span class="label">自动签到</span>
        <span class="value ${p.config && p.config.enabled ? '' : 'warn'}">${
          p.config && p.config.enabled
            ? `每天 ${esc(p.config.time)}${p.timeZoneMode === 'fixed' ? `（${esc(p.timeZone)}）` : ''}${p.config.catchUp ? ' · 可补签' : ''}`
            : '已关闭'
        }</span></div>
      <div class="row"><span class="label">连续签到</span>
        <span class="value">${st.streak ? `${st.streak} 天` : '—'}</span></div>
      <div class="row"><span class="label">累计${esc(p.unit)}</span>
        <span class="value">${(() => {
          const cached = PANELS.get(p.id)
          const accountTotal = cached && (cached.accountCredits ?? cached.totalClaimedCredits ?? cached.totalPoints)
          const shown = accountTotal || st.totalPoints
          return shown ? `${shown}` : '—'
        })()}</span></div>
      ${lastText ? `<div class="row"><span class="label">最近一次</span>
        <span class="value ${last.ok ? 'ok' : 'bad'}">${esc(lastText)}</span></div>` : ''}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>本周签到表</h2>
        <button class="btn tiny" id="btn-refresh">刷新</button>
      </div>
      <div id="week" class="week"><span class="muted">读取中…</span></div>
      <div id="week-note" class="note hidden"></div>
    </section>

    <section class="card">
      <div class="card-head"><h2>设置</h2></div>
      <div class="field">
        <label class="switch">
          <input type="checkbox" id="p-enabled" ${p.config && p.config.enabled ? 'checked' : ''}>
          <span>每天自动签到</span>
        </label>
      </div>
      <div class="field">
        <label for="p-time">签到时间</label>
        <input type="time" id="p-time" step="60" value="${esc(p.config ? p.config.time : '09:00')}">
        <span class="hint">${p.timeZoneMode === 'fixed' ? `按 ${esc(p.timeZone)} 算日期` : '按本机时区'}</span>
      </div>
      <div class="field">
        <label class="switch">
          <input type="checkbox" id="p-catchup" ${p.config && p.config.catchUp ? 'checked' : ''}>
          <span>睡过头也补签</span>
        </label>
      </div>
      <div class="actions">
        <button class="btn primary" id="btn-save">保存设置</button>
        <span id="save-msg" class="hint"></span>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>最近 14 天</h2></div>
      <div id="history" class="history"><span class="muted">读取中…</span></div>
    </section>`

  $('#btn-checkin').onclick = () => checkin(p.id)
  $('#btn-refresh').onclick = () => loadPanel(p.id, { force: true })
  $('#btn-save').onclick = () => saveProviderConfig(p.id)
  const loginBtn = $('#btn-login')
  if (loginBtn) loginBtn.onclick = () => startLogin(p.id)

  renderHistory(st.recent)
  const cached = PANELS.get(p.id)
  if (cached) renderWeek(cached)
  else loadPanel(p.id)
}

function renderWeek(panel) {
  const box = $('#week')
  if (!box) return
  if (!panel || !Array.isArray(panel.days) || !panel.days.length) {
    box.innerHTML = '<span class="muted">签到表读不出来</span>'
    return
  }
  box.innerHTML = panel.days.map((day) => {
    const cls = day.status === 3 ? 'claimed' : day.status === 2 ? 'claimable' : ''
    const bonus = day.bonusPoints ? `<div class="tag">+${day.bonusPoints} 奖励</div>` : ''
    return `<div class="day ${cls}${day.isToday ? ' today' : ''}">
      <div class="no">第 ${day.dayNo} 天</div>
      <div class="pts">${day.points}</div>
      <div class="tag">${STATUS_TAG[day.status] || day.status}</div>
      ${bonus}
    </div>`
  }).join('')

  const note = $('#week-note')
  if (!note) return
  const parts = []
  if (panel.today) {
    parts.push(panel.today.status === 3
      ? `今天（第 ${panel.today.dayNo} 天）已签，+${panel.today.points + panel.today.bonusPoints}`
      : panel.today.status === 2
        ? `今天（第 ${panel.today.dayNo} 天）还没签，可领 ${panel.today.points + panel.today.bonusPoints}`
        : `今天（第 ${panel.today.dayNo} 天）不可领`)
  }
  if (panel.consecutiveDays !== undefined) parts.push(`连续 ${panel.consecutiveDays} 天`)
  parts.push(`本周已领 ${panel.claimedDays} 天，共 ${panel.totalPoints}`)
  if (panel.accountCredits) parts.push(`账户累计 ${panel.accountCredits}`)
  note.textContent = parts.join(' · ')
  note.classList.remove('hidden')
}

function renderHistory(recent) {
  const box = $('#history')
  if (!box) return
  if (!Array.isArray(recent) || !recent.length) {
    box.innerHTML = '<span class="muted">还没有签到记录</span>'
    return
  }
  const max = Math.max(1, ...recent.map(r => (r.entry && r.entry.points) || 0))
  box.innerHTML = recent.map(({ day, entry }) => {
    const points = entry ? entry.points : 0
    const width = entry ? Math.max(6, Math.round((points / max) * 100)) : 0
    const label = !entry
      ? '没记录'
      : entry.outcome === 'claimed'
        ? `+${points}`
        : entry.outcome === 'already_claimed'
          ? '已签过'
          : entry.outcome
    return `<div class="hrow${entry ? '' : ' miss'}">
      <span class="hday">${esc(day.slice(5))}</span>
      <span class="hbar"><i style="width:${width}%"></i></span>
      <span class="hval">${esc(label)}</span>
    </div>`
  }).join('')
}

/* ── 动作 ── */

async function loadPanel(id, { force = false } = {}) {
  const week = $('#week')
  if (week && !force && !PANELS.has(id)) week.innerHTML = '<span class="muted">读取中…</span>'
  try {
    const r = await api(`/signin?id=${encodeURIComponent(id)}`)
    if (r.ok) {
      // /signin 返回的是平铺的签到表 { ok, id, days, today, ... }，不是 { panel: {...} }
      PANELS.set(id, r)
      if (id === CURRENT) renderWeek(r)
    } else {
      PANELS.delete(id)
      if (id === CURRENT) week.innerHTML = `<span class="muted">${esc(r.message || '读不到签到表')}</span>`
    }
  } catch (error) {
    if (id === CURRENT && week) week.innerHTML = `<span class="muted">${esc(error.message)}</span>`
  }
}

async function refresh({ withPanels = true } = {}) {
  try {
    const status = await api('/status')
    STATUS = status
    if (!CURRENT || !providerOf(CURRENT)) {
      CURRENT = (status.providers && status.providers[0] && status.providers[0].id) || ''
    }
    $('#version').textContent = status.version ? `v${status.version}` : ''
    const p = providerOf(CURRENT)
    $('#subtitle').textContent = p
      ? `${p.name}${p.config && p.config.enabled ? ` · 每天 ${p.config.time}` : ' · 自动签到已关'}`
      : '每天自动领积分'
    renderIndex()
    renderDetail()
    if (withPanels && p) {
      for (const item of status.providers || []) {
        if (!item.account || !item.account.loggedIn) continue
        void loadPanel(item.id)
      }
    }
    // 有未登录的服务，给个提示
    const notLogged = (status.providers || []).filter(x => !x.account || !x.account.loggedIn)
    if (notLogged.length) {
      const first = notLogged[0]
      banner(`${first.name} 还没登录。`, 'warn',
        first.id === 'minimax' ? { label: '去登录', onClick: () => startLogin('minimax') } : null)
    } else {
      hideBanner()
    }
  } catch (error) {
    banner(`读取状态失败：${error.message}`, 'bad')
  }
}

function select(id) {
  if (!id || id === CURRENT) return
  CURRENT = id
  hideBanner()
  renderIndex()
  renderDetail()
  const p = providerOf(id)
  if (p) $('#subtitle').textContent = `${p.name}${p.config && p.config.enabled ? ` · 每天 ${p.config.time}` : ' · 自动签到已关'}`
}

async function checkin(id) {
  const btn = $('#btn-checkin')
  if (btn) { btn.disabled = true; btn.textContent = '签到中…' }
  hideBanner()
  try {
    const r = await api('/checkin', { method: 'POST', body: { id } })
    if (r.ok) {
      banner(r.result.message || '签到完成', r.result.outcome === 'claimed' ? 'ok' : 'info')
      if (r.result.panel) {
        PANELS.set(id, r.result.panel)
        if (id === CURRENT) renderWeek(r.result.panel)
      }
    } else {
      banner(r.message || '签到失败', 'bad')
      if (r.code === 'AUTH_REQUIRED' || r.code === 'AUTH_INVALID_GRANT') {
        banner(`${r.message}。点这里用设备码登录。`, 'warn', { label: '去登录', onClick: () => startLogin('minimax') })
      }
    }
    if (r.status) {
      STATUS = r.status
      renderIndex()
      const st = providerOf(id)
      if (st) renderHistory(st.state.recent)
    } else {
      await refresh({ withPanels: false })
    }
  } catch (error) {
    banner(`签到请求失败：${error.message}`, 'bad')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '立刻签到' }
  }
}

async function saveProviderConfig(id) {
  const btn = $('#btn-save')
  const msg = $('#save-msg')
  if (btn) btn.disabled = true
  if (msg) msg.textContent = ''
  try {
    const r = await api('/config', {
      method: 'POST',
      body: {
        providers: {
          [id]: {
            enabled: $('#p-enabled').checked,
            time: $('#p-time').value || '09:00',
            catchUp: $('#p-catchup').checked,
          },
        },
      },
    })
    if (r.ok) {
      if (msg) { msg.textContent = '已保存'; setTimeout(() => { if (msg) msg.textContent = '' }, 2500) }
      await refresh({ withPanels: false })
    } else if (msg) {
      msg.textContent = r.message || '保存失败'
    }
  } catch (error) {
    if (msg) msg.textContent = `保存失败：${error.message}`
  } finally {
    if (btn) btn.disabled = false
  }
}

/* ── 登录（只有 MiniMax 支持设备码） ── */

let loginPoll = 0
async function startLogin(id) {
  hideBanner()
  try {
    const info = await api(`/login/start?id=${encodeURIComponent(id)}`, { method: 'POST' })
    if (!info.ok) {
      banner(info.message || '申请登录码失败', 'bad')
      return
    }
    $('#login').classList.remove('hidden')
    $('#login-title').textContent = `登录 ${providerOf(id) ? providerOf(id).name : ''}`
    $('#login-code').textContent = info.userCode
    $('#login-link').href = info.verificationUriComplete || info.verificationUri
    $('#login-link').textContent = info.verificationUriComplete || info.verificationUri
    $('#login-status').textContent = `等待确认…（${Math.round(info.expiresInSec / 60)} 分钟内有效）`

    clearInterval(loginPoll)
    loginPoll = setInterval(async () => {
      try {
        const r = await api(`/login/wait?id=${encodeURIComponent(id)}`, { method: 'POST' })
        if (r.ok) {
          clearInterval(loginPoll)
          $('#login').classList.add('hidden')
          banner('登录成功', 'ok')
          await refresh()
        } else if (r.code !== 'OAUTH_ABORTED') {
          $('#login-status').textContent = r.message || '等待确认…'
        }
      } catch { /* 继续等 */ }
    }, 3000)
  } catch (error) {
    banner(`申请登录码失败：${error.message}`, 'bad')
  }
}

function closeLogin() {
  clearInterval(loginPoll)
  $('#login').classList.add('hidden')
  void api(`/login/cancel?id=${encodeURIComponent(CURRENT || 'minimax')}`, { method: 'POST' }).catch(() => {})
}

/* ── 绑定 ── */

$('#login-close').onclick = closeLogin
$('#copy-code').onclick = async () => {
  const code = $('#login-code').textContent
  try {
    await navigator.clipboard.writeText(code)
    $('#copy-code').textContent = '已复制'
    setTimeout(() => { $('#copy-code').textContent = '复制' }, 1800)
  } catch {
    const range = document.createRange()
    range.selectNodeContents($('#login-code'))
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  }
}

refresh()
// 面板开着的时候每分钟对一次表（App 那边也可能刚签过）
setInterval(() => { if (!document.hidden) void refresh({ withPanels: false }) }, 60_000)
