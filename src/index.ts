/**
 * RoundTable for DeepSeek Harness — host plugin entry.
 *
 * A host-plane plugin that registers the `roundtable_*` tools and one usage
 * section into the global system prompt. After installation any session can
 * run a visualized round-table meeting through natural language: the model
 * creates a meeting (it becomes the captain), adds expert nodes as durable
 * continuable subagents, wires directed edges, collects contributions through
 * the aggregation gateway, and asks the human when a decision is needed.
 * The Web GUI shows the meeting as a topology tab via the `conversation.view`
 * slot, fed by the `/plugins/dsh-plugin-roundtable/state` snapshot route.
 *
 * @module dsh-plugin-roundtable
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration merge only: makes ctx.llm, ctx.subagents and ctx.systemPrompt visible.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
// 值+类型：`AssembleContext` 给模式段取会话，`ctx.systemPrompt` 靠该包的 merge。
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
// Declaration merge only: 给 `AssembleContext` 补上 `agent`（模式段的唯一输入面）。
import type {} from '@deepseek-ai/dsh-agent'
// Declaration merge only: makes ctx.userQuestions visible.
import type {} from '@deepseek-ai/dsh-user-questions'
// Declaration merge only: makes ctx.skills visible (R2: DSH 原生 skill 能力).
import type {} from '@deepseek-ai/dsh-skill'
// Declaration merge only: makes ctx.commands visible（斜杠命令 /roundtable）。
import type {} from '@deepseek-ai/dsh-commands'
import { registerRoundTableTools } from './tools.ts'
import { collectMeetingSnapshots } from './snapshot.ts'
import { registerRpc, RPC_ROUTE, type RoundTableRuntime } from './rpc.ts'
import { SessionModeTable, modeSectionText, MODE_COMMAND_NAME, runModeCommand } from './mode.ts'
import { setWorkspaceCandidates, workspaceCandidates } from './workspace-candidates.ts'
import { steerCaptain } from './members.ts'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'roundtable'
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt', 'userQuestions', 'skills']

/** Plugin configuration. */
export interface Config {
  /** State directory name under the captain's workspace (default `.roundtable`). */
  stateDir?: string
  /** `ctx.subagents` provider used to spawn nodes (default `spawn`). */
  memberProvider?: string
  /** Meeting size cap in nodes (default `8`). */
  maxNodes?: number
  /** Default collaboration mode (default `orchestrated`; `redteam` = 针锋相对评审). */
  defaultMode?: 'orchestrated' | 'egalitarian' | 'redteam'
  /** Node delegation depth cap (default `1`). */
  memberMaxDepth?: number
  /** Prompt-section order for the usage policy (default `116`). */
  promptSectionOrder?: number
}

export const Config: z<Config> = z.object({
  stateDir: z.string().default('.roundtable'),
  memberProvider: z.string().default('spawn'),
  maxNodes: z.natural().min(1).default(8),
  defaultMode: z.union(['orchestrated', 'egalitarian', 'redteam']).default('orchestrated'),
  memberMaxDepth: z.natural().default(1),
  promptSectionOrder: z.natural().default(116),
})

/** Settings namespace for the runtime-tunable preferences (mode default, budget defaults). */
export const SETTINGS_NAMESPACE = 'roundtable' as const

/** User-tunable preference schema persisted under the `roundtable` namespace. */
const PreferenceSchema = z.object({
  defaultMode: z.union(['orchestrated', 'egalitarian', 'redteam']).default('orchestrated'),
  maxRounds: z.natural().default(10),
  maxTokens: z.natural().default(200_000),
  showAllMeetings: z.boolean().default(true),
  /** 专家每轮输出 token 上限（模型请求 max_tokens），0 = 不限制。 */
  expertMaxTokens: z.natural().default(0),
  /** 专家每轮最多提几条意见，0 = 不限制。 */
  expertMaxOpinions: z.natural().default(0),
  /** E1/E4 反馈：会议结束后是否询问轻量反馈（默认开，可在设置页关闭）。 */
  feedbackEnabled: z.boolean().default(true),
  /** R2.2/D5 skill 传递方式：relay=主持人中转（省 token、可预测）；direct=专家自行调用 `skill` 工具。 */
  skillDelivery: z.union(['relay', 'direct']).default('relay'),
  /** R3 右栏面板可见性：被列出的面板在拓扑页隐藏（空 = 全部显示）。 */
  hiddenPanels: z.array(z.string()).default([]),
  /** B3 用户自建角色预设：设置页维护，专家管理面板一键填充。
   *  刻意**不预置任何内置角色** —— 列表空着，等用户自己建。
   *  注意 schemastery 不强制 required，字段级校验在 rpc.ts 手写。 */
  rolePresets: z.array(z.object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    provider: z.string(),
    model: z.string(),
    /** 可选思考强度（宿主档位 id）；声明为可空字符串，由 rpc.ts 净化。 */
    reasoningEffort: z.string().default(''),
  })).default([]),
  /** B3+：缺省角色预设（**单一缺省值**，沿用宿主 `agent-presets.default` 语义）。
   *  专家管理面板打开时用它预填；空 = 无缺省。指向已删预设时由 rpc.ts 净化清空。 */
  defaultPresetId: z.string().default(''),
})

