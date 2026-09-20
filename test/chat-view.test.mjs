/**
 * 群聊窗口（ChatView + 两个新端点）的测试。
 *
 * 三层各自会坏而互不报警，所以分三层测：
 *   1. **纯函数层**（`clampTranscriptLimit` / `selectTranscriptWindow` /
 *      `normalizeSayText`）：直接跑实现，断言边界行为。这层是**真断言**——
 *      它不查"源码里有没有这句话"，而是调进去看返回值。
 *   2. **端点接线层**（源码守卫）：两个 case 真的在 switch 里、真的走
 *      `withMeetingRpcLock`、真的调 `appendUtterance` 而不是自己写文件。
 *   3. **客户端接线层**（源码守卫）：群聊只在 chat 视图取数（不在 1Hz 轮询里）、
 *      发送失败不回滚成乐观 UI、时间轴在 chat 视图让位。
 *
 * ## 为什么第 2/3 层只能靠源码守卫
 *
 * 它们断言的是"接线接对了"，而 host 侧需要整个 cordis 组合体才能跑起来。
 * 因此这些断言一律**先去注释**再匹配（踩过的假绿：锚点字符串同时出现在注释里时，
 * 把真实代码改坏断言照样绿）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SAY_TEXT_MAX,
  TRANSCRIPT_LIMIT_DEFAULT,
  TRANSCRIPT_LIMIT_MAX,
  clampTranscriptLimit,
  normalizeSayText,
  selectTranscriptWindow,
} from '../src/rpc.ts'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
/** 去掉整行注释与块注释后再断言 —— 见文件头注释里的假绿教训。 */
const deComment = (text) =>
  text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '')

/* ------------------------------------------------------------------ *
 * 1. 纯函数层
 * ------------------------------------------------------------------ */

test('条数夹取：缺省/非法输入回落到默认值，绝不产生无界读', () => {
  assert.equal(clampTranscriptLimit(undefined), TRANSCRIPT_LIMIT_DEFAULT)
  assert.equal(clampTranscriptLimit(null), TRANSCRIPT_LIMIT_DEFAULT)
  assert.equal(clampTranscriptLimit('abc'), TRANSCRIPT_LIMIT_DEFAULT)
  assert.equal(clampTranscriptLimit(Number.NaN), TRANSCRIPT_LIMIT_DEFAULT)
  assert.equal(clampTranscriptLimit(Number.POSITIVE_INFINITY), TRANSCRIPT_LIMIT_DEFAULT)
})

test('条数夹取：超大值被夹到上限，0/负数被抬到 1', () => {
  assert.equal(clampTranscriptLimit(99999), TRANSCRIPT_LIMIT_MAX)
  assert.equal(clampTranscriptLimit(TRANSCRIPT_LIMIT_MAX + 1), TRANSCRIPT_LIMIT_MAX)
  assert.equal(clampTranscriptLimit(0), 1)
  assert.equal(clampTranscriptLimit(-5), 1)
  assert.equal(clampTranscriptLimit(3.9), 3)
})

test('窗口切分：since 是严格大于（增量补齐不会重复送回边界那条）', () => {
  const all = [{ ts: 10 }, { ts: 20 }, { ts: 30 }]
  assert.deepEqual(selectTranscriptWindow(all, 20, 100).items, [{ ts: 30 }])
  assert.deepEqual(selectTranscriptWindow(all, 0, 100).items, all)
})

test('窗口切分：超限时取尾部（看最新），但保持升序返回', () => {
  const all = [{ ts: 1 }, { ts: 2 }, { ts: 3 }, { ts: 4 }, { ts: 5 }]
  const { items } = selectTranscriptWindow(all, 0, 3)
  assert.deepEqual(items, [{ ts: 3 }, { ts: 4 }, { ts: 5 }])
  // 升序：前端直接按数组顺序渲染气泡即为时间顺序。
  assert.ok(items.every((item, index) => index === 0 || items[index - 1].ts < item.ts))
})

