/**
 * 落点纪律守卫（2026-09-23 · 用户点明「项目是项目，角色预设是角色预设」）。
 *
 * ══ 判因（实测我自己的两次越位）════════════════════════════════════════════
 *  ① src/tools.ts 的 close 提示曾让主持人去用 'dispute' 预设 —— 而用户 28 席里
 *     **并没有这个预设**（幽灵引用）。主持人照做会扑空。
 *  ② src/index.ts 的 usage rule 18 曾把 'arch'/'verify'/'repro'… 当"标准答案"列出来。
 *  二者都把**用户的可变资产**（预设库可改名、可删除、可清空）写进了项目源码。
 *
 * ══ 判据演进（每一次都被实测打回，留档以免重犯）════════════════════════════════
 * **v1「带引号的预设 id」⇒ 大量假阳性**：'redteam'（模式枚举）、'repro'（证据类型）、
 *   'user'（来源字段）与某些预设 id **同名碰撞**，但它们与预设毫无关系。
 *
 * **v2「反引号包裹的预设 id」⇒ 对"幽灵引用"结构性失明**：它遍历**用户现有的** id 集，
 *   而 'dispute' **不在**那个集合里（那正是"引用了一个不存在的预设"的定义）
 *   ⇒ 恰恰抓不到它本该抓的那一类。**判据方向是反的。**
 *
 * **v3「必须能在用户的预设库里解析到」⇒ 被真源漂移打穿**：
 *   2026-09-25 实测：它读的 ~/.dsh/settings.yaml 在本机**不存在**（只剩 .bak-* 与
 *   .imported），于是 'if (!existsSync(SETTINGS)) return undefined' 命中，走
 *   'console.log(...) + return' ⇒ 全绿，且 **pass 2 / fail 0 / skipped 0** —— 它不是
 *   t.skip()，测试框架看不见它空转，**空转被计入 pass 计数**。
 *   ⚠ 根因不是「路径写错」，而是这条守卫把判据挂在了一个属于用户的可变资产路径上。
 *
 * **v4「席 id 形态 token 一律判红」⇒ 自检是双真相（声明 A、实检 B）**：
 *   v4 的 model-facing 扫描本身是有效的，但它附带的那条"守卫自身不得依赖用户家目录"
 *   的自检**只做字符串匹配**（import 清单字面量 + 禁用词字面量），却对外宣称
 *   「**结构上**拼不出家目录路径」。2026-09-25 三名独立审查席实测出三条绕过，跑完
 *   **自检全绿**：
 *     ① 别名穿透：'import { existsSync as fileExists } from "node:fs"' + 路径拆成
 *        'settings' + '.yaml' 两段 —— import 清单字面量不变、禁用词不成词；
 *     ② 环境门回归：'if (process.env.USERPROFILE === undefined) return undefined'
 *        + 同款拼接路径 —— 零 import 变更，字面量检查完全无感；
 *     ③ 动态 import + 计算成员 + 拼接路径：'await import("no" + "de:os")' +
 *        os['home' + 'dir']() + 拼接路径 + 'console.log("silent pass"); return'
 *        —— 既无静态 import，也无禁用词字面量。
 *   ⇒ 这是本仓最忌讳的**双真相**：声明说的是一件事（运行时能力），实检做的是另一件事
 *     （源码字面量）。**v5 的处理不是把声明改软，而是把实检换成真的那件事。**
 *
 * ══ v6（本版）"裁决真的在裁"：合成正控 + 跨轮投毒 ═══════════════════════════════
 *  v5 补上读数行后，verify 席又实测出**读数只证"扫过"、不证"判过"**，三条具名反例：
 *    · 3a 删整段断言体（函数体只剩 return）；
 *    · 3b 只删 `assert.deepEqual(offenders, [])`（读数与 `judge()` 都还在）；
 *    · 3c 把 `judge()` 短路成 `return []`，**读数与统计全真、tokens 含被注入的幽灵**。
 *  v5 对这**三条全绿**（实测，见发言）。v6 用两道互补的正控堵：
 *    ① **合成正控（文件内）**：同一份 `judge()` 喂一段**已知含幽灵**的合成散文，必须返回
 *       非空违规且点名该幽灵 ⇒ 抓 3c。
 *    ② **跨轮投毒（跨进程）**：外层往扫描面注入一段含幽灵的合成散文（`PLD_POISON_FILE`），
 *       并要求受限轮**必须因此判红** ⇒ 抓 3b —— 3b 在**不投毒**时与"断言还在"完全不可区分
 *       （真实源码本来就干净），只有"把已知脏数据喂进去看它会不会红"才能分辨。
 *  实测：三条在加正控前**全绿**（3b/3c）、加后**全红**（3a: not ok 4 / 3b: not ok 4 / 3c: not ok 1）。
 *
 * ══ v5 能力面自检：判据只依赖**运行时事实**，不再依赖字面量 ═══════════════
 *  · 第 3 条 test 降级为**静态形态检查**，标题与说明按事实写死：
 *    「只拦无意回归，拦不住蓄意改写」，并列出已知绕过形态（就是上面三条）。
 *    **不再声称任何"结构性"结论** —— 声明与实检必须是同一件事。
 *  · 第 4 条 test 是**能力判据**（真的在跑，每轮全量测试都跑）：
 *    用 Node 的权限模型（'--permission --allow-fs-read=<仓库>\*'）把**用户家目录
 *    整体设为不可读**，然后**真的再把本文件当测试跑一遍**，断言：
 *      (a) 正控：家目录读取在本进程内确实被判 ERR_ACCESS_DENIED（能力真的被剥夺，
 *          不是"环境恰好没问题"）；同一进程读**仓库内**文件仍然成功（环境没被搞坏）；
 *      (b) 被限制的那一轮 exit=0，且**主扫描测试是 ok 而不是 SKIP**（不许拿跳过换绿）；
 *      (c) **边界正控**：受限轮里 os.homedir() 与 USERPROFILE 仍照常返回 —— 明写本判据
 *          证的是"读不到用户资产"，**不是**"进程内不存在家目录路径"（后者做不到，也不声称）；
 *      (d) ⚠ **工作产物回执（本版新增，u1 的修复点）**：只断言 TAP 行**挡不住掏空** ——
 *          把主扫描 test 的函数体首行换成 `return`，它照样产出一条合法 `ok` 行（实测：掏空 +
 *          真幽灵 `zz-min-ghost` 在位，四条仍全绿——这是 v4「跳过与验过不可分辨」的病从外层
 *          搬到了内层）。故主扫描 test 现在**回传一行机器可读读数**
 *          `# PLD-SCANNED files=N lines=L tokens=T`（由真实扫描算出），外层断言该行存在且
 *          N/L/T 均为正整数、files≥2、lines>100。掏空函数体 = 拿不到这一行 ⇒ 判红。
 *          该读数**拦不住照抄伪造**（已登记为未覆盖 (v)），但把「静默掏空」这条最廉价的绕过堵死了。
 *    为什么这比字面量检查强：拦的是**能力**（系统调用层能不能真读到），不是写法。
 *    实测（2026-09-25，把三条绕过**就地改写进本文件**后重跑）：
 *      · 静态第 3 条：①别名/②环境门/③动态+计算成员 **三条全部判绿**（只要路径分段拼接，连续
 *        字面量就不存在）⇒ 静态漏网是事实，已登记，不再宣称任何结构结论。
 *      · 能力判据：三条绕过**全部判红** —— 它们在模块级读家目录且**未捕获**，受限子进程当场
 *        崩掉 ⇒ 不受限轮里那条 test 判红（实测 `not ok 4`，`code: 'ERR_ACCESS_DENIED'`），
 *        受限轮 exit=1。（红队另测到 `not ok 3` 的布局，取决于注入落点，非判据差异。）
 *        ⚠ **但这不等于"凡读家目录都判红"**：见下一条「未覆盖 (iv)」。
 *
 * ══ v5 的诚实边界（做不到的，写清楚，不装作做到了）══════════════════════════════
 *  · **能力声明的确切范围（两句，不多说一个字）**：
 *    ① 能证：**扫过了什么** —— `# PLD-SCANNED files=N lines=L tokens=T`（真实扫描算出的工作量）；
 *    ② 能证：**裁决在裁** —— 含幽灵的**合成散文**喂给同一份 `judge()` 必须返回非空违规（正控）。
 *       没有这一句，读数全真也挡不住把裁决短路（反例 3c：读数与统计全真、`judge` 返回 []）。
 *    ③ 不能证：**判据本体没被换掉**（删 test / 改断言 / 连正控一起伪造）——见未覆盖 (i)(v)(vi)。
 *  · **已覆盖**（逐条实测，2026-09-25）：
 *    ① 别名穿透 / 动态 import + 计算成员 / 反斜杠形态 / 环境保护门 / 另起子进程读家目录
 *       （权限模型对 ChildProcess 报 "Use --allow-child-process"，本判据刻意不授予）——
 *       这些形态读家目录时**未被捕获**，受限轮 exit≠0 ⇒ 判红。
 *    ② **把主扫描 test 掏空**（函数体首行 `return`）——见 `PLD-SCANNED` 读数断言。
 *    ③ **裁决为空的三种阉割**（反例 3a 删整段断言体 / 3b 只删 `deepEqual` / 3c 把 `judge()`
 *       短路成 `return []` 而读数全真）——见合成正控断言（实测：加正控前**三者全绿**，加后**全红**）。
 *  · **未覆盖（不许说成已覆盖）**：
 *    (i) **删掉或阉割本判据**——本文件自己就是被测对象，仓内没有任何测试能阻止有人把第 4 条
 *        test 删掉，也拦不住**连正控断言一起删**。第 3 条那个字符串检查只能提醒。
 *        这是本判据的**结构性上限**：仓内自检对「删自检」本质无能，只能把代价抬高。
 *    (ii) 不经 fs 模块的旁路（如内部/原生绑定）——未测、不声称。
 *    (iii) 换 Node 大版本后 '--permission' 的语义变化 —— 前提变了就得重测。
 *    (iv) ⚠ **读家目录但把异常吞掉**（`try { readFileSync(home…) } catch {}`）——**判据漏**。
 *        实测（2026-09-25）：这种写法在**不受限轮**四条全绿、**受限轮**也四条全绿（exit=0），
 *        因为受限轮只做两件事——正控（家目录确实不可读）与"主扫描 test 是 ok"——
 *        它**不记录谁尝试过触达**。旧版本此处曾错误宣称"吞掉也照样判红"，**已按实测订正**。
 *    (v) **蓄意连 `PLD-SCANNED` 读数一起伪造**（照抄该行再 return）——未覆盖，同上。
 *    (vi) **蓄意连合成正控一起伪造**（照抄一段假违规返回）——未覆盖，同上。
 *  · 第 3 条的静态检查拦不住蓄意改写，只拦无意回归（有人把 v3 那行粘回来）。
 *  · 扫描面是**显式取舍**，不是"全仓都扫"：见下方 SCAN_FILES。
 *  · 本判据的事实基础：Node v24.21.0 的 '--permission' 实测（读家目录 ERR_ACCESS_DENIED、
 *    读仓库内文件 OK、起子进程被拒需显式授权）。换 Node 大版本需重测这条前提。
 *
 * ══ 判据边界（刻意留的余地，避免脆弱启发式）══════════════════════════════════
 *  · 只扫**反引号 token**：项目枚举（kind: 'repro'、=== 'redteam'）从不这样写；
 *    注释**整段剥离且保留行号**（留档历史事故是合法的，删掉注释里的教训比留着更坏，
 *    且行号必须能对上真实文件，否则"位置"这条纪律是假的）；
 *  · 只认 **kebab-case ASCII** 形状（req-spec / dispute / zz-ghost-probe）；
 *  · 命中后还要**排除已登记的项目词汇白名单**（工具名 roundtable_*、字段名
 *    regression_risk、模式名 orchestrated）——它们同样是反引号 token 但不是席 id。
 *
 * ══ 白名单的两条已知性质（写给复核者，不靠猜）══════════════════════════════════
 *  ① 它是**显式声明**，不是"为了让它变绿"的补丁：每一条都必须能回答"它为什么属于项目
 *     而非用户"。**加条目 = 改判据**，须在同一个提交里说明理由；不许为消红而加。
 *  ② **已知假阴性（登记在案）**：'redteam'（模式枚举）与 'user'（来源字段）与用户
 *     预设库里的同名 id **碰撞**——若真有人把这两条 id 当**席名**点进散文，本守卫看不见。
 *     它已不再声称"能对用户预设库解析"，所以碰撞不再制造误导结论；代价只是这两条 id
 *     的漏网，明写在判据里而不是留成暗坑。
 *     **已知假阳性**：白名单之外任何 id 形态 token（例如示例 skill 名 'pdf-fill'）都会
 *     判红。这是有意代价：宁可让作者把示例改成非 id 形态，也不放行"散文里点名具体演员"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = new URL('../src/', import.meta.url)
const SELF_FILE = fileURLToPath(import.meta.url)
const REPO_ROOT = dirname(dirname(SELF_FILE))
/** 本进程是否就是"被剥夺家目录读权限"的那一轮（由第 4 条 test 以 env 传入）。 */
const RESTRICTED = process.env.PLD_RESTRICTED === '1'

