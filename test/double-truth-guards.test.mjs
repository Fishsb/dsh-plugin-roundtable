/**
 * 双真相守卫（2026-09-23 全量审计 · 28 场会议实测）。
 *
 * 背景：审计发现三类「文案与实现两种说法」的缺陷，且都**无判据覆盖**：
 *
 *  ① `connect` 边被一次重构静默架空 —— 2026-09-19 的三模式重构（commit 8088c2f）
 *     把单线制下的 edges 从总纲里刻意移除（`charter.ts:33`），`send_message` 也不读
 *     edges；但**工具描述与 usage 仍在教主持人画拓扑**。实测代价：18 场会议画了
 *     122 条边、专家一个字读不到；边使用从重构前的 113 骤降到 13（−88%）。
 *  ② `create` 无设置卡前置门 —— 「先调 plan_meeting」只写在 description 里，
 *     实测 **8/35 次 create（23%）绕过**用户确认。
 *  ③ 「有讨论无决定」无声 —— 28 场只有 22 条 decisions，24 场为零；专家反对意见
 *     的最终去向**没有任何记录**。
 *
 * 本文件把这三条钉成机检。**风格刻意与 `visibility.test.mjs` 的接线守卫一致**
 * （读源码文本断言"，防"文案说 A、实现做 B"）：因为这三条缺陷的共性不是逻辑错，
 * 而是**两个地方对同一事实给了不同说法**，逻辑单测永远抓不到。
 *
 * ⚠ 先红说明：本文件每条断言在修复前都**确实会红**（修复前已逐条人工核对，
 * 见 docs/audit-2026-09-23-全量会话审计与优化方案.md §3 各册的"先红证据"列）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

/* ── ① connect 边：单线制下必须如实声明它是装饰 ───────────────────────── */

test('①-a usage 不得无条件教主持人画拓扑（协议须按模式条件化）', () => {
  const usage = read('index.ts')
  // 旧文案原样残留即红：它把「画拓扑」说成必经步骤，单线制下会白花调用。
  assert.doesNotMatch(
    usage,
    /Wire the topology with roundtable_connect/,
    'usage 不得再无条件要求画拓扑（单线制下边既不进总纲也不影响送达）',
  )
  // 必须同时说清"在哪些模式下它是装饰"与"在哪些模式下它是真通道"。
  assert.match(usage, /Edges are DECORATION in orchestrated\/redteam/, 'rule 4 须明说单线制下边是装饰')
  assert.match(usage, /Only in egalitarian mode do edges reach the experts/, 'rule 4 须指出 egalitarian 下边是真通道')
})

test('①-b 工具描述不得再声称边是"协作通道"而不提模式差异', () => {
  const tools = read('tools.ts')
  assert.match(tools, /MODE-DEPENDENT/, 'connect 描述须显式标注模式差异')
  assert.match(tools, /not consulted by send_message/, '须说清 send_message 不读 edges（送达不受影响）')
})

test('①-c status 的 Edges 段必须按模式如实标注（不得平铺误导）', () => {
  const tools = read('tools.ts')
  assert.match(tools, /DECORATION in \$\{String\(value\.mode\)\}/, '单线制下 Edges 段须标注为装饰')
  assert.match(tools, /LIVE in egalitarian/, 'egalitarian 下须标注为真通道')
})

test('①-d 底账：charter 确实在单线制下不拼 edges（本判据的前提必须为真）', () => {
  // 若哪天 charter 改回"单线制也拼 edges"，则 ①-a/①-b/①-c 的"装饰"说法就变成新的假话。
  // 这条是**前提守卫**：让"装饰"这个声明与其依据同生共死。
  const charter = read('charter.ts')
  assert.match(
    charter,
    /单线制下刻意\*\*不拼\*\* roster\/edges/,
    'charter 必须仍然在单线制下省略 edges —— 否则 ①a-c 的"装饰"声明即失效，须同步改回',
  )
})

/* ── ② create 设置卡门：绕过必须显式且留痕 ───────────────────────────── */