test('窗口切分：truncated 由 host 判定，且是精确判定（客户端不再拿本地页大小常量去猜）', () => {
  // host 看得见全量，所以判定是**精确**的，不是客户端那种"等于上限就保守算截断"：
  // 正好装满上限 = 一条都没丢 ⇒ 不截断。客户端旧写法（length >= PAGE）在这里会
  // 误报 —— 而那正是我们要修掉的、依赖两份常量同步的推断。
  const exact = [{ ts: 1 }, { ts: 2 }, { ts: 3 }]
  assert.equal(selectTranscriptWindow(exact, 0, 3).truncated, false, '正好装满不等于截断')
  // 超出上限才真的丢了更早的发言。
  const over = [{ ts: 1 }, { ts: 2 }, { ts: 3 }, { ts: 4 }]
  assert.equal(selectTranscriptWindow(over, 0, 3).truncated, true, '超出上限必须报截断')
  // 边界：一条都没有 / 空上限视角。
  assert.equal(selectTranscriptWindow([], 0, 200).truncated, false)
  // since 过滤后再判定：过滤剩 2 条、上限 5 ⇒ 不截断（不能拿过滤前的总数判）。
  assert.equal(selectTranscriptWindow(over, 2, 5).truncated, false)
})

test('窗口切分：不修改入参（就地排序/去重会把宿主状态改掉）', () => {
  const all = [{ ts: 3 }, { ts: 1 }, { ts: 2 }]
  const before = all.map((item) => item.ts)
  selectTranscriptWindow(all, 0, 2)
  assert.deepEqual(all.map((item) => item.ts), before)
})

test('发言正文：空白被拒、两端空白被裁、超长被拒且不截断', () => {
  assert.equal(normalizeSayText('   ').ok, false)
  assert.equal(normalizeSayText(undefined).ok, false)
  assert.equal(normalizeSayText(123).ok, false)
  const trimmed = normalizeSayText('  你好  ')
  assert.equal(trimmed.ok, true)
  assert.equal(trimmed.text, '你好')
  const long = 'x'.repeat(SAY_TEXT_MAX + 1)
  const rejected = normalizeSayText(long)
  assert.equal(rejected.ok, false)
  // 上限之内必须原样保留（群聊要给人看完整的话，不做静默裁剪）。
  const atLimit = normalizeSayText('y'.repeat(SAY_TEXT_MAX))
  assert.equal(atLimit.ok, true)
  assert.equal(atLimit.text.length, SAY_TEXT_MAX)
})

/* ------------------------------------------------------------------ *
 * 2. 端点接线层（host）
 * ------------------------------------------------------------------ */

test('接线：两个端点都在 dispatch switch 里且都走会议锁', () => {
  const src = deComment(read('../src/rpc.ts'))
  for (const endpoint of ['roundtable/transcript.list', 'roundtable/say']) {
    const at = src.indexOf(`case '${endpoint}'`)
    assert.ok(at > 0, `${endpoint} 未注册`)
    // 从 case 到下一个 case 之间必须出现会议锁 —— 否则是"读得到但状态根没解析"
    // 或"写得到但没串行化"的静默坏法。
    const next = src.indexOf('case \'', at + 10)
    const body = src.slice(at, next > 0 ? next : src.length)
    assert.ok(body.includes('withMeetingRpcLock'), `${endpoint} 没走会议锁`)
  }
})

test('接线：say 走 appendUtterance（不自己拼文件写），且标 source=user + captain 身份', () => {
  const src = deComment(read('../src/rpc.ts'))
  const at = src.indexOf("case 'roundtable/say'")
  const next = src.indexOf('case \'', at + 10)
  const body = src.slice(at, next > 0 ? next : src.length)
  assert.ok(body.includes('appendUtterance('), 'say 没有调用 appendUtterance')
  assert.ok(body.includes('nodeKey: CAPTAIN_KEY'), 'say 的身份位不是 captain')
  assert.ok(body.includes("source: 'user'"), 'say 没有标 source=user（主持人将无法区分用户亲口说的话）')
  assert.ok(!body.includes('writeFile'), 'say 不得绕开 state 层自己写文件')
})

