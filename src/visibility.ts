/**
 * 会议可见性（三模式语义）：纯函数、无 IO、无状态 —— 便于单测，也避免
 * "提示词说了 A、工具做了 B" 的两种真相。
 *
 * 语义（由用户定稿，2026-09-19）：
 *  - **单线制**（orchestrated / redteam）：专家**不掌握其他席位**。主持人转达是
 *    唯一信息来源，故专家读到的会议快照里不得出现他人条目（节点/连线/他人发言/
 *    与他人相关的用户动作）。
 *  - **圆桌制**（egalitarian）：专家知道全部席位并可直连，快照全量。
 *  - 主持人（captain）在任何模式下都看全量 —— 它是唯一的信息枢纽。
 *
 * 另含收件人策略：广播 `to="all"` 仅圆桌制允许；单线制下节点只能发给主持人。
 *
 * @module dsh-plugin-roundtable/visibility
 */

import type { MeetingMode } from './types.ts'
import { AGGREGATOR_KEY, CAPTAIN_KEY } from './types.ts'

/** 快照里的节点行（`roundtable_status` 输出形状）。 */
export interface VisibilityNode {
  key: string
}

/** 快照里的连线行。 */
export interface VisibilityEdge {
  from: string
  to: string
}

/** 快照里的发言行（工具输出用 `speaker` 表示发言者 key）。 */
export interface VisibilityUtterance {
  speaker: string
  to?: string
}

/** 快照里的待办用户动作（工具输出为 snake_case，原始状态为 camelCase）。 */
export interface VisibilityAction {
  nodeKey?: string
  node_key?: string
}

/** 一组可见性谓词：`full` 为真时全放行，调用方可跳过逐条过滤。 */
export interface StatusVisibility {
  full: boolean
  node(node: VisibilityNode): boolean
  edge(edge: VisibilityEdge): boolean
  utterance(utterance: VisibilityUtterance): boolean
  action(action: VisibilityAction): boolean
}

const VISIBLE_ALL: StatusVisibility = {
  full: true,
  node: () => true,
  edge: () => true,
  utterance: () => true,
  action: () => true,
}

/**
 * 计算某位参与者在某模式下能看到的会议快照范围。
 *
 * @param mode       会议协作模式。
 * @param viewerKind `captain` = 主持人；`node` = 专家节点。
 * @param viewerKey  专家节点的 key（`viewerKind === 'captain'` 时忽略）。
 */
export function statusVisibility(
  mode: MeetingMode,
  viewerKind: 'captain' | 'node',
  viewerKey: string,
): StatusVisibility {
  if (viewerKind === 'captain' || mode === 'egalitarian') return VISIBLE_ALL
  const key = viewerKey.trim()
  return {
    full: false,
    node: (node) => node.key === key,
    // 只放行「自己 ↔ 主持人」与「自己 ↔ 汇聚网关」两类边。
    // ⚠ 不能写成「自己参与的一切边」：那会放行 a→b，让节点 a 从
    // `roundtable_status` 的 edges 里读到同伴 b 的 key，绕过"专家互不披露"。
    // （该漏洞由本场会议的架构席实证，测试 test/visibility.test.mjs 已钉死。）
    edge: (edge) => {
      if (edge.from !== key && edge.to !== key) return false
      const other = edge.from === key ? edge.to : edge.from
      return other === CAPTAIN_KEY || other === AGGREGATOR_KEY
    },
    // 自己发的 + 定向发给自己的；发给汇聚网关的他人发言不可见。
    utterance: (utterance) => utterance.speaker === key || utterance.to === key,
    action: (action) => ((action.nodeKey ?? action.node_key ?? '') === key),
  }
}

/** 收件人裁决结果：`ok` 放行；其余为拒绝原因（调用方据此抛明确错误）。 */
export type RecipientPolicy = 'ok' | 'captain-only' | 'broadcast-egalitarian-only'

/**
 * 裁决一次会议内投递是否允许。
 *
 * @param mode        会议协作模式。
 * @param speakerKind 发起者身份。
 * @param to          收件人 key，或 `all` 广播。
 */
export function recipientPolicy(
  mode: MeetingMode,
  speakerKind: 'captain' | 'node',
  to: string,
): RecipientPolicy {
  const target = to.trim()
  if (target === 'all') return mode === 'egalitarian' ? 'ok' : 'broadcast-egalitarian-only'
  if (mode !== 'egalitarian' && speakerKind === 'node' && target !== CAPTAIN_KEY) return 'captain-only'
  return 'ok'
}

/**
 * 该通道能否真的投递 —— **host 侧唯一判定**，客户端不得再复制一份策略。
 *
 * 单线制下「专家 ↔ 专家」边即"假通道"（用户拉得出、运行时投递被拒），
 * UI 据此给出说明或禁用；汇聚网关恒可投递（`roundtable_speak` 就是这条路）。
 *
 * @param mode 会议协作模式。
 * @param from 起点（席位 key / `captain` / `aggregator`）。
 * @param to   终点（同上）。
 */
export function isDeliverable(mode: MeetingMode, from: string, to: string): boolean {
  if (from === AGGREGATOR_KEY || to === AGGREGATOR_KEY) return true
  const speakerKind = from === CAPTAIN_KEY ? 'captain' : 'node'
  return recipientPolicy(mode, speakerKind, to) === 'ok'
}
