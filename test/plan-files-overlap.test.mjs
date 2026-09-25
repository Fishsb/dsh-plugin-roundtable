/**
 * P5 判据：文件面 + **同波次重叠检测**（同树并发下唯一会让改动静默消失的形态）。
 *
 * ══ 缺陷背景（圆桌会议「执行席与约束调整决策」）══════════════════════════
 * 模式 A（专家直接改同一棵 working tree）下，两席在同一波次碰同一文件时：
 * 后写者覆盖先写者，**树里不留任何冲突标记**；而宿主唯一做「每轮改动清单」
 * 的插件对 `origin === 'subagent'` 一律返回 undefined（子代理被主动排除）
 * ⇒ 事后没有任何东西能让人发现这次覆盖发生过。所以必须在**派单时**可见。
 *
 * ══ 判据取向（与全仓「缺口可见 · 勿造启发式」一致）══════════════════════
 *  · 只比较**同一波次**：跨波次本就被 depends_on 排成先后，不构成并发写。
 *  · 重叠判据是**字面相等**：刻意不做路径规范化/glob 展开 —— 那需要知道仓库根与
 *    文件系统现状，猜出来的"等价路径"会变成假红（本插件反复在剿的形态）。
 *  · **不是硬门**：它只产出可见信号，重排与否由主持人决定（硬门会逼出凑数声明）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { collectWaveFileOverlaps, normalizePlanItems, buildRoundSignals, validateRoundPlan } from '../src/dispatch.ts'

const item = (id, files, dependsOn = []) => ({ id, task: `t-${id}`, owner: 'a', dependsOn, files })

test('P5: 同波次同文件 ⇒ 报重叠', () => {
  const overlaps = collectWaveFileOverlaps([item('a1', ['src/x.ts']), item('a2', ['src/x.ts'])])
  assert.equal(overlaps.length, 1, '两席同波碰同一文件必须报出')
  assert.deepEqual(overlaps[0].files, ['src/x.ts'])
  assert.deepEqual(overlaps[0].items.sort(), ['a1', 'a2'])
})

test('P5: 不同波次（depends_on 串行）⇒ 不算重叠', () => {
  const overlaps = collectWaveFileOverlaps([
    item('a1', ['src/x.ts']),
    item('a2', ['src/x.ts'], ['a1']),   // 被推到下一波
  ])
  assert.deepEqual(overlaps, [], 'depends_on 已把它排成串行，不是并发写，报红即假红')
})

test('P5: 同波次不同文件 ⇒ 不报', () => {
  const overlaps = collectWaveFileOverlaps([item('a1', ['src/x.ts']), item('a2', ['src/y.ts'])])
  assert.deepEqual(overlaps, [])
})

test('P5: 未声明文件面的项不参与重叠判定（不猜）', () => {
  const overlaps = collectWaveFileOverlaps([item('a1', []), item('a2', ['src/x.ts'])])
  assert.deepEqual(overlaps, [], '没声明就是没声明，不得推断它"可能会碰"')
})

test('P5: 三席同波碰同一文件 ⇒ 三项都点名', () => {
  const overlaps = collectWaveFileOverlaps([
    item('a1', ['src/x.ts']), item('a2', ['src/x.ts']), item('a3', ['src/x.ts']),
  ])
  assert.equal(overlaps.length, 1)
  assert.deepEqual(overlaps[0].items.sort(), ['a1', 'a2', 'a3'])
})

test('P5: normalizePlanItems 接受 files 与 snake_case file_paths（显式空数组=未声明）', () => {
  const [good] = normalizePlanItems([{ id: 'a1', task: 't', owner: 'a', files: ['src/x.ts', '  '] }])
  assert.deepEqual(good.files, ['src/x.ts'], '空串项应被滤掉')
  const [snake] = normalizePlanItems([{ id: 'a2', task: 't', owner: 'a', file_paths: ['src/y.ts'] }])
  assert.deepEqual(snake.files, ['src/y.ts'], '须接受 snake_case（与 depends_on 同风格）')
  const [empty] = normalizePlanItems([{ id: 'a3', task: 't', owner: 'a', files: [] }])
  assert.equal(empty.files, undefined, '显式空数组与缺省同义 = 未声明（免得被当成声明过）')
})

test('P5: round_signals 暴露 files_items / files_unspecified / file_overlaps', () => {
  const signals = buildRoundSignals({
    round: 1,
    plan: { round: 1, items: [item('a1', ['src/x.ts']), item('a2', ['src/x.ts']), item('a3', [])] },
    liveSeatKeys: ['a', 'b'],
    utterances: [],
    mode: 'orchestrated',
  })
  assert.equal(signals.files_items, 2, '两项声明了文件面')
  assert.deepEqual(signals.files_unspecified, ['a3'], '未声明项须点名')
  assert.equal(signals.file_overlaps.length, 1, '重叠须报出（这是"该串行"的机器可见面）')
})

test('P4′: 计划面带回「不许动」那面墙（原样，不加工）', () => {
  const check = validateRoundPlan(
    [item('a1', ['src/x.ts'])],
    { rosterKeys: ['a'], presets: [], boundaryNotDoing: '  不许动 X  ' },
  )
  assert.equal(check.ok, true)
  assert.equal(check.report.boundaryNotDoing, '不许动 X', '边界须 trim 后原样带回，供派单面渲染')
})

test('P4′: 未声明边界时带回空串（不伪造"已声明"）', () => {
  const check = validateRoundPlan([item('a1', ['src/x.ts'])], { rosterKeys: ['a'], presets: [] })
  assert.equal(check.ok, true)
  assert.equal(check.report.boundaryNotDoing, '', '未声明就是空串 —— 不得填默认墙')
})
