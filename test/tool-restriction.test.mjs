/**
 * 节点工具面过滤的回归测试。
 *
 * 缺陷背景：`ToolRuntime.restrict()` 对**宿主未注册的工具名**会直接抛错
 * （"unknown global tools"），而 `NODE_ALLOWED_TOOLS` 是一份与宿主无关的
 * 愿望清单——本机宿主实名是 `pwsh` / `edit` / `list_agents`，没有
 * `bash` / `str_replace_editor` / `list_subagent_models`。因此在
 * `skill_delivery=direct` 下，节点 spawn 会在传 restrict 的那一刻整体失败，
 * 且报错指向的是一个本环境根本不存在的工具名，难以归因。
 *
 * 修法是把愿望清单按宿主真实注册表过滤后再传（`isRegistered` 回调）。
 * 这份测试用**主持人视角的注册表**（CAPTAIN_TOOLS）驱动它，因为过滤查询
 * 就是 `ctx.tools.get(name, captain)`：主持人专属的 deny 名单工具在主持人
 * 视角下是存在的，必须保留在 deny 里才能真正挡住节点。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { nodeToolRestriction, restrictionDiagnostics } from '../src/members.ts'

/**
 * 模拟「主持人可见」的工具注册表：本机宿主实名 + 全部圆桌工具
 * （含主持人专属的 create / add_node / request_decision …，它们正是 deny 的标的）。
 */
const CAPTAIN_TOOLS = new Set([
  // 通用实名（本机无 bash / str_replace_editor / list_subagent_models）
  'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'pwsh',
  'todo_write', 'web_search', 'web_fetch',
  'send_message', 'interrupt_agent', 'list_agents',
  'job_list', 'job_output', 'job_kill',
  // 圆桌工具：专家可用的
  'roundtable_speak', 'roundtable_send_message', 'roundtable_summarize',
  'roundtable_status', 'roundtable_actions_clear', 'roundtable_start_review',
  'roundtable_proxy_think',
  // 圆桌工具：主持人专属（deny 标的）
  'roundtable_create', 'roundtable_plan_meeting', 'roundtable_add_node',
  'roundtable_remove_node', 'roundtable_connect', 'roundtable_disconnect',
  'roundtable_next_round',
  'roundtable_request_decision', 'roundtable_set_budget', 'roundtable_close',
  'roundtable_collect_review', 'roundtable_finish_review',
  'roundtable_export_review', 'roundtable_export_meeting', 'roundtable_kb_digest',
  // direct 模式下专家自行加载 skill
  'skill',
  /*
   * 非执行面的宿主能力（P6 的收窄标的）。这些**确实注册在本机宿主**上
   * （实测：专家节点 relay 下曾顺带继承它们，其中 dev_* 可运行时注入任意插件
   * = 等价任意代码执行）。mock 里必须列出，否则 isRegistered 过滤会把它们
   * 从 deny 里摘掉，测试就测不到"收窄是否真的写进了 deny"。
   */
  'dev_inject_plugin', 'dev_uninject_plugin', 'dev_reload_package', 'dev_reload_preset',
  'dev_injected_list', 'dev_install_package', 'dev_plugin_status', 'dev_clear_routes',
  'dev_fix_patch', 'dev_heal_links', 'dev_self_test', 'dev_scaffold_plugin',
  'dev_build_plugin', 'dev_release_plugin', 'dev_stage_add', 'dev_stage_call',
  'dev_stage_list', 'dev_stage_promote', 'dev_stage_demote',
  'nav_commit', 'nav_decide', 'nav_graph', 'nav_node', 'nav_set',
  'present',
])
const isRegistered = (name) => CAPTAIN_TOOLS.has(name)

/* ---------------- P6（2026-09-25）：工具面单一真源，全模式下发 allow ---------------- */

test('P6: relay 模式**也**下发 allow（写权限不再由 skill_delivery 派生）', () => {
  const r = nodeToolRestriction('orchestrated', 'relay', isRegistered)
  assert.ok(Array.isArray(r.allow), 'relay 必须发 allow —— 否则工具面仍随该开关漂移')
  assert.ok(r.allow.includes('write'), 'expert 执行面 write 必须保留')
  assert.ok(r.allow.includes('edit'), 'expert 执行面 edit 必须保留')
  assert.ok(r.allow.includes('pwsh'), 'expert 执行面 pwsh 必须保留')
})