/*
 * ⚠ **显式扫描面**（红队实测：面外确实还有 kebab token，这是取舍不是遗漏）：
 *   扫描面 = ['index.ts', 'tools.ts'] —— 即模型真正读到的两处散文：
 *     · src/index.ts  的 usage policy（整段是给模型的指令）
 *     · src/tools.ts  的每个工具的 description / render 文案
 *   面外已知的反例：src/plan.ts:209 的示例 skill 名 'pdf-fill'（设置卡文案，
 *   也是 model-facing，但**不在**本判据面上）。不扩面的理由：设置卡文案里出现
 *   示例 skill 名是**用户可见的功能说明**，与"给模型点名具体角色席"不同；
 *   扩面会立刻因这一处判红，而它并不是幽灵引用。
 *   ⇒ 想扩面就得先把这个取舍重新裁定。此处写明，不默认。
 */
const SCAN_FILES = ['index.ts', 'tools.ts']

/**
 * 项目词汇白名单：工具名 / 字段名 / 参数名 / 模式名 —— 它们不是角色席，也不随用户变。
 *
 * ⚠ 白名单是**判据的一部分**，不是"为了让它变绿"的补丁：这些词是**项目自己的词汇**
 * （参数名、工具名、领域枚举），与用户预设库无关。判据要区分的正是
 * 「项目词汇」与「用户资产」，白名单是那个区分的显式声明 ——
 * 每加一条都要能回答"它为什么属于项目而非用户"。
 */
