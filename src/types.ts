/**
 * RoundTable durable meeting state types.
 *
 * A meeting is one directory under the state root holding `meeting.json`
 * (nodes, edges, decisions, budget, charter) plus a `transcript.jsonl`
 * (utterances). Expert nodes are continuable subagents whose durable child
 * session ids are recorded in the meeting file, so a meeting survives
 * harness restarts.
 * @module dsh-plugin-roundtable/types
 */

/** Collaboration mode: captain orchestrates every exchange, experts talk
 *  peer-to-peer, or a 针锋相对 (red-team) review of a settled plan. */
export type MeetingMode = 'orchestrated' | 'egalitarian' | 'redteam'

/** skill 传递方式（D5）：主持人中转 / 专家直接调用。 */
export type SkillDelivery = 'relay' | 'direct'

/** Meeting lifecycle. `muted` = budget exceeded (闭麦); user may top up or close.
 *
 *  `archived` is a RESERVED state: no code path in this plugin ever writes it
 *  (meeting archiving / read-only mode is deliberately out of scope for this
 *  release). The guards that test for it are kept on purpose — they are
 *  defensive branches, not dead weight, so implementing archiving later cannot
 *  silently miss a call site. */
export type MeetingStatus = 'active' | 'muted' | 'ended' | 'archived'

/** One expert node's lifecycle status. */
export type NodeStatus = 'idle' | 'working' | 'ready' | 'removed'

/** Edge direction: forward (pipeline) or bidirectional (debate channel). */
export type EdgeDirection = 'forward' | 'bidirectional'

/** What one transcript line records. */
export type UtteranceKind = 'speech' | 'proxy-thinking' | 'retrieval' | 'decision'

/** Node statuses that still count as participants. */
export const ACTIVE_NODE_STATUSES: readonly NodeStatus[] = ['idle', 'working', 'ready']

/** Reserved speaker key of the captain (the owning session). */
export const CAPTAIN_KEY = 'captain'

/** Reserved speaker key of the aggregation gateway. */
export const AGGREGATOR_KEY = 'aggregator'

/** One expert node: a continuable subagent plus its meeting-side record. */
export interface MeetingNode {
  /** Durable continuable subagent session id (empty until spawned). */
  id: string
  /** Unique display key inside the meeting (used by edges and mailboxes). */
  key: string
  /** Role description, e.g. `researcher`, `engineer`, `reviewer`. */
  role?: string
  /** R-D：该席由哪条用户预设拉起来（`add_node.preset` 解析成功时记录）。
   *  用途：候选池要能回答"这条预设现在是否已在场"——没有这个字段就只能
   *  按 role 文本比对，那是猜。临时写的角色（未用预设）留空。 */
  presetId?: string
  /** Resolved LLM provider route captured when this node was created. */
  provider?: string
  /** Resolved model captured when this node was created. */
  model?: string
  /** Resolved reasoning effort captured when this node was created.
   *  An adapter-owned opaque id (e.g. `high` / `medium` / `low` — the exact
   *  vocabulary belongs to the model capability, not to this plugin). Read by
   *  `spawnNode` into `agentOptions.reasoningEffort` and surfaced by
   *  `roundtable_status`; absent = inherit the captain's route-owned effort. */
  reasoningEffort?: string
  status: NodeStatus
  joinedAt: number
}

/** One directed channel between two participants. */
export interface MeetingEdge {
  id: string
  /** Node key, or `captain` / `aggregator`. */
  from: string
  /** Node key, or `captain` / `aggregator`. */
  to: string
  direction: EdgeDirection
  createdAt: number
}

