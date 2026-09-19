/**
 * The `roundtable_*` model-facing tools.
 *
 * The captain (the session that created the meeting) orchestrates: expert
 * nodes are continuable subagents it spawns and wakes. Nodes share the same
 * tools, speak through `roundtable_speak`, and — in egalitarian mode — message
 * each other directly. The aggregation gateway is a deterministic merge the
 * captain pulls with `roundtable_summarize`; human decisions pause the turn
 * through the `userQuestions` seam.
 * @module dsh-plugin-roundtable/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Meeting, MeetingDecision, MeetingEdge, MeetingNode, MeetingUtterance, ReviewRecord, SkillDelivery, UserAction } from './types.ts'
import { ACTIVE_NODE_STATUSES, AGGREGATOR_KEY, CAPTAIN_KEY } from './types.ts'
import {
  appendUtterance,
  clearUserActions,
  meetingDirOf,
  readKbDigest,
  readMeeting,
  readReview,
  readTranscript,
  readUserActions,
  readUserActionsReport,
  sanitizeKey,
  stateRootOf,
  withMeetingLock,
  writeKbDigest,
  writeMeeting,
  writeReview,
  writeTextAtomic,
} from './state.ts'
import { evaluateKbDigests, mergeKbDigestEntry } from './kb-digest.ts'
import { PLUGIN_ID, HARNESS_RANGE } from './version.ts'
import { buildCharter } from './charter.ts'
import { aggregateUtterances } from './aggregator.ts'
import { proxyThinkingPrompt } from './proxy-thinking.ts'
import { beginRound, budgetExceeded, ensureActive, estimateTokens, MeetingMutedError } from './budget.ts'
import { deliverToNode, interruptNode, nodeActivity, spawnNode, steerCaptain, type MemberRuntimeConfig } from './members.ts'
import { splitByMarkers, splitUtterance, type SplitLlmLike } from './review-split.ts'
import {
  formatMeetingDraft,
  PLAN_APPROVE_LABEL,
  PLAN_REVISE_LABEL,
  resolvePlanConfirmation,
  type MeetingDraft,
} from './plan.ts'
import { listInvocableSkills, type SkillSummaryLike } from './skills.ts'
import { recipientPolicy, statusVisibility } from './visibility.ts'
import { analyzeSilence, silenceMarkFor, silenceSummaryLine } from './silence.ts'
import {
  buildRoundSignals,
  buildTalentPool,
  dispatchableSeatKeys,
  formatHandoffRows,
  formatPlanGaps,
  formatPlanWaves,
  isDispatchableSeat,
  normalizePlanItems,
  onStagePresetMap,
  planWaves,
  presetLinkedSeatIds,
  requiresDispatchPlan,
  validateRoundPlan,
  type PlanReport,
  type RoundPlan,
} from './dispatch.ts'

/** Resolved plugin config consumed by the tools. */
export interface ToolsConfig {
  /** State directory name under the captain's workspace. */
  stateDir: string
  /** Node subagent provider name. */
  memberProvider: string
  /** Meeting size cap (nodes). */
  maxNodes: number
  /** Default collaboration mode. */
  defaultMode: 'orchestrated' | 'egalitarian' | 'redteam'
  /** Node delegation depth cap. */
  memberMaxDepth?: number
  /** Live expert answer limits from settings (read at every spawn). */
  getExpertLimits?: () => { maxTokens: number; maxOpinions: number }
  /** Live default skill-delivery mode from settings (R2.2/D5). */
  getSkillDelivery?: () => SkillDelivery
  /** 设置卡片默认值（R1，设置页那一层；调用时实时读取）。 */
  getPlannedDefaults?: () => PlannedDefaults
  /** 观点拆分 LLM 路由（V0.2.2）：collect_review 时把发言拆成独立观点。 */
  reviewSplit?: { provider: string; model: string; maxOpinions: number }
  /** R-A 修复：读取用户自建角色预设（实时）。缺省 = 无预设可用。 */
  getRolePresets?: () => readonly RolePresetLike[]
}

/**
 * 角色预设的最小结构（供本文件内消费）。
 *
 * 完整校验在 `rpc.ts` 的 `sanitizeRolePresets`（条目级：name/role 非空、
 * provider/model 成对、长度截断）。这里只做**读取侧**的宽松形状，不重复校验，
 * 避免两处规则漂移。
 */
export interface RolePresetLike {
  id: string
  name: string
  role: string
  provider?: string
  model?: string
  /** 可选思考强度（宿主档位 id）；空/缺席 = 继承主持人。 */
  reasoningEffort?: string
}

/**
 * 按 id 或显示名解析一条预设；精确匹配 id 优先，其次 name。
 *
 * 导出仅为可测（`test/preset-binding.test.mjs`）；它不读写会议状态，
 * 是纯粹的名字→预设映射。
 */
export function resolvePreset(
  presets: readonly RolePresetLike[],
  ref: string,
): RolePresetLike | undefined {
  const key = ref.trim()
  if (key === '') return undefined
  return presets.find((preset) => preset.id === key)
    ?? presets.find((preset) => preset.name === key)
}

/** Resolved defaults for one meeting's settings card (R1). */
interface PlannedDefaults {
  mode: 'orchestrated' | 'egalitarian' | 'redteam'
  maxRounds: number
  maxTokens: number
  skillDelivery: SkillDelivery
}

const DEFAULT_MAX_ROUNDS = 10
const DEFAULT_MAX_TOKENS = 200_000

/** 落账保留的历轮调度计划条数（防止 meeting.json 无限增长；导出/对账只关心近期）。 */
const MAX_ROUND_PLANS = 50

