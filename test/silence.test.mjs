/**
 * 静默席判据的夹具测试（6 夹具 + 三条护栏的变异验证）。
 *
 * 纪律：夹具驱动，**不读现场 `.roundtable`**（否则断言随环境漂移）。
 * 每条护栏都用一个「关闭护栏后对应违规必须出现」的变异用例证明它真被测到。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { analyzeSilence, silenceMarkFor, silenceSummaryLine } from '../src/silence.ts'

const CAP = 'captain'
const meeting = (over = {}) => ({
  status: 'active',
  round: 1,
  nodes: [
    { key: 'a', status: 'active' },
    { key: 'b', status: 'active' },
    { key: 'c', status: 'active' },
  ],
  ...over,
})
const dispatch = (round, to) => ({ nodeKey: CAP, round, to })
const speak = (round, nodeKey) => ({ nodeKey, round })

/* ---------------- 6 个夹具 ---------------- */

test('夹具1 全员回应：无空轮、无静默、无迟到', () => {
  const m = meeting({ status: 'ended', round: 1, nodes: [{ key: 'a', status: 'active' }, { key: 'b', status: 'active' }] })
  const r = analyzeSilence(m, [dispatch(1, 'a'), dispatch(1, 'b'), speak(1, 'a'), speak(1, 'b')])
  assert.deepEqual(r.closedRounds, [1])
  assert.equal(r.closedSeats, 2)
  assert.deepEqual(r.emptyRounds, [])
  assert.deepEqual(r.silentSeats, [])
  assert.deepEqual(r.lateReplies, [])
})

test('夹具2 真静默：派了两席只回一席 → 1 静默、非空轮', () => {
  const m = meeting({ status: 'ended', round: 1, nodes: [{ key: 'a', status: 'active' }, { key: 'b', status: 'active' }] })
  const r = analyzeSilence(m, [dispatch(1, 'a'), dispatch(1, 'b'), speak(1, 'a')])
  assert.deepEqual(r.silentSeats, [{ round: 1, seat: 'b' }])
  assert.deepEqual(r.lateReplies, [])
  assert.deepEqual(r.emptyRounds, [], '有人回了就不算空轮')
})

test('夹具3 迟到 ≠ 静默：当轮没回、下一轮回 → lateReplies，不算失败', () => {
  const m = meeting({ status: 'ended', round: 2, nodes: [{ key: 'a', status: 'active' }, { key: 'b', status: 'active' }] })
  const r = analyzeSilence(m, [dispatch(1, 'b'), speak(1, 'a'), speak(2, 'b')])
  assert.deepEqual(r.silentSeats, [], '迟到不得记成静默')
  assert.deepEqual(r.lateReplies, [{ round: 1, seat: 'b', repliedIn: 2 }])
})

test('夹具4 在飞轮：active 会议最后一轮不计入分子分母', () => {
  const m = meeting({ status: 'active', round: 2 })
  const r = analyzeSilence(m, [dispatch(1, 'a'), speak(1, 'a'), dispatch(2, 'b'), dispatch(2, 'c')])
  assert.deepEqual(r.closedRounds, [1], 'R2 在飞，不收口')
  assert.equal(r.closedSeats, 1)
  assert.deepEqual(r.silentSeats, [])
  assert.deepEqual(r.emptyRounds, [])
})

test('夹具5 空轮：派了两席、无人回 → emptyRounds（硬阈值 = 0）', () => {
  const m = meeting({ status: 'ended', round: 1, nodes: [{ key: 'a', status: 'active' }, { key: 'b', status: 'active' }] })
  const r = analyzeSilence(m, [dispatch(1, 'a'), dispatch(1, 'b')])
  assert.deepEqual(r.emptyRounds, [1])
  assert.equal(r.silentSeats.length, 2)
})

test('夹具6 removed 席位：已移除的派单目标不计入有效派单集', () => {
  const m = meeting({
    status: 'ended',
    round: 1,
    nodes: [{ key: 'a', status: 'active' }, { key: 'b', status: 'removed' }],
  })
  const r = analyzeSilence(m, [dispatch(1, 'a'), dispatch(1, 'b'), speak(1, 'a')])
  assert.equal(r.closedSeats, 1, 'removed 席位不得进分母')
  assert.deepEqual(r.silentSeats, [], 'removed 席位不得报静默')
})

/* ---------------- 三条护栏的变异验证（关掉护栏 → 违规必须出现） ---------------- */

test('护栏1 变异：关掉「排除在飞轮」→ 在飞轮被计入并报静默违规', () => {
  const m = meeting({ status: 'active', round: 2 })
  const utterances = [dispatch(1, 'a'), speak(1, 'a'), dispatch(2, 'b'), dispatch(2, 'c')]
  const fixed = analyzeSilence(m, utterances)
  const mutated = analyzeSilence(m, utterances, { excludeInFlight: false })
  assert.deepEqual(fixed.closedRounds, [1])
  assert.deepEqual(mutated.closedRounds, [1, 2], '关闭护栏后被污染')
  assert.equal(fixed.silentSeats.length, 0)
  assert.equal(mutated.silentSeats.length, 2, '在飞轮被误报为静默（每轮误报的来源）')
})

test('护栏2 变异：关掉 removed 过滤 → 全员 removed 的会议被误报为静默', () => {
  const m = meeting({
    status: 'ended',
    round: 1,
    nodes: [{ key: 'a', status: 'removed' }, { key: 'b', status: 'removed' }],
  })
  const utterances = [dispatch(1, 'a'), dispatch(1, 'b')]
  assert.equal(analyzeSilence(m, utterances).silentSeats.length, 0, '过滤后无有效派单')
  assert.equal(
    analyzeSilence(m, utterances, { excludeRemoved: false }).silentSeats.length,
    2,
    '关闭护栏后误报（历史实测确有一场 8 席全 removed）',
  )
})

