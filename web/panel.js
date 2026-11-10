/* dsh-checkin-all 面板 —— 顶部索引（每个签到服务一张卡）+ 下面切到对应详情 */

const $ = selector => document.querySelector(selector)
const BASE = '/api-dsh-checkin-all'

const esc = value => String(value == null ? '' : value)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(BASE + path, {
    method,
    credentials: 'same-origin',
    headers: method === 'POST' || method === 'DELETE'
      ? { 'content-type': 'application/json', 'x-dsh-checkin-all': '1' }
      : undefined,
    body: method === 'POST' || method === 'DELETE' ? JSON.stringify(body || {}) : undefined,
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
// 空字符串 = 只看卡片（首页）；点了某张卡才有值 → 显示该服务详情
let CURRENT = ''
const PANELS = new Map() // id -> 签到表（缓存，切回不闪）

/* ── 界面偏好（存 localStorage）── */
const PREFS_KEY = 'dsh-checkin-all:prefs'

/** 哪些服务被用户手动折叠/展开 */
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    const j = raw ? JSON.parse(raw) : {}
    return {
      order: Array.isArray(j.order) ? j.order : [],        // 自定义排序（id 数组）
      collapsed: j.collapsed && typeof j.collapsed === 'object' ? j.collapsed : {}, // id -> true/false
      autoCollapse: j.autoCollapse !== false,              // 默认自动折叠「不用关注」的
    }
  } catch {
    return { order: [], collapsed: {}, autoCollapse: true }
  }
}
function savePrefs(next) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)) } catch { /* 隐私模式就算了 */ }
}
let PREFS = loadPrefs()

/** 「不用关注」的服务：自动折起来，省地方 */
function isIdle(p) {
  const st = p.state || {}
  if (!p.account || !p.account.loggedIn) return true          // 未登录
  if (!p.config || !p.config.enabled) return true             // 自动签到关着
  const last = st.lastAttempt
  const outcome = (last && last.outcome) || ''
  if (outcome === 'no_task' || outcome === 'not_yet') return true  // 没这玩法 / 还没到轮次
  return false
}

/** 按用户排序排好，没排过的保持原顺序跟在后面 */
function orderedProviders(list) {
  const rank = new Map(PREFS.order.map((id, i) => [id, i]))
  return [...list].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER
    const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER
    return ra - rb
  })
}

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

/** 一张卡片（两行紧凑布局） */
function cardHTML(p, { dragging = false } = {}) {
  const st = p.state || {}
  const last = st.lastAttempt
  const todayDone = st.claimedToday
  const on = p.config && p.config.enabled
  const lastOutcome = (last && last.outcome) || ''
  const benign = lastOutcome === 'no_task' || lastOutcome === 'not_yet'
  const needsLogin = lastOutcome === 'needs_login'
  const loggedIn = Boolean(p.account && p.account.loggedIn)

  const loginMark = loggedIn
    ? '<span class="cmark ok" aria-hidden="true">✓</span>'
    : '<span class="cmark bad" aria-hidden="true">✗</span>'
  const loginText = loggedIn
    ? '已登录'
    : needsLogin ? '已过期'
      : (p.account && p.account.label === '登录已过期') ? '已过期'
        : '未登录'

  let checkMark
  let checkText
  if (!loggedIn) {
    checkMark = '<span class="cmark idle" aria-hidden="true">–</span>'
    checkText = '无法签'
  } else if (todayDone) {
    checkMark = '<span class="cmark ok" aria-hidden="true">✓</span>'
    checkText = last && last.points > 0 ? `已签 +${last.points}` : '已签'
  } else if (benign) {
    checkMark = '<span class="cmark idle" aria-hidden="true">–</span>'
    checkText = lastOutcome === 'no_task' ? '无任务' : '未到轮次'
  } else if (last && !last.ok) {
    checkMark = '<span class="cmark bad" aria-hidden="true">✗</span>'
    checkText = '上次失败'
  } else {
    checkMark = '<span class="cmark warn" aria-hidden="true">○</span>'
    checkText = '未签'
  }

  const streakText = st.streak ? `连续 ${st.streak} 天` : ''
  return `<div class="icard${p.id === CURRENT ? ' on' : ''}${dragging ? ' dragging' : ''}"
      data-id="${esc(p.id)}" draggable="true" style="--brand:${esc(p.color)}"
      role="button" tabindex="0"
      title="${esc(p.name)}｜${esc(loginText)}｜${esc(checkText)}${st.streak ? `｜连续 ${st.streak} 天` : ''}${on ? `｜每天 ${esc(p.config.time)}` : '｜自动签到已关闭'}">
    <div class="ihead">
      <span class="iname">${esc(p.short)}</span>
      <span class="istreak">${esc(streakText)}</span>
    </div>
    <div class="istat">
      <span class="istat-item">${loginMark}<span class="itxt">${esc(loginText)}</span></span>
      <span class="istat-item">${checkMark}<span class="itxt">${esc(checkText)}</span></span>
    </div>
  </div>`
}