/** One line of the meeting transcript. */
export interface MeetingUtterance {
  id: string
  /** Speaker: a node key or `captain`. */
  nodeKey: string
  kind: UtteranceKind
  content: string
  /** Gateway-produced structured summary (set by `roundtable_summarize`). */
  summary?: string
  /** Directed audience (absent = submitted to the gateway). */
  to?: string
  /**
   * R-D：这条发言派发的是本轮计划里的哪个工作项（`roundtable_send_message`
   * 的可选 `work_item`）。
   *
   * 为什么需要它：**席位粒度**的对账回答不了"同一席位有两个工作项、其中一个
   * 没派" —— 实测中 a1/a3 都归 verify，只派 a1 时席位口径全绿。带上工作项 id
   * 才能把"计划被真的跟到底"变成可机检事实。留空 = 未按项追踪（追问、转达意见
   * 等本来就不属于任何工作项）。
   */
  workItem?: string
  /**
   * 这条发言的**来源**：`user` = 用户在群聊窗口里亲自说的。
   *
   * 为什么需要它：`nodeKey` 只有 `captain` 一个身份位，用户在群聊里发言也走
   * `captain` 身份（他就是主持人本人）。不加这个标记，主持人下一轮读 transcript
   * 时**无法区分「用户亲口说的」与「我自己说的」**，会把用户的话当成自己的话，
   * 长期产生归因错误。缺席 = 主持人/专家经由 `roundtable_speak` 写下。
   */
  source?: 'user'
  round: number
  ts: number
}

/** One human decision requested by the captain. */
export interface MeetingDecision {
  id: string
  question: string
  /** Option labels offered to the user (方案 A / B / ...). */
  options: string[]
  chosen?: string
  customAnswer?: string
  status: 'pending' | 'resolved'
  ts: number
}

/** Round/token budget; exceeding either mutes the meeting. */
export interface MeetingBudget {
  maxRounds: number
  maxTokens: number
  usedRounds: number
  usedTokens: number
}

/** 一轮调度计划的一条工作项（R-D，持久化在 `Meeting.roundPlans` 里）。
 *
 *  这是"并行/串行"的**唯一权威表达**：`dependsOn` 为空 ⇒ 与同为空的项同波
 *  并行；非空 ⇒ 波次 = 1 + max(依赖波次)。校验与波次计算见 `dispatch.ts`。 */
/**
 * 工作项的**任务类型**（2026-09-23 · 用户要求「根据任务类型应该有一个专门做审查的」）。
 *
 * 为什么是**显式声明**而不是机器推断：曾拟按动词关键词自动分类（"分析"/"实现"/"修复"），
 * 主动放弃——分类启发式会造出假红假绿（"分析接口"可能要改代码，"实现 X"可能被动词表漏掉）。
 * 由主持人显式声明，机器只做**确定性对账**：声明的改动有没有被独立审查。
 *
 * - `change`  = 会产生改动的项（改代码/配置/文档/数据）⇒ **要求独立审查**
 * - `review`  = 独立审查项：判"这是拆东墙补西墙打补丁，还是从根因解决"
 * - `survey`  = 只读勘察/取证，无改动面
 *
 * 缺省省略 = 主持人未声明类型（`round_signals` 记为 unspecified，**可见但不拦截**——
 * 机器判不了未声明项有没有改动面，故不替人下结论）。
 */
export type PlanItemKind = 'change' | 'review' | 'survey'

