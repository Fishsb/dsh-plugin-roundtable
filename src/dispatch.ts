/**
 * 本轮调度计划（R-D）：把"谁做什么、谁等谁、什么可并行"从主持人的脑内
 * 变成可机检、可落账的数据结构。纯函数、无 IO，夹具驱动。
 *
 * 背景（2026-09-19 用户实测反馈）：主持人模式此前**只有执行面**（自由文本
 * `roundtable_send_message`）——没有计划面。后果有两条，用户在真会议上都撞到：
 *  1. 依赖关系不可表达："哪些任务能并行、哪些必须串"只活在主持人脑内且不落账，
 *     静默判据（silence.ts）只测"派了没回"，对"派单结构是否合理"完全盲；
 *  2. 名册在 spawn 期烧死：`roundtable_status` 只回在场节点，候选池（28 条
 *     用户自建预设）不进每轮信息面 —— 主持人想换人也无从选起。
 *
 * 本模块同时负责 ① 计划面 与 ② 信息面：`buildTalentPool`（候选池，供
 * `tools.ts` 的 `talent_pool` 字段）与 `buildRoundSignals`（本轮信号，供
 * `round_signals` 字段）都在这里实现 —— 逻辑集中、夹具可测，`tools.ts`
 * 只负责"取实时数据 + 按可见性裁剪"。
 *
 * 并行/串行的**判据是结构性的**，不是描述性的：
 *  - `depends_on` 为空 ⇒ 与同为空的项**同波并行**；
 *  - `depends_on` 非空 ⇒ 波次 = 1 + max(依赖波次)，即真串行；
 *  - 引用不存在的 id / 成环 / 引用不存在的席位 ⇒ **拒绝**，而不是放过。
 * 于是"我做了并行串行分析"这句话，变成了必须交出的一张图。
 *
 * @module dsh-plugin-roundtable/dispatch
 */

import type { MeetingMode, RoundPlan, RoundPlanItem } from './types.ts'
import { AGGREGATOR_KEY, CAPTAIN_KEY } from './types.ts'

/** 持久化形状从 types.ts 再导出，调用方只认 `dispatch.ts` 一个入口。 */
export type { RoundPlan, RoundPlanItem } from './types.ts'

/** 一个波次：同一波内的项**无相互依赖**，可并发下发。 */
export interface PlanWave {
  /** 波次序号，从 1 开始；1 = 本轮立刻可并发下发的全部项。 */
  wave: number
  items: { id: string; task: string; owner: string }[]
}

/** 席位缺口：计划要求一条**在场不存在**的预设。 */
export interface PlanGap {
  /** 需要新席的工作项 id。 */
  item: string
  /** 该项的任务描述（便于主持人/用户看懂为什么缺人）。 */
  task: string
  /** 预设 id（写 `new:<id>` 时给出的原值）。 */
  presetId: string
  /** 预设显示名（解析到才有；未解析时为空串）。 */
  presetName: string
  /** 预设是否已解析到（false = 用户预设里没有这条，属配置错误）。 */
  resolved: boolean
  /** 当前是否已有该预设的席位在场（true = 缺口已补上）。 */
  onStage: boolean
}

/** 校验通过后的计划报告（波次 + 缺口 + 承接席）。 */
export interface PlanReport {
  /** 按波次分组（升序）。并发 = 同一波；串行 = 后面的波等前面的波。 */
  waves: PlanWave[]
  /** 需要新拉席位的项（`new:<预设>`）。 */
  gaps: PlanGap[]
  /** 计划点名的**在场席**（去重，保持出现顺序；不含 `new:` 缺口）。 */
  owners: string[]
}

/** 校验结果：通过给报告，不通过给**可读原因**（调用方据此报错）。 */
export type PlanCheck =
  | { ok: true; report: PlanReport }
  | { ok: false; error: string }

/** 校验所需的会议侧事实（全部由调用方实时读取，本模块不猜）。 */
export interface PlanContext {
  /** 在场可派单席 key（未移除，且已出生 `id !== ''`）。 */
  rosterKeys: readonly string[]
  /** 可用角色预设（id + 显示名 + role 摘要）。 */
  presets: readonly { id: string; name: string; role?: string }[]
  /** 已在场的节点（用于判缺口是否已补：按 `presetId` 关联）。 */
  onStagePresetIds?: readonly string[]
}

/** `new:` 前缀：把工作项承接席指向"尚不存在、需本轮新拉的预设"。 */
export const NEW_SEAT_PREFIX = 'new:'

