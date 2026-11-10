// lib/providers/index.js — 签到服务注册表
//
// 内置 9 个服务 + 用户自定义的服务（custom-services.json）。
// 加内置服务就在下面登记一行；自定义服务由 loadCustomServices() 动态加载，
// 面板的索引卡片、调度器、AI 工具都会自动带上。

import { createMinimaxProvider } from './minimax.js'
import { createLingxiProvider } from './lingxi.js'
import { createDumateProvider } from './dumate.js'
import { createAstudioProvider } from './astudio.js'
import { createQoderProvider } from './qoder.js'
import { createTraeProvider } from './trae.js'
import { createDoubaoProvider } from './doubao.js'
import { createCodeArtsProvider } from './codearts.js'
import { createBuddyProvider } from './buddy.js'
import { createCustomProvider } from './custom.js'
import { loadCustomServices } from '../custom-services.js'

export function createProviders({ log = () => {}, config = async () => ({}), env = process.env, customServices = null } = {}) {
  const list = [
    createMinimaxProvider({ log, config }),
    createLingxiProvider({ log, env }),
    createDumateProvider({ log, env }),
    createAstudioProvider({ log, env }),
    createQoderProvider({ log, env }),
    createTraeProvider({ log, env }),
    createDoubaoProvider({ log, env }),
    createCodeArtsProvider({ log, env }),
    createBuddyProvider({ log, env }),
  ]

  // 自定义服务：传了就用传的（同步场景），没传就现读
  const customs = Array.isArray(customServices) ? customServices : []
  for (const def of customs) {
    if (!def || !def.id) continue
    if (list.some((p) => p.id === def.id)) continue
    list.push(createCustomProvider(def, { log, env }))
  }

  const byId = new Map(list.map(p => [p.id, p]))
  return {
    list,
    get: id => byId.get(id) || null,
    ids: () => list.map(p => p.id),
    /** 索引卡片用的元信息（不联网） */
    meta: () => list.map(p => ({
      id: p.id, name: p.name, short: p.short, color: p.color, unit: p.unit,
      timeZoneMode: p.timeZoneMode, timeZone: p.timeZone || '',
      ...(p.custom ? { custom: true } : {}),
    })),
  }
}

/**
 * 异步版：先读自定义服务再建注册表。
 * runner / 面板都走这个，保证自定义卡片能出现。
 */
export async function createProvidersAsync({ log = () => {}, config = async () => ({}), env = process.env } = {}) {
  let customs = []
  try {
    customs = await loadCustomServices(env)
  } catch (error) {
    log(`dsh-checkin-all: 读自定义服务失败 ${error.message}`, 'warn')
  }
  return createProviders({ log, config, env, customServices: customs })
}

export { OUTCOME } from './base.js'