function renderIndex() {
  const box = $('#index')
  const all = (STATUS && STATUS.providers) || []
  if (!all.length) {
    box.innerHTML = '<div class="index-loading muted">没有可用的签到服务</div>'
    return
  }

  const list = orderedProviders(all)
  // 分两组：需要关注的（展开）/ 不用关注的（可折叠）
  const active = []
  const idle = []
  for (const p of list) {
    const userSays = PREFS.collapsed[p.id]           // true=手动折叠 / false=手动展开
    const shouldCollapse = userSays === undefined
      ? (PREFS.autoCollapse && isIdle(p))
      : userSays === true
    if (shouldCollapse) idle.push(p)
    else active.push(p)
  }

  const idleCollapsed = idle.length > 0 && PREFS.collapsed.__idle !== false

  box.innerHTML = `
    <div class="igroup">${active.map(p => cardHTML(p)).join('')}</div>
    ${idle.length ? `
      <button type="button" class="igroup-toggle" id="idle-toggle" aria-expanded="${!idleCollapsed}">
        <span class="chev">${idleCollapsed ? '▸' : '▾'}</span>
        ${idleCollapsed ? `已折叠 ${idle.length} 个（不用关注）` : `收起 ${idle.length} 个不用关注的`}
      </button>
      <div class="igroup${idleCollapsed ? ' hidden' : ''}" id="idle-group">
        ${idle.map(p => cardHTML(p)).join('')}
      </div>
    ` : ''}
    <button type="button" class="igroup-add" id="btn-add-service" title="把「添加新签到服务」的提示词发到对话里">＋ 添加签到服务</button>
  `

  // 点击卡片 → 看详情
  for (const el of box.querySelectorAll('.icard')) {
    el.onclick = () => select(el.dataset.id)
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(el.dataset.id) } }
  }
  const toggle = $('#idle-toggle')
  if (toggle) {
    toggle.onclick = () => {
      const nowCollapsed = PREFS.collapsed.__idle === false   // 当前是展开的 → 要收起
      PREFS.collapsed.__idle = nowCollapsed ? true : false
      savePrefs(PREFS)
      renderIndex()
    }
  }
  const addBtn = $('#btn-add-service')
  if (addBtn) addBtn.onclick = () => showAddServicePrompt()
  wireDrag(box)
}

/** 拖动排序：拖到另一张卡上就换位，松手存顺序 */
function wireDrag(box) {
  let dragId = ''
  const cards = [...box.querySelectorAll('.icard')]
  for (const el of cards) {
    el.addEventListener('dragstart', (e) => {
      dragId = el.dataset.id
      el.classList.add('dragging')
      try { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move' } catch { /* 忽略 */ }
    })
    el.addEventListener('dragend', () => {
      dragId = ''
      for (const c of box.querySelectorAll('.icard')) c.classList.remove('dragging', 'drop-target')
    })
    el.addEventListener('dragover', (e) => {
      if (!dragId || el.dataset.id === dragId) return
      e.preventDefault()
      el.classList.add('drop-target')
    })
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'))
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      el.classList.remove('drop-target')
      const from = dragId || e.dataTransfer?.getData('text/plain')
      const to = el.dataset.id
      if (!from || from === to) return
      reorder(from, to)
    })
  }
}

/** 把 from 挪到 to 的位置 */
function reorder(from, to) {
  const all = (STATUS && STATUS.providers) || []
  const ids = orderedProviders(all).map(p => p.id)
  const i = ids.indexOf(from)
  const j = ids.indexOf(to)
  if (i < 0 || j < 0) return
  ids.splice(i, 1)
  ids.splice(j, 0, from)
  PREFS.order = ids
  savePrefs(PREFS)
  renderIndex()
}

/* ── 详情：和原来那张卡一致 ── */