/** The model-facing usage policy: when and how to drive RoundTable. */
function usageSectionText(toolNames: string): string {
  return `When the user asks to run a round-table meeting (圆桌会议) — e.g. "开个圆桌会议讨论 X", "让几个专家辩论 Y", "use RoundTable to decide Z" — you are the captain (主持人) of a multi-expert meeting. Follow this protocol:
1. NEVER create a meeting straight away. FIRST check whether the request is actually clear enough to meet on — three things must be answerable: what concrete phenomenon to fix (goal), what counts as solved (done-standard), and **what must NOT be touched** (the wall you may not demolish). If you cannot answer any of them FROM THE USER'S OWN WORDS, you are about to paraphrase for them: ask ONE short clarifying question and wait. Measured cost of skipping this (session 690079f3): the captain paraphrased a vague "容量门" into its own definition, ran a full 8-expert meeting, and the user only clarified AFTER it ended — an entire round wasted; the captain's own note read "全仓查无你的原话，只有转述". Then call roundtable_plan_meeting with the meeting name, the goal, the experts you intend to use (key/role/provider/model, only pass provider/model when the user explicitly wants a different route for that expert), and the three boundary fields (boundary_goal / boundary_done / boundary_not_doing — pass what you have; the card warns loudly when they are missing so the user can fill the gap) plus the parameters you derived. It does NOT create anything: it shows the human a readable SETTINGS CARD (roster + mode + budget + knowledge base + selected skills + boundary) and blocks until they answer, returning decision="approved" (create with exactly those values) or decision="revise" with the user's own words — update the draft, keep every unchanged field as-is, and call it again (it will show the revised card with revised=true). Always show the card, even for a single expert. If it returns decision="unavailable", state the draft in words, get explicit agreement, then create.
2. Call roundtable_create only with the confirmed values (name, goal, mode, max_rounds, max_tokens, kb_path, skills, skill_delivery, and the boundary fields boundary_goal/boundary_done/boundary_not_doing so the boundary reaches every expert's charter). ⚠ This is ENFORCED: create refuses a meeting that has no confirmed settings card for that name and tells you to call roundtable_plan_meeting first (measured 2026-09-23: 23% of past meetings bypassed the card). Only a script/probe/verification meeting that genuinely needs no user confirmation may pass skip_plan_card: true — that is recorded as planCardSkipped and shown in roundtable_status, so never use it just to save a step. Default to the user's configured mode (orchestrated unless asked otherwise); for egalitarian mode also bound max_rounds/max_tokens so the debate cannot run away; for "redteam" (针锋相对) the meeting attacks an already-settled plan — experts only find flaws, no alternative proposals.
3. Call roundtable_add_node once per expert role the goal needs (researcher, engineer, reviewer, ...). Nodes are durable subagents that carry the《全局协作总纲》as their persona. R-A: the user maintains self-built role presets (设置 → 圆桌会议 → 角色预设); call roundtable_list_presets FIRST and, when a preset fits, pass its id as \`preset\` to add_node (or reuse its role verbatim) so the meeting runs the text the user actually wrote — do NOT invent a substitute role for a task a preset already covers. If the catalogue is empty, write the role yourself and say it is ad-hoc. By default a node inherits your current provider/model; pass provider/model only when the user explicitly wants a different route for that expert. Never ask the user to pick per node. NOTE (R-D): the roster is NOT frozen at creation — the same preset catalogue is visible every round through roundtable_status.talent_pool, and pulling a seat mid-meeting is the expected move (see rule 16). Roster visibility depends on mode: in egalitarian mode broadcast the current roster with roundtable_send_message to="all" after EVERY add/remove (a node's persona roster is only a spawn-time snapshot); in orchestrated/redteam (single-line) modes the experts do NOT know about each other — never broadcast (the tool rejects it) and never name another expert when you relay. "One node at a time" there means INFORMATION ISOLATION (one recipient per message, no shared roster) — it does NOT mean serial execution: independent work items go out together, one message each.
4. Edges are DECORATION in orchestrated/redteam — do NOT spend calls on them. Measured (2026-09-23 audit of 28 real meetings): in the single-line modes the charter deliberately omits the roster/edges section (experts must not learn about each other), and roundtable_send_message does NOT consult edges — delivery depends only on the roster and the mode policy. So in orchestrated/redteam an edge changes nothing except the picture you and the user see; express ordering with the dispatch plan's depends_on instead, and skip roundtable_connect unless the user explicitly asks for a topology diagram. Only in egalitarian mode do edges reach the experts (the charter lists them and nodes may address each other directly) — there they encode who may talk to whom, so wire them before dispatching.
5. Lead by delegation: send tasks and relayed opinions to nodes with roundtable_send_message, monitor with roundtable_status, and pull the aggregation gateway digest with roundtable_summarize. Do not duplicate a node's work merely because its turn is slow. In orchestrated mode you relay everything; in egalitarian mode nodes debate each other directly and you only referee (watch the budget). Start every round with ONE roundtable_status call and treat its nodes[] as the SOLE authoritative roster (the charter/plan-card rosters are compile-time snapshots and the user may have added or removed experts since): dispatch only to live nodes listed there, and reuse the same call for the pending_actions check (rule 9) and the budget gauge (rule 8) instead of querying twice. That same call carries TWO fields you must actually USE, not just read: (a) talent_pool — the user's whole role-preset catalogue with an ON STAGE flag, i.e. your bench; the roster is not fixed at creation, so when round_signals says a seat is missing, or the round's work needs a competence nobody on stage has, pull one mid-meeting with roundtable_add_node preset=<id> (read its full role text with roundtable_list_presets filter=<kw> first — the pool deliberately ships ids/names only to keep this free); (b) round_signals — plan-vs-actual dispatch reconciliation, the seats that have not spoken yet this round, and the structured [越界转派] backlog: those are the experts' OWN "this needs a different seat" requests, and you must either re-dispatch them to the right seat or fold them into your summary — never drop them.
6. When experts disagree or a decision needs the user, call roundtable_request_decision with the question and option labels (the meeting pauses until the human answers). Before opening the card, poll roundtable_status and confirm every active node's activity is idle/ready with no new utterances pending — never interrupt the human with experts still producing. The options must come from collected output (experts' [建议决策] lines and stated trade-offs), and while the card is open do not narrate anything new to the user. Never decide on the user's behalf.
7. Before handing a goal to a black-box worker model (no visible reasoning, e.g. a video/image model), call roundtable_proxy_think to obtain the director template: write the [DeepSeek 代理思考] reasoning, translate exact parameters, state expectations and fallbacks, so the global thinking chain stays transparent.
8. Watch the budget in roundtable_status. HONESTY RULE: the token figure there is an ESTIMATE OF SPOKEN TEXT ONLY (≈0.6 token per CJK char) — it excludes system prompts, expert personas, conversation history and tool overhead, so it is NOT the real LLM spend. Treat it as a "how much have we said" gauge, not a cost meter, and say so when you report it to the user. A muted (闭麦) meeting can be topped up with roundtable_set_budget. Present the consolidated result, then roundtable_close the meeting.
9. UI edits never touch meeting state directly: expert changes made in the Web UI (add/remove expert) are recorded as pending lines in the meeting's user-actions.jsonl (one JSON per line; read the "text" field). At the start of every round check roundtable_status for pending_actions: when present, execute each line with the matching roundtable_* tool (roundtable_add_node / roundtable_remove_node / ...), and only after EVERY action succeeded call roundtable_actions_clear to empty the file. If one action fails, keep the record and explain the failure in your reply — never clear a partially-executed file. roundtable_actions_clear also reports "malformed": a non-zero count means that many recorded lines were not valid JSON, so those user operations could NOT be executed and are now gone — say so plainly to the user instead of reporting a clean sweep. When the executed lines included an expert add/remove, follow rule 3's broadcast duty — egalitarian mode only: broadcast the roster with roundtable_send_message to="all"; in orchestrated/redteam do NOT broadcast (experts do not know about each other), just dispatch one node at a time.
10. Knowledge-base relay (主持人中转): the meeting's knowledge-base directory is recorded in the meeting state (kb_path, shown in roundtable_status). When an expert needs reference material, YOU read the specific file(s) with your file tools and relay the content to the expert — never copy the whole library. Before reading any KB file, check the "KB digest cache" section of roundtable_status: an entry marked [HIT] means the cached summary still matches the current file contents, so reuse that digest directly and do NOT read the file again — you reading it plus the expert reads it is exactly where the double token cost comes from. Only on a miss (no entry, or [STALE]) read the file, then store the distilled points with roundtable_kb_digest so the next need is free. Keep digests short: they are summaries, not file copies. A "已修改知识库部分内容" pending action means the KB changed: re-browse it to refresh your understanding.
11. Skills (DSH native, v0.2.31): a meeting may carry a skill list (shown as skills in roundtable_status) with a delivery mode of its own (skill_delivery). In "relay" mode YOU read the skill body (ctx.skills.get) and hand the relevant points to the expert — never ask an expert to load it. In "direct" mode each expert loads skills itself with the native \`skill\` tool from the names listed in its persona; do not relay the body. Pick the skills on the settings card from the real catalog; never invent a skill name. If the user asks to add skills mid-meeting, the meeting's own list cannot change — note it and use the relay path for the new material.
12. 针锋相对 (adversarial review): after you and the user settle a concrete plan, ASK whether they want to start this mode. If yes: call roundtable_start_review with the user's original question and the settled plan, then add red-team experts (role 红队审查) whose ONLY job is to attack the plan (no alternative proposals). When the experts have spoken, call roundtable_collect_review to gather their objections into the review record; the Web review window then opens automatically. The user clicks 「支持」 on real flaws and must type a reason when 「驳回」 (驳回必填理由) — endorsements arrive as pending user actions ("用户认定缺陷…"), so treat them as a known-flaws checklist when you revise the plan. After the user finishes and you have revised the plan, call roundtable_finish_review (附上修订说明) to close the pass. Closed loop (闭环复审, C3): a review may run at most 3 passes total (first + up to 2 re-reviews, max_review_pass=3); each re-review is started again with roundtable_start_review and must only check whether the previous pass's endorsed flaws were fixed — do NOT let experts introduce brand-new scoring. When the cap is reached you may continue only after the user explicitly approves (user_approved_extra_pass=true). Present the consolidated result, and export the record with roundtable_export_review into a Markdown deliverable the user can keep or paste into an issue.

13. Exporting the whole meeting: roundtable_export_meeting turns the ENTIRE meeting into a Markdown deliverable — issue-style header (plugin version, mode, time span, budget), goal, expert roster with routes, the decision log, every round of the transcript with speaker → audience, the review record when one exists, and the user's adjustment log. It returns the Markdown to you AND writes it to <meetingDir>/export.md so the user can open the file directly; it also works while the meeting is still running (the header then marks it as an in-progress snapshot). Use roundtable_export_review when only the 针锋相对 record is wanted.

14. SINGLE-OUTPUT DISCIPLINE (主持人单一出口): you are the ONLY voice the user hears from this meeting. Expert nodes cannot use the host's send_message (denied) — their results land in the meeting transcript via roundtable_speak, and the host wakes you with a one-line "subagent settled" notice. When woken by such a notice: pull the digest (roundtable_summarize) or the tail (roundtable_status), absorb each expert's [核心产出] and [建议决策] into your working context, and do NOT relay anything to the user turn-by-turn. Only after the whole round converges (every active node idle/ready, pending_actions handled) present ONE consolidated summary that covers every expert's chosen direction, key trade-offs and conflicts, folding their [建议决策] into roundtable_request_decision options where the user must pick. If a settled notice says a child ended on 'error'/'refusal'/'max-tokens', its transcript entry may be missing or partial — check roundtable_status, and if the node never spoke, either re-dispatch it once or report the gap; never pretend its content was collected. Before roundtable_close you MUST have delivered the final consolidated result to the user — a meeting that ends silently is a failure of your role.

15. Single-line discipline (orchestrated/redteam): you are the ONLY information hub. When relaying an expert's opinion to another, never name the source's key or role (say "另有意见认为…"), and never tell a node who else is in the meeting; when an expert ends a turn with an [越界转派] line, you MUST re-dispatch that item to the seat whose role covers it (or fold it into the summary you give the user) — never drop it. In egalitarian mode experts hand off to each other directly and cc you; just report the hand-off chain in your summary.

16. DISPATCH ANALYSIS IS STRUCTURAL (调度纪律, R-D): "which tasks can run in parallel and which are serial" must be handed over as DATA, not asserted in prose. Every round, call roundtable_next_round ONCE with plan=[{id, task, owner, depends_on, kind}] — with TWO OR MORE live seats an empty plan is REJECTED, so if nobody needs a task this round, do not advance the round at all. Semantics: empty depends_on ⇒ the item dispatches in wave 1 IN PARALLEL with the other empty ones; depends_on lists other ids of the SAME round and pushes the item into a later wave (= 1 + max dependency wave). The tool rejects dependency cycles, dangling ids and unknown/capped seats, and returns waves + gaps. Then act on it literally: dispatch wave 1 right away as several roundtable_send_message calls in ONE turn (that is what parallel means here), tagging each with its work_item=<plan id>, and start a later wave only after every item it depends on has reported back. If an item's owner is "new:<preset id>", the plan lists it under gaps — pull that seat first with roundtable_add_node preset=<id>; that is how the expert bench gets used mid-meeting instead of being frozen at creation. A plan you declare but do not follow is visible in the ledger: roundtable_status.round_signals reports undispatched_owners (seat level) and undispatched_items (work-item level — only exact if you tag work_item=), plus unplanned_dispatches; and roundtable_export_meeting lists every round's plan plus the dispatched rounds that have none.

17. NO ROBBING PETER TO PAY PAUL (拆东墙补西墙 — the user's standing requirement for the WHOLE meeting, not just one step). The wall you may not demolish is the meeting's boundary (\`boundary_not_doing\`, shown in roundtable_status and in every expert's charter). Concretely, for every item in a round plan: (a) fill \`regression_risk\` — one line naming what this work could break and how you will confirm it did not; round_signals reports "regression self-check: N/M item(s)" plus the ids that skipped it, so an empty field is visible rather than silent. For a read-only item write "无回归面（只读）" instead of leaving it blank. (b) When an expert proposes a change, do NOT accept "顺带修好了 X" as a bonus — ask which existing behaviour it touched and what evidence shows that behaviour still holds. A fix that silently changes something else is the exact failure mode this rule exists for. (c) If a change genuinely must cross the boundary, say so BEFORE doing it and get the user's explicit agreement — never redefine the boundary to fit a convenient solution. (d) When you close the meeting, report any boundary violation that happened, with its evidence; a meeting that ends silently about a crossed boundary is worse than one that fails loudly. (e) When you DISPATCH a change, put the anti-patch requirement INTO the task text itself — not just in this protocol: e.g. "改这个功能时同时说明你碰了哪些既有行为、以及凭什么确认它们仍然成立".

18. NO SELF-REVIEW (禁止自产自审 — the user's explicit rule, 2026-09-23). A seat that PRODUCED a change cannot be the seat that JUDGES it: self-review structurally cannot find the wall its own change knocked down (it only knows what it meant to do). Mechanically: declare task types in the plan via \`kind\` — \`change\` (produces a change to code/config/docs/data) and \`review\` (independently judges whether the change is a 拆东墙补西墙 patch or a root-cause fix). The dispatch gate REJECTS a plan where: (i) a \`change\` item has no \`review\` item depending on it; (ii) the review's owner is the same seat as the change's owner (同席自审); (iii) the review's owner also owns any change item this round (交叉自审 — it would judge a peer while its own change is under review). Pick the reviewer by TASK TYPE: the reviewer's competence must MATCH what the change could break. Concretely for software work — a structural/architectural change needs a seat that judges structure; "is this claim actually true" needs a seat that verifies by re-running or reproducing; a change touching credentials/permissions needs a security-minded seat; a change touching stored data or migrations needs a data-minded seat. ⚠ Do NOT treat any preset id as the answer: the user's presets are THEIR list (they rename and delete them, and a given id may not exist at all) — call roundtable_list_presets or read talent_pool and pick whichever seat's role text actually covers the surface the change touches, then say why that seat. If no available seat covers it, write the reviewer's role yourself rather than reusing a mismatched one. \`roundtable_status.round_signals\` reports "independent review: N/M change item(s)" so partial coverage is visible too. When reviews come back, YOU judge: if a review finds the change is a patch, do NOT silently accept it — re-dispatch the fix (new change + new independent review) or put the disagreement to the user. Repeat until the user's directive is actually satisfied.

19. STAY ON THE USER'S DIRECTIVE (锚定用户指令 — 绝对避免偏离). The meeting exists to satisfy ONE thing: what the user actually asked for. \`meeting.userDirective\` stores their RAW wording (not your paraphrase — that is exactly how session 690079f3 wasted a whole round: the captain paraphrased a vague term into its own definition and only learned the real intent after the meeting ended, admitting "全仓查无你的原话，只有转述"). Every round, before dispatching, re-read the user-directive line in \`roundtable_status\` and ask: does this round's work still serve THAT sentence? Your role in the loop is: clarify intent → compose the plan → dispatch → judge the returned results → re-dispatch — repeat until the directive is met. What does NOT count as progress: work that is interesting but not asked for; a question you substituted for theirs; a scope you expanded "while we were at it". If a round's results drift from the directive, stop and pull it back instead of continuing. If the directive genuinely conflicts with what you now believe should be done, put it to the user with roundtable_request_decision — never quietly redefine the goal.

Tools: ${toolNames}`
}