test('接线：say 落盘后**唤醒**主持人（落盘 ≠ 送达，不唤醒就是假成功）', () => {
  const src = deComment(read('../src/rpc.ts'))
  const at = src.indexOf("case 'roundtable/say'")
  const next = src.indexOf('case \'', at + 10)
  const body = src.slice(at, next > 0 ? next : src.length)
  // 只落盘不唤醒：用户在空闲会议里说话，气泡出现了却永远不会有人回应 ——
  // 这正是本插件一直在防的"假成功"。而且同一个输入条在空状态那一屏会 steer，
  // 两处行为必须一致。
  assert.ok(body.includes('steerCaptain('), 'say 没有唤醒主持人（落盘≠送达）')
  assert.ok(body.includes('delivered'), 'say 没有把送达结果回给前端')
  // 加壳：steer 出去的是 plugin 来源的消息，裸着转发用户原文会让主持人分不清
  // 这是用户本人在说话还是插件注入的文本。
  assert.ok(body.includes('Message from the user'), '唤醒时没有标明这条来自用户（主持人会误判来源）')
  // 唤醒必须在会议锁**之外**（steer 会推进入主持人的回合，不该占着会议锁）。
  const lockStart = body.indexOf('withMeetingRpcLock')
  const lockBody = body.slice(lockStart, body.indexOf('if (!recorded.ok)'))
  assert.ok(!lockBody.includes('steerCaptain('), 'steerCaptain 被放在会议锁内（会长时间占锁）')
})

test('接线：source=user 真的到得了主持人可读面（否则那条区分在 host 侧不可达）', () => {
  // `source` 字段存在的**唯一理由**是让主持人分辨"用户亲口说的"与"我自己说的"。
  // 若它只传到浏览器（wire.ts）而主持人读的 status/digest/export 都不带，
  // 这条区分就形同虚设 —— 主持人会把用户的话读成自己的话，于是不再回应。
  const tools = deComment(read('../src/tools.ts'))
  // ⚠ 必须断言**取值表达式**，不能只断言 `from_user:` 这个键出现过 ——
  // 写成 `from_user: false,` 同样含 `from_user:`，那样恒定绿（本守卫第一版就是，
  // 由 test/mutate.mjs 的变异 21 实证）。
  assert.match(
    tools,
    /from_user:\s*utterance\.source === 'user',/,
    'roundtable_status 的 recent_utterances 没有真的从 source 推导 from_user',
  )
  assert.ok(tools.includes('userSourceMark('), '导出没标出用户亲口的发言')
  const aggregator = deComment(read('../src/aggregator.ts'))
  assert.ok(aggregator.includes('userSourceMark('), '汇聚网关 digest 没标出用户亲口的发言')
  // 标记必须来自**单一来源**：四处各写各的字面量必然漂移。
  const shared = read('../src/utterance-source.ts')
  assert.ok(shared.includes("utterance.source === 'user'"), '共享标记函数没有真的判定 source=user')
})

test('接线：transcript.list 是只读端点（不做任何写入）', () => {
  const src = deComment(read('../src/rpc.ts'))
  const at = src.indexOf("case 'roundtable/transcript.list'")
  const next = src.indexOf('case \'', at + 10)
  const body = src.slice(at, next > 0 ? next : src.length)
  assert.ok(body.includes('readTranscript('), 'transcript.list 没有读全量发言')
  for (const forbidden of ['appendUtterance(', 'writeMeeting(', 'appendUserAction(']) {
    assert.ok(!body.includes(forbidden), `只读端点里出现了写操作：${forbidden}`)
  }
})

test('接线：transcript.list 真的调用了夹取与切分函数（不是只导入）', () => {
  const src = deComment(read('../src/rpc.ts'))
  const at = src.indexOf("case 'roundtable/transcript.list'")
  const next = src.indexOf('case \'', at + 10)
  const body = src.slice(at, next > 0 ? next : src.length)
  // 本仓已有的教训：函数写了、也导入了，但消费点没调用 —— 那是最隐蔽的假绿
  // （纯函数层全绿，而线上走的仍是老路径）。所以断言**调用点**。
  assert.ok(body.includes('clampTranscriptLimit('), 'transcript.list 没有调用条数夹取（可能无界读）')
  assert.ok(body.includes('selectTranscriptWindow('), 'transcript.list 没有用窗口切分函数')
})

test('接线：transcript.list 的注释里钉死"与专家侧可见性过滤是两套权限"', () => {
  const src = read('../src/rpc.ts')
  const at = src.indexOf("case 'roundtable/transcript.list'")
  const next = src.indexOf('case \'', at + 10)
  // 断言范围是**该 case 自己的区块**（含区块内注释）：说明写在实现旁边才有人看，
  // 写在文件头等于没写。这里刻意用未去注释的原文 —— 注释就是被测对象。
  const body = src.slice(at, next > 0 ? next : src.length)
  assert.ok(body.includes('statusVisibility'), '缺少权限边界说明（后人可能拿专家侧过滤来滤这个端点）')
  assert.ok(body.includes('两套独立权限'), '权限边界说明没写清"两套"')
})

