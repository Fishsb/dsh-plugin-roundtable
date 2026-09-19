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
  // ⚠ 第 4 轮验收的反例：只断言"出现过 .then("是不够的 —— 把 toast 挪进 .catch
  // 并在 catch 里补一次 refresh()，旧断言照样绿。真正的判据是**成功分支之前不得
  // 出现失败分支**。
  assert.doesNotMatch(between, /\.catch\(/, 'toast 之前不得出现 .catch( —— 否则失败也会报成功')
  assert.ok(handler.indexOf('refresh()', toastAt) > toastAt, '提示之后仍要重画（两件事都要做）')
})

test('② 拖线说明必须按模式分叉（单线制/圆桌制各一句），不得再用一句通吃', () => {
  const view = read(VIEW)
  const locales = read('../src/client/locales.ts')
  // 两个键都必须存在（zh/en 各一份 = 每个键在 locales 里出现 3 次：联合 + zh + en）。
  // ⚠ 必须用词边界：`edgeScopeHintEgalitarian` 含 `edgeScopeHint` 子串，裸计数会串味。
  for (const key of ['edgeScopeHint', 'edgeScopeHintEgalitarian']) {
    const hits = (locales.match(new RegExp(key + '(?![A-Za-z])', 'g')) ?? []).length
    assert.equal(hits, 3, `${key} 必须在联合类型与 zh/en 各出现一次（实测 ${hits}）`)
  }
  const modeAware = view.split("meeting.mode === 'egalitarian' ? 'edgeScopeHintEgalitarian' : 'edgeScopeHint'").length - 1
  assert.equal(modeAware, 2, `图例与右键菜单两处都必须按模式分叉，实测 ${modeAware} 处`)
  // 成功 toast 也必须分叉（单线制下"已连接"会被误读成改动了通信权限）
  assert.match(view, /meeting\?\.mode === 'egalitarian' \? 'edgeConnected' : 'edgeConnectedSingleLine'/,
    '连线成功提示必须按模式分叉')
})

test('⑦b 不可投递的边必须有可见标注（`deliverable` 不得再是只写不读）', () => {
  const view = read(VIEW)
  const css = read('../src/client/RoundTableView.module.css')
  assert.match(view, /edge\.deliverable === false/, '客户端必须真的读取 host 的 deliverable 判定')
  assert.match(view, /styles\.edgeUndeliverable/, '不可投递的边必须有降级样式')
  assert.match(css, /\.edgeUndeliverable\s*\{/, 'CSS 必须定义该降级样式')
  assert.match(view, /translate\('edgeUndeliverableHint'\)/, '必须配一条可读说明（SVG title）')
})

test('⑧ 三个弹窗必须能用 Esc 关闭（此前 src/client 全目录 0 命中）', () => {
  const view = read(VIEW)
  // 只数真正的 JSX 属性行（注释里也会提到这个字符串，裸计数会把它算进去）
  const dialogs = view.match(/^\s+role="dialog"/gm) ?? []
  assert.equal(dialogs.length, 3, `弹窗数变了（${dialogs.length}）—— 新增弹窗时同步 Esc 处理`)
  const effect = sliceFrom(view, "if (event.key !== 'Escape') return", 'window.addEventListener')
  for (const closer of ['setReviewOpen(false)', 'closeManage()', 'closeKb()']) {
    assert.ok(effect.includes(closer), `Esc 必须能关掉对应弹窗：缺 ${closer}`)
  }
  assert.match(view, /removeEventListener\('keydown'/, '必须解绑 keydown（否则重复挂监听）')
})

test('F1 用量必须随会议切换复位（否则显示上一场的数字）', () => {
  const view = read(VIEW)
  assert.match(view, /setUsage\(null\)/, '换会议必须清掉上一场的用量结果')
  const resetEffect = sliceFrom(view, 'setUsage(null)', '}, [meeting?.id])')
  assert.ok(resetEffect.length > 0, '复位必须挂在 meeting.id 的 effect 上')
})

test('⑤ 用量"没有值"的两种情形必须分开说（投影未挂 vs 该席无活会话）', () => {
  const view = read(VIEW)
  const locales = read('../src/client/locales.ts')
  assert.match(view, /usage\.projections_available \? 'usageDormant' : 'usageUnavailable'/,
    '客户端必须用端点上报的 projections_available 选文案')
  for (const key of ['usageDormant', 'usageUnavailable']) {
    assert.equal((locales.match(new RegExp(key, 'g')) ?? []).length, 3, `${key} 必须在联合类型与 zh/en 各出现一次`)
  }
  // 反例守卫：文案不得再说"无 provider 值（节点无会话或宿主未挂投影）"这种把两种情形混起来的说法
  assert.doesNotMatch(locales, /节点无会话或宿主未挂投影/, '该文案与 projections_available=true 自相矛盾，已废弃')
})
