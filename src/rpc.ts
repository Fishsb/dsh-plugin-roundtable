/**
 * RPC handlers for the browser topology tab:
 *   - `roundtable/prefs.get`   → { defaultMode, maxRounds, maxTokens }
 *   - `roundtable/prefs.set`   → persist user preferences
 *   - `roundtable/edge.set`    → flip one edge's direction (UI right-click menu)
 *   - `roundtable/edge.add`    → drag-to-connect a new channel
 *   - `roundtable/edge.remove` → remove an edge
 *
 * Registered on the host through `ctx.inject(['connection'])` on the plugin's
 * OWN RPC channel `/roundtable` (NOT the shared `/api` one). The `/api`
 * channel is a single-interceptor shared channel owned by dsh-api-gateway, so
 * registering a second `intercept('/api')` here throws
 * "shared RPC channel /api already has an interceptor" and silently drops
 * every roundtable RPC — which is exactly why drag-to-connect looked dead for
 * both removed AND active nodes. Using `rpc.handle('/roundtable', ...)` gives
 * this plugin its own prefix-routed channel, mirroring the ya-subagent plugin.
 * @module dsh-plugin-roundtable/rpc
 */

import type { Context } from '@deepseek-ai/cordis'
// Value import triggers `declare module 'cordis'` merge for `ctx.connection`.
import type {} from '@deepseek-ai/dsh-client-connection'
// Declaration merge only: makes ctx.llm visible for the model-list RPC.
import type {} from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { readdir, rm, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join } from 'node:path'
import type { EdgeDirection, FeedbackEntry, MeetingUtterance, RolePreset, UserAction } from './types.ts'
import { CAPTAIN_KEY } from './types.ts'
import {
  appendFeedback,
  appendUserAction,
  appendUtterance,
  clearFeedback,
  clearFeedbackForMeeting,
  meetingDirOf,
  readFeedback,
  readKbDigest,
  readMeeting,
  readReview,
  readTranscript,
  readUserActions,
  setViewpointStatus,
  stateRootOf,
  withMeetingLock,
  writeMeeting,
} from './state.ts'
import { buildCharter } from './charter.ts'
import { digestIsFresh } from './kb-digest.ts'
import { agentTimingOfSnapshot, providerTokensOfSnapshot, providerUsageTotal } from './usage.ts'
import type { SessionModeTable } from './mode.ts'
import { steerCaptain } from './members.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** RPC result envelope (mirrors the apiproxy wire shape). */
export type RpcResult<T> =
  | { ok: true; value: T; error?: never }
  | { ok: false; error: { code: string; message: string; details?: unknown }; value?: never }

/** Wire shape of the runtime preferences. */
export interface RoundTablePreferences {
  readonly defaultMode: 'orchestrated' | 'egalitarian' | 'redteam'
  readonly maxRounds: number
  readonly maxTokens: number
  /** 互通开关：true = 显示所有圆桌会议；false = 仅显示当前对话开启的会议。 */
  readonly showAllMeetings: boolean
  /** 专家每轮输出 token 上限（模型请求 max_tokens），0 = 不限制。 */
  readonly expertMaxTokens: number
  /** 专家每轮最多提几条意见，0 = 不限制。 */
  readonly expertMaxOpinions: number
  /** E1/E4 反馈：会议结束后是否询问轻量反馈；false = 永久关闭（设置页可改）。 */
  readonly feedbackEnabled: boolean
  /** R2.2/D5：skill 传递方式（relay=主持人中转；direct=专家自行调用）。 */
  readonly skillDelivery: 'relay' | 'direct'
  /** 右栏面板可见性（R3）：被列出的面板在拓扑页隐藏；空 = 全部显示。 */
  readonly hiddenPanels: string[]
  /** B3：用户自建角色预设（全局偏好；不预置任何内置角色）。 */
  readonly rolePresets: RolePreset[]
  /** B3+：缺省角色预设（**单一缺省值**，沿用宿主 `agent-presets.default` 的语义）；
   *  空 = 无缺省。专家管理面板打开时用它预填 role/provider/model。 */
  readonly defaultPresetId?: string
}

/**
 * 右栏面板 id（客户端与服务端共用的稳定标识）。
 *
 * 批次 B ④ 收敛：7 → 2 —— `files`（零数据源空壳）、`tasks`（与 agents 同数组）
 * 已在批次 A 删除；`skills` 并入 agents 脚部、`activity` 并入网关摘要作第二视图、
 * `review` 面板删除（头部徽章 + 弹窗已是两个入口）。**剩下的每个面板都有唯一数据源**。
 */
export const ROUNDTABLE_PANELS: readonly string[] = [
  'agents',
  'dispatch',
  'kb',
]

/** 把任意输入收敛成合法的隐藏面板清单（未知 id 丢弃，去重）。 */
export function sanitizeHiddenPanels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const id = typeof item === 'string' ? item.trim() : ''
    if (id === '' || !ROUNDTABLE_PANELS.includes(id) || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/** 预设条目的硬上限（客户端与服务端共用；服务端截断，客户端提前拦截）。 */
export const ROLE_PRESET_MAX = 50
/** `roundtable/transcript.list` 的默认/最大返回条数（**必须夹取**，不设无界读）。 */
export const TRANSCRIPT_LIMIT_DEFAULT = 200
export const TRANSCRIPT_LIMIT_MAX = 1000
/** `roundtable/say` 的单条发言字数上限（与会议文本的既有量级一致）。 */
export const SAY_TEXT_MAX = 4000

/**
 * 把任意输入收敛成一个合法的 `transcript.list` 条数上限。
 *
 * 独立成导出纯函数（而非内联在 switch 里）的理由：**"不设无界读"是这条端点的
 * 核心约束**，而它只有被真的跑一遍才算断言过。内联写法只能靠源码正则守卫，
 * 那是"字符串出现过"的证据，不是"夹取真的生效"的证据。
 *
 * @param raw 客户端传来的 `limit`（任意类型）。
 * @returns `[1, TRANSCRIPT_LIMIT_MAX]` 内的整数；非法输入回落到默认值。
 */
export function clampTranscriptLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return TRANSCRIPT_LIMIT_DEFAULT
  return Math.min(Math.max(Math.floor(raw), 1), TRANSCRIPT_LIMIT_MAX)
}

/**
 * 从全量发言里切出要发给群聊窗口的那一段。
 *
 * 两条语义各自都可能悄悄坏，所以做成纯函数而不是内联在处理器里：
 *   - `since > 0` 时**严格大于**（增量补齐不能把边界那条重复送回，否则前端
 *     id 去重之外还要靠 ts 兜底，多一层不必要的假设）；
 *   - 取**尾部** `limit` 条（群聊要看最新），但**按升序返回**（气泡顺序即时间
 *     顺序，前端不该再排一次）。
 *
 * 返回的 `truncated` 是**由 host 判定**的"真的丢了更早的发言"。刻意不用
 * 「条数 == 上限」这种前端侧的推断：那要求客户端的页大小常量与 host 的夹取上限
 * 永远同步，而它们是两份彼此不知道的常量 —— host 上限调到 100 时，客户端拿 100 条
 * 去比 200，「更早的发言未载入」这条提示就会**静默消失**，用户以为自己看到了全部。
 * 判定权归知道真相的一侧（这里），前端只负责显示。
 *
 * @param all   全量发言（按 ts 升序）。
 * @param since ts 下界；`<= 0` 表示不筛。
 * @param limit 已由 {@link clampTranscriptLimit} 收敛过的条数上限。
 */
