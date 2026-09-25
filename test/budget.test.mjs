/**
 * budget.ts 纯函数测试（R3/A6）：token 估算单调性与熔断边界。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  beginRound,
  budgetAxisText,
  budgetExceeded,
  budgetLimitText,
  budgetUnlimited,
  ensureActive,
  estimateTokens,
  MeetingEndedError,
  MeetingMutedError,
} from '../src/budget.ts'

/** 最小可用 Meeting 工厂（只填被测逻辑需要的字段）。 */
function meeting(overrides = {}) {
  return {
    id: 'm1',
    name: '测试会议',
    goal: '',
    mode: 'orchestrated',
    captainSessionId: 'captain-1',
    charter: '',
    nodes: [],
    edges: [],
    decisions: [],
    budget: { maxRounds: 3, maxTokens: 1000, usedRounds: 0, usedTokens: 0 },
    round: 0,
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

test('estimateTokens：空串为 0', () => {
  assert.equal(estimateTokens(''), 0)
})

test('estimateTokens：随文本增长单调不减', () => {
  const samples = ['', 'a', 'ab', 'abc', 'abcd', 'abcd e', '你好', '你好世界', 'hello 世界']
  let previous = -1
  for (const sample of samples) {
    const value = estimateTokens(sample)
    assert.ok(value >= previous, `estimateTokens(${JSON.stringify(sample)}) = ${value} 小于前一个样本 ${previous}`)
    previous = value
  }
})

test('estimateTokens：空白字符不计入', () => {
  assert.equal(estimateTokens('   \n\t  '), 0)
})

test('estimateTokens：CJK 比等价长度的拉丁更贵', () => {
  assert.ok(estimateTokens('汉字') > estimateTokens('ab'))
})

test('熔断边界：轮数恰好等于上限即算超限', () => {
  assert.equal(budgetExceeded(meeting({ round: 3 })), 'rounds')
  assert.equal(budgetExceeded(meeting({ round: 2 })), undefined)
})

test('熔断边界：token 恰好等于上限即算超限', () => {
  assert.equal(budgetExceeded(meeting({ budget: { maxRounds: 9, maxTokens: 100, usedRounds: 0, usedTokens: 100 } })), 'tokens')
  assert.equal(budgetExceeded(meeting({ budget: { maxRounds: 9, maxTokens: 100, usedRounds: 0, usedTokens: 99 } })), undefined)
})

test('熔断：两条轴同时超限时优先报轮数', () => {
  const both = meeting({ round: 5, budget: { maxRounds: 3, maxTokens: 10, usedRounds: 5, usedTokens: 99 } })
  assert.equal(budgetExceeded(both), 'rounds')
})

test('ensureActive：未超限时不抛错、状态保持 active', () => {
  const fresh = meeting()
  ensureActive(fresh)
  assert.equal(fresh.status, 'active')
})

test('ensureActive：超限时置为 muted 并抛 MeetingMutedError', () => {
  const over = meeting({ round: 3 })
  assert.throws(() => ensureActive(over), MeetingMutedError)
  assert.equal(over.status, 'muted')
})

test('ensureActive：已 muted 且仍超限时继续抛（不会静默放行）', () => {
  const muted = meeting({ round: 4, status: 'muted' })
  assert.throws(() => ensureActive(muted), MeetingMutedError)
})

test('ensureActive：ended / archived 一律抛 MeetingEndedError', () => {
  for (const status of ['ended', 'archived']) {
    assert.throws(() => ensureActive(meeting({ status })), MeetingEndedError, `status=${status} 应被拒绝`)
  }
})

/* ---- R-B：roundtable_next_round 的纯逻辑内核（此前 beginRound 从未被调用，轮数轴形同虚设） ---- */

test('beginRound：round 与 usedRounds 同步推进', () => {
  const fresh = meeting()
  assert.equal(beginRound(fresh), 1)
  assert.equal(fresh.round, 1)
  assert.equal(fresh.budget.usedRounds, 1)
  beginRound(fresh)
  assert.equal(fresh.round, 2)
  assert.equal(fresh.budget.usedRounds, 2)
})

test('next_round 语义：推进到恰好等于上限时轮数轴超限', () => {
  const fresh = meeting({ round: 2, budget: { maxRounds: 3, maxTokens: 1000, usedRounds: 2, usedTokens: 0 } })
  beginRound(fresh)
  assert.equal(budgetExceeded(fresh), 'rounds')
  // 工具的做法：置 muted 并持久化（不抛错，让主持人看到本轮已开但已闭麦）
  fresh.status = 'muted'
  assert.equal(fresh.status, 'muted')
  // 下一次再推进会被 withCaptainLock 的 ensureActive 拦下
  assert.throws(() => ensureActive(fresh), MeetingMutedError)
})

test('next_round 语义：未触顶时保持 active 不闭麦', () => {
  const fresh = meeting({ round: 1, budget: { maxRounds: 3, maxTokens: 1000, usedRounds: 1, usedTokens: 0 } })
  beginRound(fresh)
  assert.equal(budgetExceeded(fresh), undefined)
})

test('set_budget 解麦联动：补轮数额度后 round 轴不再是障碍（前提是有工具推进 round）', () => {
  const fresh = meeting({ round: 3, status: 'muted', budget: { maxRounds: 3, maxTokens: 1000, usedRounds: 3, usedTokens: 10 } })
  fresh.budget.maxRounds = 5 // 主持人加额
  assert.equal(fresh.round < fresh.budget.maxRounds && fresh.budget.usedTokens < fresh.budget.maxTokens, true)
})

/* ---- 0 = 不限制（2026-09-24 · 用户要求「把上下文和轮次限制调到 0 表示不限制」）----
 *
 * 判因：设置页两个输入框一直写着 `min={0}`（专家限额一栏的文案也明说「0 = 不限制」），
 * 但 `budgetExceeded` 此前是 `round >= maxRounds` —— 于是 `0` 成了**最严格**的上限：
 * 第 1 轮就 `0 >= 0` 立刻闭麦。同一份界面上 `0` 在两个地方表示相反的意思。
 * 下面每条都钉住这个取值语义，且**先红**（改动前全部会红，见 release note）。
 */

test('0 = 不限制：budgetUnlimited 的判据是"非正数"，含 NaN', () => {
  assert.equal(budgetUnlimited(0), true, '0 必须表示不限制')
  assert.equal(budgetUnlimited(-1), true, '负数按不限制处理（脏数据下宁可不闭麦，也不要"上限无声失效"）')
  assert.equal(budgetUnlimited(Number.NaN), true, 'NaN 归入不限制（NaN 比较恒假，否则闭麦会静默失灵）')
  assert.equal(budgetUnlimited(1), false)
  assert.equal(budgetUnlimited(200_000), false)
})

test('0 = 不限制：轮数轴为 0 时永不算超限（旧实现第 1 轮就闭麦）', () => {
  // 旧实现下这条是 `0 >= 0` ⇒ 'rounds'，即"用户要求不限制，却立刻闭麦"。
  assert.equal(budgetExceeded(meeting({ round: 0, budget: { maxRounds: 0, maxTokens: 1000, usedRounds: 0, usedTokens: 0 } })), undefined)
  assert.equal(budgetExceeded(meeting({ round: 999, budget: { maxRounds: 0, maxTokens: 1000, usedRounds: 999, usedTokens: 0 } })), undefined)
})

test('0 = 不限制：Token 轴为 0 时永不算超限，且不影响另一条轴', () => {
  assert.equal(budgetExceeded(meeting({ round: 1, budget: { maxRounds: 5, maxTokens: 0, usedRounds: 1, usedTokens: 9_999_999 } })), undefined)
  // 轮数轴仍然要管（不限制是**逐轴**的，不是"设了 0 就全都不管"）。
  assert.equal(budgetExceeded(meeting({ round: 5, budget: { maxRounds: 5, maxTokens: 0, usedRounds: 5, usedTokens: 0 } })), 'rounds')
})

test('0 = 不限制：两轴都为 0 时会议永不闭麦', () => {
  const both = meeting({ round: 10_000, budget: { maxRounds: 0, maxTokens: 0, usedRounds: 10_000, usedTokens: 9_999_999 } })
  assert.equal(budgetExceeded(both), undefined)
  ensureActive(both) // 不得抛错：不限制的会议必须能继续跑
  assert.equal(both.status, 'active', '两轴不限制时状态必须保持 active')
})

test('0 = 不限制：ensureActive 对不限制会议放行，不置 muted', () => {
  const free = meeting({ round: 50, budget: { maxRounds: 0, maxTokens: 0, usedRounds: 50, usedTokens: 123_456 } })
  ensureActive(free)
  assert.equal(free.status, 'active')
})

test('0 = 不限制：已 muted 的会议把某轴改成 0 后可以解麦', () => {
  // 这正是 set_budget 的解麦判据：旧写法 `fresh.round < fresh.budget.maxRounds`
  // 在 maxRounds=0 时判成"仍在超限"，于是补 0 反而永远解不了麦。
  const muted = meeting({ round: 3, status: 'muted', budget: { maxRounds: 1, maxTokens: 1000, usedRounds: 3, usedTokens: 10 } })
  assert.equal(budgetExceeded(muted), 'rounds', '前提：这条确实超限')
  muted.budget.maxRounds = 0 // 用户要求不限制
  assert.equal(budgetExceeded(muted), undefined, '改成 0 后必须不再超限（否则永远解不了麦）')
})

test('0 = 不限制：渲染口径统一为 ∞，不得出现 `3/0`', () => {
  // `3/0` 会被读成"越用越少"，与"不限制"正好相反。
  assert.equal(budgetAxisText(0, 3), '3/∞')
  assert.equal(budgetAxisText(10, 3), '3/10')
  assert.equal(budgetLimitText(0), '∞')
  assert.equal(budgetLimitText(200_000), '200000')
  // 上限为 0 时用量再大也不得退化成 `N/0`
  assert.ok(!budgetAxisText(0, 10_000).includes('/0'), '不限制的轴不得渲染出 /0')
})
