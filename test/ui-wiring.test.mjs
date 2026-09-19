/**
 * UI 接线守卫（批次 A/B 里**没有自动断言**的四条改动）：源码级断言，不需要 DOM 运行时。
 *
 * 与相邻守卫文件的分工（避免重复覆盖）：
 *   - `panel-ids.test.mjs`：面板 id 单源（host 清单 = 视图渲染集合）；
 *   - `silence.test.mjs`：静默判据及其接线（导出名单行内 + 网关摘要尾部，含"只接一处"防线）；
 *   - **本文件**：交互接线 —— ① 预设下拉受控、③ 时间轴在摘要区内、④ 技能并入 agents 脚部、
 *     ⑦ 边方向切换有成功反馈。
 *
 * 为什么必须钉住：这四条都是"改了看起来没事、但用户看不到/点不动"的类型 ——
 * typecheck 不查 JSX 结构，既有测试也不渲染客户端；只有源码结构断言能在回归时转红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const VIEW = '../src/client/RoundTableView.tsx'

/** 从锚点起取一段切片（找不到锚点即 fail，避免"锚点消失后断言静默通过"）。 */
const sliceFrom = (text, anchor, end) => {
  const at = text.indexOf(anchor)
  assert.ok(at >= 0, `锚点不存在：${anchor}`)
  const rest = text.slice(at)
  const stop = rest.indexOf(end)
  assert.ok(stop > 0, `切片终点不存在：${end}`)
  return rest.slice(0, stop)
}

test('① 预设下拉必须是受控组件（`value={selectedPresetId}`）—— 回退成 value="" 会让"选完看不出选了啥"复发', () => {
  const view = read(VIEW)
  const block = sliceFrom(view, "translate('managePresetLabel')", '</select>')
  const openTag = block.slice(block.indexOf('<select'), block.indexOf('>', block.indexOf('<select')) + 1)
  assert.match(openTag, /value=\{selectedPresetId\}/, '下拉的 value 必须是受控状态')
  assert.doesNotMatch(openTag, /value=""/, '不得回到硬编码空值（受控值恒空 → 选完立刻回弹）')
  // 占位项本身允许 value=""（这是合法用法，且必须有 onChange 才会回写状态）
  assert.match(openTag, /onChange=/, '受控值必须配 onChange')
  const after = block.slice(block.indexOf('>') + 1)
  assert.match(after, /<option value="">/, '占位项仍在（它的 value="" 不该被误删）')
})

test('③ 发言时间轴必须在网关摘要区内作第二视图（不新增面板、也不丢时间戳）', () => {
  const view = read(VIEW)
  const digest = sliceFrom(view, 'className={styles.digest}', '</details>')
  const bodyAt = digest.indexOf('styles.digestBody')
  const activityAt = digest.indexOf("translate('activity')")
  assert.ok(bodyAt >= 0, '摘要正文必须在 details 内')
  assert.ok(activityAt > bodyAt, '时间轴必须排在摘要正文之后（同一 details 内）')
  assert.match(digest, /styles\.logTime/, '时间轴必须含时间戳列（这正是它并入的理由）')
  assert.match(digest, /meeting\.recent/, '时间轴数据源必须是既有快照字段，不得新开数据面')
  assert.doesNotMatch(view, /data-rt-panel="activity"/, '不变量：activity 不得再作为独立面板存在')
})

test('④ 技能清单并入 agents 面板脚部（不占独立面板、不跨视图重复渲染）', () => {
  const view = read(VIEW)
  const agentsPanel = sliceFrom(view, 'data-rt-panel="agents"', 'data-rt-panel="kb"')
  assert.match(agentsPanel, /translate\('skillsTitle'\)/, '技能清单必须落在 agents 面板内')
  assert.match(agentsPanel, /meeting\.skills/, '清单数据源是会议级 skills')
  assert.doesNotMatch(view, /data-rt-panel="skills"/, '不变量：skills 不得再作为独立面板存在')
})

test('⑦ 边方向切换必须有成功反馈（toast 在 RPC 成功分支内、且在调用之后）', () => {
  const view = read(VIEW)
  const handler = sliceFrom(view, 'const handleEdgeAction', '}, [menu, refresh, rpc])')
  const rpcAt = handler.indexOf("'roundtable/edge.set'")
  const toastAt = handler.indexOf("translate(action === 'bidirectional' ? 'edgeSetBidirectional' : 'edgeSetForward')")
  assert.ok(rpcAt >= 0, '方向切换必须调 edge.set')
  assert.ok(toastAt > rpcAt, '成功提示必须在 edge.set 之后（失败不得谎报成功）')
  const between = handler.slice(rpcAt, toastAt)
  assert.match(between, /\.then\(/, 'toast 必须落在 .then 成功分支里')
  assert.ok(handler.indexOf('refresh()', toastAt) > toastAt, '提示之后仍要重画（两件事都要做）')
})
