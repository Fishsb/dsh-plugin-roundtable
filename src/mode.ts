/**
 * 会话级「圆桌讨论模式」（discussion mode）。
 *
 * 语义：某会话一旦处于该模式，**用户发来的消息按圆桌会议处理** —— 主持人
 * 起会议（按 usage 协议走 plan_meeting → create → 派单），而不是单模型直接作答。
 *
 * 两个入口，同一个状态表（这是刻意的：一个状态面，两个来源标记）：
 *   1. 斜杠命令 `/roundtable [off|议题]`（host 命令注册，见 `index.ts`）→ `manual`；
 *   2. 「圆桌会议」tab 被选中（浏览器挂载 `RoundTableView`）→ `auto`。
 *
 * 有效值 = `manual || auto`。两者互不覆盖：tab 切走只撤 `auto` 那一份，
 * 命令开的模式仍然生效 —— 反过来也不会因为命令开了模式而让 tab 无法撤自己那份。
 *
 * ## 状态边界（写清楚，免得把机制当现状）
 *
 * 状态是**进程内内存**（`Map`），不落盘：
 *   - DSH 重启 / 插件热重载后清零；
 *   - 重启后的自愈路径是「重新打开圆桌会议 tab」（客户端挂载即重新开 `auto`），
 *     或再次敲 `/roundtable`；
 *   - UI 徽章显示的是 **host 实际状态**（RPC 回包），不是本地猜测 —— 所以
 *     在没有 tab 的会话（例如 DSH 刚起来、用户还在聊天页）徽章会如实显示未开。
 *
 * @module dsh-plugin-roundtable/mode
 */

/** 模式来源：命令开的（manual）与 tab 开的（auto）互不覆盖。 */
export type ModeSource = 'auto' | 'manual'

/** 一个会话的模式状态（两个来源标记，任一为真即生效）。 */
export interface SessionModeState {
  /** 「圆桌会议」tab 被选中时置位。 */
  readonly auto: boolean
  /** `/roundtable` 命令置位。 */
  readonly manual: boolean
}

/** 未开状态（读不到会话时的返回值 —— 不是"未知"，是"默认关"）。 */
export const MODE_OFF: SessionModeState = Object.freeze({ auto: false, manual: false })

/** 有效值：两个来源任一为真。 */
export function isModeActive(state: SessionModeState): boolean {
  return state.auto || state.manual
}

/**
 * 会话 → 模式状态表。
 *
 * 键是 `SessionId` 的字符串形式（host 侧 `agent.session.id` 与浏览器下发的
 * `sessionId` 是同一 axis，见 `rpc.ts` 的注释）。
 */
export class SessionModeTable {
  private readonly states = new Map<string, SessionModeState>()

  /** 读一个会话的状态；未记录即 {@link MODE_OFF}（不抛错，缺失不是错误）。 */
  read(sessionId: string): SessionModeState {
    return this.states.get(sessionId) ?? MODE_OFF
  }

  /** 该会话此刻是否处于讨论模式。 */
  isActive(sessionId: string): boolean {
    return isModeActive(this.read(sessionId))
  }

  /**
   * 写一个来源标记。只改**自己这一份**，另一份原样保留。
   * @returns 写入后的状态（值未变时返回原引用，便于调用方跳过重渲染）。
   */
  set(sessionId: string, source: ModeSource, active: boolean): SessionModeState {
    const current = this.read(sessionId)
    const next: SessionModeState = source === 'auto'
      ? { auto: active, manual: current.manual }
      : { auto: current.auto, manual: active }
    if (next.auto === current.auto && next.manual === current.manual) return current
    this.states.set(sessionId, next)
    return next
  }

  /** 两个来源一起清（会话结束/显式关闭时用）。 */
  clear(sessionId: string): void {
    this.states.delete(sessionId)
  }

  /** 已记录的会话数（探针与测试用，不是业务接口）。 */
  size(): number {
    return this.states.size
  }
}