export interface RoundPlanItem {
  /** 工作项 id：**本轮内**唯一，供同轮其他项引用。 */
  id: string
  /** 做什么（一句话，可核）。 */
  task: string
  /** 承接席：在场节点 key，或 `new:<预设 id>`（本轮需新拉该预设）。 */
  owner: string
  /** 必须先完成的工作项 id（空 = 可并行）。 */
  dependsOn: string[]
  /**
   * 任务类型（2026-09-23）。`change` ⇒ 该项的产出必须在**另一席**被独立审查，
   * 且审查项须声明 `kind:'review'` 且 `owner` **不是**任何 change 项的 owner。
   */
  kind?: PlanItemKind
  /**
   * **回归风险自检**（2026-09-23 · 用户要求「避免拆东墙补西墙」）。
   *
   * 填这条改动**可能碰坏什么**（哪个既有行为/文件/判据），以及打算怎么确认没碰坏。
   * 缺省省略 = 主持人未做该自检。
   *
   * ⚠ **语义边界（刻意不做成硬门）**：
   *  ① 机器**判不了**"这条是否真风险"，也**判不了**"哪条是改动型工作"——
   *     按动词关键词分类是脆弱启发式，会造出假红假绿（本插件反复在剿的形态）。
   *     故本字段**只呈现、不判定**：`round_signals` 会列出"哪几项没做自检"，
   *     让缺口**可见**，由人/主持人决定要不要追问。
   *  ② 不做成必填：很多工作项（读代码、查资料）**没有回归面**，强制填写会逼出
   *     "无风险"这类凑数文字，反而使真风险淹没——那正是「为不存在的需求付出的复杂度」。
   */
  regressionRisk?: string
  /**
   * **本项会碰的文件面**（P5，2026-09-25 · 归属留痕）。
   *
   * 为什么需要：现状下"谁改了哪个文件"在**结构上**不可知 —— 宿主唯一做
   * 「每轮改动清单 + 前后树快照」的插件对 `origin === 'subagent'` 一律返回
   * undefined（子代理被主动排除），转录里也只有自由文本。于是两席同波次改同一
   * 文件时，没人分得清是谁改的；用户验收看到的是一团无主的 diff。
   *
   * 语义（与 `regressionRisk` 一致的**只呈现不判定**取向）：
   *  · 主持人声明本项**打算**碰哪些文件（路径或 glob）；
   *  · `round_signals` 据此报出「同波次内文件面重叠」的项对 —— 这是**并发写冲突
   *    的可见面**，不是硬门。真正要串行时用 `dependsOn` 把后者推到下一波。
   *  · 缺省省略 = 未声明，`round_signals` 记为未声明项（缺口可见，不静默）。
   */
  files?: string[]
}

/** 落账的一轮计划（主持人推进轮次时提交，超预算闭麦也保留）。 */
export interface RoundPlan {
  round: number
  items: RoundPlanItem[]
  /** 主持人一句话本轮意图（可选）。 */
  note?: string
  createdAt: number
}

/**
 * 会议**边界声明**（2026-09-23 · 用户全流程要求）。
 *
 * 判因（用户原话）：「主持人接收到消息后，如果边界不清晰或者目标模糊，
 * **要先和用户沟通明确边界/方向/目标**，再开始后续流程」，且「整个会议过程
 * 要**避免方案拆东墙补西墙**」。
 *
 * 两项要求收敛到**同一个结构**（不新增抽象层）：
 *  - `goal`      = 要解决的具体现象（目标）
 *  - `done`      = 判定「已解决」的标准（方向）
 *  - `notDoing`  = **明确不做 / 不许动的**（= 「不许拆的那面墙」）
 *
 * ⇒ 边界不清 = 主持人**填不出这三项**（必须回去问用户，不得自行转述后开工）；
 *   防拆东墙 = 每次改动都要对照 `notDoing` 自检「有没有把别处弄坏」。
 *
 * 与用户自建项目治理的 `nav_set(doing/next/notDoing/exit)` **同构**——沿用
 * 用户既有的方法论，不是本插件另造一套。
 *
 * ⚠ 实测教训（会话 `690079f3`）：主持人把用户含糊的「容量门」**自行转述**成
 *   一个具体定义后直接开会，会议结束后才澄清，付出一整轮作废的代价。
 *   主持人当时自认：「全仓查无你的原话，只有转述」。
 */