export function selectTranscriptWindow<T extends { ts: number }>(
  all: readonly T[],
  since: number,
  limit: number,
): { items: T[]; truncated: boolean } {
  const filtered = since > 0 ? all.filter((utterance) => utterance.ts > since) : [...all]
  const truncated = filtered.length > limit
  return {
    items: truncated ? filtered.slice(filtered.length - limit) : filtered,
    truncated,
  }
}

/** `roundtable/say` 的正文裁决（非法输入给出可读原因，不抛）。 */
export function normalizeSayText(raw: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { ok: false, reason: 'payload must include a non-empty text' }
  if (text.length > SAY_TEXT_MAX) return { ok: false, reason: `text exceeds ${SAY_TEXT_MAX} characters` }
  return { ok: true, text }
}
const ROLE_PRESET_ID_MAX = 64
const ROLE_PRESET_NAME_MAX = 40
const ROLE_PRESET_ROLE_MAX = 400
/** 思考强度 id 上限（宿主档位 id 是短标识，如 `off`/`low`/`high`/`max`）。 */
const ROLE_PRESET_EFFORT_MAX = 40

/**
 * 把任意输入收敛成合法的角色预设清单（B3）。
 *
 * schemastery 的 `z.object` 在 resolve 阶段**不校验缺失的 required 字段**
 * （`s({ rolePresets: [{ id: 'a' }] })` 直接通过），所以条目级校验不能依赖
 * schema，必须在这里手写 —— 与 {@link sanitizeHiddenPanels} 同一套路：
 *   - `name` 与 `role` 非空是硬要求，二者缺一即丢弃该条；
 *   - `id` 为空或与前面的条目重复时**重新分配**（保数据，不静默丢条目）；
 *   - `provider`/`model` 必须成对出现，否则整体视为"继承主持人"；
 *   - 单字段超长截断，总条数超 {@link ROLE_PRESET_MAX} 截断。
 */
export function sanitizeRolePresets(value: unknown): RolePreset[] {
  if (!Array.isArray(value)) return []
  const out: RolePreset[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (out.length >= ROLE_PRESET_MAX) break
    if (item === null || typeof item !== 'object') continue
    const raw = item as {
      id?: unknown
      name?: unknown
      role?: unknown
      provider?: unknown
      model?: unknown
      reasoningEffort?: unknown
    }
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, ROLE_PRESET_NAME_MAX) : ''
    const role = typeof raw.role === 'string' ? raw.role.trim().slice(0, ROLE_PRESET_ROLE_MAX) : ''
    if (name === '' || role === '') continue
    const candidate = typeof raw.id === 'string' ? raw.id.trim().slice(0, ROLE_PRESET_ID_MAX) : ''
    const id = candidate === '' || seen.has(candidate) ? randomUUID() : candidate
    seen.add(id)
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
    const model = typeof raw.model === 'string' ? raw.model.trim() : ''
    const routed = provider !== '' && model !== ''
    // effort 是**可选**档位：空 = 继承主持人（沿用宿主 provider/model 的成对折叠口径）。
    const effort = typeof raw.reasoningEffort === 'string'
      ? raw.reasoningEffort.trim().slice(0, ROLE_PRESET_EFFORT_MAX)
      : ''
    out.push({
      id,
      name,
      role,
      ...(routed ? { provider, model } : {}),
      ...(effort === '' ? {} : { reasoningEffort: effort }),
    })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 模型目录（A2/A12）：词表唯一来源 = ctx.llm.resolveModelInfo
 * ------------------------------------------------------------------ */

/** 每模型的一条推理档位（逐字沿用宿主 `reasoning.efforts[]` 的 id/name）。 */
export interface ModelCatalogEffort {
  id: string
  name: string
  description?: string
}

/** 宿主 `resolveModelInfo(...).reasoning` 的收敛形状；**缺席 = 该模型不提供推理档位**。 */
export interface ModelCatalogReasoning {
  efforts: ModelCatalogEffort[]
  defaultEffort?: string
}

export interface ModelCatalogModel {
  id: string
  name: string
  reasoning?: ModelCatalogReasoning
}

export interface ModelCatalogProvider {
  id: string
  name: string
  models: ModelCatalogModel[]
}

/** 一次目录读取失败（provider 粒度，一条 provider 至多一条）。 */
export interface ModelCatalogFailure {
  id: string
  name: string
  message: string
}

export interface ModelCatalog {
  providers: ModelCatalogProvider[]
  failures: ModelCatalogFailure[]
}

/** 本插件用到的宿主 `llm` 服务最小面（只读目录，不发起任何请求）。 */
export interface ModelCatalogLlm {
  listProviders(): { id: string; name: string }[]
  listModels(provider: string): Promise<{ id: string; name: string }[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    id: string
    name: string
    reasoning?: { efforts: { id: string; name: string; description?: string }[]; defaultEffort?: string }
  }>
}

/** 把任意抛错收敛成一句可显示的话（与宿主 `buildModelCatalog` 同口径）。 */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 读取一个精确模型的档位词表。
 *
 * 宿主语义（`dsh-llm` 的 `normalizeModelInfo`）：
 *   - 模型**不提供**推理 ⇒ `reasoning` 字段**缺席**（不是空对象）；
 *   - `efforts` 为空数组属**非法**，宿主直接抛 `INVALID_MODEL_REASONING`；
 *   - `defaultEffort` **不恒给**，且必须落在 `efforts[].id` 里。
 * 所以这里「字段缺席 / 空数组 / 抛错」统一收敛成 `undefined`（= 不提供档位），
 * 而把**抛错**另记到 `failures`，避免「读不出来」伪装成「不支持推理」。
 */
async function probeReasoning(
  llm: ModelCatalogLlm,
  provider: string,
  model: string,
): Promise<{ reasoning?: ModelCatalogReasoning; error?: unknown }> {
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const reasoning = info?.reasoning
    if (reasoning === undefined) return {}
    const efforts: ModelCatalogEffort[] = []
    const seen = new Set<string>()
    for (const effort of Array.isArray(reasoning.efforts) ? reasoning.efforts : []) {
      const id = typeof effort?.id === 'string' ? effort.id.trim() : ''
      const name = typeof effort?.name === 'string' ? effort.name.trim() : ''
      if (id === '' || name === '' || seen.has(id)) continue
      seen.add(id)
      efforts.push({
        id,
        name,
        ...(typeof effort.description === 'string' && effort.description !== '' ? { description: effort.description } : {}),
      })
    }
    if (efforts.length === 0) return {}
    const requested = typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : ''
    return {
      reasoning: {
        efforts,
        ...(requested !== '' && seen.has(requested) ? { defaultEffort: requested } : {}),
      },
    }
  } catch (error) {
    return { error }
  }
}

/**
 * 组装设置页/专家管理面板用的模型目录（**可导出纯函数**，便于机检）。
 *
 * 两条硬约束：
 *   1. 逐 provider 的 `listModels` 与逐模型的 `resolveModelInfo` 都**逐层兜底** ——
 *      单模型读失败不得把整个 provider 清成空列表（旧写法 `catch { models = [] }`
 *      正是这种"把单点故障放大成整段静默"）。
 *   2. 失败进 `failures[]`（provider 粒度一条），而不是与"不支持推理"同形。
 *      空 models 的 provider **仍然保留**（UI 可用性优先），不抄宿主的空组过滤。
 */