/**
 * 硬门判据（用户 2026-09-19 拍板）：在场席 ≥2 且没交计划 ⇒ 拒绝推进轮次。
 *
 * 刻意抽成一处而不是写死在工具里：这条判据同时出现在 usage 协议文案与
 * `roundtable_next_round` 的实现里，两处一旦漂移就是"文案说要交、工具其实不查"。
 *
 * **判据与模式无关**（用户拍板的口径是"≥2 席必交"，未按模式分叉），理由：
 * 推进轮次 = 花钱，任何模式下主持人都该说清"本轮要让谁做什么、谁等谁"。
 * 圆桌制下专家的自组织（同伴直达）不改变这一点 —— 它只是**执行路径**更多，
 * 而计划描述的是**本轮意图**。故这里不收 `mode` 参数：加模式分支会让
 * "同一件事两个判据"，而当前没有证据支持分叉。
 *
 * 单席免 —— 那时压根没有"并行还是串行"这个问题，不制造无意义的仪式。
 */
export function requiresDispatchPlan(liveSeatCount: number, planItemCount: number): boolean {
  return planItemCount === 0 && liveSeatCount >= 2
}

/** 一条计划项的 id/task 长度上限（防止把整段需求书塞进 id）。 */
const MAX_ID_CHARS = 60
const MAX_TASK_CHARS = 400
const MAX_ITEMS = 40

/** 解析承接席写法：在场席 key 或 `new:<预设 id>`。 */
export function splitOwnerRef(owner: string): { kind: 'seat' | 'new'; value: string } {
  const trimmed = owner.trim()
  if (trimmed.startsWith(NEW_SEAT_PREFIX)) {
    return { kind: 'new', value: trimmed.slice(NEW_SEAT_PREFIX.length).trim() }
  }
  return { kind: 'seat', value: trimmed }
}

/**
 * 宽松解析工具入参 `plan`（接受 `dependsOn` / `depends_on` 两种写法，
 * 容忍缺失字段）。不做合法性判断 —— 那是 {@link validateRoundPlan} 的事。
 */
export function normalizePlanItems(raw: unknown): RoundPlanItem[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const candidate = entry as Record<string, unknown>
    const id = String(candidate.id ?? '').trim().slice(0, MAX_ID_CHARS)
    const task = String(candidate.task ?? '').trim().slice(0, MAX_TASK_CHARS)
    const owner = String(candidate.owner ?? '').trim()
    const dependsRaw = candidate.dependsOn ?? candidate.depends_on
    const dependsOn = Array.isArray(dependsRaw)
      ? dependsRaw
          .map((dependency) => String(dependency ?? '').trim().slice(0, MAX_ID_CHARS))
          .filter((dependency) => dependency !== '')
      : []
    // 回归风险自检（2026-09-23）：显式空串与缺省**同义**（都算"没填"），
    // 避免"填了个空字符串"被当成做过自检——那是本插件在剿的假绿形态。
    const riskRaw = candidate.regressionRisk ?? candidate.regression_risk
    const regressionRisk = String(riskRaw ?? '').trim().slice(0, MAX_TASK_CHARS)
    return [{
      id,
      task,
      owner,
      dependsOn,
      ...(regressionRisk === '' ? {} : { regressionRisk }),
    }]
  })
}

/**
 * 校验一张本轮调度计划并算出波次。
 *
 * 逐条判据（每条都必须能被夹具独立测到）：
 *  1. 计划非空且条数 ≤ {@link MAX_ITEMS}；
 *  2. 每项的 id/task/owner 非空，id 本轮内唯一；
 *  3. `depends_on` 必须指向本轮**已存在**的 id（悬挂引用 = 拒绝）；
 *  4. 依赖图**无环**（自环、二元环、多元环都拒绝）；
 *  5. 承接席要么是在场席 key，要么是解析得到的预设（`new:<id>`）；
 *     写错席位列全清单提示，写错预设列可用预设 id。
 */
