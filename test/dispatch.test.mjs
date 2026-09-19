/**
 * dispatch.ts 纯函数测试（R-D）：本轮调度计划是"并行/串行分析"的唯一机检凭据。
 *
 * 背景（2026-09-19 用户实测反馈）：主持人此前**一把抓全下发** —— 没有任何数据结构
 * 能表达"哪些能并行、哪些必须串"，静默判据只测"派了没回"，对派单结构完全盲。
 * 本文件把三件事钉死：
 *   D1/D2  环与悬挂引用必须**被拒绝**（不是警告）；
 *   D3     波次分层正确（空依赖=同波并行；有依赖=后一波）；
 *   D4     承接席必须是真席位，或解析得到的预设（含 `new:` 缺口）；
 *   D5     硬门判据：≥2 席且无计划 ⇒ 要计划（单席豁免）；
 *   D6     候选池：只认未移除且记了 presetId 的节点，索引/在场标记可核；
 *   D7     计划 vs 实际派发的对账（两侧都要报）；
 *   D8     [越界转派] 结构化提取（含"没有该行不得误报"）。
 *
 * ⚠ 断言必须**咬得住结构**：注释掉 validateRoundPlan 里的环检测/悬挂检查，
 * D1/D2 必须变红（本批的"反验收"就是照这个跑一遍，见 release-notes/v0.2.42.md）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildRoundSignals,
  buildTalentPool,
  collectHandoffs,
  dispatchableSeatKeys,
  formatHandoffRows,
  formatPlanGaps,
  formatPlanWaves,
  normalizePlanItems,
  onStagePresetMap,
  parseHandoffs,
  planWaves,
  presetLinkedSeatIds,
  reconcileDispatches,
  requiresDispatchPlan,
  splitOwnerRef,
  toHandoffRows,
  validateRoundPlan,
} from '../src/dispatch.ts'

/** 一条计划项的简写工厂。 */
function item(id, owner, dependsOn = [], task = `task-${id}`) {
  return { id, task, owner, dependsOn }
}

/** 校验上下文：默认两条在场席 + 两条预设。 */
function context(overrides = {}) {
  return {
    rosterKeys: ['arch', 'impl'],
    presets: [
      { id: 'req-spec', name: '需求质询', role: 'r1' },
      { id: 'verify', name: '独立验证', role: 'r2' },
    ],
    onStagePresetIds: [],
    ...overrides,
  }
}

/** 断言校验通过并取回报告（失败时把原因打进断言消息，便于定位）。 */
function report(items, ctx = context()) {
  const result = validateRoundPlan(items, ctx)
  assert.equal(result.ok, true, result.ok ? '' : `expected valid, got: ${result.error}`)
  return result.report
}

/** 断言校验被拒绝，并返回错误文本。 */
function rejected(items, ctx = context()) {
  const result = validateRoundPlan(items, ctx)
  assert.equal(result.ok, false, 'expected the plan to be rejected, but it passed')
  return result.error
}

/* ---------------------------------------------------------------- D1 环 */

test('D1 自环被拒绝', () => {
  const error = rejected([item('a', 'arch', ['a'])])
  assert.match(error, /cycle/i)
  assert.match(error, /a/)
})

test('D1 二元环被拒绝', () => {
  const error = rejected([item('a', 'arch', ['b']), item('b', 'impl', ['a'])])
  assert.match(error, /cycle/i)
})

test('D1 三元环被拒绝，且错误里给出可读链', () => {
  const error = rejected([
    item('a', 'arch', ['c']),
    item('b', 'impl', ['a']),
    item('c', 'arch', ['b']),
  ])
  assert.match(error, /cycle/i)
  // 链要么是 a→…→a，要么是 b/c 起点的等价环；断言"首尾同 id"这个环的特征。
  const chain = (error.match(/dependency cycle: (.*?) —/) ?? [])[1] ?? ''
  const hops = chain.split('→').map((part) => part.trim())
  assert.ok(hops.length >= 3, `chain too short: ${chain}`)
  assert.equal(hops[0], hops[hops.length - 1], `chain is not a closed loop: ${chain}`)
})

/* ------------------------------------------------- D2 悬挂引用 */

test('D2 depends_on 指向本轮不存在的 id 被拒绝，并列出已知 id', () => {
  const error = rejected([item('a', 'arch'), item('b', 'impl', ['zzz'])])
  assert.match(error, /zzz/)
  assert.match(error, /not an id in this plan/i)
  assert.match(error, /known: a, b/)
})

test('D2 id/task/owner 为空或重复都被拒绝', () => {
  assert.match(rejected([{ id: '', task: 't', owner: 'arch', dependsOn: [] }]), /id must not be empty/)
  assert.match(rejected([{ id: 'a', task: '', owner: 'arch', dependsOn: [] }]), /task must not be empty/)
  assert.match(rejected([{ id: 'a', task: 't', owner: '', dependsOn: [] }]), /owner must not be empty/)
  assert.match(rejected([item('a', 'arch'), item('a', 'impl')]), /duplicate id/)
})

test('D2 空计划被拒绝（且给出"那就不该推进轮次"的出口）', () => {
  const error = rejected([])
  assert.match(error, /plan is empty/)
  assert.match(error, /do not advance the round/i)
})

/* ------------------------------------------------- D3 波次分层 */

test('D3 链式依赖 a→b→c 得到三波（真串行）', () => {
  const waves = planWaves([item('a', 'arch'), item('b', 'impl', ['a']), item('c', 'arch', ['b'])])
  assert.deepEqual(waves.map((wave) => wave.wave), [1, 2, 3])
  assert.deepEqual(waves.map((wave) => wave.items.map((entry) => entry.id)), [['a'], ['b'], ['c']])
})