export interface MeetingBoundary {
  /** 要解决的具体现象/问题（用户视角，非工程视角）。 */
  goal: string
  /** 判定「已解决」的标准：什么情况下算完成。 */
  done: string
  /** 明确不做 / 不许动的范围（= 不许拆的那面墙）。 */
  notDoing: string
  /**
   * 「怎么检查」——判据落成**可执行的检查方式**（命令 / 字节比对 / 审计态）。
   *
   * 2026-09-23 吸收 P10 CTO「战略输入模板」中的 *成功标准须可量化*（来源
   * `tanweai/pua` 的 `skills/pua/references/p10-protocol.md`）。P10 要求
   * 「可量化的最终结果，不是过程指标」，本字段就是它的落点。
   *
   * ⚠ 为什么是**新增第四个字段**而不是"给 done 做模糊词判定"：
   * 按「性能良好 / 体验流畅」这类词表判红是**分类启发式**，本项目已明令禁止
   * （见 `test/double-truth-guards.test.mjs` ⑦-c：'regression_risk 不得做成
   * 脆弱启发式（只呈现不判定）'）。启发式会造出假红假绿——那正是本插件反复剿的形态。
   * 改采**结构性**判据：不问"done 写得够不够量化"（机器判不了），而问
   * "有没有写下检查方式"（存在性，确定性可判）。措辞由用户与专家评判。
   *
   * 缺省 = ''（未声明）。空串与缺省同义，防"填了空字符串冒充已量化"。
   */
  check: string
}

/**
 * One pending user action recorded by the Web UI (`user-actions.jsonl`).
 *
 * The UI never mutates meeting state directly: an expert edit (add/remove)
 * is appended here as a pending action, the captain (主持人) drains the file
 * next round through `roundtable_*` tools, and only clears it after every
 * line was executed successfully. Empty file = no pending work.
 */
export interface UserAction {
  id: string
  ts: number
  /** What the captain must do: add an expert node / remove one / other. */
  kind: 'add-node' | 'remove-node' | 'kb-path' | 'other'
  /** Target node key when the action concerns one expert. */
  nodeKey?: string
  /** Role text captured for an add-node action. */
  role?: string
  /** Provider route captured for an add-node action (empty = inherit captain). */
  provider?: string
  /** Model captured for an add-node action (empty = inherit captain). */
  model?: string
  /** Reasoning effort captured for an add-node action (empty = inherit captain). */
  reasoningEffort?: string
  /** Human-readable sentence, e.g. "删除了专家 researcher". */
  text: string
}

/** 用户自建的角色预设（B3）。
 *
 *  全局偏好（`settings.yaml` 的 `roundtable` 命名空间），不属于任何一场会议：
 *  新建/编辑/删除预设都不会影响已创建的会议。它只是"专家管理"表单的填充
 *  来源 —— 选中后把 role/provider/model 三个字段写进同一条 `add-node`
 *  user-action，链路与手填完全一致（不需要新链路）。 */
export interface RolePreset {
  /** 稳定 id（新建时生成；编辑与删除都按 id 定位）。 */
  id: string
  /** 预设名称，如"安全审查"。 */
  name: string
  /** 角色说明，最终写进专家节点的 role。 */
  role: string
  /** 可选 LLM provider 路由；必须与 model 同时给出才生效。空 = 继承主持人。 */
  provider?: string
  /** 可选模型名；空 = 继承主持人。 */
  model?: string
  /** 可选思考强度（宿主 reasoning effort 的不透明 id，如 `high`）。
   *
   *  空 / 缺席 = 继承主持人的 route-owned effort —— 与 provider/model 的
   *  「成对才生效」不同，effort 可单独给出（只改档位、不改路由）。档位词表
   *  由 `roundtable/models.list` 逐模型下发，插件不自造枚举。 */
  reasoningEffort?: string
}

/** 知识库摘要缓存（C2）的一条条目。
 *
 *  失效键 = `path + size + mtimeMs`：任一变化即视为失效。宿主
 *  `listKbDirectory()` 本来就在 stat 每个条目，所以比对不产生额外 IO。
 *  本插件**不自己调 LLM 生成摘要** —— digest 由主持人读过文件后写下，
 *  缓存只负责"命中就不必再读第二遍"（你读 + 专家读 = 双倍 token）。 */
