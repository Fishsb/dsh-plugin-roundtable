/**
 * 边界可判定性 · 功能测试（2026-09-23 · 吸收 P10「成功标准须可量化」）。
 *
 * ══ 为什么单独有本文件（而不是只靠 double-truth-guards 的文本断言）══════════════
 * `double-truth-guards.test.mjs` ⑩-a/⑩-b 是**读源码文本**断言"接线在不在"——
 * 它能抓"文案说 A、实现做 B"，但**抓不到"接线在、渲染出来却是空"**。
 * 本文件走**真调用**：拿一个真的 boundary 对象喂给 `buildCharter` /
 * `formatMeetingDraft` / `renderMeetingMarkdown`，看值有没有真的抵达输出。
 *
 * ⚠ 先红已验（改动前实测）：同一组断言在原始源码上是 1/6 与 1/4 通过
 *   （唯一恒真的那条是"不许动"行，改动前就存在）⇒ 断言非平凡、非全红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCharter } from '../src/charter.ts'
import { formatMeetingDraft } from '../src/plan.ts'
import { renderMeetingMarkdown } from '../src/tools.ts'

const BASE = {
  id: 'probe', name: '探针会议', goal: 'g', mode: 'orchestrated',
  captainSessionId: 'c', charter: '', nodes: [], edges: [], decisions: [],
  budget: { maxRounds: 5, maxTokens: 1000, usedRounds: 0, usedTokens: 0 },
  round: 0, status: 'active', createdAt: 0, updatedAt: 0,
}

const CHECK = '跑 check-capacity.mjs，比对输出 JSON'
const WALL = '不许动 storeMode 读侧'

test('check 真的抵达总纲（每个专家的 persona）', () => {
  const charter = buildCharter({
    ...BASE,
    boundary: { goal: '容量门不清', done: '设置页四个框都有缺省', check: CHECK, notDoing: WALL },
  })
  assert.ok(charter.includes(CHECK), '总纲必须含检查方式正文（不是只含标签）')
  assert.ok(charter.includes('怎么检查才算达标'), '总纲须带检查方式标签')
  assert.ok(charter.includes(WALL), '既有"不许动"那面墙不得因新增字段而丢')
})

test('check 真的抵达导出物（事后复盘用）', () => {
  const md = renderMeetingMarkdown(
    { ...BASE, boundary: { goal: '容量门不清', done: '有缺省', check: CHECK, notDoing: WALL } },
    [], [], undefined,
  )
  assert.ok(md.includes(CHECK), '导出物必须含检查方式正文')
  assert.ok(md.includes('- **怎么检查**：'), '导出物须带"怎么检查"标签')
})

test('check 真的抵达设置卡（用户确认那一屏）', () => {
  const card = formatMeetingDraft({
    name: '探针', goal: 'g', mode: 'orchestrated', maxRounds: 5, maxTokens: 1000,
    kbPath: '', skills: [], skillDelivery: 'relay',
    boundary: { goal: '容量门不清', done: '四个框有缺省', check: CHECK, notDoing: WALL },
  }, [])
  assert.ok(card.includes(CHECK), '设置卡必须含检查方式正文')
  assert.ok(card.includes('**怎么检查**'), '设置卡须带"怎么检查"标签')
  assert.ok(card.includes(WALL), '设置卡既有边界项不得丢')
})

test('缺 check 时三处都显式出声（不得留白成"假完整"）', () => {
  const noCheck = { goal: 'g', done: '有缺省', check: '', notDoing: '' }
  const charter = buildCharter({ ...BASE, boundary: noCheck })
  const md = renderMeetingMarkdown({ ...BASE, boundary: noCheck }, [], [], undefined)
  const card = formatMeetingDraft({
    name: '探针', goal: 'g', mode: 'orchestrated', maxRounds: 5, maxTokens: 1000,
    kbPath: '', skills: [], skillDelivery: 'relay', boundary: noCheck,
  }, [])
  assert.ok(charter.includes('怎么检查才算达标：（未声明）'), '总纲未填须标（未声明）')
  assert.ok(md.includes('- **怎么检查**：（未声明）'), '导出物未填须标（未声明）')
  assert.ok(card.includes('写不出检查方式的标准多半不可判定'), '设置卡未填须点破"多半不可判定"')
})
