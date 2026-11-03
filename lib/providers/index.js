// lib/providers/index.js — 签到服务注册表
//
// 加新服务就在这里登记一行，面板的索引卡片、调度器、AI 工具都会自动带上它。

import { createMinimaxProvider } from './minimax.js'
import { createLingxiProvider } from './lingxi.js'
import { createDumateProvider } from './dumate.js'
import { createAstudioProvider } from './astudio.js'

export function createProviders({ log = () => {}, config = async () => ({}), env = process.env } = {}) {
  const list = [
    createMinimaxProvider({ log, config }),
    createLingxiProvider({ log, env }),
    createDumateProvider({ log, env }),
    createAstudioProvider({ log, env }),
  ]
  const byId = new Map(list.map(p => [p.id, p]))
  return {
    list,
    get: id => byId.get(id) || null,
    ids: () => list.map(p => p.id),
    /** 索引卡片用的元信息（不联网） */
    meta: () => list.map(p => ({
      id: p.id, name: p.name, short: p.short, color: p.color, unit: p.unit,
      timeZoneMode: p.timeZoneMode, timeZone: p.timeZone || '',
    })),
  }
}

export { OUTCOME } from './base.js'
