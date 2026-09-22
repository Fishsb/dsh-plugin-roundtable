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
  assert.match(tools, /never pretend it was collected|Do not treat "nobody raised it again" as agreement/, '须禁止把"没人再提"当一致')
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
