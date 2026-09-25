/**
 * Web snapshot collection: reads the disk truth under every workspace's
 * state root and merges live node activity. The browser topology tab polls
 * `/plugins/dsh-plugin-roundtable/state` for this.
 * @module dsh-plugin-roundtable/snapshot
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { listMeetings, readMeeting, readReview, readTranscript, readUserActions } from './state.ts'
import { aggregateUtterances } from './aggregator.ts'
import { ACTIVE_NODE_STATUSES, AGGREGATOR_KEY, CAPTAIN_KEY } from './types.ts'
import type { Meeting, MeetingNode, MeetingUtterance, UserAction } from './types.ts'
import { isDeliverable } from './visibility.ts'
import { analyzeSilence, silenceSummaryLine } from './silence.ts'
import {
  buildRoundSignals,
  dispatchableSeatKeys,
  onStagePresetEntries,
  onStagePresetMap,
  presetLinkedSeatIds,
  validateRoundPlan,
  type PlanReport,
} from './dispatch.ts'

/** 角色预设读取面（与 tools.ts 的 `getRolePresets` 同一个来源，由调用方注入）。 */
export interface SnapshotRolePreset {
  id: string
  name: string
  role: string
  provider?: string
  model?: string
}

/** `collectMeetingSnapshots` 的可选依赖（缺省 = 无预设，不影响其它字段）。 */
export interface SnapshotOptions {
  /** 实时读取用户自建角色预设。 */
  getRolePresets?: () => readonly SnapshotRolePreset[]
}

/**
 * 由本轮计划算出**波次**与**缺口**（复用 dispatch.ts 的校验器，不另写一套波次算法）。
 *
 * 计划是落账数据，理论上都合法；但它可能是**旧版本**写的、或被手工改坏 ——
 * 校验失败时返回 null，UI 显示"计划不可解析"，绝不静默画一张假的波次图。
 */
function planView(meeting: Meeting, presets: readonly SnapshotRolePreset[]): {
  waves: PlanReport['waves']
  gaps: { item: string; presetId: string; presetName: string; onStage: boolean }[]
} | null {
  const plan = (meeting.roundPlans ?? []).find((candidate) => candidate.round === meeting.round)
  if (plan === undefined) return null
  const report = validateRoundPlan(plan.items, {
    rosterKeys: dispatchableSeatKeys(meeting.nodes),
    presets: presets.map((preset) => ({ id: preset.id, name: preset.name, role: preset.role })),
    onStagePresetIds: presetLinkedSeatIds(meeting.nodes),
  })
  if (!report.ok) return null
  return {
    waves: report.report.waves,
    gaps: report.report.gaps.map((gap) => ({
      item: gap.item,
      presetId: gap.presetId,
      presetName: gap.presetName,
      onStage: gap.onStage,
    })),
  }
}

/** 骨架虚线边的 id 前缀（host 侧唯一来源；客户端只读 `implicit` 字段）。 */
const SYNTHETIC_EDGE_PREFIX = 'synthetic:'

/** 按 key 去重节点列表：同名 key 多次加入（删了重建）时保留最新一条，
 *  且非 removed 优先。返回顺序 = meeting.nodes 首次出现顺序。 */
function dedupeNodesByKey(nodes: MeetingNode[]): MeetingNode[] {
  const byKey = new Map<string, MeetingNode>()
  for (const node of nodes) {
    const prev = byKey.get(node.key)
    if (prev === undefined) {
      byKey.set(node.key, node)
      continue
    }
    const prevActive = prev.status !== 'removed'
    const nodeActive = node.status !== 'removed'
    if (nodeActive !== prevActive) {
      if (nodeActive) byKey.set(node.key, node)
      continue
    }
    if ((node.joinedAt ?? 0) >= (prev.joinedAt ?? 0)) byKey.set(node.key, node)
  }
  return [...byKey.values()]
}

