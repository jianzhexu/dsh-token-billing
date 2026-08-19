/**
 * dsh-token-billing — Host half（持久化版本）。
 *
 * 按 DeepSeek 官方定价（https://api-docs.deepseek.com/zh-cn/quick_start/pricing）
 * 对每次模型调用记账：模型（flash/pro）、高峰/空闲时段、缓存命中/未命中。
 *
 * 持久化：账本不再是内存 Map——每次调用先写入 storage-domain 的
 * `token_billing` 领域（`~/.dsh/storages/token_billing.json`，json 后端），
 * 启动时从领域重建内存账本后继续记账。进程重启后历史记录保留。
 *
 * 账本按 session 累计，聚合出工作区（workspace 实体账本）与全局汇总，
 * 通过 HTTP JSON 路由 /api/token-billing 暴露给浏览器端插件。
 */

import { billingDomainSpec, recordKey } from './domain.js'

// 价格表（单位：元 / 百万 tokens）。高峰时段为北京时间 9:00-12:00、14:00-18:00；
// 空闲时段价格为高峰的一半。
const PRICES = {
  flash: {
    hit: { peak: 0.1, 'off-peak': 0.05 },
    miss: { peak: 3, 'off-peak': 1.5 },
    output: { peak: 9, 'off-peak': 4.5 },
  },
  pro: {
    hit: { peak: 0.3, 'off-peak': 0.15 },
    miss: { peak: 9, 'off-peak': 4.5 },
    output: { peak: 27, 'off-peak': 13.5 },
  },
}
const PRICE_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'

const round4 = (n) => Math.round(n * 1e4) / 1e4
const zeroTotals = () => ({ calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, cost: 0 })
const addTo = (totals, other) => {
  totals.calls += other.calls
  totals.inputTokens += other.inputTokens
  totals.cacheReadTokens += other.cacheReadTokens
  totals.cacheWriteTokens += other.cacheWriteTokens
  totals.outputTokens += other.outputTokens
  totals.cost = round4(totals.cost + other.cost)
}

// 北京时间（UTC+8）当前小时
const beijingHour = (at) => new Date(at + 8 * 3600 * 1000).getUTCHours()
const periodOf = (at) => {
  const h = beijingHour(at)
  return (h >= 9 && h < 12) || (h >= 14 && h < 18) ? 'peak' : 'off-peak'
}
// 模型 -> 价格档位；不在定价页上的模型记入 other（不计价）
const modelKey = (model) => {
  const m = String(model || '').toLowerCase()
  if (m.includes('pro')) return 'pro'
  if (m.includes('flash')) return 'flash'
  return 'other'
}
const normPath = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase()
const basename = (p) => {
  const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(p)
}

