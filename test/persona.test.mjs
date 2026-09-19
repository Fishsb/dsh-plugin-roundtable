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

/* ---------------- 三模式语义（2026-09-19 定稿）：单线制不可见他人 ---------------- */

const NODES = [
  { key: 'alpha', role: '架构主审：只审结构', id: '', status: 'active' },
  { key: 'beta', role: '落地可行性：只答能不能做', id: '', status: 'active' },
  { key: 'gamma', role: '验收判据：只写可复验判据', id: '', status: 'active' },
]

/** 真实装配：charter 在会议创建时生成并存入 meeting.charter，再注入每个节点 persona。 */
function composed(mode, selfKey = 'alpha') {
  const m = meeting({ mode, nodes: NODES })
  const charter = buildCharter(m)
  return { charter, persona: nodePersona({ ...m, charter }, NODES.find((n) => n.key === selfKey), '.roundtable') }
}

test('A1 单线制 persona 不含其他席位的 key 与 role（专家互不知情）', () => {
  for (const mode of ['orchestrated', 'redteam']) {
    const { persona } = composed(mode)
    for (const other of ['beta', 'gamma']) {
      assert.ok(!persona.includes(other), `${mode}: persona 不得出现他人 key ${other}`)
    }
    assert.ok(!persona.includes('落地可行性'), `${mode}: persona 不得出现他人 role 文本`)
    assert.ok(!persona.includes('验收判据：'), `${mode}: persona 不得出现他人 role 文本`)
    assert.ok(persona.includes('alpha'), `${mode}: 自己的 key 应保留`)
  }
})

test('A1 圆桌制 persona 含全部席位（知道所有其他专家）', () => {
  const { persona } = composed('egalitarian')
  assert.ok(persona.includes('beta') && persona.includes('gamma'), 'egalitarian: 应看到全部 key')
  assert.ok(persona.includes('落地可行性'), 'egalitarian: 应看到他人 role')
})

test('A2 单线制 charter 不含名册段与连线段；圆桌制含', () => {
  const single = composed('orchestrated').charter
  assert.ok(!single.includes('连线通道'), '单线制不得出现连线通道')
  assert.ok(!single.includes('名册快照'), '单线制不得出现名册快照声明')
  assert.ok(single.includes('互不披露'), '单线制应声明互不披露')
  const round = composed('egalitarian').charter
  assert.ok(round.includes('连线通道') && round.includes('名册快照'), '圆桌制应保留名册与连线')
})

test('A3 越界处置按模式分叉：单线制上交主持人 / 圆桌制直转同伴', () => {
  const single = composed('orchestrated').persona
  assert.ok(single.includes('[越界转派]'), '单线制应教会用 [越界转派] 行上交')
  assert.ok(!single.includes('直接转给名册里承担该职责的成员'), '单线制不得教直转同伴')
  const eg = composed('egalitarian').persona
  assert.ok(eg.includes('直接转给名册里承担该职责的成员'), '圆桌制应教直转同伴')
  // R-D 精确化：旧断言是"圆桌制 persona 完全不含 [越界转派]" —— 那个口径太粗，
  // 与"必须声明**不使用**该标记（否则实现不收集、专家却照写 = 两条真相）"
  // 直接冲突。判据改为**按语境**分：不得出现在"该用/请用"的语境里，
  // 但必须出现在"不使用"的声明里。这不是放宽，是把"教用"与"声明不用"分开。
  assert.ok(!/请(在|用|按).{0,20}\[越界转派\]/.test(eg), '圆桌制不得教用该标记')
  assert.ok(!eg.includes('由主持人再分配'), '圆桌制不得说"交主持人再分配"（那是单线制口径）')
  assert.ok(/不使用.{0,10}\[越界转派\]/.test(eg), '圆桌制必须显式声明不使用该标记（与实现对账）')
})

test('A4 buildCharter 单线制不含其他席位 key（防 charter 漏改）', () => {
  for (const mode of ['orchestrated', 'redteam']) {
    const charter = composed(mode).charter
    for (const other of ['beta', 'gamma']) {
      assert.ok(!charter.includes(other), `${mode}: charter 不得出现他人 key ${other}`)
    }
  }
})

test('R-C 名册提示只在圆桌制出现（单线制不提示去查名册）', () => {
  const eg = nodePersona(meeting({ mode: 'egalitarian' }), node, '.roundtable')
  assert.ok(eg.includes('名册是加入时刻的快照'), 'egalitarian 应声明名册是快照')
  assert.ok(eg.includes('roundtable_status 的 nodes[] 为准'), 'egalitarian 应指向 status 查册')
  for (const mode of ['orchestrated', 'redteam']) {
    const persona = nodePersona(meeting({ mode }), node, '.roundtable')
    assert.ok(!persona.includes('名册是加入时刻的快照'), `${mode}: 单线制不得提示名册快照`)
    assert.ok(persona.includes('不掌握'), `${mode}: 单线制应声明不掌握其他席位`)
  }
})

test('nodeWelcome 按模式分叉：圆桌制可直达 / 红队只报主持人 / 统筹单线等派单', () => {
  const egalitarian = nodeWelcome(meeting({ mode: 'egalitarian' }), node)
  assert.ok(egalitarian.includes('圆桌制'))
  assert.ok(egalitarian.includes('roundtable_send_message'), '圆桌制应教直达消息')
  const redteam = nodeWelcome(meeting({ mode: 'redteam' }), node)
  assert.ok(redteam.includes('针锋相对'))
  assert.ok(redteam.includes('严禁互相直达'))
  const orchestrated = nodeWelcome(meeting({ mode: 'orchestrated' }), node)
  assert.ok(orchestrated.includes('单线制'), '统筹模式应标明单线制')
  assert.ok(orchestrated.includes('不掌握'), '统筹模式应声明不掌握其他席位')
  assert.ok(!orchestrated.includes('多模型平等'))
})

test('nodeWelcome 收尾：产出走 roundtable_speak，且单线制不暴露名册来源', () => {
  const welcome = nodeWelcome(meeting(), node)
  assert.ok(welcome.includes('你已加入圆桌会议'))
  assert.ok(welcome.includes('roundtable_speak'))
  assert.ok(!welcome.includes('roundtable_status 的 nodes[] 为准'), '单线制 welcome 不得提示查名册')
})