test('P6: relay 与 direct 的执行面完全一致（差别只在 skill 加载器）', () => {
  const relay = nodeToolRestriction('orchestrated', 'relay', isRegistered)
  const direct = nodeToolRestriction('orchestrated', 'direct', isRegistered)
  for (const name of ['write', 'edit', 'pwsh', 'read', 'grep', 'glob']) {
    assert.ok(relay.allow.includes(name), `relay 执行面缺 ${name}`)
    assert.ok(direct.allow.includes(name), `direct 执行面缺 ${name}`)
  }
  assert.ok(!relay.allow.includes('skill'), 'relay：skill 正文由主持人中转，专家不应自取')
  assert.ok(direct.allow.includes('skill'), 'direct：专家自行加载 skill')
})

test('P6: 非执行面宿主能力已收窄（dev_* / nav_* / present）', () => {
  const r = nodeToolRestriction('orchestrated', 'relay', isRegistered)
  for (const name of ['dev_inject_plugin', 'dev_reload_package', 'nav_commit', 'present']) {
    assert.ok(r.deny.includes(name), `${name} 应被 deny（非执行面）`)
    assert.ok(!r.allow.includes(name), `${name} 不应出现在 allow`)
  }
})

test('P6: 收窄不得吃掉执行面（把需求本身挡掉是最坏的过度修复）', () => {
  const r = nodeToolRestriction('orchestrated', 'relay', isRegistered)
  for (const name of ['write', 'edit', 'pwsh']) {
    assert.ok(!r.deny.includes(name), `${name} 绝不能进 deny —— 专家的本职就是落地执行`)
  }
})

test('P6: restrictionDiagnostics 能识别"空 allow 残废"', () => {
  const healthy = restrictionDiagnostics(nodeToolRestriction('orchestrated', 'relay', isRegistered))
  assert.equal(healthy.degraded, false)
  assert.ok(healthy.allowCount > 0)
  const broken = restrictionDiagnostics(nodeToolRestriction('orchestrated', 'relay', () => false))
  assert.equal(broken.degraded, true, 'allow 被滤空必须判 degraded（否则残废席位静默）')
  assert.equal(broken.allowCount, 0)
})

test('relay 模式同样经过注册表过滤，且闸门工具保留', () => {
  const r = nodeToolRestriction('orchestrated', 'relay', isRegistered)
  assert.ok(r.deny.includes('roundtable_create'))
  assert.ok(r.deny.includes('roundtable_close'))
  assert.ok(!r.allow.includes('bash'), '本机未注册 bash，应被过滤掉')
})

test('未传 isRegistered 时保持旧行为：整份清单原样传入', () => {
  const r = nodeToolRestriction('orchestrated', 'direct')
  assert.ok(r.allow.includes('bash'), '未过滤时应保留愿望清单原样')
  assert.ok(r.allow.includes('str_replace_editor'))
})

test('单线制仍保留主持人专属闸门（新增 deny 不得挤掉原有闸门）', () => {
  for (const mode of ['orchestrated', 'redteam']) {
    const r = nodeToolRestriction(mode, 'relay', isRegistered)
    for (const name of ['roundtable_create', 'roundtable_add_node', 'roundtable_close', 'roundtable_kb_digest', 'send_message']) {
      assert.ok(r.deny.includes(name), `${mode}: ${name} 必须在 deny 中`)
    }
  }
})

test('direct 模式发 allow + deny', () => {
  const r = nodeToolRestriction('orchestrated', 'direct', isRegistered)
  assert.ok(Array.isArray(r.allow))
  assert.ok(Array.isArray(r.deny))
})

test('过滤后不含宿主未注册的工具名（这正是旧版 spawn 失败的原因）', () => {
  const r = nodeToolRestriction('orchestrated', 'relay', isRegistered)
  for (const name of [...r.allow, ...r.deny]) {
    assert.ok(CAPTAIN_TOOLS.has(name), `过滤后仍残留未注册工具名：${name}`)
  }
})

test('本机没有 bash / str_replace_editor / list_subagent_models 时，它们被剔除', () => {
  const r = nodeToolRestriction('orchestrated', 'relay', isRegistered)
  for (const name of ['bash', 'str_replace_editor', 'list_subagent_models']) {
    assert.ok(!r.allow.includes(name), `${name} 应从 allow 中剔除`)
    assert.ok(!r.deny.includes(name), `${name} 应从 deny 中剔除`)
  }
})