/** One meeting snapshot for the Web UI. */
export interface MeetingSnapshot {
  id: string
  name: string
  goal: string
  mode: string
  status: string
  round: number
  workspace: string
  /** 主持（创建）该会议的会话 id —— 用于"来源对话"前缀与互通过滤。 */
  captainSessionId: string
  /** 知识库目录（阅览版）；空 = 未设置。 */
  kbPath: string
  /** R2：本次会议选中的 skill 名称清单；空 = 未选。 */
  skills: string[]
  /** R2.2/D5：skill 传递方式（relay / direct）。 */
  skillDelivery: string
  budget: {
    maxRounds: number
    maxTokens: number
    usedRounds: number
    usedTokens: number
  }
  nodes: {
    id: string
    key: string
    role: string
    provider: string
    model: string
    /** 该席的思考强度（宿主档位 id；空 = 继承主持人）。缺失 = 旧快照。 */
    reasoningEffort?: string
    /** 该席由哪条用户预设拉起（空 = 临时写的角色）。
     *  用途：UI 拿它反查预设的**头像与职能名** —— 会议节点本身只有 role 文本，
     *  没有预设的展示信息。缺失 = 旧快照。 */
    presetId?: string
    status: string
    activity: string
  }[]
  edges: {
    id: string
    from: string
    to: string
    direction: string
    /** 骨架虚线边（非用户拉的真实边）—— 由 host 判定，客户端不得再解析 id 前缀。 */
    implicit: boolean
    /** 该通道能否真的投递（host 侧唯一判定；单线制下专家↔专家为 false）。 */
    deliverable: boolean
  }[]
  pendingDecisions: {
    id: string
    question: string
    options: string[]
  }[]
  /** Pending user actions recorded by the Web UI, awaiting the captain. */
  pendingActions: {
    id: string
    kind: string
    nodeKey: string
    role: string
    provider: string
    model: string
    /** 思考强度（空 = 继承主持人）。 */
    reasoningEffort: string
    text: string
  }[]
  /** 针锋相对评审（无则 null）。 */
  review: {
    status: string
    reviewPass: number
    maxReviewPass: number
    question: string
    plan: string
    viewpoints: {
      id: string
      nodeKey: string
      content: string
      endorsed: boolean
    }[]
  } | null
  digest: string
  /**
   * R-D-UI：本轮调度计划（波次 + 未派项）与专家候选池 —— 拓扑页的「调度」面板数据源。
   *
   * 判据口径与 `roundtable_status.round_signals` **同源**（都走 `dispatch.ts` 的
   * 纯函数），避免"工具说一套、UI 画一套"的两个判定者。
   * 圆桌制（egalitarian）下 `outOfScope` 恒空（该协议是单线制专属，见 dispatch.ts）。
   */
  plan: {
    /** 本轮是否有计划（false = 没做并行/串行分析，UI 必须显示出来而不是留白）。 */
    recorded: boolean
    /** 本轮计划说明（next_round 的 note）。 */
    note: string
    /**
     * 落账的计划**能否解析**（校验失败说明它是旧版本写的或被手工改坏）。
     * `waves` 为空且 `parsable === false` 时 UI 必须显示"不可解析"，
     * 绝不能画一张空波次图让人以为"本轮没任务"。
     */
    parsable: boolean
    /** 同波内的项**无相互依赖**（可并发下发）。 */
    waves: { wave: number; items: { id: string; task: string; owner: string }[] }[]
    /** 计划点名、但本轮没有任何定向派发的在场席。 */
    undispatchedOwners: string[]
    /** 本轮收到定向派发、但不在计划承接席里的席。 */
    unplannedDispatches: string[]
    /** 需要新拉席位的项（`new:<预设>`；`onStage` = 该预设其实已在场）。 */
    gaps: { item: string; presetId: string; presetName: string; onStage: boolean }[]
    /** 专家用 [越界转派] 交给主持人的"该换人"事项（单线制专属）。 */
    outOfScope: { fromSeat: string; item: string; suggestedRole: string; round: number }[]
  }
  /**
   * R-D-UI：**本会议**的候选池在场标记（预设清单本身是全局的，客户端已从
   * `prefs.get` 的 `rolePresets` 拿到，故此处**只下发每会议独有的部分**）。
   *
   * 理由：快照是 1Hz 轮询、实测 16 会议 301 KB；把 28 条预设正文按会议重复
   * 下发是纯浪费。`total` 仍然给，便于 UI 发现"预设清单读到了 0 条"这种异常。
   */
  talentPool: {
    total: number
    onStage: { presetId: string; nodeKeys: string[] }[]
  }
  messages: {
    id: string
    from: string
    to: string
    ts: number
  }[]
  recent: {
    id: string
    from: string
    to: string
    text: string
    ts: number
    round: number
  }[]
}