export async function buildModelCatalog(llm: ModelCatalogLlm | undefined): Promise<ModelCatalog> {
  if (llm === undefined) return { providers: [], failures: [] }
  const failures: ModelCatalogFailure[] = []
  const providers: ModelCatalogProvider[] = []
  for (const provider of llm.listProviders()) {
    let models: { id: string; name: string }[] = []
    try {
      models = await llm.listModels(provider.id)
    } catch (error) {
      // Provider 级读取失败：记一条 failure，条目仍出现（空 models）。
      failures.push({ id: provider.id, name: provider.name, message: failureMessage(error) })
      providers.push({ id: provider.id, name: provider.name, models: [] })
      continue
    }
    // 逐模型降级：单模型抛错只影响它自己（不波及同 provider 的其它模型）。
    const probed = await Promise.all(
      models.map(async (model) => ({
        model,
        ...(await probeReasoning(llm, provider.id, model.id)),
      })),
    )
    const broken = probed.filter((entry) => entry.error !== undefined)
    const first = broken[0]
    if (first !== undefined) {
      failures.push({
        id: provider.id,
        name: provider.name,
        message: `${failedModelIds(broken.map((entry) => entry.model.id))}: ${failureMessage(first.error)}`,
      })
    }
    providers.push({
      id: provider.id,
      name: provider.name,
      models: probed.map((entry) => ({
        id: entry.model.id,
        name: entry.model.name,
        ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
      })),
    })
  }
  return { providers, failures }
}

/** 失败模型清单的人读形式（超过 3 个则折叠，避免把 37 条铺进一句话）。 */
function failedModelIds(ids: string[]): string {
  const head = ids.slice(0, 3).join(', ')
  return ids.length <= 3 ? head : `${head} 等 ${ids.length} 个模型`
}

/**
 * 净化缺省预设 id（B3+）：**必须指向现存预设**，否则视为"无缺省"。
 * 宁可丢掉死指针，也不让"缺省指向已删预设"这种状态落库（UI 会静默预填空）。
 */
export function sanitizeDefaultPresetId(value: unknown, presets: readonly RolePreset[]): string {
  const raw = typeof value === 'string' ? value.trim().slice(0, ROLE_PRESET_ID_MAX) : ''
  if (raw === '') return ''
  return presets.some((preset) => preset.id === raw) ? raw : ''
}

/**
 * Live preference source.
 *
 * 0.1.7 起插件不再注册 settings namespace：偏好就住在插件自己的 volatile
 * Config 里（`SettingsForms` 按 profile entry id 暴露这些字段）。`get()` 是
 * **唯一读路径** —— 每次调用都从 volatile 引用取值，所以设置页写入经 Loader
 * 推回引用后，工具层/RPC 立刻读到新值，无需重启，也没有第二份缓存要同步。
 */
export interface PreferenceStore {
  get(): RoundTablePreferences
}

/** Holder shared between the settings fiber and the RPC fiber. */
export interface RoundTableRuntime {
  /** 偏好读取面（volatile Config 的封装；见 {@link PreferenceStore}）。 */
  prefs: PreferenceStore
  /**
   * 偏好写入面：把 patch 落进本插件的 profile entry。
   *
   * 由 `index.ts` 注入（它才拿得到 `ctx.fiber.entry.options.id` 与 Settings
   * 服务）。缺省为空 = 插件没有 profile entry（无 Loader 装配），此时写操作
   * **明确报错**而不是静默丢弃 —— 静默降级会让设置页看起来好用但什么都没存。
   */
  setPrefs?: (patch: Record<string, unknown>) => Promise<void>
  stateDir: string
  /**
   * 会话级「圆桌讨论模式」状态表（会话 tab 那一半写入面）。
   *
   * 为什么放在 runtime 而不是新开一个服务：`registerRpc` 是**唯一**同时被
   * 浏览器两条 transport 与 host 命令层看见的装配点，模式状态只有一个消费者
   * 面（RPC），多开一层服务只是多一条要维护的传递链。可选是因为它只承载
   * UI 侧写的 `auto` 那一份 —— 缺席时 `mode.set` 报错、其余端点不受影响。
   */
  mode?: SessionModeTable
}

/**
 * Browser-facing POST route for this plugin's RPC.
 *
 * It mirrors the snapshot route's transport (the plugin's own `webServer`
 * registration) instead of relying on the host's generic connection channel,
 * which is what the client actually reaches.
 */
export const RPC_ROUTE = '/plugins/dsh-plugin-roundtable/rpc'

/** One endpoint dispatch: `(endpoint, payload) => envelope`, never throws. */
export type RpcDispatch = (endpoint: string, payload: unknown) => Promise<RpcResult<unknown>>

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function fail<T>(message: string): RpcResult<T> {
  return { ok: false, error: { code: 'internal', message } }
}

/** Connection service slice used to register this plugin's own RPC channel. */
interface RpcConnection {
  readonly rpc: {
    /**
     * 0.1.5-rc.1 起为两参签名：`handle(channel, handler) => disposer`。
     * 0.1.1 时代的第三参 `{ authority }` 已被移除；实测运行时忽略多余实参，
     * 因此本 shim 只保留真实形状，避免后人照抄不存在的选项。
     */
    readonly handle: (
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
    ) => unknown  }
}

/** Run one meeting mutation under the meeting lock, resolving its state root first. */
async function withMeetingRpcLock<T>(
  runtime: RoundTableRuntime,
  meetingId: string,
  operation: (stateRoot: string) => Promise<RpcResult<T>>,
): Promise<RpcResult<T>> {
  const { workspaceOfMeeting } = await import('./edge-helper.ts')
  const workspace = await workspaceOfMeeting(runtime.stateDir, meetingId)
  if (workspace === undefined) return fail(`meeting "${meetingId}" not found in any workspace`)
  const stateRoot = stateRootOf(workspace, runtime.stateDir)
  return withMeetingLock(`meeting:${stateRoot}:${meetingId}`, () => operation(stateRoot))
}

/** 观点三态写入（V0.2.2）。幂等；状态变化时写结构化 user-action（V2 回写负载）。
 *  驳回必须附理由（C2），由 setViewpointStatus 强制非空。
 *  P1 务实降级：connection 通道不暴露调用者 session 身份（handler 仅
 *  endpoint/payload/signal），无法做 captainSessionId 校验——以「会议归属
 *  校验（withMeetingRpcLock）+ 状态机校验（reviewing 阶段拒绝）」作为防线。 */