export interface KbDigestEntry {
  /** 知识库中被读取条目的绝对路径。 */
  path: string
  /** 失效键：写摘要时的文件大小（字节）。 */
  size: number
  /** 失效键：写摘要时的修改时间（ms）。 */
  mtimeMs: number
  /** 主持人写下的要点摘要（不是全文）。 */
  digest: string
  /** 摘要写入时间（ms），超限时按最旧淘汰。 */
  ts: number
}

/** `<meetingDir>/kb-digest.json` 的形状（独立文件，避开 meeting.json 竞态）。 */
export interface KbDigestFile {
  meetingId: string
  entries: KbDigestEntry[]
  updatedAt: number
}

/** The full durable meeting record (transcript lives in transcript.jsonl). */
export interface Meeting {
  /** Sanitized stable id; the meeting directory name. */
  id: string
  name: string
  /** Meeting background and goal (charter section one). */
  goal: string
  mode: MeetingMode
  /** Session id of the captain (DeepSeek) that owns this meeting. */
  captainSessionId: string
  /** The injected《全局协作总纲》. */
  charter: string
  nodes: MeetingNode[]
  edges: MeetingEdge[]
  decisions: MeetingDecision[]
  budget: MeetingBudget
  /** Current debate round. */
  round: number
  /** R-D：历轮调度计划（按轮升序）。**这是"主持人做过并行/串行分析"的唯一
   *  机检证据** —— 没有它，主持人的"我分析过了"无法与"一把抓全下发"区分。
   *  缺省（旧会议）= 未记录任何计划，status 会显式标为 unplanned。 */
  roundPlans?: RoundPlan[]
  /** 知识库目录（阅览版）：主持人按需读取其中文件转交专家。空 = 未设置。 */
  kbPath?: string
  /** 本次会议选中的 skill 名称清单（来自 `ctx.skills.list()`）；空/缺省 = 未选。 */
  skills?: string[]
  /** skill 传递方式（创建时固化）：relay=主持人中转；direct=专家自行调用。 */
  skillDelivery?: SkillDelivery
  /** 会议边界声明（2026-09-23）：边界不清时**不得开工**，先回问用户。缺省 = 未声明（旧会议）。 */
  boundary?: MeetingBoundary
  /**
   * **用户原话留档**（2026-09-23 · 用户要求「以用户的会话指令为核心，绝对要避免偏离用户指令」）。
   *
   * 会议 goal 是**主持人转述**过的版本；本条存用户**未加工的原始指令**，
   * 供每轮对照核查"我们还在解用户问的那个问题吗"。
   *
   * 判因（实测 · 会话 690079f3）：主持人把含糊的「容量门」转述成自己的定义后开工，
   * 会议结束后才发现要解的不是那个问题，一整轮作废；主持人自认「全仓查无你的原话，
   * 只有转述」——**转述一旦覆盖原话，偏离就无法被发现**。
   */
  userDirective?: string
  status: MeetingStatus
  /**
   * R1 留痕（2026-09-23 审计）：本场会议**跳过了设置卡**（`create` 带
   * `skip_plan_card: true`）——用户从未通过 `roundtable_plan_meeting` 确认过
   * 席位/预算/模式。缺省省略（正常流程不写此字段）。
   *
   * 用途：让"这场会议没让用户确认过"成为**事后可查**的事实。审计实测绕过率
   * 8/35 = 23%，此前**无任何信号**能分辨——与那次圆桌会议诊断守藏项目得到的
   * 「留痕字段必须有消费面」是同族缺陷。
   */
  planCardSkipped?: boolean
  createdAt: number
  updatedAt: number
}

/** 观点证据分级（C1）：代码/bug 类缺陷须给可复现步骤；设计类缺陷给论证链。 */
export interface ReviewEvidence {
  /** 证据类型：repro=可复现步骤；argument=论证链（设计类缺陷适用）。 */
  kind: 'repro' | 'argument'
  /** 证据正文：复现步骤（1. 2. 3.）或论证链。≤600 字符。 */
  text: string
}

