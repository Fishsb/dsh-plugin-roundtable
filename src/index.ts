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

import type { Context, Volatile } from '@deepseek-ai/cordis'
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
// 0.1.7 起用户偏好住在插件自己的 volatile Config 里，落盘经 `settings` 服务
// （`SettingsForms.update(entryId, patch)`）。此处为类型 + `Context.settings` 合并。
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
// Declaration merge only: 给 `Fiber` 补上 `entry`（`ctx.fiber.entry` 是取本插件
// profile entry id 的**唯一**途径，Settings 按该 id 定位表单）。上游同做法的
// 插件（dsh-agent-preset-registry / dsh-experimental-speech-to-text）都把
// `cordis-plugin-loader` 列进 dependencies，靠这句 import 触发模块合并。
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { registerRoundTableTools } from './tools.ts'
import { collectMeetingSnapshots } from './snapshot.ts'
import { registerRpc, RPC_ROUTE, type PreferenceStore, type RoundTableRuntime } from './rpc.ts'
import { SessionModeTable, modeSectionText, MODE_COMMAND_NAME, runModeCommand } from './mode.ts'
import { setWorkspaceCandidates, workspaceCandidates } from './workspace-candidates.ts'
import { steerCaptain } from './members.ts'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RolePreset } from './types.ts'

export const name = 'roundtable'
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt', 'userQuestions', 'skills']

/**
 * Plugin configuration.
 *
 * **0.1.7 迁移（ACT-373）**：用户可调偏好不再走 `settings.register(ns, schema)`
 * ——0.1.7 的 `SettingsForms` 已删除 `register`，改为「插件把自己的 Config 字段
 * 标 `.volatile()`，forms 按 profile entry id 暴露」。因此原先那份独立的
 * `PreferenceSchema` 整体折叠进这里的 Config，字段名与浏览器设置页的
 * `roundtable/prefs.*` 载荷**逐字一致**，`settings.update(entryId, patch)` 才能
 * 直接吃下设置页的 patch。
 *
 * `.volatile()` 字段在 `apply` 里是 `Volatile<T>` 引用（不是值），读要 `.get()`；
 * Loader 在写入提交后把新值推进这些引用（`loader/volatile-update`）。
 */
export interface Config {
  /** State directory name under the captain's workspace (default `.roundtable`). */
  stateDir?: string
  /** `ctx.subagents` provider used to spawn nodes (default `spawn`). */
  memberProvider?: string
  /** Meeting size cap in nodes (default `8`). */
  maxNodes?: number
  /** Node delegation depth cap (default `1`). */
  memberMaxDepth?: number
  /** Prompt-section order for the usage policy (default `116`). */
  promptSectionOrder?: number
  /** Default collaboration mode（同时是用户偏好；`redteam` = 针锋相对评审）. */
  defaultMode: Volatile<'orchestrated' | 'egalitarian' | 'redteam'>
  maxRounds: Volatile<number>
  maxTokens: Volatile<number>
  showAllMeetings: Volatile<boolean>
  expertMaxTokens: Volatile<number>
  expertMaxOpinions: Volatile<number>
  feedbackEnabled: Volatile<boolean>
  skillDelivery: Volatile<'relay' | 'direct'>
  hiddenPanels: Volatile<string[]>
  rolePresets: Volatile<RolePreset[]>
  defaultPresetId: Volatile<string>
}