test('②-a create 必须有设置卡门禁（不能只写在描述里）', () => {
  const tools = read('tools.ts')
  assert.match(tools, /hasPlanCardApproval\(stateRoot, captain\.id, meetingName\)/, 'create 须真的查批准记录')
  assert.match(tools, /no confirmed settings card/, '缺批准时须报错并指路')
})

test('②-b 绕过必须显式（skip_plan_card），且报错文案要指路', () => {
  const tools = read('tools.ts')
  assert.match(tools, /skip_plan_card/, '须有显式绕过参数')
  assert.match(tools, /pass skip_plan_card: true/, '报错文案须给出可操作的绕过写法')
})

test('②-c 绕过必须留痕且有消费面（只写不读 = 没写）', () => {
  const tools = read('tools.ts')
  const types = read('types.ts')
  assert.match(types, /planCardSkipped\?: boolean/, '会议记录须有 planCardSkipped 字段')
  assert.match(tools, /plan_card_skipped: meeting\.planCardSkipped === true/, 'status 须回吐该字段（消费面）')
  assert.match(tools, /plan_card_skipped: this meeting was created WITHOUT the settings card/, 'status 渲染须显式警示')
})

test('②-d plan_meeting 批准时必须写记录（写侧与读侧同址）', () => {
  const tools = read('tools.ts')
  // 写侧：批准分支落盘；读侧：create 时校验。两者必须走同一函数（防路径漂移）。
  assert.match(tools, /if \(confirmation\.kind === 'approved'\)/, '批准分支须留痕')
  assert.match(tools, /planCardRecordFile/, '读写两侧须共用 planCardRecordFile（单一实现）')
})

/* ── ③ 分歧处置：有讨论无决定必须出声 ─────────────────────────────────── */

test('③-a close 在有讨论无决定时须提示（不得静默收场）', () => {
  const tools = read('tools.ts')
  assert.match(tools, /dispute_hint/, 'close 须回吐分歧提示字段')
  assert.match(tools, /experts spoke but 0 decisions/, '提示文案须点破"反对意见去向未记录"')
  assert.match(tools, /Do not treat "nobody raised it again" as agreement/, '须禁止把"没人再提"当一致')
})

test('③-a′ 落点纪律：项目不得硬编码角色预设 id（预设是用户的，可改名可删）', () => {
  const tools = read('tools.ts')
  const usage = read('index.ts')
  /*
   * 用户 2026-09-23 点明「项目是项目，角色预设是角色预设」。
   * 实测我上一版犯过两次：① close 提示让主持人去用 `dispute` 预设——**该预设不存在**，
   * 主持人照做会扑空（幽灵引用）；② rule 18 把 arch/verify/repro/security/data/perf
   * 当"标准答案"列出来。二者都把**用户的可变资产**写进了项目源码。
   * 正确做法：项目只说**职责/能力面**，由主持人去 list_presets/talent_pool 挑。
   */
  assert.doesNotMatch(
    tools,
    /run the `dispute` preset/,
    'close 提示不得引用具体预设 id（dispute 在用户 28 席里并不存在 = 幽灵引用）',
  )
  assert.match(tools, /pick whichever/, 'close 提示须改为"从候选里挑"，而非点名')
  assert.doesNotMatch(
    usage,
    /architecture\/design seat \(\\`arch\\`\)/,
    'rule 18 不得把 arch 当标准答案',
  )
  assert.match(
    usage,
    /Do NOT treat any preset id as the answer/,
    'rule 18 须显式说明"不要把任何预设 id 当答案"（其可改名可删除、甚至可能不存在）',
  )
  assert.match(usage, /call roundtable_list_presets or read talent_pool and pick whichever seat/, 'rule 18 须指向动态候选池')
})

