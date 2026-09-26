/**
 * R-D-UI 接线守卫：把「调度面板」这条链路钉死。
 *
 * 为什么需要（本仓库实测过的假绿形态）：host 算了、快照没带、或视图没渲染，
 * 三处任一断掉都不会有类型错误 —— 面板只是"永远空着"，看起来像"本轮没任务"。
 * 本文件逐段断言**四段链路**都在：
 *   host 纯函数 → snapshot 字段 → wire 类型 → 视图渲染；
 * 外加三条口径守卫：
 *   ① 预设清单不得随 1Hz 快照重复搬运（只下发每会议独有的在场标记）；
 *   ② 面板 id 三处一致由 `panel-ids.test.mjs` 覆盖，这里只钉渲染存在；
 *   ③ 圆桌制下 [越界转派] 恒空（该协议是单线制专属）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildRoundSignals, onStagePresetEntries } from '../src/dispatch.ts'
// 共享渲染目录的**唯一实现处**（三个渲染测试中已改走沙箱模块的那两处，产物落在哪由它决定）。
import { RENDER_TMP_DIR } from './render-tmp-sandbox.mjs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 纯函数：`dir` 是否**落在仓库根内**（跨盘、仓库根自身都判否）。
 * 抽成纯函数是为了**两个方向都能断言** —— 判别力不靠"真实盘面恰好是对的"（见下面那条负控单元）。
 */