export const Config: z<Config> = z.object({
  stateDir: z.string().default('.roundtable'),
  memberProvider: z.string().default('spawn'),
  maxNodes: z.natural().min(1).default(8),
  memberMaxDepth: z.natural().default(1),
  promptSectionOrder: z.natural().default(116),
  defaultMode: z.union(['orchestrated', 'egalitarian', 'redteam']).default('orchestrated').volatile(),
  /** 默认轮数上限；**0 = 不限制**（该轴永不闭麦）。 */
  maxRounds: z.natural().default(10).volatile(),
  /** 默认 Token 预算上限；**0 = 不限制**（该轴永不闭麦）。 */
  maxTokens: z.natural().default(200_000).volatile(),
  showAllMeetings: z.boolean().default(true).volatile(),
  /** 专家每轮输出 token 上限（模型请求 max_tokens），0 = 不限制。 */
  expertMaxTokens: z.natural().default(0).volatile(),
  /** 专家每轮最多提几条意见，0 = 不限制。 */
  expertMaxOpinions: z.natural().default(0).volatile(),
  /** E1/E4 反馈：会议结束后是否询问轻量反馈（默认开，可在设置页关闭）。 */
  feedbackEnabled: z.boolean().default(true).volatile(),
  /** R2.2/D5 skill 传递方式：relay=主持人中转（省 token、可预测）；direct=专家自行调用 `skill` 工具。 */
  skillDelivery: z.union(['relay', 'direct']).default('relay').volatile(),
  /** R3 右栏面板可见性：被列出的面板在拓扑页隐藏（空 = 全部显示）。 */
  hiddenPanels: z.array(z.string()).default([]).volatile(),
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
  })).default([]).volatile(),
  /** B3+：缺省角色预设（**单一缺省值**，沿用宿主 `agent-presets.default` 语义）。
   *  专家管理面板打开时用它预填；空 = 无缺省。指向已删预设时由 rpc.ts 净化清空。 */
  defaultPresetId: z.string().default('').volatile(),
}) as unknown as z<Config>
/*
 * ⚠ 上面的 `as unknown as` **只**为绕开 schemastery 的泛型不变性：
 * `required(...).default(...)` 推出的 `Partial<Conf>` 与 `Partial<ObjectT<...>>`
 * 在 3.18.4 下不可互相赋值，与 volatile 语义无关（实测：形状完全一致的接口
 * 同样报错）。代价是它**一并关掉了「Config 接口 ↔ schema 字段」的一致性检查**
 * —— 漏一个偏好字段时，编译与运行都不会报警。
 * 该缺口由 `test/settings-contract.test.mjs` 补回（比对 **z.object 的 volatile
 * 字段** ↔ `RoundTablePreferences` 接口字段，并断言 `prefs.get()` 每个字段都从
 * **同名 Config 引用**取值）。注意它不读本接口本身 —— 只在 `Config` 接口里多写
 * 一个无人消费的字段，该测试不会发现（无运行后果，暂不设守）。
 */