/** Orchestrated meetings show an implicit star topology even before the
 * captain wires explicit edges: captain ⇄ each node, each node → aggregator.
 *
 * Real edges (the ones the user drags) are always included AND the synthetic
 * skeleton is kept as a faded backdrop for any pair not explicitly wired, so
 * dragging a new channel never makes the whole topology jump/vanish — the
 * user sees their wire land on top of a stable skeleton instead of the
 * skeleton disappearing the moment they add one edge.
 */
function synthesizedEdges(meeting: Meeting): MeetingSnapshot['edges'] {
  // 已移除的专家从拓扑彻底消失：其真实连线也不再返回（前端拓扑不渲染 removed 节点）。
  const removedKeys = new Set(meeting.nodes.filter((node) => node.status === 'removed').map((node) => node.key))
  // 归口：`implicit`（骨架边）与 `deliverable`（能否真投递）都在 host 侧算好，
  // 客户端零策略 —— 否则它要复制一份 recipientPolicy，就是"同一事实两个判定者"。
  const decorate = (id: string, from: string, to: string, direction: 'forward' | 'bidirectional'): MeetingSnapshot['edges'][number] => ({
    id,
    from,
    to,
    direction,
    implicit: id.startsWith(SYNTHETIC_EDGE_PREFIX),
    deliverable: isDeliverable(meeting.mode, from, to),
  })
  const real = meeting.edges
    .filter((edge) => !removedKeys.has(edge.from) && !removedKeys.has(edge.to))
    .map((edge) => decorate(edge.id, edge.from, edge.to, edge.direction))
  if (meeting.mode === 'egalitarian') return real
  const covered = new Set(real.flatMap((edge) => [`${edge.from}→${edge.to}`, `${edge.to}→${edge.from}`]))
  const out: MeetingSnapshot['edges'] = [...real]
  for (const node of meeting.nodes) {
    if (node.status === 'removed') continue
    if (!covered.has(`${CAPTAIN_KEY}→${node.key}`)) {
      out.push(decorate(`${SYNTHETIC_EDGE_PREFIX}${CAPTAIN_KEY}:${node.key}`, CAPTAIN_KEY, node.key, 'bidirectional'))
    }
    if (!covered.has(`${node.key}→${AGGREGATOR_KEY}`)) {
      out.push(decorate(`${SYNTHETIC_EDGE_PREFIX}${node.key}:${AGGREGATOR_KEY}`, node.key, AGGREGATOR_KEY, 'forward'))
    }
  }
  return out
}

/** Recent directed message pulses for the flow animation (newest first). */
function recentDirectedMessages(utterances: readonly MeetingUtterance[]): MeetingSnapshot['messages'] {
  const out: MeetingSnapshot['messages'] = []
  for (let i = utterances.length - 1; i >= 0 && out.length < 8; i--) {
    const utterance = utterances[i]
    if (utterance === undefined) continue
    if (utterance.kind !== 'speech' && utterance.kind !== 'proxy-thinking') continue
    out.push({
      id: utterance.id,
      from: utterance.nodeKey,
      to: utterance.to ?? AGGREGATOR_KEY,
      ts: utterance.ts,
    })
  }
  return out
}

