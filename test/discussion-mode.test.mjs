/**
 * 讨论模式（会话级）测试：状态表语义 + 命令解析 + 接线守卫。
 *
 * 分三层，因为这三层会各自坏而互不报警：
 *   1. **语义层**（`SessionModeTable`）：两个来源互不覆盖 —— 这是这套设计的
 *      全部要害，tab 切走把命令开的模式一起关掉是最容易犯的错；
 *   2. **解析层**（`parseModeCommand`）：裸调用=开、`off`=关、其余=议题；
 *   3. **接线层**（源码守卫）：host 真的注册了 `/roundtable`、客户端真的在
 *      挂载/卸载时写 `auto`、提示词段真的按会话条件化。类型检查不查这些。
 *
 * ## 反验收（变异实测，2026-09-20）
 *
 * 九组变异逐个把实现改坏，确认对应守卫**真的转红**（这是"断言写了"与"断言有效"
 * 的分别）。其中两组第一轮是 fail=0 的**假绿**，已就地修强：
 *   - W1：`ctx.inject(['commands'])` 改成 `['settings']` → 原断言在**去注释后**才判定
 *     （旧写法匹配到了注释里那句同一字符串）；
 *   - W3：卸载写 `active:false` 改成 `true` → 原断言只查"文件里出现过 active:false"，
 *     被挂载路径那一次冒充；改为**只在 cleanup 切片内**断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MODE_COMMAND_NAME,
  MODE_OFF,
  SessionModeTable,
  isModeActive,
  parseModeCommand,
  runModeCommand,
} from '../src/mode.ts'

/**
 * 剥掉整行注释后再断言。
 *
 * 为什么必须剥（实测踩到的假绿）：`assert.match(src, /ctx\.inject\(\['commands'\]/)`
 * 在**注释里也写了同一句**时恒真 —— 把真实代码改成 `ctx.inject(['settings'], ...)`
 * 后这条断言照样绿（变异测试 fail=0）。凡"锚点字符串同时出现在注释里"的断言，
 * 都必须在去注释的文本上跑。
 */
const stripLineComments = (text) => text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('未记录的会话读作关，且不是"未知"（缺失不是错误）', () => {
  const table = new SessionModeTable()
  assert.deepEqual(table.read('never-seen'), MODE_OFF)
  assert.equal(table.isActive('never-seen'), false)
  assert.equal(table.size(), 0, '读操作不得写入记录（读不该有副作用）')
})

test('两个来源互不覆盖：清 auto 不得关掉 manual，反之亦然', () => {
  const table = new SessionModeTable()
  table.set('s1', 'manual', true)
  table.set('s1', 'auto', true)
  assert.deepEqual(table.read('s1'), { auto: true, manual: true })

  table.set('s1', 'auto', false)
  assert.deepEqual(table.read('s1'), { auto: false, manual: true })
  assert.equal(table.isActive('s1'), true, '这是本设计的要害：tab 切走不关命令开的模式')

  table.set('s1', 'manual', false)
  assert.equal(table.isActive('s1'), false)
  assert.deepEqual(table.read('s1'), MODE_OFF, '两份都撤后回到未开')
})

test('会话之间互不影响（键是会话，不是全局开关）', () => {
  const table = new SessionModeTable()
  table.set('a', 'manual', true)
  assert.equal(table.isActive('a'), true)
  assert.equal(table.isActive('b'), false)
})

test('isModeActive 是"任一为真"，与来源无关', () => {
  assert.equal(isModeActive({ auto: true, manual: false }), true)
  assert.equal(isModeActive({ auto: false, manual: true }), true)
  assert.equal(isModeActive(MODE_OFF), false)
})

test('值未变的写入返回原引用（调用方可据此跳过重渲染）', () => {
  const table = new SessionModeTable()
  const first = table.set('s1', 'manual', true)
  const again = table.set('s1', 'manual', true)
  assert.equal(first, again, '第二次写同一值必须返回同一引用')
})

