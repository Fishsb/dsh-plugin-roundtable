/**
 * The《全局协作总纲》generated at meeting start and injected into every
 * expert node's persona. Four fixed sections per the V1 spec.
 * @module dsh-plugin-roundtable/charter
 */

import type { Meeting } from './types.ts'

/** Build the charter text for one meeting's current roster and edges. */
export function buildCharter(meeting: Meeting): string {
  const roster = meeting.nodes
    .filter((node) => node.status !== 'removed')
    .map((node) => `  - ${node.key}${node.role !== undefined && node.role !== '' ? `（${node.role}）` : ''}`)
    .join('\n')
  const edges = meeting.edges
    .map((edge) => `  - ${edge.from} → ${edge.to}${edge.direction === 'bidirectional' ? '（双向）' : '（单向）'}`)
    .join('\n')
  const redteamRules = meeting.mode === 'redteam'
    ? [
        '',
        '五、针锋相对评审协议（本会议为「针锋相对」模式）',
        '- 目标：对主持人已定稿的方案挑毛病（红队审查），找出方案的真实缺陷与认知盲区。',
        '- 每位专家只负责找缺陷，严禁提出替代方案；指出问题要具体、可复现，不较真不抬杠。',
        '- 每条观点只聚焦一个缺陷，建议 1~3 条；如无缺陷可明确说明"暂无"。',
        '- 观点证据分级（C1）：代码/bug 类缺陷必须附可复现步骤（"可复现：1. … 2. …"）；设计类缺陷附论证链（"论证：因为…所以…"），禁止为设计类缺陷编造伪复现步骤。',
        '- 主持人用 roundtable_start_review(question, plan) 记录议题与方案，专家发言后主持人用 roundtable_collect_review 收集观点，用户逐条「支持/驳回」（驳回须附理由）。',
        '- 闭环复审（C3）：用户在评审窗口表态后，主持人据此修订方案，再用 roundtable_finish_review 结束本轮。若开启下一轮复审，专家只核对上一轮已认定缺陷是否被修复，禁止引入全新打分项。',
      ]
    : []
  // 三模式语义（2026-09-19 定稿）：
  //  - 单线制（orchestrated / redteam）：专家互不披露，主持人是唯一信息枢纽；
  //  - 圆桌制（egalitarian）：名册与连线全公开，专家可直连。
  // 单线制下刻意**不拼** roster/edges —— 名册段本身就是"还有别人"的泄露面。
  const singleLineTeam = [
    '二、团队与通信边界（单线制）',
    '主持人（DeepSeek）：全局编排与最终汇总，唯一对用户负责；也是你唯一的联系人与信息来源。',
    '你与其他席位的存在互不披露：不掌握其他专家的人数、标识、分工与连线。',
    '权限隔离：只做本职，严禁越权代管他人的工作；只有主持人可以创建/移除成员、修改连线、发起人类决策、结束会议。',
    '本职以外的请求或发现，不要自行处理，也不要臆断谁会处理 —— 在本轮发言里单列一行 [越界转派]：<事项> | 建议承接：<职责>，由主持人再分配。',
  ]
  const roundTableTeam = [
    '二、团队成员与角色边界（圆桌制）',
    '主持人（DeepSeek）：全局编排与最终汇总，唯一对用户负责。',
    '专家节点：',
    roster === '' ? '（暂无）' : roster,
    '  （上表是总纲编译时刻的名册快照；成员可能已有增删，当前名册一律以 roundtable_status 的 nodes[] 为准。）',
    '连线通道：',
    edges === '' ? '（暂无）' : edges,
    '权限隔离：节点只做本职，严禁越权代管其他节点的工作；只有主持人可以创建/移除节点、修改连线、发起人类决策、结束会议。',
    '本职以外的请求或发现，直接转给名册里承担该职责的成员（roundtable_send_message），并在正文写明已转派，同时抄送主持人一行。',
    // R-D：与 dispatch.ts 的实现对齐 —— 那里对圆桌制**不收集** [越界转派]
    // （该标记是单线制的上行协议）。总纲如果不说明，就成了"实现按 A 做、
    // 文案按 B 读"的两条真相：专家会写该标记、主持人却永远收不到。
    '本模式**不使用** `[越界转派]` 标记（那是单线制的上行协议）：圆桌制下你直接转给同伴即可，机器不会收集该标记。',
  ]
  return [
    '《全局协作总纲》',
    '',
    '一、会议背景与核心目标',
    meeting.goal.trim() === '' ? '（未提供，以主持人现场说明为准）' : meeting.goal,
    /*
     * 用户原话（2026-09-23 · 用户要求「以用户的会话指令为核心，绝对要避免偏离用户指令」）。
     * 放在目标**之下、边界之上**：先看到"主持人怎么理解"，立刻对照"用户原话是什么"。
     * ⚠ 这条同时防两种偏离：主持人转述时歪掉、以及专家在讨论中把议题换成自己关心的。
     */
    ...(meeting.userDirective === undefined || meeting.userDirective.trim() === ''
      ? []
      : [
          '',
          '一之一、**用户原话**（未加工·最高优先级；与上文目标冲突时**以本条为准**）',
          `> ${meeting.userDirective.trim().split('\n').join('\n> ')}`,
          '本会议的**唯一目的**是满足上面这句用户指令。产出偏离它 = 无效产出，无论多精彩。',
        ]),
    /*
     * 边界声明（2026-09-23 · 用户全流程要求「避免方案拆东墙补西墙」）。
     * 三项随总纲进**每个专家**的 persona ⇒ 「不许动什么」成为全席共享的判据，
     * 而不是只活在主持人脑内。缺省时不给空标题（避免"有段落无内容"的假完整）。
     */
    ...(meeting.boundary === undefined
      ? []
      : [
          '',
          '一之二、本会议的边界声明（**改动前必须对照**）',
          `- 要解决的现象：${meeting.boundary.goal.trim() === '' ? '（未声明）' : meeting.boundary.goal.trim()}`,
          `- 算解决的标准：${meeting.boundary.done.trim() === '' ? '（未声明）' : meeting.boundary.done.trim()}`,
          `- **明确不做 / 不许动**：${meeting.boundary.notDoing.trim() === '' ? '（未声明）' : meeting.boundary.notDoing.trim()}`,
          '- ⚠ 提出任何改动时，须自答一句：「这条改动会不会碰坏上面『不许动』里的东西？」',
          '  若会，必须在 [核心产出] 里点明**碰了哪面墙、用什么证据确认没碰坏**；没有证据就标「未验证」。',
          '  禁止用"顺带修好了"掩盖越界改动 —— 那是拆东墙补西墙的典型形态。',
        ]),
    '',
    ...(meeting.mode === 'egalitarian' ? roundTableTeam : singleLineTeam),
    '',
    '三、标准化协作协议',
    '- 每次发言开头标注 [当前状态]，结尾给出 [核心产出] 与 [下一步建议]。',
    '- [核心产出] 必须自包含：选定的方向、关键取舍与理由写进这一节，让不读过程的人也能完整获得结论。',
    '- 发言中有需要用户拍板的分歧时，在结尾单列一行 [建议决策]：<问题> | 选项：<A>/<B>/… | 推荐：<X> 理由：<一句话>；主持人据此触发人类决策。',
    '- 单一出口：专家的汇报只进会议记录（roundtable_speak），对用户的输出一律由主持人整轮收敛后统一汇总，专家不直接对用户播报。',
    '- 严禁输出"好的""收到"等无信息量内容。',
    '- 节点发言通过 roundtable_speak 写入会议记录，供汇聚网关与主持人查阅；定向讨论使用 to 参数。',
    '',
    '四、全局约束与安全红线',
    '- 遇到分歧或无法独自决定的事项，立即建议主持人触发 [需人类决策]，严禁自行替用户拍板。',
    '- 严禁编造不存在的 API、数据或事实；不确定时明确说明。',
    '- 超预算（轮数/Token）时会议将自动闭麦暂停。',
    ...redteamRules,
  ].join('\n')
}