test('D3 两条无依赖项落在同一波（并行）', () => {
  const waves = report([item('a', 'arch'), item('b', 'impl')]).waves
  assert.equal(waves.length, 1)
  assert.deepEqual(waves[0].items.map((entry) => entry.id), ['a', 'b'])
})

test('D3 一个前置 + 两个依赖它的项得到两波（前置串行、后继并行）', () => {
  const waves = report([
    item('a', 'arch'),
    item('b', 'impl', ['a']),
    item('c', 'arch', ['a']),
  ]).waves
  assert.deepEqual(waves.map((wave) => wave.items.map((entry) => entry.id)), [['a'], ['b', 'c']])
})

test('D3 菱形依赖取最长路径深度', () => {
  const waves = report([
    item('a', 'arch'),
    item('b', 'impl', ['a']),
    item('c', 'arch', ['a']),
    item('d', 'impl', ['b', 'c']),
  ]).waves
  assert.deepEqual(waves.map((wave) => wave.items.map((entry) => entry.id)), [['a'], ['b', 'c'], ['d']])
})

/* ------------------------------------------------- D4 承接席与缺口 */

test('D4 未知席被拒绝，且提示可以改用 new:<预设 id>', () => {
  const error = rejected([item('a', 'ghost')])
  assert.match(error, /ghost/)
  assert.match(error, /not a live seat/i)
  assert.match(error, /live seats: arch, impl/)
})

test('D4 已移除的席（不在 rosterKeys 里）等同于未知席', () => {
  const error = rejected([item('a', 'gone')], context({ rosterKeys: ['arch'] }))
  assert.match(error, /not a live seat/i)
})

test('D4 new:<预设> 解析成功则进缺口，且不带进 owners', () => {
  const result = report([item('a', 'arch'), item('b', 'new:verify')])
  assert.deepEqual(result.owners, ['arch'])
  assert.equal(result.gaps.length, 1)
  assert.deepEqual(
    { item: result.gaps[0].item, presetId: result.gaps[0].presetId, name: result.gaps[0].presetName, resolved: result.gaps[0].resolved, onStage: result.gaps[0].onStage },
    { item: 'b', presetId: 'verify', name: '独立验证', resolved: true, onStage: false },
  )
})

test('D4 缺口是否已补：onStagePresetIds 里有时标 onStage', () => {
  const result = report([item('a', 'new:verify')], context({ onStagePresetIds: ['verify'] }))
  assert.equal(result.gaps[0].onStage, true)
})

test('D4 new:<不存在的预设> 被拒绝并列出可用预设 id', () => {
  const error = rejected([item('a', 'new:nope')])
  assert.match(error, /nope/)
  assert.match(error, /not found/i)
  assert.match(error, /req-spec, verify/)
})

test('D4 new: 后缺 id、以及预设库为空时的报错都要说清', () => {
  assert.match(rejected([item('a', 'new:')]), /missing a preset id/)
  const error = rejected([item('a', 'new:verify')], context({ presets: [] }))
  assert.match(error, /no role presets are defined/)
})

test('D4 splitOwnerRef 区分在场席与 new: 写法', () => {
  assert.deepEqual(splitOwnerRef('arch'), { kind: 'seat', value: 'arch' })
  assert.deepEqual(splitOwnerRef('new:verify'), { kind: 'new', value: 'verify' })
  assert.deepEqual(splitOwnerRef('  new: verify  '), { kind: 'new', value: 'verify' })
})

/* ------------------------------------------------- D5 硬门判据 */

test('D5 ≥2 在场席且无计划 ⇒ 必须交计划', () => {
  assert.equal(requiresDispatchPlan(2, 0), true)
  assert.equal(requiresDispatchPlan(5, 0), true)
})

test('D5 单席会议豁免（不存在并行/串行这个问题）', () => {
  assert.equal(requiresDispatchPlan(1, 0), false)
  assert.equal(requiresDispatchPlan(0, 0), false)
})

test('D5 【口径显式化】硬门与模式无关：圆桌制下 ≥2 席同样必须交计划', () => {
  // 这是**用户拍板的无差别口径**（"≥2 席必交"），刻意没按模式分叉 ——
  // 推进轮次 = 花钱，任何模式下都该说清本轮意图。圆桌制下专家自组织不改变这点：
  // 它只是执行路径更多。本条把该口径钉成断言，免得日后被当成意外行为改掉，
  // 也免得有人"顺手"加模式分支造出两个判据。
  assert.equal(requiresDispatchPlan(2, 0), true)
  assert.equal(requiresDispatchPlan(1, 0), false)
  // 判据签名里没有 mode —— 结构上就分不了叉
  assert.equal(requiresDispatchPlan.length, 2, '判据只收（席数, 计划条数）两个参数，不得引入模式')
})

test('D5 交了计划就放行', () => {
  assert.equal(requiresDispatchPlan(3, 1), false)
})

/* ------------------------------------------------- D6 候选池 */

test('D6 候选池 total 等于预设条数，且逐条给路由与在场标记', () => {
  const pool = buildTalentPool(
    [
      { id: 'req-spec', name: '需求质询', provider: 'dshapi', model: 'm1' },
      { id: 'verify', name: '独立验证' },
    ],
    [{ key: 'arch', status: 'idle', presetId: 'verify' }],
  )
  assert.equal(pool.total, 2)
  assert.deepEqual(pool.candidates.map((candidate) => candidate.id), ['req-spec', 'verify'])
  assert.deepEqual(pool.candidates.map((candidate) => candidate.on_stage), [false, true])
  assert.equal(pool.candidates[1].provider, '')
  assert.deepEqual(pool.on_stage, [{ preset_id: 'verify', node_keys: ['arch'] }])
})