const NON_PRESET_TOKENS = new Set([
  // 协作模式与 skill 传递方式（项目自己的领域枚举）
  'orchestrated', 'egalitarian', 'redteam', 'relay', 'direct',
  // 工具名（项目注册的，不随用户变）
  'roundtable_list_presets', 'roundtable_add_node', 'roundtable_create', 'roundtable_status',
  'roundtable_plan_meeting', 'roundtable_send_message', 'roundtable_next_round', 'roundtable_close',
  'roundtable_speak', 'roundtable_summarize', 'roundtable_request_decision', 'roundtable_export_meeting',
  'roundtable_kb_digest', 'roundtable_proxy_think', 'roundtable_connect', 'roundtable_disconnect',
  'roundtable_actions_clear', 'roundtable_set_budget', 'roundtable_start_review',
  'roundtable_collect_review', 'roundtable_finish_review', 'roundtable_export_review', 'roundtable_remove_node',
  // 工具参数名与字段名（add_node / plan_meeting / plan item 的接口词汇）
  'preset', 'role', 'provider', 'model', 'key', 'name', 'task', 'owner', 'kind', 'to', 'content', 'id',
  'change', 'review', 'survey', 'depends_on', 'work_item', 'regression_risk',
  'boundary_not_doing', 'boundary_goal', 'boundary_done', 'boundary_check', 'user_directive', 'skip_plan_card',
  'plan_card_skipped', 'talent_pool', 'round_signals', 'on_stage', 'skill_delivery',
  // 会议状态与审计 kind（领域枚举）
  'active', 'muted', 'ended', 'archived', 'capacity-over', 'gate-reject', 'all', 'captain', 'aggregator',
])

