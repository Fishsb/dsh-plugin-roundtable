/**
 * Meeting budget: round/token caps and the mute (闭麦) gate.
 * @module dsh-plugin-roundtable/budget
 */

import type { Meeting } from './types.ts'

/**
 * 预算轴的取值语义：**`0`（或任何非正数）= 不限制**，该轴永不闭麦。
 *
 * 判因（2026-09-24 · 用户要求「把上下文和轮次限制调到 0 表示不限制」）：
 * 设置页的两个输入框一直写着 `min={0}`（专家限额一栏的文案也明说「0 = 不限制」），
 * 但 `budgetExceeded` 此前是 `round >= maxRounds` —— 于是 `0` 变成了**最严格的**
 * 上限：第 1 轮就 `0 >= 0` 立刻闭麦。同一份界面上，`0` 在一处表示"不限制"、
 * 在另一处表示"立刻停"，这正是本仓反复在剿的「同一事实两个说法」。
 *
 * 收敛成这一个谓词（而不是各渲染点各自写 `<= 0`）的理由：判定者只能有一个。
 * 谁改了这里，`budgetExceeded` / 设置卡 / status / 导出 / 拓扑条会**同时**改口径。
 */
export function budgetUnlimited(limit: number): boolean {
  // 用 `!(limit > 0)` 而不是 `limit <= 0`：NaN 也归入"不限制"。
  // 宁可在脏数据下不闭麦（用户还能收场），也不要因 NaN 比较恒假而让"上限失效"无声发生。
  return !(limit > 0)
}

/** 预算用量的**单一口径**渲染：不限制的轴一律写作 `∞`（不得渲染成 `3/0`）。 */
export const BUDGET_UNLIMITED_MARK = '∞'

/** `已用/上限`，不限制时上限位为 `∞`。所有展示面（status / 导出 / 拓扑 / 设置卡）共用。 */
export function budgetAxisText(limit: number, used: number): string {
  return budgetUnlimited(limit) ? `${used}/${BUDGET_UNLIMITED_MARK}` : `${used}/${limit}`
}

/** **只渲染上限本身**（不带上限/已用对比），不限制时为 `∞`。用于"建会/改预算"回执。 */
export function budgetLimitText(limit: number): string {
  return budgetUnlimited(limit) ? BUDGET_UNLIMITED_MARK : String(limit)
}

/** Which budget axis is exceeded, if any. `0` 的轴不参与熔断（= 不限制）。 */
export function budgetExceeded(meeting: Meeting): 'rounds' | 'tokens' | undefined {
  const { maxRounds, maxTokens, usedTokens } = meeting.budget
  if (!budgetUnlimited(maxRounds) && meeting.round >= maxRounds) return 'rounds'
  if (!budgetUnlimited(maxTokens) && usedTokens >= maxTokens) return 'tokens'
  return undefined
}

/** Error when the meeting has ended. */
export class MeetingEndedError extends Error {
  constructor(meetingId: string) {
    super(`roundtable: meeting "${meetingId}" has ended — start a new meeting`)
    this.name = 'MeetingEndedError'
  }
}

/** Error when the meeting is muted (闭麦) on a budget axis. */
export class MeetingMutedError extends Error {
  readonly axis: 'rounds' | 'tokens'
  constructor(meetingId: string, axis: 'rounds' | 'tokens') {
    super(
      `roundtable: meeting "${meetingId}" is muted on ${axis} — the captain may top up the budget with roundtable_set_budget or close the meeting`,
    )
    this.name = 'MeetingMutedError'
    this.axis = axis
  }
}

/** Mutate the meeting: apply the mute gate and reject terminal meetings. */
export function ensureActive(meeting: Meeting): void {
  if (meeting.status === 'ended' || meeting.status === 'archived') {
    throw new MeetingEndedError(meeting.id)
  }
  const exceeded = budgetExceeded(meeting)
  if (exceeded !== undefined && meeting.status !== 'muted') {
    meeting.status = 'muted'
  }
  if (meeting.status === 'muted') {
    const axis = budgetExceeded(meeting)
    if (axis !== undefined) throw new MeetingMutedError(meeting.id, axis)
  }
}

/** Estimate the token cost of a text (coarse: ~0.6 tokens per CJK char, ~0.3 per latin). */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x2e80) cjk += 1
    else if (char.trim() !== '') other += 1
  }
  return Math.ceil(cjk * 0.6 + other * 0.3)
}

/** Advance the meeting round and return the new round number. */
export function beginRound(meeting: Meeting): number {
  meeting.round += 1
  meeting.budget.usedRounds = meeting.round
  return meeting.round
}