test('宿主确实注册的工具被保留（过滤不能把清单清空）', () => {
  const r = nodeToolRestriction('orchestrated', 'relay', isRegistered)
  assert.ok(r.allow.includes('roundtable_speak'), '专家协作工具应保留')
  assert.ok(r.allow.includes('pwsh'), '本机实名 shell 应保留')
  assert.ok(r.allow.includes('roundtable_status'), '专家要查自己的轮次与预算')
})

test('主持人专属工具仍在 deny 里（过滤不能把权限闸门放空）', () => {
  const r = nodeToolRestriction('orchestrated', 'relay', isRegistered)
  for (const name of ['roundtable_create', 'roundtable_add_node', 'roundtable_close', 'roundtable_kb_digest']) {
    assert.ok(r.deny.includes(name), `${name} 必须在 deny 中`)
    assert.ok(!r.allow.includes(name), `${name} 不应出现在 allow 中`)
  }
})

test('isRegistered 全 false 时 allow 为空且判 degraded（不抛错，交由 spawnNode 拒绝）', () => {
  const r = nodeToolRestriction('orchestrated', 'relay', () => false)
  assert.deepEqual(r.allow, [])
  assert.deepEqual(r.deny, [])
  assert.equal(restrictionDiagnostics(r).degraded, true)
})

test('默认参数是 relay，且已下发 allow（P6 后不再返回 undefined）', () => {
  const r = nodeToolRestriction()
  assert.ok(Array.isArray(r.allow), 'P6 后默认路径也必须发 allow')
  assert.ok(!r.allow.includes('skill'), '默认 relay：不应留 skill 加载器')
})

/* ---------------- 三模式语义（2026-09-19）：单线制不可见他人 ---------------- */

test('单线制 deny roundtable_summarize（全场逐人纪要），圆桌制保留', () => {
  for (const mode of ['orchestrated', 'redteam']) {
    const r = nodeToolRestriction(mode, 'relay', isRegistered)
    assert.ok(r.deny.includes('roundtable_summarize'), `${mode}: 全场纪要必须 deny（否则"不知道有别人"是假的）`)
  }
  const egalitarian = nodeToolRestriction('egalitarian', 'relay', isRegistered)
  assert.ok(!egalitarian.deny.includes('roundtable_summarize'), 'egalitarian: 纪要应保留')
})

test('单线制 direct 模式下 summarize 的有效工具面被挡（allow ∩ ¬deny）', () => {
  const r = nodeToolRestriction('orchestrated', 'relay', isRegistered)
  const effective = r.allow.filter((name) => !r.deny.includes(name))
  assert.ok(!effective.includes('roundtable_summarize'), '有效工具面不得含 summarize')
  assert.ok(effective.includes('roundtable_speak'), '有效工具面仍须含 speak')
  assert.ok(effective.includes('roundtable_status'), '有效工具面仍须含 status（专家要查自己的轮次与预算）')
  const egalitarian = nodeToolRestriction('egalitarian', 'relay', isRegistered)
  const effectiveEg = egalitarian.allow.filter((name) => !egalitarian.deny.includes(name))
  assert.ok(effectiveEg.includes('roundtable_summarize'), 'egalitarian 有效工具面应含 summarize')
})

test('R-B 单一出口：宿主 send_message 在 relay 与 direct 下都被 deny', () => {
  for (const delivery of ['relay', 'direct']) {
    const r = nodeToolRestriction('orchestrated', delivery, isRegistered)
    assert.ok(r.deny.includes('send_message'), `${delivery}: send_message 必须在 deny 中（阻断子代理正文回传主会话）`)
  }
})

test('R-B 单一出口：send_message 不出现在任何模式的 allow 白名单', () => {
  for (const delivery of ['relay', 'direct']) {
    const r = nodeToolRestriction('orchestrated', delivery, isRegistered)
    assert.ok(!r.allow.includes('send_message'), 'allow 清单不得放宿主回传通道回来')
  }
})

test('R-B：roundtable_next_round 是主持人专属工具，节点必须被 deny', () => {
  const r = nodeToolRestriction('orchestrated', 'relay', isRegistered)
  assert.ok(r.deny.includes('roundtable_next_round'))
  assert.ok(!r.allow.includes('roundtable_next_round'))
})