/** The model-facing usage policy: when and how to drive RoundTable. */
function usageSectionText(toolNames: string): string {
  return `When the user asks to run a round-table meeting (圆桌会议) — e.g. "开个圆桌会议讨论 X", "让几个专家辩论 Y", "use RoundTable to decide Z" — you are the captain (主持人) of a multi-expert meeting. Follow this protocol:
1. NEVER create a meeting straight away. FIRST check whether the request is actually clear enough to meet on — three things must be answerable: what concrete phenomenon to fix (goal), what counts as solved (done-standard), and **what must NOT be touched** (the wall you may not demolish). If you cannot answer any of them FROM THE USER'S OWN WORDS, you are about to paraphrase for them: ask ONE short clarifying question and wait. Measured cost of skipping this (session 690079f3): the captain paraphrased a vague "容量门" into its own definition, ran a full 8-expert meeting, and the user only clarified AFTER it ended — an entire round wasted; the captain's own note read "全仓查无你的原话，只有转述". Then call roundtable_plan_meeting with the meeting name, the goal, the experts you intend to use (key/role/provider/model, only pass provider/model when the user explicitly wants a different route for that expert), and the four boundary fields (boundary_goal / boundary_done / boundary_check / boundary_not_doing — pass what you have; the card warns loudly when they are missing so the user can fill the gap) plus the parameters you derived. It does NOT create anything: it shows the human a readable SETTINGS CARD (roster + mode + budget + knowledge base + selected skills + boundary) and blocks until they answer, returning decision="approved" (create with exactly those values) or decision="revise" with the user's own words — update the draft, keep every unchanged field as-is, and call it again (it will show the revised card with revised=true). Always show the card, even for a single expert. If it returns decision="unavailable", state the draft in words, get explicit agreement, then create.
2. Call roundtable_create only with the confirmed values (name, goal, mode, max_rounds, max_tokens, kb_path, skills, skill_delivery, and the boundary fields boundary_goal/boundary_done/boundary_check/boundary_not_doing so the boundary reaches every expert's charter). ⚠ This is ENFORCED: create refuses a meeting that has no confirmed settings card for that name and tells you to call roundtable_plan_meeting first (measured 2026-09-23: 23% of past meetings bypassed the card). Only a script/probe/verification meeting that genuinely needs no user confirmation may pass skip_plan_card: true — that is recorded as planCardSkipped and shown in roundtable_status, so never use it just to save a step. Default to the user's configured mode (orchestrated unless asked otherwise); for egalitarian mode also bound max_rounds/max_tokens so the debate cannot run away; for "redteam" (针锋相对) the meeting attacks an already-settled plan — experts only find flaws, no alternative proposals.
3. Call roundtable_add_node once per expert role the goal needs (researcher, engineer, reviewer, ...). Nodes are durable subagents that carry the《全局协作总纲》as their persona. R-A: the user maintains self-built role presets (设置 → 圆桌会议 → 角色预设); call roundtable_list_presets FIRST and, when a preset fits, pass its id as \`preset\` to add_node (or reuse its role verbatim) so the meeting runs the text the user actually wrote — do NOT invent a substitute role for a task a preset already covers. If the catalogue is empty, write the role yourself and say it is ad-hoc. By default a node inherits your current provider/model; pass provider/model only when the user explicitly wants a different route for that expert. Never ask the user to pick per node. NOTE (R-D): the roster is NOT frozen at creation — the same preset catalogue is visible every round through roundtable_status.talent_pool, and pulling a seat mid-meeting is the expected move (see rule 16). Roster visibility depends on mode: in egalitarian mode broadcast the current roster with roundtable_send_message to="all" after EVERY add/remove (a node's persona roster is only a spawn-time snapshot); in orchestrated/redteam (single-line) modes the experts do NOT know about each other — never broadcast (the tool rejects it) and never name another expert when you relay. "One node at a time" there means INFORMATION ISOLATION (one recipient per message, no shared roster) — it does NOT mean serial execution: independent work items go out together, one message each.
4. Edges are DECORATION in orchestrated/redteam — do NOT spend calls on them. Measured (2026-09-23 audit of 28 real meetings): in the single-line modes the charter deliberately omits the roster/edges section (experts must not learn about each other), and roundtable_send_message does NOT consult edges — delivery depends only on the roster and the mode policy. So in orchestrated/redteam an edge changes nothing except the picture you and the user see; express ordering with the dispatch plan's depends_on instead, and skip roundtable_connect unless the user explicitly asks for a topology diagram. Only in egalitarian mode do edges reach the experts (the charter lists them and nodes may address each other directly) — there they encode who may talk to whom, so wire them before dispatching.
5. Lead by delegation: send tasks and relayed opinions to nodes with roundtable_send_message, monitor with roundtable_status, and pull the aggregation gateway digest with roundtable_summarize. Do not duplicate a node's work merely because its turn is slow. In orchestrated mode you relay everything; in egalitarian mode nodes debate each other directly and you only referee (watch the budget). Start every round with ONE roundtable_status call and treat its nodes[] as the SOLE authoritative roster (the charter/plan-card rosters are compile-time snapshots and the user may have added or removed experts since): dispatch only to live nodes listed there, and reuse the same call for the pending_actions check (rule 9) and the budget gauge (rule 8) instead of querying twice. That same call carries TWO fields you must actually USE, not just read: (a) talent_pool — the user's whole role-preset catalogue with an ON STAGE flag, i.e. your bench; the roster is not fixed at creation, so when round_signals says a seat is missing, or the round's work needs a competence nobody on stage has, pull one mid-meeting with roundtable_add_node preset=<id> (read its full role text with roundtable_list_presets filter=<kw> first — the pool deliberately ships ids/names only to keep this free); (b) round_signals — plan-vs-actual dispatch reconciliation, the seats that have not spoken yet this round, and the structured [越界转派] backlog: those are the experts' OWN "this needs a different seat" requests, and you must either re-dispatch them to the right seat or fold them into your summary — never drop them.
6. When experts disagree or a decision needs the user, call roundtable_request_decision with the question and option labels (the meeting pauses until the human answers). Before opening the card, poll roundtable_status and confirm every active node's activity is idle/ready with no new utterances pending — never interrupt the human with experts still producing. The options must come from collected output (experts' [建议决策] lines and stated trade-offs), and while the card is open do not narrate anything new to the user. Never decide on the user's behalf.
7. Before handing a goal to a black-box worker model (no visible reasoning, e.g. a video/image model), call roundtable_proxy_think to obtain the director template: write the [DeepSeek 代理思考] reasoning, translate exact parameters, state expectations and fallbacks, so the global thinking chain stays transparent.
8. Watch the budget in roundtable_status. HONESTY RULE: the token figure there is an ESTIMATE OF SPOKEN TEXT ONLY (≈0.6 token per CJK char) — it excludes system prompts, expert personas, conversation history and tool overhead, so it is NOT the real LLM spend. Treat it as a "how much have we said" gauge, not a cost meter, and say so when you report it to the user. A muted (闭麦) meeting can be topped up with roundtable_set_budget, and **a budget of 0 means UNLIMITED on that axis** (it never mutes; status renders it as ∞) — pass 0 in roundtable_create / roundtable_plan_meeting / roundtable_set_budget only when the user actually asked for no cap, since the budget is the only thing that pauses a runaway debate. Present the consolidated result, then roundtable_close the meeting.
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

20. EXECUTION IS PART OF THE JOB (专家不只审查，还要落地执行 — 2026-09-25 · 用户要求「团队角色不仅审查方案还要做方案落地执行」). A meeting whose goal is to CHANGE something must produce actual changes, not just a critique. The expert surface already carries write/edit/pwsh in **every** mode (P6: \`nodeToolRestriction\` always sends an explicit allow list — write access is no longer a side-effect of the token-saving \`skill_delivery\` switch), and the charter's 执行协议 section is injected whenever the meeting declares a boundary. Your duty as captain: (a) when a round's work is a change, declare it \`kind:"change"\` and let the owning seat **edit the workspace itself** — do NOT accept a prose description of the edit as the deliverable; (b) require the seat to report the actual file paths it touched plus evidence that each pre-existing behaviour still holds (see rule 17b/e) — "顺带修好了" is not evidence; (c) **rebuild and sync** before claiming anything took effect: this plugin runs from \`lib/\` and the host loads the copy under the profile's node_modules, so 「改了 src」 ≠ 「生效」 (P1 — the src→lib→profile chain has three silent breakpoints and \`lib/\` is git-ignored, meaning the drift is invisible in \`git status\`); (d) keep same-wave writes serial: two seats must not touch the same file in one wave — order them with \`depends_on\` (writes serial, reads parallel); (e) if the needed change must cross the meeting's 不许动 wall, STOP and put it to the user — never widen the boundary to fit the change. A change item with no independent \`kind:"review"\` item still violates rule 18 and is rejected regardless of how well it was executed.

Tools: ${toolNames}`
}