/** 席 id 形态：kebab-case ASCII，字母开头（req-spec / dispute / zz-ghost-probe）。 */
const SEAT_ID_SHAPE = /`([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`/g

/**
 * 只扫 model-facing 散文：usage 段与工具 description/render 文案 —— **仓库自身字节**。
 *
 * 剥离注释时**保留行号**（块注释内容换成等量空格、换行原样留下），
 * 否则报出来的 file:line 与真实文件对不上，"位置"这条纪律就形同虚设
 * （v3 就是拿剥离后的串算行号的，报的号本来就是错的）。
 */
function modelFacingText() {
  /*
   * ⚠ **合成投毒缝**（2026-09-25 · verify 席 3b 反例倒逼）：
   * 3b（只删掉"真实扫描必须干净"那条 `deepEqual`）在**真实源码本来就干净**时与保留它
   * **完全不可区分** —— 任何**文件内**的正控都抓不到它（正控自己还在跑，只是没人再拦真源）。
   * 唯一的出路是**跨轮正控**：让外层那一轮往扫描面里注入一段**已知含幽灵的合成散文**，
   * 并要求内层**必须因此判红**。判据机械完好 ⇒ 投毒轮红；被短路/删断言 ⇒ 投毒轮仍绿 ⇒ 外层判红。
   * 该缝只在 `PLD_POISON_FILE` 被显式设置时生效（正常全量测试里不设 ⇒ 扫描面不变）。
   */
  const extra = []
  const poisonFile = process.env.PLD_POISON_FILE
  if (poisonFile !== undefined && poisonFile !== '' && existsSync(poisonFile)) {
    extra.push({ name: 'synthetic-poison', lines: [{ line: 1, text: readFileSync(poisonFile, 'utf8') }] })
  }
  return extra.concat(SCAN_FILES.map((name) => {
    const raw = readFileSync(new URL(name, SRC), 'utf8')
    const blanked = raw
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const lines = []
    blanked.split('\n').forEach((text, index) => {
      // 剥离 import/type 行（那不是在跟模型说话），但**保留真实行号**
      if (/^\s*(import|export type|export interface)/.test(text)) return
      lines.push({ line: index + 1, text })
    })
    return { name, lines }
  }))
}

/*
 * ⚠ **合成正控输入**（2026-09-25 · verify 席实测倒逼 · 3c 反例）：
 * 一段含席 id 形态 token 的**假散文**。它不是源码、不参与真实扫描，唯一用途是把
 * "裁决真的在裁"变成一条可断言的事实 —— 否则 `judge()` 被短路成 `return []`
 * 时，真实扫描返回 0 条**看起来完全正常**（3c：读数行与统计全真，裁决为空）。
 */