async function applyViewpointStatus(
  runtime: RoundTableRuntime,
  meetingId: string,
  viewpointId: string,
  status: 'pending' | 'endorsed' | 'rejected',
  rejectReason?: string,
): Promise<RpcResult<{ changed: boolean; status: string }>> {
  return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
    const review = await readReview(stateRoot, meetingId)
    if (review === undefined) return fail(`no review in progress for meeting "${meetingId}"`)
    const viewpoint = review.viewpoints.find((candidate) => candidate.id === viewpointId)
    if (viewpoint === undefined) return fail(`viewpoint "${viewpointId}" not found`)
    if (review.status === 'reviewing') {
      return fail('review is still collecting viewpoints — call roundtable_collect_review before endorsing or rejecting')
    }
    if (review.status === 'done') {
      return fail('this review pass is finished — start a new pass (roundtable_start_review) to re-review')
    }
    let changed: boolean
    try {
      changed = await setViewpointStatus(stateRoot, meetingId, viewpointId, status, rejectReason)
    } catch (error) {
      return fail((error as Error).message)
    }
    if (changed && status !== 'pending') {
      const label = status === 'endorsed' ? '用户认定缺陷' : '用户驳回观点'
      const reasonText = status === 'rejected' && rejectReason !== undefined && rejectReason.trim() !== ''
        ? `；理由：${rejectReason.trim().replace(/\s+/g, ' ').slice(0, 120)}`
        : ''
      await appendUserAction(stateRoot, meetingId, {
        id: randomUUID(),
        ts: Date.now(),
        kind: 'other',
        nodeKey: viewpoint.nodeKey,
        // V2：回写负载升级为结构化行 id（utteranceId#seq），主持人据此精确回改。
        text: `${label}（针锋相对评审 ${viewpoint.id}）${reasonText}：${viewpoint.content.replace(/\s+/g, ' ').slice(0, 60)}`,
      })
    }
    return ok({ changed, status })
  })
}

/**
 * Register the RoundTable RPC handler.
 *
 * Two transports share ONE dispatch body, so the browser can reach the plugin
 * even when the host's generic `connection` channel is not mounted (or its
 * `/roundtable` prefix got dropped by a live plugin reload):
 *   1. the host `connection` RPC channel `/roundtable` (kept for compatibility);
 *   2. the plugin's own `webServer` POST route `<RPC_ROUTE>` — the same
 *      transport as the `/plugins/dsh-plugin-roundtable/state` snapshot route,
 *      which is what the browser actually uses.
 *
 * @returns the dispatch function, so the caller can mount it on a web route.
 */