/** Web-server service slice used to register the snapshot route. */
interface WebRouteHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Workspace registry slice used to enumerate state roots. */
interface WorkspaceListHost {
  list(): { title: string; path: string }[]
}

/** Structural service-key candidates (newest first). */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const

export function apply(ctx: Context, config: Config): void {
  const resolved = {
    stateDir: config.stateDir ?? '.roundtable',
    memberProvider: config.memberProvider ?? 'spawn',
    maxNodes: config.maxNodes ?? 8,
    defaultMode: config.defaultMode ?? 'orchestrated',
    memberMaxDepth: config.memberMaxDepth ?? 1,
  }

  // Usage policy into the global system prompt.
  const toolNames = [
    'roundtable_plan_meeting',
    'roundtable_create',
    'roundtable_add_node',
    'roundtable_remove_node',
    'roundtable_list_presets',
    'roundtable_connect',
    'roundtable_disconnect',
    'roundtable_next_round',
    'roundtable_speak',
    'roundtable_send_message',
    'roundtable_summarize',
    'roundtable_request_decision',
    'roundtable_status',
    'roundtable_actions_clear',
    'roundtable_start_review',
    'roundtable_collect_review',
    'roundtable_finish_review',
    'roundtable_export_review',
    'roundtable_export_meeting',
    'roundtable_kb_digest',
    'roundtable_set_budget',
    'roundtable_close',
    'roundtable_proxy_think',
  ].join(', ')
  ctx.systemPrompt.section({
    name: 'roundtable:usage',
    order: config.promptSectionOrder ?? 116,
    text: usageSectionText(toolNames),
  })

  // 会话级「圆桌讨论模式」状态表单例（进程内；见 mode.ts 的边界说明）。
  const modeTable = new SessionModeTable()

  // 模式生效时追加的一段（**按会话**求值：`assemble.agent` 是本次装配的 agent，
  // 缺席（诊断装配）时恒空）。与上面那段的分工：usage 段常驻讲"怎么开会"，
  // 这一段只在模式开着时讲"这条消息现在就按会议处理"。
  ctx.systemPrompt.section({
    name: 'roundtable:mode',
    order: (config.promptSectionOrder ?? 116) + 1,
    text: (assemble: AssembleContext) => {
      const sessionId = String(assemble.agent?.session.id ?? '')
      if (sessionId === '') return ''
      return modeTable.isActive(sessionId) ? modeSectionText() : ''
    },
  })

  // Settings-backed runtime preferences (mode default, budget defaults, expert
  // answer limits). The cordis.yml config is the composition base; the user
  // layer wins. Settings are consumed by the client settings page (via RPC)
  // and by the tools' defaults. Declared before the tools so their lazy
  // getExpertLimits closure can read the live scope.
  const runtime: RoundTableRuntime = {
    scope: undefined,
    stateDir: resolved.stateDir,
    mode: modeTable,
    fallbackPrefs: {
      defaultMode: resolved.defaultMode,
      maxRounds: 10,
      maxTokens: 200_000,
      showAllMeetings: true,
      expertMaxTokens: 0,
      expertMaxOpinions: 0,
      feedbackEnabled: true,
      skillDelivery: 'relay',
      hiddenPanels: [],
      rolePresets: [],
    },
  }

  registerRoundTableTools(ctx, {
    stateDir: resolved.stateDir,
    memberProvider: resolved.memberProvider,
    maxNodes: resolved.maxNodes,
    defaultMode: resolved.defaultMode,
    memberMaxDepth: resolved.memberMaxDepth,
    // 观点拆分 LLM 路由：默认 deepseek-official/deepseek-v4-flash（实测可用），
    // 后续可配置化；不可用时 collect 自动整条兜底（三道防线②）。
    reviewSplit: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      maxOpinions: 3,
    },
    // Read live every spawn so a settings change applies to newly added
    // experts without a restart.
    getExpertLimits: () => {
      const prefs = runtime.scope?.get() ?? runtime.fallbackPrefs
      return {
        maxTokens: prefs.expertMaxTokens ?? 0,
        maxOpinions: prefs.expertMaxOpinions ?? 0,
      }
    },
    // R2.2/D5：skill 传递方式的默认值，读设置页（实时）。
    getSkillDelivery: () => (runtime.scope?.get() ?? runtime.fallbackPrefs).skillDelivery ?? 'relay',
    // R-A 修复：把用户自建角色预设暴露给工具层（实时读取）。
    // 此前预设只被浏览器表单消费，agent 侧拿不到 —— 主持人结构上无法「按预设建节点」。
    getRolePresets: () => (runtime.scope?.get() ?? runtime.fallbackPrefs).rolePresets ?? [],
    // R1 第 3 条：卡片默认值的设置页那一层。
    getPlannedDefaults: () => {
      const prefs = runtime.scope?.get() ?? runtime.fallbackPrefs
      return {
        mode: prefs.defaultMode,
        maxRounds: prefs.maxRounds,
        maxTokens: prefs.maxTokens,
        skillDelivery: prefs.skillDelivery ?? 'relay',
      }
    },
  })
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, PreferenceSchema, {
        base: { defaultMode: resolved.defaultMode },
      }) as unknown as RoundTableRuntime['scope']
      runtime.scope = scope
      scope?.watch((value) => {
        const preference = value as { defaultMode?: 'orchestrated' | 'egalitarian' } | undefined
        if (preference?.defaultMode === 'orchestrated' || preference?.defaultMode === 'egalitarian') {
          resolved.defaultMode = preference.defaultMode
        }
      })
    } catch (error) {
      settingsCtx.logger.warn('roundtable: settings namespace registration failed; preferences fall back to config defaults', error)
    }
  })

  // Browser RPC (preferences, edge edits, KB path, review 表态 …). The same
  // dispatch body is mounted on the plugin's own web route below.
  const dispatchRpc = registerRpc(ctx, runtime)

  // Web surface: the snapshot route AND the RPC route (browser settings page +
  // topology tab edits). Both ride the plugin's own `webServer` registration —
  // the transport that is reliably reachable — instead of depending on the
  // host's generic connection channel. Headless profiles may not mount the web
  // server: register lazily on service availability.
  let webRegistered = false
  let rpcRouteRegistered = false
  const registerWebSurface = (): void => {
    const webServer = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])) as WebRouteHost | undefined
    if (webServer === undefined) return

    // RPC route: needs only the web server, so it mounts on its own.
    if (!rpcRouteRegistered) {
      rpcRouteRegistered = true
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: RPC_ROUTE,
        handler: async (req, res) => {
          // 先序列化再写头：如果 `JSON.stringify` 在 `writeHead` 之后抛错，
          // 宿主只能回一个**空 400** —— 客户端拿不到任何原因（实测：
          // `roundtable/usage.get` 带真实 meetingId 时就是空 400，不带时反而
          // 有正常报文，看起来像"端点时好时坏"）。这里把序列化失败变成可读报文。
          const send = (status: number, body: unknown): void => {
            const headers = {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            }
            let text: string
            try {
              text = JSON.stringify(body)
            } catch (error: unknown) {
              res.writeHead(400, headers)
              res.end(JSON.stringify({
                ok: false,
                error: {
                  code: 'internal',
                  message: `response is not serializable: ${error instanceof Error ? error.message : String(error)}`,
                },
              }))
              return
            }
            res.writeHead(status, headers)
            res.end(text)
          }
          if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
            send(405, { ok: false, error: { code: 'internal', message: 'this route accepts POST only' } })
            return
          }
          let body: unknown
          try {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(chunk as Buffer)
            body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
          } catch {
            send(400, { ok: false, error: { code: 'internal', message: 'body must be JSON' } })
            return
          }
          const message = body as { endpoint?: unknown; payload?: unknown } | null
          if (message === null || typeof message !== 'object' || typeof message.endpoint !== 'string') {
            send(400, { ok: false, error: { code: 'internal', message: 'body must be { endpoint, payload? }' } })
            return
          }
          // dispatch 自身绝不抛错（见 rpc.ts）——但"绝不"是契约不是保证，
          // 这里兜底成可读报文，避免任何意外再次退化成空 400。
          try {
            send(200, await dispatchRpc(message.endpoint, message.payload))
          } catch (error: unknown) {
            send(500, {
              ok: false,
              error: {
                code: 'internal',
                message: `rpc route handler threw: ${error instanceof Error ? error.message : String(error)}`,
              },
            })
          }
        },
      }), 'roundtable: rpc route')
    }

    if (webRegistered) return
    const workspaceRegistry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1])) as WorkspaceListHost | undefined
    if (workspaceRegistry === undefined) return
    webRegistered = true
    const refreshCandidates = (): void => {
      setWorkspaceCandidates(workspaceRegistry.list().map((workspace) => ({
        title: workspace.title,
        path: workspace.path,
      })))
    }
    refreshCandidates()
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-plugin-roundtable/state',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const roots = workspaceCandidates().map((workspace) => ({
          workspace: workspace.title,
          stateRoot: join(workspace.path, resolved.stateDir),
        }))
        const sessionFilter = url.searchParams.get('session') ?? undefined
        // R-D-UI：候选池来自设置页那一层（与 tools.ts 的 getRolePresets 同源），
        // 实时读取 —— 用户新增预设后刷新页面即可看到，无需重启。
        const snapshots = await collectMeetingSnapshots(ctx, roots, sessionFilter, {
          getRolePresets: () => runtime.scope?.get()?.rolePresets ?? runtime.fallbackPrefs.rolePresets ?? [],
        })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({ meetings: snapshots }))
      },
    }), 'roundtable: snapshot route')
  }
  registerWebSurface()
  ctx.on('internal/service', (serviceName) => {
    if (WEB_SERVER_KEYS.includes(serviceName as (typeof WEB_SERVER_KEYS)[number])
      || WORKSPACE_KEYS.includes(serviceName as (typeof WORKSPACE_KEYS)[number])) {
      registerWebSurface()
    }
  })

  // 斜杠命令 `/roundtable`：开启/关闭会话级讨论模式。模式开着时本会话的每条
  // 用户消息都按圆桌会议处理（`roundtable:mode` 提示词段负责说清这条契约）。
  //
  // 用 `ctx.inject(['commands'])` 挂载而非写进 inject 顶层：命令面缺席的组合
  // （无头 profile）插件其余功能照常，只有这条命令不可用 —— 与 index.ts 里
  // settings / webServer 两处的懒挂载同一套路。
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: MODE_COMMAND_NAME,
      description: '开启/关闭圆桌讨论模式（本会话的消息按圆桌会议处理）',
      // 尾部输入：`off` 退模式；其余非空文本当作议题，开模式并转交主持人。
      input: { hint: '[off|议题]' },
      handler: (invocation) => {
        const sessionId = String(invocation.agent.session.id)
        const outcome = runModeCommand(modeTable, sessionId, invocation.rawInput)
        if (outcome.steerText !== '') {
          // 议题作为一条插件来源的用户消息转交主持人：空闲时它会开一个回合，
          // 忙时在最近一个步骤边界插入（steer 的既定语义）。
          //
          // 必须走 `steerCaptain` 并给出**出处**：裸投递会让主持人读不出
          // 「这是用户给的议题」还是「插件自己注入的文本」（2026-09-23 实测
          // 本处曾裸传，与空状态输入框那处同族；封皮现收进 `steerCaptain` 的类型）。
          steerCaptain(invocation.agent, { kind: 'user-topic' }, outcome.steerText)
        }
        return { kind: 'success', text: outcome.text }
      },
    }), 'roundtable: /roundtable command')
  })
}
