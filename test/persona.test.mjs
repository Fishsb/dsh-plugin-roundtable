/**
 * R-B 单一出口：persona / charter 的协议断言。
 *  - 反指引：说破宿主"回传 parent"要求，防专家撞 deny 后重试；
 *  - modeRule 三分支（redteam 不再误标"主持人统筹"）；
 *  - charter 第三节：[核心产出] 自包含 + [建议决策] + 单一出口原则。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { nodePersona, nodeWelcome } from '../src/members.ts'
import { buildCharter } from '../src/charter.ts'

function meeting(overrides = {}) {
  return {
    id: 'm1',
    name: '测试会议',
    goal: '目标',
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

const node = { key: 'engineer', role: '工程', id: '', status: 'active' }

test('persona 含反指引：忽略宿主 send_message 回传要求，产出只走 roundtable_speak', () => {
  const persona = nodePersona(meeting(), node, '.roundtable')
  assert.ok(persona.includes('回传'), '应提到宿主回传指引')
  assert.ok(persona.includes('忽略它'), '应要求忽略该指引')
  assert.ok(persona.includes('该工具对你不可用'), '应说明 send_message 不可用')
})

test('modeRule 三分支：orchestrated / egalitarian / redteam 各自正确', () => {
  const orchestrated = nodePersona(meeting({ mode: 'orchestrated' }), node, '.roundtable')
  assert.ok(orchestrated.includes('协作模式为"主持人统筹"'))
  const egalitarian = nodePersona(meeting({ mode: 'egalitarian' }), node, '.roundtable')
  assert.ok(egalitarian.includes('协作模式为"多模型平等"'))
  const redteam = nodePersona(meeting({ mode: 'redteam' }), node, '.roundtable')
  assert.ok(redteam.includes('针锋相对评审'), 'redteam 应有专属模式文案')
  assert.ok(!redteam.includes('协作模式为"主持人统筹"'), 'redteam 不得再误标为主持人统筹')
  assert.ok(redteam.includes('严禁提出替代方案'), 'redteam 文案含红队纪律')
})

test('persona 发言格式：[核心产出] 自包含 + [建议决策] 行', () => {
  const persona = nodePersona(meeting(), node, '.roundtable')
  assert.ok(persona.includes('[核心产出] 必须自包含'))
  assert.ok(persona.includes('[建议决策]'))
})

test('charter 第三节：自包含 / 建议决策 / 单一出口三规则注入总纲', () => {
  const charter = buildCharter(meeting())
  assert.ok(charter.includes('[核心产出] 必须自包含'))
  assert.ok(charter.includes('[建议决策]'))
  assert.ok(charter.includes('单一出口'))
})

/* ---------------- R-C 名册感知 ---------------- */

test('R-C modeRule 三分支都带"名册快照 → 查 roundtable_status"提醒', () => {
  for (const mode of ['orchestrated', 'egalitarian', 'redteam']) {
    const persona = nodePersona(meeting({ mode }), node, '.roundtable')
    assert.ok(persona.includes('名册是加入时刻的快照'), `${mode} 应声明名册是快照`)
    assert.ok(persona.includes('roundtable_status 的 nodes[] 为准'), `${mode} 应指向 roundtable_status 查册`)
  }
})

test('R-C nodeWelcome 按模式分叉：平等可直达 / 红队只报主持人 / 统筹等派单', () => {
  const egalitarian = nodeWelcome(meeting({ mode: 'egalitarian' }), node)
  assert.ok(egalitarian.includes('多模型平等'))
  assert.ok(egalitarian.includes('roundtable_send_message'), '平等模式应教直达消息')
  const redteam = nodeWelcome(meeting({ mode: 'redteam' }), node)
  assert.ok(redteam.includes('针锋相对'))
  assert.ok(redteam.includes('严禁互相直达'))
  const orchestrated = nodeWelcome(meeting({ mode: 'orchestrated' }), node)
  assert.ok(orchestrated.includes('主持人会给你布置任务'))
  assert.ok(!orchestrated.includes('多模型平等'))
})

test('R-C nodeWelcome 收尾：名册一律以 roundtable_status 为准', () => {
  const welcome = nodeWelcome(meeting(), node)
  assert.ok(welcome.includes('你已加入圆桌会议'))
  assert.ok(welcome.includes('roundtable_speak'))
  assert.ok(welcome.includes('roundtable_status 的 nodes[] 为准'))
})

test('R-C charter 名册表带快照新鲜度声明', () => {
  const charter = buildCharter(meeting({
    nodes: [{ key: 'engineer', role: '工程', id: '', status: 'active' }],
  }))
  assert.ok(charter.includes('名册快照'), '应说明表是编译时刻快照')
  assert.ok(charter.includes('roundtable_status 的 nodes[] 为准'), '应指向权威名册来源')
})