test('③-a″ 角色预设 id 不得作为"必须存在"的前提出现在项目源码', () => {
  const files = ['tools.ts', 'index.ts', 'dispatch.ts', 'charter.ts', 'plan.ts']
  /*
   * 这条是上一条的**结构版**：上面靠列举已知违规写法，这条防"换个 id 再来一次"。
   * 判据：源码里不得出现 `preset="<id>"` / `preset: '<id>'` 这类**写死的预设引用**；
   * 动态解析（resolvePreset(available, ref)）不受影响。
   */
  for (const file of files) {
    const text = read(file)
    assert.doesNotMatch(
      text,
      /preset\s*[:=]\s*['"][a-z][a-z0-9-]{1,30}['"]/,
      `${file} 不得写死预设 id 字面量（预设属于用户，项目只认动态候选池）`,
    )
  }
})

test('③-b 提示不得阻断 close（只问一个专家的正当用法不能被拦）', () => {
  const tools = read('tools.ts')
  // close 的返回必须恒为 closed:true —— 提示只是附加字段。
  assert.match(tools, /return \{ closed: true, meeting_name: located\.name, dispute_hint/, 'close 必须无条件成功')
})

test('③-c 阈值须避免噪音：只在 ≥3 位专家发言且 0 决策时触发', () => {
  const tools = read('tools.ts')
  assert.match(tools, /stats\.speakers >= 3 && stats\.decisions === 0/, '触发条件须双向限定（防给安静会议制造噪音）')
})

/* ── ④ 预设闭环：档位必须在设置卡上可见（确认一份看不到参数的卡片 = 假确认）── */

test('④-a 设置卡须渲染专家的思考强度（含"继承"显式态）', () => {
  const plan = read('plan.ts')
  assert.match(plan, /reasoningEffort\?: string/, '卡片入参须接受档位')
  assert.match(plan, /@继承/, '未指定档位须显式写"继承"，不得留白')
})

test('④-b plan_meeting 须解析档位：显式 > 预设 > 空（与 add_node 同序）', () => {
  const tools = read('tools.ts')
  assert.match(tools, /reasoning_effort: \{ type: 'string', description: '可选思考强度/, 'experts[] 须接受档位')
  assert.match(tools, /entry\?\.reasoning_effort/, '须解析显式档位')
  assert.match(tools, /preset\?\.reasoningEffort/, '须回落到预设自带档位（否则预设档位在卡片上不可见）')
})

/* ── ⑤ 恒真条件：`||` 右侧必须是比较，不得是字符串本身 ───────────────────── */

test('⑤-a talent_pool 路由渲染不得用恒真条件（真机复现过的双真相）', () => {
  const tools = read('tools.ts')
  /*
   * 原缺陷：`String(provider ?? '') === '' || String(model ?? '')` —— 右侧漏了 `=== ''`，
   * 返回的是 model 字符串本身（truthy）⇒ 整个条件恒真 ⇒ 28/28 条预设全被显示成
   * 「（继承主持人路由）」，而 list_presets 对同一预设显示真实路由。
   * 下面两条一起钉：①不得再出现那种"裸字符串操作数"写法；②必须有正确实现。
   */
  assert.doesNotMatch(
    tools,
    /=== '' \|\| String\([^)]*\)\s*\?/,
    '不得再用 `x === \'\' || String(y)` 这种恒真条件（右侧是字符串本身，恒 truthy）',
  )
  assert.match(tools, /const hasRoute = String\(candidate\.provider \?\? ''\) !== '' && String\(candidate\.model \?\? ''\) !== ''/, '须用双向非空判定')
})

test('⑤-b 路由渲染的判据必须与 list_presets 同口径（同数据不得两个说法）', () => {
  const tools = read('tools.ts')
  // list_presets 的判据是 `provider === '' || model === ''` ⇒ 继承；取反即"有路由"。
  // talent_pool 必须语义等价，否则同一份预设在两个工具里显示不同。
  assert.match(tools, /const hasRoute = String\(candidate\.provider \?\? ''\) !== '' && String\(candidate\.model \?\? ''\) !== ''/, 'talent_pool 须用等价判据')
  assert.match(tools, /const route = preset\.provider === '' \|\| preset\.model === ''/, 'list_presets 判据须保持（作为同口径的另一半）')
})

/* ── ⑥ 澄清前置：边界不清不得开工（用户全流程要求 ①）───────────────────── */

test('⑥-a usage rule 1 须有澄清前置：填不出三项先回问用户', () => {
  const usage = read('index.ts')
  // 旧文案允许直接出卡片：必须已被"先判边界"取代。
  assert.doesNotMatch(
    usage,
    /NEVER create a meeting straight away\. First call roundtable_plan_meeting/,
    'rule 1 不得再直接从"不要立刻建会"跳到"先出卡片"——中间必须夹"先确认边界"',
  )
  assert.match(usage, /check whether the request is actually clear enough to meet on/, 'rule 1 须要求先判清晰度')
  assert.match(usage, /ask ONE short clarifying question and wait/, '填不出时必须先问且等回答')
  assert.match(usage, /what must NOT be touched/, '三项之一必须是"不许动什么"')
})

test('⑥-b usage rule 1 须引用实测代价（防后来人删掉这条）', () => {
  const usage = read('index.ts')
  // 留下判因，使删掉它需要先推翻证据 —— 与 chart 里其他规则的留档方式一致。
  assert.match(usage, /690079f3/, 'rule 1 须引用实测会话 id（判因留档）')
  assert.match(usage, /只有转述/, 'rule 1 须引用主持人自认的原话（"全仓查无你的原话，只有转述"）')
})

test('⑥-c 边界须贯通四段链：卡片 → 会议记录 → 总纲 → 导出', () => {
  const plan = read('plan.ts')
  const tools = read('tools.ts')
  const charter = read('charter.ts')
  const types = read('types.ts')
  // ① 类型存在
  assert.match(types, /export interface MeetingBoundary/, '须有 MeetingBoundary 类型')
  assert.match(types, /boundary\?: MeetingBoundary/, 'Meeting 须挂 boundary')
  // ② 卡片渲染（含未声明警示）
  assert.match(plan, /边界确认/, '设置卡须有边界确认块')
  assert.match(plan, /本次未声明边界/, '未声明时须显式警示（不得静默省略）')
  // ③ 总纲注入（每个专家都看得到）
  assert.match(charter, /本会议的边界声明/, '总纲须带边界段')
  assert.match(charter, /明确不做 \/ 不许动/, '总纲须带"不许动"那一项')
  // ④ 导出物留档
  assert.match(tools, /## 边界声明/, '导出物须含边界段（否则事后无法复盘是否越界）')
})

test('⑥-d 边界须四个参数都可传（plan_meeting 与 create 同批）', () => {
  const tools = read('tools.ts')
  const hits = tools.match(/boundary_not_doing: \{ type: 'string'/g) ?? []
  assert.equal(hits.length, 2, 'plan_meeting 与 create 两处都要有 boundary_not_doing（漏一处即断链）')
  const checkHits = tools.match(/boundary_check: \{ type: 'string'/g) ?? []
  assert.equal(checkHits.length, 2, 'plan_meeting 与 create 两处都要有 boundary_check（P10 量化的落点，漏一处即断链）')
  assert.match(tools, /boundary_goal: \{ type: 'string'/, 'plan_meeting 须收 boundary_goal')
  assert.match(tools, /boundary_done: \{ type: 'string'/, 'plan_meeting 须收 boundary_done')
})

/* ── ⑦ 防拆东墙：全流程要求 ② 须落到机制而非口号 ───────────────────────── */

test('⑦-a usage 须有专门一条防拆东墙（不得只散落在别处）', () => {
  const usage = read('index.ts')
  assert.match(usage, /NO ROBBING PETER TO PAY PAUL/, '须有独立的防拆东墙规则条')
  assert.match(usage, /never redefine the boundary to fit a convenient solution/, '须禁止"改边界来迁就现成方案"')
  assert.match(usage, /a meeting that ends silently about a crossed boundary is worse than one that fails loudly/, '须要求收口时如实报告越界')
})

test('⑦-b regression_risk 须四段贯通：类型 → 归一 → 信号 → 渲染', () => {
  const types = read('types.ts')
  const dispatch = read('dispatch.ts')
  const tools = read('tools.ts')
  assert.match(types, /regressionRisk\?: string/, 'RoundPlanItem 须有 regressionRisk')
  assert.match(dispatch, /candidate\.regressionRisk \?\? candidate\.regression_risk/, '归一须接受 snake_case（与 depends_on 同风格）')
  assert.match(dispatch, /risk_items_missing/, '信号须报"哪几项没自检"')
  assert.match(tools, /regression self-check: \$\{String\(signals\.risk_declared/, 'status 须渲染分母（always render）')
})

test('⑦-c regression_risk 不得做成脆弱启发式（只呈现不判定）', () => {
  const dispatch = read('dispatch.ts')
  /*
   * 设计决定留档：曾拟"按动词关键词判哪条是改动型工作"，**主动放弃**——
   * 分类启发式会造出假红假绿（本插件反复在剿的形态）。本条钉住"没有偷偷加回分类"。
   */
  assert.doesNotMatch(
    dispatch,
    /regressionRisk[\s\S]{0,200}(REQUIRED|must not be empty|is empty — )/,
    'regression_risk 不得做成硬门（机器判不了哪条需要自检）',
  )
  assert.match(dispatch, /只呈现不判定|不判定/, '须留档"只呈现不判定"的设计理由')
})

test('⑦-d 空串与缺省同义（防"填了空字符串"冒充已自检）', () => {
  const dispatch = read('dispatch.ts')
  // normalize 必须把空串折叠成"未填"；否则 "" 会进 plan 并被当成已声明。
  assert.match(
    dispatch,
    /\.\.\.\(regressionRisk === '' \? \{\} : \{ regressionRisk \}\)/,
    '空串必须折叠成缺省（否则空字符串会冒充"已自检"）',
  )
})

/* ── ⑧ 禁止自产自审（用户明确要求）───────────────────────────────────── */

test('⑧-a 自产自审须是**硬门**（不是提醒）：三形态都要被拦', () => {
  const dispatch = read('dispatch.ts')
  // ① change 无独立审查项
  assert.match(dispatch, /is kind:"change" but no kind:"review" item depends on it/, '须拦"改动无独立审查"')
  // ② 同席自审
  assert.match(dispatch, /that is 自产自审 \(self-review\)/, '须拦同席自审')
  // ③ 交叉自审
  assert.match(dispatch, /交叉自审/, '须拦交叉自审（审别人的同时自己也有改动在审）')
  assert.match(dispatch, /item\.kind === 'change'/, '判据须基于显式 kind，不得靠动词猜测')
})

test('⑧-b 自产自审判据须有单席豁免（结构上分不了席）', () => {
  const dispatch = read('dispatch.ts')
  assert.match(
    dispatch,
    /changeItems\.length > 0 && context\.rosterKeys\.length >= 2/,
    '在场席 <2 时须豁免（无法分席，不是纵容）；否则单席会议无法推进',
  )
})

test('⑧-c 独立审查覆盖面须可见（硬门只管"至少一个"，半覆盖要报出来）', () => {
  const dispatch = read('dispatch.ts')
  const tools = read('tools.ts')
  assert.match(dispatch, /change_uncovered/, '信号须报"哪些 change 无独立审查"')
  assert.match(dispatch, /change_covered/, '信号须报覆盖率')
  assert.match(tools, /independent review: \$\{String\(signals\.change_covered/, 'status 须渲染覆盖率（always render）')
  assert.match(dispatch, /kind_unspecified/, '未声明 kind 的项须可见（只报不拦）')
})

test('⑧-d usage 须有独立的禁止自产自审条（含按任务类型选审查席）', () => {
  const usage = read('index.ts')
  assert.match(usage, /NO SELF-REVIEW/, '须有独立的禁止自产自审规则条')
  assert.match(usage, /self-review structurally cannot find the wall its own change knocked down/, '须给出"为什么"（自审找不到自己拆的墙）')
  assert.match(usage, /Pick the reviewer by TASK TYPE/, '须要求按任务类型挑审查席')
  assert.match(usage, /do NOT silently accept it — re-dispatch the fix/, '须要求审查不通过时重新派单而非静默接受')
})

test('⑧-e 派单时须把防拆东墙要求写进任务正文（不能只留在协议里）', () => {
  const usage = read('index.ts')
  assert.match(usage, /put the anti-patch requirement INTO the task text itself/, '须要求把要求写进派单消息本身')
})

/* ── ⑨ 锚定用户指令（绝对避免偏离）────────────────────────────────────── */

test('⑨-a userDirective 须四段贯通：类型 → 卡片 → status → 总纲/导出', () => {
  const types = read('types.ts')
  const plan = read('plan.ts')
  const tools = read('tools.ts')
  const charter = read('charter.ts')
  assert.match(types, /userDirective\?: string/, 'Meeting 须有 userDirective')
  assert.match(plan, /userDirective\?: string/, '卡片草案须带 userDirective')
  assert.match(plan, /你的原话（逐字）/, '卡片须原样回显用户原话（防转述覆盖）')
  assert.match(tools, /user_directive: meeting\.userDirective \?\? ''/, 'status 须回吐（每轮对照）')
  assert.match(tools, /USER DIRECTIVE \(verbatim/, 'status 渲染须显眼（每轮必现）')
  assert.match(charter, /一之一、\*\*用户原话\*\*（未加工·最高优先级/, '总纲须带用户原话段（与目标冲突时以原话为准）')
  assert.match(tools, /## 用户原话（未加工）/, '导出物须留原话（否则事后查不出偏离）')
})

test('⑨-b 未留原话时须显式警示（不留白）', () => {
  const tools = read('tools.ts')
  assert.match(tools, /user directive: NOT recorded/, '未留档时须提示"你只有自己的转述"')
})

test('⑨-c usage 须有独立的锚定用户指令条 + 主持人闭环职责', () => {
  const usage = read('index.ts')
  assert.match(usage, /STAY ON THE USER'S DIRECTIVE/, '须有独立的锚定指令规则条')
  assert.match(usage, /clarify intent → compose the plan → dispatch → judge the returned results → re-dispatch/, '须写清主持人的闭环职责')
  assert.match(usage, /What does NOT count as progress/, '须定义"什么不算进展"（防自我感动式推进）')
  assert.match(usage, /never quietly redefine the goal/, '须禁止静默改目标')
})

/* ── ⑩ 边界可判定性：吸收 P10「成功标准须可量化」（结构性判据，非启发式）────── */

test('⑩-a boundary.check 须五段贯通：类型 → 卡片 → 总纲 → status → 导出', () => {
  const types = read('types.ts')
  const plan = read('plan.ts')
  const tools = read('tools.ts')
  const charter = read('charter.ts')
  assert.match(types, /check: string/, 'MeetingBoundary 须有 check 字段')
  assert.match(plan, /怎么检查/, '设置卡须渲染检查方式')
  assert.match(charter, /怎么检查才算达标/, '总纲须带检查方式（专家据此判"到底算不算完成"）')
  assert.match(tools, /check: meeting\.boundary\.check/, 'status 须回吐 check（消费面）')
  assert.match(tools, /- \*\*怎么检查\*\*：/, '导出物须留检查方式')
})

test('⑩-b 缺「怎么检查」时须出声（有 done 无 check 是"没人验得了的完成"）', () => {
  const tools = read('tools.ts')
  // 判因：done 已声明却没有任何检查方式 ⇒ 「完成」变成无法验证的主张（本插件反复剿的假绿形态）。
  assert.match(tools, /no way to check, so "done" cannot be verified/, 'status 须点破"无检查方式 ⇒ done 不可验证"')
  assert.match(tools, /a done-standard is declared but NOT how to check it/, 'status 须在 done 有值而 check 为空时显式警示')
})

test('⑩-c 量化判据不得做成关键词启发式（本项目已明令禁止分类判据）', () => {
  const plan = read('plan.ts')
  const tools = read('tools.ts')
  /*
   * 设计决定留档：曾拟"给 done 做模糊词表判定（性能良好/体验流畅 ⇒ 标红）"，
   * **主动放弃** —— 那正是 ⑦-c 同型的脆弱启发式（造假红假绿）。
   * 改采结构性判据：不问"写得够不够量化"（机器判不了），只问"有没有写下检查方式"
   * （存在性，确定性可判）。
   */
  for (const [name, text] of [['plan.ts', plan], ['tools.ts', tools]]) {
    assert.doesNotMatch(
      text,
      /性能良好|体验流畅|不可判定表述/,
      `${name} 不得内置模糊词表（分类启发式会造出假红假绿）`,
    )
  }
  assert.match(plan, /写不出检查方式的标准多半不可判定/, '须留档"结构判定而非措辞评判"的理由')
})