export function validateRoundPlan(
  items: readonly RoundPlanItem[],
  context: PlanContext,
): PlanCheck {
  if (items.length === 0) {
    return { ok: false, error: 'plan is empty — a round with no dispatch is not a round; do not advance the round at all' }
  }
  if (items.length > MAX_ITEMS) {
    return { ok: false, error: `plan has ${items.length} items, over the cap of ${MAX_ITEMS} — split it across rounds` }
  }

  const ids = new Set<string>()
  for (const [index, item] of items.entries()) {
    const at = `plan[${index}]`
    if (item.id === '') return { ok: false, error: `${at}: id must not be empty` }
    if (item.task === '') return { ok: false, error: `${at} (${item.id}): task must not be empty` }
    if (item.owner === '') return { ok: false, error: `${at} (${item.id}): owner must not be empty` }
    if (ids.has(item.id)) return { ok: false, error: `${at}: duplicate id "${item.id}" — ids must be unique inside one round` }
    ids.add(item.id)
  }

  for (const item of items) {
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency)) {
        return {
          ok: false,
          error: `item "${item.id}" depends_on "${dependency}" which is not an id in this plan (known: ${[...ids].join(', ')})`,
        }
      }
    }
  }

  const cycle = findCycle(items)
  if (cycle !== undefined) {
    return { ok: false, error: `dependency cycle: ${cycle.join(' → ')} — a cycle means nobody can ever start` }
  }

  const roster = new Set(context.rosterKeys)
  const presetById = new Map(context.presets.map((preset) => [preset.id, preset]))
  const onStage = new Set(context.onStagePresetIds ?? [])
  const gaps: PlanGap[] = []
  const owners: string[] = []

  for (const item of items) {
    const ref = splitOwnerRef(item.owner)
    if (ref.kind === 'new') {
      if (ref.value === '') {
        return { ok: false, error: `item "${item.id}": owner "${item.owner}" is missing a preset id (write "new:<preset id>")` }
      }
      const preset = presetById.get(ref.value)
      if (preset === undefined) {
        const known = context.presets.length === 0
          ? 'no role presets are defined (设置 → 圆桌会议 → 角色预设)'
          : `available presets: ${context.presets.map((candidate) => candidate.id).join(', ')}`
        return { ok: false, error: `item "${item.id}": role preset "${ref.value}" not found — ${known}` }
      }
      gaps.push({
        item: item.id,
        task: item.task,
        presetId: preset.id,
        presetName: preset.name,
        resolved: true,
        onStage: onStage.has(preset.id),
      })
      continue
    }
    if (!roster.has(ref.value)) {
      const known = context.rosterKeys.length === 0
        ? 'no live seat yet (call roundtable_add_node first)'
        : `live seats: ${context.rosterKeys.join(', ')}`
      return {
        ok: false,
        error: `item "${item.id}": owner "${ref.value}" is not a live seat — ${known}. `
          + 'To pull a new seat from the user\'s role presets, write owner as "new:<preset id>" and the plan will list it as a gap.',
      }
    }
    if (!owners.includes(ref.value)) owners.push(ref.value)
  }

  return { ok: true, report: { waves: planWaves(items), gaps, owners } }
}

/** 依赖成环检测（Kahn）：返回剩余环上的 id 链，无环返回 undefined。 */
function findCycle(items: readonly RoundPlanItem[]): string[] | undefined {
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const item of items) {
    indegree.set(item.id, item.dependsOn.length)
    for (const dependency of item.dependsOn) {
      const list = dependents.get(dependency) ?? []
      list.push(item.id)
      dependents.set(dependency, list)
    }
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id)
  const settled = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift() as string
    settled.add(current)
    for (const dependent of dependents.get(current) ?? []) {
      const left = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, left)
      if (left === 0) queue.push(dependent)
    }
  }
  if (settled.size === items.length) return undefined
  const remaining = items.filter((item) => !settled.has(item.id))
  const start = remaining[0]
  if (start === undefined) return undefined
  // 顺着依赖边在环内走出来一条可读链（起点任取环上一点，回到起点即闭环）。
  const inRing = new Set(remaining.map((item) => item.id))
  const chain: string[] = [start.id]
  let cursor = start.id
  for (let hop = 0; hop <= remaining.length; hop += 1) {
    const current = items.find((item) => item.id === cursor)
    const next = current?.dependsOn.find((dependency) => inRing.has(dependency))
    if (next === undefined) break
    chain.push(next)
    if (next === start.id) break
    cursor = next
  }
  return chain
}

/**
 * 计算波次：`depends_on` 为空的项落在第 1 波（彼此并行），
 * 其余项 = 1 + max(依赖波次)。**输入必须已通过环检测**。
 */
export function planWaves(items: readonly RoundPlanItem[]): PlanWave[] {
  const depth = new Map<string, number>()
  const byId = new Map(items.map((item) => [item.id, item]))
  const resolve = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    const item = byId.get(id)
    if (item === undefined || seen.has(id)) return 1
    seen.add(id)
    const value = item.dependsOn.length === 0
      ? 1
      : 1 + Math.max(...item.dependsOn.map((dependency) => resolve(dependency, seen)))
    depth.set(id, value)
    return value
  }
  for (const item of items) resolve(item.id, new Set())

  const waves = new Map<number, PlanWave['items']>()
  for (const item of items) {
    const wave = depth.get(item.id) ?? 1
    const bucket = waves.get(wave) ?? []
    bucket.push({ id: item.id, task: item.task, owner: item.owner })
    waves.set(wave, bucket)
  }
  return [...waves.entries()]
    .sort(([a], [b]) => a - b)
    .map(([wave, bucket]) => ({ wave, items: bucket }))
}

