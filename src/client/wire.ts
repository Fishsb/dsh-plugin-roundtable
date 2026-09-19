/**
 * Wire types shared by the browser topology tab: the meeting snapshot served
 * by `/plugins/dsh-plugin-roundtable/state` and the RPC result envelope.
 * @module dsh-plugin-roundtable/client/wire
 */

/** One RPC response envelope (structurally compatible with the host's RpcResult). */
export type RpcEnvelope<T> =
  | { ok: true; value: T; error?: never }
  | { ok: false; error: { code: string; message: string; details?: unknown }; value?: never }

/** A tiny typed RPC caller over the plugin's own web route. */
export type RpcCaller = <T>(endpoint: string, payload: unknown) => Promise<RpcEnvelope<T>>

/**
 * POST one RPC call to the plugin's OWN web route.
 *
 * That route is mounted through the same `webServer` registration as the
 * snapshot route, so the browser reaches it even when the host's generic
 * connection channel is not mounted — which is what made the settings page
 * report 「读取设置失败」. An unreachable or malformed answer is reported as a
 * failure envelope instead of a rejected promise.
 */
export async function callRpc<T>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcEnvelope<T>> {
  try {
    const response = await fetch('/plugins/dsh-plugin-roundtable/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    })
    const body = await response.json() as unknown
    const envelope = body as RpcEnvelope<T> | null
    if (envelope === null || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
      return { ok: false, error: { code: 'internal', message: `roundtable rpc route returned ${response.status}` } }
    }
    return envelope
  } catch (error: unknown) {
    return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }
  }
}

export interface WireNode {
  id: string
  key: string
  role: string
  provider: string
  model: string
  status: string
  activity: string
}

export interface WireEdge {
  id: string
  from: string
  to: string
  direction: string
  /** 骨架虚线边（host 判定）—— 不要再解析 id 前缀。 */
  implicit?: boolean
  /** 该通道能否真的投递（host 判定；单线制下专家↔专家为 false）。 */
  deliverable?: boolean
}

export interface WireBudget {
  maxRounds: number
  maxTokens: number
  usedRounds: number
  usedTokens: number
}

export interface WirePendingDecision {
  id: string
  question: string
  options: string[]
}

/** One pending user action recorded by the Web UI, awaiting the captain. */
export interface WirePendingAction {
  id: string
  kind: string
  nodeKey: string
  role: string
  provider: string
  model: string
  text: string
}

/** Model entry for the expert-management dropdown (from host llm catalog). */
export interface WireModelOption {
  id: string
  name: string
}

/** Provider entry with its advertised models for the expert-management dropdown. */
export interface WireProviderOption {
  id: string
  name: string
  models: WireModelOption[]
}

export interface WireMessage {
  id: string
  from: string
  to: string
  ts: number
}

/** 逐节点用量（`roundtable/usage.get` 的按需返回；批次 B ⑤）。 */
export interface WireUsageNode {
  key: string
  status: string
  live: boolean
  /** provider 上报的真实四桶（`TokenUsageProjection`，明细）；`null` = 该节点无会话或宿主未挂 session-projection。 */
  provider_tokens: Record<string, number> | null
  /** 四桶之和（**派生值**，投影里没有这个字段）；列表标题行只用它，明细仍看四桶。 */
  provider_total: number | null
  /** 该席 agent 的真实累计耗时（`subagentTiming` 投影）；`null` = 非描述符子代理会话或未挂投影。 */
  agent_ms: number | null
  /** `agent_ms` 是否来自**未结束**的回合（true 时数字还会涨，UI 须标 `~`）。 */
  agent_active: boolean
  /** 会议发言的 ts 跨度（**不是** agent 耗时；两个口径不可混用）。 */
  transcript_span_ms: number | null
  utterances: number
}

export interface WireUsage {
  nodes: WireUsageNode[]
  /** 本地字符估算（与 provider 值口径不同，不可混用）。 */
  budget_estimate: { used_tokens: number; max_tokens: number }
  projections_available: boolean
  note: string
}

/** One knowledge-base directory entry (阅览版: name/kind/format/size only). */
export interface WireKbEntry {
  name: string
  kind: 'file' | 'dir'
  ext: string
  size: number
  mtimeMs: number
  /**
   * host 侧算好的摘要有效性：`true` = 已读入且文件未变；`false` = **读入后已变更**
   * （UI 必须提示主持人重读）；`undefined` = 从未生成摘要（不是"已变更"）。
   * 取代原先「用户勾选『我改过内容』」那个静默失效补丁。
   */
  valid?: boolean
}

/** Knowledge-base listing returned by `roundtable/kb.list`. */
export interface WireKbListing {
  path: string
  configured: boolean
  error: string
  files: WireKbEntry[]
}

/** 观点证据分级（C1）：repro=可复现步骤；argument=论证链。 */
export interface WireReviewEvidence {
  kind: 'repro' | 'argument'
  text: string
}

/** 针锋相对评审：一个观点（V0.2.2 三态 + 拆分）。 */
export interface WireReviewViewpoint {
  id: string
  utteranceId: string
  nodeKey: string
  content: string
  /** 三态：pending/endorsed/rejected。 */
  status: 'pending' | 'endorsed' | 'rejected'
  /** 兼容派生（旧视图仍可读）：status === 'endorsed'。 */
  endorsed: boolean
  /** 派生：status === 'rejected'。 */
  rejected: boolean
  /** 驳回理由（C2：驳回必填；前端在 rejected 状态下展示）。 */
  rejectReason?: string
  /** 证据分级（C1）。 */
  evidence?: WireReviewEvidence
  /** 原文引用子串（拆分观点可能有）。 */
  quote?: string
  /** 维度标签（默认"其他"）。 */
  dimension: string
  /** 发言内序号：0=整条未拆分。 */
  seq: number
}

