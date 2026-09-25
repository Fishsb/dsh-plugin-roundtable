/**
 * 「0 = 不限制」的**功能**测试（2026-09-24 · 用户要求「把上下文和轮次限制调到 0 表示不限制」）。
 *
 * ══ 为什么单独有这个文件（而不是只靠 budget.test.mjs 的纯函数断言）══════════════
 * `budget.test.mjs` 钉住的是 `budgetExceeded` / `budgetUnlimited` 的**语义**；
 * 但本仓反复实测过的形态是："判据对了，值却没抵达输出"（接线在、渲染出来是空 /
 * 是旧口径）。0 这一版尤其容易漏，因为**渲染点有五个**：设置卡 / status / 导出 /
 * 回执文案 / 客户端预算条 —— 任何一处漏改，用户都会看到 `3/0` 或"超限自动闭麦"，
 * 与"不限制"正好相反。
 *
 * 本文件走**真调用**：拿 maxRounds=0 / maxTokens=0 的真会议对象喂给三个真渲染函数，
 * 看 `∞` 有没有真的抵达。客户端两处（RoundTableView / RoundTableSettings）是源码
 * 断言 —— 它们要在 DOM 里才跑得起来，而本轮不引入浏览器运行时（同 `ui-wiring` 的取舍）。
 *
 * ⚠ 先红已验（改动前实测）：下面每条都会红 —— 改动前三个渲染函数一律写死
 *   `${used}/${max}` ⇒ 输出 `3/0`；设置卡写死 `（超限自动闭麦）`；设置页输入框
 *   写死 `Math.max(1, …)` / `Math.max(1000, …)` ⇒ 用户敲 0 会被顶掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildCharter } from '../src/charter.ts'
import { formatMeetingDraft } from '../src/plan.ts'
import { renderMeetingMarkdown } from '../src/tools.ts'

const read = (rel) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

/** 两条轴都不限制的会议（round 与用量都远超任何合理上限，以证明"真的不管"）。 */
const FREE = {
  id: 'free', name: '不限制会议', goal: 'g', mode: 'orchestrated',
  captainSessionId: 'c', charter: '', nodes: [], edges: [], decisions: [],
  budget: { maxRounds: 0, maxTokens: 0, usedRounds: 42, usedTokens: 9_999_999 },
  round: 42, status: 'active', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_600_000,
}

test('导出物：不限制的轴渲染成 ∞，绝不出现 `42/0`', () => {
  const md = renderMeetingMarkdown(FREE, [], [], undefined)
  assert.ok(md.includes('**预算用量**：42/∞ 轮 · 9999999/∞ token'), '导出物须用 ∞ 表示不限制')
  assert.ok(!md.includes('/0 '), '导出物不得出现 `/0`（会被读成"越用越少"）')
})

test('导出物：不限制时仍保留用量（不可因"没有上限"就把已用也抹掉）', () => {
  const md = renderMeetingMarkdown(FREE, [], [], undefined)
  assert.ok(md.includes('42/∞'), '已用轮数必须仍在（用户要能看出跑了多少）')
})

test('设置卡：0 渲染成「不限制」，不得再写「超限自动闭麦」', () => {
  const card = formatMeetingDraft({
    name: '探针', goal: 'g', mode: 'orchestrated', maxRounds: 0, maxTokens: 0,
    kbPath: '', skills: [], skillDelivery: 'relay',
  }, [])
  assert.ok(card.includes('不限制'), '设置卡必须让用户看见"不限制"三个字')
  assert.ok(!card.includes('0 轮（超限自动闭麦）'), '0 轮不得被写成"超限自动闭麦"（正好是本意的反面）')
  assert.ok(!card.includes('0 tokens（超限自动闭麦）'), '0 tokens 同上')
})

