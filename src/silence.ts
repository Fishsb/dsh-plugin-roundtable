/**
 * 静默席判据（会议账本健康检查）：纯函数、无 IO，夹具驱动。
 *
 * 背景（「UI 优化会审」实测）：专家节点**可以在不调用 `roundtable_speak` 的情况下
 * 结束回合** —— 产出只落在主持人的结算通知里，会议账本 0 条、网关摘要缺该席、
 * 导出整席丢失，且全程**不报错**。本场现场复发 3 个席次（`minimal` R1、`user` R2、
 * `impl` R1+R2）；跨 19 场历史基线为 empty-round 1/25（可为 0）。
 *
 * 三条护栏（每一栏都必须可被独立测到，故以选项暴露给测试翻转）：
 *  1. **排除在飞轮**：`meeting.status !== 'ended'` 时，当前 `meeting.round` 尚未收口，
 *     不计入分子分母 —— 否则每轮误报约 30%。
 *  2. **`status === 'removed'` 的席位不计入有效派单集**：实测有一场会议 8 席
 *     全部 removed，不过滤会把「已结束且全员移除」误报成静默违规。
 *  3. **迟到 ≠ 静默**：该席位在更后面的轮次回了，属 `lateReplies`（**不算失败**，
 *     但必须留一条记录，防「迟到」被静默吞掉）。
 *
 * 轮次归属一律读**发言自带的 `round` 字段**（写入时取自 `meeting.round`）；
 * 「在飞轮」的判据字段是 `meeting.round`（`beginRound` 保证它与 `budget.usedRounds`
 * 恒等，19/19 场实测）。不要用 `budget.usedRounds` 当轮次来源 —— 那会多一个真值来源。
 *
 * ⚠ 不得读现场 `.roundtable`：测试必须夹具驱动，否则断言随环境漂移。
 *
 * @module dsh-plugin-roundtable/silence
 */

import { CAPTAIN_KEY } from './types.ts'

/** 会议侧最小形状（只取判据需要的字段）。 */
export interface SilenceMeetingLike {
  /** `active` 表示会议仍在进行（此时最后一轮属于在飞轮）。 */
  status: string
  /** 当前轮次（在飞轮判据；与 `budget.usedRounds` 恒等）。 */
  round: number
  nodes: readonly { key: string; status: string }[]
}

/** 发言侧最小形状。 */
export interface SilenceUtteranceLike {
  /** 发言人：席位 key 或 `captain`。 */
  nodeKey: string
  /** 发言所属轮次。 */
  round: number
  /** 定向收件人；空 = 交给汇聚网关。 */
  to?: string
}

/** 判据开关（仅为可测性存在：关闭某条护栏后，对应违规必须出现）。 */
export interface SilenceOptions {
  /** 护栏 1：排除在飞轮（默认 true）。 */
  excludeInFlight?: boolean
  /** 护栏 2：过滤 removed 席位（默认 true）。 */
  excludeRemoved?: boolean
  /** 护栏 3：迟到与静默分开记（默认 true）。 */
  separateLate?: boolean
}

/** 分析结果。 */
export interface SilenceReport {
  /** 已收口的派单轮次（升序）。 */
  closedRounds: number[]
  /** 已收口轮次的席位次总数（分母）。 */
  closedSeats: number
  /** 空轮：该轮派了席位，但**没有任何席位发言**（口径三，硬阈值 = 0）。 */
  emptyRounds: number[]
  /** 真静默：该轮派了该席，该席当轮未回、且此后也没有回过。 */
  silentSeats: { round: number; seat: string }[]
  /** 迟到：该轮派了该席，该席当轮未回，但在**更后面的轮次**回了（不算失败，只记录）。 */
  lateReplies: { round: number; seat: string; repliedIn: number }[]
}

/**
 * 分析一次会议的静默/迟到情况。
 *
 * @param meeting    会议快照（`status` / `round` / `nodes`）。
 * @param utterances 会议账本全部发言（逐条带 `round`）。
 * @param options    护栏开关（默认全开）。
 */
export function analyzeSilence(
  meeting: SilenceMeetingLike,
  utterances: readonly SilenceUtteranceLike[],
  options: SilenceOptions = {},
): SilenceReport {
  const excludeInFlight = options.excludeInFlight ?? true
  const excludeRemoved = options.excludeRemoved ?? true
  const separateLate = options.separateLate ?? true

  const roster = [
    ...new Set(
      meeting.nodes
        .filter((node) => !excludeRemoved || node.status !== 'removed')
        .map((node) => node.key),
    ),
  ]
  const rosterSet = new Set(roster)

  // 派单轮：主持人发出的、带定向收件人的发言所在轮次
  const dispatches = utterances.filter(
    (u) => u.nodeKey === CAPTAIN_KEY && (u.to ?? '') !== '',
  )
  const dispatchRounds = [...new Set(dispatches.map((u) => u.round))].sort((a, b) => a - b)

  const report: SilenceReport = {
    closedRounds: [],
    closedSeats: 0,
    emptyRounds: [],
    silentSeats: [],
    lateReplies: [],
  }

  for (const round of dispatchRounds) {
    // 护栏 1：在飞轮尚未收口，不计入
    if (excludeInFlight && meeting.status !== 'ended' && round === meeting.round) continue
    report.closedRounds.push(round)

    const seats = new Set<string>()
    for (const u of dispatches) {
      if (u.round !== round) continue
      const to = u.to ?? ''
      if (to === 'all') for (const key of roster) seats.add(key)
      else if (rosterSet.has(to)) seats.add(to)
    }
    if (seats.size === 0) continue

    const spokeThisRound = new Set(
      utterances.filter((u) => u.round === round && seats.has(u.nodeKey)).map((u) => u.nodeKey),
    )
    report.closedSeats += seats.size
    if (spokeThisRound.size === 0) report.emptyRounds.push(round)

    for (const seat of seats) {
      if (spokeThisRound.has(seat)) continue
      const laterRound = utterances
        .filter((u) => u.nodeKey === seat && u.round > round)
        .reduce((max, u) => Math.max(max, u.round), -1)
      if (laterRound > -1 && separateLate) {
        report.lateReplies.push({ round, seat, repliedIn: laterRound })
      } else {
        report.silentSeats.push({ round, seat })
      }
    }
  }

  return report
}

/**
 * 一行摘要（供**导出物**与**汇聚网关摘要尾部**共用）。
 * 无静默/空轮时返回空串（迟到单独列：不算失败，但必须留痕，防被静默吞掉）。
 */
export function silenceSummaryLine(report: SilenceReport): string {
  const parts: string[] = []
  if (report.silentSeats.length > 0) {
    parts.push(`静默未回：${report.silentSeats.map((s) => `R${s.round}/${s.seat}`).join(', ')}`)
  }
  if (report.emptyRounds.length > 0) parts.push(`空轮：${report.emptyRounds.join(', ')}`)
  if (report.lateReplies.length > 0) {
    parts.push(`迟到（不算失败）：${report.lateReplies.map((s) => `R${s.round}/${s.seat}→R${s.repliedIn}`).join(', ')}`)
  }
  return parts.join('；')
}

/** 某席位在已收口轮次里的静默标注（导出物名单行内用）；无记录返回空串。 */
export function silenceMarkFor(report: SilenceReport, seat: string): string {
  const rounds = report.silentSeats.filter((s) => s.seat === seat).map((s) => `R${s.round}`)
  return rounds.length === 0 ? '' : ` — ⚠ 静默未回（${rounds.join(', ')}）`
}