/** 波次段的**人读**渲染（next_round 与 status 共用，避免两处漂移）。 */
export function formatPlanWaves(report: PlanReport): string {
  const lines: string[] = []
  for (const wave of report.waves) {
    lines.push(`  wave ${wave.wave}${wave.wave === 1 ? ' (dispatch now, in parallel)' : ` (after wave ${wave.wave - 1})`}:`)
    for (const item of wave.items) {
      lines.push(`    - ${item.id} → ${item.owner}: ${item.task}`)
    }
  }
  return lines.join('\n')
}

/** 缺口段的**人读**渲染；无缺口返回空串（调用方据此整段省略）。 */
export function formatPlanGaps(report: PlanReport): string {
  if (report.gaps.length === 0) return ''
  const lines = ['  gaps (pull these seats with roundtable_add_node before dispatching):']
  for (const gap of report.gaps) {
    lines.push(`    - ${gap.item} needs preset \`${gap.presetId}\`（${gap.presetName}）`
      + `${gap.onStage ? ' — already on stage' : ' — nobody on stage yet'}`)
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 账本对账：计划说了发给谁 vs 本轮实际发给了谁
 * ------------------------------------------------------------------ */

/** 对账结果（两侧都是"派单外的人/漏派的人"，属**信号**不是错误）。 */
export interface DispatchReconciliation {
  /** 计划点名、但本轮没有收到任何定向派发的在场席。 */
  undispatchedOwners: string[]
  /**
   * 本轮实际收到定向派发、但不在计划承接席里的席。
   *
   * 单线制下这通常是"临时追加"（主持人需说明）；**圆桌制下也可能是同伴直达**，
   * 那时它是正常自组织而非偏差 —— 所以这是**信号**（要读、要解释），
   * 不是"必须为空"的断言。判据本身不按模式改口径（同一个事实同一个算法），
   * 由读的人按模式解释。
   */
  unplannedDispatches: string[]
}

/**
 * 比对计划承接席与本轮实际定向派发对象（两侧都只含**在场席**；
 * `new:` 缺口不参与 —— 它本来就不该在本轮收到派发）。
 */
export function reconcileDispatches(
  plannedOwners: readonly string[],
  dispatchedSeats: readonly string[],
): DispatchReconciliation {
  const planned = new Set(plannedOwners)
  const dispatched = new Set(dispatchedSeats)
  return {
    undispatchedOwners: plannedOwners.filter((owner) => !dispatched.has(owner)),
    unplannedDispatches: dispatchedSeats.filter((seat) => !planned.has(seat)),
  }
}

/* ------------------------------------------------------------------ *
 * [越界转派] 结构化提取（单线制下专家交给主持人的"该换人"信号）
 * ------------------------------------------------------------------ */

/** 一条被提取出来的越界转派。 */
export interface Handoff {
  /** 提出该转派的席位（或 captain）。 */
  fromSeat: string
  /** 事项正文。 */
  item: string
  /** 建议承接的职责（未写则为空串）。 */
  suggestedRole: string
  /** 所属轮次。 */
  round: number
}

/** 单条转派文本的长度上限（防止一条发言把 status 撑爆）。 */
const MAX_HANDOFF_ITEM_CHARS = 300
const MAX_HANDOFF_ROLE_CHARS = 200
/** status 里最多列几条转派（**总数单独给**，防止"没看见"退化成"没发生"）。 */
export const HANDOFF_RENDER_LIMIT = 8

/**
 * 从一条发言里提取 `[越界转派]` 行。
 *
 * 协议（charter 第二节）：`[越界转派]：<事项> | 建议承接：<职责>`。
 *
 * 判据（实测收紧过两次，见下方注释）：
 *  - **必须是行首标记**（允许前导空白与 `-`/`*`/`1.` 等项目符号）。早期版本用
 *    "行内包含"[越界转派]"就抓" —— 结果主持人派单里写一句
 *    「请在末尾按协议写一行 [越界转派]（无则写"无"）」就被当成一条真实转派，
 *    即"讨论该标记"被误判成"发出该标记"。行首判据把这类引用挡在外面。
 *  - 容忍全角/半角分隔符、`建议承接` 标签缺失、只写事项不写职责。
 *  - 不猜、不做语义推断：没有该标记就是没有。
 */
export function parseHandoffs(
  fromSeat: string,
  content: string,
  round: number,
): Handoff[] {
  const out: Handoff[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.replace(/^[\s>*\-•\d.、)）]+/, '')
    if (!trimmed.startsWith('[越界转派]')) continue
    const body = trimmed.slice('[越界转派]'.length).replace(/^[:：\s]+/, '').trim()
    if (body === '') continue
    const parts = body.split(/[|｜]/)
    const head = (parts[0] ?? '').trim()
    const tail = parts.slice(1).join(' ').trim()
    const item = head.slice(0, MAX_HANDOFF_ITEM_CHARS)
    if (item === '') continue
    const suggestedRole = tail
      .replace(/^建议承接\s*[:：]?/, '')
      .slice(0, MAX_HANDOFF_ROLE_CHARS)
      .trim()
    out.push({ fromSeat, item, suggestedRole, round })
  }
  return out
}

/** `[越界转派]` 在语义上就是**席位 → 主持人**的上行信号：这两类发起者不算。 */
const HANDOFF_NON_SEAT_SPEAKERS: readonly string[] = [CAPTAIN_KEY, AGGREGATOR_KEY]

/**
 * 提取一批发言里的全部转派（**最新在前**，便于主持人先看当下的）。
 *
 * 默认排除主持人/汇聚网关的发言：主持人在派单里引用该标记（"请在末尾写一行
 * [越界转派]"）不得被当成一条待处理转派 —— 实测出现过这种假信号。
 */
export function collectHandoffs(
  utterances: readonly { nodeKey: string; content: string; round: number }[],
  options: { excludeSpeakers?: readonly string[] } = {},
): Handoff[] {
  const excluded = new Set(options.excludeSpeakers ?? HANDOFF_NON_SEAT_SPEAKERS)
  const out: Handoff[] = []
  for (const utterance of utterances) {
    if (excluded.has(utterance.nodeKey)) continue
    out.push(...parseHandoffs(utterance.nodeKey, utterance.content, utterance.round))
  }
  return out.reverse()
}

/** 渲染转派段（status 与导出共用）。 */
export function formatHandoffRows(
  rows: readonly { from_seat: string; item: string; suggested_role: string; round: number }[],
): string {
  if (rows.length === 0) return '  (none)'
  return rows.map((row) => {
    const role = row.suggested_role === '' ? '（未写建议承接）' : row.suggested_role
    return `  - [R${row.round}] ${row.from_seat} → ${role}: ${row.item}`
  }).join('\n')
}

/**
 * 转成状态输出用的**蛇形对象字面量**行。
 *
 * 刻意返回**匿名对象类型**（而不是 interface）：工具输出必须满足
 * `Record<string, JsonValue>`，而 TS 只给对象字面量/匿名类型隐式索引签名，
 * interface 没有 —— 直接塞 `Handoff[]` 会让整个 status 工具类型不过。
 */
export function toHandoffRows(
  handoffs: readonly Handoff[],
  limit: number,
): { from_seat: string; item: string; suggested_role: string; round: number }[] {
  return handoffs.slice(0, limit).map((handoff) => ({
    from_seat: handoff.fromSeat,
    item: handoff.item,
    suggested_role: handoff.suggestedRole,
    round: handoff.round,
  }))
}

/* ------------------------------------------------------------------ *
 * 候选池（R-D ①）：专家库进每轮信息面
 * ------------------------------------------------------------------ */

/** 由「预设 → 在场席」条目构造 {@link RoundSignalsInput.onStageByPreset} 所需的映射。
 *
 *  **唯一装配入口**：tools.ts 与 snapshot.ts 都必须用它，不得各写一份 reduce
 *  （实测过漏传导致的两个答案，见该字段的注释）。 */
export function onStagePresetMap(
  entries: readonly { preset_id: string; node_keys: string[] }[],
): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const entry of entries) map[entry.preset_id] = [...entry.node_keys]
  return map
}