export function registerRpc(ctx: Context, runtime: RoundTableRuntime): RpcDispatch {
  const dispatch: RpcDispatch = async (endpoint, payload) => {
    try {
      switch (endpoint) {
          case 'roundtable/prefs.get': {
            const prefs = runtime.prefs.get()
            // `panels` 是**派生字段**（面板 id 单源），不属于持久化偏好，
            // 所以不塞进 RoundTablePreferences 接口，用交叉类型表达。
            return ok<RoundTablePreferences & { panels: string[] }>({
              defaultMode: prefs.defaultMode,
              maxRounds: prefs.maxRounds,
              maxTokens: prefs.maxTokens,
              showAllMeetings: prefs.showAllMeetings,
              expertMaxTokens: prefs.expertMaxTokens ?? 0,
              expertMaxOpinions: prefs.expertMaxOpinions ?? 0,
              feedbackEnabled: prefs.feedbackEnabled ?? true,
              skillDelivery: prefs.skillDelivery === 'direct' ? 'direct' : 'relay',
              hiddenPanels: sanitizeHiddenPanels(prefs.hiddenPanels),
              rolePresets: sanitizeRolePresets(prefs.rolePresets),
              // 面板 id 单源（批次 A ⑥）：客户端不再自带一份 id 清单，只保留
              // id → 文案键 的映射；新增/改名面板时改这里一处即可。
              panels: [...ROUNDTABLE_PANELS],
              defaultPresetId: prefs.defaultPresetId ?? '',
            })
          }
          case 'roundtable/prefs.set': {
            const patch = payload as Partial<RoundTablePreferences> | undefined
            if (patch === undefined || typeof patch !== 'object' || patch === null) {
              return fail('payload must be a preferences patch object')
            }
            // 0 = 不限制；任何有限非负整数都接受。
            const clampLimit = (value: unknown, fallback: number): number =>
              typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
            if (runtime.setPrefs === undefined) {
              // 0.1.7：偏好写在插件**自己的 profile entry** 上，没有 entry 就无处
              // 落盘。以前这里会退回一份内存副本让设置页"看起来能用"，但那正是
              // 静默失效 —— 用户改了设置、页面显示成功、重启后全部消失。现在
              // 明确报错（同 ACT-373 对 settings.register 被 catch 吞掉的处理）。
              return fail('preferences cannot be persisted: this plugin has no profile entry (settings service or Loader entry missing)')
            }
            const current = runtime.prefs.get()
            // 写入前先净化：坏数据不落库（schemastery 不会替我们拦）。
            const sanitized: Record<string, unknown> = { ...patch }
            /*
             * 预算两轴（2026-09-24 · 用户要求「0 表示不限制」）：
             * `0` 是**合法且有意义**的值，与"用户没填"必须分开 —— 所以回落值取
             * **当前值**而不是某个常量，且判据是"有限非负整数"（`clampLimit`）。
             * 负值/NaN ⇒ 拒绝写库并保留现值（不静默写成一个荒谬上限）。
             */
            if (patch.maxRounds !== undefined) sanitized.maxRounds = clampLimit(patch.maxRounds, current.maxRounds)
            if (patch.maxTokens !== undefined) sanitized.maxTokens = clampLimit(patch.maxTokens, current.maxTokens)
            if (patch.hiddenPanels !== undefined) sanitized.hiddenPanels = sanitizeHiddenPanels(patch.hiddenPanels)
            if (patch.rolePresets !== undefined) sanitized.rolePresets = sanitizeRolePresets(patch.rolePresets)
            // B3+：缺省 id 必须指向（本次 patch 生效后的）现存预设，防死指针落库
            if (patch.defaultPresetId !== undefined) {
              const presetsAfterPatch = patch.rolePresets === undefined
                ? sanitizeRolePresets(current.rolePresets)
                : sanitizeRolePresets(patch.rolePresets)
              sanitized.defaultPresetId = sanitizeDefaultPresetId(patch.defaultPresetId, presetsAfterPatch)
            }
            await runtime.setPrefs(sanitized)
            const next = runtime.prefs.get()
            return ok<RoundTablePreferences>({
              defaultMode: next.defaultMode,
              maxRounds: next.maxRounds,
              maxTokens: next.maxTokens,
              showAllMeetings: next.showAllMeetings,
              expertMaxTokens: next.expertMaxTokens ?? 0,
              expertMaxOpinions: next.expertMaxOpinions ?? 0,
              feedbackEnabled: next.feedbackEnabled ?? true,
              skillDelivery: next.skillDelivery === 'direct' ? 'direct' : 'relay',
              hiddenPanels: sanitizeHiddenPanels(next.hiddenPanels),
              rolePresets: sanitizeRolePresets(next.rolePresets),
              defaultPresetId: next.defaultPresetId ?? '',
            })
          }
          case 'roundtable/edge.set': {
            const body = payload as { meetingId?: unknown; edgeId?: unknown; direction?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const edgeId = typeof body?.edgeId === 'string' ? body.edgeId : ''
            if (meetingId === '' || edgeId === '') return fail('payload must be { meetingId, edgeId, direction }')
            const directionRaw = typeof body?.direction === 'string' ? body.direction : ''
            if (directionRaw !== 'forward' && directionRaw !== 'bidirectional') {
              return fail('direction must be "forward" or "bidirectional"')
            }
            const direction: EdgeDirection = directionRaw
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail<{ direction: string }>(`meeting "${meetingId}" not found`)
              const edge = meeting.edges.find((candidate) => candidate.id === edgeId)
              if (edge === undefined) return fail<{ direction: string }>(`edge "${edgeId}" not found`)
              edge.direction = direction
              meeting.charter = buildCharter(meeting)
              await writeMeeting(stateRoot, meeting)
              return ok<{ direction: string }>({ direction: edge.direction })
            })
          }
          case 'roundtable/edge.add': {
            const body = payload as { meetingId?: unknown; from?: unknown; to?: unknown; direction?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const from = typeof body?.from === 'string' ? body.from.trim() : ''
            const to = typeof body?.to === 'string' ? body.to.trim() : ''
            if (meetingId === '' || from === '' || to === '') return fail('payload must be { meetingId, from, to, direction }')
            const direction: EdgeDirection = body?.direction === 'bidirectional' ? 'bidirectional' : 'forward'
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail<Record<string, string>>(`meeting "${meetingId}" not found`)
              const valid = (key: string): boolean => key === 'captain' || key === 'aggregator'
                || meeting.nodes.some((node) => node.key === key && node.status !== 'removed')
              if (!valid(from)) return fail<Record<string, string>>(`unknown endpoint "${from}"`)
              if (!valid(to)) return fail<Record<string, string>>(`unknown endpoint "${to}"`)
              if (from === to) return fail<Record<string, string>>('an edge cannot connect a participant to itself')
              if (meeting.edges.some((edge) => edge.from === from && edge.to === to)) {
                return fail<Record<string, string>>(`channel ${from} → ${to} already exists`)
              }
              const edge = { id: randomUUID(), from, to, direction, createdAt: Date.now() }
              meeting.edges.push(edge)
              meeting.charter = buildCharter(meeting)
              await writeMeeting(stateRoot, meeting)
              return ok({ edgeId: edge.id, from: edge.from, to: edge.to, direction: edge.direction })
            })
          }
          case 'roundtable/edge.remove': {
            const body = payload as { meetingId?: unknown; edgeId?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const edgeId = typeof body?.edgeId === 'string' ? body.edgeId : ''
            if (meetingId === '' || edgeId === '') return fail('payload must be { meetingId, edgeId }')
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail<{ removed: boolean }>(`meeting "${meetingId}" not found`)
              const before = meeting.edges.length
              meeting.edges = meeting.edges.filter((edge) => edge.id !== edgeId)
              meeting.charter = buildCharter(meeting)
              await writeMeeting(stateRoot, meeting)
              return ok({ removed: before !== meeting.edges.length })
            })
          }
          case 'roundtable/meeting.delete': {
            const body = payload as { meetingId?: unknown; captainSessionId?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const expectCaptain = typeof body?.captainSessionId === 'string' ? body.captainSessionId : ''
            if (meetingId === '') return fail('payload must be { meetingId }')
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return ok({ deleted: false })
              // ⚠ **防误删，不是鉴权**：本 RPC 路由在设计上拿不到调用者身份
              // （`index.ts` 只把 endpoint/payload 交给 dispatch），所以
              // "payload 带 captainSessionId" 属自证、可伪造 —— 它只能挡住
              // "会话与会议对不上"的误操作。真正的身份校验缺口在宿主 webServer。
              if (expectCaptain !== '' && expectCaptain !== meeting.captainSessionId) {
                return fail('captainSessionId does not own this meeting — refusing to delete (anti-accident guard, not authentication)')
              }
              // Best-effort: interrupt the meeting's expert subagents first so
              // no orphan keeps running after the meeting is gone.
              const agents = (ctx as unknown as { agents?: { interrupt?: (id: string) => unknown } }).agents
              for (const node of meeting.nodes) {
                if (node.id !== '' && agents?.interrupt !== undefined) {
                  try { agents.interrupt(node.id) } catch { /* best-effort */ }
                }
              }
              await rm(meetingDirOf(stateRoot, meetingId), { recursive: true, force: true })
              return ok({ deleted: true })
            })
          }
          case 'roundtable/usage.get': {
            // 逐节点用量（批次 B ⑤）：**按需端点，绝不进 1Hz 快照** ——
            // `sessionProjections.snapshot()` 会物化投影（惰性折叠整条日志），
            // 每秒对每个专家跑一次等于持续重折叠。
            // 口径纪律：`provider_tokens` 是 provider 上报的**真实值**；
            // `budget_estimate` 是本地字符估算（budget.ts 的 CJK×0.6 + latin×0.3），
            // 两者不可混用（拿估算当账单就是错的）。
            const body = payload as { meetingId?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            if (meetingId === '') return fail('payload must be { meetingId }')
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail(`meeting "${meetingId}" not found`)
              const utterances = await readTranscript(stateRoot, meetingId)
              const agents = (ctx as unknown as { agents?: { get?: (id: string) => { session?: unknown } | undefined } }).agents
              // ⚠ 服务必须走 `ctx.get`，不能属性读：`ctx.sessionProjections` 在未
              // 于插件 `inject` 声明该服务时会抛「cannot get property
              // "sessionProjections" without inject」，异常穿过 dispatch 的兜底
              // （它在 try 外）→ 宿主回**空 400**。实测这就是本端点此前对任何真实
              // 会议都不可用的真因。`ctx.get` 是"可用则取、不可用则 undefined"的读法。
              const projections = ctx.get('sessionProjections' as never) as {
                snapshot?: (session: unknown, keys?: readonly string[]) => unknown
              } | undefined
              const nodes = meeting.nodes
                .filter((node) => node.status !== 'removed')
                .map((node) => {
                  const live = node.id === '' ? undefined : agents?.get?.(node.id)
                  const session = live?.session
                  let providerTokens: Record<string, number> | null = null
                  let agentMs: number | null = null
                  let agentActive = false
                  if (session !== undefined && typeof projections?.snapshot === 'function') {
                    try {
                      // 一次快照取三把钥匙（`tokenUsage` = provider 真实四桶，
                      // `subagentTiming` = 该席 agent 真实耗时，`subagent` = 身份门：
                      // 没有描述符的会话其 timing 恒为 `{settledMs:0}`，必须靠身份键
                      // 才能区分"没数据"与"真的 0"）——读同一个投影刀口，不为第二个
                      // 指标再物化一遍。取数与挑字段都在 usage.ts（夹具可测）。
                      const snap = projections.snapshot(session, ['tokenUsage', 'subagentTiming', 'subagent'])
                      providerTokens = providerTokensOfSnapshot(snap) ?? null
                      const timing = agentTimingOfSnapshot(snap)
                      if (timing !== undefined) {
                        agentMs = timing.agent_ms
                        agentActive = timing.agent_active
                      }
                    } catch {
                      // 单个节点取数失败只降级该节点（= 不可用），不拖垮整个端点。
                      providerTokens = null
                    }
                  }
                  const mine = utterances.filter((utterance) => utterance.nodeKey === node.key)
                  const first = mine[0]?.ts
                  const last = mine[mine.length - 1]?.ts
                  return {
                    key: node.key,
                    status: node.status,
                    live: live !== undefined,
                    provider_tokens: providerTokens,
                    // 派生合计（投影无此字段）：列表只显示它，明细仍以四桶为准。
                    provider_total: providerTokens === null ? null : providerUsageTotal(providerTokens),
                    // 该席 agent 的真实耗时（`subagentTiming`），不是会议发言跨度；
                    // `agent_active` = 来自未结束的回合（数字还会涨）。
                    agent_ms: agentMs,
                    agent_active: agentActive,
                    // 会议发言的 ts 跨度：**不是** agent 耗时，但能看出该席的发言分布。
                    transcript_span_ms: first !== undefined && last !== undefined ? Math.max(0, last - first) : null,
                    utterances: mine.length,
                  }
                })
              return ok({
                nodes,
                budget_estimate: { used_tokens: meeting.budget.usedTokens, max_tokens: meeting.budget.maxTokens },
                projections_available: typeof projections?.snapshot === 'function',
                note: 'provider_tokens = provider 上报真实值（四桶）；agent_ms = 该席 agent 累计耗时（~ 表示回合进行中）；budget_estimate = 本地字符估算。三者口径不同，不可混用。',
              })
            })
          }
          case 'roundtable/mode.get': {
            // 会话级讨论模式：徽章数据源。缺席的会话按"未开"回答（不是错误）。
            const body = payload as { sessionId?: unknown } | undefined
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
            if (sessionId === '') return ok({ active: false, auto: false, manual: false })
            const state = runtime.mode?.read(sessionId)
            return ok({
              active: state === undefined ? false : (state.auto || state.manual),
              auto: state?.auto ?? false,
              manual: state?.manual ?? false,
            })
          }
          case 'roundtable/mode.set': {
            // tab 挂载/卸载 → 写 `auto` 那一份。命令写的 `manual` 不受影响。
            const body = payload as { sessionId?: unknown; active?: unknown } | undefined
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
            if (sessionId === '') return fail('payload needs a non-empty sessionId')
            if (typeof body?.active !== 'boolean') return fail('payload needs a boolean active')
            if (runtime.mode === undefined) return fail('mode table is not mounted in this composition')
            runtime.mode.set(sessionId, 'auto', body.active)
            const state = runtime.mode.read(sessionId)
            return ok({ active: state.auto || state.manual, auto: state.auto, manual: state.manual })
          }
          case 'roundtable/user-actions.append': {
            // The Web UI records an expert edit here instead of touching
            // meeting state; the captain drains the file next round.
            const body = payload as {
              meetingId?: unknown
              kind?: unknown
              nodeKey?: unknown
              role?: unknown
              provider?: unknown
              model?: unknown
              reasoningEffort?: unknown
              text?: unknown
            } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const kindRaw = typeof body?.kind === 'string' ? body.kind : ''
            if (meetingId === '' || (kindRaw !== 'add-node' && kindRaw !== 'remove-node' && kindRaw !== 'kb-path' && kindRaw !== 'other')) {
              return fail('payload must be { meetingId, kind, text } with kind in add-node|remove-node|kb-path|other')
            }
            const text = typeof body?.text === 'string' ? body.text.trim() : ''
            if (text === '') return fail('payload must include a non-empty text sentence')
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const action: UserAction = {
                id: randomUUID(),
                ts: Date.now(),
                kind: kindRaw as UserAction['kind'],
                nodeKey: typeof body?.nodeKey === 'string' && body.nodeKey.trim() !== '' ? body.nodeKey.trim() : undefined,
                role: typeof body?.role === 'string' && body.role.trim() !== '' ? body.role.trim() : undefined,
                provider: typeof body?.provider === 'string' && body.provider.trim() !== '' ? body.provider.trim() : undefined,
                model: typeof body?.model === 'string' && body.model.trim() !== '' ? body.model.trim() : undefined,
                // 逐字段显式构造（**刻意不用 spread**）：客户端多塞的键不落库，
                // 且新字段只在这里开口子，长度与空值口径与上面几项一致。
                reasoningEffort: typeof body?.reasoningEffort === 'string' && body.reasoningEffort.trim() !== ''
                  ? body.reasoningEffort.trim().slice(0, ROLE_PRESET_EFFORT_MAX)
                  : undefined,
                text,
              }
              await appendUserAction(stateRoot, meetingId, action)
              return ok({ id: action.id })
            })
          }
          case 'roundtable/user-actions.list': {
            const body = payload as { meetingId?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            if (meetingId === '') return fail('payload must be { meetingId }')
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              return ok<UserAction[]>(await readUserActions(stateRoot, meetingId))
            })
          }
          case 'roundtable/transcript.list': {
            // 群聊窗口的**按需**全量读取。
            //
            // 为什么不放宽快照里的 `recent`：那是 1Hz 轮询载荷的一部分
            // （snapshot.ts 记有"16 会议 301 KB"实测），把 20 条上限或 90 字截断
            // 放宽会让**每场会议每次轮询**都变大。群聊只在其窗口打开时需要全量，
            // 所以做成独立端点按需拉取 —— 轮询体保持原样。
            //
            // ⚠ 权限边界（写给后人）：本端点服务于**浏览器的用户视角**，用户是
            // 会议的信息枢纽，理应看到全部发言。它与专家侧 `roundtable_status`
            // 的 `statusVisibility` 过滤（visibility.ts）是**两套独立权限**——
            // 禁止拿 `statusVisibility` 来过滤本端点，那会让用户在群聊里看不到
            // 自己会议的全貌。
            const body = payload as { meetingId?: unknown; since?: unknown; limit?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            if (meetingId === '') return fail('payload must be { meetingId, since?, limit? }')
            const since = typeof body?.since === 'number' && Number.isFinite(body.since) ? body.since : 0
            const limit = clampTranscriptLimit(body?.limit)
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const all = await readTranscript(stateRoot, meetingId)
              // 截断标记由 host 判定并随数据一起回（而不是让客户端拿自己的页大小
              // 常量去猜）：判定权必须归知道全量的那一侧，否则 host 上限一改，
              // 前端"上面还有更早发言"的提示就会静默消失。见 selectTranscriptWindow。
              return ok<{ items: MeetingUtterance[]; truncated: boolean }>(
                selectTranscriptWindow(all, since, limit),
              )
            })
          }
          case 'roundtable/say': {
            // 群聊输入框：用户在窗口里说的话，落成一条主持人发言，并**唤醒主持人**。
            //
            // 与 `roundtable/speak`（主持人工具）的区别只在 `source: 'user'`：
            // 身份同为 `captain`（用户就是主持人本人），但主持人下一轮读
            // transcript 时必须能区分"用户亲口说的"与"我自己说的"，否则会
            // 把用户的话当成自己的话 —— 那是归因错误，不是风格问题。
            //
            // **为什么要唤醒**（v0.2.49 定案）：只落盘不唤醒的话，用户在空闲/
            // 结束的会议里说一句话，界面上它出现了，但**没有任何人或事会回应它** ——
            // 这正是本插件一直在防的"假成功"（落盘 ≠ 送达）。而且同一个输入条在
            // 空状态那一屏会 steer 主持人开局，在这里却毫无反应，两处行为不一致。
            // 唤醒是**尽力而为**：没有活的主持人 agent 时如实回 `delivered: false`，
            // 由前端提示 —— 不假装已送达。
            const body = payload as { meetingId?: unknown; text?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            if (meetingId === '') return fail('payload must be { meetingId, text }')
            const judged = normalizeSayText(body?.text)
            if (!judged.ok) return fail(judged.reason)
            const text = judged.text
            // 显式给出成功分支的类型：回调里同时有 `ok<…>()` 与 `fail()`，
            // 而 `fail<T>` 的 T 默认 unknown —— 不标注的话 T 会被推成 unknown。
            const recorded = await withMeetingRpcLock<{ id: string; ts: number; captainSessionId: string }>(
              runtime,
              meetingId,
              async (stateRoot) => {
                const meeting = await readMeeting(stateRoot, meetingId)
                if (meeting === undefined) return fail(`meeting "${meetingId}" not found`)
                const utterance: MeetingUtterance = {
                  id: randomUUID(),
                  nodeKey: CAPTAIN_KEY,
                  kind: 'speech',
                  content: text,
                  source: 'user',
                  round: meeting.round,
                  ts: Date.now(),
                }
                await appendUtterance(stateRoot, meetingId, utterance)
                return ok({ id: utterance.id, ts: utterance.ts, captainSessionId: meeting.captainSessionId })
              },
            )
            if (!recorded.ok) return recorded
            // 唤醒放在锁外（与 `roundtable_send_message` 同一理由：steer 会推进入
            // 主持人的回合，不该占着会议锁）。
            //
            // 必须**加壳**再转交：steer 出去的是 plugin 来源的消息，原文裸着塞进去
            // 主持人无法判断这是用户本人的指令、还是插件自己注入的文本。加壳照
            // `roundtable_send_message` 的既有格式，并点明出处 —— 主持人据此知道
            // "用户本人在会议群聊里说了这句话"。
            const captain = ctx.agents.get(recorded.value.captainSessionId as SessionId)
            const delivered = captain === undefined
              ? false
              : steerCaptain(captain, { kind: 'meeting-group-chat' }, text)
            return ok<{ id: string; ts: number; delivered: boolean }>({
              id: recorded.value.id,
              ts: recorded.value.ts,
              delivered,
            })
          }
          case 'roundtable/steer': {
            // 「还没有会议」空状态窗口里的输入框：此时会议**还不存在**，这条消息
            // 的作用不是发言，而是**开一场会议**。
            //
            // 语义与 `/roundtable <议题>` 斜杠命令完全一致（`src/index.ts` 的命令
            // 处理器）：① 把该会话标记为讨论模式（`manual=true`）；② 用 steer 把
            // 议题作为一条插件来源的用户消息交给主持人，主持人据此出设置卡片、
            // 拉起专家队伍。
            //
            // 三条刻意的选择：
            //   1. **复用 `steerCaptain`**（members.ts），不另写一条 steer 路径 ——
            //      那是本插件唯一的主持人投递入口，复制一份必然漂移。
            //   2. **不走 `runModeCommand`**：那个函数按斜杠命令语法解析，输入
            //      `off` 会退模式而不转交（见 parseModeCommand）。输入框里打的
            //      每个字都是**议题**，不能被当成命令 —— 否则用户想讨论"off 这个
            //      关键字怎么处理"时会静默地把模式关掉。
            //   3. **先置模式再 steer**：模式段是 system prompt 的一部分，顺序反了
            //      就会出现"议题已转交但主持人不知道要按圆桌处理"的窗口。
            const body = payload as { sessionId?: unknown; text?: unknown } | undefined
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
            if (sessionId === '') return fail('payload must be { sessionId, text }')
            const judged = normalizeSayText(body?.text)
            if (!judged.ok) return fail(judged.reason)
            if (runtime.mode === undefined) return fail('mode table is not mounted in this composition')
            const captain = ctx.agents.get(sessionId as SessionId)
            if (captain === undefined) {
              // 会话没有活 agent（页面刚刷新、会话已归档…）：明确报错，不假装已送达。
              return fail(`session "${sessionId}" has no live agent to steer`)
            }
            runtime.mode.set(sessionId, 'manual', true)
            if (!steerCaptain(captain, { kind: 'user-topic' }, judged.text)) {
              return fail('the session rejected the message (steer failed)')
            }
            const state = runtime.mode.read(sessionId)
            return ok<{ active: boolean; auto: boolean; manual: boolean }>({
              active: state.auto || state.manual,
              auto: state.auto,
              manual: state.manual,
            })
          }
          case 'roundtable/models.list': {
            // Model dropdown for the expert-management UI: every registered
            // provider route plus the models it advertises (advisory catalog),
            // each model carrying the reasoning-effort vocabulary the adapter
            // declares.
            //
            // `listModels()` NEVER carries `reasoning` — only `resolveModelInfo`
            // does. Reading the field off `listModels()` therefore yields
            // `undefined` forever, and the effort dropdown would silently show
            // nothing. The extra hop below is pure in-memory work (no provider
            // I/O), so no cache is warranted.
            const llm = ctx.get('llm') as ModelCatalogLlm | undefined
            return ok<ModelCatalog>(await buildModelCatalog(llm))
          }
          case 'roundtable/kb.path.set': {
            // Knowledge-base path (阅览版): validated, stored on the meeting,
            // never reads file contents. Relative paths resolve against the
            // meeting's own workspace.
            const body = payload as { meetingId?: unknown; path?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const raw = typeof body?.path === 'string' ? body.path.trim() : ''
            if (meetingId === '' || raw === '') return fail('payload must be { meetingId, path }')
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail<{ path: string }>(`meeting "${meetingId}" not found`)
              const workspace = dirname(stateRoot)
              const resolved = isAbsolute(raw) ? raw : join(workspace, raw)
              let info
              try {
                info = await stat(resolved)
              } catch {
                return fail<{ path: string }>(`path not found or unreadable: ${resolved}`)
              }
              if (!info.isDirectory()) return fail<{ path: string }>(`path is not a directory: ${resolved}`)
              meeting.kbPath = resolved
              await writeMeeting(stateRoot, meeting)
              return ok({ path: resolved })
            })
          }
          case 'roundtable/kb.list': {
            // List the first level of the configured knowledge base (names,
            // kinds, formats and sizes only — the browse-only contract).
            const body = payload as { meetingId?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            if (meetingId === '') return fail('payload must be { meetingId }')
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail<{ path: string }>(`meeting "${meetingId}" not found`)
              const configured = meeting.kbPath ?? ''
              if (configured === '') return ok({ path: '', configured: false, error: '', files: [] })
              const listing = await listKbDirectory(configured)
              // KB `valid` 通道（批次 A ⑤）：把 host 侧已算好的摘要有效性一并回传，
              // 让 UI 用「文件系统事实」判定变更，取代「用户勾选」这个静默失效补丁
              // （勾选框漏勾 = 变更永远不通知主持人，且无任何失败信号）。
              const cache = await readKbDigest(stateRoot, meetingId)
              const byPath = new Map(cache.entries.map((entry) => [entry.path, entry]))
              const files = listing.files.map((file) => {
                const entry = byPath.get(join(configured, file.name))
                return {
                  ...file,
                  // undefined = 该文件从未生成摘要（UI 显示"未读"，不是"已变更"）
                  valid: entry === undefined
                    ? undefined
                    : digestIsFresh(entry, { size: file.size, mtimeMs: file.mtimeMs }),
                }
              })
              return ok({ path: configured, configured: true, error: listing.error, files })
            })
          }
          case 'roundtable/review.endorse': {
            // V0.2.1 兼容别名：映射到三态 setStatus('endorsed')。
            const body = payload as { meetingId?: unknown; viewpointId?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const viewpointId = typeof body?.viewpointId === 'string' ? body.viewpointId : ''
            if (meetingId === '' || viewpointId === '') return fail('payload must be { meetingId, viewpointId }')
            return applyViewpointStatus(runtime, meetingId, viewpointId, 'endorsed')
          }
          case 'roundtable/review.setStatus': {
            // V0.2.2 三态：pending/endorsed/rejected 可互切（支持可取消、驳回）。
            // 驳回必填理由（C2）：payload.reject_reason 非空，由 setViewpointStatus 强制。
            const body = payload as { meetingId?: unknown; viewpointId?: unknown; status?: unknown; reject_reason?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const viewpointId = typeof body?.viewpointId === 'string' ? body.viewpointId : ''
            const status = body?.status
            if (meetingId === '' || viewpointId === '') return fail('payload must be { meetingId, viewpointId, status }')
            if (status !== 'pending' && status !== 'endorsed' && status !== 'rejected') {
              return fail('status must be "pending" | "endorsed" | "rejected"')
            }
            const rejectReason = typeof body?.reject_reason === 'string' ? body.reject_reason : undefined
            if (status === 'rejected' && (rejectReason === undefined || rejectReason.trim() === '')) {
              return fail('rejecting a viewpoint requires a non-empty reject_reason (驳回必填理由)')
            }
            return applyViewpointStatus(runtime, meetingId, viewpointId, status, rejectReason)
          }
          case 'roundtable/feedback.append': {
            // E1/E3 匿名反馈：前端在会议结束后询问，条目写工作区级 feedback.jsonl。
            const body = payload as {
              meetingId?: unknown
              mode?: unknown
              providers?: unknown
              models?: unknown
              usedRounds?: unknown
              usedTokens?: unknown
              rating?: unknown
              note?: unknown
            } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const mode = typeof body?.mode === 'string' ? body.mode : ''
            if (meetingId === '' || mode === '') return fail('payload must be { meetingId, mode, rating, ... }')
            const ratingRaw = typeof body?.rating === 'string' ? body.rating : ''
            if (ratingRaw !== 'good' && ratingRaw !== 'meh' && ratingRaw !== 'bad') {
              return fail('rating must be "good" | "meh" | "bad"')
            }
            const asStringList = (value: unknown): string[] =>
              Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20) : []
            const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 1000) : ''
            const entry: FeedbackEntry = {
              id: randomUUID(),
              ts: Date.now(),
              meetingId,
              mode,
              providers: asStringList(body?.providers),
              models: asStringList(body?.models),
              usedRounds: typeof body?.usedRounds === 'number' ? Math.max(0, Math.floor(body.usedRounds)) : 0,
              usedTokens: typeof body?.usedTokens === 'number' ? Math.max(0, Math.floor(body.usedTokens)) : 0,
              rating: ratingRaw,
              note: note === '' ? undefined : note,
            }
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              // 先清掉该会议的历史条目再追加（同一会议只保留最新一条反馈）。
              await clearFeedbackForMeeting(stateRoot, meetingId)
              await appendFeedback(stateRoot, entry)
              return ok({ id: entry.id })
            })
          }
          case 'roundtable/feedback.list': {
            const body = payload as { workspace?: unknown } | undefined
            const workspace = typeof body?.workspace === 'string' ? body.workspace : ''
            const roots = await feedbackStateRoots(runtime, workspace)
            const entries: FeedbackEntry[] = []
            for (const stateRoot of roots) {
              entries.push(...await readFeedback(stateRoot))
            }
            entries.sort((a, b) => b.ts - a.ts)
            return ok({ entries: entries.slice(0, 200) })
          }
          case 'roundtable/feedback.clear': {
            const body = payload as { workspace?: unknown } | undefined
            const workspace = typeof body?.workspace === 'string' ? body.workspace : ''
            const roots = await feedbackStateRoots(runtime, workspace)
            let cleared = 0
            for (const stateRoot of roots) {
              cleared += await clearFeedback(stateRoot)
            }
            return ok({ cleared })
          }
          default:
            return fail(`unknown endpoint: ${endpoint}`)
        }
    } catch (error: unknown) {
      // HTTP 回退路由必须"永不抛"，否则 webServer 会以 400 收场、客户端只能
      // 看到 fetch 失败而不是真正的错误信息。
      return fail(error instanceof Error ? error.message : String(error))
    }
  }

  // Transport 1: the host's generic connection channel (compatibility path).
  // Two arguments only: the 0.1.1-era `{ authority: 'trusted-host' }` trust
  // policy was removed from `connection.rpc.handle` — 0.1.5 declares
  // `handle(channel, handler) => disposer`. Historical note: back then,
  // omitting the option made host registration throw ("options.authority" read
  // on undefined), the channel never mounted, and every browser RPC failed with
  // "无法连接会议服务". That failure mode is gone; passing the extra object
  // today is silently ignored, which is exactly why it went unnoticed until
  // v0.2.21 aligned this shim with the real signature.
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection as unknown as RpcConnection
    const disposer: unknown = connection.rpc.handle('/roundtable', dispatch)
    // `connection.rpc.handle` returns the route disposer; hand it to the plugin
    // fiber so the channel unmounts with the plugin.
    if (typeof disposer === 'function') {
      const release = disposer as () => unknown
      connectionCtx.effect(() => () => {
        void release()
      }, 'roundtable: rpc channel')
    }
  })
  return dispatch
}