/** 针锋相对评审记录（快照携带，前端弹窗数据源）。 */
export interface WireReview {
  status: string
  reviewPass: number
  maxReviewPass: number
  question: string
  plan: string
  viewpoints: WireReviewViewpoint[]
}

/** 一条匿名反馈（E1/E3：设置页列表展示）。 */
export interface WireFeedbackEntry {
  id: string
  ts: number
  meetingId: string
  mode: string
  providers: string[]
  models: string[]
  usedRounds: number
  usedTokens: number
  rating: 'good' | 'meh' | 'bad'
  note?: string
}

export interface WireUtterance {
  id: string
  from: string
  to: string
  text: string
  ts: number
  round: number
}

/** R-D-UI：本轮调度计划（波次 + 对账），快照携带，拓扑页「调度」面板数据源。 */
export interface WirePlanItem {
  id: string
  task: string
  owner: string
}

export interface WirePlanWave {
  wave: number
  items: WirePlanItem[]
}

export interface WireDispatchPlan {
  /** 本轮是否交过计划（false = 没做并行/串行分析，UI 必须显示而非留白）。 */
  recorded: boolean
  note: string
  /** 落账计划能否解析（false = 旧版本写的或被改坏，禁止画空波次图）。 */
  parsable: boolean
  waves: WirePlanWave[]
  undispatchedOwners: string[]
  unplannedDispatches: string[]
  gaps: { item: string; presetId: string; presetName: string; onStage: boolean }[]
  /** 专家用 [越界转派] 交给主持人的"该换人"事项（单线制专属，圆桌制恒空）。 */
  outOfScope: { fromSeat: string; item: string; suggestedRole: string; round: number }[]
}

/**
 * R-D-UI：本会议的候选池在场标记。
 *
 * 预设清单本身是**全局**的（客户端已从 `prefs.get` 的 `rolePresets` 拿到），
 * 快照只下发每会议独有的部分 —— 1Hz 轮询下不重复搬运同一份清单。
 */
export interface WireTalentPool {
  total: number
  onStage: { presetId: string; nodeKeys: string[] }[]
}

export interface WireMeeting {
  id: string
  name: string
  goal: string
  mode: string
  status: string
  round: number
  workspace: string
  captainSessionId: string
  /** 知识库目录（阅览版）；空 = 未设置。 */
  kbPath: string
  /** R2：本次会议选中的 skill 名称清单；空 = 未选。 */
  skills: string[]
  /** R2.2/D5：skill 传递方式（relay / direct）。 */
  skillDelivery: string
  budget: WireBudget
  nodes: WireNode[]
  edges: WireEdge[]
  pendingDecisions: WirePendingDecision[]
  pendingActions: WirePendingAction[]
  review: WireReview | null
  digest: string
  /** R-D-UI：本轮调度计划（可选 —— 旧 host 不返回该字段）。 */
  plan?: WireDispatchPlan
  /** R-D-UI：本会议候选池的在场标记（可选 —— 旧 host 不返回该字段）。 */
  talentPool?: WireTalentPool
  messages: WireMessage[]
  recent: WireUtterance[]
}

/** B3 用户自建角色预设（设置页维护；专家管理面板一键填充）。
 *  与 host `types.ts` 的 `RolePreset` 逐字对应。 */
export interface WireRolePreset {
  id: string
  name: string
  role: string
  /** 可选 provider 路由；必须与 model 同时存在才生效。 */
  provider?: string
  /** 可选模型名；空 = 继承主持人。 */
  model?: string
}

export interface RoundTablePrefs {
  defaultMode: 'orchestrated' | 'egalitarian' | 'redteam'
  maxRounds: number
  maxTokens: number
  /** 互通开关：true=显示所有圆桌会议；false=仅显示当前对话开启的会议。 */
  showAllMeetings: boolean
  /** 专家每轮输出 token 上限（模型请求 max_tokens），0 = 不限制。 */
  expertMaxTokens: number
  /** 专家每轮最多提几条意见，0 = 不限制。 */
  expertMaxOpinions: number
  /** E1/E4 反馈：会议结束后是否询问轻量反馈；false = 永久关闭。 */
  feedbackEnabled: boolean
  /** R2.2/D5：skill 传递方式（relay=主持人中转；direct=专家自行调用）。 */
  skillDelivery: 'relay' | 'direct'
  /** R3：右栏隐藏的面板 id 清单；空 = 全部显示。 */
  hiddenPanels: string[]
  /** B3：用户自建角色预设（全局；不预置内置角色）。 */
  rolePresets: WireRolePreset[]
  /** host 的面板 id 清单（单一来源：`rpc.ts` 的 `ROUNDTABLE_PANELS`）。 */
  panels?: string[]
  /** B3+：缺省角色预设 id（单一缺省值；空 = 无缺省）。 */
  defaultPresetId?: string
}

/**
 * Poll the meeting snapshot. Without a session id the host lists every
 * meeting under every workspace (互通开); with one it filters by captain
 * session (互通关 — only meetings started by the current conversation).
 */
export async function fetchMeetings(sessionId?: string): Promise<WireMeeting[]> {
  const query = sessionId === undefined ? '' : `?session=${encodeURIComponent(sessionId)}`
  const response = await fetch(`/plugins/dsh-plugin-roundtable/state${query}`, {
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`roundtable state route returned ${response.status}`)
  const body = await response.json() as { meetings?: WireMeeting[] }
  return Array.isArray(body.meetings) ? body.meetings : []
}