/** One-line compaction for the sidebar timeline. */
function compactText(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > limit ? `${single.slice(0, limit)}…` : single
}

/** Recent contributions for the sidebar activity log (newest first). */
function recentUtterances(utterances: readonly MeetingUtterance[]): MeetingSnapshot['recent'] {
  const out: MeetingSnapshot['recent'] = []
  for (let i = utterances.length - 1; i >= 0 && out.length < 20; i--) {
    const utterance = utterances[i]
    if (utterance === undefined) continue
    if (utterance.kind !== 'speech' && utterance.kind !== 'proxy-thinking') continue
    out.push({
      id: utterance.id,
      from: utterance.nodeKey,
      to: utterance.to ?? AGGREGATOR_KEY,
      text: compactText(utterance.summary ?? utterance.content, 90),
      ts: utterance.ts,
      round: utterance.round,
    })
  }
  return out
}

/** Collect snapshots across state roots, optionally filtered by captain session. */
export async function collectMeetingSnapshots(
  ctx: Context,
  roots: readonly { workspace: string; stateRoot: string }[],
  sessionFilter?: string,
  options: SnapshotOptions = {},
): Promise<MeetingSnapshot[]> {
  // 预设库每轮只读一次（不是每个会议读一次）：它来自设置页，与会议无关。
  const presets = options.getRolePresets?.() ?? []
  const wireAction = (action: UserAction): MeetingSnapshot['pendingActions'][number] => ({
    id: action.id,
    kind: action.kind,
    nodeKey: action.nodeKey ?? '',
    role: action.role ?? '',
    provider: action.provider ?? '',
    model: action.model ?? '',
    reasoningEffort: action.reasoningEffort ?? '',
    text: action.text,
  })
  const snapshots: MeetingSnapshot[] = []
  for (const root of roots) {
    for (const meetingId of await listMeetings(root.stateRoot)) {
      const meeting = await readMeeting(root.stateRoot, meetingId)
      if (meeting === undefined) continue
      if (sessionFilter !== undefined && meeting.captainSessionId !== sessionFilter) continue
      const utterances = await readTranscript(root.stateRoot, meetingId)
      const userActions = await readUserActions(root.stateRoot, meetingId)
      const review = await readReview(root.stateRoot, meetingId)
      // 在场席集合：plan 与 talentPool 两处共用同一份，避免各自计算漂移。
      const onStageEntries = onStagePresetEntries(meeting.nodes)
      snapshots.push({
        id: meeting.id,
        name: meeting.name,
        goal: meeting.goal,
        mode: meeting.mode,
        status: meeting.status,
        round: meeting.round,
        workspace: root.workspace,
        captainSessionId: meeting.captainSessionId,
        kbPath: meeting.kbPath ?? '',
        skills: meeting.skills ?? [],
        skillDelivery: meeting.skillDelivery ?? 'relay',
        budget: {
          maxRounds: meeting.budget.maxRounds,
          maxTokens: meeting.budget.maxTokens,
          usedRounds: meeting.budget.usedRounds,
          usedTokens: meeting.budget.usedTokens,
        },
        // 每个 key 只保留一条有效节点（删了重建 / 同名 key 多实例时取最新，
        // 非 removed 优先）。这样拓扑图与专家列表不会出现同一专家多条（避免
        // kimi+deepseek 同名残留）。removed 节点仍输出（status='removed'），
        // 由前端负责「拓扑图隐藏、专家列表置底」。
        nodes: dedupeNodesByKey(meeting.nodes).map((node) => {
          let activity = 'unspawned'
          if (node.status === 'removed') {
            activity = 'removed'
          } else if (node.id !== '' && ACTIVE_NODE_STATUSES.includes(node.status)) {
            const live = ctx.agents.get(node.id as SessionId)
            activity = live === undefined ? 'ready' : live.status
          }
          return {
            id: node.id,
            key: node.key,
            role: node.role ?? '',
            provider: node.provider ?? '',
            model: node.model ?? '',
            ...(node.reasoningEffort === undefined || node.reasoningEffort === '' ? {} : { reasoningEffort: node.reasoningEffort }),
            ...(node.presetId === undefined || node.presetId === '' ? {} : { presetId: node.presetId }),
            status: node.status,
            activity,
          }
        }),
        edges: synthesizedEdges(meeting),
        pendingDecisions: meeting.decisions
          .filter((decision) => decision.status === 'pending')
          .map((decision) => ({ id: decision.id, question: decision.question, options: decision.options })),
        pendingActions: userActions.map(wireAction),
        review: review === undefined ? null : {
          status: review.status,
          reviewPass: review.reviewPass ?? 1,
          maxReviewPass: review.maxReviewPass ?? 3,
          question: review.question,
          plan: review.plan,
          viewpoints: review.viewpoints.map((viewpoint) => ({
            id: viewpoint.id,
            utteranceId: viewpoint.utteranceId,
            nodeKey: viewpoint.nodeKey,
            content: viewpoint.content,
            status: viewpoint.status,
            // 兼容派生：旧前端仍可读 endorsed。
            endorsed: viewpoint.status === 'endorsed',
            rejected: viewpoint.status === 'rejected',
            rejectReason: viewpoint.rejectReason,
            evidence: viewpoint.evidence,
            quote: viewpoint.quote,
            dimension: viewpoint.dimension,
            seq: viewpoint.seq,
          })),
        },
        digest: (() => {
          // 静默标记（批次 B ②）：UI 的网关摘要也带上"谁派了没回"，
          // 与 tools.ts 的 roundtable_summarize 同一口径。
          const line = silenceSummaryLine(analyzeSilence(
            { status: meeting.status, round: meeting.round, nodes: meeting.nodes },
            utterances,
          ))
          const base = aggregateUtterances(utterances)
          return line === '' ? base : `${base}\n\n[静默判据] ${line}`
        })(),
        messages: recentDirectedMessages(utterances),
        recent: recentUtterances(utterances),
        // R-D-UI：调度面板数据源。判据走 dispatch.ts 纯函数，与 status 同源。
        // 在场席集合**算一次**即可（plan 与 talentPool 共用），避免两处各算一遍漂移。
        plan: (() => {
          const plan = (meeting.roundPlans ?? []).find((candidate) => candidate.round === meeting.round)
          const view = planView(meeting, presets)
          const signals = buildRoundSignals({
            round: meeting.round,
            mode: meeting.mode,
            plan,
            liveSeatKeys: dispatchableSeatKeys(meeting.nodes),
            utterances,
            // 必填（曾经漏传 → 同一会议两个答案）。走唯一装配入口，与 tools.ts 同源。
            onStageByPreset: onStagePresetMap(onStageEntries),
          })
          return {
            recorded: plan !== undefined,
            note: plan?.note ?? '',
            parsable: plan === undefined || view !== null,
            waves: view?.waves ?? [],
            undispatchedOwners: signals.undispatched_owners,
            unplannedDispatches: signals.unplanned_dispatches,
            gaps: view?.gaps ?? [],
            outOfScope: signals.out_of_scope.map((row) => ({
              fromSeat: row.from_seat,
              item: row.item,
              suggestedRole: row.suggested_role,
              round: row.round,
            })),
          }
        })(),
        talentPool: {
          total: presets.length,
          onStage: onStageEntries.map((entry) => ({
            presetId: entry.preset_id,
            nodeKeys: entry.node_keys,
          })),
        },
      })
    }
  }
  return snapshots
}