/** `/roundtable` 命令名的单源（注册、文案、测试三处引用它）。 */
export const MODE_COMMAND_NAME = 'roundtable'

/** `/roundtable` 尾部输入的解析结果。 */
export type ModeCommandIntent =
  | { kind: 'enable' }
  | { kind: 'disable' }
  /** 带议题：开模式 + 把议题作为用户消息转交主持人（一次性启动会议）。 */
  | { kind: 'topic'; topic: string }

/**
 * 解析 `/roundtable` 的尾部输入。
 *
 * 裸调用即"开"（用户要求：用斜杠命令就是开启圆桌会议讨论模式），
 * `off`/`关` 显式退；其余文本一律当作**议题**（开模式并转交）。
 */
export function parseModeCommand(rawInput: string): ModeCommandIntent {
  const text = rawInput.trim()
  if (text === '') return { kind: 'enable' }
  const lower = text.toLowerCase()
  if (lower === 'on' || lower === 'enable' || text === '开' || text === '开启') return { kind: 'enable' }
  if (lower === 'off' || lower === 'disable' || text === '关' || text === '关闭') return { kind: 'disable' }
  return { kind: 'topic', topic: text }
}

/** 命令执行结果：新状态 + 可选的"转交议题" + 给人看的一行结果。 */
export interface ModeCommandOutcome {
  readonly state: SessionModeState
  /** 需要作为用户消息转交给主持人的议题（`''` = 不转交）。 */
  readonly steerText: string
  /** 命令结果文案（`command/done` 的 text，UI 直接显示）。 */
  readonly text: string
}

/**
 * 执行一次 `/roundtable` 命令（纯函数：只改传进来的状态表，不做 IO）。
 *
 * 把 IO（`agent.steer`）留给调用方，测试才能只断言状态与文案。
 */
export function runModeCommand(
  table: SessionModeTable,
  sessionId: string,
  rawInput: string,
): ModeCommandOutcome {
  const intent = parseModeCommand(rawInput)
  if (intent.kind === 'disable') {
    // 命令的语义是"退模式"，因此两份一起撤 —— 否则用户敲了 off 却因为 tab 还
    // 开着而看不到任何变化（假反馈）。
    table.set(sessionId, 'manual', false)
    table.set(sessionId, 'auto', false)
    return { state: MODE_OFF, steerText: '', text: '圆桌讨论模式已关闭。' }
  }
  const state = table.set(sessionId, 'manual', true)
  if (intent.kind === 'enable') {
    return {
      state,
      steerText: '',
      text: '圆桌讨论模式已开启：本会话后续消息按圆桌会议处理。关闭用 /roundtable off。',
    }
  }
  return {
    state,
    steerText: intent.topic,
    text: `圆桌讨论模式已开启，议题已转交主持人：${intent.topic}`,
  }
}

/**
 * 模式生效时注入的 system prompt 段（主机侧英文，与既有 usage 段同一语域）。
 *
 * 只描述**行为契约**，不重复 usage 段里的 16 条协议 —— 那一段在模式关闭时
 * 也在提示词里，重复会把 token 花在同一件事上。
 */
export function modeSectionText(): string {
  return [
    'ROUNDTABLE DISCUSSION MODE IS ON for this session.',
    'The user enabled it (the /roundtable command, or by speaking inside the 圆桌会议 tab).',
    'Treat every incoming user message in this session as the agenda of a round-table meeting:',
    '- If the message already names a concrete question or goal, start the meeting protocol at once (roundtable_plan_meeting first, per the usage policy above) instead of answering it yourself.',
    '- If the goal is not concrete yet, ask ONE short clarifying question, then start the meeting.',
    '- Keep the single-output discipline: expert content reaches the user only through your consolidated summary.',
    'Do not silently fall back to a plain single-model answer while this mode is on; the user leaves it with /roundtable off.',
  ].join('\n')
}