/**
 * 「可派单席」判据：未移除 **且已出生**（`id !== ''`）。
 *
 * 只有一个判定者：调度面（硬门计席数、波次校验的 rosterKeys、对账的 liveSeatKeys）
 * 四处内联过同一条谓词（snapshot.ts ×2 / tools.ts ×2）。内联四处时，
 * 任何一处漏掉 `id !== ''` 都会让"未出生的席"混进可派单集 —— 那是"计划能点到一个
 * 根本收不到消息的席"，且**不会报错**。
 *
 * ⚠ 只收这一条：名册展示、连线合法性、去重等处的 `status !== 'removed'` 语义不同
 * （不要求已出生），不要顺手替换（那会把已有语义改掉）。
 */
export function isDispatchableSeat(node: { status: string; id?: string }): boolean {
  return node.status !== 'removed' && (node.id ?? '') !== ''
}

/** 可派单席的 key 列表（顺序 = 会议名册顺序）。 */
export function dispatchableSeatKeys(
  nodes: readonly { key: string; status: string; id?: string }[],
): string[] {
  return nodes.filter(isDispatchableSeat).map((node) => node.key)
}

/**
 * 「与预设关联的在场席」判据：未移除且记了 `presetId`。
 *
 * **另一个**谓词，不是 {@link isDispatchableSeat} 的变体：这里要求的是
 * "这条预设现在有人顶着"（供 `new:<预设>` 缺口还原与候选池 on_stage 标记），
 * 不要求 `id !== ''`（未出生的席也仍是"已认领该预设"）。
 * 两处内联过同一条（tools.ts 的 validateRoundPlan 入参 / snapshot.ts 的 planView）。
 */