const isInsideRepo = (root, dir) => {
  const rel = relative(root, dir)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

test('R-D-UI 10: the render test must stay runnable on a fresh clone (self-create its tmp dir)', () => {
  // 实测坑：渲染测试的转译产物目录被 .gitignore 忽略，全新克隆上并不存在。
  // 只写 mkdtempSync 会以 ENOENT 全红（"我本地绿、别人一跑就红"）。
  // 判据：必须先 mkdirSync 建目录，且不得依赖系统临时目录（那样解析不到 react）。
  const render = read('../test/dispatch-panel-render.test.mjs')
  assert.match(render, /mkdirSync\(TMP_DIR, \{ recursive: true \}\)/, '必须先自建目录（否则全新克隆全红）')
  assert.doesNotMatch(render, /from 'node:os'/, '不得用系统临时目录（解析不到本仓 react）')
  assert.match(render, /\.render-tmp/, '必须仍指向共享渲染目录（不是另起一个目录）')
  /*
   * ⚠ 原断言在这里按**字面量**钉住 `new URL('./.render-tmp/', import.meta.url)`。它现在两头都不成立：
   *   ① 锁死写法：等价的 `fileURLToPath(new URL('./.render-tmp/', import.meta.url))` 会被误红；
   *   ② **射程没跟着实现走**：真正决定"产物落在哪"的那一行已集中到 `test/render-tmp-sandbox.mjs:46`，
   *      而本门只读 dispatch-panel 一个文件 ⇒ 把沙箱模块改成 %TEMP% 后本门仍全绿，两个渲染测试全红。
   *      （集中化会在不声不响中把守卫射程留在原地 —— 这正是本仓反复剿的"看着有门、其实没管到"。）
   * 改成**运行时可判的不变量**：拿模块导出的真实路径判"是否落在仓库内"。
   */
  const sandbox = read('../test/render-tmp-sandbox.mjs')
  assert.match(sandbox, /mkdirSync\(RENDER_TMP_DIR, \{ recursive: true \}\)/, '必须先自建目录（否则全新克隆全红）')
  assert.doesNotMatch(sandbox, /from 'node:os'/, '不得用系统临时目录（解析不到本仓 react）')
  assert.equal(
    isInsideRepo(REPO_ROOT, RENDER_TMP_DIR),
    true,
    '产物目录必须落在仓库内 —— Node 从产物所在目录向上找本仓 node_modules，写 %TEMP% 会 '
    + "Cannot find package 'react'（实测踩过）。实际解析为：" + RENDER_TMP_DIR,
  )
})

test('R-D-UI 10b 负控：isInsideRepo 在"仓库内 / 系统临时目录 / 仓库根自身"三处给出不同结论', () => {
  assert.equal(isInsideRepo(REPO_ROOT, join(REPO_ROOT, 'test', '.render-tmp')), true, '仓库内必须判是')
  assert.equal(isInsideRepo(REPO_ROOT, tmpdir()), false, '系统临时目录必须判否（本仓踩过 Cannot find package react）')
  assert.equal(isInsideRepo(REPO_ROOT, REPO_ROOT), false, '仓库根自身不算"落在仓库内"（那等于把产物写在仓库顶上）')
})

test('R-D-UI 9: charter must match the implementation on the egalitarian handoff protocol', () => {
  // 实现（dispatch.ts）对圆桌制**不收集** [越界转派]（那是单线制上行协议）。
  // 总纲若不说明，就成了"实现按 A 做、文案按 B 读"：专家照着写该标记，
  // 主持人机器上永远收不到 —— 这正是本批要消灭的"两条真相"。
  const charter = read('../src/charter.ts')
  const roundTableAt = charter.indexOf('const roundTableTeam')
  assert.ok(roundTableAt > 0, 'charter 必须仍有圆桌制段')
  const roundTableBlock = charter.slice(roundTableAt, charter.indexOf('return [', roundTableAt))
  assert.match(roundTableBlock, /直接转给名册里承担该职责的成员/, '圆桌制必须说"直接转给同伴"')
  assert.match(roundTableBlock, /不使用.*\[越界转派\]/, '圆桌制必须声明不使用该标记')
  // 反向：单线制段必须**保留**该协议（别为了对称把两边都写没了）
  const singleBlock = charter.slice(charter.indexOf('const singleLineTeam'), roundTableAt)
  assert.match(singleBlock, /\[越界转派\]/, '单线制必须保留该上行协议')
  assert.doesNotMatch(singleBlock, /不使用/, '单线制不得声明不使用（那正是它的协议）')
})

test('R-D-UI ①：host 快照必须返回 plan 与 talentPool（缺一个面板就是死面板）', () => {
  const snapshot = read('../src/snapshot.ts')
  assert.match(snapshot, /^  plan: \{/m, '快照类型必须含 plan')
  assert.match(snapshot, /^  talentPool: \{/m, '快照类型必须含 talentPool')
  // 构造点必须真的写入这两个字段（行首锚定：`notPlan,` 这类改名不得蒙混过关 ——
  // 本断言的第一版没锚行首，变异测试（改名 plan→notPlan）**照样绿**，已回修）。
  assert.match(snapshot, /^ {8}plan: \(\(\) => \{/m, '构造快照时必须真的写入 plan')
  assert.match(snapshot, /^ {8}talentPool: \{/m, '构造快照时必须真的写入 talentPool')
  // 判据必须复用 dispatch.ts 的纯函数 —— 工具说一套、UI 画一套就是两个判定者。
  assert.match(snapshot, /buildRoundSignals\(\{/, '对账信号必须走 dispatch.ts')
  assert.match(snapshot, /onStagePresetEntries\(meeting\.nodes\)/, '在场标记必须走 dispatch.ts')
  assert.match(snapshot, /planView\(meeting, presets\)/, '波次必须走计划校验器')
})

test('R-D-UI ②：快照不得随 1Hz 轮询重复搬运预设清单（只下发在场标记）', () => {
  const snapshot = read('../src/snapshot.ts')
  // 定位**构造点**（不是类型声明）：`talentPool: {` 出现在 return 对象里那一处。
  const at = snapshot.lastIndexOf('talentPool: {')
  assert.ok(at > 0, '应当找到 talentPool 的构造点')
  const block = snapshot.slice(at, at + 500)
  assert.match(block, /onStage:/, '只下发每会议独有的在场标记')
  assert.doesNotMatch(block, /candidates:/, '不得把全量预设清单按会议重复下发（客户端已从 prefs.get 拿到）')
  assert.match(block, /total: presets\.length/, 'total 仍要给，便于发现"预设读到 0 条"')
})

test('R-D-UI ③：wire 类型与视图必须一一接上（缺字段只是面板空着，不会报错）', () => {
  const wire = read('../src/client/wire.ts')
  assert.match(wire, /export interface WireDispatchPlan/, 'wire 必须声明调度计划类型')
  assert.match(wire, /export interface WireTalentPool/, 'wire 必须声明候选池类型')
  assert.match(wire, /plan\?: WireDispatchPlan/, 'WireMeeting 必须带上 plan')
  assert.match(wire, /talentPool\?: WireTalentPool/, 'WireMeeting 必须带上 talentPool')

  // R-D-UI 抽模块：面板本体在 DispatchPanel.tsx（为了能被**真渲染**断言），
  // 视图负责挂载并喂数据。两处都要钉 —— 只钉视图会漏掉面板内容，反之亦然。
  const view = read('../src/client/RoundTableView.tsx')
  const panel = read('../src/client/DispatchPanel.tsx')
  assert.match(panel, /data-rt-panel="dispatch"/, '面板必须渲染调度面板根节点')
  assert.match(panel, /plan\.waves\.map\(/, '必须渲染波次（并行/串行的可见证据）')
  assert.match(panel, /translate\('dispatchNoPlan'\)|t\('dispatchNoPlan'\)/, '缺计划必须显式提示，不能留白')
  assert.match(panel, /t\('dispatchUnparsable'\)/, '计划不可解析必须显式提示，不能画空波次图')
  assert.match(panel, /t\('dispatchUndispatched'\)/, '漏派必须显示')
  assert.match(panel, /t\('dispatchOutOfScope'\)/, '越界转派必须显示')
  assert.match(panel, /presets\.map\(/, '候选池必须渲染')
  // 视图必须挂载面板并喂 host 数据（缺任一个 = 面板永远空着）
  assert.match(view, /<DispatchPanel/, '视图必须挂载 DispatchPanel')
  assert.match(view, /plan=\{meeting\.plan\}/, '必须把 host 的计划喂进去')
  assert.match(view, /onStageIds=\{onStagePresetIds\}/, '必须把 host 的在场标记喂进去')
  // 在场标记只能来自 host（客户端不得自己按 role 文本猜）
  assert.match(view, /meeting\?\.talentPool\?\.onStage/, '在场标记必须读 host 快照')
  assert.doesNotMatch(view + panel, /preset\.role === node\.role/, '不得按 role 文本自行配对')
})

test('R-D-UI ④：host 必须把预设读取面接进快照路由（否则候选池恒 0 条）', () => {
  const index = read('../src/index.ts')
  // 0.1.7 迁移（ACT-373）：偏好不再经 `runtime.scope`（settings namespace 已随
  // `SettingsForms.register` 一起消失），改从 volatile Config 包装出的
  // `runtime.prefs` 实时读取。判据钉的仍是**同一意图**：快照路由必须现读现取
  // （不得烘焙成常量，否则设置页改了预设、候选池不跟着变）。
  assert.match(index, /getRolePresets: \(\) => runtime\.prefs\.get\(\)\?\.rolePresets/,
    '快照路由必须实时注入预设读取面')
  assert.match(index, /collectMeetingSnapshots\(ctx, roots, sessionFilter, \{/, '必须以选项传入')
})

test('R-D-UI ⑤：在场判定只有一个来源，且排除已移除席与临时角色', () => {
  // 与 buildTalentPool 共用 onStagePresetEntries —— 这里直接钉它的判据。
  const entries = onStagePresetEntries([
    { key: 'gone', status: 'removed', presetId: 'verify' },
    { key: 'adhoc', status: 'idle', presetId: undefined },
    { key: 'live', status: 'idle', presetId: 'verify' },
  ])
  assert.deepEqual(entries, [{ preset_id: 'verify', node_keys: ['live'] }])
})

test('R-D-UI ⑥：圆桌制下越界转派恒空（面板不得显示该模式不存在的信号）', () => {
  const utterances = [{ nodeKey: 'impl', content: '[越界转派]：数据迁移 | 建议承接：数据与迁移', round: 1 }]
  const base = { round: 1, plan: undefined, liveSeatKeys: ['impl'], utterances }
  assert.equal(buildRoundSignals({ ...base, mode: 'egalitarian' }).out_of_scope_total, 0)
  assert.equal(buildRoundSignals({ ...base, mode: 'orchestrated' }).out_of_scope_total, 1)
})

test('R-D-UI ⑦：面板必须抽成独立模块，以便被**真渲染**断言（否则只能做源码字符串断言）', () => {
  // 这条守卫防的是"把面板摊回 1900 行的视图里" —— 那样 `dispatch-panel-render.test.mjs`
  // 就只能断言源码字符串，退回 verify 席拒绝接受的证据强度（声明消费者 ≠ 渲染生效）。
  const panel = read('../src/client/DispatchPanel.tsx')
  assert.match(panel, /export function DispatchPanel/, '面板必须是可独立 import 的组件')
  // 必须是纯展示：不得引入 hooks / IO（否则渲染面测试无法在 node 里跑起来）
  assert.doesNotMatch(panel, /useState|useEffect|useMemo|fetch\(/, '面板不得有 hooks/IO，否则不可渲染')
  // 渲染面测试必须真的 import 生产模块（不是自己复刻一份 —— 那是夹具绿）
  const render = read('../test/dispatch-panel-render.test.mjs')
  assert.match(render, /src\/client\/DispatchPanel\.tsx/, '渲染测试必须指向生产模块')
  assert.doesNotMatch(render, /function DispatchPanel/, '渲染测试不得自己复刻面板实现')
})

test('R-D-UI ⑧：buildRoundSignals 的每个输出字段都必须有消费者（不得算出来没人看）', () => {
  // 本仓实测过的形态：字段算出来、进了 JSON，但**没有任何渲染** ——
  // 模型/用户看不见，等于闸没接（`planned_owners` 就是这样被漏掉过一次：
  // 它是席位侧分母，只在"有偏差时"才打印，读的人看不到比较基准）。
  // 用运行时 Object.keys 取字段（不是扫源码字符串），新增字段若没接上即红。
  const tools = read('../src/tools.ts')
  const snapshot = read('../src/snapshot.ts')
  const sample = buildRoundSignals({
    round: 1, mode: 'orchestrated', plan: undefined, liveSeatKeys: [], utterances: [], onStageByPreset: {},
  })
  const unconsumed = Object.keys(sample).filter((field) =>
    !tools.includes(`signals.${field}`) && !snapshot.includes(`signals.${field}`))
  assert.deepEqual(unconsumed, [], `这些字段算出来却没有消费者：${unconsumed.join(', ')}`)
})