test('D6 已移除席与临时角色（无 presetId）都不算任何预设的在场席', () => {
  const pool = buildTalentPool(
    [{ id: 'verify', name: '独立验证' }],
    [
      { key: 'gone', status: 'removed', presetId: 'verify' },
      { key: 'adhoc', status: 'idle', presetId: undefined },
      { key: 'live', status: 'idle', presetId: '' },
    ],
  )
  assert.deepEqual(pool.on_stage, [])
  assert.equal(pool.candidates[0].on_stage, false)
})

test('D6 同一预设拉起多个席位时全部记名', () => {
  const pool = buildTalentPool(
    [{ id: 'verify', name: '独立验证' }],
    [
      { key: 'v1', status: 'idle', presetId: 'verify' },
      { key: 'v2', status: 'working', presetId: 'verify' },
    ],
  )
  assert.deepEqual(pool.on_stage, [{ preset_id: 'verify', node_keys: ['v1', 'v2'] }])
})

/* ------------------------------------------------- D7 对账 */

test('D7 计划点名但没派发 ⇒ undispatched；临时多派 ⇒ unplanned', () => {
  assert.deepEqual(reconcileDispatches(['arch', 'impl'], ['arch']), {
    undispatchedOwners: ['impl'],
    unplannedDispatches: [],
  })
  assert.deepEqual(reconcileDispatches(['arch'], ['arch', 'extra']), {
    undispatchedOwners: [],
    unplannedDispatches: ['extra'],
  })
})

test('D7 计划与实际一致时两侧都空', () => {
  assert.deepEqual(reconcileDispatches(['arch', 'impl'], ['impl', 'arch']), {
    undispatchedOwners: [],
    unplannedDispatches: [],
  })
})

test('D7 轮次信号：计划、波次、待回席一并给出（本轮只派了首波）', () => {
  const signals = buildRoundSignals({
    round: 2,
    mode: 'orchestrated',
    plan: { round: 2, items: [item('a', 'arch'), item('b', 'impl', ['a'])], createdAt: 0 },
    liveSeatKeys: ['arch', 'impl'],
    utterances: [
      { nodeKey: 'captain', content: '派单', round: 2, to: 'arch' },
      { nodeKey: 'arch', content: '[核心产出] 做完了', round: 2 },
    ],
  })
  assert.equal(signals.plan_recorded, true)
  assert.deepEqual(signals.planned_owners, ['arch', 'impl'])
  assert.deepEqual(signals.planned_waves, [['a'], ['b']])
  // b 要等 a，本轮还没派 ⇒ 漏派名单里必须有 impl（这就是"计划没跟到底"的机器凭据）。
  assert.deepEqual(signals.undispatched_owners, ['impl'])
  assert.deepEqual(signals.unplanned_dispatches, [])
  // impl 本轮没发言 ⇒ 待回席。
  assert.deepEqual(signals.pending_seats, ['impl'])
})

test('D7 轮次信号：无计划时显式记 unplanned，且不把在场席当成漏派', () => {
  const signals = buildRoundSignals({
    round: 1,
    mode: 'orchestrated',
    plan: undefined,
    liveSeatKeys: ['arch', 'impl'],
    utterances: [{ nodeKey: 'captain', content: '一把抓全发', round: 1, to: 'all' }],
  })
  assert.equal(signals.plan_recorded, false)
  assert.deepEqual(signals.planned_owners, [])
  assert.deepEqual(signals.undispatched_owners, [])
  // 广播视为全量在场席已派 ⇒ 不报未派发（避免把圆桌制广播误报成漏派）。
  assert.deepEqual(signals.unplanned_dispatches, [])
  assert.deepEqual(signals.pending_seats, ['arch', 'impl'])
})

test('D7 轮次信号只认主持人发出的定向派发（专家之间的发言不算派单）', () => {
  const signals = buildRoundSignals({
    round: 3,
    mode: 'orchestrated',
    plan: undefined,
    liveSeatKeys: ['arch', 'impl'],
    utterances: [
      { nodeKey: 'arch', content: '给 impl 的私信', round: 3, to: 'impl' },
      { nodeKey: 'captain', content: '给汇聚网关的汇总', round: 3, to: 'aggregator' },
    ],
  })
  assert.deepEqual(signals.unplanned_dispatches, [])
  // arch 本轮发过言（虽然是对 impl 说的），impl 没发 ⇒ 只有 impl 算待回。
  assert.deepEqual(signals.pending_seats, ['impl'])
})

test('D7 计划里 new:<已在场的预设> 必须还原成真席位（否则正常派发被误报成计划外）', () => {
  const signals = buildRoundSignals({
    round: 1,
    mode: 'orchestrated',
    plan: { round: 1, items: [item('a', 'verify'), item('b', 'new:accept')], createdAt: 0 },
    liveSeatKeys: ['verify', 'accept'],
    onStageByPreset: { accept: ['accept'] },
    utterances: [
      // 主持人按计划把 b 派给了在场的 accept 席 —— 这是**合规**派发。
      { nodeKey: 'captain', content: '派单', round: 1, to: 'verify' },
      { nodeKey: 'captain', content: '派单', round: 1, to: 'accept' },
    ],
  })
  assert.deepEqual(signals.planned_owners, ['verify', 'accept'], 'new:<已在场> 必须还原为真席位')
  assert.deepEqual(signals.unplanned_dispatches, [], '合规派发不得被误报为计划外')
  assert.deepEqual(signals.undispatched_owners, [])
})