const SYNTHETIC_PROSE = [
  { name: 'synthetic-control', lines: [{ line: 1, text: '示例散文里点了一个席：`zz-min-ghost`。' }] },
]

/**
 * 判据本体：返回违规清单。**没有静默档** —— 要么是清单，要么是空数组。
 * 扫描面若为空，test 里的断言会直接判红（不允许"跑成 pass 但什么都没验"）。
 *
 * ⚠ 参数化（2026-09-25）：接受任意"扫描结果"形态，因而**可被合成输入直接调用**。
 * 这是正控能成立的前提 —— 判据不绑定真实文件，才可能拿同一份代码去裁一段已知含幽灵的
 * 散文，从而把"短路 / 裁决体被删"变成可观测的红。
 */
function judge(scanned = modelFacingText()) {
  const offenders = []
  for (const { name, lines } of scanned) {
    for (const { line, text } of lines) {
      for (const m of text.matchAll(SEAT_ID_SHAPE)) {
        const token = m[1]
        if (NON_PRESET_TOKENS.has(token)) continue
        const snippet = text.slice(Math.max(0, m.index - 70), m.index + 60).replace(/\s+/g, ' ').trim()
        offenders.push('src/' + name + ':' + line + ' -> [' + token + ']  ...' + snippet + '...')
      }
    }
  }
  return offenders
}

test('落点纪律：model-facing 散文（扫描面 = src/index.ts + src/tools.ts）不得出现「席 id 形态」的反引号 token（且裁决对合成幽灵正控有效）', () => {
  // 扫描面自检：文件读不到、名字改了、正则失效 —— 都必须判红，不许退化成空转。
  const scanned = modelFacingText()
  const totalLines = scanned.reduce((sum, file) => sum + file.lines.length, 0)
  // 真扫过的 token 总数（未过滤白名单前的原始命中）——**先扫后印**，是这条 test 的工作产物。
  const totalTokens = scanned.reduce(
    (sum, file) => sum + file.lines.reduce((n, line) => n + [...line.text.matchAll(SEAT_ID_SHAPE)].length, 0),
    0,
  )
  /*
   * ⚠ **机器可读回执**（2026-09-25，verify 席实测倒逼）：
   * 外层（不受限轮）只能看到测试运行器的 TAP 行，而**把函数体首行改成 `return`**（或
   * `console.log('（跳过：…）'); return`）**照样产出合法 `ok` 行** ⇒ 把这条 test 整个掏空，
   * 四条仍全绿、真幽灵在位而判据零反应 —— 那是 v4「跳过与验过不可分辨」的病从外层
   * 搬到了内层。故此处把**扫描的工作量**印成一行可解析读数，由外层断言它存在且非零：
   * 掏空函数体 = 拿不到这行（它只能由真实扫描算出来）。
   *
   * 诚实边界：**蓄意连读数一起伪造**（照抄这一行再 return）本判据认不出 —— 与「蓄意删掉
   * 本 test」同属未覆盖类，已登记在文件头「未覆盖」段，不在此处假装拦得住。
   */
  console.log('# PLD-SCANNED files=' + scanned.length + ' lines=' + totalLines + ' tokens=' + totalTokens)
  assert.ok(
    totalLines > 100,
    '扫描面为空或萎缩（' + totalLines + ' 行）——守卫会退化成"跑成 pass 但什么都没验"（正是 v3 的死法）',
  )
  /*
   * ⚠ **裁决正控**（2026-09-25 · verify 席实测倒逼）：先拿同一份判据去裁一段**合成散文**
   * （含幽灵 `zz-min-ghost`），必须返回**非空违规**。没有这一步，把 `judge()` 短路成
   * `return []` 或删掉下面的 `deepEqual` 都会**照样全绿**（反例 3a/3b/3c 实测如此）：
   * 读数行只证「扫过 N 文件 / L 行 / T token」，**不证「对命中做过裁决」**。
   */
  const control = judge(SYNTHETIC_PROSE)
  assert.ok(
    control.length > 0,
    '判据对含幽灵的合成散文返回了 0 条违规 ⇒ 裁决体被短路/删除（读数再真也不能当绿）',
  )
  assert.match(control.join('\n'), /zz-min-ghost/, '正控违规里必须点名那个幽灵 token（否则是"非空但没在裁"）')
  const offenders = judge()
  assert.deepEqual(
    offenders,
    [],
    '项目源码的 model-facing 散文里出现了**席 id 形态**的反引号 token。'
    + '角色席是**用户资产**（可改名、可删除、可清空），项目不得点名任何具体席：'
    + '应改为**按职责描述**，让主持人从 roundtable_list_presets / talent_pool 动态挑；'
    + '示例/枚举请写成非 id 形态（不要用反引号包 kebab-case）。违规：\n  '
    + offenders.join('\n  '),
  )
})

