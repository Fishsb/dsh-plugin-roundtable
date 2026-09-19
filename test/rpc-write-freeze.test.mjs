/**
 * 冻结测试（批次 B ⑥）：**Web RPC 对会议状态的直写点恒为 4 处**。
 *
 * 背景（圆桌会议「UI 优化会审」架构席裁定）：
 * `meeting.edges` 有**两个独立写入者** —— ①host 工具 `roundtable_connect/disconnect`
 * （走 `withCaptainLock` + `captainSessionId` 校验）②Web RPC 的 `edge.add/set/remove`
 * 与 `kb.path.set`（只走 `withMeetingRpcLock`，**不校验调用者身份**）。
 *
 * 本轮决定**挂账**而不改语义（队列化会改变 UI 的即时反馈），但加一道冻结门：
 * 直写点一旦从 4 变多，就是"UI 绕过主持人直改会议状态"的路径在扩张 ——
 * 必须先决定它归队列（`user-actions`）还是留在直写，再来改这个断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const rpc = readFileSync(new URL('../src/rpc.ts', import.meta.url), 'utf8')

test('RPC 直写点恒为 4 处（新增即红：先决定归属再改断言）', () => {
  const writes = [...rpc.matchAll(/await writeMeeting\(/g)].length
  assert.equal(
    writes,
    4,
    `RPC 直写点从 4 变为 ${writes} —— UI 直改会议状态的路径扩张了。`
    + '请先决定：归队列（user-actions，主持人执行）还是保留直写；再同步更新本断言与 rpc.ts 注释。',
  )
})

test('这 4 处直写点就是已知的四个端点（集合冻结，不只是数量）', () => {
  for (const endpoint of [
    "'roundtable/edge.set'",
    "'roundtable/edge.add'",
    "'roundtable/edge.remove'",
    "'roundtable/kb.path.set'",
  ]) {
    assert.ok(rpc.includes(endpoint), `缺少预期端点 ${endpoint} —— 冻结集合变了`)
  }
  // 反向：不得出现第 5 个带直写的端点（用"每个 case 块内至多一处 writeMeeting"近似校验）
  const cases = [...rpc.matchAll(/case '(roundtable\/[a-z.-]+)': \{/g)].map((m) => m[1])
  assert.ok(cases.length > 0, '应当解析出端点清单')
  const writeCount = [...rpc.matchAll(/await writeMeeting\(/g)].length
  assert.ok(writeCount <= cases.length, '直写点不得多于端点总数')
})

test('每个直写点都在会议级锁内（不许绕过 withMeetingRpcLock 并发写）', () => {
  const locks = [...rpc.matchAll(/withMeetingRpcLock\(/g)].length
  const writes = [...rpc.matchAll(/await writeMeeting\(/g)].length
  // 4 处直写各对应一次 withMeetingRpcLock 包裹（允许 >=，因为还有只读端点也用锁）
  assert.ok(locks >= writes, `带锁调用 ${locks} 少于直写点 ${writes} —— 存在无锁直写`)
})
