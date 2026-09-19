/**
 * 冻结测试（批次 B ⑥；第 4 轮验收后**重写**）：Web RPC 的状态写入面**按符号白名单计数**。
 *
 * 为什么重写：旧版只有两条断言，其中 `writeCount <= cases.length` 是**恒真**的
 * （4 <= 16），而正向那条只数 `await writeMeeting(`。第 4 轮验收给出的最小反例：
 * 在 `applyViewpointStatus`（模块级函数，不在任何 `case` 块内）里再加一次状态写，
 * 整道门**照样绿** —— 门挡不住它宣称要挡的"直写面扩张"。
 *
 * 现行契约：把**每一个**碰会议/账本状态的写入符号都登记进来，逐个断言精确次数。
 * 新增一条写入路径（或给已有路径加一次写）都会让对应计数变化 → 断言转红。
 * 计数口径：**全文子串计数**（含模块级函数内的调用；import 行按实测为 0，故不影响）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const rpc = readFileSync(new URL('../src/rpc.ts', import.meta.url), 'utf8')

/** 已登记的状态写入符号 → 期望次数（数字来自实测，改代码必须同步改这里）。 */
const STATE_WRITERS = {
  'await writeMeeting(': 4,
  'setViewpointStatus(': 1,
  'appendUserAction(': 2,
  'rm(meetingDirOf': 1,
}

const countOf = (needle) => rpc.split(needle).length - 1

test('状态写入面：每个已登记符号的次数都必须精确匹配（多一处即红）', () => {
  for (const [symbol, expected] of Object.entries(STATE_WRITERS)) {
    const actual = countOf(symbol)
    assert.equal(
      actual,
      expected,
      `${symbol} 的写入次数从 ${expected} 变为 ${actual} —— UI/宿主写会议状态的路径变了。`
      + '请先决定：归队列（user-actions，主持人执行）还是保留直写；再同步更新本断言与 rpc.ts 注释。',
    )
  }
})

test('已登记的写入点必须真的存在（防符号被改名后这条门静默失效）', () => {
  for (const symbol of Object.keys(STATE_WRITERS)) {
    assert.ok(countOf(symbol) > 0, `写入符号 ${symbol} 在 rpc.ts 里找不到 —— 它可能被改名了，请同步本表`)
  }
})

test('四个 edge/kb 直写端点仍在（集合冻结，不只是数量）', () => {
  for (const endpoint of [
    "'roundtable/edge.set'",
    "'roundtable/edge.add'",
    "'roundtable/edge.remove'",
    "'roundtable/kb.path.set'",
  ]) {
    assert.ok(rpc.includes(endpoint), `缺少预期端点 ${endpoint} —— 冻结集合变了`)
  }
})

test('每个直写点都在会议级锁内（不许绕过 withMeetingRpcLock 并发写）', () => {
  const locks = countOf('withMeetingRpcLock(')
  const writes = countOf('await writeMeeting(')
  // 4 处直写各对应一次 withMeetingRpcLock 包裹（允许 >=，因为还有只读端点也用锁）
  assert.ok(locks >= writes, `带锁调用 ${locks} 少于直写点 ${writes} —— 存在无锁直写`)
})
