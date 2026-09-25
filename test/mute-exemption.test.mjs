/**
 * 闭麦死锁守卫（2026-09-25 · 本机亲历缺陷，圆桌会议「高并发优化施工」R6 实测）。
 *
 * ══ 判因（真实复现，不是推演）════════════════════════════════════════════════
 * 会议跑到轮数上限（maxRounds）后 `next_round` 把 status 置为 `muted`。此后：
 *   · `roundtable_set_budget` ⇒ 抛 MeetingMutedError（**解麦入口被自己拦下**）
 *   · `roundtable_close`      ⇒ 抛 MeetingMutedError（**收场被拦下**）
 *   · `roundtable_export_meeting` ⇒ 抛（**记录导不出**）
 * ⇒ 会议被锁死，只能手工改磁盘上的 meeting.json 才能收场（本次实际发生）。
 *
 * ══ 为什么既有测试没抓到 ══════════════════════════════════════════════════════
 * `test/budget.test.mjs` 覆盖的是 `budget.ts` 的**纯函数**（含"改成 0 后不再超限，
 * 否则永远解不了麦"），全绿；但**没有任何测试问过"收场工具到底调不调得到那个函数"**
 * —— 缺陷不在被调方，在**接线**：`withCaptainLock` 对 19 处主持人工具统一 `ensureActive`。
 * 这正是本仓反复在剿的形态：组件测了，接线没测。
 *
 * ══ 判据取向 ══════════════════════════════════════════════════════════════════
 *  · 收场类动作（补额/结束/导出/收口复审）**必须**豁免闭麦；
 *  · 参会类动作（推进轮次/发言/派单/改名单）**必须**照旧被拦 —— 否则"上限"形同虚设；
 *  · 白名单是**显式登记**：新增主持人工具默认被拦（缺省安全），要豁免须在此登记。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MUTE_EXEMPT_ACTIONS, isMuteExempt } from '../src/tools.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = readFileSync(join(HERE, '..', 'src', 'tools.ts'), 'utf8')

/** 源码里真实传给 withCaptainLock 的 action 串（判据必须对着真实调用点，而非我手抄的清单）。 */
function realActions() {
  return [...TOOLS.matchAll(/withCaptainLock\([\s\S]*?,\s*'([^']+)'/g)].map((m) => m[1])
}

test('闭麦死锁：收场类动作必须豁免闭麦（解麦/收场/导出不得被自己的闸门拦下）', () => {
  for (const action of ['change the budget', 'close it', 'export the meeting']) {
    assert.ok(isMuteExempt(action), `'${action}' 必须豁免闭麦 —— 否则闭麦后既解不了麦也收不了场（本机实测死锁）`)
  }
})

test('闭麦死锁：参会类动作必须**照旧**被拦（豁免不得放水成"闭麦形同虚设"）', () => {
  for (const action of ['advance the round', 'add nodes', 'remove nodes', 'edit channels']) {
    assert.ok(!isMuteExempt(action), `'${action}' 不得豁免 —— 闭麦的本意就是停下这些消耗预算的动作`)
  }
})

test('接线：withCaptainLock 必须真的走这个谓词（防"函数写了没人用"的假绿）', () => {
  assert.match(TOOLS, /if \(!isMuteExempt\(action\)\)/, 'withCaptainLock 必须按 isMuteExempt 决定是否 ensureActive')
  assert.ok(!/^\s*ensureActive\(fresh\)$/m.test(TOOLS) || /if \(!isMuteExempt\(action\)\)/.test(TOOLS),
    '不得退回"无条件 ensureActive"（那正是死锁的原形态）')
})

test('白名单与真实调用点同源：不得登记永不匹配的"幽灵动作"', () => {
  const real = new Set(realActions())
  assert.ok(real.size > 0, '必须能解析出真实 action 串（解析失败=判据空转，须先修本测试）')
  for (const action of MUTE_EXEMPT_ACTIONS) {
    assert.ok(real.has(action), `白名单项 '${action}' 在任何 withCaptainLock 调用点都匹配不到 —— 幽灵登记（本判据首版实测踩过：'read the status' 对应的工具根本不走本函数）`)
  }
})

test('白名单非空且不重复（空白名单=死锁回归；重复项=登记噪声）', () => {
  assert.ok(MUTE_EXEMPT_ACTIONS.length > 0, '豁免集不得为空')
  assert.equal(new Set(MUTE_EXEMPT_ACTIONS).size, MUTE_EXEMPT_ACTIONS.length, '不得有重复项')
})

test('错误文案承诺的出路必须真的可达（防"文案说能用 set_budget 解麦"而实现堵死）', () => {
  const budget = readFileSync(join(HERE, '..', 'src', 'budget.ts'), 'utf8')
  assert.match(budget, /top up the budget with roundtable_set_budget or close the meeting/,
    '前提：MeetingMutedError 仍承诺这两条出路（若改了文案，本判据须同步）')
  assert.ok(isMuteExempt('change the budget') && isMuteExempt('close it'),
    '文案承诺的两条出路必须都在豁免集里 —— 承诺与实现的单一真源')
})