test('D7 计划里 new:<真缺口> 不参与对账（它本轮本来就不该收到派发）', () => {
  const signals = buildRoundSignals({
    round: 1,
    mode: 'orchestrated',
    plan: { round: 1, items: [item('a', 'verify'), item('b', 'new:perf')], createdAt: 0 },
    liveSeatKeys: ['verify'],
    onStageByPreset: {},
    utterances: [{ nodeKey: 'captain', content: '派单', round: 1, to: 'verify' }],
  })
  assert.deepEqual(signals.planned_owners, ['verify'])
  assert.deepEqual(signals.undispatched_owners, [], '缺口席位不算漏派')
})

test('D7 工作项粒度：同席位两个项、只派一个 ⇒ 旧席位口径全绿，工作项口径能把它指出来', () => {
  // 实测缺口：a1/a3 都归 verify，旧口径（只比席位）全绿 —— 这正是"计划没跟到底"
  // 逃过对账的路径。带上 work_item 才能把"同一席位的多个项"分开数。
  // 注意这里 a3 归入 **untracked 而非 undispatched**：verify 当轮确实收到过派发
  // （a1 那条），所以机器只能说"该项不可核"，不能说"没派"——三态的意义就在这。
  const signals = buildRoundSignals({
    round: 1,
    mode: 'orchestrated',
    plan: { round: 1, items: [item('a1', 'verify'), item('a3', 'verify', ['a1'])], createdAt: 0 },
    liveSeatKeys: ['verify'],
    utterances: [
      { nodeKey: 'captain', content: '派单', round: 1, to: 'verify', workItem: 'a1' },
    ],
  })
  assert.equal(signals.tracked_items, 1)
  assert.deepEqual(signals.untracked_items.map((entry) => entry.id), ['a3'], '同一席位漏项必须被指出来')
  // 席位口径在这里是**盲的**（verify 已经收到过派发），所以两条判据都要留：
  // 席位口径抓"整席没派"，工作项口径抓"同席位漏项"。
  assert.deepEqual(signals.undispatched_owners, [], '席位口径抓不到这一项（预期内）')
})

test('D7 工作项粒度：全部按项派发后无遗漏，且不跨轮误算', () => {
  const signals = buildRoundSignals({
    round: 2,
    mode: 'orchestrated',
    plan: { round: 2, items: [item('b1', 'verify'), item('b2', 'verify', ['b1'])], createdAt: 0 },
    liveSeatKeys: ['verify'],
    utterances: [
      // 上一轮派过 a1：不得被算进本轮
      { nodeKey: 'captain', content: '派单', round: 1, to: 'verify', workItem: 'a1' },
      { nodeKey: 'captain', content: '派单', round: 2, to: 'verify', workItem: 'b1' },
      { nodeKey: 'captain', content: '派单', round: 2, to: 'verify', workItem: 'b2' },
    ],
  })
  assert.deepEqual(signals.undispatched_items, [])
  assert.equal(signals.tracked_items, 2)
})

test('D7 无计划时不报工作项遗漏（没有对账对象）', () => {
  const signals = buildRoundSignals({
    round: 1,
    mode: 'orchestrated',
    plan: undefined,
    liveSeatKeys: ['verify'],
    utterances: [{ nodeKey: 'captain', content: '派单', round: 1, to: 'verify' }],
  })
  assert.deepEqual(signals.undispatched_items, [])
  assert.equal(signals.tracked_items, 0)
})

test('D7 工作项粒度三态：真漏派 vs 不可核（不得把"没打标签"说成"没做"）', () => {
  const signals = buildRoundSignals({
    round: 1,
    mode: 'orchestrated',
    plan: { round: 1, items: [item('a1', 'verify'), item('a2', 'accept'), item('a3', 'verify', ['a1'])], createdAt: 0 },
    liveSeatKeys: ['verify', 'accept'],
    utterances: [
      // a1：打了标签
      { nodeKey: 'captain', content: '派单', round: 1, to: 'verify', workItem: 'a1' },
      // a2：没打标签，但承接席 accept 当轮收到了派发 ⇒ 不可核（不是失败）
      { nodeKey: 'captain', content: '派单', round: 1, to: 'accept' },
      // a3：既没标签，verify 当轮……收到过（a1 那条），所以也归不可核
    ],
  })
  assert.deepEqual(signals.undispatched_items, [], '不得把"不可核"报成"漏派"')
  assert.deepEqual(signals.untracked_items.map((entry) => entry.id).sort(), ['a2', 'a3'])
  assert.equal(signals.tracked_items, 1)
})

test('D7 工作项粒度：该席当轮什么都没收到 ⇒ 才是真漏派', () => {
  const signals = buildRoundSignals({
    round: 1,
    mode: 'orchestrated',
    plan: { round: 1, items: [item('a1', 'verify'), item('a2', 'accept')], createdAt: 0 },
    liveSeatKeys: ['verify', 'accept'],
    utterances: [{ nodeKey: 'captain', content: '派单', round: 1, to: 'verify', workItem: 'a1' }],
  })
  assert.deepEqual(signals.undispatched_items.map((entry) => entry.id), ['a2'])
  assert.deepEqual(signals.untracked_items, [])
})

/* ------------------------------------------------- D7b 自审遗留回归 */