export function presetLinkedSeatIds(
  nodes: readonly { status: string; presetId?: string }[],
): string[] {
  return nodes
    .filter((node) => node.status !== 'removed' && (node.presetId ?? '') !== '')
    .map((node) => node.presetId as string)
}

/**
 * 由节点算出「预设 → 在场席 key」。
 *
 * 判据：只认**未移除且记了 `presetId`** 的节点 —— 临时写的角色不算任何预设的
 * 在场席（拿 role 文本比对是猜，这里不猜）。`buildTalentPool` 与快照/status 的
 * 在场标记都用它，保证"谁在场"只有一个判定者。
 */
export function onStagePresetEntries(
  nodes: readonly { key: string; status: string; presetId?: string }[],
): { preset_id: string; node_keys: string[] }[] {
  const stage = new Map<string, string[]>()
  for (const node of nodes) {
    const presetId = node.presetId ?? ''
    if (node.status === 'removed' || presetId === '') continue
    const list = stage.get(presetId) ?? []
    list.push(node.key)
    stage.set(presetId, list)
  }
  return [...stage.entries()].map(([preset_id, node_keys]) => ({ preset_id, node_keys }))
}

/**
 * 由用户预设 + 当前节点算出**候选池**。
 *
 * 判据（全可机检）：
 *  - `total` = 预设条数（磁盘权威，实时读设置页那一层）；
 *  - `on_stage` 见 {@link onStagePresetEntries}；
 *  - `candidates` 给全量预设一条一行（id/name/路由/on_stage），**刻意不给
 *    role 全文**：28 条预设的正文约 3.4k token，每轮灌一遍就是纯浪费，
 *    要正文走 `roundtable_list_presets filter=<关键词>`。
 *
 * 返回**匿名对象类型**（不是 interface）：工具输出必须满足
 * `Record<string, JsonValue>`，而 TS 只给对象字面量/匿名类型隐式索引签名。
 */
export function buildTalentPool(
  presets: readonly { id: string; name: string; provider?: string; model?: string; reasoningEffort?: string }[],
  nodes: readonly { key: string; status: string; presetId?: string }[],
): {
  total: number
  on_stage: { preset_id: string; node_keys: string[] }[]
  candidates: { id: string; name: string; provider: string; model: string; reasoning_effort: string; on_stage: boolean }[]
} {
  const onStage = onStagePresetEntries(nodes)
  const staged = new Set(onStage.map((entry) => entry.preset_id))
  return {
    total: presets.length,
    on_stage: onStage,
    candidates: presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      provider: preset.provider ?? '',
      model: preset.model ?? '',
      // 候选池摘要也带档位：否则主持人看不到"这条预设带不带强度"。
      reasoning_effort: preset.reasoningEffort ?? '',
      on_stage: staged.has(preset.id),
    })),
  }
}

/* ------------------------------------------------------------------ *
 * 轮次信号（R-D ②）：计划 vs 实际 + 待回席 + [越界转派] 积压
 * ------------------------------------------------------------------ */

/** 信号计算所需的会议侧事实（全部由调用方实时读取，本模块不猜）。 */
export interface RoundSignalsInput {
  round: number
  /**
   * 协作模式。判据随模式分叉，不能一把抓：
   *  - `[越界转派]` 是**单线制专属协议**（charter 第二节 / members.ts 的 modeRule）。
   *    圆桌制（egalitarian）下专家直接 `roundtable_send_message` 转给同伴并抄送主持人，
   *    **不使用**该标记 —— 在那里收集它就是在报一个该模式不存在的信号。
   */
  mode: MeetingMode
  /** 本轮的调度计划；undefined = 本轮没有计划（要显式报出来，不静默）。 */
  plan: RoundPlan | undefined
  /** 在场可派发席 key（未移除**且已出生**）。 */
  liveSeatKeys: readonly string[]
  /** 会议账本全部发言。 */
  utterances: readonly { nodeKey: string; content: string; round: number; to?: string; workItem?: string }[]
  /**
   * 预设 id → 该预设**已在场**的席位 key。
   *
   * 用途：`owner: "new:<预设>"` 有两种实况 —— ①该预设确实没人，得先拉席（真缺口）；
   * ②该预设已经在场，主持人只是沿用了 `new:` 写法（`validateRoundPlan` 会提示
   * "already on stage"）。②若不解析成真实席位，主持人派给它就会被误报成
   * "计划外派发"，把真信号淹没在假信号里。所以对账前必须把已到场的 `new:` 还原。
   *
   * ⚠ **必填**（不是 optional）。这一条曾经是 optional，于是 `snapshot.ts` 漏传它，
   * 同一场会议里 `status` 说"没漏派"而快照说 `unplannedDispatches:["arch"]` ——
   * 两个判定者对同一事实给了两个答案，且**类型层不报错**（实测证据见
   * `tset/probe-ontsstage.mjs`）。改成必填后，装配点漏传就是编译错误。
   * 装配请统一走 {@link buildRoundSignals} 的调用方里那一个 map（tools.ts / snapshot.ts
   * 都用 `onStagePresetMap()`），不要再各写一份。
   */
  onStageByPreset: Readonly<Record<string, readonly string[]>>
}