test('/roundtable 尾部分类：裸调用=开、off=关、其余=议题', () => {
  assert.deepEqual(parseModeCommand(''), { kind: 'enable' })
  assert.deepEqual(parseModeCommand('   '), { kind: 'enable' })
  for (const word of ['off', 'OFF', 'disable', '关', '关闭']) {
    assert.deepEqual(parseModeCommand(word), { kind: 'disable' }, `${word} 应判为关闭`)
  }
  assert.deepEqual(parseModeCommand('评审这套架构'), { kind: 'topic', topic: '评审这套架构' })
  // 已知边界：`on` 与议题无法从文本区分（都非空非 off），故显式列为开。
  assert.deepEqual(parseModeCommand('on'), { kind: 'enable' })
})

test('执行命令：开/关改的是状态，带议题时另给一段转交文本', () => {
  const table = new SessionModeTable()

  const enabled = runModeCommand(table, 's1', '')
  assert.equal(enabled.steerText, '')
  assert.deepEqual(enabled.state, { auto: false, manual: true })
  assert.equal(table.isActive('s1'), true)
  assert.match(enabled.text, /已开启/)

  const topic = runModeCommand(table, 's2', '评审 A 与 B 的取舍')
  assert.equal(topic.steerText, '评审 A 与 B 的取舍', '议题必须原样转交，不得被改写')
  assert.equal(table.isActive('s2'), true)
  assert.match(topic.text, /评审 A 与 B 的取舍/, '结果文案要回显议题（否则用户不知道转交了什么）')

  // 关闭必须连 tab 那份一起撤：否则用户敲了 off 而 tab 还开着，看不到变化
  table.set('s3', 'auto', true)
  runModeCommand(table, 's3', 'off')
  assert.equal(table.isActive('s3'), false, 'off 必须能关掉 tab 开的模式（假反馈防线）')
})