test('设置卡：有限上限仍照旧说"超限自动闭麦"（不限制是特例，不是替换）', () => {
  const card = formatMeetingDraft({
    name: '探针', goal: 'g', mode: 'orchestrated', maxRounds: 10, maxTokens: 200_000,
    kbPath: '', skills: [], skillDelivery: 'relay',
  }, [])
  assert.ok(card.includes('10 轮（超限自动闭麦）'), '有限上限必须保留原有口径')
  assert.ok(card.includes('200000 tokens（超限自动闭麦）'), '有限上限必须保留原有口径')
})

test('总纲：专家须知道 0 的轴的语义是"不限制"（否则会误判自己已超预算）', () => {
  const charter = buildCharter(FREE)
  assert.ok(charter.includes('不限制'), '总纲须声明 0 = 不限制')
})

test('客户端设置页：两个输入框必须接受 0（不得 Math.max(1)/Math.max(1000) 顶掉）', () => {
  const settings = read('client/RoundTableSettings.tsx')
  /*
   * 判据取**行内**：`min={1}` / `min={1000}` 与 `Math.max(1, …)` / `Math.max(1000, …)`
   * 是本轮要剿掉的确切形态 —— 用户敲下 0 会被立刻改写成 1/1000，永远存不进"不限制"。
   */
  assert.doesNotMatch(settings, /min=\{1\}/, 'maxRounds 输入框不得再用 min={1}（0 是合法值）')
  assert.doesNotMatch(settings, /min=\{1000\}/, 'maxTokens 输入框不得再用 min={1000}')
  assert.doesNotMatch(settings, /Math\.max\(1, Math\.floor\(Number\(event\.target\.value\)/, 'maxRounds 不得把 0 顶成 1')
  assert.doesNotMatch(settings, /Math\.max\(1000, Math\.floor\(Number\(event\.target\.value\)/, 'maxTokens 不得把 0 顶成 1000')
  // 反向守卫：不能为了通过上面几条就把输入框整个删掉
  assert.match(settings, /patch\(\{ maxRounds: value \}\)/, 'maxRounds 输入框必须仍在（不得为过判据而删）')
  assert.match(settings, /patch\(\{ maxTokens: value \}\)/, 'maxTokens 输入框必须仍在')
  assert.match(settings, /settingsBudgetUnlimitedHint/, '设置页须给出"0 = 不限制"的可读说明')
})

test('客户端预算条：不限制时显示 ∞ 且不画进度（不得退化成 `N/0`）', () => {
  const view = read('client/RoundTableView.tsx')
  assert.match(view, /budgetDial/, '预算条须走统一口径（不得两处各写一份）')
  assert.match(view, /∞/, '预算条须渲染 ∞ 表示不限制')
  assert.doesNotMatch(
    view,
    /\{meeting\.budget\.usedRounds\}\/\{meeting\.budget\.maxRounds\}/,
    '不得再直接拼 `used/max`（max=0 时会渲染成 N/0）',
  )
  assert.doesNotMatch(
    view,
    /\{meeting\.budget\.usedTokens\}\/\{meeting\.budget\.maxTokens\}/,
    '不得再直接拼 `used/max`（token 轴同上）',
  )
})

test('五段链的口径一致：三个 host 渲染面都不得含 `/0` 形态的硬编码', () => {
  /*
   * 这一条打的是**结构**：只要还有人自己拼 `used/max`，不限制的轴上就会出现 `/0`。
   * 三个 host 渲染面（tools.ts 的 status/导出、plan.ts 的设置卡）一律必须走
   * `budget.ts` 的唯一口径函数。
   */
  const tools = read('tools.ts')
  const plan = read('plan.ts')
  assert.match(tools, /budgetAxisText\(/, 'status/导出须走 budgetAxisText')
  assert.match(plan, /budgetUnlimited\(/, '设置卡须走 budgetUnlimited 判定')
  assert.doesNotMatch(tools, /out\.push\(`- \*\*预算用量\*\*：\$\{meeting\.budget\.usedRounds\}/, '导出不得再手拼 used/max')
  assert.doesNotMatch(tools, /`Budget: \$\{String\(budget\.used_rounds\)\}/, 'status 不得再手拼 used/max')
})
