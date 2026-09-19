/**
 * Provider 用量取数的夹具测试 + 三个"空 400"回归护栏。
 *
 * 这一组测的是**已经真实发生过的故障**：`roundtable/usage.get` 对任何真实会议
 * 返回空 400，客户端只能看到"没反应"。真因有三层（服务读法 / 快照形状 / 字段名），
 * 而这三层**都不是类型错误** —— tsc 全绿、单测全绿、端点照样不可用。
 * 所以这里既测纯函数，也用源码级护栏钉住那三层的写法。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  PROVIDER_USAGE_FIELDS,
  agentTimingOfSnapshot,
  pickAgentTiming,
  pickProviderTokens,
  providerTokensOfSnapshot,
  providerUsageTotal,
} from '../src/usage.ts'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 真实形状：`SessionProjectionRegistry.snapshot()` 的读面是 `{ asOfSeq, values }`。 */
const realSnapshot = (tokenUsage) => ({
  asOfSeq: 42,
  values: {
    tokenUsage,
    contextPressure: { pressureTokens: 999, contextWindow: 128000 },
  },
})

test('取数：真实四桶被完整取出（含同快照里的其他投影键）', () => {
  const picked = providerTokensOfSnapshot(realSnapshot({
    uncachedInputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 1000,
    cacheWriteTokens: 200,
  }))
  assert.deepEqual(picked, {
    uncachedInputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 1000,
    cacheWriteTokens: 200,
  })
  assert.deepEqual(Object.keys(picked), [...PROVIDER_USAGE_FIELDS])
})

test('回归：历史错形状 `snapshot.tokenUsage.totals.*` 必须取不到（不是"碰巧也读到"）', () => {
  // 旧代码读的就是这个形状 —— 它在真实 host 上永远是 undefined。
  assert.equal(providerTokensOfSnapshot({
    tokenUsage: { totals: { uncachedInputTokens: 1, outputTokens: 2 } },
  }), undefined)
  assert.equal(providerTokensOfSnapshot(realSnapshot({ totals: { totalTokens: 5 } })), undefined)
})

test('缺失即"不可用"（undefined），绝不编造 0', () => {
  assert.equal(providerTokensOfSnapshot(realSnapshot({})), undefined)
  assert.equal(providerTokensOfSnapshot({ values: {} }), undefined)
  assert.equal(providerTokensOfSnapshot({ values: null }), undefined)
  assert.equal(providerTokensOfSnapshot({}), undefined)
  assert.equal(providerTokensOfSnapshot(null), undefined)
  assert.equal(providerTokensOfSnapshot(undefined), undefined)
  assert.equal(pickProviderTokens('123'), undefined)
})

