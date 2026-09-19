/**
 * 用量端点 ↔ 1Hz 快照的**边界守卫**（第 4 轮验收：这条边界此前只靠注释维持）。
 *
 * 契约：`roundtable/usage.get` 是**按需**端点，理由是 `sessionProjections.snapshot()`
 * 会惰性折叠整条会话日志；`snapshot.ts`（1Hz 轮询快照）**不得**碰投影。
 * 若有人把用量塞回快照，性能会静默退化且没有任何断言会红 —— 本文件就是补上这条。
 *
 * 三条断言都是源码级、确定性的（不需要运行态）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const count = (text, needle) => text.split(needle).length - 1

test('1Hz 快照不得读投影：snapshot.ts 不许出现 sessionProjections / usage.ts', () => {
  const snapshot = read('../src/snapshot.ts')
  assert.doesNotMatch(snapshot, /sessionProjections/, '1Hz 快照读了投影 —— 会把整条会话日志每秒折叠一次')
  assert.doesNotMatch(snapshot, /from '\.\/usage\.ts'/, '1Hz 快照引入了用量取数面')
  assert.doesNotMatch(snapshot, /\btokenUsage\b/, '1Hz 快照不得含 provider 用量口径')
})

test('投影只允许在按需端点里读一次：rpc.ts 的 projections.snapshot( 调用数恒为 1', () => {
  const rpc = read('../src/rpc.ts')
  assert.equal(count(rpc, 'projections.snapshot('), 1, '投影快照调用点变多了 —— 先确认是不是进了多条路径')
  // 该调用必须落在 usage.get 的 case 内（用 case 标签切块，而不是全文搜索）
  const blocks = rpc.split(/case 'roundtable\//).slice(1)
  const owners = blocks.filter((block) => block.includes('projections.snapshot('))
  assert.equal(owners.length, 1, `投影读出现在 ${owners.length} 个 case 里`)
  assert.match(owners[0].slice(0, 40), /^usage\.get/, '投影读必须只出现在 usage.get')
})

test('`projections_available` 只能据实上报（不得写死 true/false）', () => {
  const rpc = read('../src/rpc.ts')
  assert.match(rpc, /projections_available: typeof projections\?\.snapshot === 'function'/,
    'projections_available 必须由服务实际能力推导')
  assert.doesNotMatch(rpc, /projections_available: (true|false)/, '不得写死 —— 客户端据此选文案')
})