test('D7 【实测反例】跨轮不得复用追踪记录：计划 id 本轮内唯一，跨轮复用合法', () => {
  // 自审实测（probe-cross-round）：R1 派过 work_item=a1，R2 的计划里也有一个
  // **从未派发**的 a1（id 只要求本轮内唯一，跨轮复用完全合法）。旧实现扫全部轮次，
  // 于是 R2 被 R1 的同名记录冒充成"已追踪"—— tracked=1 / undispatched=[]，
  // 应为 tracked=0 / undispatched=['a1']。这是一条纯假绿（机器报"跟到底了"）。
  const signals = buildRoundSignals({
    round: 2,
    mode: 'orchestrated',
    plan: { round: 2, items: [item('a1', 'verify')], createdAt: 0 },
    liveSeatKeys: ['verify'],
    utterances: [{ nodeKey: 'captain', content: 'R1 派 a1', round: 1, to: 'verify', workItem: 'a1' }],
  })
  assert.equal(signals.tracked_items, 0, '不得把上一轮的同名记录算作本轮已追踪')
  assert.deepEqual(signals.undispatched_items.map((entry) => entry.id), ['a1'])
})

test('D7 圆桌制（egalitarian）不得报 [越界转派]：该协议是单线制专属', () => {
  // charter 第二节与 members.ts 的 modeRule 都写明：圆桌制下专家直接转给同伴
  // 并抄送主持人，不使用 [越界转派] 标记。在那里收集它 = 报一个本模式不存在的信号。
  const utterances = [{ nodeKey: 'impl', content: '[越界转派]：数据迁移 | 建议承接：数据与迁移', round: 1 }]
  const circular = buildRoundSignals({
    round: 1,
    mode: 'egalitarian',
    plan: undefined,
    liveSeatKeys: ['impl'],
    utterances,
  })
  assert.equal(circular.out_of_scope_total, 0, '圆桌制下该协议不存在，不得收集')
  assert.deepEqual(circular.out_of_scope, [])
  // 同一批发言在单线制下**必须**被收集（判据随模式分叉，不是被整体关掉）
  const single = buildRoundSignals({
    round: 1,
    mode: 'orchestrated',
    plan: undefined,
    liveSeatKeys: ['impl'],
    utterances,
  })
  assert.equal(single.out_of_scope_total, 1, '单线制下必须收集（否则是把判据关掉了）')
})

test('D7 【实测反例】漏传 onStageByPreset 会让同一会议出现两个答案（已改必填）', () => {
  // 专家席（arch）在 R-D-UI 实测中报到：snapshot.ts 调 buildRoundSignals 时漏传
  // onStageByPreset，于是同一场会议里 status 说"没漏派"、快照说 unplanned=['arch']。
  // 根因不是"忘了传"，而是**判定者的输入没有单一装配入口**且该参数是 optional
  // —— 漏传在类型层不报错。修法：改必填 + onStagePresetMap() 唯一装配入口。
  // 本条同时钉住"这个差异真实存在"（否则改必填的必要性无从证明）。
  const input = {
    round: 1,
    mode: 'orchestrated',
    plan: {
      round: 1,
      items: [item('u1', 'verify'), item('u2', 'new:arch')],
      createdAt: 0,
    },
    liveSeatKeys: ['verify', 'arch'],
    utterances: [
      { nodeKey: 'captain', content: 'x', round: 1, to: 'verify', workItem: 'u1' },
      { nodeKey: 'captain', content: 'y', round: 1, to: 'arch', workItem: 'u2' },
    ],
  }
  const missing = buildRoundSignals({ ...input, onStageByPreset: {} })
  const correct = buildRoundSignals({ ...input, onStageByPreset: { arch: ['arch'] } })
  assert.deepEqual(missing.unplanned_dispatches, ['arch'], '漏传时会把正常派发误报成计划外（这就是那个假信号）')
  assert.deepEqual(correct.unplanned_dispatches, [], '传对了就没有误报')
  // 两个装配点必须都用同一个入口（不得各写一份 reduce）
  assert.equal(typeof onStagePresetMap, 'function')
  assert.deepEqual(onStagePresetMap([{ preset_id: 'a', node_keys: ['x'] }]), { a: ['x'] })
})

