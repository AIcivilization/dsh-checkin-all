// lib/providers/base.js — 一个「签到服务」的公共约定
//
// 每个签到服务（MiniMax Code、WPS 灵犀……）都实现同一套方法，面板和调度器只认这套接口，
// 加新服务时不用改面板、不用改调度器。
//
// 一个 provider 需要提供：
//   id            稳定标识（用在存储、路由、设置里）
//   name          显示名
//   short         短名（索引页签上用）
//   color         品牌色（索引卡片、图标）
//   needsLogin()  现在能不能用（凭据在不在）
//   account()     账号信息 { loggedIn, label, detail, expiresInSec? }
//   panel()       签到表 { days, today, claimable, claimedDays, totalPoints, description }
//   run(opts)     签到一次 → { ok, outcome, points, message, panel?, dayNo? }
//   loginStart()  可选：发起登录
//   loginWait()   可选：等登录完成
//   cancelLogin() 可选
//
// run() 的 outcome 约定（面板和统计按这个认）：
//   'claimed'          刚领到分
//   'already_claimed'  今天已经领过
//   'dry-run'          只看了没领
//   其他               失败（配合 ok:false）

export const OUTCOME = {
  CLAIMED: 'claimed',
  ALREADY: 'already_claimed',
  DRY: 'dry-run',
  FAILED: 'failed',
}

/** 统一的失败结果，provider 抛错时由 runner 包成这个 */
export function failure(providerId, error, extra = {}) {
  return {
    ok: false,
    outcome: error && error.code ? error.code : 'error',
    provider: providerId,
    points: 0,
    message: (error && error.message) || String(error),
    ...extra,
  }
}

/**
 * 只读模式：凭据是从别的机器拷来的，不能动 refresh token。
 * 环境变量 DSH_CHECKIN_ALL_READONLY=1，或在 profile 配置里写 readonly: true。
 */
export function isReadOnly(env = process.env) {
  const v = String(env.DSH_CHECKIN_ALL_READONLY || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/** 签到表里一天的状态 */
export const DAY_STATUS = { upcoming: 1, claimable: 2, claimed: 3, disabled: 4, locked: 4 }