/** The caller agent, or a loud failure for non-agent callers. */
function requireCaptain(exec: { agent?: Agent }): Agent {
  if (exec.agent === undefined) {
    throw new Error('roundtable tools require a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

/** The captain's workspace directory (meeting state root parent). */
function workspaceOf(agent: Agent): string {
  const header = (agent.session as unknown as { header?: { cwd?: string } }).header
  return header?.cwd ?? process.cwd()
}

/** Process-local lock key enforcing one active meeting per captain session. */
function captainLockKey(stateRoot: string, captainId: string): string {
  return `captain:${stateRoot}:${captainId}`
}

/** Process-local lock key for one meeting directory. */
function meetingLockKey(stateRoot: string, meetingId: string): string {
  return `meeting:${stateRoot}:${meetingId}`
}

/** Find the active meeting this captain leads (or undefined). */
async function findMeetingByCaptain(stateRoot: string, captainId: string): Promise<Meeting | undefined> {
  const { listMeetings } = await import('./state.ts')
  for (const id of await listMeetings(stateRoot)) {
    const meeting = await readMeeting(stateRoot, id)
    if (meeting !== undefined
      && meeting.captainSessionId === captainId
      && meeting.status !== 'ended'
      && meeting.status !== 'archived') {
      return meeting
    }
  }
  return undefined
}

/** Find the active meeting this agent participates in (captain or node). */
async function findMeetingByParticipant(stateRoot: string, agentId: string): Promise<Meeting | undefined> {
  const { listMeetings } = await import('./state.ts')
  for (const id of await listMeetings(stateRoot)) {
    const meeting = await readMeeting(stateRoot, id)
    if (meeting === undefined || meeting.status === 'ended' || meeting.status === 'archived') continue
    if (meeting.captainSessionId === agentId) return meeting
    if (meeting.nodes.some((node) => node.id === agentId && ACTIVE_NODE_STATUSES.includes(node.status))) {
      return meeting
    }
  }
  return undefined
}

/** Locate the meeting the captain leads, or fail loudly (captain-tool boilerplate). */
async function locateCaptainMeeting(stateRoot: string, captainId: string): Promise<Meeting> {
  const located = await findMeetingByCaptain(stateRoot, captainId)
  if (located === undefined) throw new Error('you are not leading any meeting — call roundtable_create first')
  return located
}

/** Locate the meeting the caller participates in, or fail loudly. */
async function locateParticipantMeeting(stateRoot: string, agentId: string): Promise<Meeting> {
  const located = await findMeetingByParticipant(stateRoot, agentId)
  if (located === undefined) throw new Error('you do not belong to any active meeting yet')
  return located
}

/** Lock + captain-permission gate + active check: the inner captain-tool boilerplate. */
async function withCaptainLock<T>(
  stateRoot: string,
  meetingId: string,
  captainId: string,
  action: string,
  operation: (fresh: Meeting) => Promise<T>,
): Promise<T> {
  return withMeetingLock(meetingLockKey(stateRoot, meetingId), async () => {
    const fresh = await readMeeting(stateRoot, meetingId)
    if (fresh === undefined || fresh.captainSessionId !== captainId) {
      throw new Error(`only the captain of meeting "${meetingId}" may ${action}`)
    }
    ensureActive(fresh)
    return operation(fresh)
  })
}

type ParticipantIdentity =
  | { kind: 'captain' }
  | { kind: 'node'; name: string }

/** Derive the caller's role from fresh state. */
function participantIdentityOf(meeting: Meeting, agentId: string): ParticipantIdentity | undefined {
  if (meeting.captainSessionId === agentId) return { kind: 'captain' }
  const node = meeting.nodes.find((candidate) => candidate.id === agentId && candidate.status !== 'removed')
  return node === undefined ? undefined : { kind: 'node', name: node.key }
}

/** Fresh meeting plus caller identity, rechecked inside the lock. */
async function requireFreshParticipant(
  stateRoot: string,
  meetingId: string,
  callerId: string,
): Promise<{ meeting: Meeting; identity: ParticipantIdentity }> {
  const fresh = await readMeeting(stateRoot, meetingId)
  if (fresh === undefined) throw new Error(`meeting "${meetingId}" no longer exists`)
  const identity = participantIdentityOf(fresh, callerId)
  if (identity === undefined) throw new Error(`you are no longer a participant in meeting "${fresh.name}"`)
  return { meeting: fresh, identity }
}

/** Look up one live node by key. */
function requireNode(meeting: Meeting, key: string): MeetingNode {
  const node = meeting.nodes.find((candidate) => candidate.key === key && candidate.status !== 'removed')
  if (node === undefined) throw new Error(`no active node named "${key}" in meeting "${meeting.name}"`)
  return node
}

/** R-C `to:"all"` fan-out recipients: live (spawned, not removed) nodes except
 *  the speaker; a node speaker additionally reaches the captain. Roster
 *  broadcasts ride the same transcript + wake path as directed messages. */
export function broadcastRecipients(meeting: Meeting, speaker: string): string[] {
  // 席位口径单源（dispatch.isDispatchableSeat）：未移除且已出生，再排除发起者。
  const live = dispatchableSeatKeys(meeting.nodes).filter((key) => key !== speaker)
  return speaker === CAPTAIN_KEY ? live : [CAPTAIN_KEY, ...live]
}

/** Resolve a node for the given key (captain/aggregator are not nodes). */
function isNodeKey(meeting: Meeting, key: string): boolean {
  return meeting.nodes.some((candidate) => candidate.key === key && candidate.status !== 'removed')
}

/** Valid edge endpoints: captain, aggregator, or a live node. */
function validEndpoint(meeting: Meeting, key: string): boolean {
  return key === CAPTAIN_KEY || key === AGGREGATOR_KEY || isNodeKey(meeting, key)
}

/** Record one utterance and its token cost; throws when the meeting is muted. */
async function recordUtterance(
  stateRoot: string,
  meeting: Meeting,
  utterance: Omit<MeetingUtterance, 'id' | 'ts' | 'round'>,
): Promise<MeetingUtterance> {
  ensureActive(meeting)
  const full: MeetingUtterance = {
    ...utterance,
    id: randomUUID(),
    round: meeting.round,
    ts: Date.now(),
  }
  meeting.budget.usedTokens += estimateTokens(full.content)
  meeting.updatedAt = Date.now()
  await appendUtterance(stateRoot, meeting.id, full)
  await writeMeeting(stateRoot, meeting)
  return full
}

/** One answered question as returned by the `userQuestions` seam. */
interface AskUserQuestionAnswerItemLike {
  id: string
  selected: string[]
  custom?: string
}

/* ------------------------------------------------------------------ *
 * 会议设置卡片（R1）的默认值解析与卡片渲染。
 *
 * 默认值优先级（任务书 R1 第 3 条）：会议参数显式传入 > 插件
 * PreferenceSchema（设置页）> 插件 Config 默认值。设置页那一层由 index.ts
 * 通过 getPlannedDefaults 注入，这里只负责"显式传入 > 注入的偏好"。
 * ------------------------------------------------------------------ */

/** Normalize one meeting-mode argument (throws on garbage). */
function normalizeMode(value: unknown, fallback: 'orchestrated' | 'egalitarian' | 'redteam'): 'orchestrated' | 'egalitarian' | 'redteam' {
  if (value === undefined || value === null) return fallback
  if (value === 'orchestrated' || value === 'egalitarian' || value === 'redteam') return value
  throw new Error(`mode must be "orchestrated" | "egalitarian" | "redteam", got "${String(value)}"`)
}

/** Normalize one skill-delivery argument (throws on garbage). */
function normalizeSkillDelivery(value: unknown, fallback: SkillDelivery): SkillDelivery {
  if (value === undefined || value === null) return fallback
  if (value === 'relay' || value === 'direct') return value
  throw new Error(`skill_delivery must be "relay" | "direct", got "${String(value)}"`)
}

/** Sanitize a skill-name list: trim, drop empties, de-duplicate, cap at 20. */
function normalizeSkillNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const name = String(item ?? '').trim()
    if (name === '' || out.includes(name)) continue
    out.push(name)
    if (out.length >= 20) break
  }
  return out
}

/** 会议参数显式传入 > 设置页偏好 > Config 默认值。 */
function plannedDefaults(config: ToolsConfig, args: Record<string, unknown>): PlannedDefaults {
  const injected = config.getPlannedDefaults?.() ?? {
    mode: config.defaultMode,
    maxRounds: DEFAULT_MAX_ROUNDS,
    maxTokens: DEFAULT_MAX_TOKENS,
    skillDelivery: 'relay' as SkillDelivery,
  }
  const maxRounds = typeof args.max_rounds === 'number' && Number.isFinite(args.max_rounds) && args.max_rounds >= 1
    ? Math.floor(args.max_rounds)
    : injected.maxRounds
  const maxTokens = typeof args.max_tokens === 'number' && Number.isFinite(args.max_tokens) && args.max_tokens >= 1000
    ? Math.floor(args.max_tokens)
    : injected.maxTokens
  return {
    mode: normalizeMode(args.mode, injected.mode),
    maxRounds,
    maxTokens,
    skillDelivery: normalizeSkillDelivery(args.skill_delivery, injected.skillDelivery),
  }
}

/** 渲染一张设置卡片的正文（放 `AskUserQuestionItem.detail`）。
 *  渲染规则集中在 plan.ts，这里只做"加上当前可选 skill 清单"的转接。 */
function renderPlanCard(
  draft: MeetingDraft,
  experts: readonly { key: string; role?: string; provider?: string; model?: string }[],
  available: readonly SkillSummaryLike[],
  options: { revised: boolean },
): string {
  return formatMeetingDraft(draft, experts, { revised: options.revised, availableSkills: available })
}

/** Register every `roundtable_*` tool into the shared tools registry. */
export function registerRoundTableTools(ctx: Context, config: ToolsConfig): void {
  ctx.tools.register(defineTool({
    name: 'roundtable_create',
    description: 'Create a new RoundTable meeting: you (the calling agent) become the captain (主持人). A captain leads one active meeting at a time. Preferred flow (v0.2.31): call roundtable_plan_meeting first, let the user confirm the draft card, then create the meeting with exactly the confirmed values (name/goal/mode/max_rounds/max_tokens/kb_path/skills/skill_delivery). Choose the collaboration mode: "orchestrated" means you decide who speaks and relay everything; "egalitarian" means experts message each other directly (a budget of max rounds/tokens then mutes the meeting — 闭麦).',
    parameters: {
      name: { type: 'string', required: true, description: 'Name for the new meeting (used as its stable id).' },
      goal: { type: 'string', required: true, description: 'Meeting background and core goal (charter section one) — the ultimate deliverable.' },
      mode: {
        type: 'string',
        enum: ['orchestrated', 'egalitarian', 'redteam'],
        description: `Collaboration mode. Defaults to "${config.defaultMode}". "orchestrated" = captain relays everything; "egalitarian" = experts debate peer-to-peer under a budget (use max_rounds/max_tokens to bound it); "redteam" = 针锋相对评审 of a settled plan (experts attack the plan).`,
      },
      max_rounds: { type: 'integer', description: `Debate round cap (default ${DEFAULT_MAX_ROUNDS}); exceeding it mutes the meeting.` },
      max_tokens: { type: 'integer', description: `Total token budget for the meeting transcript (default ${DEFAULT_MAX_TOKENS}); exceeding it mutes the meeting.` },
      kb_path: { type: 'string', description: '知识库目录（可选）：主持人按需读取其中文件并转交专家。相对路径按工作区解析。' },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: '本次会议选中的 skill 名称清单（可选，来自 roundtable_plan_meeting 的卡片确认结果）。',
      },
      skill_delivery: {
        type: 'string',
        enum: ['relay', 'direct'],
        description: 'skill 传递方式：relay=主持人中转（默认）；direct=专家自行用 skill 工具调用。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          meeting_id: { type: 'string', required: true },
          meeting_name: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          max_rounds: { type: 'integer', required: true },
          max_tokens: { type: 'integer', required: true },
          kb_path: { type: 'string', required: true },
          skills: { type: 'array', required: true, items: { type: 'string' } },
          skill_delivery: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `RoundTable meeting "${value.meeting_name}" created (id ${value.meeting_id}, mode ${value.mode}, budget ${value.max_rounds} rounds / ${value.max_tokens} tokens, kb ${value.kb_path === '' ? 'none' : value.kb_path}, skills ${value.skills.length === 0 ? 'none' : value.skills.join(', ')} via ${value.skill_delivery}). You are the captain. Add expert nodes with roundtable_add_node.`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const meetingName = String(args.name ?? '').trim()
      if (meetingName === '') throw new Error('meeting name must not be empty')
      const meetingId = sanitizeKey(meetingName)
      // R1 第 3 条：缺省值必须与设置页一致（显式传入 > 设置页偏好 > Config）。
      // 主持人跳过设置卡片直接建会时，预算同样要落在设置页的值上。
      const defaults = plannedDefaults(config, args as Record<string, unknown>)
      const mode = defaults.mode
      // 用户确认过的 skill 清单优先；未给（或给空）则回退到设置页的默认传递方式。
      const requestedSkills = normalizeSkillNames(args.skills)
      const skillDelivery = defaults.skillDelivery
      const kbPath = typeof args.kb_path === 'string' ? args.kb_path.trim() : ''
      const maxRounds = defaults.maxRounds
      const maxTokens = defaults.maxTokens
      return withMeetingLock(captainLockKey(stateRoot, captain.id), async () => {
        const current = await findMeetingByCaptain(stateRoot, captain.id)
        if (current !== undefined) {
          throw new Error(`you already lead meeting "${current.name}" — close it before creating another`)
        }
        return withMeetingLock(meetingLockKey(stateRoot, meetingId), async () => {
          const existing = await readMeeting(stateRoot, meetingId)
          if (existing !== undefined && existing.status !== 'ended' && existing.status !== 'archived') {
            throw new Error(`meeting id "${meetingId}" is taken — pick a different meeting name`)
          }
          const now = Date.now()
          const meeting: Meeting = {
            id: meetingId,
            name: meetingName,
            goal: String(args.goal ?? ''),
            mode,
            captainSessionId: captain.id,
            charter: '',
            nodes: [],
            edges: [],
            decisions: [],
            budget: {
              maxRounds,
              maxTokens,
              usedRounds: 0,
              usedTokens: 0,
            },
            round: 0,
            ...(kbPath === '' ? {} : { kbPath }),
            ...(requestedSkills.length === 0 ? {} : { skills: requestedSkills }),
            skillDelivery,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          }
          meeting.charter = buildCharter(meeting)
          await writeMeeting(stateRoot, meeting)
          return {
            meeting_id: meeting.id,
            meeting_name: meeting.name,
            mode: meeting.mode,
            max_rounds: meeting.budget.maxRounds,
            max_tokens: meeting.budget.maxTokens,
            kb_path: meeting.kbPath ?? '',
            skills: meeting.skills ?? [],
            skill_delivery: meeting.skillDelivery ?? skillDelivery,
          }
        })
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_plan_meeting',
    description: 'Show the human a MEETING SETTINGS CARD before creating anything (R1). This tool does NOT create a meeting: it composes a readable draft (experts, mode, budget, knowledge base, selected skills) from the user\'s request plus your plugin defaults, then BLOCKS until the user confirms. Returns decision="approved" plus the confirmed plan to pass to roundtable_create, or decision="revise" with the user\'s own words — update the draft and call this tool again (the card is shown again, revised=true). Call it for EVERY meeting, even a single-expert one.',
    parameters: {
      name: { type: 'string', required: true, description: '草案里的会议名称（也是会议 id 的来源）。' },
      goal: { type: 'string', required: true, description: '会议背景与核心目标（总纲第一节）。' },
      mode: { type: 'string', enum: ['orchestrated', 'egalitarian', 'redteam'], description: '协作模式；缺省用设置页的默认模式。' },
      experts: {
        type: 'array',
        description: '草案里的专家名单（卡片上逐个列出）。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', required: true, description: '专家唯一标识，如 researcher。' },
            role: { type: 'string', description: '角色说明，如 安全审查。传了 preset 且解析成功时，此字段可省略。' },
            preset: { type: 'string', description: '可选：用户自建角色预设的 id 或名称（见 roundtable_list_presets）。卡片会显示该预设解析后的 role 与路由。' },
            provider: { type: 'string', description: '模型路由（与 model 同时给出才生效；缺省继承主持人当前路由）。' },
            model: { type: 'string', description: '模型名。' },
          },
        },
      },
      max_rounds: { type: 'integer', description: '轮数上限；缺省用设置页默认值。' },
      max_tokens: { type: 'integer', description: 'Token 预算；缺省用设置页默认值。' },
      kb_path: { type: 'string', description: '知识库目录（可空）。' },
      skills: { type: 'array', items: { type: 'string' }, description: '选中 skill 的名称清单（可空）。' },
      skill_delivery: { type: 'string', enum: ['relay', 'direct'], description: 'skill 传递方式；缺省用设置页默认值。' },
      revised: { type: 'boolean', description: '本次是"用户要求修改后"的再次确认（卡片会标注已按意见更新）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          decision: { type: 'string', required: true },
          user_note: { type: 'string', required: true },
          name: { type: 'string', required: true },
          goal: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          max_rounds: { type: 'integer', required: true },
          max_tokens: { type: 'integer', required: true },
          kb_path: { type: 'string', required: true },
          skills: { type: 'array', required: true, items: { type: 'string' } },
          skill_delivery: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.decision === 'approved'
          ? `用户已确认会议设置：创建 "${value.name}"（${value.mode}，${value.max_rounds} 轮 / ${value.max_tokens} tokens，kb ${value.kb_path === '' ? '未设置' : value.kb_path}，skills ${value.skills.length === 0 ? '未选' : value.skills.join(', ')}，skill 传递 ${value.skill_delivery}）。请用 roundtable_create 按这些值创建会议，然后逐个 roundtable_add_node。`
          : value.decision === 'revise'
            ? `用户要求修改：${value.user_note}\n请据此更新草案（保持未改动的项原样），再次调用 roundtable_plan_meeting 让用户确认；确认前不要创建会议。`
            : `设置卡片未能取得用户答复（userQuestions 服务不可用或被中止）${value.user_note === '' ? '' : `：${value.user_note}`}。请把草案内容用文字告知用户，取得明确同意后再调用 roundtable_create。`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const defaults = plannedDefaults(config, args as Record<string, unknown>)
      const name = String(args.name ?? '').trim()
      const goal = String(args.goal ?? '').trim()
      const kbPath = typeof args.kb_path === 'string' ? args.kb_path.trim() : ''
      const skills = normalizeSkillNames(args.skills)
      const experts = Array.isArray(args.experts)
        ? (args.experts as unknown[]).flatMap((raw) => {
            const entry = raw as { key?: unknown; role?: unknown; preset?: unknown; provider?: unknown; model?: unknown }
            const key = String(entry?.key ?? '').trim()
            if (key === '') return []
            // R-A：卡片必须显示**解析后**的 role/路由，否则用户确认的是一份与
            // 实际建节点不同的草案（本次自审抓到的假绿同型问题）。
            // 解析失败不静默：卡片上显式标注 unresolved，交由用户与主持人看见。
            const presetRef = entry?.preset === undefined ? '' : String(entry.preset).trim()
            let preset: RolePresetLike | undefined
            let unresolved = ''
            if (presetRef !== '') {
              const available = config.getRolePresets?.() ?? []
              preset = resolvePreset(available, presetRef)
              if (preset === undefined) unresolved = presetRef
            }
            const role = entry?.role !== undefined
              ? String(entry.role)
              : preset?.role
            const provider = entry?.provider !== undefined
              ? String(entry.provider)
              : (preset?.provider !== undefined && preset.model !== undefined ? preset.provider : undefined)
            const model = entry?.model !== undefined
              ? String(entry.model)
              : (preset?.provider !== undefined && preset.model !== undefined ? preset.model : undefined)
            return [{
              key,
              role,
              provider,
              model,
              preset: presetRef === '' ? undefined : presetRef,
              unresolved: unresolved === '' ? undefined : unresolved,
            }]
          })
        : []
      const draft: MeetingDraft = {
        name,
        goal,
        mode: defaults.mode,
        maxRounds: defaults.maxRounds,
        maxTokens: defaults.maxTokens,
        kbPath,
        skills,
        skillDelivery: defaults.skillDelivery,
      }
      // 清单读取失败一律降级为空（skills.ts 内部已兜底）。
      const available = await listInvocableSkills(ctx, workspace, exec.signal)
      const detail = renderPlanCard(draft, experts, available, { revised: args.revised === true })

      const userQuestions = ctx.get('userQuestions') as
        | {
            ask(request: {
              questions: {
                id: string
                question: string
                detail?: string
                header?: string
                options?: { label: string; description?: string }[]
                intent?: { kind: 'plan-review'; approve: string }
              }[]
              agent?: Agent
              signal?: AbortSignal
            }): Promise<{ answers: AskUserQuestionAnswerItemLike[] }>
          }
        | undefined
      const fallback = {
        decision: 'unavailable',
        user_note: userQuestions === undefined ? 'the userQuestions service is not mounted in this composition' : '',
        name: draft.name,
        goal: draft.goal,
        mode: draft.mode,
        max_rounds: draft.maxRounds,
        max_tokens: draft.maxTokens,
        kb_path: draft.kbPath,
        skills: draft.skills,
        skill_delivery: draft.skillDelivery,
      }
      if (userQuestions === undefined) return fallback

      const questionId = randomUUID()
      let answer
      try {
        answer = await userQuestions.ask({
          questions: [{
            id: questionId,
            question: `确认「${draft.name.trim() === '' ? '未命名会议' : draft.name.trim()}」的会议设置？`,
            detail,
            header: '圆桌会议 · 会议设置确认',
            options: [
              { label: PLAN_APPROVE_LABEL, description: '按上方参数创建会议（专家随后由主持人逐个拉入）' },
              { label: PLAN_REVISE_LABEL, description: '在输入框写明要改的地方，主持人会更新草案并再弹一次' },
            ],
            // 原生 plan-review 载体：detail 放 plan markdown，approve 指向批准选项。
            intent: { kind: 'plan-review', approve: PLAN_APPROVE_LABEL },
          }],
          agent: captain,
          signal: exec.signal,
        })
      } catch (error: unknown) {
        return { ...fallback, decision: 'unavailable', user_note: `设置卡片不可用：${(error as Error).message}` }
      }
      const item = answer.answers.find((candidate) => candidate.id === questionId)
      const confirmation = resolvePlanConfirmation(item)
      return {
        decision: confirmation.kind,
        user_note: confirmation.kind === 'revise' || confirmation.kind === 'unavailable' ? confirmation.note : '',
        name: draft.name,
        goal: draft.goal,
        mode: draft.mode,
        max_rounds: draft.maxRounds,
        max_tokens: draft.maxTokens,
        kb_path: draft.kbPath,
        skills: draft.skills,
        skill_delivery: draft.skillDelivery,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_add_node',
    description: 'Add an expert node to your meeting: spawns a durable continuable subagent with the meeting charter as its persona. By default the node inherits your current provider/model. Supply provider/model only when the user explicitly wants a different route for this expert. Pass `preset` to reuse one of the user\'s self-built role presets (see roundtable_list_presets, or the talent_pool section of roundtable_status) instead of inventing a role. Pulling a seat MID-MEETING is expected: when a round plan lists a `new:<preset>` gap, add that seat here before dispatching that item.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique node key inside the meeting (e.g. researcher, engineer, reviewer).' },
      role: { type: 'string', description: 'Role description for this expert (e.g. "security reviewer"). Ignored when `preset` resolves.' },
      preset: { type: 'string', description: 'Optional role-preset reference (id or exact name, as returned by roundtable_list_presets). When it resolves, the preset\'s role/provider/model fill any field you left unset; explicit `role`/`provider`/`model` still win.' },
      provider: { type: 'string', description: 'Optional LLM provider route. Use only when the user explicitly requests a different provider; requires model.' },
      model: { type: 'string', description: 'Optional model override. Omit to inherit your current model.' },
      reasoning_effort: { type: 'string', description: 'Optional adapter-owned reasoning-effort id for this expert (e.g. high / medium / low — the exact vocabulary is defined by the model capability, not by this plugin). Omit to inherit your own route-owned effort.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node_name: { type: 'string', required: true },
          node_id: { type: 'string', required: true },
          preset_id: { type: 'string', required: true, description: '该席来自哪条预设（空 = 临时角色）。' },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          reasoning_effort: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Node "${value.node_name}" joined (subagent id ${value.node_id}, ${value.provider}/${value.model}${value.reasoning_effort === '' ? '' : ` @ ${value.reasoning_effort}`}, status ${value.status}${value.preset_id === '' ? ', ad-hoc role' : `, from preset ${value.preset_id}`}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const located = await findMeetingByCaptain(stateRoot, captain.id)
      if (located === undefined) {
        throw new Error('you are not leading any meeting — call roundtable_create first')
      }
      const meetingId = located.id
      const created = await withCaptainLock(stateRoot, meetingId, captain.id, 'add nodes', async (fresh) => {
        const nodeKey = sanitizeKey(String(args.name ?? '').trim())
        if (nodeKey === '') throw new Error('node name must not be empty')
        if (nodeKey === CAPTAIN_KEY || nodeKey === AGGREGATOR_KEY) {
          throw new Error(`node name "${nodeKey}" is reserved`)
        }
        if (fresh.nodes.some((candidate) => candidate.key === nodeKey && candidate.status !== 'removed')) {
          throw new Error(`node "${nodeKey}" already exists in meeting "${fresh.name}"`)
        }
        if (fresh.nodes.filter((candidate) => candidate.status !== 'removed').length >= config.maxNodes) {
          throw new Error(`meeting "${fresh.name}" is at its node cap (${config.maxNodes})`)
        }
        // A2/A5: reasoning effort is captured on the node and forwarded by
        // spawnNode; an empty value means "inherit the captain's effort".
        // 预设可携带档位（R-A 扩展）：显式入参优先，其次预设，最后继承主持人。
        const explicitEffort = args.reasoning_effort !== undefined ? String(args.reasoning_effort).trim() : ''
        // R-A：预设引用。解析成功后，预设填充**未显式给出**的字段；显式参数优先。
        // 解析失败**不静默降级** —— 静默会让「以为用了预设」与「其实没用」不可分辨
        // （这正是本次自审抓到的假绿形态），所以直接报错并提示可用的 id。
        const presetRef = args.preset !== undefined ? String(args.preset).trim() : ''
        let fromPreset: RolePresetLike | undefined
        if (presetRef !== '') {
          const available = config.getRolePresets?.() ?? []
          fromPreset = resolvePreset(available, presetRef)
          if (fromPreset === undefined) {
            const hint = available.length === 0
              ? 'no role presets are defined (设置 → 圆桌会议 → 角色预设)'
              : `available: ${available.map((preset) => preset.id).join(', ')}`
            throw new Error(`roundtable: role preset "${presetRef}" not found — ${hint}`)
          }
        }
        const resolvedRole = args.role !== undefined
          ? String(args.role)
          : fromPreset?.role
        const resolvedProvider = args.provider !== undefined
          ? String(args.provider)
          : (fromPreset?.provider !== undefined && fromPreset.model !== undefined
              ? fromPreset.provider
              : captain.options.provider)
        const resolvedModel = args.model !== undefined
          ? String(args.model)
          : (fromPreset?.provider !== undefined && fromPreset.model !== undefined
              ? fromPreset.model
              : captain.options.model)
        // 档位与路由的关系：**可单独给出**（只改强度、不改路由），空即继承。
        const presetEffort = fromPreset?.reasoningEffort !== undefined ? String(fromPreset.reasoningEffort).trim() : ''
        const reasoningEffort = explicitEffort !== '' ? explicitEffort : presetEffort
        const node: MeetingNode = {
          id: '',
          key: nodeKey,
          role: resolvedRole,
          // R-D：记下预设来源，候选池才能机检"这条预设是否已在场"。
          presetId: fromPreset === undefined ? undefined : fromPreset.id,
          provider: resolvedProvider,
          model: resolvedModel,
          reasoningEffort: reasoningEffort === '' ? undefined : reasoningEffort,
          status: 'idle',
          joinedAt: Date.now(),
        }
        const limits = config.getExpertLimits?.() ?? { maxTokens: 0, maxOpinions: 0 }
        // R2：会议选中的 skill 清单随 persona 注入；direct 模式下专家需自行
        // 用 `skill` 工具加载，所以清单必须写进 persona（见 members.ts）。
        await spawnNode(ctx, {
          provider: config.memberProvider,
          maxDepth: config.memberMaxDepth,
        } as MemberRuntimeConfig, fresh, node, captain, config.stateDir, exec.signal, limits, {
          names: fresh.skills ?? [],
          delivery: fresh.skillDelivery ?? config.getSkillDelivery?.() ?? 'relay',
        })
        fresh.nodes.push(node)
        fresh.charter = buildCharter(fresh)
        try {
          await writeMeeting(stateRoot, fresh)
        } catch (error: unknown) {
          if (node.id !== '') interruptNode(ctx, captain, node.id)
          throw error
        }
        return {
          node_name: node.key,
          node_id: node.id,
          preset_id: node.presetId ?? '',
          provider: node.provider ?? '',
          model: node.model ?? '',
          reasoning_effort: node.reasoningEffort ?? '',
          status: node.status,
        }
      })
      return created
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_remove_node',
    description: 'Remove an expert node from your meeting: interrupts its live turn, marks it removed, and drops every edge touching it.',
    parameters: {
      name: { type: 'string', required: true, description: 'Key of the node to remove.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node_name: { type: 'string', required: true },
          removed_edges: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Node "${value.node_name}" removed; ${value.removed_edges} edge(s) dropped.`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      const removed = await withCaptainLock(stateRoot, located.id, captain.id, 'remove nodes', async (fresh) => {
        const node = requireNode(fresh, String(args.name ?? ''))
        node.status = 'removed'
        const before = fresh.edges.length
        fresh.edges = fresh.edges.filter((edge) => edge.from !== node.key && edge.to !== node.key)
        fresh.charter = buildCharter(fresh)
        await writeMeeting(stateRoot, fresh)
        return { node, removedEdges: before - fresh.edges.length }
      })
      if (removed.node.id !== '') interruptNode(ctx, captain, removed.node.id)
      return { node_name: removed.node.key, removed_edges: removed.removedEdges }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_connect',
    description: 'Create a directed channel between two participants (a node key, "captain", or "aggregator"). Direction "forward" = pipeline hand-off; "bidirectional" = debate channel (both sides may address each other).',
    parameters: {
      from: { type: 'string', required: true, description: 'Source endpoint: a node key, "captain", or "aggregator".' },
      to: { type: 'string', required: true, description: 'Target endpoint: a node key, "captain", or "aggregator".' },
      direction: { type: 'string', enum: ['forward', 'bidirectional'], description: 'Channel direction (default forward).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          edge_id: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          direction: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Channel ${value.edge_id}: ${value.from} → ${value.to} (${value.direction}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'edit channels', async (fresh) => {
        const from = String(args.from ?? '').trim()
        const to = String(args.to ?? '').trim()
        if (!validEndpoint(fresh, from)) throw new Error(`unknown endpoint "${from}"`)
        if (!validEndpoint(fresh, to)) throw new Error(`unknown endpoint "${to}"`)
        if (from === to) throw new Error('an edge cannot connect a participant to itself')
        if (fresh.edges.some((edge) => edge.from === from && edge.to === to)) {
          throw new Error(`channel ${from} → ${to} already exists`)
        }
        const direction = (args.direction ?? 'forward') as 'forward' | 'bidirectional'
        const edge: MeetingEdge = { id: randomUUID(), from, to, direction, createdAt: Date.now() }
        fresh.edges.push(edge)
        fresh.charter = buildCharter(fresh)
        await writeMeeting(stateRoot, fresh)
        return { edge_id: edge.id, from, to, direction }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_disconnect',
    description: 'Remove a channel by edge id, or by its from/to endpoints.',
    parameters: {
      edge_id: { type: 'string', description: 'Id of the edge to remove (from roundtable_status or connect).' },
      from: { type: 'string', description: 'Source endpoint (alternative to edge_id).' },
      to: { type: 'string', description: 'Target endpoint (alternative to edge_id).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.removed ? 'Channel removed.' : 'No matching channel found.' }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'edit channels', async (fresh) => {
        const before = fresh.edges.length
        if (args.edge_id !== undefined) {
          fresh.edges = fresh.edges.filter((edge) => edge.id !== String(args.edge_id))
        } else if (args.from !== undefined && args.to !== undefined) {
          fresh.edges = fresh.edges.filter((edge) => edge.from !== String(args.from) || edge.to !== String(args.to))
        } else {
          throw new Error('provide edge_id, or both from and to')
        }
        fresh.charter = buildCharter(fresh)
        await writeMeeting(stateRoot, fresh)
        return { removed: before !== fresh.edges.length }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_next_round',
    description: 'Advance the meeting to the next round and start it, WITH the dispatch plan for that round. Call this ONCE right before you dispatch a new round of tasks to the nodes. The plan is what makes "parallel vs serial" machine-checkable instead of a claim: every item is {id, task, owner, depends_on}; empty depends_on = dispatch in the same wave IN PARALLEL, non-empty depends_on = the item waits for those items (a later wave). The tool rejects cycles, dangling depends_on, and unknown seats, then returns waves/gaps. Hard gate: with 2 or more live seats a plan is REQUIRED — if nobody needs a task this round, do not advance the round at all. It also makes the max_rounds budget real; hitting the cap mutes the meeting (闭麦). Requires the captain.',
    parameters: {
      plan: {
        type: 'array',
        description: '本轮调度计划（在场席 ≥2 时必填）。owner = 在场席 key，或 "new:<预设 id>"（本轮需新拉该预设，会出现在 gaps 里）；depends_on 只填**本轮**其他项的 id。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '本轮内唯一的工作项 id（供 depends_on 引用）。' },
            task: { type: 'string', required: true, description: '这一项要做什么（一句话，可核）。' },
            owner: { type: 'string', required: true, description: '承接席：在场席 key，或 new:<预设 id>。' },
            depends_on: { type: 'array', items: { type: 'string' }, description: '必须先完成的本轮工作项 id；留空 = 与同为空的项并行。' },
          },
        },
      },
      note: { type: 'string', description: '一句话说明本轮意图（可选，落账进导出物）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          round: { type: 'integer', required: true, description: 'The new current round number.' },
          max_rounds: { type: 'integer', required: true },
          status: { type: 'string', required: true },
          muted_axis: { type: 'string', description: 'Empty when active; "rounds" | "tokens" when this advance muted the meeting.' },
          plan_items: { type: 'integer', required: true, description: '本轮计划条目数（0 = 单席会议免计划）。' },
          waves: { type: 'string', required: true, description: '按波次渲染的计划（同波可并发）。' },
          gaps: { type: 'string', required: true, description: '需要新拉席位的项。' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.muted_axis === ''
            ? `Round ${value.round}/${value.max_rounds} started.`
            : `Round ${value.round}/${value.max_rounds} — meeting is now MUTED (${value.muted_axis} exceeded). Top up with roundtable_set_budget or close it.`,
          value.plan_items === 0
            ? 'No dispatch plan (single-live-seat meeting: there is no parallel/serial question to answer).'
            : `Dispatch plan recorded (${value.plan_items} item(s)):\n${value.waves}`,
          ...(value.gaps === '' ? [] : [value.gaps]),
          ...(value.plan_items === 0 ? [] : [
            'Dispatch wave 1 now (one roundtable_send_message per owner, in parallel); only dispatch a later wave after every item it depends on has reported back.',
          ]),
        ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'advance the round', async (fresh) => {
        const items = normalizePlanItems(args.plan)
        // 硬门（用户 2026-09-19 拍板）：在场席 ≥2 时，"并行/串行分析"必须交出来。
        // 判据本体在 dispatch.requiresDispatchPlan（同一个函数被夹具钉死，
        // 避免"文案说要交、工具其实不查"的两处漂移）；席位口径同样单源。
        const liveNodes = fresh.nodes.filter(isDispatchableSeat)
        if (requiresDispatchPlan(liveNodes.length, items.length)) {
          throw new Error(
            `roundtable: meeting "${fresh.name}" has ${liveNodes.length} live seats — `
            + 'roundtable_next_round requires a dispatch plan (plan=[{id,task,owner,depends_on}]). '
            + 'Empty depends_on means "dispatch in parallel with the other empty ones"; depends_on means "wait for those items". '
            + `Live seats: ${liveNodes.map((node) => node.key).join(', ')}. `
            + 'If nobody needs a task this round, do not advance the round at all.',
          )
        }
        // 先校验、后推进：计划不合法时**不得**烧掉一轮（否则错误会让预算静默流失）。
        let report: PlanReport | undefined
        if (items.length > 0) {
          const presets = config.getRolePresets?.() ?? []
          const check = validateRoundPlan(items, {
            rosterKeys: liveNodes.map((node) => node.key),
            presets: presets.map((preset) => ({ id: preset.id, name: preset.name, role: preset.role })),
            onStagePresetIds: presetLinkedSeatIds(fresh.nodes),
          })
          if (!check.ok) throw new Error(`roundtable: invalid dispatch plan — ${check.error}`)
          report = check.report
        }
        beginRound(fresh)
        if (report !== undefined) {
          const kept = (fresh.roundPlans ?? []).filter((plan) => plan.round !== fresh.round)
          const recorded: RoundPlan = {
            round: fresh.round,
            items,
            createdAt: Date.now(),
          }
          const note = args.note === undefined ? '' : String(args.note).trim().slice(0, 500)
          if (note !== '') recorded.note = note
          fresh.roundPlans = [...kept, recorded].slice(-MAX_ROUND_PLANS)
        }
        const exceeded = budgetExceeded(fresh)
        if (exceeded !== undefined && fresh.status === 'active') fresh.status = 'muted'
        await writeMeeting(stateRoot, fresh)
        return {
          round: fresh.round,
          max_rounds: fresh.budget.maxRounds,
          status: fresh.status,
          muted_axis: exceeded ?? '',
          plan_items: items.length,
          waves: report === undefined ? '' : formatPlanWaves(report),
          gaps: report === undefined ? '' : formatPlanGaps(report),
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_speak',
    description: 'Write your contribution into the meeting transcript (the aggregation gateway input). Follow the charter format: start with [当前状态], end with [核心产出] and [下一步建议]; never output filler. Leave `to` empty to submit to the gateway; set it to a participant key for a directed remark.',
    parameters: {
      content: { type: 'string', required: true, description: 'The full contribution text.' },
      to: { type: 'string', description: 'Directed audience: a node key or "captain". Empty submits to the aggregation gateway.' },
      kind: { type: 'string', enum: ['speech', 'proxy-thinking', 'retrieval'], description: 'Contribution kind (default speech). Use "proxy-thinking" when you speak for a black-box worker model, "retrieval" when reporting knowledge-base retrieval.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          utterance_id: { type: 'string', required: true },
          round: { type: 'integer', required: true },
          tokens_used: { type: 'integer', required: true },
          budget_remaining_tokens: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Contribution recorded (id ${value.utterance_id}, round ${value.round}); meeting token budget remaining ${value.budget_remaining_tokens}.`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const located = await locateParticipantMeeting(stateRoot, caller.id)
      const recorded = await withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
        const { meeting, identity } = await requireFreshParticipant(stateRoot, located.id, caller.id)
        const content = String(args.content ?? '').trim()
        if (content === '') throw new Error('content must not be empty')
        const speaker = identity.kind === 'captain' ? CAPTAIN_KEY : identity.name
        const to = args.to !== undefined ? String(args.to).trim() : undefined
        if (to !== undefined && to !== '' && !validEndpoint(meeting, to)) {
          throw new Error(`unknown directed audience "${to}"`)
        }
        const kind = (args.kind ?? 'speech') as 'speech' | 'proxy-thinking' | 'retrieval'
        const utterance = await recordUtterance(stateRoot, meeting, { nodeKey: speaker, kind, content, to: to === '' ? undefined : to })
        return {
          utterance_id: utterance.id,
          round: utterance.round,
          tokens_used: estimateTokens(content),
          budget_remaining_tokens: Math.max(0, meeting.budget.maxTokens - meeting.budget.usedTokens),
        }
      })
      return recorded
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_send_message',
    description: 'Send a direct message to another participant: wakes the recipient as its next turn. In "orchestrated"/"redteam" (single-line) modes only the captain may message nodes, ONE NODE AT A TIME: experts do not know about each other, so never broadcast and never name another expert in the text you relay. In "egalitarian" mode any participant may message any other — this is how experts debate peer-to-peer — and to="all" broadcasts one message to every live participant (use it right after add_node/remove_node so running nodes learn the current roster; it costs one transcript line per recipient).',
    parameters: {
      to: { type: 'string', required: true, description: 'Recipient: "captain", a node key, or "all" (broadcast to every live participant).' },
      content: { type: 'string', required: true, description: 'The message text.' },
      work_item: { type: 'string', description: 'R-D：这条消息下发的是本轮调度计划里的哪个工作项 id（如 "a1"）。填了才能机检"计划被真的跟到底"——同一席位有多个工作项时，只有席位粒度的对账抓不到漏派。追问/转达意见等不属于任何工作项的消息留空。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'string', required: true, description: 'wake (recipient node woken), live (captain steered), or dropped (best effort failed). For to="all": comma-separated key:outcome per recipient.' },
          work_item: { type: 'string', required: true, description: '被记录的 work_item（空 = 未按项追踪）。' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Delivery: ${value.delivered}${value.work_item === '' ? '' : ` (work item ${value.work_item})`}.`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const located = await locateParticipantMeeting(stateRoot, caller.id)
      const content = String(args.content ?? '').trim()
      if (content === '') throw new Error('content must not be empty')
      const to = String(args.to ?? '').trim()
      if (to === '') throw new Error('recipient must not be empty')
      // R-D：可选的工作项追踪。填了才能机检"计划被真的跟到底"。
      const workItem = args.work_item !== undefined ? String(args.work_item).trim().slice(0, 60) : ''
      const prepared = await withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
        const { meeting, identity } = await requireFreshParticipant(stateRoot, located.id, caller.id)
        ensureActive(meeting)
        const speaker = identity.kind === 'captain' ? CAPTAIN_KEY : identity.name
        // 工作项必须真的在本轮计划里 —— 否则"追踪"本身可以被编造，
        // 那份对账就只是自证（与"契约须描述现状"同理：不许写不存在的项）。
        if (workItem !== '') {
          const currentPlan = (meeting.roundPlans ?? []).find((plan) => plan.round === meeting.round)
          const known = currentPlan?.items.some((item) => item.id === workItem) === true
          if (!known) {
            throw new Error(
              `work_item "${workItem}" is not an item of round ${meeting.round}'s dispatch plan`
              + (currentPlan === undefined
                ? ' (this round has no plan — call roundtable_next_round with one first)'
                : ` (this round plans: ${currentPlan.items.map((item) => item.id).join(', ')})`),
            )
          }
        }
        // 三模式语义（2026-09-19）：收件人策略集中在 visibility.ts ——
        // 单线制下节点只能发主持人；广播 to="all" 仅圆桌制允许。
        const policy = recipientPolicy(meeting.mode, identity.kind === 'captain' ? 'captain' : 'node', to)
        if (policy === 'captain-only') {
          throw new Error('orchestrated/redteam mode: nodes report to the captain only — the captain relays between nodes')
        }
        if (policy === 'broadcast-egalitarian-only') {
          throw new Error('broadcast (to="all") is egalitarian-only — in orchestrated/redteam, message one node at a time (experts do not know about each other)')
        }
        if (to === 'all') {
          const recipients = broadcastRecipients(meeting, speaker)
          if (recipients.length === 0) throw new Error('no live participants to broadcast to (every node is unspawned or removed)')
          for (const recipient of recipients) {
            await recordUtterance(stateRoot, meeting, { nodeKey: speaker, kind: 'speech', content, to: recipient, workItem: workItem === '' ? undefined : workItem })
          }
          return { kind: 'broadcast' as const, meeting, speaker, recipients }
        }
        if (to === CAPTAIN_KEY) {
          // Captain-bound messages are persisted in the transcript; live steering happens after the lock.
          await recordUtterance(stateRoot, meeting, { nodeKey: speaker, kind: 'speech', content, to: CAPTAIN_KEY, workItem: workItem === '' ? undefined : workItem })
          return { kind: 'captain' as const, meeting, speaker }
        }
        const recipient = requireNode(meeting, to)
        if (recipient.id === '') throw new Error(`node "${to}" has no live subagent yet`)
        await recordUtterance(stateRoot, meeting, { nodeKey: speaker, kind: 'speech', content, to, workItem: workItem === '' ? undefined : workItem })
        return { kind: 'node' as const, meeting, speaker, recipient }
      })
      const captainLive = ctx.agents.get(prepared.meeting.captainSessionId as import('@deepseek-ai/dsh-session').SessionId)
      if (prepared.kind === 'broadcast') {
        const outcomes: string[] = []
        for (const recipient of prepared.recipients) {
          if (recipient === CAPTAIN_KEY) {
            const steered = captainLive !== undefined && prepared.speaker !== CAPTAIN_KEY
              && steerCaptain(captainLive, `RoundTable message from ${prepared.speaker}:\n\n${content}`)
            outcomes.push(`captain:${steered ? 'live' : 'dropped'}`)
            continue
          }
          const target = prepared.meeting.nodes.find((node) => node.key === recipient)
          const accepted = target !== undefined && captainLive !== undefined
            ? await deliverToNode(ctx, captainLive, target.id, content, exec.signal)
            : false
          outcomes.push(`${recipient}:${accepted ? 'wake' : 'dropped'}`)
        }
        return { delivered: outcomes.join(','), work_item: workItem }
      }
      if (prepared.kind === 'captain') {
        if (captainLive !== undefined && prepared.speaker !== CAPTAIN_KEY) {
          const delivered = steerCaptain(captainLive, `RoundTable message from ${prepared.speaker}:\n\n${content}`)
          return { delivered: delivered ? 'live' : 'dropped', work_item: workItem }
        }
        return { delivered: 'dropped', work_item: workItem }
      }
      if (captainLive !== undefined) {
        const accepted = await deliverToNode(ctx, captainLive, prepared.recipient.id, content, exec.signal)
        return { delivered: accepted ? 'wake' : 'dropped', work_item: workItem }
      }
      return { delivered: 'dropped', work_item: workItem }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_summarize',
    description: 'Pull the aggregation gateway digest: a deterministic structured merge of the transcript (per-speaker recent lines). Use it to stay aligned without reading every raw line; you may then condense it further in your own reply.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          digest: { type: 'string', required: true },
          speech_count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `[Gateway digest]\n${value.digest}` }],
    },
    async execute(_args, exec) {
      const caller = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const located = await locateParticipantMeeting(stateRoot, caller.id)
      const utterances = await readTranscript(stateRoot, located.id)
      // 静默标记（批次 B ②）：摘要尾部必须写清"谁派了没回"，
      // 否则主持人读摘要时看不出整席缺失（网关摘要原本只含已发言者）。
      const meeting = await readMeeting(stateRoot, located.id)
      const silenceLine = meeting === undefined
        ? ''
        : silenceSummaryLine(analyzeSilence(
          { status: meeting.status, round: meeting.round, nodes: meeting.nodes },
          utterances,
        ))
      return {
        digest: silenceLine === '' ? aggregateUtterances(utterances) : `${aggregateUtterances(utterances)}\n\n[静默判据] ${silenceLine}`,
        speech_count: utterances.filter((utterance) => utterance.kind === 'speech' || utterance.kind === 'proxy-thinking').length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_request_decision',
    description: 'Pause the meeting and ask the human for a decision (Human-in-the-loop). The user picks one option or types their own. The meeting turn blocks until the user answers; the answer is then returned to you. Use for real forks or disagreements the experts cannot settle.',
    parameters: {
      question: { type: 'string', required: true, description: 'The decision to put to the user (e.g. "架构方案 A 还是 B？").' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Option labels (e.g. ["方案 A：模块化", "方案 B：一体化"]). The user may also type a custom answer.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          decision_id: { type: 'string', required: true },
          chosen: { type: 'string', required: true },
          custom_answer: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Human decision ${value.decision_id}: ${value.chosen}${value.custom_answer !== undefined && value.custom_answer !== '' ? ` (custom: ${value.custom_answer})` : ''}`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      const question = String(args.question ?? '').trim()
      if (question === '') throw new Error('question must not be empty')
      const optionLabels = Array.isArray(args.options)
        ? (args.options as unknown[]).map((option) => String(option).trim()).filter((option) => option !== '')
        : []
      const decision: MeetingDecision = {
        id: randomUUID(),
        question,
        options: optionLabels,
        status: 'pending',
        ts: Date.now(),
      }
      await withCaptainLock(stateRoot, located.id, captain.id, 'request decisions', async (fresh) => {
        fresh.decisions.push(decision)
        await writeMeeting(stateRoot, fresh)
      })

      const userQuestions = ctx.get('userQuestions') as
        | { ask(request: { questions: { id: string; question: string; header?: string; options?: { label: string; description?: string }[] }[]; agent?: Agent; signal?: AbortSignal }): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }> }
        | undefined
      if (userQuestions === undefined) {
        decision.status = 'resolved'
        decision.chosen = '(unavailable)'
        await withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
          const fresh = await readMeeting(stateRoot, located.id)
          if (fresh !== undefined) await writeMeeting(stateRoot, fresh)
        })
        throw new Error('roundtable: human decision unavailable — the userQuestions service is not mounted in this composition')
      }
      const answer = await userQuestions.ask({
        questions: [{
          id: decision.id,
          question,
          header: '圆桌会议 · 需人类决策',
          ...(optionLabels.length > 0 ? { options: optionLabels.map((label) => ({ label })) } : {}),
        }],
        agent: captain,
        signal: exec.signal,
      })
      const item = answer.answers.find((candidate) => candidate.id === decision.id)
      const chosen = item?.selected[0]
      const customAnswer = item?.custom !== undefined && item.custom !== '' ? item.custom : undefined
      await withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
        const fresh = await readMeeting(stateRoot, located.id)
        if (fresh === undefined) return
        const target = fresh.decisions.find((candidate) => candidate.id === decision.id)
        if (target !== undefined) {
          target.status = 'resolved'
          target.chosen = chosen
          if (customAnswer !== undefined) target.customAnswer = customAnswer
        }
        await writeMeeting(stateRoot, fresh)
      })
      return {
        decision_id: decision.id,
        chosen: chosen ?? '(no selection)',
        ...(customAnswer !== undefined ? { custom_answer: customAnswer } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_status',
    description: 'Meeting snapshot: nodes with live activity, edges, budget, pending decisions, and the recent transcript tail. Poll this to watch progress.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value as Record<string, unknown>) }],
    },
    async execute(_args, exec) {
      const caller = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const located = await locateParticipantMeeting(stateRoot, caller.id)
      const { meeting, identity } = await withMeetingLock(
        meetingLockKey(stateRoot, located.id),
        () => requireFreshParticipant(stateRoot, located.id, caller.id),
      )
      const activity = nodeActivity(ctx, meeting.nodes)
      const utterances = await readTranscript(stateRoot, meeting.id)
      const userActions = await readUserActions(stateRoot, meeting.id)
      // 三模式语义（2026-09-19）：单线制下专家**不掌握其他席位** —— 快照必须
      // 与提示词一致，否则"文案说不认识、工具一查全认识"就是假隔离。
      const viewerKey = identity.kind === 'captain' ? CAPTAIN_KEY : identity.name
      const vis = statusVisibility(meeting.mode, identity.kind === 'captain' ? 'captain' : 'node', viewerKey)
      // 静默席判据（批次 A ②）：让"专家没 speak 就结束回合"这条缺陷**在运行态可见**，
      // 而不是只活在测试里。三条护栏与硬阈值见 src/silence.ts。
      // （内联成字面量是因为工具输出要求 JSON 兼容类型，interface 没有索引签名。）
      const silence = analyzeSilence(
        { status: meeting.status, round: meeting.round, nodes: meeting.nodes },
        utterances.map((utterance) => ({ nodeKey: utterance.nodeKey, round: utterance.round, to: utterance.to })),
      )
      // 隔离修正（R-D 顺带）：静默判据原样返回全员席位名 —— 单线制下节点调一次
      // `roundtable_status` 就能读到同伴的 key，与 members.ts 里"deny
      // roundtable_summarize"的理由（文案说不认识、工具一查全认识）是同一个漏洞。
      // 主持人不受影响；节点只保留**自己**那一条（"你这轮没回"对它是有效信息）。
      const silenceForViewer = vis.full
        ? silence
        : {
            ...silence,
            emptyRounds: [] as number[],
            silentSeats: silence.silentSeats.filter((entry) => entry.seat === viewerKey),
            lateReplies: silence.lateReplies.filter((entry) => entry.seat === viewerKey),
          }
      // R-D ①：候选池进每轮信息面。此前主持人每轮唯一的信息拉取（本工具）
      // 只回在场席 —— 专家库（用户自建预设）不进信息面，主持人结构上想换人也没得选。
      // 只给 id/name/路由：28 条预设的 role 全文约 3.4k token，必须走
      // roundtable_list_presets filter=<关键词> 按需取，不能每轮灌。
      // 单线制下**只给主持人**：候选池会暴露"还有哪些席位在别处"，那是隔离面。
      const presets = config.getRolePresets?.() ?? []
      // 可派单席判据单源（dispatch.isDispatchableSeat）：未移除**且已出生**。
      const liveSeatKeys = dispatchableSeatKeys(meeting.nodes)
      // 计算集中在 dispatch.ts（纯函数、夹具可测）；这里只负责取实时数据 + 按可见性裁剪。
      const talentPool = vis.full
        ? buildTalentPool(presets, meeting.nodes)
        : { total: 0, on_stage: [], candidates: [] }
      // R-D ②：本轮信号的账本侧。计划说了发给谁 vs 实际发给谁；
      // 专家用 [越界转派] 交给主持人的"该换人"事项（此前只是 persona 文案，
      // 机器读不到，于是"这活该别人接"永远沉在发言里）。
      const roundSignals = vis.full
        ? buildRoundSignals({
            round: meeting.round,
            mode: meeting.mode,
            plan: (meeting.roundPlans ?? []).find((plan) => plan.round === meeting.round),
            liveSeatKeys,
            utterances,
            // `new:<预设>` 已在场时还原成真席位，否则对账会把正常派发误报成
            // "计划外派发"（假信号淹没真信号）。走**唯一装配入口**，与 snapshot.ts 同源。
            onStageByPreset: onStagePresetMap(talentPool.on_stage),
          })
        // 节点视角给 null（不是 undefined：工具输出必须是 JSON 值）。
        // 渲染侧按 `round === undefined` 整段省略，绝不渲染成"没做分析"。
        : null
      return {
        meeting_id: meeting.id,
        meeting_name: meeting.name,
        mode: meeting.mode,
        status: meeting.status,
        viewer: identity.kind === 'captain' ? CAPTAIN_KEY : identity.name,
        round: meeting.round,
        kb_path: meeting.kbPath ?? '',
        skills: meeting.skills ?? [],
        skill_delivery: meeting.skillDelivery ?? config.getSkillDelivery?.() ?? 'relay',
        budget: {
          max_rounds: meeting.budget.maxRounds,
          max_tokens: meeting.budget.maxTokens,
          used_rounds: meeting.budget.usedRounds,
          used_tokens: meeting.budget.usedTokens,
        },
        nodes: meeting.nodes
          .filter((node) => node.status !== 'removed')
          .map((node) => ({
            key: node.key,
            role: node.role ?? '',
            provider: node.provider ?? '',
            model: node.model ?? '',
            reasoning_effort: node.reasoningEffort ?? '',
            status: node.status,
            activity: activity.get(node.key) ?? 'unspawned',
          }))
          .filter((row) => vis.node(row)),
        edges: meeting.edges.map((edge) => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          direction: edge.direction,
        })).filter((row) => vis.edge(row)),
        // 单线制下专家不参与人类决策（persona 规则 4 已禁其发起），故对节点不回决策项。
        pending_decisions: vis.full
          ? meeting.decisions
            .filter((decision) => decision.status === 'pending')
            .map((decision) => ({ id: decision.id, question: decision.question, options: decision.options }))
          : [],
        pending_actions: userActions.map((action) => ({
          id: action.id,
          kind: action.kind,
          node_key: action.nodeKey ?? '',
          role: action.role ?? '',
          provider: action.provider ?? '',
          model: action.model ?? '',
          text: action.text,
        })).filter((row) => vis.action(row)),
        recent_utterances: utterances.map((utterance) => ({
          speaker: utterance.nodeKey,
          kind: utterance.kind,
          content: utterance.content.slice(0, 400),
          to: utterance.to ?? '',
          round: utterance.round,
        })).filter((row) => vis.utterance(row)).slice(-10),
        silence: {
          closedRounds: silenceForViewer.closedRounds,
          closedSeats: silenceForViewer.closedSeats,
          emptyRounds: silenceForViewer.emptyRounds,
          silentSeats: silenceForViewer.silentSeats,
          lateReplies: silenceForViewer.lateReplies,
        },
        talent_pool: talentPool,
        round_signals: roundSignals,
        kb_digest: await kbDigestOverview(stateRoot, meeting.id),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_kb_digest',
    description: 'Record (or refresh) a knowledge-base digest in the meeting cache after YOU read a KB file. The plugin stats the file itself and stores path+size+mtimeMs as the invalidation key; from then on roundtable_status shows that entry with valid=true and you reuse the summary instead of reading the file again — this is what stops you and the expert paying for the same file twice, and the cache itself costs no tokens. Check roundtable_status FIRST: if the entry is already valid, reuse it and do not read the file. Requires the captain.',
    parameters: {
      path: { type: 'string', required: true, description: 'KB file path: absolute, or relative to the meeting\'s kb_path.' },
      digest: { type: 'string', required: true, description: 'The distilled points you will actually reuse (a summary, not a copy of the file).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          size: { type: 'integer', required: true },
          mtime_ms: { type: 'integer', required: true },
          cached_entries: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Knowledge-base digest cached for ${value.path} (${value.size} bytes); ${value.cached_entries} entry(ies) in this meeting's cache.`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'record a knowledge-base digest', async (fresh) => {
        const raw = String(args.path ?? '').trim()
        if (raw === '') throw new Error('path must not be empty')
        // Relative paths resolve against the meeting's own kb_path so the
        // captain can write the short name it just saw in the KB listing.
        const kbPath = fresh.kbPath ?? ''
        const resolved = isAbsolute(raw) ? raw : (kbPath === '' ? raw : join(kbPath, raw))
        let info
        try {
          info = await stat(resolved)
        } catch {
          throw new Error(`knowledge-base file not found or unreadable: ${resolved}`)
        }
        if (!info.isFile()) throw new Error(`not a file: ${resolved}`)
        const digestText = String(args.digest ?? '').trim()
        if (digestText === '') throw new Error('digest must not be empty')
        const cache = await readKbDigest(stateRoot, fresh.id)
        const entries = mergeKbDigestEntry(cache.entries, {
          path: resolved,
          size: info.size,
          mtimeMs: info.mtimeMs,
          digest: digestText,
          ts: Date.now(),
        })
        await writeKbDigest(stateRoot, fresh.id, entries)
        return {
          path: resolved,
          size: info.size,
          mtime_ms: Math.round(info.mtimeMs),
          cached_entries: entries.length,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_actions_clear',
    description: 'Clear the meeting\'s pending user-actions file (user-actions.jsonl) after you executed every recorded action with the roundtable_* tools. Only call this after each action was applied successfully; on a failure keep the record and explain why. Returns how many actions were cleared, plus how many unparseable lines had to be dropped (report a non-zero count to the user — an action was lost).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cleared: { type: 'integer', required: true },
          malformed: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.malformed > 0
          ? `Cleared ${value.cleared} pending user action(s), and dropped ${value.malformed} unparseable line(s) — tell the user those operations were lost and could not be executed.`
          : `Cleared ${value.cleared} pending user action(s).`,
      }],
    },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'clear user actions', async (fresh) => {
        return clearUserActions(stateRoot, fresh.id)
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_start_review',
    description: 'Start a 针锋相对 (adversarial) review pass of a settled plan: records the user\'s original question and the captain\'s plan into review.json, so the Web review window can show them. First pass = reviewPass 1. After a previous pass was finished (status done), calling this again starts the next review pass (reviewPass + 1, closed loop 闭环复审) and preserves the previous pass in history; the captain may open at most 2 re-review passes beyond the first (maxReviewPass 3). To go beyond the cap, the user must have explicitly approved: pass user_approved_extra_pass=true. Requires the captain.',
    parameters: {
      question: { type: 'string', required: true, description: 'The user\'s original question / topic.' },
      plan: { type: 'string', required: true, description: 'The settled plan and its explanation (the object under review).' },
      user_approved_extra_pass: { type: 'boolean', description: 'Set true ONLY when the user explicitly approved exceeding the re-review cap (maxReviewPass). Never set on your own.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          review_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          review_pass: { type: 'integer', required: true },
          max_review_pass: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Review started (id ${value.review_id}, status ${value.status}, review pass ${value.review_pass}/${value.max_review_pass}). Tell the experts to attack ONLY the plan (red-team).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      const question = String(args.question ?? '').trim()
      const plan = String(args.plan ?? '').trim()
      if (question === '' || plan === '') throw new Error('question and plan must not be empty')
      return withCaptainLock(stateRoot, located.id, captain.id, 'start a review', async (fresh) => {
        // S1 覆盖保护：进行中的评审（含已支持/驳回记录）不允许被静默覆盖。
        const existing = await readReview(stateRoot, fresh.id)
        if (existing !== undefined && existing.status !== 'done') {
          throw new Error(`a review is already in progress (status ${existing.status}) — finish it before starting a new pass`)
        }
        // 复审轮次（C3）：上一轮已 done → reviewPass+1；超上限须用户显式批准。
        const previousPass = existing?.status === 'done' && typeof existing.reviewPass === 'number' ? existing.reviewPass : 0
        const reviewPass = previousPass + 1
        const maxReviewPass = existing?.maxReviewPass ?? 3
        if (reviewPass > maxReviewPass && args.user_approved_extra_pass !== true) {
          throw new Error(`re-review cap reached (pass ${reviewPass} > max ${maxReviewPass}) — ask the user to approve continuing, then retry with user_approved_extra_pass=true, or export and finish the review`)
        }
        const now = Date.now()
        const review: ReviewRecord = {
          meetingId: fresh.id,
          question,
          plan,
          status: 'reviewing',
          reviewPass,
          maxReviewPass,
          schemaVersion: 2,
          viewpoints: [],
          startedAt: now,
          updatedAt: now,
          // 保留上一轮快照（闭环核对"旧缺陷是否修复"的依据）。
          history: existing?.status === 'done' ? [...(existing.history ?? []), {
            pass: existing.reviewPass,
            question: existing.question,
            plan: existing.plan,
            viewpoints: existing.viewpoints,
            finishedAt: existing.finishedAt ?? now,
          }] : [],
        }
        await writeReview(stateRoot, fresh.id, review)
        return { review_id: fresh.id, status: review.status, review_pass: review.reviewPass, max_review_pass: review.maxReviewPass }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_collect_review',
    description: 'Collect the red-team experts\' objections from the transcript into review.json (viewpoints), then the Web review window becomes ready. Call this after the experts have spoken (roundtable_speak). Idempotent: already-collected utterances are skipped. Requires the captain.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          collected: { type: 'integer', required: true },
          split_attempts: { type: 'integer', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Review collected: ${value.collected} viewpoint(s) (${value.split_attempts} split attempt(s)), status ${value.status}.`,
      }],
    },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'collect review', async (fresh) => {
        const review = await readReview(stateRoot, fresh.id)
        if (review === undefined) throw new Error('no review in progress — call roundtable_start_review first')
        // 幂等键 = utteranceId 集合（观点拆分后 viewpoint.id 已变，不能用作去重）。
        const collectedUtteranceIds = new Set(review.viewpoints.map((viewpoint) => viewpoint.utteranceId))
        const utterances = await readTranscript(stateRoot, fresh.id)
        const llm = ctx.get('llm') as SplitLlmLike | undefined
        const splitConfig = config.reviewSplit
        let collected = 0
        let splitAttempts = 0
        for (const utterance of utterances) {
          if (utterance.nodeKey === CAPTAIN_KEY) continue
          if (utterance.kind !== 'speech' && utterance.kind !== 'proxy-thinking') continue
          if (utterance.ts < review.startedAt) continue
          if (collectedUtteranceIds.has(utterance.id)) continue
          const content = utterance.content.replace(/\s+/g, ' ').trim()
          if (content === '') continue // 空发言跳过
          // 观点拆分（三道防线）：LLM 优先，任何失败 → 本地启发式兜底（零 token）→ 仍失败则整条兜底（seq=0）。
          let lines: Awaited<ReturnType<typeof splitUtterance>> | null = null
          if (llm !== undefined && splitConfig !== undefined) {
            try {
              lines = await splitUtterance(llm, splitConfig, utterance.nodeKey, content)
              splitAttempts += 1
            } catch {
              lines = null
            }
          }
          if (lines === null) {
            // 无 LLM 或 LLM 拆分失败：按「观点 N（…）」段落结构本地切分，保证观点逐条可认定。
            try {
              lines = splitByMarkers(content)
            } catch {
              lines = null
            }
          }
          if (lines !== null && lines.length > 0) {
            lines.forEach((line, index) => {
              review.viewpoints.push({
                id: `${utterance.id}#${index + 1}`,
                utteranceId: utterance.id,
                nodeKey: utterance.nodeKey,
                content: line.content,
                status: 'pending',
                quote: line.quote,
                dimension: line.dimension,
                evidence: line.evidence,
                ts: utterance.ts,
                seq: index + 1,
              })
              collected += 1
            })
          } else {
            review.viewpoints.push({
              id: `${utterance.id}#0`,
              utteranceId: utterance.id,
              nodeKey: utterance.nodeKey,
              content,
              status: 'pending',
              dimension: '其他',
              ts: utterance.ts,
              seq: 0,
            })
            collected += 1
          }
        }
        if (collected > 0) review.status = 'ready'
        await writeReview(stateRoot, fresh.id, review)
        return { collected, split_attempts: splitAttempts, status: review.status }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_finish_review',
    description: 'Finish the current 针锋相对 review pass: marks it done (closed loop 闭环 can then start the next pass with roundtable_start_review). Records remaining endorsed (已认定) defects as the known-flaws checklist. Call this after the user finished endorsing/rejecting viewpoints and you have revised the plan (or decided to stop). Requires the captain.',
    parameters: {
      revised_plan_summary: { type: 'string', description: 'Optional one-line summary of how the endorsed defects were addressed in the revised plan (写入历史，供下一轮核对).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          review_pass: { type: 'integer', required: true },
          endorsed_count: { type: 'integer', required: true },
          can_review_again: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Review pass ${value.review_pass} finished (status ${value.status}, ${value.endorsed_count} endorsed defect(s)). ${value.can_review_again ? 'You may start the next re-review pass with roundtable_start_review.' : 'Re-review cap reached — export the record and present the consolidated result.'}`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'finish the review', async (fresh) => {
        const review = await readReview(stateRoot, fresh.id)
        if (review === undefined) throw new Error('no review in progress — call roundtable_start_review first')
        if (review.status === 'done') {
          return { status: review.status, review_pass: review.reviewPass, endorsed_count: countEndorsed(review), can_review_again: review.reviewPass < review.maxReviewPass }
        }
        if (review.status === 'reviewing') {
          throw new Error('review is still collecting viewpoints — call roundtable_collect_review before finishing')
        }
        review.status = 'done'
        review.finishedAt = Date.now()
        const summary = String(args.revised_plan_summary ?? '').trim()
        if (summary !== '') {
          // 本轮修订说明并入最后一条历史（无历史则新建），供下一轮"旧缺陷是否修复"核对。
          const last = review.history.length > 0 ? review.history[review.history.length - 1] : undefined
          if (last !== undefined && last.pass === review.reviewPass) {
            last.revisedPlanSummary = summary
          } else {
            review.history.push({
              pass: review.reviewPass,
              question: review.question,
              plan: review.plan,
              viewpoints: review.viewpoints,
              finishedAt: Date.now(),
              revisedPlanSummary: summary,
            })
          }
        }
        await writeReview(stateRoot, fresh.id, review)
        return {
          status: review.status,
          review_pass: review.reviewPass,
          endorsed_count: countEndorsed(review),
          can_review_again: review.reviewPass < review.maxReviewPass,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_export_review',
    description: 'Export the full 针锋相对 review record (all passes, viewpoints, endorsements, reject reasons, revision summaries) as a Markdown deliverable with a prefilled issue header (plugin version, mode, expert providers/models) — ready to paste into a GitHub issue or keep as a review record. Requires the captain.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          markdown: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.markdown }],
    },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'export the review', async (fresh) => {
        const review = await readReview(stateRoot, fresh.id)
        if (review === undefined) throw new Error('no review record yet — call roundtable_start_review first')
        return { markdown: renderReviewMarkdown(review, fresh) }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_export_meeting',
    description: 'Export the WHOLE meeting — issue-style header (plugin version, mode, time span, budget), goal, expert roster, the decision log, every round of the transcript with speaker → audience, the review record when one exists, and the user adjustment log — as a Markdown deliverable. Returns the Markdown AND writes it to <meetingDir>/export.md so the user can open the file directly. It works on an in-progress meeting too (the header then marks it as a snapshot). Requires the captain.',
    parameters: {
      save: { type: 'boolean', description: 'Also write the Markdown to <meetingDir>/export.md (default true). Pass false to only return the text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          markdown: { type: 'string', required: true },
          saved_to: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.saved_to === ''
          ? value.markdown
          : `${value.markdown}\n\n---\n（已同时写入 ${value.saved_to}，${value.bytes} 字节）`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'export the meeting', async (fresh) => {
        const utterances = await readTranscript(stateRoot, fresh.id)
        const { actions } = await readUserActionsReport(stateRoot, fresh.id)
        const review = await readReview(stateRoot, fresh.id)
        const markdown = renderMeetingMarkdown(fresh, utterances, actions, review)
        const bytes = Buffer.byteLength(markdown, 'utf8')
        if (args.save === false) return { markdown, saved_to: '', bytes }
        const file = join(meetingDirOf(stateRoot, fresh.id), 'export.md')
        await writeTextAtomic(file, markdown)
        return { markdown, saved_to: file, bytes }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_set_budget',
    description: 'Adjust the meeting budget. Top up max_rounds/max_tokens to unmute (闭麦后恢复) a muted meeting, or tighten them. Requires the captain.',
    parameters: {
      max_rounds: { type: 'integer', description: 'New round cap.' },
      max_tokens: { type: 'integer', description: 'New total token budget.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          max_rounds: { type: 'integer', required: true },
          max_tokens: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Budget updated: ${value.max_rounds} rounds / ${value.max_tokens} tokens (meeting status ${value.status}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'change the budget', async (fresh) => {
        if (typeof args.max_rounds === 'number') fresh.budget.maxRounds = Math.floor(args.max_rounds)
        if (typeof args.max_tokens === 'number') fresh.budget.maxTokens = Math.floor(args.max_tokens)
        if (fresh.status === 'muted') {
          if (fresh.round < fresh.budget.maxRounds && fresh.budget.usedTokens < fresh.budget.maxTokens) {
            fresh.status = 'active'
          }
        }
        await writeMeeting(stateRoot, fresh)
        return { status: fresh.status, max_rounds: fresh.budget.maxRounds, max_tokens: fresh.budget.maxTokens }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_list_presets',
    description: 'List the user\'s self-built role presets (设置 → 圆桌会议 → 角色预设）。读取实时，返回每条预设的 id / name / role / provider / model / reasoningEffort（思考强度；空 = 继承主持人）。用途：在你为会议挑选专家之前拿到**用户真正定义的**角色文本，而不是自己临场编一个 role。拿到后把某条的 role 原样传给 roundtable_add_node（或直接用 preset 参数引用；档位会随之自动生效，无需重复给 reasoning_effort）。返回空列表表示用户尚未建任何预设——此时不要假装有预设可用，改为自行写 role 并说明这是临时角色。',
    parameters: {
      filter: { type: 'string', description: '可选：按 id 或名称子串过滤；留空返回全部。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          shown: { type: 'integer', required: true },
          presets: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                role: { type: 'string', required: true },
                provider: { type: 'string', required: true },
                model: { type: 'string', required: true },
                reasoningEffort: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.total === 0) {
          return [{ type: 'text', text: 'No role presets defined yet (设置 → 圆桌会议 → 角色预设 is empty). Write the expert role yourself and say it is an ad-hoc role.' }]
        }
        const lines = value.presets.map((preset) => {
          const route = preset.provider === '' || preset.model === ''
            ? '（继承主持人路由）'
            : `${preset.provider}/${preset.model}`
          const effort = preset.reasoningEffort === '' ? '' : ` @${preset.reasoningEffort}`
          return `- ${preset.id} | ${preset.name} | ${route}${effort}\n  role: ${preset.role}`
        })
        return [{
          type: 'text',
          text: `${value.shown}/${value.total} role preset(s):\n${lines.join('\n')}`,
        }]
      },
    },
    async execute(args) {
      const presets = config.getRolePresets?.() ?? []
      const filter = typeof args.filter === 'string' ? args.filter.trim() : ''
      const matched = filter === ''
        ? presets
        : presets.filter((preset) => preset.id.includes(filter) || preset.name.includes(filter))
      return {
        total: presets.length,
        shown: matched.length,
        presets: matched.map((preset) => ({
          id: preset.id,
          name: preset.name,
          role: preset.role,
          provider: preset.provider ?? '',
          model: preset.model ?? '',
          reasoningEffort: preset.reasoningEffort ?? '',
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_close',
    description: 'End your meeting: interrupts all nodes (best effort) and marks the meeting ended. The record stays on disk for review.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'boolean', required: true },
          meeting_name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Meeting "${value.meeting_name}" closed.` }],
    },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      const nodes = await withCaptainLock(stateRoot, located.id, captain.id, 'close it', async (fresh) => {
        const roster = fresh.nodes.map((node) => ({ ...node }))
        for (const node of fresh.nodes) {
          if (node.status !== 'removed') node.status = 'removed'
        }
        fresh.status = 'ended'
        await writeMeeting(stateRoot, fresh)
        return roster
      })
      for (const node of nodes) {
        if (node.id !== '') interruptNode(ctx, captain, node.id)
      }
      return { closed: true, meeting_name: located.name }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_proxy_think',
    description: 'Proxy Thinking (代理思考): prepare to hand a task to a black-box worker model (no visible reasoning). Returns the director-side template you must fill in: write [DeepSeek 代理思考] reasoning, translate the task into exact worker parameters, and state expectations/fallbacks. Then deliver the translated parameters to the worker model.',
    parameters: {
      worker_model: { type: 'string', required: true, description: 'The black-box worker model (e.g. seedance, an image model).' },
      task: { type: 'string', required: true, description: 'The goal to translate for the worker model.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          template: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.template }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const located = await findMeetingByParticipant(stateRoot, caller.id)
      const workerModel = String(args.worker_model ?? '').trim()
      const task = String(args.task ?? '').trim()
      if (workerModel === '' || task === '') throw new Error('worker_model and task must not be empty')
      if (located !== undefined) {
        await withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
          const { meeting, identity } = await requireFreshParticipant(stateRoot, located.id, caller.id)
          const speaker = identity.kind === 'captain' ? CAPTAIN_KEY : identity.name
          await recordUtterance(stateRoot, meeting, {
            nodeKey: speaker,
            kind: 'proxy-thinking',
            content: `[代理思考 → ${workerModel}] ${task}`,
          })
        })
      }
      return { template: proxyThinkingPrompt(workerModel, task) }
    },
  }))
}

/** Render the status snapshot as compact text for the model. */
/** 知识库摘要缓存概览（C2）。
 *
 *  每条都用磁盘现状标注 valid：主持人据此决定"直接用摘要"还是"重读文件"，
 *  不必自己猜 mtime。条目上限 50、每条摘要上限 2000 字符（见 kb-digest.ts）。 */
async function kbDigestOverview(stateRoot: string, meetingId: string): Promise<{
  count: number
  valid_count: number
  entries: { path: string; size: number; mtime_ms: number; digest: string; valid: boolean; updated_at: string }[]
}> {
  const cache = await readKbDigest(stateRoot, meetingId)
  const evaluated = await evaluateKbDigests(cache.entries)
  return {
    count: evaluated.length,
    valid_count: evaluated.filter((entry) => entry.valid).length,
    entries: evaluated.map((entry) => ({
      path: entry.path,
      size: entry.size,
      mtime_ms: Math.round(entry.mtimeMs),
      digest: entry.digest,
      valid: entry.valid,
      updated_at: new Date(entry.ts).toISOString(),
    })),
  }
}

/** 状态行里最多列几条缓存、每条摘要最多显示多少字符（避免状态输出失控）。 */
const KB_DIGEST_RENDER_LIMIT = 10
const KB_DIGEST_RENDER_CHARS = 800

function renderStatus(value: Record<string, unknown>): string {
  const nodes = Array.isArray(value.nodes) ? value.nodes as Record<string, unknown>[] : []
  const edges = Array.isArray(value.edges) ? value.edges as Record<string, unknown>[] : []
  const budget = (value.budget ?? {}) as Record<string, unknown>
  const pending = Array.isArray(value.pending_decisions) ? value.pending_decisions as Record<string, unknown>[] : []
  const pendingActions = Array.isArray(value.pending_actions) ? value.pending_actions as Record<string, unknown>[] : []
  const recent = Array.isArray(value.recent_utterances) ? value.recent_utterances as Record<string, unknown>[] : []
  const kbDigest = (value.kb_digest ?? {}) as Record<string, unknown>
  const silence = (value.silence ?? {}) as Record<string, unknown>
  const emptyRounds = Array.isArray(silence.emptyRounds) ? silence.emptyRounds as number[] : []
  const silentSeats = Array.isArray(silence.silentSeats) ? silence.silentSeats as Record<string, unknown>[] : []
  const lateReplies = Array.isArray(silence.lateReplies) ? silence.lateReplies as Record<string, unknown>[] : []
  const kbEntries = Array.isArray(kbDigest.entries) ? kbDigest.entries as Record<string, unknown>[] : []
  const kbListed = kbEntries.slice(0, KB_DIGEST_RENDER_LIMIT)
  // R-D：候选池 + 本轮信号（缺省时按"没做分析/没定义预设"渲染，不静默）。
  const pool = (value.talent_pool ?? {}) as Record<string, unknown>
  const poolTotal = typeof pool.total === 'number' ? pool.total : 0
  const poolCandidates = Array.isArray(pool.candidates) ? pool.candidates as Record<string, unknown>[] : []
  const signals = (value.round_signals ?? {}) as Record<string, unknown>
  const waveRows = Array.isArray(signals.planned_waves) ? signals.planned_waves as unknown[][] : []
  const plannedWaveText = waveRows.length === 0
    ? '(none)'
    : waveRows.map((ids, index) => `[${Array.isArray(ids) ? ids.map(String).join(', ') : ''}]${index === waveRows.length - 1 ? '' : ' → '}`).join('')
  const undispatchedOwners = Array.isArray(signals.undispatched_owners) ? (signals.undispatched_owners as string[]) : []
  const plannedOwners = Array.isArray(signals.planned_owners) ? (signals.planned_owners as string[]) : []
  const unplannedDispatches = Array.isArray(signals.unplanned_dispatches) ? (signals.unplanned_dispatches as string[]) : []
  const pendingSeats = Array.isArray(signals.pending_seats) ? (signals.pending_seats as string[]) : []
  const outOfScope = (Array.isArray(signals.out_of_scope) ? signals.out_of_scope : []) as {
    from_seat: string
    item: string
    suggested_role: string
    round: number
  }[]
  // R-D：工作项粒度的漏派（席位口径抓不到"同席位多工作项漏了其中一个"）。
  const undispatchedItems = Array.isArray(signals.undispatched_items)
    ? (signals.undispatched_items as { id: string; owner: string; task: string }[])
    : []
  const trackedItems = typeof signals.tracked_items === 'number' ? signals.tracked_items : 0
  const untrackedItems = Array.isArray(signals.untracked_items)
    ? (signals.untracked_items as { id: string; owner: string; task: string }[])
    : []
  const lines: string[] = [
    `Meeting "${String(value.meeting_name)}" (id ${String(value.meeting_id)}, mode ${String(value.mode)}, status ${String(value.status)}, round ${String(value.round)})`,
    `Knowledge base path: ${String(value.kb_path ?? '') === '' ? '(none)' : String(value.kb_path)}`,
    `Budget: ${String(budget.used_rounds)}/${String(budget.max_rounds)} rounds, ${String(budget.used_tokens)}/${String(budget.max_tokens)} tokens (spoken-text estimate only — NOT the real LLM spend)`,
    `Nodes (${nodes.length}):`,
    ...nodes.map((node) => {
      const effort = String(node.reasoning_effort ?? '')
      return `  - ${String(node.key)} [${String(node.role ?? '')}] ${String(node.status)}/${String(node.activity ?? '')} · ${String(node.provider ?? '')}/${String(node.model ?? '')}${effort === '' ? '' : ` @${effort}`}`
    }),
    `Edges (${edges.length}):`,
    ...edges.map((edge) => `  - ${String(edge.from)} → ${String(edge.to)} (${String(edge.direction)})`),
    `Pending decisions: ${pending.length === 0 ? 'none' : pending.map((decision) => `"${String(decision.question)}"`).join('; ')}`,
    `Pending user actions (${pendingActions.length}): ${pendingActions.length === 0 ? 'none' : pendingActions.map((action) => `"${String(action.text)}"`).join('; ')}`,
    `KB digest cache: ${String(kbDigest.count ?? 0)} entry(ies), ${String(kbDigest.valid_count ?? 0)} still valid (HIT = reuse the digest; STALE = the file changed, read it again):`,
    ...kbListed.map((entry) => {
      const digest = String(entry.digest ?? '')
      const shown = digest.length > KB_DIGEST_RENDER_CHARS ? `${digest.slice(0, KB_DIGEST_RENDER_CHARS)}…` : digest
      return `  - [${entry.valid === true ? 'HIT' : 'STALE'}] ${String(entry.path)}: ${shown}`
    }),
    ...(kbEntries.length > kbListed.length ? [`  - …and ${kbEntries.length - kbListed.length} more cached entr(ies)`] : []),
    // 静默席判据（批次 A ②）：必须**渲染出来**，否则字段进了 JSON 但模型看不见 = 闸等于没接。
    `Silence gate: empty rounds ${emptyRounds.length} (threshold 0)${emptyRounds.length > 0 ? ` → [${emptyRounds.join(', ')}]` : ''}; silent seats ${silentSeats.length}; late replies ${lateReplies.length}`,
    ...(silentSeats.length === 0 ? [] : [
      `  ⚠ silent (dispatched, never spoke, not even later): ${silentSeats.map((s) => `R${String(s.round)}/${String(s.seat)}`).join(', ')} — re-dispatch once or record the gap; never pretend it was collected`,
    ]),
    ...(lateReplies.length === 0 ? [] : [
      `  (late, not a failure but must be recorded: ${lateReplies.map((s) => `R${String(s.round)}/${String(s.seat)}→R${String(s.repliedIn)}`).join(', ')})`,
    ]),
    // R-D ①：候选池必须**渲染出来**（同静默判据的教训：只进 JSON = 闸等于没接）。
    `Talent pool (${poolTotal} role preset(s); pull one mid-meeting with roundtable_add_node preset=<id>; role text via roundtable_list_presets filter=<kw>):`,
    ...(poolCandidates.length === 0
      ? [`  ${poolTotal === 0 && value.viewer !== CAPTAIN_KEY ? '(captain only)' : '(none defined — write the role yourself and say it is ad-hoc)'}`]
      : poolCandidates.map((candidate) => {
          const route = String(candidate.provider ?? '') === '' || String(candidate.model ?? '')
            ? '（继承主持人路由）'
            : `${String(candidate.provider)}/${String(candidate.model)}`
          const effort = String(candidate.reasoning_effort ?? '') === '' ? '' : ` @${String(candidate.reasoning_effort)}`
          return `  - ${String(candidate.id)} | ${String(candidate.name)} | ${route}${effort}${candidate.on_stage === true ? ' | ON STAGE' : ''}`
        })),
    `Round signals (R${String(signals.round ?? value.round)}):`,
    ...(signals.round === undefined ? ['  (captain only)'] : [
      `  dispatch plan: ${signals.plan_recorded === true ? 'recorded' : 'NOT recorded — no parallel/serial analysis for this round'}`,
      ...(signals.plan_recorded === true ? [
        `  planned waves (same wave = dispatch in parallel; later waves wait): ${plannedWaveText}`,
        // 席位侧分母**always render**：只在"有偏差时"打印，读的人就看不到比较基准，
        // 无法自行核对"这轮到底该派给谁"（`planned_owners` 曾被算出来却没渲染 ——
        // 字段进了 JSON、模型看不见，等于闸没接）。
        `  planned owners (seat level): ${plannedOwners.length === 0 ? '(none — every item is a new:<preset> gap)' : plannedOwners.join(', ')}`,
      ] : []),
      ...(undispatchedOwners.length === 0 && unplannedDispatches.length === 0 ? [] : [
        `  plan vs actual dispatches: ⚠ undispatched owners [${undispatchedOwners.join(', ')}]; unplanned dispatches [${unplannedDispatches.join(', ')}]`,
      ]),
      ...(signals.plan_recorded !== true ? [] : [
        `  plan vs actual work items (pass work_item= on roundtable_send_message to make this exact): tracked ${trackedItems}`
        + `${undispatchedItems.length === 0 ? '' : `, ⚠ ${undispatchedItems.length} never dispatched (no tag AND the owning seat got nothing this round)`}`
        + `${untrackedItems.length === 0 ? '' : `, ${untrackedItems.length} untracked (seat was dispatched but the message carried no work_item — unverifiable, NOT a failure)`}`,
      ]),
      ...(undispatchedItems.length === 0 ? [] : [
        `    ⚠ never dispatched: ${undispatchedItems.map((entry) => `${entry.id} → ${entry.owner}`).join('; ')}`,
      ]),
      ...(untrackedItems.length === 0 ? [] : [
        `    untracked: ${untrackedItems.map((entry) => `${entry.id} → ${entry.owner}`).join('; ')} (tag work_item= next time to make it checkable)`,
      ]),
      ...(pendingSeats.length === 0 ? [] : [
        `  pending seats (no utterance yet this round): ${pendingSeats.join(', ')}`,
      ]),
      `  out-of-scope handoffs [越界转派] (${String(signals.out_of_scope_total ?? 0)} total — these are the "this needs a different seat" signals; pull that preset or fold it into the summary):`,
      formatHandoffRows(outOfScope),
      ...(typeof signals.out_of_scope_hidden === 'number' && signals.out_of_scope_hidden > 0
        ? [`  (…and ${signals.out_of_scope_hidden} older hidden)`]
        : []),
    ]),
    `Recent transcript:`,
    ...recent.map((utterance) => `  [R${String(utterance.round)}] ${String(utterance.speaker)}${String(utterance.to ?? '') === '' ? '' : ` → ${String(utterance.to)}`}: ${String(utterance.content)}`),
  ]
  return lines.join('\n')
}

/** Count endorsed (已认定) viewpoints in the current pass. */
function countEndorsed(review: ReviewRecord): number {
  return review.viewpoints.filter((viewpoint) => viewpoint.status === 'endorsed').length
}

/** One-line viewpoint marker inside the exported markdown. */
function viewpointStatusLabel(status: string): string {
  if (status === 'endorsed') return '✅ 已认定'
  if (status === 'rejected') return '❌ 已驳回'
  return '⬜ 未表态'
}

/** Evidence line inside the exported markdown. */
function evidenceLine(evidence: { kind: string; text: string } | undefined): string {
  if (evidence === undefined) return ''
  const label = evidence.kind === 'repro' ? '证据（可复现步骤）' : '证据（论证链）'
  return `\n  - **${label}**：${evidence.text}`
}

/** Render the full review record as a Markdown deliverable (C5/E2).
 *  The header carries prefilled issue metadata: plugin version, meeting mode,
 *  expert providers/models and budget usage — ready to paste into a
 *  GitHub issue. */
function renderReviewMarkdown(review: ReviewRecord, meeting: Meeting): string {
  const out: string[] = []
  out.push('# 针锋相对评审记录', '')
  out.push('---')
  out.push('<!-- 以下为预填的 issue 元数据，可整段作为 GitHub issue 模板 -->')
  out.push(`- **插件**：${PLUGIN_ID}（${HARNESS_RANGE}）`)
  out.push(`- **协作模式**：${meeting.mode}`)
  const expertRoutes = meeting.nodes
    .filter((node) => node.status !== 'removed')
    .map((node) => `${node.key}（${node.provider ?? '-'}/${node.model ?? '-'}）`)
  out.push(`- **专家**：${expertRoutes.length === 0 ? '-' : expertRoutes.join('、')}`)
  out.push(`- **预算用量**：${meeting.budget.usedRounds}/${meeting.budget.maxRounds} 轮 · ${meeting.budget.usedTokens}/${meeting.budget.maxTokens} token`)
  out.push('---', '')
  out.push(renderReviewBody(review))
  return out.join('\n')
}

/** 评审主体（不含 issue 头部）：整场会议导出复用它，避免头部重复。 */
function renderReviewBody(review: ReviewRecord): string {
  const out: string[] = []
  out.push(`## 评审轮次 ${review.reviewPass}/${review.maxReviewPass} · ${review.status === 'done' ? '已完成' : review.status === 'ready' ? '待表态' : '收集中'}`)
  out.push('', '## 原始问题', '', review.question, '', '## 本轮方案（待攻击对象）', '', review.plan, '')
  const endorsed = review.viewpoints.filter((viewpoint) => viewpoint.status === 'endorsed')
  const rejected = review.viewpoints.filter((viewpoint) => viewpoint.status === 'rejected')
  const pending = review.viewpoints.filter((viewpoint) => viewpoint.status === 'pending')
  out.push(`## 本轮观点（${review.viewpoints.length} 条：已认定 ${endorsed.length} / 已驳回 ${rejected.length} / 未表态 ${pending.length}）`, '')
  if (review.viewpoints.length === 0) {
    out.push('（暂无观点）')
  }
  for (const viewpoint of review.viewpoints) {
    out.push(
      `- **[${viewpointStatusLabel(viewpoint.status)}]** 观点 ${viewpoint.seq}（${viewpoint.dimension}，来自 ${viewpoint.nodeKey}）`,
      '',
      `  ${viewpoint.content}`,
      evidenceLine(viewpoint.evidence),
    )
    if (viewpoint.quote !== undefined) out.push(`\n  > 原文引用：${viewpoint.quote}`)
    if (viewpoint.status === 'rejected' && viewpoint.rejectReason !== undefined) {
      out.push(`\n  - **驳回理由**：${viewpoint.rejectReason}`)
    }
    out.push('')
  }
  if (review.history !== undefined && review.history.length > 0) {
    out.push('---', '', '## 历史轮次（闭环复审对照）', '')
    for (const pass of review.history) {
      out.push(`### 第 ${pass.pass} 轮`, '', `- 问题：${pass.question}`, `- 方案：${pass.plan}`)
      if (pass.revisedPlanSummary !== undefined) out.push(`- 修订说明：${pass.revisedPlanSummary}`)
      const endorsedInPass = pass.viewpoints.filter((viewpoint) => viewpoint.status === 'endorsed')
      if (endorsedInPass.length > 0) {
        out.push('- 该轮已认定缺陷：')
        for (const viewpoint of endorsedInPass) out.push(`  - ${viewpoint.content}`)
      }
      out.push('')
    }
  }
  return out.join('\n')
}

/** 单条发言在导出里的字符上限（超出截断并标注，避免导出物失控）。 */
const EXPORT_UTTERANCE_CHARS = 4000

/** 本地时区的可读时间戳（导出物是给人看的，不用 UTC）。 */
function formatStamp(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 把一场会议整体渲染成 Markdown 交付物（B6）。
 *
 * 只读既有磁盘状态（`meeting.json` / `transcript.jsonl` / `review.json` /
 * `user-actions.jsonl`），**不新增任何状态**；会议进行中也能导出，此时头部
 * 会标注"进行中快照"，避免把半场会议误当成结论。
 */
export function renderMeetingMarkdown(
  meeting: Meeting,
  utterances: readonly MeetingUtterance[],
  userActions: readonly UserAction[],
  review: ReviewRecord | undefined,
): string {
  const out: string[] = []
  const running = meeting.status !== 'ended'
  out.push(`# 圆桌会议记录 · ${meeting.name}`, '')
  out.push('---')
  out.push('<!-- 以下为预填的会议元数据，可整段作为 issue / 归档记录的头部 -->')
  out.push(`- **插件**：${PLUGIN_ID}（${HARNESS_RANGE}）`)
  out.push(`- **会议 id**：${meeting.id}`)
  out.push(`- **协作模式**：${meeting.mode}`)
  out.push(`- **状态**：${meeting.status}${running ? '（进行中快照）' : ''}`)
  out.push(`- **创建时间**：${formatStamp(meeting.createdAt)}`)
  out.push(`- **${running ? '最后更新' : '结束时间'}**：${formatStamp(meeting.updatedAt)}`)
  out.push(`- **预算用量**：${meeting.budget.usedRounds}/${meeting.budget.maxRounds} 轮 · ${meeting.budget.usedTokens}/${meeting.budget.maxTokens} token`)
  if ((meeting.kbPath ?? '') !== '') out.push(`- **知识库**：${meeting.kbPath}`)
  if ((meeting.skills ?? []).length > 0) {
    out.push(`- **skill**：${(meeting.skills ?? []).map((skill) => `\`${skill}\``).join('、')}（传递方式 ${meeting.skillDelivery ?? 'relay'}）`)
  }
  out.push('---', '')

  out.push('## 议题 / 目标', '', meeting.goal.trim() === '' ? '（未提供）' : meeting.goal.trim(), '')

  out.push(`## 专家名单（${meeting.nodes.length}）`, '')
  // 静默标记（批次 B ②）：名单行内标出"派了但没回"的席位，
  // 否则导出物看起来一切正常，整席丢失无从察觉。
  const silenceForRoster = analyzeSilence(
    { status: meeting.status, round: meeting.round, nodes: meeting.nodes },
    utterances,
  )
  if (meeting.nodes.length === 0) out.push('（无）')
  for (const node of meeting.nodes) {
    const route = `${node.provider ?? '（继承主持人）'}/${node.model ?? '（继承主持人）'}`
    const effort = (node.reasoningEffort ?? '') === '' ? '' : ` @${node.reasoningEffort}`
    const role = (node.role ?? '') === '' ? '（未填角色）' : node.role
    const origin = (node.presetId ?? '') === '' ? '（临时角色）' : `（预设 \`${node.presetId}\`）`
    out.push(`- \`${node.key}\` — ${role} ${origin} — ${route}${effort} — 状态 ${node.status}${silenceMarkFor(silenceForRoster, node.key)}`)
  }
  const silenceLine = silenceSummaryLine(silenceForRoster)
  if (silenceLine !== '') out.push('', `> **静默判据**：${silenceLine}`)
  out.push('')

  // R-D：调度计划是"主持人做过并行/串行分析"的唯一机检证据，导出物必须带上，
  // 否则一份"一把抓全下发"的会议记录看起来与逐波派发完全一样。
  const plans = meeting.roundPlans ?? []
  const dispatchedRounds = [...new Set(
    utterances
      .filter((utterance) => utterance.nodeKey === CAPTAIN_KEY && (utterance.to ?? '') !== '')
      .map((utterance) => utterance.round),
  )].sort((a, b) => a - b)
  const plannedRounds = new Set(plans.map((plan) => plan.round))
  const unplanned = dispatchedRounds.filter((round) => !plannedRounds.has(round))
  out.push(`## 调度计划（${plans.length} 轮已记录）`, '')
  out.push('> 同波内的项**无相互依赖**（可并发下发）；后面的波等前面的波完成。')
  out.push('')
  if (plans.length === 0) out.push('（未记录任何调度计划）')
  for (const plan of [...plans].sort((a, b) => a.round - b.round)) {
    out.push(`### 第 ${plan.round} 轮${plan.note === undefined || plan.note === '' ? '' : ` · ${plan.note}`}`, '')
    for (const wave of planWaves(plan.items)) {
      out.push(`- **wave ${wave.wave}**${wave.wave === 1 ? '（立刻并发下发）' : `（等 wave ${wave.wave - 1}）`}`)
      for (const item of wave.items) {
        const owner = item.owner.startsWith('new:')
          ? `新拉预设 \`${item.owner.slice(4)}\``
          : `\`${item.owner}\``
        out.push(`  - \`${item.id}\` → ${owner}：${item.task}`)
      }
    }
    out.push('')
  }
  if (unplanned.length > 0) {
    out.push(`> ⚠ **未记录调度计划的已派发轮次**：${unplanned.map((round) => `R${round}`).join('、')}（这些轮次的并行/串行取舍无机器凭据）`, '')
  }
  out.push('')

  out.push(`## 决策记录（${meeting.decisions.length}）`, '')
  if (meeting.decisions.length === 0) out.push('（无）')
  for (const decision of meeting.decisions) {
    out.push(`- **[${decision.status === 'resolved' ? '已决' : '待决'}]** ${decision.question}`)
    out.push(`  - 选项：${decision.options.length === 0 ? '（无）' : decision.options.join(' / ')}`)
    if (decision.chosen !== undefined) out.push(`  - 用户选择：${decision.chosen}`)
    if (decision.customAnswer !== undefined) out.push(`  - 自定义答案：${decision.customAnswer}`)
    out.push(`  - 时间：${formatStamp(decision.ts)}`)
  }
  out.push('')

  // 发言按轮次分组；同一轮内保持写入顺序（读取顺序即发言顺序）。
  out.push(`## 发言记录（${utterances.length} 条）`, '')
  if (utterances.length === 0) {
    out.push('（无）', '')
  } else {
    const rounds = [...new Set(utterances.map((utterance) => utterance.round))].sort((a, b) => a - b)
    for (const round of rounds) {
      out.push(`### 第 ${round} 轮`, '')
      for (const utterance of utterances.filter((candidate) => candidate.round === round)) {
        const audience = (utterance.to ?? '') === '' ? '汇聚网关' : utterance.to
        const kind = utterance.kind === 'speech' ? '' : ` · ${utterance.kind}`
        out.push(`**${utterance.nodeKey} → ${audience}** · ${formatStamp(utterance.ts)}${kind}`)
        const shown = utterance.content.length > EXPORT_UTTERANCE_CHARS
          ? `${utterance.content.slice(0, EXPORT_UTTERANCE_CHARS)}\n\n…（已截断，原长 ${utterance.content.length} 字符）`
          : utterance.content
        out.push('', shown, '')
      }
    }
  }

  if (review !== undefined) {
    out.push('---', '', '# 针锋相对评审记录', '', renderReviewBody(review), '')
  }

  out.push('---', '', `## 用户调整记录（${userActions.length}）`, '')
  out.push('> 只包含尚未被主持人清空的记录；已执行并清空的调整不会出现在导出里。', '')
  if (userActions.length === 0) out.push('（无）')
  for (const action of userActions) {
    const key = (action.nodeKey ?? '') === '' ? '' : ` · ${action.nodeKey}`
    out.push(`- ${formatStamp(action.ts)} · ${action.kind}${key}：${action.text}`)
  }
  out.push('')
  return out.join('\n')
}