function renderDetail() {
  const p = providerOf(CURRENT)
  const box = $('#detail')
  // 没选中 → 首页模式：详情整块隐藏，只留卡片
  if (!p) {
    box.innerHTML = ''
    box.classList.add('hidden')
    document.body.classList.add('cards-only')
    return
  }
  box.classList.remove('hidden')
  document.body.classList.remove('cards-only')
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

  const canLogin = p.id === 'minimax' || p.id === 'codearts' || p.id === 'buddy'
  // 浏览器授权式登录（没有设备码，弹窗里只显示「等待浏览器授权」）
  const browserLogin = p.id === 'codearts' || p.id === 'buddy'
  // 支持手动配置凭据的服务
  const canManual = ['lingxi', 'dumate', 'astudio', 'trae', 'codearts'].includes(p.id)
  const isDoubao = p.id === 'doubao'
  const isBuddy = p.id === 'buddy'
  const isQoder = p.id === 'qoder'
  const manualHint = {
    lingxi: 'wps_sid 的值',
    dumate: '完整 Cookie 串（含 bce-user-info）',
    astudio: 'accountId,token,ssoSessionId（逗号分隔）',
    trae: 'Cloud-IDE-JWT token',
    codearts: '华为云 AK/SK：access_key_id,secret_access_key[,security_token]（逗号分隔）',
  }[p.id]

  box.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h2>${esc(p.name)}</h2>
        <div class="head-actions">
          ${canLogin && (!account.loggedIn || p.id === 'buddy') ? '<button class="btn tiny" id="btn-login">登录</button>' : ''}
          ${canManual ? '<button class="btn tiny" id="btn-cred">配置凭据</button>' : ''}
          ${isQoder ? '<button class="btn tiny" id="btn-qoder">配置令牌</button>' : ''}
          ${isDoubao ? '<button class="btn tiny" id="btn-doubao">配置 Cookie</button>' : ''}
          ${isBuddy ? '<button class="btn tiny" id="btn-buddy">手动粘贴</button>' : ''}
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

    ${isQoder ? `
    <section class="card" id="qoder-card">
      <div class="card-head"><h2>Qoder 令牌</h2><span class="hint" id="qoder-status"></span></div>
      <div class="field">
        <p class="hint"><b>先看这里：</b>本机装了 Qoder 桌面 App 并且登录着的话，<b>不用填令牌</b>——插件会自动读 App 里的登录（看上面「登录状态」）。这一栏只用于没有 App、或者想再加一个账号的情况。</p>
      </div>
      <div class="field">
        <p class="hint">令牌在 <b>Qoder 网页版</b>创建，不在桌面 App 里，所以 App 里翻不到。步骤：浏览器登录 Qoder →
          <a class="link" href="https://qoder.com/account/integrations" target="_blank" rel="noreferrer">海外版 ↗</a> /
          <a class="link" href="https://qoder.com.cn/account/integrations" target="_blank" rel="noreferrer">国内版 ↗</a> →
          点「创建令牌」→ 复制。令牌以 <code>pt-</code> 开头，只显示一次。旧版页面可能在「设置 → API 令牌」或「账号 → 集成」下面。</p>
      </div>
      <div class="field">
        <label for="qoder-pat">个人访问令牌（PAT）</label>
        <input type="password" id="qoder-pat" placeholder="pt-... 粘贴令牌">
      </div>
      <div class="field">
        <label for="qoder-name">备注名（可选）</label>
        <input type="text" id="qoder-name" placeholder="例如：主号 / 小号">
      </div>
      <div class="field">
        <label for="qoder-region">区域</label>
        <select id="qoder-region">
          <option value="cn">国内版（openapi.qoder.com.cn）</option>
          <option value="intl">海外版（openapi.qoder.sh）</option>
        </select>
      </div>
      <div class="actions">
        <button class="btn primary" id="btn-qoder-add">添加令牌</button>
        <span id="qoder-msg" class="hint"></span>
      </div>
      <div id="qoder-list" class="field"></div>
    </section>
    ` : ''}

    ${isDoubao ? `
    <section class="card" id="doubao-card">
      <div class="card-head"><h2>豆包 Cookie</h2><span class="hint" id="doubao-status"></span></div>
      <div class="field">
        <p class="hint">豆包的「天天领额度」需要<b>个人账号</b>的登录 Cookie。从浏览器开发者工具 → 网络 → 任意请求的请求头里复制整条 Cookie 粘贴到这里。</p>
        <p class="hint"><b>工作版 / 飞书企业账号没有这个玩法</b>——服务端任务列表里只有 <code>chat_activity</code>（聊天任务）和累计额度里程碑，没有 <code>daily_signin</code>，签到接口会直接回「系统错误」。这不是 Cookie 的问题，换个人豆包账号登录就行。</p>
      </div>
      <div class="field">
        <label for="doubao-cookie">Cookie（doubao.com）</label>
        <textarea id="doubao-cookie" rows="3" placeholder="整条 Cookie"></textarea>
      </div>
      <div class="field">
        <label for="doubao-name">备注名（可选）</label>
        <input type="text" id="doubao-name" placeholder="例如：主号">
      </div>
      <div class="actions">
        <button class="btn primary" id="btn-doubao-add">添加账号</button>
        <button class="btn" id="btn-doubao-scan">从本机豆包读</button>
        <span id="doubao-msg" class="hint"></span>
      </div>
      <div id="doubao-list" class="field"></div>
    </section>
    ` : ''}

    ${isBuddy ? `
    <section class="card" id="buddy-card">
      <div class="card-head"><h2>WorkBuddy 账号</h2><span class="hint" id="buddy-status"></span></div>
      <div class="field">
        <p class="hint"><b>国内版</b>（copilot.tencent.com）有每日领取；<b>国际版</b>（workbuddy.ai）目前只有模型接入，没有签到。
          令牌获取：登录对应站点后，打开开发者工具 → 网络 → 任意 API 请求，从请求头里复制 <code>Authorization</code> 的 <code>Bearer</code> 后面那串。</p>
      </div>
      <div class="field">
        <label for="buddy-token">access_token</label>
        <textarea id="buddy-token" rows="2" placeholder="Bearer 后面那串"></textarea>
      </div>
      <div class="field">
        <label for="buddy-region">产品线</label>
        <select id="buddy-region">
          <option value="cn">国内版（有签到）</option>
          <option value="intl">国际版（无签到）</option>
        </select>
      </div>
      <div class="field">
        <label for="buddy-name">备注名（可选）</label>
        <input type="text" id="buddy-name" placeholder="例如：主号">
      </div>
      <div class="actions">
        <button class="btn primary" id="btn-buddy-add">添加账号</button>
        <span id="buddy-msg" class="hint"></span>
      </div>
      <div id="buddy-list" class="field"></div>
    </section>
    ` : ''}

    ${canManual ? `
    <section class="card" id="cred-card">
      <div class="card-head">
        <h2>账号</h2>
        <span class="hint" id="cred-status"></span>
      </div>
      <div id="cred-list" class="field"></div>
      <div class="field">
        <label for="cred-value">${esc(manualHint)}</label>
        <textarea id="cred-value" rows="3" placeholder="${esc(manualHint)}"></textarea>
      </div>
      <div class="field">
        <label for="cred-name">备注名（可选，多账号时区分用）</label>
        <input type="text" id="cred-name" placeholder="例如：主号 / 小号">
      </div>
      <div class="actions">
        <button class="btn primary" id="btn-cred-save">添加账号</button>
        <button class="btn" id="btn-cred-clear">清空全部</button>
        <span id="cred-msg" class="hint"></span>
      </div>
    </section>
    ` : ''}

    <section class="card">
      <div class="card-head">
        <h2 id="week-title">本周签到表</h2>
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

  // Qoder 令牌配置
  const qoderBtn = $('#btn-qoder')
  const qoderCard = $('#qoder-card')
  if (qoderCard && qoderBtn) {
    qoderBtn.onclick = () => { qoderCard.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
    $('#btn-qoder-add').onclick = () => addQoderPat()
    loadQoderList()
  }

  // 豆包 Cookie（多账号）
  const doubaoBtn = $('#btn-doubao')
  const doubaoCard = $('#doubao-card')
  if (doubaoCard && doubaoBtn) {
    doubaoBtn.onclick = () => { doubaoCard.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
    $('#btn-doubao-add').onclick = () => addDoubaoCookie()
    const scanBtn = $('#btn-doubao-scan')
    if (scanBtn) scanBtn.onclick = () => scanDoubaoCookie()
    loadDoubaoList()
  }

  // WorkBuddy（多账号）
  const buddyBtn = $('#btn-buddy')
  const buddyCard = $('#buddy-card')
  if (buddyCard && buddyBtn) {
    buddyBtn.onclick = () => { buddyCard.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
    $('#btn-buddy-add').onclick = () => addBuddyAccount()
    loadBuddyList()
  }

  // 手动凭据配置
  const credBtn = $('#btn-cred')
  const credCard = $('#cred-card')
  if (credCard && credBtn) {
    credBtn.onclick = () => { credCard.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
    $('#btn-cred-save').onclick = () => saveCredential(p.id)
    $('#btn-cred-clear').onclick = () => clearCredential(p.id)
    loadCredentialStatus(p.id)
  }

  renderHistory(st.recent)
  const cached = PANELS.get(p.id)
  if (cached) renderWeek(cached)
  else loadPanel(p.id)
}

/** 加载豆包 Cookie 列表 */
async function loadDoubaoList() {
  const box = $('#doubao-list')
  const status = $('#doubao-status')
  if (!box) return
  try {
    const r = await api('/doubao')
    if (!r.ok) { box.innerHTML = `<span class="muted">${esc(r.message || '读取失败')}</span>`; return }
    const list = r.doubaos || []
    if (status) status.textContent = list.length ? `已配置 ${list.length} 个账号` : '未配置'
    if (!list.length) { box.innerHTML = '<span class="muted">还没有配置 Cookie</span>'; return }
    box.innerHTML = list.map((d) => `
      <div class="row">
        <span class="label">${esc(d.name || `#${d.id}`)}${d.from ? ` · 来自${esc(d.from)}` : ''}</span>
        <span class="value">
          <button class="btn tiny" data-doubao-del="${esc(d.id)}">删除</button>
        </span>
      </div>`).join('')
    for (const btn of box.querySelectorAll('[data-doubao-del]')) {
      btn.onclick = () => removeDoubaoCookie(btn.dataset.doubaoDel)
    }
  } catch (e) {
    box.innerHTML = `<span class="muted">${esc(e.message)}</span>`
  }
}

/** 添加豆包 Cookie */
async function addDoubaoCookie() {
  const msg = $('#doubao-msg')
  const cookie = $('#doubao-cookie').value.trim()
  const name = $('#doubao-name').value.trim()
  if (!cookie) { if (msg) msg.textContent = '请输入 Cookie'; return }
  try {
    const r = await api('/doubao', { method: 'POST', body: { cookie, name } })
    if (r.ok) {
      if (msg) { msg.textContent = '已添加'; setTimeout(() => { if (msg) msg.textContent = '' }, 2500) }
      $('#doubao-cookie').value = ''
      $('#doubao-name').value = ''
      loadDoubaoList()
      await refresh({ withPanels: false })
    } else if (msg) {
      msg.textContent = r.message || '添加失败'
    }
  } catch (e) {
    if (msg) msg.textContent = `添加失败：${e.message}`
  }
}

/** 加载 WorkBuddy 账号列表 */
async function loadBuddyList() {
  const box = $('#buddy-list')
  const status = $('#buddy-status')
  if (!box) return
  try {
    const r = await api('/buddy')
    if (!r.ok) { box.innerHTML = `<span class="muted">${esc(r.message || '读取失败')}</span>`; return }
    const list = r.accounts || []
    if (status) status.textContent = list.length ? `已配置 ${list.length} 个账号` : '未配置'
    if (!list.length) { box.innerHTML = '<span class="muted">还没有配置账号</span>'; return }
    box.innerHTML = list.map((a, i) => `
      <div class="row">
        <span class="label">${esc(a.name || (a.region === 'intl' ? '国际版' : '国内版'))}</span>
        <span class="value"><button class="btn tiny" data-buddy-del="${i}">删除</button></span>
      </div>`).join('')
    for (const btn of box.querySelectorAll('[data-buddy-del]')) {
      btn.onclick = () => removeBuddyAccount(Number(btn.dataset.buddyDel))
    }
  } catch (e) {
    box.innerHTML = `<span class="muted">${esc(e.message)}</span>`
  }
}

/** 添加 WorkBuddy 账号 */
async function addBuddyAccount() {
  const msg = $('#buddy-msg')
  const token = $('#buddy-token').value.trim()
  const region = $('#buddy-region').value
  const name = $('#buddy-name').value.trim()
  if (!token) { if (msg) msg.textContent = '请输入 access_token'; return }
  try {
    const r = await api('/buddy', { method: 'POST', body: { token, region, name } })
    if (r.ok) {
      if (msg) { msg.textContent = '已添加'; setTimeout(() => { if (msg) msg.textContent = '' }, 2500) }
      $('#buddy-token').value = ''
      $('#buddy-name').value = ''
      loadBuddyList()
      await refresh({ withPanels: false })
    } else if (msg) {
      msg.textContent = r.message || '添加失败'
    }
  } catch (e) {
    if (msg) msg.textContent = `添加失败：${e.message}`
  }
}

/** 删除 WorkBuddy 账号（按索引） */
async function removeBuddyAccount(index) {
  const msg = $('#buddy-msg')
  try {
    const r = await api(`/buddy?index=${index}`, { method: 'DELETE' })
    if (r.ok) {
      if (msg) { msg.textContent = '已删除'; setTimeout(() => { if (msg) msg.textContent = '' }, 2500) }
      loadBuddyList()
      await refresh({ withPanels: false })
    } else if (msg) {
      msg.textContent = r.message || '删除失败'
    }
  } catch (e) {
    if (msg) msg.textContent = `删除失败：${e.message}`
  }
}

/** 从本机豆包电脑版 / 浏览器读 Cookie（macOS 会问一次钥匙串权限） */
async function scanDoubaoCookie() {
  const msg = $('#doubao-msg')
  if (msg) msg.textContent = '正在读本机豆包的登录…'
  try {
    const r = await api('/doubao', { method: 'POST', body: { fromLocal: true } })
    if (r.ok) {
      if (msg) { msg.textContent = `已从「${r.from || '本机豆包'}」读到了`; setTimeout(() => { if (msg) msg.textContent = '' }, 3000) }
      loadDoubaoList()
      await refresh({ withPanels: false })
    } else if (msg) {
      msg.textContent = r.message || '读取失败'
    }
  } catch (e) {
    if (msg) msg.textContent = `读取失败：${e.message}`
  }
}

/** 删除豆包 Cookie */
async function removeDoubaoCookie(id) {
  const msg = $('#doubao-msg')
  try {
    const r = await api(`/doubao?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (r.ok) {
      if (msg) { msg.textContent = '已删除'; setTimeout(() => { if (msg) msg.textContent = '' }, 2500) }
      loadDoubaoList()
      await refresh({ withPanels: false })
    } else if (msg) {
      msg.textContent = r.message || '删除失败'
    }
  } catch (e) {
    if (msg) msg.textContent = `删除失败：${e.message}`
  }
}

/** 加载 Qoder 令牌列表（脱敏显示） */
async function loadQoderList() {
  const box = $('#qoder-list')
  const status = $('#qoder-status')
  if (!box) return
  try {
    const r = await api('/qoder')
    if (!r.ok) { box.innerHTML = `<span class="muted">${esc(r.message || '读取失败')}</span>`; return }
    const qoders = r.qoders || []
    if (status) status.textContent = qoders.length ? `已配置 ${qoders.length} 个令牌` : '未配置'
    if (!qoders.length) { box.innerHTML = '<span class="muted">还没有配置令牌</span>'; return }
    box.innerHTML = qoders.map((q) => `
      <div class="row">
        <span class="label">${esc(q.name || `#${q.id}`)} · ${q.region === 'intl' ? '海外' : '国内'}</span>
        <span class="value">
          <button class="btn tiny" data-qoder-del="${esc(q.id)}">删除</button>
        </span>
      </div>`).join('')
    for (const btn of box.querySelectorAll('[data-qoder-del]')) {
      btn.onclick = () => removeQoderPat(btn.dataset.qoderDel)
    }
  } catch (e) {
    box.innerHTML = `<span class="muted">${esc(e.message)}</span>`
  }
}

/** 添加 Qoder PAT（服务端会先验证 PAT 有效性） */
async function addQoderPat() {
  const msg = $('#qoder-msg')
  const pat = $('#qoder-pat').value.trim()
  const name = $('#qoder-name').value.trim()
  const region = $('#qoder-region').value
  if (!pat) { if (msg) msg.textContent = '请输入 PAT'; return }
  try {
    const r = await api('/qoder', { method: 'POST', body: { pat, name, region } })
    if (r.ok) {
      if (msg) { msg.textContent = '已添加'; setTimeout(() => { if (msg) msg.textContent = '' }, 2500) }
      $('#qoder-pat').value = ''
      $('#qoder-name').value = ''
      loadQoderList()
      await refresh({ withPanels: false })
    } else if (msg) {
      msg.textContent = r.message || '添加失败'
    }
  } catch (e) {
    if (msg) msg.textContent = `添加失败：${e.message}`
  }
}

/** 删除 Qoder PAT */
async function removeQoderPat(id) {
  const msg = $('#qoder-msg')
  try {
    const r = await api(`/qoder?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (r.ok) {
      if (msg) { msg.textContent = '已删除'; setTimeout(() => { if (msg) msg.textContent = '' }, 2500) }
      loadQoderList()
      await refresh({ withPanels: false })
    } else if (msg) {
      msg.textContent = r.message || '删除失败'
    }
  } catch (e) {
    if (msg) msg.textContent = `删除失败：${e.message}`
  }
}

/** 读某个服务的手动凭据状态（脱敏，只显示「已配置」） */
/** 各服务的凭据字段（多账号里每个账号存的就是这些） */
const CRED_FIELDS = {
  lingxi: (v) => ({ wps_sid: v }),
  dumate: (v) => ({ cookie: v }),
  astudio: (v) => {
    const [accountId, token, ssoSessionId] = v.split(',').map(x => x.trim())
    if (!accountId || !token) return { error: 'AStudio 需要 accountId 和 token（逗号分隔）' }
    return { accountId, token, ...(ssoSessionId ? { ssoSessionId } : {}) }
  },
  trae: (v) => ({ token: v }),
  codearts: (v) => {
    const [access_key_id, secret_access_key, security_token] = v.split(',').map(x => x.trim())
    if (!access_key_id || !secret_access_key) return { error: 'CodeArts 需要 access_key_id 和 secret_access_key（逗号分隔）' }
    return { access_key_id, secret_access_key, ...(security_token ? { security_token } : {}) }
  },
  doubao: (v) => ({ cookie: v }),
}

/** 加载账号列表（多账号） */
async function loadCredentialStatus(id) {
  const box = $('#cred-list')
  const status = $('#cred-status')
  if (!box) return
  try {
    const r = await api(`/accounts?provider=${encodeURIComponent(id)}`)
    if (!r.ok) { box.innerHTML = `<span class="muted">${esc(r.message || '读取失败')}</span>`; return }
    const list = r.accounts || []
    if (status) {
      status.textContent = list.length ? `${list.length} 个账号` : '还没有账号'
      status.className = list.length ? 'hint ok' : 'hint'
    }
    if (!list.length) {
      box.innerHTML = '<span class="muted">还没有配置账号</span>'
      return
    }
    box.innerHTML = list.map((a) => `
      <div class="row">
        <span class="label">${esc(a.name || `账号 #${a.id}`)}</span>
        <span class="value"><button class="btn tiny" data-cred-del="${esc(a.id)}">删除</button></span>
      </div>`).join('')
    for (const btn of box.querySelectorAll('[data-cred-del]')) {
      btn.onclick = () => removeCredentialAccount(id, btn.dataset.credDel)
    }
  } catch (e) {
    box.innerHTML = `<span class="muted">${esc(e.message)}</span>`
  }
}

/** 添加一个账号 */
async function saveCredential(id) {
  const value = $('#cred-value').value.trim()
  const name = ($('#cred-name') && $('#cred-name').value.trim()) || ''
  const msg = $('#cred-msg')
  if (!value) { if (msg) msg.textContent = '请输入凭据值'; return }
  const make = CRED_FIELDS[id]
  if (!make) { if (msg) msg.textContent = '这个服务不支持手动配置'; return }
  const fields = make(value)
  if (fields.error) { if (msg) msg.textContent = fields.error; return }
  try {
    const r = await api(`/accounts?provider=${encodeURIComponent(id)}`, {
      method: 'POST', body: { entry: { ...fields, ...(name ? { name } : {}) } },
    })
    if (r.ok) {
      if (msg) { msg.textContent = `已添加（#${r.id}）`; setTimeout(() => { if (msg) msg.textContent = '' }, 2500) }
      $('#cred-value').value = ''
      if ($('#cred-name')) $('#cred-name').value = ''
      loadCredentialStatus(id)
      await refresh({ withPanels: false })
    } else if (msg) {
      msg.textContent = r.message || '添加失败'
    }
  } catch (e) {
    if (msg) msg.textContent = `添加失败：${e.message}`
  }
}

/** 删一个账号 */
async function removeCredentialAccount(id, accountId) {
  const msg = $('#cred-msg')
  try {
    const r = await api(`/accounts?provider=${encodeURIComponent(id)}&id=${encodeURIComponent(accountId)}`, { method: 'DELETE' })
    if (r.ok) {
      if (msg) { msg.textContent = '已删除'; setTimeout(() => { if (msg) msg.textContent = '' }, 2500) }
      loadCredentialStatus(id)
      await refresh({ withPanels: false })
    } else if (msg) {
      msg.textContent = r.message || '删除失败'
    }
  } catch (e) {
    if (msg) msg.textContent = `删除失败：${e.message}`
  }
}

/** 清空该服务的全部账号 */
async function clearCredential(id) {
  const msg = $('#cred-msg')
  try {
    const list = (await api(`/accounts?provider=${encodeURIComponent(id)}`)).accounts || []
    if (!list.length) { if (msg) msg.textContent = '本来就没有账号'; return }
    for (const a of list) {
      await api(`/accounts?provider=${encodeURIComponent(id)}&id=${encodeURIComponent(a.id)}`, { method: 'DELETE' })
    }
    if (msg) { msg.textContent = '已清空'; setTimeout(() => { if (msg) msg.textContent = '' }, 2500) }
    loadCredentialStatus(id)
    await refresh({ withPanels: false })
  } catch (e) {
    if (msg) msg.textContent = `清空失败：${e.message}`
  }
}

function renderWeek(panel) {
  const box = $('#week')
  if (!box) return
  if (!panel || !Array.isArray(panel.days) || !panel.days.length) {
    box.innerHTML = '<span class="muted">签到表读不出来</span>'
    return
  }

  // 「每日登录积分」型服务（如 AStudio）：只显示今天一天，标题改成「每日登录」
  const isDaily = panel.style === 'daily'
  const title = $('#week-title')
  if (title) title.textContent = isDaily ? '每日登录积分' : '本周签到表'

  if (isDaily) {
    const day = panel.days[0]
    const done = day.status === 3
    box.innerHTML = `<div class="day ${done ? 'claimed' : 'claimable'} today">
      <div class="no">今天</div>
      <div class="pts">+${day.points}</div>
      <div class="tag">${done ? '已到账' : '可领取'}</div>
    </div>`
  } else {
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
  }

  const note = $('#week-note')
  if (!note) return
  const parts = []
  if (isDaily) {
    parts.push(panel.today.status === 3
      ? `今天已自动到账 +${panel.today.points} 积分`
      : `今天可领取 +${panel.today.points} 积分`)
  } else if (panel.today) {
    parts.push(panel.today.status === 3
      ? `今天（第 ${panel.today.dayNo} 天）已签，+${panel.today.points + panel.today.bonusPoints}`
      : panel.today.status === 2
        ? `今天（第 ${panel.today.dayNo} 天）还没签，可领 ${panel.today.points + panel.today.bonusPoints}`
        : `今天（第 ${panel.today.dayNo} 天）不可领`)
  }
  if (!isDaily && panel.consecutiveDays !== undefined) parts.push(`连续 ${panel.consecutiveDays} 天`)
  if (!isDaily) parts.push(`本周已领 ${panel.claimedDays} 天，共 ${panel.totalPoints}`)
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
    // 选中的服务没了就回到首页（不再自动选第一个）
    if (CURRENT && !providerOf(CURRENT)) CURRENT = ''
    $('#version').textContent = status.version ? `v${status.version}` : ''
    const p = providerOf(CURRENT)
    $('#subtitle').textContent = p
      ? `${p.name}${p.config && p.config.enabled ? ` · 每天 ${p.config.time}` : ' · 自动签到已关'}`
      : '每天自动领积分'
    // 首页只显示卡片时，标题可点回卡片视图
    document.body.classList.toggle('cards-only', !p)
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

/** 点卡片看详情；再点同一张（或点标题）回卡片视图 */
function select(id) {
  const next = (id === CURRENT) ? '' : id
  CURRENT = next || ''
  hideBanner()
  renderIndex()
  renderDetail()
  const p = providerOf(CURRENT)
  document.body.classList.toggle('cards-only', !p)
  if (p) {
    $('#subtitle').textContent = `${p.name}${p.config && p.config.enabled ? ` · 每天 ${p.config.time}` : ' · 自动签到已关'}`
    // 进详情时滚到顶部，免得还要手动找
    try { window.scrollTo({ top: 0, behavior: 'smooth' }) } catch { /* 忽略 */ }
  } else {
    $('#subtitle').textContent = '每天自动领积分'
  }
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
async function startLogin(id, opts = {}) {
  hideBanner()
  try {
    // WorkBuddy 要带 region（国内版 / 国际版）
    const region = id === 'buddy' ? (($('#buddy-region') && $('#buddy-region').value) || 'cn') : undefined
    const qs = region ? `&region=${encodeURIComponent(region)}` : ''
    const info = await api(`/login/start?id=${encodeURIComponent(id)}${qs}`, { method: 'POST' })
    if (!info.ok) {
      banner(info.message || '申请登录码失败', 'bad')
      return
    }
    const isBrowserLogin = info.userCode === '' || info.userCode === undefined
    $('#login').classList.remove('hidden')
    $('#login-title').textContent = `登录 ${providerOf(id) ? providerOf(id).name : ''}`
    // 浏览器授权式登录没有设备码：把码框藏起来，只留「去授权」链接
    const codeBox = $('#login-code') && $('#login-code').closest('.code-box')
    if (codeBox) codeBox.style.display = isBrowserLogin ? 'none' : ''
    const copyBtn = $('#copy-code')
    if (copyBtn) copyBtn.style.display = isBrowserLogin ? 'none' : ''
    $('#login-code').textContent = info.userCode || ''
    $('#login-link').href = info.verificationUriComplete || info.verificationUri
    $('#login-link').textContent = isBrowserLogin ? '打开华为云登录页 ↗' : (info.verificationUriComplete || info.verificationUri)
    if (isBrowserLogin) {
      const mins = Math.round((info.expiresInSec || 180) / 60)
      $('#login-hint').textContent = info.opened
        ? `已在浏览器打开华为云登录页。在那里登录并同意授权，这个窗口会自动完成（${mins} 分钟内有效）。`
        : `浏览器没自动打开的话，点下面的链接登录并授权（${mins} 分钟内有效）。`
      $('#login-status').textContent = '等待浏览器授权…'
    } else {
      $('#login-hint').textContent = '在浏览器里打开下面的地址，输入设备码确认一次即可（和 App 里登录是同一个流程）。'
      $('#login-status').textContent = `等待确认…（${Math.round(info.expiresInSec / 60)} 分钟内有效）`
    }

    clearInterval(loginPoll)
    if (isBrowserLogin) {
      // 浏览器授权式：/login/wait 是一次性的长请求（服务端等到回调才返回），
      // 所以只发一次，不要每 3 秒重发——否则会在服务端堆出一串等待。
      $('#login-status').textContent = '等待浏览器授权…'
      try {
        const r = await api(`/login/wait?id=${encodeURIComponent(id)}${qs}`, { method: 'POST' })
        if (r.ok) {
          $('#login').classList.add('hidden')
          banner(`${id === 'buddy' ? 'WorkBuddy' : 'CodeArts'} 登录成功，凭据已保存`, 'ok')
          await refresh()
        } else {
          $('#login-status').textContent = r.message || '登录失败'
        }
      } catch (e) {
        $('#login-status').textContent = `登录失败：${e.message}`
      }
      return
    }
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

/* ── 添加签到服务 ── */

/** 打开「添加服务」弹窗 */
async function showAddServicePrompt() {
  const box = $('#addsvc')
  if (!box) return
  box.classList.remove('hidden')
  switchTab('ai')
  try {
    const r = await api('/custom', { method: 'POST', body: { prompt: true } })
    if (r.ok && $('#addsvc-prompt')) $('#addsvc-prompt').value = r.prompt || ''
  } catch (e) {
    if ($('#prompt-msg')) $('#prompt-msg').textContent = `取提示词失败：${e.message}`
  }
  loadCustomList()
}

function switchTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.tab === name)
  for (const id of ['ai', 'manual']) {
    const el = $(`#tab-${id}`)
    if (el) el.classList.toggle('hidden', id !== name)
  }
}

/** 已导入的自定义服务列表 */
async function loadCustomList() {
  const box = $('#custom-list')
  if (!box) return
  try {
    const r = await api('/custom')
    const list = r.services || []
    if (!list.length) { box.innerHTML = '<span class="muted">还没有自定义服务</span>'; return }
    box.innerHTML = list.map((s) => `
      <div class="row">
        <span class="label">${esc(s.name)}（${esc(s.id)}）</span>
        <span class="value"><button class="btn tiny" data-custom-del="${esc(s.id)}">删除</button></span>
      </div>`).join('')
    for (const btn of box.querySelectorAll('[data-custom-del]')) {
      btn.onclick = () => removeCustomService(btn.dataset.customDel)
    }
  } catch (e) {
    box.innerHTML = `<span class="muted">${esc(e.message)}</span>`
  }
}

/** 导入一段定义 */
async function importCustomService() {
  const ta = $('#addsvc-json')
  const msg = $('#import-msg')
  const text = ta ? ta.value.trim() : ''
  if (!text) { if (msg) msg.textContent = '先把 JSON 粘进来'; return }
  if (msg) msg.textContent = '导入中…'
  try {
    const r = await api('/custom', { method: 'POST', body: { text } })
    if (r.ok) {
      if (msg) msg.textContent = `已导入「${r.service?.name || r.id}」，卡片已出现`
      if (ta) ta.value = ''
      loadCustomList()
      await refresh({ withPanels: false })
    } else if (msg) {
      msg.textContent = r.message || '导入失败'
    }
  } catch (e) {
    if (msg) msg.textContent = `导入失败：${e.message}`
  }
}

/** 删一个自定义服务 */
async function removeCustomService(id) {
  const msg = $('#import-msg')
  try {
    const r = await api(`/custom?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (r.ok) {
      if (msg) msg.textContent = '已删除'
      loadCustomList()
      await refresh({ withPanels: false })
    } else if (msg) {
      msg.textContent = r.message || '删除失败'
    }
  } catch (e) {
    if (msg) msg.textContent = `删除失败：${e.message}`
  }
}

/* 弹窗事件 */
for (const t of document.querySelectorAll('.tab')) {
  t.onclick = () => switchTab(t.dataset.tab)
}
if ($('#addsvc-close')) $('#addsvc-close').onclick = () => $('#addsvc').classList.add('hidden')
if ($('#addsvc')) {
  $('#addsvc').onclick = (e) => { if (e.target.id === 'addsvc') $('#addsvc').classList.add('hidden') }
}
if ($('#btn-copy-prompt')) {
  $('#btn-copy-prompt').onclick = async () => {
    const ta = $('#addsvc-prompt')
    const msg = $('#prompt-msg')
    try {
      await navigator.clipboard.writeText(ta.value)
      if (msg) { msg.textContent = '已复制，去对话里粘贴'; setTimeout(() => { if (msg) msg.textContent = '' }, 3000) }
    } catch {
      ta.select()
      if (msg) msg.textContent = '自动复制失败，已选中，按 Cmd+C 复制'
    }
  }
}
if ($('#btn-import-svc')) $('#btn-import-svc').onclick = () => importCustomService()

/* 点标题回卡片视图 */
if ($('#back-home')) $('#back-home').onclick = () => select('')