test('接线守卫①：host 真的注册了 /roundtable，且缺席命令面时不炸插件', () => {
  const index = stripLineComments(read('../src/index.ts'))
  assert.match(index, /ctx\.inject\(\['commands'\]/, '必须用懒注入挂载命令面（无头 profile 下插件其余功能仍可用）')
  assert.match(index, /commands\.register\(\{/, '必须真的调用 register')
  assert.match(index, /name: MODE_COMMAND_NAME/, '命令名必须取自单源常量，不得散落字面量')
  assert.match(index, /from '@deepseek-ai\/dsh-commands'/, '需要类型导入才能让 ctx.commands 可见')
  assert.equal(MODE_COMMAND_NAME, 'roundtable')
})

test('接线守卫②：提示词段按会话条件化（不能常驻，也不能无条件返回空）', () => {
  const index = read('../src/index.ts')
  const at = index.indexOf("name: 'roundtable:mode'")
  assert.ok(at >= 0, '必须注册 roundtable:mode 段')
  // 终点取"下一个装配段"的锚点，而不是第一个 '})' —— 类型注解里就含 '})'，
  // 裸 indexOf 会在半个表达式处截断（实测踩过）。
  const block = index.slice(at, index.indexOf('// Settings-backed runtime preferences', at))
  assert.match(block, /modeTable\.isActive\(/, '段文本必须查会话状态（这是模式的全部作用机制）')
  assert.match(block, /return ''/, '未开时必须返回空串（否则模式等于常开）')
  assert.match(block, /assemble\.agent\?\.session\.id/, '必须从装配上下文取 agent 的会话 id')
  assert.match(block, /if \(sessionId === ''\) return ''/, '拿不到会话 id 时必须退化成空（不得抛错）')
  // 类型面：不得回退成 `as {...}` 断言 —— 那会让 agent 形状漂移在编译期静默通过
  assert.doesNotMatch(block, /as \{ agent/, '不得用 as 断言绕开 AssembleContext 的真实类型')
})

test('接线守卫③：客户端挂载写 auto、卸载撤 auto，且徽章读 host 真值', () => {
  const view = stripLineComments(read('../src/client/RoundTableView.tsx'))
  assert.match(view, /'roundtable\/mode\.set'/, '必须调 mode.set')
  assert.match(view, /'roundtable\/mode\.get'/, '必须调 mode.get（命令开的模式要能亮）')
  // 挂载效应：从 effect 起点切到它的依赖数组，取整段。
  const anchor = "useEffect(() => {\n    let alive = true\n    const write"
  const at = view.indexOf(anchor)
  assert.ok(at >= 0, '找不到模式写入的挂载效应（锚点漂了就要同步改本守卫）')
  const effect = view.slice(at, view.indexOf('}, [rpc, sessionId])', at))
  // 卸载路径：cleanup 里必须有一次 active:false，且必须在 **cleanup 内部** ——
  // 只断言"文件里出现过 active:false"会被挂载路径的那一次冒充（假绿）。
  const cleanupAt = effect.indexOf('return () => {')
  assert.ok(cleanupAt >= 0, '挂载效应必须有 cleanup（否则切走不撤模式）')
  const cleanup = effect.slice(cleanupAt)
  assert.match(cleanup, /active: false/, 'cleanup 必须写 active:false（切走要撤自己那份）')
  assert.match(cleanup, /alive = false/, '卸载后必须丢掉晚到的回包（否则 React 报警 + 假状态）')
  assert.ok(cleanup.indexOf('active: false') > cleanup.indexOf('alive = false'),
    '先立 alive=false 守卫再发请求，否则回包仍会写进已卸载组件')
  // 徽章自身的显示条件已搬进共享组件（v0.2.50），其守卫见接线守卫⑥。
})

test('接线守卫⑥：徽章是**一个**组件、两处共用，且两处都渲得出来', () => {
  const view = stripLineComments(read('../src/client/RoundTableView.tsx'))
  // 必须引用共享组件，而不是各写一份内联标记（两份会漂移，而它承载的是状态事实）。
  assert.match(view, /from '\.\/ModeBadge\.tsx'/, '未引用共享的 ModeBadge')
  // ⚠ 两处徽章**都在** `if (meeting === undefined) {` 之后（空状态那一块在早退体内部，
  // 头部在早退体之后），所以不能用那一行做切片边界 —— 用早退体的结束锚点
  // （`const modeLabel =`，与 chat-view.test.mjs 同一对锚点）。
  const earlyAt = view.indexOf('if (meeting === undefined) {')
  const earlyEnd = view.indexOf('const modeLabel =', earlyAt)
  assert.ok(earlyAt >= 0 && earlyEnd > earlyAt, '找不到早退体（锚点漂了就要同步改本守卫）')
  const emptyScreen = view.slice(earlyAt, earlyEnd)
  const header = view.slice(earlyEnd)
  assert.match(emptyScreen, /<ModeBadge /, '空状态那一屏没有徽章（模式开着却看不见）')
  assert.match(header, /<ModeBadge /, '有会议时的头部没有徽章')
  // 两处引用的是同一个组件 —— 抽出来之后仍内联一份自己的标记就白抽了。
  assert.ok(!/modeViaCommand|modePersistent/.test(view), '视图里仍内联了徽章文案（应只在共享组件里）')
  // 组件侧：真值未到时不得画（否则先画"关"再跳"开"，用户看到一次不存在的状态变化）；
  // `manual` 那一份必须能被区分显示。
  const badge = stripLineComments(read('../src/client/ModeBadge.tsx'))
  assert.match(badge, /state === null\) return null/, '真值未到前不得画徽章')
  assert.match(badge, /state\.manual \?/, '未区分"切走也不关"的那一份')
})

test('接线守卫④：rpc 端点存在，且 mode.set 校验输入（不写垃圾键）', () => {
  const rpc = stripLineComments(read('../src/rpc.ts'))
  assert.match(rpc, /case 'roundtable\/mode\.get'/, '缺 mode.get 端点')
  assert.match(rpc, /case 'roundtable\/mode\.set'/, '缺 mode.set 端点')
  const setAt = rpc.indexOf("case 'roundtable/mode.set'")
  const block = rpc.slice(setAt, rpc.indexOf("case 'roundtable/user-actions.append'", setAt))
  assert.match(block, /sessionId === ''/, '空 sessionId 必须拒绝（否则垃圾键常驻内存表）')
  assert.match(block, /typeof body\?\.active !== 'boolean'/, 'active 必须是布尔（非布尔一律拒绝）')
  assert.match(block, /runtime\.mode === undefined/, '状态表缺席必须报错，不得静默吞掉')
})

test('接线守卫⑤：mode 是可选的（旧配置/无 UI 组合下插件仍装配）', () => {
  const rpc = stripLineComments(read('../src/rpc.ts'))
  assert.match(rpc, /mode\?: SessionModeTable/, '必须声明为可选字段（装配点只有一个，缺席不该炸）')
  const index = stripLineComments(read('../src/index.ts'))
  assert.match(index, /mode: modeTable/, 'index 必须真的把表接进去（声明了却没人装配 = 死字段）')
})

test('接线守卫⑦：投递主持人**一律经 steerCaptain**，且不得有裸 steer（2026-09-23 实测反例）', () => {
  // 为什么加这一条：封皮原本靠「每个调用点自己记得加」，实测**两处漏加**，
  // 而漏加的恰好是同一语义的两个入口 —— `/roundtable <议题>` 命令（index.ts）
  // 与空状态输入框（rpc.ts 的 roundtable/steer，其注释自述「与斜杠命令完全一致」）。
  // 会话日志实证：命令路径转交出去的正文是 `整理一下我需要对整个项目做…`，
  // 首行没有任何出处；而同一次会话里 `say` 路径的正文首行是
  // `Message from the user (meeting group chat):`。同一件事两种真相。
  //
  // 本守卫钉住"封皮只有一个产地"：任何直接 `agent.steer(createUserMessage(...))`
  // 的裸投递都必须为零 —— 因为那条路不经过 CaptainProvenance 的类型强制。
  const files = ['../src/index.ts', '../src/rpc.ts', '../src/tools.ts', '../src/members.ts']
  const raw = new Map(files.map((f) => [f, stripLineComments(read(f))]))
  for (const [file, src] of raw) {
    // members.ts 是 steerCaptain 自己的实现，唯一允许出现 createUserMessage 的地方。
    if (file.endsWith('members.ts')) continue
    assert.ok(
      !/\.steer\(\s*createUserMessage/.test(src),
      `${file} 里出现了裸 steer(createUserMessage(...)) —— 投递主持人必须走 steerCaptain(出处, 正文)`,
    )
  }
  // 反向：调用点的实参必须**声明出处**（漏了 typecheck 就过不去；
  // 这里再钉一次是因为 typecheck 在本机因 peer 声明解析失败而常年红，
  // 不能把这条纪律的发现责任全押在一个已经红的闸上）。
  const callers = ['../src/index.ts', '../src/rpc.ts', '../src/tools.ts']
  const provenanceKinds = new Set()
  for (const file of callers) {
    const src = raw.get(file)
    for (const m of src.matchAll(/steerCaptain\([^,]+,\s*\{\s*kind:\s*'([a-z-]+)'/g)) provenanceKinds.add(m[1])
  }
  assert.deepEqual(
    [...provenanceKinds].sort(),
    ['meeting-group-chat', 'node', 'user-topic'],
    '三类出处都必须被真实调用点使用（少一类说明某条投递路径没走 steerCaptain）',
  )
  // 封皮工厂是唯一产地：三类都必须真的产出文本（掏空 provenanceLabel 会静默裸投）。
  const members = raw.get('../src/members.ts')
  for (const label of ['(round-table topic)', '(meeting group chat)', 'RoundTable message from ']) {
    assert.ok(members.includes(label), `provenanceLabel 缺少封皮片段：${label}`)
  }
})