/** 本轮信号（字段全为必填，见 `buildTalentPool` 关于匿名返回类型的说明）。 */
export function buildRoundSignals(input: RoundSignalsInput): {
  round: number
  plan_recorded: boolean
  planned_owners: string[]
  planned_waves: string[][]
  undispatched_owners: string[]
  unplanned_dispatches: string[]
  undispatched_items: { id: string; owner: string; task: string }[]
  untracked_items: { id: string; owner: string; task: string }[]
  tracked_items: number
  pending_seats: string[]
  out_of_scope: { from_seat: string; item: string; suggested_role: string; round: number }[]
  out_of_scope_total: number
  out_of_scope_hidden: number
  /** 本轮计划条数（0 = 无计划，与 `plan_recorded:false` 同义，供风险面分母用）。 */
  plan_items: number
  /** 做了回归风险自检的项数（分母 = `plan_items`）。 */
  risk_declared: number
  /** **未**做回归风险自检的项 id（只呈现不判定：机器判不了哪条需要自检）。 */
  risk_items_missing: string[]
} {
  const { round, plan, liveSeatKeys, utterances } = input  // 计划承接席（席位口径）：
  //  - `owner` 是裸席位 key ⇒ 原样进集；
  //  - `owner` 是 `new:<预设>` 且该预设**已在场** ⇒ 还原成在场的那个（些）席位。
  //    （实测缺陷：不还原时，主持人按计划把该项派给在场席位会被误报成
  //    "计划外派发"，真信号被假信号淹没。）
  //  - `new:<预设>` 而该预设确实没人 ⇒ 保留为缺口，不参与对账：它本轮本来
  //    就不该收到派发，报成"漏派"是错的（该先 add_node，见 round_signals.gaps
  //    与 next_round 返回的 gaps）。
  const onStageByPreset = input.onStageByPreset ?? {}
  const plannedOwners: string[] = []
  if (plan !== undefined) {
    for (const item of plan.items) {
      const ref = splitOwnerRef(item.owner)
      if (ref.kind === 'seat') {
        if (!plannedOwners.includes(ref.value)) plannedOwners.push(ref.value)
        continue
      }
      for (const seat of onStageByPreset[ref.value] ?? []) {
        if (!plannedOwners.includes(seat)) plannedOwners.push(seat)
      }
    }
  }
  const scheduled = plan === undefined ? [] : planWaves(plan.items).map((wave) => wave.items.map((item) => item.id))
  /**
   * 实际派发集合。**派单者随模式分叉**，不能一律只认主持人：
   *  - 单线制（orchestrated / redteam）：主持人是唯一信息枢纽，只有它派单
   *    （专家发给主持人的汇报不算派发；广播在那里被工具拒绝）。
   *  - 圆桌制（egalitarian）：**专家互相直达**就是正常派单路径（charter 第二节：
   *    "本职以外的请求直接转给名册里承担该职责的成员"）。只认主持人会把
   *    "同伴唤醒"误报成漏派 —— 实测 E3：`impl` 由 `arch` 唤醒，却被报成
   *    `undispatched=["impl","arch"]`，连发起直达的 `arch` 自身也算漏派（纯假阳性）。
   *
   * 广播按全量在场席计（单线制不允许广播，所以这一支只对圆桌制有意义）。
   * 发给主持人/汇聚网关的发言**不算派发**（那是汇报，不是派单）。
   */
  const dispatched: string[] = []
  for (const utterance of utterances) {
    if (utterance.round !== round) continue
    const speakerIsCaptain = utterance.nodeKey === CAPTAIN_KEY
    if (!speakerIsCaptain && input.mode !== 'egalitarian') continue
    const to = (utterance.to ?? '').trim()
    if (to === '' || to === AGGREGATOR_KEY || to === CAPTAIN_KEY) continue
    for (const seat of to === 'all' ? liveSeatKeys : [to]) {
      // 发起者自己不算"被派发"（圆桌制下 A→B 只说明 B 被唤醒了）。
      if (seat === utterance.nodeKey) continue
      if (!dispatched.includes(seat)) dispatched.push(seat)
    }
  }
  // 工作项粒度：三态，而不是"没打标签 = 没派"。
  //   ① tracked      —— 该项被显式打上 work_item 派过了（可核）；
  //   ② untracked    —— 没打标签，但**该项的承接席当轮收到过派发** ⇒ 可能派了但
  //                     没追踪（"不可核"）；
  //   ③ undispatched —— 既没标签、该席当轮也没收到任何派发 ⇒ 真漏派。
  // 把 ② 混进 ③ 就是把"不可核"说成"没做"（本仓库判据口径明确禁止）。
  // 追踪记录**只认本轮**：计划 id 的契约是"本轮内唯一"（跨轮复用合法），
  // 若扫全部轮次，R2 从没派过的 a1 会被 R1 的同名记录冒充成"已追踪" ——
  // 实测过的跨轮假绿（probe：tracked=1，undispatched=[]，应为 0/['a1']）。
  const trackedItems = new Set<string>()
  for (const utterance of utterances) {
    if (utterance.round !== round) continue
    if (utterance.nodeKey !== CAPTAIN_KEY) continue
    const workItem = (utterance.workItem ?? '').trim()
    if (workItem !== '') trackedItems.add(workItem)
  }
  const outstanding = plan === undefined
    ? []
    : plan.items.filter((item) => !trackedItems.has(item.id)).map((item) => ({
        id: item.id,
        owner: item.owner,
        task: item.task,
        // `new:<预设>` 已到场时按到场席位判"该席当轮是否收到过派发"。
        seatReached: splitOwnerRef(item.owner).kind === 'seat'
          ? dispatched.includes(splitOwnerRef(item.owner).value)
          : (onStageByPreset[splitOwnerRef(item.owner).value] ?? []).some((seat) => dispatched.includes(seat)),
      }))
  const undispatchedItems = outstanding
    .filter((item) => !item.seatReached)
    .map(({ id, owner, task }) => ({ id, owner, task }))
  const untrackedItems = outstanding
    .filter((item) => item.seatReached)
    .map(({ id, owner, task }) => ({ id, owner, task }))

  const reconciliation = plan === undefined
    // 没有计划就没有对账对象：此时把"每一个被派发的席"都报成 unplanned 是噪音，
    // 会掩盖真正的信号。缺计划这件事已由 `plan_recorded: false` 单独报出。
    ? { undispatchedOwners: [] as string[], unplannedDispatches: [] as string[] }
    : reconcileDispatches(plannedOwners, dispatched)
  const handoffs = input.mode === 'egalitarian'
    // 圆桌制没有 [越界转派] 协议（专家直接转给同伴并抄送主持人）：
    // 在该模式下收集它 = 报一个本模式不存在的信号。显式置空，不静默走默认。
    ? []
    : collectHandoffs(utterances.map((utterance) => ({
        nodeKey: utterance.nodeKey,
        content: utterance.content,
        round: utterance.round,
      })))
  return {
    round,
    plan_recorded: plan !== undefined,
    planned_owners: plannedOwners,
    planned_waves: scheduled,
    undispatched_owners: reconciliation.undispatchedOwners,
    unplanned_dispatches: reconciliation.unplannedDispatches,
    undispatched_items: undispatchedItems,
    untracked_items: untrackedItems,
    tracked_items: plan === undefined ? 0 : plan.items.filter((item) => trackedItems.has(item.id)).length,
    pending_seats: liveSeatKeys.filter((key) => !utterances.some(
      (utterance) => utterance.round === round && utterance.nodeKey === key,
    )),
    out_of_scope: toHandoffRows(handoffs, HANDOFF_RENDER_LIMIT),
    out_of_scope_total: handoffs.length,
    out_of_scope_hidden: Math.max(0, handoffs.length - HANDOFF_RENDER_LIMIT),
    /*
     * 回归风险自检的**可见面**（2026-09-23 · 用户要求「避免拆东墙补西墙」）。
     *
     * ⚠ 刻意**不判定**：机器判不了"哪条工作项是改动型"——按动词关键词分类是脆弱
     *   启发式（"分析接口" 含"分析"却可能要改代码；"实现 X" 明明是改动却可能被
     *   动词表漏掉），会造出假红假绿。故这里只做**计数与点名**：
     *   把"哪几项没做自检"摆出来 ⇒ 缺口可见 ⇒ 主持人与用户自己判断要不要追问。
     *   这与本插件既有的「留痕字段必须有消费面」是同一取向：不替人下结论，但绝不让
     *   缺口静默消失。
     */
    plan_items: plan === undefined ? 0 : plan.items.length,
    risk_declared: plan === undefined ? 0 : plan.items.filter((item) => (item.regressionRisk ?? '') !== '').length,
    risk_items_missing: plan === undefined
      ? [] as string[]
      : plan.items.filter((item) => (item.regressionRisk ?? '') === '').map((item) => item.id),
  }
}