test('快照轮询体不得被群聊扩容：recent 仍是 20 条 / 90 字截断', () => {
  const src = read('../src/snapshot.ts')
  assert.ok(src.includes('compactText(utterance.summary ?? utterance.content, 90)'), 'recent 的 90 字截断被改动')
  // ⚠ 这里**必须用词边界正则**，不能用 includes：`'out.length < 200'.includes('out.length < 20')`
  // 是 true —— 一条带 includes 的断言在"20 被改成 200"时照样绿，那就是假绿
  // （本守卫第一版正是如此，由 test/mutate.mjs 的变异 1 实证）。
  assert.match(src, /out\.length < 20\b(?!\d)/, 'recent 的 20 条上限被改动')
})

/* ------------------------------------------------------------------ *
 * 3. 客户端接线层
 * ------------------------------------------------------------------ */

test('客户端：群聊取数只在 chat 视图发生（不进 1Hz 轮询）', () => {
  const src = deComment(read('../src/client/RoundTableView.tsx'))
  // 全量拉取的调用点必须都在 `view === 'chat'` 守卫之后。
  const calls = [...src.matchAll(/fetchTranscript\(/g)].map((match) => match.index)
  assert.ok(calls.length >= 2, '找不到群聊取数调用点')
  const pollTickAt = src.indexOf('const tick = async (): Promise<void> => {')
  const pollBody = src.slice(pollTickAt, src.indexOf('window.setInterval', pollTickAt))
  assert.ok(!pollBody.includes('fetchTranscript'), '1Hz 轮询体里出现了群聊全量拉取')
})

test('客户端：发送不做乐观插入（失败时群聊里不会留下假消息）', () => {
  const src = deComment(read('../src/client/RoundTableView.tsx'))
  const at = src.indexOf('const sendChat = useCallback')
  const body = src.slice(at, src.indexOf('}, [rpc, meeting?.id, chatSending', at))
  assert.ok(body.includes("'roundtable/say'"), 'sendChat 没有调用 say 端点')
  // 关键：回包成功后才回读增量，而不是先把这条塞进列表。
  const beforeRead = body.slice(0, body.indexOf('mergeSince('))
  assert.ok(!beforeRead.includes('setChatMessages'), '在回读成功之前就改了列表（乐观插入）')
  assert.ok(body.indexOf('mergeSince(') > body.indexOf("'roundtable/say'"), '回读发生在发送之前')
})

test('客户端：增量合并的两个不变式（按 id 去重 + 合完按 ts 升序）', () => {
  const src = deComment(read('../src/client/RoundTableView.tsx'))
  const at = src.indexOf('const mergeSince = useCallback')
  const body = src.slice(at, src.indexOf('}, [rpc])', at))
  assert.ok(body.includes('seen.has(message.id)'), '合并没有按 id 去重（增量窗口会与本地重叠）')
  assert.ok(body.includes('merged.sort((a, b) => a.ts - b.ts)'), '合完没有重新按 ts 升序（气泡顺序会乱）')
})

test('客户端：chat 视图下让出拓扑时间轴（同一份信息不并列两份）', () => {
  const src = deComment(read('../src/client/RoundTableView.tsx'))
  assert.ok(src.includes("view === 'topology' ? ("), '拓扑块没有视图守卫')
  assert.ok(src.includes('data-rt-view={view}'), '缺少视图标记（无法机检当前视图）')
})

test('客户端：群聊组件存在且不与拓扑共用样式模块', () => {
  const src = deComment(read('../src/client/ChatView.tsx'))
  assert.ok(src.includes("from './ChatView.module.css'"), 'ChatView 未使用独立样式模块')
  assert.ok(!src.includes('RoundTableView.module.css'), 'ChatView 混用了拓扑样式模块')
  // aggregator 不是发言者，不得画成成员。
  assert.ok(!src.includes("key: 'aggregator'"), 'aggregator 被当成了群成员（它不是发言者）')
})

/* ------------------------------------------------------------------ *
 * 4. 空状态输入框（与会话级开场）
 * ------------------------------------------------------------------ */

test('接线：空状态与群聊窗口**共用同一个输入框组件**（不得各写一份）', () => {
  const empty = deComment(read('../src/client/RoundTableView.tsx'))
  const chat = deComment(read('../src/client/ChatView.tsx'))
  // 两处都必须出现 ChatComposer —— 用户的要求就是"那个输入框也就是群聊窗口的输入框"，
  // 复制一份会在下一次改动时立刻漂移。
  assert.ok(empty.includes('<ChatComposer'), '空状态没有用共享的 ChatComposer')
  assert.ok(chat.includes('<ChatComposer'), '群聊窗口没有用共享的 ChatComposer')
  // 群聊窗口里不得再内联 textarea（内联即第二份实现）。
  assert.ok(!chat.includes('<textarea'), '群聊窗口里内联了自己的 textarea')
  // 空状态**块内**不得内联 textarea。
  // ⚠ 范围必须收窄到那个 early-return 块：RoundTableView 另有合法的 textarea
  // （反馈备注、驳回理由），全文件断言会误报 —— 本守卫第一版就是这么假红的。
  const at = empty.indexOf('if (meeting === undefined)')
  const end = empty.indexOf('const modeLabel =', at)
  assert.ok(at > 0 && end > at, '找不到空状态块')
  assert.ok(!empty.slice(at, end).includes('<textarea'), '空状态块里内联了自己的 textarea')
})

test('接线：空状态的发送走 steer（会议还不存在），不是 say', () => {
  const src = deComment(read('../src/client/RoundTableView.tsx'))
  const at = src.indexOf('const startMeeting = useCallback')
  assert.ok(at > 0, '找不到 startMeeting')
  const body = src.slice(at, src.indexOf('}, [rpc, sessionId, steerSending, translate])', at))
  assert.ok(body.includes('steerSession('), 'startMeeting 没有调用 steerSession')
  assert.ok(!body.includes("'roundtable/say'"), 'startMeeting 误用了 say（会议此刻还不存在）')
})

test('接线：hooks 全部在 `meeting === undefined` 早退之前（否则两次渲染 hooks 数不同）', () => {
  const src = deComment(read('../src/client/RoundTableView.tsx'))
  const at = src.indexOf('if (meeting === undefined) {')
  assert.ok(at > 0, '找不到早退分支')
  // 无会议与有会议是**同一个组件的两次渲染**：早退之后若再出现 hook，两次渲染的
  // hooks 数量就不同，React 会在切到下一个会议时直接抛错（rules-of-hooks 违规）。
  // 这是加了空状态输入框之后新引入的风险点，故钉住。
  //
  // ⚠ 正则必须同时覆盖**裸调用**与**赋值式调用**两种写法：
  //   裸：`useEffect(() => ...)`
  //   赋值：`const [x, setX] = useState(false)` / `const f = useCallback(...)`
  // 只写 `^\s*useState\(` 会**恒不命中**（本仓代码风格永远是赋值式），
  // 于是这条断言永远绿 —— 第一版就是这样，由 test/mutate.mjs 的变异 18 实证。
  const after = src.slice(at)
  const offenders = after.match(/(?:\b(?:const|let|var)\s+[^\n=]+\=\s*|\b)(useState|useEffect|useMemo|useCallback|useRef)\s*\(/g)
  assert.equal(offenders, null, `早退之后出现了 hooks：${String(offenders)}`)
  // 另外：steer 用的状态与回调必须在早退之前就已声明（否则渲染时是 undefined）。
  assert.ok(src.indexOf('const [steerSending') < at, 'steerSending 声明在早退之后')
  assert.ok(src.indexOf('const startMeeting = useCallback') < at, 'startMeeting 声明在早退之后')
})

test('接线：steer 端点在 host 侧注册、走 mode 表 + steerCaptain，且不解析命令语法', () => {
  const src = deComment(read('../src/rpc.ts'))
  const at = src.indexOf("case 'roundtable/steer'")
  assert.ok(at > 0, 'steer 端点未注册')
  const next = src.indexOf('case \'', at + 10)
  const body = src.slice(at, next > 0 ? next : src.length)
  assert.ok(body.includes('runtime.mode.set(sessionId, \'manual\', true)'), 'steer 没有置讨论模式')
  assert.ok(body.includes('steerCaptain('), 'steer 没有走既有的主持人投递入口')
  // **顺序**也必须钉住：模式段是 system prompt 的一部分，先 steer 再置模式会出现
  // "议题已转交但主持人不知道要按圆桌处理"的窗口。只断言两者都出现是不够的 ——
  // 把两句对调后 include 断言照样全绿（由 test/mutate.mjs 的变异 19 实证）。
  const setAt = body.indexOf("runtime.mode.set(sessionId, 'manual', true)")
  const steerAt = body.indexOf('steerCaptain(')
  assert.ok(setAt >= 0 && steerAt >= 0, '找不到置模式/steer 的调用点')
  assert.ok(setAt < steerAt, '必须先置讨论模式再 steer（顺序反了主持人不知道按圆桌处理）')
  // 关键反例：不得复用 runModeCommand —— 它会把 "off" 当命令退模式，
  // 而输入框里打的每个字都是议题。
  assert.ok(!body.includes('runModeCommand('), 'steer 复用了命令解析（"off" 会被误当命令）')
  assert.ok(!body.includes('parseModeCommand('), 'steer 复用了命令解析')
  // 没有活 agent 时必须明确失败，不得假装已送达。
  assert.ok(body.includes('has no live agent'), '缺少"无活会话"的显式失败')
})

test('接线：截断标记由 host 给（客户端不得再拿本地页大小常量去猜）', () => {
  // 客户端旧写法 `list.length >= TRANSCRIPT_PAGE` 依赖"本地常量 == host 夹取上限"，
  // 而它们是两份彼此不知道的常量：host 上限一调小，客户端就拿小数字去比大数字，
  // 「更早的发言未载入」会**静默消失**，用户以为自己看到了全部。
  const client = deComment(read('../src/client/RoundTableView.tsx'))
  assert.ok(!/TRANSCRIPT_PAGE/.test(client), '客户端仍在用本地页大小常量推断截断')
  assert.ok(client.includes('page.truncated'), 'loadTranscript 没有消费 host 给的 truncated')
  const wire = deComment(read('../src/client/wire.ts'))
  assert.ok(wire.includes('truncated:'), 'fetchTranscript 没有把 truncated 带回前端')
})

test('接线：客户端真的引用了 steerSession（不是只定义了没人调）', () => {
  const empty = deComment(read('../src/client/RoundTableView.tsx'))
  assert.match(empty, /from '\.\/wire\.ts'/, 'RoundTableView 未从 wire 导入')
  assert.ok(empty.includes('steerSession'), 'RoundTableView 没有引用 steerSession')
  const wire = deComment(read('../src/client/wire.ts'))
  assert.ok(wire.includes("'roundtable/steer'"), 'wire.ts 没有 steer 的调用点')
})

test('语言字典：中英两份键集逐字一致（缺一条会让另一种语言显示键名）', async () => {
  const { zh, en } = await import('../src/client/locales.ts')
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(enKeys, zhKeys)
  // 群聊新增键必须两份都在。
  for (const key of ['viewTopology', 'viewChat', 'chatSend', 'chatYou', 'chatRoundDivider', 'emptyInputPlaceholder']) {
    assert.ok(zhKeys.includes(key), `zh 缺少 ${key}`)
    assert.ok(enKeys.includes(key), `en 缺少 ${key}`)
  }
})

test('客户端：切回拓扑时重新测量画布（旧 observers 不跟卸载的 DOM）', () => {
  const src = deComment(read('../src/client/RoundTableView.tsx'))
  // ResizeObserver 所在 effect 的依赖数组必须含 view。
  //
  // ⚠ 必须先断言 `indexOf` 命中：直接 `slice(at, src.indexOf('}, [view])', at))`
  // 在**找不到**时 indexOf 返回 -1，而 `slice(at, -1)` 会给出一大段字符串 ——
  // 断言照样通过。这是正编码的假绿，由 test/mutate.mjs 的变异 9 实证。
  const at = src.indexOf('const observer = new ResizeObserver(measure)')
  assert.ok(at > 0, '找不到画布测量的 ResizeObserver 装配点')
  const depAt = src.indexOf('}, [view])', at)
  assert.ok(depAt > 0, '画布测量 effect 没有依赖 view（切回后节点会挤在默认坐标）')
  assert.ok(depAt > at, '依赖数组的位置不在 effect 之后')
})
