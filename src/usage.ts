/**
 * Provider 用量的读取口径（`roundtable/usage.get` 的取数面）。
 *
 * 这个模块存在的唯一理由：把「从哪个投影读、读哪几个字段」从 RPC 处理器里摘出来，
 * 使它能被夹具断言 —— 这段逻辑此前是错的，而且**错到端点在任何真实会议上都不可用**
 * （实测 `roundtable/usage.get` 带真实 meetingId 返回空 400）：
 *
 * 1. 服务读法错：`ctx.sessionProjections` 属性读需要 `inject`，未声明时抛
 *    `cannot get property "sessionProjections" without inject`，异常逃出处理器 →
 *    宿主回空 400，客户端只看到"没反应"。
 * 2. 快照形状错：`snapshot()` 的读面是 `{ asOfSeq, values }`，代码读的是
 *    `snap.tokenUsage`（应为 `snap.values.tokenUsage`）。
 * 3. 字段名错：`tokenUsage` 是四个互斥桶（见 `TokenUsageProjection`），
 *    **没有** `totals` 层、也没有 `totalTokens` 字段；客户端据此渲染的
 *    `provider_tokens.totalTokens` 永远只能是"—"。
 *
 * 第一方证据（比夹具更硬，`@deepseek-ai/dsh-token-meter` 源码 + 本机真实会话日志）：
 * - 投影单元的 wire 视图是 `view: (state) => state.totals`，而其 **state** 才是
 *   `{ totals, last }` —— 旧代码正是把 **state 形状**（`totals`）套在了 **wire 读面**
 *   上，两套词汇被交叉了。
 * - wire 的 schema 是 `.strict()` 的 `{ uncachedInputTokens, outputTokens,
 *   cacheReadTokens, cacheWriteTokens }`，恰好就是本模块的白名单。
 * - **事件**里的 `TokenUsage` 是另一套词：`{ inputTokens, outputTokens, totalTokens }`
 *   （本机 `assistant/message` 实测）。`totalTokens` 只存在于事件层 —— 这多半就是
 *   当年"以为投影有 totalTokens/totals"的来源，所以这里必须显式区分两套词汇。
 * - 投影初值是 `zeroBuckets()`（四个 0），**不是** `{}`：所以全 0 是"provider 至今
 *   报了 0"（宿主自己说的），与"我们编造 0"是两件事 —— 本模块只在形状缺失时返回
 *   `undefined`，一旦字段存在（哪怕是 0）就照实回传。
 * - 服务读法同样有第一方先例：`dsh-session-query` 用
 *   `ctx.get('sessionProjections')?.snapshot(session)`，`dsh-api-session-controller`
 *   用 `...snapshot(agent.session, ['subagent']).values.subagent`。
 *
 * 纪律：一个数值字段都没有时返回 `undefined`（= 不可用），不编造 0 —— 0 是
 * "provider 报了 0"，与"没有投影"是两件事。
 */

/** `@deepseek-ai/dsh-token-meter` 的 `TokenUsageProjection` 四个互斥桶（顺序即展示顺序）。 */
export const PROVIDER_USAGE_FIELDS = [
  'uncachedInputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
] as const

/**
 * 只挑已知数值字段；一个都没有、或输入不是对象 → `undefined`。
 * 未知字段（含历史错形状里的 `totals`/`totalTokens`）一律忽略。
 */
export function pickProviderTokens(value: unknown): Record<string, number> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const picked: Record<string, number> = {}
  for (const field of PROVIDER_USAGE_FIELDS) {
    const raw = source[field]
    if (typeof raw === 'number' && Number.isFinite(raw)) picked[field] = raw
  }
  return Object.keys(picked).length === 0 ? undefined : picked
}

/** 从投影快照（`{ values: { tokenUsage } }`）取出四桶；形状不对返回 `undefined`。 */
export function providerTokensOfSnapshot(snapshot: unknown): Record<string, number> | undefined {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const values = (snapshot as { values?: unknown }).values
  if (values === null || typeof values !== 'object') return undefined
  return pickProviderTokens((values as { tokenUsage?: unknown }).tokenUsage)
}

/**
 * 四桶合计。**派生值**（投影里没有这个字段），只用于列表标题行；
 * 明细仍以四桶为准，所以两个字段一起返回而不是拿合计冒充原始值。
 */
export function providerUsageTotal(tokens: Record<string, number>): number {
  let total = 0
  for (const value of Object.values(tokens)) total += value
  return total
}

/**
 * 子代理耗时（`subagentTiming` 投影，第一方 key）→ `{ agent_ms, agent_active }`。
 *
 * 为什么不用 transcript 的 ts 跨度冒充耗时：transcript 跨度是**会议发言的墙钟跨度**
 * （席位两次发言相隔多久），把它当"这个专家跑了多久"是口径错误。第一方本来就给了
 * 真东西 —— `settledMs`（已结束回合的累计毫秒）+ `active{since,through}`（当前未结束
 * 回合的区间），`agent_ms = settledMs + (through - since)` 才是「该席 agent 累计耗时」。
 *
 * `agent_active = true` 表示这个数字来自**尚未结束**的回合（随事件折叠继续增长；
 * 注意它是"已折叠事件时间"，长工具调用期间**不跳表** —— 不是实时秒表）。
 * 缺 `settledMs`（非描述符子代理会话/未注册本单元）→ `undefined`，不编造。
 */
export function pickAgentTiming(value: unknown): { agent_ms: number; agent_active: boolean } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const source = value as { settledMs?: unknown; active?: unknown }
  const settled = typeof source.settledMs === 'number' && Number.isFinite(source.settledMs) && source.settledMs >= 0
    ? source.settledMs
    : undefined
  if (settled === undefined) return undefined
  const active = source.active as { since?: unknown; through?: unknown } | null | undefined
  const since = typeof active?.since === 'number' ? active.since : undefined
  const through = typeof active?.through === 'number' ? active.through : undefined
  const open = since !== undefined && through !== undefined && through >= since
  return { agent_ms: settled + (open ? through - since : 0), agent_active: open }
}

/**
 * 从同一个投影快照里取出 `subagentTiming`（与 token 读同一刀，不重复物化）。
 *
 * ⚠ **必须先过 `subagent` 身份门**：`subagentTiming` 的 `init` 是
 * `{ descriptorSeen: false, settledMs: 0 }`，而它的 **wire 视图只有 `{ settledMs, active? }`**
 * —— `descriptorSeen` 留在 state 里、不出现在 wire 上。于是**没有描述符的会话**
 * （例如主持人自己的顶层会话）也会返回 `{ settledMs: 0 }`，与"某子代理所有回合都
 * 结算在 0ms"在 wire 上**完全同形**。直接采信就会把跑了数小时的席位显示成"0.0 秒"，
 * 比不显示更糟（实测：主持人会话 `agent_ms` 读出 0）。
 *
 * 第一方判据：`subagent` 投影的 wire 值是 `SubagentIdentityProjection | null`，其文档
 * 明示 **`null` ⟺ 没有有效描述符**（缺失/畸形/版本不识别，故意不区分）。所以
 * `subagent === null`（或该 key 未注册）→ 耗时**不可用**，返回 `undefined`。
 */
export function agentTimingOfSnapshot(snapshot: unknown): { agent_ms: number; agent_active: boolean } | undefined {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const values = (snapshot as { values?: unknown }).values
  if (values === null || typeof values !== 'object') return undefined
  const source = values as { subagent?: unknown; subagentTiming?: unknown }
  if (source.subagent === null || source.subagent === undefined) return undefined
  return pickAgentTiming(source.subagentTiming)
}
