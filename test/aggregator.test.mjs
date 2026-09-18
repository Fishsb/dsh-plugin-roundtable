/**
 * R-B 单一出口：汇聚网关 digest 必须把专家的 [核心产出] 与 [建议决策]
 * 都带给主持人——修复"子代理选的方向在汇总里完全没有"的信息丢失。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateUtterances } from '../src/aggregator.ts'

function utterance(overrides = {}) {
  return {
    id: `u${Math.random()}`,
    nodeKey: 'engineer',
    kind: 'speech',
    content: '',
    round: 1,
    ts: 0,
    ...overrides,
  }
}

test('digest 提取 [核心产出] 并附带 [建议决策] 行', () => {
  const digest = aggregateUtterances([utterance({
    content: '[当前状态] 完成评审\n一些过程描述\n[核心产出]\n选择事件驱动架构，放弃轮询。\n[下一步建议]\n出原型。\n[建议决策]：存储选型 | 选项：SQLite/Postgres | 推荐：SQLite 理由：单机够用',
  })])
  assert.ok(digest.includes('选择事件驱动架构'), '[核心产出] 应进 digest')
  assert.ok(digest.includes('[建议决策] 存储选型 | 选项：SQLite/Postgres | 推荐：SQLite 理由：单机够用'), '[建议决策] 行应进 digest')
  assert.ok(!digest.includes('一些过程描述'), '过程描述不应挤占 digest')
})

test('无 [建议决策] 的发言不产生该标记', () => {
  const digest = aggregateUtterances([utterance({
    content: '[当前状态] ok\n[核心产出]\n结论A。\n[下一步建议]\n无。',
  })])
  assert.ok(digest.includes('结论A'))
  assert.ok(!digest.includes('[建议决策]'))
})

test('多条发言：[建议决策] 逐条附带不串行', () => {
  const digest = aggregateUtterances([
    utterance({ nodeKey: 'a', content: '[核心产出]\n方向甲。\n[建议决策]：问题1 | 选项：X/Y | 推荐：X' }),
    utterance({ nodeKey: 'b', content: '[核心产出]\n方向乙。' }),
  ])
  assert.ok(digest.includes('方向甲'))
  assert.ok(digest.includes('方向乙'))
  assert.equal(digest.split('[建议决策]').length - 1, 1, '只有发言 a 携带建议决策')
})

test('retrieval 与 captain 之外的元数据规则不变：非 speech 类型不入 digest', () => {
  const digest = aggregateUtterances([utterance({ kind: 'retrieval', content: '[核心产出]\n不该出现。' })])
  assert.ok(!digest.includes('不该出现'))
})