test('落点纪律：动态挑席能力必须保留（不得为通过上一条而删掉预设链）', () => {
  const all = ['tools.ts', 'index.ts', 'dispatch.ts', 'rpc.ts']
    .map((f) => readFileSync(new URL(f, SRC), 'utf8'))
    .join('\n')
  /*
   * 反向守卫：上一条禁止"点名预设"，但**不能**因此把预设能力整体删掉。
   * 这条钉住"动态候选池"仍在 —— 否则守一条会拆另一条（正是拆东墙补西墙）。
   */
  assert.match(all, /getRolePresets/, '须保留读取用户预设库的能力')
  assert.match(all, /resolvePreset\(/, '须保留按引用动态解析预设（不依赖具体 id）')
  assert.match(all, /roundtable_list_presets|buildTalentPool|talent_pool/, '须保留让主持人动态挑席的入口')
})

test('落点纪律：静态形态检查【只拦无意回归，拦不住蓄意改写】——守卫代码不得粘回 v3 的死路径空转', () => {
  /*
   * ⚠ 这条是**字面量**检查，能力面判据在下一条。它的确切主张只有两句：
   *   ① 拦住"有人把 v3 那行 existsSync(家目录/settings.yaml) + console.log 跳过 粘回来"；
   *   ② 拦住"守卫代码里重新出现指向宿主设置文件的**连续**路径字面量"。
   * 它**不**声称"结构上拼不出家目录路径" —— 那件事由下一条用**运行时能力**判据来证。
   *
   * 已知绕过（2026-09-25 三名审查席实测，本条检查对它们**全部为绿**，留档备查）：
   *   ① import 别名 + 路径分段拼接；
   *   ② 环境门 'if (process.env.USERPROFILE === undefined) return undefined' + 分段拼接；
   *   ③ 动态 import('no'+'de:os') + 计算成员 + 分段拼接 + 静默 return。
   *   ⇒ 所以本条的结论只能是"形态回归没发生"，不能是"读不到家目录"。
   *
   * 取"代码面"：行首块注释（留档散文）→ 行注释 → 字符串 → 模板串。
   * ⚠ 必须剥字符串，否则**断言的说明文案自己**就成了命中物（自我检查的第一号陷阱）。
   */
  const raw = readFileSync(SELF_FILE, 'utf8')
  const code = raw
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  assert.doesNotMatch(code, /settings\.yaml/, '守卫不得重新依赖宿主设置文件（该文件本机已不存在）')
  assert.doesNotMatch(code, /existsSync\s*\([^)]*\.dsh/, '守卫不得用"家目录路径不存在就跳过"的空转形态')
  // 能力判据的存在性：'PLD_RESTRICTED' 必须同时出现在**代码面**与**命令面**（本文件里），
  // 只读散文字面量会被注释骗过。它拦不住蓄意删除（已登记），但能拦住"顺手删掉"。
  assert.match(raw, /PLD_RESTRICTED/, '守卫必须保留能力面判据（删掉它等于把 v5 退回 v4 的空口声明）')
  assert.match(code, /PLD_RESTRICTED/, '能力面判据的标记必须出现在代码里（不是只写在注释里）')
  assert.match(code, /--allow-fs-read=/, '能力面判据必须仍以权限模型把家目录设为不可读（不许换成自述式检查）')
  assert.match(code, /PLD-SCANNED/, '主扫描 test 必须仍回传工作产物读数（删掉它 = 外层再也分不出"验过"与"掏空"）')
  assert.match(code, /SYNTHETIC_PROSE/, '主扫描 test 必须保留合成正控（删掉它 = 裁决被短路也看不出来，3c）')
  assert.match(code, /PLD_POISON_FILE/, '能力面判据必须保留跨轮投毒缝（删掉它 = 删掉真实断言也看不出来，3b）')
})

/**
 * 受限子进程的环境：必须在**干净**的进程里跑内层测试。
 *
 * ⚠ 实测坑（2026-09-25）：Node 测试运行器给每个测试文件设 NODE_TEST_CONTEXT=child，
 * 并被**逐代继承**。带着它再跑 `node --test`，新的运行器会把自己也当成"worker 子进程"，
 * 于是不打印 TAP，而是把 v8.serialize 的二进制流灌进 stdout ⇒ 内层测试其实绿了，
 * 外层却解析不出任何 ok 行（实测表现为"主扫描测试根本没跑"的假红）。
 * 故先剥掉这两个变量，再叠加 PLD_RESTRICTED 标记。
 */
function restrictedEnv(extra = {}) {
  const env = { ...process.env, PLD_RESTRICTED: '1', ...extra }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  return env
}

test('落点纪律：能力面判据 —— 受限进程里实测守卫读不到用户家目录（且这一轮不是靠跳过换绿）', () => {
  // 探针就是**家目录本身**：实测在权限模型下 existsSync(homedir()) 即 ERR_ACCESS_DENIED，
  // 无需指明具体文件 —— 也让本文件的**代码面**不再出现任何宿主资产路径字面量。
  const homeProbe = homedir()
  if (RESTRICTED) {
    /*
     * 本轮就是被剥夺家目录读权限的那一轮。这里做两件事：
     *   正控 ①：家目录读取确实被判 ERR_ACCESS_DENIED（能力真的被剥夺，判据不是空转）；
     *   正控 ②：仓库内文件仍可读（排除"整个 fs 坏了"这种让结论无意义的场景）。
     * 这是**断言**，不是跳过：本轮结论由外层（不受限的）那一次 spawn 汇总。
     */
    let denied = false
    try {
      existsSync(homeProbe)
    } catch (error) {
      denied = error !== null && typeof error === 'object' && error.code === 'ERR_ACCESS_DENIED'
    }
    assert.ok(denied, '受限轮里家目录居然可读（或报的不是 ERR_ACCESS_DENIED）⇒ 能力判据失效，不许当绿')
    assert.ok(existsSync(SELF_FILE), '受限轮里连仓库内文件都读不到 ⇒ 环境被搞坏，结论无意义')
    /*
     * 正控 ③（写清判据的确切边界，防止把话说大）：
     * 受限轮里"家目录路径本身"仍然**拿得到**（os.homedir() 与 USERPROFILE 照常返回），
     * 被剥夺的只有**读家目录里的文件**这项能力。
     * ⇒ 本判据证明的是「守卫进程读不到用户资产」，**不是**「进程内不存在家目录路径」。
     *   后者做不到，也不该声称 —— 这正是 v4 栽的那个坑（声明大、实检小）。
     */
    assert.equal(typeof homedir(), 'string', '受限轮里 os.homedir() 应照常可用（本判据不该越界声称"路径不可知"）')
    assert.equal(typeof process.env.USERPROFILE, 'string', '受限轮里 USERPROFILE 应照常可用（同上）')
    return
  }
  /*
   * 外层（不受限）轮：起一个**受权限模型限制**的子进程，把本文件当测试再跑一遍。
   *   --permission                    打开权限模型
   *   --allow-fs-read=<仓库>\*        只放行仓库内读取（家目录不在其中 ⇒ 判 ERR_ACCESS_DENIED）
   *   --experimental-test-isolation=none  同进程跑，避免测试框架再 spawn 被拒
   * 该子进程**不得**授予 --allow-fs-write / --allow-child-process：判据不需要它们。
   */
  /*
   * ⚠ **跨轮正控的投毒文件**（2026-09-25 · verify 席 3b 反例倒逼）：
   * 先把一段**已知含幽灵**的合成散文写到仓库内一个临时文件，再让内层那一轮通过
   * `PLD_POISON_FILE` 把它并进扫描面。于是内层**必须因此判红**：
   *   判据机械完好 ⇒ 投毒轮 fail≠0；被短路（3c）/删掉真实断言（3b）⇒ 投毒轮仍绿 ⇒ 外层判红。
   * 这是唯一能抓住 3b 的形态 —— 正因为真实源码本来就干净，"断言被删"在**不投毒**时与保留
   * 它完全不可区分（实测：3b 在加投毒前 4 条全绿）。
   * 毒饵文件随后立即删除；它在仓库内、且被 `--allow-fs-read=<仓库>\*` 覆盖。
   */
  const poisonPath = join(REPO_ROOT, 'test', '.pld-poison-probe.txt')
  writeFileSync(poisonPath, '合成投毒散文：这里点了一个席 \`zz-min-ghost\`。', 'utf8')
  const restricted = spawnSync(
    process.execPath,
    [
      '--permission',
      '--allow-fs-read=' + join(REPO_ROOT, '*'),
      '--experimental-test-isolation=none',
      // TAP 报告器：受限轮里的子进程**不得**再被 spawn（本测试自己就是那条 spawn），
      // 故不能用默认 spec 报告器（它会 fork），也不允许授予 --allow-child-process。
      '--test-reporter=tap',
      '--test',
      relative(REPO_ROOT, SELF_FILE),
      // ⚠ 必须用**本文件自己的相对路径**（绝对路径实测被 runner 拒）：
      // 写死文件名会让'把守卫改名/挪位置'顺手绕开复核。
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
      env: restrictedEnv({ PLD_POISON_FILE: poisonPath }),
    },
  )
  const out = (restricted.stdout ?? '') + (restricted.stderr ?? '')
  rmSync(poisonPath, { force: true })
  /*
   * ⚠ **投毒轮的预期是"必须红"**：受限轮被喂了含幽灵的合成散文，
   * 只要判据机械完好（扫描 → 裁决 → deepEqual 全在），主扫描 test 就必须 not ok。
   * 反之（被短路成 return []，或真实断言被删）⇒ 它仍绿 ⇒ 这一条判红。
   * 故此处**不再要求受限轮 exit=0**，而是要求「主扫描 test 判红」。
   */
  assert.notEqual(
    restricted.status, 0,
    '受限轮被投毒（扫描面里含幽灵）却仍 exit=0 ⇒ 判据对幽灵零反应（裁决被短路或断言被删）：\n' + out.slice(0, 1200),
  )
  // TAP 行形如 `ok 1 - <标题>` / `not ok 1 - <标题>`；`# SKIP` 表示被跳过（不许）。
  const tapLines = (restricted.stdout ?? '').split('\n').filter((line) => /^(ok|not ok) \d+ - /.test(line))
  const mainTap = tapLines.find((line) => line.includes('model-facing 散文'))
  assert.ok(mainTap !== undefined, '受限轮里主扫描测试根本没跑（消失或被 SKIP）—— 那是拿跳过换绿：\n' + out.slice(0, 1200))
  /*
   * ⚠ **投毒轮里主扫描测试必须是 `not ok`**（这是"裁决真的在裁"的跨轮证据）。
   * 反过来：它若仍是 `ok`，说明扫描到的幽灵被无声吞掉了（judge 被短路 / deepEqual 被删）。
   */
  assert.ok(
    mainTap.startsWith('not ok'),
    '受限轮被投毒（扫描面含幽灵 `zz-min-ghost`）但主扫描测试仍报 ok ⇒ 裁决没在裁：\n' + mainTap,
  )
  assert.ok(!mainTap.includes('# SKIP'), '受限轮里主扫描测试被跳过 —— 不允许：\n' + mainTap)
  // 其余三条仍须为 ok（投毒只应打红主扫描那一条，不该把别的测试也带崩）
  const okLines = tapLines.filter((line) => line.startsWith('ok '))
  assert.ok(okLines.length >= 3, '受限轮里除主扫描外只剩 ' + okLines.length + ' 条 ok（应为 3）⇒ 有测试悄悄消失：\n' + out.slice(0, 1200))
  const capLine = okLines.find((line) => line.includes('能力面判据'))
  assert.ok(capLine !== undefined && !capLine.includes('# SKIP'), '受限轮里能力面判据自己没跑：\n' + out.slice(0, 1200))
  /*
   * ⚠⚠ **读数断言**（2026-09-25 · verify 席实测倒逼 · 这条才是真闸）：
   * 上面那些 TAP 行断言**挡不住掏空** —— 把主扫描测试的函数体首行换成 `return`，
   * 它**照样产出一条合法 `ok` 行**（实测：掏空 + 真幽灵 `zz-min-ghost` 在位，四条仍全绿）。
   * 故这里改为要求被扫那轮**回传一行机器可读读数** `# PLD-SCANNED files=N lines=L tokens=T`，
   * 并断言 N/L/T 都是**正整数**。该行只能由真实扫描算出来，掏空函数体 = 拿不到它。
   *
   * ⚠ TAP 里测试体内的 console.log 会被逐行加 `# ` 前缀（实测），故同时接受
   *   `# PLD-SCANNED …`（被 TAP 转义）与 `# \# PLD-SCANNED …`（原样透出）两种形态。
   *
   * 诚实边界（登记，不假装拦得住）：蓄意**连读数一起伪造**（照抄这一行再 return）、
   * 或蓄意**删掉本条 test** —— 都属未覆盖类，见文件头「v5 的诚实边界」。
   */
  const scanLine = (restricted.stdout ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/^#\s*/, '').replace(/^\\#\s*/, ''))
    .find((line) => line.startsWith('PLD-SCANNED '))
  assert.ok(
    scanLine !== undefined,
    '受限轮没有回传扫描读数行（# PLD-SCANNED …）⇒ 主扫描测试很可能被掏空成 `return`：'
    + '只有 `ok` 行而拿不到工作产物，正是 v4「跳过与验过不可分辨」的病。\n' + out.slice(0, 1200),
  )
  const readout = Object.fromEntries(
    scanLine.slice('PLD-SCANNED '.length).split(' ').map((pair) => pair.split('=')),
  )
  for (const key of ['files', 'lines', 'tokens']) {
    const value = Number(readout[key])
    assert.ok(
      Number.isInteger(value) && value > 0,
      '扫描读数 ' + key + ' 非正整数（' + String(readout[key]) + '）⇒ 该轮没有真的扫过任何东西：' + scanLine,
    )
  }
  assert.ok(Number(readout.files) >= 2, '扫描读数 files=' + readout.files + ' 少于 2 ⇒ 扫描面被悄悄收窄：' + scanLine)
  assert.ok(Number(readout.lines) > 100, '扫描读数 lines=' + readout.lines + ' 不足以证明扫到正文：' + scanLine)
})