/** One knowledge-base directory entry (阅览版: name/kind/format/size only). */
export interface KbEntry {
  name: string
  kind: 'file' | 'dir'
  /** Lowercased extension without the dot (empty for directories). */
  ext: string
  size: number
  mtimeMs: number
}

/**
 * Resolve the state roots whose feedback.jsonl should be read/cleared:
 * every known workspace candidate (optionally narrowed to one named
 * workspace). A candidate whose state root directory does not exist yet
 * contributes nothing.
 */
async function feedbackStateRoots(runtime: RoundTableRuntime, workspaceName?: string): Promise<string[]> {
  const { workspaceCandidates } = await import('./workspace-candidates.ts')
  const { stat } = await import('node:fs/promises')
  const candidates = workspaceCandidates()
    .filter((candidate) => workspaceName === undefined || candidate.title === workspaceName)
  const roots: string[] = []
  for (const candidate of candidates) {
    const root = stateRootOf(candidate.path, runtime.stateDir)
    try {
      const info = await stat(root)
      if (info.isDirectory()) roots.push(root)
    } catch {
      // Directory not created yet: skip.
    }
  }
  return roots
}

/**
 * List the first level of a knowledge-base directory (browse-only): skips
 * dot-hidden entries, caps the result at 300 items so a huge folder cannot
 * blow up the UI, and tolerates per-entry stat failures.
 */
export async function listKbDirectory(dir: string): Promise<{ error: string; files: KbEntry[] }> {
  let info
  try {
    info = await stat(dir)
  } catch {
    return { error: 'path not found or unreadable', files: [] }
  }
  if (!info.isDirectory()) return { error: 'not a directory', files: [] }
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { error: 'directory unreadable', files: [] }
  }
  const files: KbEntry[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    let size = 0
    let mtimeMs = 0
    try {
      const entryStat = await stat(full)
      size = entryStat.size
      mtimeMs = entryStat.mtimeMs
    } catch {
      // Best-effort: an entry that vanished mid-listing still shows its name.
    }
    files.push({
      name: entry.name,
      kind: entry.isDirectory() ? 'dir' : 'file',
      ext: entry.isDirectory() ? '' : extname(entry.name).replace(/^\./, '').toLowerCase(),
      size,
      mtimeMs,
    })
    if (files.length >= 300) break
  }
  return { error: '', files }
}