/** 针锋相对评审：一个观点（红队专家提的一条缺陷，可能是发言拆分而来）。 */
export interface ReviewViewpoint {
  /** 行 id：`${utteranceId}#${seq}`（拆分后 seq≥1；未拆分整条 seq=0）。 */
  id: string
  /** 来源发言 id（collect 幂等键：同一发言只收集一次）。 */
  utteranceId: string
  /** 提出该观点的专家节点 key。 */
  nodeKey: string
  /** 缺陷内容（单条观点文本）。 */
  content: string
  /** 三态：pending=未操作；endorsed=用户支持认定为真实缺陷；rejected=用户审阅后否定。可互切。 */
  status: 'pending' | 'endorsed' | 'rejected'
  /** 驳回理由（C2：驳回必填；支持后改回 pending/rejected 不清除，供追溯）。 */
  rejectReason?: string
  /** 证据分级（C1）：LLM 拆分时按发言内容提取；无则 undefined。 */
  evidence?: ReviewEvidence
  /** 观点对应的原文引用子串（≤120 字符，无则 undefined）。 */
  quote?: string
  /** 维度标签（自由字符串，默认"其他"）。 */
  dimension: string
  ts: number
  /** 发言内序号：0=整条未拆分；≥1=拆分出的第 N 条。 */
  seq: number
}

/** 一轮已完成的评审快照（闭环复审 history 项）。 */
export interface ReviewPassSnapshot {
  pass: number
  question: string
  plan: string
  viewpoints: ReviewViewpoint[]
  finishedAt: number
  /** 该轮修订说明（主持人 finish_review 时附，供下一轮核对旧缺陷是否修复）。 */
  revisedPlanSummary?: string
}

/** 一条轻量用户反馈（E1/E3，工作区级 feedback.jsonl，匿名）。
 *  只记录结构化使用事实 + 用户主动填写的一句说明；绝不记录对话内容。 */
export interface FeedbackEntry {
  id: string
  ts: number
  /** 会议 id（仅稳定 id，不存会议名/内容，便于去重）。 */
  meetingId: string
  /** 协作模式（orchestrated / egalitarian / redteam）。 */
  mode: string
  /** 专家 provider 去重列表（如 ["zai-coding-cn"]）。 */
  providers: string[]
  /** 专家 model 去重列表（如 ["glm-5.2"]）。 */
  models: string[]
  /** 会议结束时预算用量。 */
  usedRounds: number
  usedTokens: number
  /** 1 键有用度：good / meh / bad。 */
  rating: 'good' | 'meh' | 'bad'
  /** 可选一句"最卡的点"（用户主动填写）。 */
  note?: string
}

/** 针锋相对评审记录（`<meetingDir>/review.json`，独立文件防 meeting.json 竞态）。 */
export interface ReviewRecord {
  meetingId: string
  /** 用户最初提出的问题。 */
  question: string
  /** 主持人提供的方案与说明。 */
  plan: string
  /** reviewing=评审进行中；ready=观点已收集，弹窗可展示；done=用户完成评审。 */
  status: 'reviewing' | 'ready' | 'done'
  /** 闭环复审（C3）：当前第几轮评审（首轮 = 1；每轮定稿后再开下一轮 +1）。 */
  reviewPass: number
  /** 闭环复审（C3）：最大评审轮数（首轮 + 最多复审 2 次 = 3）；达到上限后再想继续须用户显式批准。 */
  maxReviewPass: number
  /** 之前各轮已定稿的评审快照（闭环核对"旧缺陷是否修复"的依据）。 */
  history: ReviewPassSnapshot[]
  /** schema 版本：1=旧（endorsed 布尔）；2=三态 + 观点拆分（当前）。缺失视为 1。 */
  schemaVersion: 1 | 2
  viewpoints: ReviewViewpoint[]
  startedAt: number
  updatedAt: number
  /** 完成评审的时间（status → done 时写）。 */
  finishedAt?: number
}