/**
 * T3：判定一条 RPC 请求是否应被拒绝，返回 HTTP 状态（401/403）或 undefined（放行）。
 *
 * 两条防线，**任一不通过即拒**：
 *  ① 宿主浏览器鉴权 —— 复用 `connection.requestRejection()`（BrowserAuth），
 *     与宿主 `GET /` 返回 401 的是同一套判据。宿主没挂 connection 时**跳过**
 *     （不因缺件而放行，交给第 ② 条兜底）。
 *  ② 回环兜底 —— 非回环来源一律拒（403）。宿主只监听 127.0.0.1，本路由没有
 *     任何理由接受外部来源；即便 connection 缺席，也不至于变成公开放行。
 *
 * 失败方向是刻意的：**拿不准就拒**。本路由的全部端点都是给浏览器 UI 用的，
 * 不是给同机进程调的命令行接口 —— 后者正是 T3 要挡的形态。
 */
function rejectUnauthenticated(ctx: Context, req: IncomingMessage): 401 | 403 | undefined {
  // ① 宿主浏览器鉴权（若可用）
  const connection = (ctx.get as (key: string) => unknown)('connection') as
    | { requestRejection?: (request: { headers: Record<string, string | string[] | undefined> }) => 401 | 403 | undefined }
    | undefined
  if (connection !== undefined && typeof connection.requestRejection === 'function') {
    try {
      const rejection = connection.requestRejection({ headers: req.headers })
      if (rejection !== undefined) return rejection
      // 宿主明确认通过 ⇒ 放行（不再用回环兜底二次判，避免与宿主判据分叉）
      return undefined
    } catch {
      // 鉴权实现抛错时**不放行**（否则一个内部异常就变成后门）
      return 401
    }
  }
  // ② 回环兜底：非回环来源直接 403
  const remote = req.socket?.remoteAddress ?? ''
  if (!isLoopbackAddress(remote)) return 403
  return undefined
}