test('真实初值：宿主的 `zeroBuckets()` 是四个 0，不是空对象 —— 全 0 要照实回传', () => {
  // 出处：dsh-token-meter 的 `init: () => ({ totals: zeroBuckets(), last: null })`
  // + `view: (state) => state.totals`。所以活会话在"还没发请求"时得到的是这四桶 0，
  // 不是 undefined —— 那是**宿主自己说**的 0，与本模块编造 0 是两件事。
  const zeros = providerTokensOfSnapshot(realSnapshot({
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }))
  assert.deepEqual(zeros, { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.equal(providerUsageTotal(zeros), 0)
})

test('真实活会话采样（本机 2026-09-20 实读，含 cacheWrite=0 的边界）', () => {
  // 取自本会话在宿主投影上的真实 wire 值：cacheWriteTokens 恰好为 0，
  // 用来钉住"0 是合法取值、不能被当成缺失剔除"。
  const live = providerTokensOfSnapshot(realSnapshot({
    uncachedInputTokens: 2193463,
    outputTokens: 439067,
    cacheReadTokens: 238229632,
    cacheWriteTokens: 0,
  }))
  assert.deepEqual(live, {
    uncachedInputTokens: 2193463,
    outputTokens: 439067,
    cacheReadTokens: 238229632,
    cacheWriteTokens: 0,
  })
  assert.equal(providerUsageTotal(live), 240862162)
})

test('两套词汇不得交叉：事件层的 `inputTokens`/`totalTokens` 不是投影层字段', () => {
  // 事件层 TokenUsage = { inputTokens, outputTokens, totalTokens }（本机
  // assistant/message 实测）。两套词只有一个交集字段 `outputTokens` —— 把它喂进来
  // 只会得到 `{ outputTokens }`，而 `inputTokens`/`totalTokens` **取不到**。
  // 若把事件词汇当投影词汇，就会再次写出 `provider_tokens.totalTokens` 这种永远取不到的字段。
  assert.deepEqual(pickProviderTokens({ inputTokens: 15722, outputTokens: 212, totalTokens: 15934 }), { outputTokens: 212 })
  assert.equal(pickProviderTokens({ inputTokens: 1 }), undefined)
  assert.equal(pickProviderTokens({ totalTokens: 1 }), undefined)
})

test('未知字段与不可序列化数值被忽略：`totalTokens`/`bogus` 不进结果，NaN 不算数', () => {
  assert.deepEqual(pickProviderTokens({
    outputTokens: 3,
    totalTokens: 5,
    bogus: 999,
    uncachedInputTokens: Number.NaN,
    cacheReadTokens: Number.POSITIVE_INFINITY,
  }), { outputTokens: 3 })
})

test('合计只加被取出的桶（派生值，与明细同源）', () => {
  assert.equal(providerUsageTotal({ uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 8 }), 15)
  assert.equal(providerUsageTotal({ outputTokens: 0 }), 0)
})

test('护栏①：usage.get 的服务读法必须是 `ctx.get`，不得属性读 sessionProjections', () => {
  const rpc = read('../src/rpc.ts')
  assert.match(rpc, /ctx\.get\('sessionProjections' as never\)/, '必须用 ctx.get 读投影服务')
  // 属性读在未 inject 时抛 "cannot get property ... without inject" → 空 400。
  assert.doesNotMatch(rpc, /\)\s*\.\s*sessionProjections\b/, '不得以属性形式读 sessionProjections')
  assert.doesNotMatch(rpc, /\}\s*\)\s*\.sessionProjections/, '不得以属性形式读 sessionProjections')
})

test('护栏②：usage.get 的取数走 usage.ts，不得在本文件里手写快照形状', () => {
  const rpc = read('../src/rpc.ts')
  assert.match(rpc, /providerTokensOfSnapshot\(snap\)/, '取数须经 usage.ts')
  assert.match(rpc, /agentTimingOfSnapshot\(snap\)/, '耗时取数同样须经 usage.ts')
  assert.doesNotMatch(rpc, /tokenUsage\s+as\s/, '不得在本文件里手写快照形状')
  assert.doesNotMatch(rpc, /\.totals\b/, 'tokenUsage 没有 totals 层')
})

