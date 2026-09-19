/**
 * 三模式语义（用户定稿 2026-09-19）：可见性谓词 + 收件人策略的纯函数断言。
 *
 * 覆盖方案里的 B 组判据：
 *  - B1 statusVisibility：单线制节点只放行自身相关；captain 与 egalitarian 全量。
 *  - B2 recipientPolicy：单线制下节点只能发主持人。
 *  - B3 recipientPolicy：广播 to="all" 仅 egalitarian。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { recipientPolicy, statusVisibility } from '../src/visibility.ts'

const MODES = ['orchestrated', 'egalitarian', 'redteam']

test('B1 captain 在任何模式下都是全量视图', () => {
  for (const mode of MODES) {
    const vis = statusVisibility(mode, 'captain', 'captain')
    assert.equal(vis.full, true, `${mode} 主持人应全量`)
    assert.equal(vis.node({ key: 'other' }), true)
    assert.equal(vis.utterance({ speaker: 'other', to: 'captain' }), true)
    assert.equal(vis.edge({ from: 'a', to: 'b' }), true)
    assert.equal(vis.action({ nodeKey: 'other' }), true)
  }
})

test('B1 egalitarian 专家是全量视图（圆桌制：知道全部席位）', () => {
  const vis = statusVisibility('egalitarian', 'node', 'a')
  assert.equal(vis.full, true)
  assert.equal(vis.node({ key: 'b' }), true)
  assert.equal(vis.utterance({ speaker: 'b' }), true)
})

test('B1 单线制专家只放行自身相关（不可见他人）', () => {
  for (const mode of ['orchestrated', 'redteam']) {
    const vis = statusVisibility(mode, 'node', 'a')
    assert.equal(vis.full, false, `${mode} 应为过滤视图`)
    // 节点：只有自己
    assert.equal(vis.node({ key: 'a' }), true)
    assert.equal(vis.node({ key: 'b' }), false)
    // 发言：自己发的 / 定向发给自己的；他人对他人、他人交网关的一律不可见
    assert.equal(vis.utterance({ speaker: 'a' }), true)
    assert.equal(vis.utterance({ speaker: 'b', to: 'a' }), true)
    assert.equal(vis.utterance({ speaker: 'b', to: 'captain' }), false)
    assert.equal(vis.utterance({ speaker: 'b' }), false)
    assert.equal(vis.utterance({ speaker: 'b', to: 'c' }), false)
    // 连线：只有「自己 ↔ 主持人/网关」可见
    assert.equal(vis.edge({ from: 'captain', to: 'a' }), true)
    assert.equal(vis.edge({ from: 'a', to: 'captain' }), true)
    assert.equal(vis.edge({ from: 'captain', to: 'b' }), false)
    assert.equal(vis.edge({ from: 'b', to: 'c' }), false)
    // arch 第 2 轮实证的漏洞：旧谓词放行「自己参与的一切边」，
    // 于是 a→b 会把同伴 b 的 key 泄露给 a（专家互不披露语义被绕过）。
    assert.equal(vis.edge({ from: 'a', to: 'b' }), false, 'a→b 不得暴露同伴 b')
    assert.equal(vis.edge({ from: 'b', to: 'a' }), false, 'b→a 同样不得暴露 b')
    // 网关不是同伴：自己 ↔ 汇聚网关属本职通道，可见
    assert.equal(vis.edge({ from: 'a', to: 'aggregator' }), true)
    assert.equal(vis.edge({ from: 'aggregator', to: 'a' }), true)
    // 用户动作：只放行与自己相关的（camelCase 与 snake_case 两种形状）
    assert.equal(vis.action({ nodeKey: 'a' }), true)
    assert.equal(vis.action({ node_key: 'a' }), true)
    assert.equal(vis.action({ nodeKey: 'b' }), false)
    assert.equal(vis.action({}), false)
  }
})

test('B1 视图谓词不会因为 key 前后空格而误放行', () => {
  const vis = statusVisibility('orchestrated', 'node', ' a ')
  assert.equal(vis.node({ key: 'a' }), true)
})

test('B2/B3 收件人策略：单线制节点只发主持人，广播仅圆桌制', () => {
  for (const mode of ['orchestrated', 'redteam']) {
    assert.equal(recipientPolicy(mode, 'node', 'captain'), 'ok', `${mode} 节点应可发主持人`)
    assert.equal(recipientPolicy(mode, 'node', 'b'), 'captain-only', `${mode} 节点不得直发他人`)
    assert.equal(recipientPolicy(mode, 'captain', 'b'), 'ok', `${mode} 主持人可定向派单`)
    assert.equal(recipientPolicy(mode, 'captain', 'all'), 'broadcast-egalitarian-only', `${mode} 不得广播`)
    assert.equal(recipientPolicy(mode, 'node', 'all'), 'broadcast-egalitarian-only')
  }
  assert.equal(recipientPolicy('egalitarian', 'node', 'b'), 'ok')
  assert.equal(recipientPolicy('egalitarian', 'node', 'all'), 'ok')
  assert.equal(recipientPolicy('egalitarian', 'captain', 'all'), 'ok')
})

test('接线守卫：谓词必须真的被消费点调用（防"函数写了没人用"的假绿）', () => {
  const tools = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
  assert.match(tools, /statusVisibility\(meeting\.mode/, 'roundtable_status 必须按模式投影快照')
  assert.match(tools, /recipientPolicy\(meeting\.mode/, 'roundtable_send_message 必须走收件人策略')
  const members = readFileSync(new URL('../src/members.ts', import.meta.url), 'utf8')
  assert.match(members, /nodeToolRestriction\(meeting\.mode/, 'spawn 必须把会议模式传给节点工具面')
})

test('接线守卫：主持人协议文案必须与工具闸一致（防"协议教广播、工具报错"）', () => {
  const usage = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(usage, /15\. Single-line discipline/, '必须含单线制纪律 rule 15')
  assert.match(usage, /Roster visibility depends on mode/, 'rule 3 必须按模式条件化')
  assert.doesNotMatch(
    usage,
    /Roster changes are invisible to running experts/,
    '旧的"每次增删后无条件广播名册"必须清除（单线制下工具会报错，协议不得再教）',
  )
  assert.doesNotMatch(
    usage,
    /broadcast duty \(roundtable_send_message to="all"\) right after clearing/,
    'rule 9 不得再要求无条件广播',
  )
})