export default {
  name: 'token-billing',
  inject: ['webServer', 'storageDomain'],
  async apply(ctx) {
    // 打开领域：加载并校验全部存量记录；调用方（本插件）拥有句柄，卸载时关闭。
    const domain = await ctx.storageDomain.open(billingDomainSpec)
    ctx.effect(() => async () => {
      await domain.close()
    })
    const callsTable = domain.table('calls')

    const workspaceRegistry = ctx.get('workspaceRegistry')
    // 目录 -> workspace 实体索引（path -> { id, title }）
    const workspaceIndexOf = () => {
      const idx = new Map()
      if (!workspaceRegistry) return idx
      let list = []
      try { list = workspaceRegistry.list() || [] } catch (e) { /* 忽略 */ }
      for (const w of list) {
        if (w && w.path) idx.set(normPath(w.path), { id: String(w.id), title: w.title || basename(w.path) })
      }
      return idx
    }
    // 会话工作目录 -> 工作区归属；优先 workspace 实体，未匹配退回 cwd
    const resolveWorkspace = (cwd) => {
      if (!cwd) return { id: null, key: 'unknown', title: '未知工作区', path: null }
      const hit = workspaceIndexOf().get(normPath(cwd))
      if (hit) return { id: hit.id, key: 'ws:' + hit.id, title: hit.title, path: String(cwd) }
      return { id: null, key: 'cwd:' + normPath(cwd), title: basename(cwd), path: String(cwd) }
    }

    // 空白会话判定缓存（非 live 会话使用；live 会话直接查事件）
    const blankCache = new Map()
    async function isBlank(sessionId) {
      const sessions = ctx.get('sessions')
      const s = sessions ? sessions.get(sessionId) : undefined
      if (s) {
        let hasTurn = false
        try {
          const evs = s.events
          if (evs && evs.some) hasTurn = evs.some((e) => e && e.type === 'turn/start')
        } catch (e) { /* 忽略 */ }
        return !hasTurn
      }
      if (blankCache.has(sessionId)) return blankCache.get(sessionId)
      const q = ctx.get('sessionQuery')
      if (!q) return false
      try {
        const snap = await q.readSession(sessionId)
        const hasTurn = !!(snap && snap.events && snap.events.some((e) => e && e.type === 'turn/start'))
        const blank = !hasTurn
        blankCache.set(sessionId, blank)
        return blank
      } catch (e) {
        return false
      }
    }

    // sessionId -> { totals, byModel, lastCall, workspace, lastSeq }
    // 持久化的权威在领域表；内存账本是启动时重建的聚合投影。
    const ledger = new Map()

    // 启动：从持久化记录重建账本（聚合 + 恢复去重基线与序号）。
    function loadLedger() {
      for (const [, rec] of callsTable.entries()) {
        const sessionId = rec.sessionId
        let entry = ledger.get(sessionId)
        if (!entry) {
          entry = { totals: zeroTotals(), byModel: {}, lastCall: null, workspace: rec.workspace, lastSeq: -1 }
          ledger.set(sessionId, entry)
        }
        addTo(entry.totals, {
          calls: 1,
          inputTokens: rec.inputTokens,
          cacheReadTokens: rec.cacheReadTokens,
          cacheWriteTokens: rec.cacheWriteTokens,
          outputTokens: rec.outputTokens,
          cost: rec.cost,
        })
        const mk = modelKey(rec.model)
        const bm = entry.byModel[mk] || (entry.byModel[mk] = zeroTotals())
        addTo(bm, {
          calls: 1,
          inputTokens: rec.inputTokens,
          cacheReadTokens: rec.cacheReadTokens,
          cacheWriteTokens: rec.cacheWriteTokens,
          outputTokens: rec.outputTokens,
          cost: rec.cost,
        })
        entry.lastCall = { at: rec.at, model: rec.model, period: rec.period, known: rec.known, cost: rec.cost }
        if (rec.seq > entry.lastSeq) entry.lastSeq = rec.seq
      }
    }

    loadLedger()

    // 记账：先持久化（put 在 durability 后才更新领域内存），成功后再更新投影。
    async function recordCall(options, usage) {
      const sessionId = options.sessionId
      if (!sessionId) return // 无法归属到会话的调用不计入
      const model = String(options.model || 'unknown')
      const now = Date.now()
      const buckets = {
        inputTokens: usage.inputTokens || 0,
        cacheReadTokens: usage.cacheReadTokens || 0,
        cacheWriteTokens: usage.cacheWriteTokens || 0,
        outputTokens: usage.outputTokens || 0,
      }
      const entry = ledger.get(sessionId) || { totals: zeroTotals(), byModel: {}, lastCall: null, workspace: null, lastSeq: -1 }
      // 解析工作区归属（会话的工作目录 -> workspace 实体），仅首次解析
      if (!entry.workspace) {
        const sessions = ctx.get('sessions')
        const session = sessions ? sessions.get(sessionId) : undefined
        const cwd = session && session.header ? session.header.cwd : undefined
        entry.workspace = resolveWorkspace(cwd)
      }
      // 重放去重：与上一笔记录总量完全相同且发生在 90 秒内 → 视为同一请求的重放，避免重复计费
      const last = entry.lastCall
      if (last && last.model === model && (now - last.at) < 90000 &&
          last.inputTokens === buckets.inputTokens &&
          last.cacheReadTokens === buckets.cacheReadTokens &&
          last.cacheWriteTokens === buckets.cacheWriteTokens &&
          last.outputTokens === buckets.outputTokens) {
        return
      }
      const period = periodOf(now)
      const price = PRICES[modelKey(model)] || null
      const missTokens = buckets.inputTokens + buckets.cacheWriteTokens
      const cost = price
        ? (missTokens * price.miss[period] + buckets.cacheReadTokens * price.hit[period] + buckets.outputTokens * price.output[period]) / 1e6
        : 0
      const seq = entry.lastSeq + 1
      const rec = {
        sessionId,
        seq,
        at: now,
        model,
        period,
        known: !!price,
        cost: round4(cost),
        ...buckets,
        workspace: entry.workspace,
      }

      // 持久化失败不阻断记账：记录错误并继续更新内存（当会话内可见；重启后丢失该笔）。
      try {
        await callsTable.put(recordKey(sessionId, seq), rec)
      } catch (error) {
        ctx.logger.warn(`token-billing: persist call failed: ${String((error && error.message) || error)}`)
      }

      entry.lastSeq = seq
      addTo(entry.totals, { ...buckets, calls: 1, cost })
      const mk = modelKey(model)
      const bm = entry.byModel[mk] || (entry.byModel[mk] = zeroTotals())
      addTo(bm, { ...buckets, calls: 1, cost })

      entry.lastCall = { at: now, model, period, known: !!price, cost: round4(cost) }
      ledger.set(sessionId, entry)
    }

    // 拦截每次模型调用流（重试/重放/路由都经过此 waterfall），读取 usage 块并记账
    ctx.on('llm/stream', (options, next) => {
      const stream = next()
      return (async function* () {
        let usage = null
        let recorded = false
        try {
          for await (const chunk of stream) {
            if (chunk && chunk.type === 'usage' && chunk.usage) usage = chunk.usage
            yield chunk
          }
        } finally {
          if (!recorded && usage) {
            recorded = true
            await recordCall(options, usage)
          }
        }
      })()
    })

    // 组装账单（未指定会话时返回全局汇总）
    async function buildState(sessionId) {
      const entry = sessionId ? ledger.get(sessionId) : null
      // 全局汇总：所有会话合计
      const globalTotals = zeroTotals()
      const globalByModel = {}
      for (const e of ledger.values()) {
        addTo(globalTotals, e.totals)
        for (const mk of Object.keys(e.byModel)) {
          const bm = e.byModel[mk]
          const gm = globalByModel[mk] || (globalByModel[mk] = zeroTotals())
          addTo(gm, bm)
        }
      }
      // 工作区聚合：以 workspace 实体（账本）为准；会话数 = 可见会话（排除归档与空白，与侧边栏一致）
      const archived = new Set(workspaceRegistry ? (workspaceRegistry.archivedSessionIds || []) : [])
      const groups = new Map()
      const ensureGroup = (key, title, path, id) => {
        let g = groups.get(key)
        if (!g) {
          g = { key, id: id || null, title, path: path || null, totals: zeroTotals(), byModel: {}, sessionCount: 0 }
          groups.set(key, g)
        }
        return g
      }
      const foldEntry = (g, e) => {
        addTo(g.totals, e.totals)
        for (const mk of Object.keys(e.byModel)) {
          const bm = e.byModel[mk]
          const gm = g.byModel[mk] || (g.byModel[mk] = zeroTotals())
          addTo(gm, bm)
        }
      }
      if (workspaceRegistry) {
        let list = []
        try { list = workspaceRegistry.list() || [] } catch (e) { /* 忽略 */ }
        for (const w of list) {
          if (!w) continue
          const key = 'ws:' + String(w.id)
          const g = ensureGroup(key, w.title || basename(w.path || ''), w.path, String(w.id))
          const ids = w.sessionIds || []
          for (const sid of ids) {
            const e = ledger.get(sid)
            if (e) foldEntry(g, e)
          }
          for (const sid of ids) {
            if (archived.has(sid)) continue
            if (await isBlank(sid)) continue
            g.sessionCount += 1
          }
        }
      }
      // ledger 中未匹配到 workspace 实体的会话（cwd 兜底 / unknown）
      for (const e of ledger.values()) {
        const ws = e.workspace
        if (ws && ws.id && groups.has(ws.key)) continue
        const key = ws ? ws.key : 'unknown'
        let g = groups.get(key)
        if (!g) {
          g = ensureGroup(key, ws ? ws.title : '未知工作区', ws ? ws.path : null, ws && ws.id ? ws.id : null)
          g.sessionCount = 1
        }
        foldEntry(g, e)
      }
      const workspaceList = Array.from(groups.values()).sort((a, b) => b.totals.cost - a.totals.cost)
      // 当前会话所属工作区（即使当前会话尚无记账记录，也按 header.cwd 解析归属）
      let sessionWorkspace = null
      if (entry && entry.workspace) {
        sessionWorkspace = groups.get(entry.workspace.key) || null
      } else if (sessionId) {
        const sessions = ctx.get('sessions')
        const s = sessions ? sessions.get(sessionId) : undefined
        const cwd = s && s.header ? s.header.cwd : undefined
        const ws = resolveWorkspace(cwd)
        sessionWorkspace = groups.get(ws.key) || null
      }
      return {
        ok: true,
        sessionId,
        period: periodOf(Date.now()),
        totals: entry ? entry.totals : zeroTotals(),
        byModel: entry ? entry.byModel : {},
        lastCall: entry && entry.lastCall
          ? { at: entry.lastCall.at, model: entry.lastCall.model, period: entry.lastCall.period, known: entry.lastCall.known, cost: entry.lastCall.cost }
          : null,
        sessionWorkspace,
        workspaces: workspaceList,
        global: {
          totals: globalTotals,
          byModel: globalByModel,
          sessionCount: ledger.size,
        },
        prices: PRICES,
        source: PRICE_SOURCE,
        note: '扣减费用 = token 消耗量 × 模型单价；高峰时段为北京时间 9:00-12:00、14:00-18:00，其余为空闲时段（价格为高峰的一半）。工作区按 workspace 实体账本归属，会话数为侧边栏可见数（排除空白与归档会话）。账本已持久化（storage-domain json 后端），重启后保留。',
      }
    }

    // HTTP JSON 路由：浏览器端插件轮询此接口
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/token-billing',
      handler: async (req, res) => {
        let sessionId = null
        try {
          const query = new URL(req.url || '/', 'http://localhost').searchParams
          const raw = query.get('session')
          if (raw) sessionId = String(raw)
        } catch (e) { /* 忽略解析错误 */ }
        let payload
        try {
          payload = await buildState(sessionId)
        } catch (e) {
          payload = { ok: false, error: String(e && e.message || e) }
        }
        const body = JSON.stringify(payload)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      },
    })
  },
}
