/**
 * R-C 名册广播：broadcastRecipients 纯函数断言。
 *  - 主持人发起：所有已出生（id 非空）且未 removed 的节点，不含自己；
 *  - 节点发起：主持人永远在列，其余为其他存活节点，排除自己；
 *  - 未出生 / removed 节点一律排除；全空时主持人侧得到空集。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { broadcastRecipients } from '../src/tools.ts'
import { CAPTAIN_KEY } from '../src/types.ts'

function meeting(nodes) {
  return { nodes }
}

const live = (key, overrides = {}) => ({ key, role: key, id: `sid-${key}`, status: 'active', ...overrides })

test('主持人广播：只发给已出生且未移除的节点', () => {
  const m = meeting([
    live('researcher'),
    live('engineer'),
    live('ghost', { id: '' }),
    live('dropped', { status: 'removed' }),
  ])
  assert.deepEqual(broadcastRecipients(m, CAPTAIN_KEY), ['researcher', 'engineer'])
})

test('节点广播：主持人永远在列，且排除自己', () => {
  const m = meeting([live('a'), live('b'), live('unspawned', { id: '' })])
  assert.deepEqual(broadcastRecipients(m, 'a'), [CAPTAIN_KEY, 'b'])
})

test('全员未出生：主持人无受众（空集），节点仍可发给主持人', () => {
  const m = meeting([live('a', { id: '' }), live('b', { status: 'removed' })])
  assert.deepEqual(broadcastRecipients(m, CAPTAIN_KEY), [])
  assert.deepEqual(broadcastRecipients(m, 'a'), [CAPTAIN_KEY])
})

test('空名册：主持人广播得到空集', () => {
  assert.deepEqual(broadcastRecipients(meeting([]), CAPTAIN_KEY), [])
})