test('护栏③：RPC 回包必须先序列化再写头，且处理器兜底成可读报文（不许再退化成空 400）', () => {
  const index = read('../src/index.ts')
  // 先 stringify 的判据：writeHead 出现的位置在 stringify 之后。
  const body = index.slice(index.indexOf('const send = (status: number, body: unknown)'), index.indexOf('if ((req.method'))
  assert.ok(body.length > 0, 'send 定义必须存在')
  assert.match(body, /response is not serializable/, '序列化失败须变成可读报文')
  assert.ok(
    body.indexOf('JSON.stringify(body)') < body.indexOf('res.writeHead(status'),
    '必须先 stringify 再 writeHead（否则宿主只剩空 400）',
  )
  const route = index.slice(index.indexOf('rpc route handler threw') - 800, index.indexOf('rpc route handler threw') + 200)
  assert.match(route, /await dispatchRpc\(/, 'dispatch 调用须在兜底 try 内')
  assert.match(index, /rpc route handler threw/, '处理器抛错须变成可读报文')
})

test('护栏④：客户端读合计字段，不得再读不存在的 provider_tokens.totalTokens', () => {
  const view = read('../src/client/RoundTableView.tsx')
  const wire = read('../src/client/wire.ts')
  assert.match(wire, /provider_total: number \| null/, 'wire 须声明派生合计字段')
  assert.doesNotMatch(view, /provider_tokens\.totalTokens/, '投影里没有 totalTokens')
  assert.match(view, /entry\.provider_total/, '列表须读派生合计')
})

/* ---------------- ⑤ 的耗时口径：agent 真实耗时 ≠ 会议发言跨度 ---------------- */

test('耗时：`subagentTiming` 的 settledMs 被采用（未结束回合再加 (through - since)）', () => {
  // 出处：dsh-subagent 的 `subagentTiming` 投影
  // `{ settledMs, active?: { since, through } }`。
  assert.deepEqual(pickAgentTiming({ settledMs: 12000 }), { agent_ms: 12000, agent_active: false })
  assert.deepEqual(pickAgentTiming({ settledMs: 12000, active: { since: 1000, through: 3500 } }),
    { agent_ms: 14500, agent_active: true })
  // active 存在但区间非法（through < since / 缺字段）→ 当作无开放回合，不产生负数
  assert.deepEqual(pickAgentTiming({ settledMs: 100, active: { since: 500, through: 400 } }), { agent_ms: 100, agent_active: false })
  assert.deepEqual(pickAgentTiming({ settledMs: 100, active: {} }), { agent_ms: 100, agent_active: false })
})

test('耗时：没有 settledMs 就是"不可用"，不编造 0、也不拿 active 顶替', () => {
  assert.equal(pickAgentTiming({ active: { since: 1, through: 2 } }), undefined)
  assert.equal(pickAgentTiming({ settledMs: -5 }), undefined)
  assert.equal(pickAgentTiming({ settledMs: Number.NaN }), undefined)
  assert.equal(pickAgentTiming({ settledMs: '12' }), undefined)
  assert.equal(pickAgentTiming(null), undefined)
  assert.equal(pickAgentTiming(undefined), undefined)
})

test('耗时身份门：`subagent === null`（无描述符）时 timing 的 0 必须当"不可用"', () => {
  // 实测陷阱：主持人自己的顶层会话读 `subagentTiming` 得到 `{settledMs: 0}`
  // ——init 是 `{descriptorSeen:false, settledMs:0}`，而 wire 视图丢了
  // `descriptorSeen`，所以"没数据"与"真的 0ms"在 wire 上同形。身份键是唯一判据。
  assert.equal(agentTimingOfSnapshot({ values: { subagentTiming: { settledMs: 0 }, subagent: null } }), undefined)
  assert.equal(agentTimingOfSnapshot({ values: { subagentTiming: { settledMs: 0 } } }), undefined)
  assert.equal(agentTimingOfSnapshot({ values: {} }), undefined)
  assert.equal(agentTimingOfSnapshot({}), undefined)
  // 有描述符才是真的子代理：此时 0 是合法终值（还没有回合结算）
  assert.deepEqual(
    agentTimingOfSnapshot({ values: { subagentTiming: { settledMs: 0 }, subagent: { mode: 'continuable', label: 'x' } } }),
    { agent_ms: 0, agent_active: false },
  )
  assert.deepEqual(
    agentTimingOfSnapshot({
      values: { subagentTiming: { settledMs: 4100, active: { since: 100, through: 900 } }, subagent: { mode: 'one-shot' } },
    }),
    { agent_ms: 4900, agent_active: true },
  )
})

test('耗时：与 token 读同一刀快照（不重复物化），且两把钥匙互不串味', () => {
  const snap = {
    asOfSeq: 9,
    values: {
      tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 8 },
      subagentTiming: { settledMs: 3000, active: { since: 0, through: 500 } },
      subagent: { mode: 'continuable', label: 'x' },
    },
  }
  assert.deepEqual(agentTimingOfSnapshot(snap), { agent_ms: 3500, agent_active: true })
  assert.equal(providerUsageTotal(providerTokensOfSnapshot(snap)), 15)
  // 只有 tokenUsage 的快照 → 耗时必须为"不可用"（不是 0）
  assert.equal(agentTimingOfSnapshot({ values: { tokenUsage: { outputTokens: 1 } } }), undefined)
})

test('护栏⑤：耗时与 token 必须取自**同一次** snapshot 调用，且耗时读的是 subagentTiming', () => {
  const rpc = read('../src/rpc.ts')
  assert.match(rpc, /snapshot\(session, \['tokenUsage', 'subagentTiming', 'subagent'\]\)/,
    '三把钥匙必须同一次快照取（第三个是身份门）')
  assert.equal((rpc.match(/projections\.snapshot\(/g) ?? []).length, 1, '端点内 snapshot 只允许调用一次')
  assert.doesNotMatch(rpc, /subagentTiming\s+as\s/, '不得在本文件里手写投影形状')
  // 客户端必须标出"进行中"，并且不再把 transcript 跨度当 agent 耗时显示
  const view = read('../src/client/RoundTableView.tsx')
  assert.match(view, /entry\.agent_active \? '~' : ''/, '进行中的耗时必须带 ~')
  assert.match(view, /\(transcript\)/, '退回 transcript 跨度时必须显式标注口径')
})