test('护栏3 变异：关掉「迟到与静默分开」→ 迟到被误记成静默', () => {
  const m = meeting({ status: 'ended', round: 2, nodes: [{ key: 'a', status: 'active' }, { key: 'b', status: 'active' }] })
  const utterances = [dispatch(1, 'b'), speak(1, 'a'), speak(2, 'b')]
  const fixed = analyzeSilence(m, utterances)
  const mutated = analyzeSilence(m, utterances, { separateLate: false })
  assert.equal(fixed.silentSeats.length, 0)
  assert.deepEqual(mutated.silentSeats, [{ round: 1, seat: 'b' }], '关闭护栏后迟到被算成失败')
  assert.equal(mutated.lateReplies.length, 0)
})

/* ---------------- 硬阈值门 ---------------- */

test('硬阈值：口径三（空轮）必须 = 0；迟到只记录', () => {
  const m = meeting({ status: 'ended', round: 3, nodes: [{ key: 'a', status: 'active' }, { key: 'b', status: 'active' }] })
  const r = analyzeSilence(m, [
    dispatch(1, 'a'), dispatch(1, 'b'), speak(1, 'a'), speak(2, 'b'), // R1: a 当轮回、b 迟到到 R2
    dispatch(2, 'a'), speak(3, 'a'),                                  // R2: 只派 a，而 a 迟到到 R3
    dispatch(3, 'a'), speak(3, 'a'),                                  // R3: 正常
  ])
  // R2 唯一被派单的席位当轮未回 → **在收口时它就是空轮**（这正是"迟到不等于当轮有人说话"的语义，
  // 也是判据必须在轮次收口时跑、不能事后扫账本的原因）。
  assert.deepEqual(r.emptyRounds, [2], 'R2 无人当轮发言 → 空轮')
  assert.equal(r.silentSeats.length, 0, '两人都回过，只是迟到')
  assert.deepEqual(r.lateReplies, [
    { round: 1, seat: 'b', repliedIn: 2 },
    { round: 2, seat: 'a', repliedIn: 3 },
  ])
})

/* ---------------- 接线守卫：判据必须跑在运行态，不能只活在测试里 ---------------- */

test('接线守卫：roundtable_status 必须回传 silence 判据结果', () => {
  const tools = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
  assert.match(tools, /const silence = analyzeSilence\(/, 'status 必须调用 analyzeSilence（否则闸只存在于测试里）')
  assert.match(tools, /closedRounds: silence\.closedRounds/, '判据结果必须以 silence 字段回传')
  assert.match(tools, /silentSeats: silence\.silentSeats/, '静默席必须回传（否则运行态看不见这条缺陷）')
})

/* ---------------- 标记辅助（导出与网关摘要尾部共用） ---------------- */

test('silenceSummaryLine：无静默无空轮时为空串（不产生噪声）', () => {
  const m = { status: 'ended', round: 1, nodes: [{ key: 'a', status: 'active' }] }
  const clean = analyzeSilence(m, [{ nodeKey: CAP, round: 1, to: 'a' }, { nodeKey: 'a', round: 1 }])
  assert.equal(silenceSummaryLine(clean), '', '全回应时不得输出标记行')
})

test('silenceSummaryLine：静默/空轮/迟到分别成文，且迟到标明"不算失败"', () => {
  const m = { status: 'ended', round: 3, nodes: [{ key: 'a', status: 'active' }, { key: 'b', status: 'active' }] }
  const r = analyzeSilence(m, [
    { nodeKey: CAP, round: 1, to: 'a' }, { nodeKey: CAP, round: 1, to: 'b' }, // b 当轮不回，后面也不回 → 静默
    { nodeKey: 'a', round: 1 },
    { nodeKey: CAP, round: 2, to: 'a' }, { nodeKey: 'a', round: 3 }, // R2 空轮 + a 迟到
  ])
  const line = silenceSummaryLine(r)
  assert.match(line, /静默未回：R1\/b/)
  assert.match(line, /空轮：2/)
  assert.match(line, /迟到（不算失败）：R2\/a→R3/)
})

test('silenceMarkFor：只标该席位自己的静默轮次，无关席位返回空串', () => {
  const m = { status: 'ended', round: 1, nodes: [{ key: 'a', status: 'active' }, { key: 'b', status: 'active' }] }
  const r = analyzeSilence(m, [{ nodeKey: CAP, round: 1, to: 'a' }, { nodeKey: CAP, round: 1, to: 'b' }, { nodeKey: 'a', round: 1 }])
  assert.match(silenceMarkFor(r, 'b'), /⚠ 静默未回（R1）/)
  assert.equal(silenceMarkFor(r, 'a'), '', '回过话的席位不得被标注')
})

test('接线守卫：导出与网关摘要在同一个标记函数上（防只接一处）', () => {
  const tools = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
  assert.match(tools, /silenceMarkFor\(silenceForRoster, node\.key\)/, '导出名单行内必须标注静默席')
  assert.match(tools, /\[静默判据\] \$\{silenceLine\}/, '网关摘要尾部必须带静默判据行')
  const snapshot = readFileSync(new URL('../src/snapshot.ts', import.meta.url), 'utf8')
  assert.match(snapshot, /silenceSummaryLine\(analyzeSilence\(/, 'UI 快照摘要同一口径')
})