test('D7 接线守卫：onStageByPreset 必须由唯一装配入口提供（两个装配点同源）', () => {
  const tools = read('../src/tools.ts')
  const snapshot = read('../src/snapshot.ts')
  assert.match(tools, /onStageByPreset: onStagePresetMap\(talentPool\.on_stage\)/, 'tools.ts 必须走唯一入口')
  assert.match(snapshot, /onStageByPreset: onStagePresetMap\(onStageEntries\)/, 'snapshot.ts 必须走唯一入口')
  // 不得再各写一份 reduce（那正是漏传得以发生的形态）
  assert.doesNotMatch(tools, /onStageByPreset: .*\.reduce\(/, 'tools.ts 不得自写装配')
  assert.doesNotMatch(snapshot, /onStageByPreset: .*\.reduce\(/, 'snapshot.ts 不得自写装配')
  // 类型层必须必填：optional 会让漏传静默通过
  const dispatch = read('../src/dispatch.ts')
  assert.match(dispatch, /^  onStageByPreset: Readonly<Record<string, readonly string\[\]>>$/m,
    'onStageByPreset 必须必填（optional 时漏传不报错）')
})

test('D7 接线守卫：可派单席 / 预设关联席 两条谓词必须单源（不得再内联）', () => {
  const tools = read('../src/tools.ts')
  const snapshot = read('../src/snapshot.ts')
  // 可派单席（未移除 + 已出生）：调度侧四处曾各自内联
  assert.match(tools, /dispatchableSeatKeys\(meeting\.nodes\)/, 'tools 必须走单一入口')
  assert.match(tools, /fresh\.nodes\.filter\(isDispatchableSeat\)/, '硬门计席必须走单一谓词')
  assert.match(snapshot, /rosterKeys: dispatchableSeatKeys\(meeting\.nodes\)/, 'snapshot rosterKeys 单源')
  assert.match(snapshot, /liveSeatKeys: dispatchableSeatKeys\(meeting\.nodes\)/, 'snapshot liveSeatKeys 单源')
  assert.doesNotMatch(tools + snapshot, /node\.status !== 'removed' && node\.id !== ''/, '调度侧不得再内联该谓词')
  // 预设关联席（未移除 + 有 presetId）：另一条谓词，同样单源
  assert.match(tools, /onStagePresetIds: presetLinkedSeatIds\(fresh\.nodes\)/, 'tools 单源')
  assert.match(snapshot, /onStagePresetIds: presetLinkedSeatIds\(meeting\.nodes\)/, 'snapshot 单源')
})

test('D7 两条席位谓词语义不同，不得合并（出生与否）', () => {
  // 未出生的席：仍"认领了预设"（presetLinked），但**不可派单**（dispatchable）。
  const nodes = [
    { key: 'born', id: 's1', status: 'idle', presetId: 'verify' },
    { key: 'unborn', id: '', status: 'idle', presetId: 'arch' },
    { key: 'gone', id: 's2', status: 'removed', presetId: 'verify' },
  ]
  assert.deepEqual(dispatchableSeatKeys(nodes), ['born'], '未出生/已移除都不可派单')
  assert.deepEqual(presetLinkedSeatIds(nodes), ['verify', 'arch'], '未出生仍算认领了预设；已移除不算')
})

test('D7 【实测反例】圆桌制下同伴直达是合法派单路径，不得报成漏派', () => {
  // 实测（probe-egalitarian）：圆桌制下 `impl` 由同伴 `arch` 直接唤醒 —— 这正是
  // egalitarian 的设计（charter 第二节：本职以外的请求直接转给承担该职责的成员）。
  // 旧实现对账只认**主持人**发出的派发，于是把"同伴唤醒"误报成
  // `undispatched=["impl","arch"]`（纯假阳性：连发起直达的 arch 自己也算漏派）。
  const base = {
    round: 1,
    liveSeatKeys: ['arch', 'impl'],
    onStageByPreset: {},
    plan: {
      round: 1,
      items: [item('x1', 'impl'), item('x2', 'arch')],
      createdAt: 0,
    },
  }
  const utterances = [
    { nodeKey: 'captain', content: '派给 arch', round: 1, to: 'arch', workItem: 'x2' },
    { nodeKey: 'arch', content: 'impl 你来', round: 1, to: 'impl' },
  ]
  const circular = buildRoundSignals({ ...base, mode: 'egalitarian', utterances })
  assert.deepEqual(circular.undispatched_owners, [], '圆桌制：同伴唤醒必须算已派发')
  assert.deepEqual(circular.undispatched_items, [])
  // 单线制下同一批发言：同伴直达**不是**派单路径（工具层面也被拒），
  // 所以 impl 确实没被主持人派到 ⇒ 报漏派是对的（判据随模式分叉，不是被关掉）。
  const single = buildRoundSignals({ ...base, mode: 'orchestrated', utterances })
  assert.deepEqual(single.undispatched_owners, ['impl'], '单线制：只有主持人能派单')
})

test('D7 圆桌制：发起直达的席位自己不算"被派发"（A→B 只说明 B 被唤醒）', () => {
  const signals = buildRoundSignals({
    round: 1,
    mode: 'egalitarian',
    liveSeatKeys: ['arch', 'impl'],
    onStageByPreset: {},
    plan: { round: 1, items: [item('x1', 'impl'), item('x2', 'arch')], createdAt: 0 },
    // 只有 arch→impl：arch 自己没被任何人派 ⇒ x2 仍应报漏派（这是真信号，不是假阳性）
    utterances: [{ nodeKey: 'arch', content: 'impl 你来', round: 1, to: 'impl' }],
  })
  assert.deepEqual(signals.undispatched_owners, ['arch'], '发起者不应因自己发过消息就被算作已派')
  assert.deepEqual(signals.undispatched_items.map((entry) => entry.id), ['x2'])
  assert.deepEqual(signals.untracked_items.map((entry) => entry.id), ['x1'], 'impl 被唤醒但无标签 ⇒ 不可核')
})

test('D7 汇报不是派发：节点发给主持人/汇聚网关不得被算作对某席的派发', () => {
  const signals = buildRoundSignals({
    round: 1,
    mode: 'egalitarian',
    liveSeatKeys: ['arch'],
    onStageByPreset: {},
    plan: { round: 1, items: [item('x1', 'arch')], createdAt: 0 },
    utterances: [
      { nodeKey: 'arch', content: '汇报给主持人', round: 1, to: 'captain' },
      { nodeKey: 'arch', content: '交给网关', round: 1, to: 'aggregator' },
    ],
  })
  assert.deepEqual(signals.undispatched_owners, ['arch'], '汇报不算派发（两个收件人都不是席位）')
})

/* ------------------------------------------------- D8 越界转派 */

test('D8 标准写法被提取为 {事项, 建议承接}', () => {
  const handoffs = parseHandoffs('impl', '结论如下。\n[越界转派]：数据迁移的兼容性 | 建议承接：数据与迁移', 4)
  assert.equal(handoffs.length, 1)
  assert.deepEqual(handoffs[0], {
    fromSeat: 'impl',
    item: '数据迁移的兼容性',
    suggestedRole: '数据与迁移',
    round: 4,
  })
})

test('D8 容忍半角/全角分隔与缺失的标签', () => {
  assert.equal(parseHandoffs('a', '[越界转派]: 事项X | 建议承接: 角色Y', 1)[0].suggestedRole, '角色Y')
  assert.equal(parseHandoffs('a', '[越界转派]：事项X ｜ 角色Y', 1)[0].suggestedRole, '角色Y')
  const onlyItem = parseHandoffs('a', '[越界转派]：只有事项', 1)[0]
  assert.equal(onlyItem.item, '只有事项')
  assert.equal(onlyItem.suggestedRole, '')
})

test('D8 没有 [越界转派] 行时不得误报（不许凑数）', () => {
  assert.deepEqual(parseHandoffs('a', '一切正常，[核心产出] 无越界事项。建议承接：无', 1), [])
  assert.deepEqual(parseHandoffs('a', '[越界转派]', 1), [])
  assert.deepEqual(parseHandoffs('a', '[越界转派]：   ', 1), [])
})

test('D8 【实测反例】行内引用该标记不算转派（"讨论它"≠"发出它"）', () => {
  // 主机实测真实踩到：主持人派单里写「请在末尾按协议写一行 [越界转派]（无则写"无"）」，
  // 旧的行内 indexOf 判据把这句话抓成了 2 条待处理转派（内容还是"（无则写"无"）"），
  // 真信号被假信号淹没。标记必须是**行首**才算。
  const dispatchText = '请核验 X。请在发言末尾按协议写一行 [越界转派]（无则写"无"）。'
  assert.deepEqual(parseHandoffs('captain', dispatchText, 1), [])
  assert.deepEqual(parseHandoffs('a', '按你说的，我写了 [越界转派]：这条其实在行内。', 1), [])
})

test('D8 行首允许列表符号与前导空白', () => {
  assert.equal(parseHandoffs('a', '  - [越界转派]：事项A | 建议承接：角色B', 1)[0].item, '事项A')
  assert.equal(parseHandoffs('a', '* [越界转派]：事项A', 1)[0].item, '事项A')
  assert.equal(parseHandoffs('a', '1. [越界转派]：事项A', 1)[0].item, '事项A')
})

test('D8 collectHandoffs 默认排除主持人/汇聚网关（它们只是在转述协议）', () => {
  const utterances = [
    { nodeKey: 'captain', content: '请在末尾写一行 [越界转派]（无则写"无"）。', round: 1 },
    { nodeKey: 'aggregator', content: '[越界转派]：不应被当成席位请求', round: 1 },
    { nodeKey: 'impl', content: '[越界转派]：数据迁移的兼容性 | 建议承接：数据与迁移', round: 1 },
  ]
  const handoffs = collectHandoffs(utterances)
  assert.equal(handoffs.length, 1)
  assert.equal(handoffs[0].fromSeat, 'impl')
  // 显式放开排除名单时：主持人那条**仍被行首判据挡住**（它不在行首），
  // 只有网关那条真正的行首标记会进来 ⇒ 2 条。两道判据是独立的，这里同时钉住。
  const unfiltered = collectHandoffs(utterances, { excludeSpeakers: [] })
  assert.equal(unfiltered.length, 2)
  assert.ok(unfiltered.some((entry) => entry.fromSeat === 'aggregator'))
  assert.ok(!unfiltered.some((entry) => entry.fromSeat === 'captain'), '行首判据必须仍挡住主持人那条引用')
})

test('D8 一条发言里的多行转派都要提到，且最新在前', () => {
  const handoffs = collectHandoffs([
    { nodeKey: 'a', content: '[越界转派]：第一件 | 建议承接：X', round: 1 },
    { nodeKey: 'b', content: '无\n[越界转派]：第二件 | 建议承接：Y', round: 2 },
  ])
  assert.deepEqual(handoffs.map((entry) => entry.item), ['第二件', '第一件'])
  assert.equal(handoffs[0].round, 2)
})

test('D8 status 行与限额：超出上限时给总数与隐藏数（不静默丢弃）', () => {
  const handoffs = collectHandoffs(
    Array.from({ length: 10 }, (_, index) => ({
      nodeKey: 'a',
      content: `[越界转派]：事项${index} | 建议承接：角色${index}`,
      round: 1,
    })),
  )
  const rows = toHandoffRows(handoffs, 8)
  assert.equal(rows.length, 8)
  assert.equal(rows[0].from_seat, 'a')
  assert.equal(rows[0].suggested_role, '角色9')
  assert.match(formatHandoffRows(rows), /\[R1\] a → 角色9: 事项9/)
  assert.equal(formatHandoffRows([]), '  (none)')
})

/* ------------------------------------------------- 渲染与解析 */

test('normalizePlanItems 容忍 dependsOn/depends_on 两种写法并丢垃圾行', () => {
  const items = normalizePlanItems([
    { id: 'a', task: 't', owner: 'arch', dependsOn: ['b'] },
    { id: 'b', task: 't', owner: 'impl', depends_on: ['c'] },
    'garbage',
    null,
    { id: 'c' },
  ])
  assert.deepEqual(items.map((entry) => entry.id), ['a', 'b', 'c'])
  assert.deepEqual(items[0].dependsOn, ['b'])
  assert.deepEqual(items[1].dependsOn, ['c'])
  assert.deepEqual(items[2], { id: 'c', task: '', owner: '', dependsOn: [] })
  assert.deepEqual(normalizePlanItems(undefined), [])
  assert.deepEqual(normalizePlanItems({ not: 'an array' }), [])
})

test('渲染：波次标出"立刻并发"与"等上一波"，缺口单列', () => {
  const result = report([item('a', 'arch'), item('b', 'new:verify', ['a'])])
  const waves = formatPlanWaves(result)
  assert.match(waves, /wave 1 \(dispatch now, in parallel\)/)
  assert.match(waves, /wave 2 \(after wave 1\)/)
  assert.match(waves, /- a → arch: task-a/)
  const gaps = formatPlanGaps(result)
  assert.match(gaps, /new:verify|verify/)
  assert.match(gaps, /nobody on stage yet/)
  assert.equal(formatPlanGaps(report([item('a', 'arch')])), '')
})

/* ---------------------------------------- 接线守卫（纯函数绿 ≠ 运行态接上） ----
 *
 * 这一组照 usage.test.mjs 的口径做**源码级护栏**：上面 35 条夹具全绿，仍然可能
 * 出现"模块写了、工具没调"（本仓库实测过的假绿形态：判据只活在测试里）。
 * 所以这里钉死三处接线：硬门真的在 next_round 里、计划真的落账、候选池/信号
 * 真的进 status 返回体。 */

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('接线守卫：next_round 必须真的调用硬门与校验，且先校验后推进轮次', () => {
  const tools = read('../src/tools.ts')
  assert.match(tools, /requiresDispatchPlan\(liveNodes\.length, items\.length\)/,
    '硬门必须接在 next_round 上（纯函数绿 ≠ 工具会拦）')
  assert.match(tools, /const check = validateRoundPlan\(items, \{/, '计划必须过校验')
  assert.match(tools, /if \(!check\.ok\) throw new Error\(`roundtable: invalid dispatch plan/, '校验失败必须报错')
  // 顺序守卫：beginRound 必须在校验之后 —— 否则一个非法计划会**静默烧掉一轮**，
  // 这让"报错"本身变成预算泄漏（比不报错更坏）。
  const body = tools.slice(tools.indexOf('requiresDispatchPlan(liveNodes.length'), tools.indexOf('plan_items: items.length'))
  assert.ok(body.indexOf('check.ok') < body.indexOf('beginRound(fresh)'),
    '必须"先校验、后推进"：非法计划不得烧掉一轮')
})

test('接线守卫：计划必须落账（否则"做过分析"无法与"一把抓"区分）', () => {
  const tools = read('../src/tools.ts')
  assert.match(tools, /fresh\.roundPlans = \[\.\.\.kept, recorded\]\.slice\(-MAX_ROUND_PLANS\)/,
    '计划必须写进 meeting.roundPlans')
  // 类型侧在 types.ts（会议记录的形状），单独钉。
  const types = read('../src/types.ts')
  assert.match(types, /roundPlans\?: RoundPlan\[\]/, '类型层必须有该字段')
  assert.match(types, /export interface RoundPlanItem/, '计划项类型必须落 state 形状模块')
})

test('接线守卫：候选池与轮次信号必须进 status 的返回体', () => {
  const tools = read('../src/tools.ts')
  assert.match(tools, /buildTalentPool\(presets, meeting\.nodes\)/, 'status 必须算候选池')
  assert.match(tools, /talent_pool: talentPool,/, '候选池必须回传')
  assert.match(tools, /buildRoundSignals\(\{/, 'status 必须算轮次信号')
  assert.match(tools, /round_signals: roundSignals,/, '轮次信号必须回传')
  // 隔离：两者都只给主持人（单线制下候选池 = "别处还有谁"的泄露面）。
  assert.match(tools, /const talentPool = vis\.full/, '候选池必须按可见性裁剪')
  assert.match(tools, /const roundSignals = vis\.full/, '轮次信号必须按可见性裁剪')
})

test('接线守卫：导出物必须带调度计划，并点出未记录计划的已派发轮次', () => {
  const tools = read('../src/tools.ts')
  assert.match(tools, /## 调度计划（\$\{plans\.length\} 轮已记录）/, '导出必须有调度计划段')
  assert.match(tools, /未记录调度计划的已派发轮次/, '导出必须点出"派了但没计划"的轮次')
})

test('接线守卫：usage 协议必须把"隔离"与"串行"分开说，且含硬门与波次语义', () => {
  const index = read('../src/index.ts')
  assert.match(index, /INFORMATION ISOLATION/, '必须说清 one-at-a-time 是隔离而非串行')
  assert.match(index, /DISPATCH ANALYSIS IS STRUCTURAL/, '必须有调度纪律条款')
  assert.match(index, /an empty plan is REJECTED/, '协议必须写明硬门')
  assert.match(index, /talent_pool/, '协议必须指向候选池')
})

test('接线守卫：add_node 必须记下预设来源（否则候选池的 on_stage 只能靠猜 role）', () => {
  const tools = read('../src/tools.ts')
  assert.match(tools, /presetId: fromPreset === undefined \? undefined : fromPreset\.id/,
    'add_node 必须记录 presetId')
})

test('接线守卫：send_message 必须支持并按项落账 work_item，且拒绝计划外的项', () => {
  const tools = read('../src/tools.ts')
  assert.match(tools, /work_item: \{ type: 'string'/, '参数必须存在')
  assert.match(tools, /workItem: workItem === '' \? undefined : workItem \}/, '必须写进转录')
  // "追踪"本身不得可编造：声明的项必须真的在本轮计划里。
  assert.match(tools, /is not an item of round \$\{meeting\.round\}'s dispatch plan/,
    '计划外的工作项必须被拒绝（否则这份对账只是自证）')
})