/** 回环地址判定（IPv4 / IPv6 / IPv4-mapped IPv6 三种写法）。 */
function isLoopbackAddress(address: string): boolean {
  if (address === '') return false
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === 'localhost'
    || normalized.startsWith('127.')
}

/** Web-server service slice used to register the snapshot route. */
interface WebRouteHost {  register(route: {
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

  // Runtime preferences live in this plugin's OWN volatile Config (0.1.7):
  // the cordis.yml / profile patch is the composition base, the user layer
  // wins, and every field is exposed to the config UI as a form keyed by this
  // entry's profile id. Settings are consumed by the client settings page (via
  // RPC) and by the tools' defaults. Declared before the tools so their lazy
  // `getExpertLimits` closure can read the live references.
  //
  // The store is the single read path: it resolves each field from the volatile
  // reference, so a settings-page write (which the Loader pushes back into these
  // references) is visible to every consumer without a restart.
  const prefs: PreferenceStore = {
    get: () => ({
      defaultMode: config.defaultMode.get(),
      maxRounds: config.maxRounds.get(),
      maxTokens: config.maxTokens.get(),
      showAllMeetings: config.showAllMeetings.get(),
      expertMaxTokens: config.expertMaxTokens.get(),
      expertMaxOpinions: config.expertMaxOpinions.get(),
      feedbackEnabled: config.feedbackEnabled.get(),
      skillDelivery: config.skillDelivery.get(),
      // VolatileSnapshot 递归 readonly（引用保证快照不可变），而
      // RoundTablePreferences 的字段是可变的数组类型 —— 这里拷一份出去，
      // 顺带保证消费方改不动快照（原先 scope.get() 是同一约束的旧写法）。
      hiddenPanels: [...config.hiddenPanels.get()],
      rolePresets: config.rolePresets.get().map((preset) => ({ ...preset })),
      defaultPresetId: config.defaultPresetId.get(),
    }),
  }
  const runtime: RoundTableRuntime = {
    prefs,
    stateDir: resolved.stateDir,
    mode: modeTable,
  }

  registerRoundTableTools(ctx, {
    stateDir: resolved.stateDir,
    memberProvider: resolved.memberProvider,
    maxNodes: resolved.maxNodes,
    // 缺省模式取自 volatile 引用：设置页改了它，**新建**会议立刻用新值。
    defaultMode: config.defaultMode.get(),
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
      const current = prefs.get()
      return {
        maxTokens: current.expertMaxTokens ?? 0,
        maxOpinions: current.expertMaxOpinions ?? 0,
      }
    },
    // R2.2/D5：skill 传递方式的默认值，读设置页（实时）。
    getSkillDelivery: () => prefs.get().skillDelivery ?? 'relay',
    // R-A 修复：把用户自建角色预设暴露给工具层（实时读取）。
    // 此前预设只被浏览器表单消费，agent 侧拿不到 —— 主持人结构上无法「按预设建节点」。
    getRolePresets: () => prefs.get().rolePresets ?? [],
    // R1 第 3 条：卡片默认值的设置页那一层。
    getPlannedDefaults: () => {
      const current = prefs.get()
      return {
        mode: current.defaultMode,
        maxRounds: current.maxRounds,
        maxTokens: current.maxTokens,
        skillDelivery: current.skillDelivery ?? 'relay',
      }
    },
  })
  // Settings surface (0.1.7): the plugin declares NO namespace of its own any
  // more — its volatile Config fields ARE the form. `configure({ auto: false })`
  // is the shipped pattern for plugins that own their UI (the RoundTable tab
  // renders the preferences itself), and it is registered as an effect so a
  // late-starting Settings service still picks the policy up.
  //
  // The write path goes through `runtime.setPrefs`, which needs this entry's
  // profile id — `ctx.fiber.entry?.options.id`, absent when the plugin was
  // mounted without a Loader (then the settings page keeps working read-only
  // and every write is refused loudly instead of silently doing nothing).
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })
  runtime.setPrefs = async (patch: Record<string, unknown>): Promise<void> => {
    const settings = ctx.get('settings') as SettingsForms | undefined
    if (settings === undefined) throw new Error('settings service is not mounted')
    const entryId = ctx.fiber.entry?.options.id
    if (entryId === undefined) throw new Error('this plugin has no profile entry; preferences cannot be persisted')
    await settings.update(entryId, patch)
  }

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
          /*
           * T3（2026-09-25）：复用宿主自身的浏览器鉴权，而不是自造令牌。
           *
           * 实测背景：宿主 webServer 的 `GET /` 返回 **401**（它有鉴权），而本路由
           * 不带任何凭据 `POST` 却返回 **200**——同一进程、同一端口，宿主关起来了、
           * 插件路由完全敞开（`rpc.ts` 的注释自认「真正的身份校验缺口在宿主
           * webServer」，而实测宿主并未兜住）。风险不在"外部攻击者"（宿主只监听
           * 127.0.0.1），而在**在场的专家节点**：它持有 pwsh，一条本机 HTTP 请求即可
           * 调 `user-actions.append` 伪造「用户要求增删专家」，而主持人下一轮会照单
           * 执行 —— 等于借主持人的手改会议本身。
           *
           * 为什么复用宿主而不是自造：`connection.requestRejection()`（宿主
           * dsh-client-connection 的 BrowserAuth）已经是这套系统的浏览器会话鉴权
           * （启动令牌换签 cookie），语义与"浏览器发来的请求"完全一致。自造一份
           * 共享密钥只会多一个要传递、要轮换、可能被同机进程读到的秘密，且与宿主
           * 的鉴权真源分叉成两套。宿主若没挂 `connection`（headless 组合），
           * 退回"只允许回环"——**绝不退回"完全放行"**。
           */
          const rejection = rejectUnauthenticated(ctx, req)
          if (rejection !== undefined) {
            send(rejection, {
              ok: false,
              error: {
                code: 'unauthorized',
                message: `this endpoint requires an authenticated browser session (host WebServer returned ${String(rejection)} for an unauthenticated request); the plugin RPC route is not a public surface`,
              },
            })
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
        // T3 同批：本路由与 RPC 路由是同一暴露类（插件在宿主 webServer 上自注册，
        // 不在宿主的 401 闸门之内）。只修 RPC 而留着它会变成"锁前门留窗户" ——
        // 快照里含全部会议的 transcript 与专家配置，泄露面不比 RPC 小。
        // 用同一把闸：宿主 BrowserAuth（拿不准就拒）。
        const rejection = rejectUnauthenticated(ctx, req)
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            ok: false,
            error: {
              code: 'unauthorized',
              message: `roundtable snapshot route requires an authenticated browser session (host WebServer returned ${String(rejection)} for an unauthenticated request)`,
            },
          }))
          return
        }
        const url = new URL(req.url ?? '/', 'http://x')
        const roots = workspaceCandidates().map((workspace) => ({
          workspace: workspace.title,
          stateRoot: join(workspace.path, resolved.stateDir),
        }))
        const sessionFilter = url.searchParams.get('session') ?? undefined
        // R-D-UI：候选池来自设置页那一层（与 tools.ts 的 getRolePresets 同源），
        // 实时读取 —— 用户新增预设后刷新页面即可看到，无需重启。
        const snapshots = await collectMeetingSnapshots(ctx, roots, sessionFilter, {
          getRolePresets: () => runtime.prefs.get()?.rolePresets ?? [],
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
