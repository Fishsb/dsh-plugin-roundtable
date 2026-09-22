/**
 * 会议设置确认卡片（R1）：草案数据结构 + 卡片 Markdown 渲染 + 答案解析。
 *
 * 原生 `ctx.userQuestions` 没有表单能力（只有选项列表 + 一个自由文本
 * `custom`），所以"可改全部"是通过 `custom` 自由文本 + 回流重建实现的，
 * 而不是富表单。本模块只负责把一份草案渲染成**可读**的 Markdown，并把
 * 用户的回答解析成三态：approved / revise / unavailable。
 *
 * @module dsh-plugin-roundtable/plan
 */

import type { MeetingBoundary, SkillDelivery } from './types.ts'

/** skill 的两种传递方式（D5）。单一来源：types.ts。 */
export type { SkillDelivery }

/** 卡片上"按此创建"选项的固定标签；`intent.approve` 必须与它逐字一致。 */
export const PLAN_APPROVE_LABEL = '按此创建'

/** 卡片上的次选项：用户想改点什么。 */
export const PLAN_REVISE_LABEL = '我要修改'

/**
 * 一张设置卡片所描述的会议草案（尚未创建）。
 *
 * 字段与 `roundtable_create` 的入参一一对应，外加 `skills` / `skillDelivery`，
 * 这样用户确认后主持人可以**原样**按草案创建会议，不再自行拍参数。
 */
export interface MeetingDraft {
  /** 会议名称（同时作为会议 id 的稳定来源）。 */
  name: string
  /** 会议背景与核心目标（总纲第一节）。 */
  goal: string
  /** 协作模式。 */
  mode: 'orchestrated' | 'egalitarian' | 'redteam'
  /** 轮数上限，超限闭麦。 */
  maxRounds: number
  /** Token 预算上限，超限闭麦。 */
  maxTokens: number
  /** 知识库目录（可空）：主持人按需读取其中文件转交专家。 */
  kbPath: string
  /**
   * 会议边界声明（2026-09-23 · 用户全流程要求）。
   * 缺省 = 主持人未声明 ⇒ 卡片会显式警示「边界未声明」，并提示先问用户。
   */
  boundary?: MeetingBoundary
  /** 用户**未加工的原始指令**（2026-09-23）：卡片上原样回显，让用户核对有无被转述歪。 */
  userDirective?: string
  /** 本次会议选中的 skill 名称清单（可为空）。 */
  skills: string[]
  /** skill 传递方式：relay=主持人中转；direct=专家自行调用。 */
  skillDelivery: SkillDelivery
}

/** 卡片选项的两态解析结果。 */
export type PlanConfirmation =
  | { kind: 'approved' }
  | { kind: 'revise'; note: string }
  /** 服务缺失或用户没给任何选择：主持人应把它当作"再确认一次"。 */
  | { kind: 'unavailable'; note: string }

/** 一行 `键：值`，值为空时显示占位符。 */
function line(label: string, value: string, empty = '（未设置）'): string {
  return `- **${label}**：${value.trim() === '' ? empty : value.trim()}`
}

/** 可选 skill 清单在卡片上最多列出的条数（超出只给数量）。 */
const SKILL_LIST_LIMIT = 12

/** 清单里的一条 skill：只要名字与描述这两个字段。 */
export interface SkillListEntry {
  readonly name: string
  readonly description?: string
}

/**
 * 把一份草案渲染成卡片正文（Markdown）。
 *
 * 这里是"让用户看懂将要创建什么"的唯一位置：每一项参数都显示当前值，
 * 专家逐个列出 key / 角色 / 路由，并把**当前可选**的 skill 清单也列出来
 * （用户要在「我要修改」的自由文本里增删 skill，就得先看得到名字）。
 * 禁止在其中塞伪交互说明。
 */
export function formatMeetingDraft(
  draft: MeetingDraft,
  experts: readonly { key: string; role?: string; provider?: string; model?: string; preset?: string; unresolved?: string; reasoningEffort?: string }[],
  options: { revised?: boolean; availableSkills?: readonly SkillListEntry[] } = {},
): string {
  const modeLabel = draft.mode === 'orchestrated'
    ? 'orchestrated（主持人统筹，一切经由主持人转达）'
    : draft.mode === 'egalitarian'
      ? 'egalitarian（多模型平等，专家互相直达，超预算闭麦）'
      : 'redteam（针锋相对，专家只挑已定稿方案的毛病）'
  const roster = experts.length === 0
    ? '（暂无专家——建议至少 1 位）'
    : experts.map((expert, index) => {
        const role = expert.role !== undefined && expert.role.trim() !== '' ? expert.role.trim() : '（未填角色）'
        const route = expert.provider !== undefined && expert.provider !== '' && expert.model !== undefined && expert.model !== ''
          ? `${expert.provider}/${expert.model}`
          : '继承主持人当前 provider/model'
        // R-A：卡片须让人看出这条专家是「用户预设」还是「主持人临时写的角色」，
        // 以及预设引用是否解析成功——引用失败不静默。
        const origin = expert.unresolved !== undefined
          ? `  ⚠ 预设 \`${expert.unresolved}\` 未找到（将按临时角色走；可用 roundtable_list_presets 查 id）`
          : expert.preset !== undefined
            ? `  ← 来自预设 \`${expert.preset}\``
            : ''
        /*
         * 档位可见性（2026-09-23 审计 · 预设闭环缺口）：
         * `add_node` / `list_presets` / `status` 三处都带 reasoningEffort，**唯独设置卡没有**
         * ⇒ 用户在确认「按此创建」时看不到专家将跑在什么强度上，而预设自带的档位
         * （`reasoningEffort`）会经 add_node 静默生效。确认一份看不到实际参数的卡片
         * 就是假确认——故此处补上（空 = 继承主持人，显式写出而非留白）。
         */
        const effort = expert.reasoningEffort !== undefined && expert.reasoningEffort.trim() !== ''
          ? ` @${expert.reasoningEffort.trim()}`
          : ' @继承'
        return `${index + 1}. \`${expert.key}\` — ${role} — ${route}${effort}${origin}`
      }).join('\n')
  const skills = draft.skills.length === 0
    ? '（未选）'
    : draft.skills.map((skill) => `\`${skill}\``).join('、')
  const deliveryLabel = draft.skillDelivery === 'relay'
    ? 'relay（主持人中转：主持人读正文后按需转交，省 token、行为可预测）'
    : 'direct（专家直接调用：专家自己用 `skill` 工具加载，更自主、各自读取）'
  const boundary = draft.boundary
  return [
    `# 会议设置确认 · ${draft.name.trim() === '' ? '（未命名）' : draft.name.trim()}`,
    '',
    options.revised === true
      ? '> 已按你的意见更新草案，请再确认一次；还有出入就再选「我要修改」。'
      : '> 以下是主持人推导的会议草案。**确认后才会真正创建会议。**',
    '',
    '## 会议参数',
    line('会议名称', draft.name, '（未命名）'),
    line('协作模式', modeLabel),
    line('轮数上限', `${draft.maxRounds} 轮（超限自动闭麦）`),
    line('Token 预算', `${draft.maxTokens} tokens（超限自动闭麦）`),
    line('知识库', draft.kbPath, '（未设置：专家需要资料时由主持人按需读取转交）'),
    line('选中 skill', skills, '（未选）'),
    line('skill 传递方式', deliveryLabel),
    '',
    '## 专家名单',
    roster,
    '',
    '## 可选 skill 清单（写进「我要修改」的说明里即可增删）',
    formatAvailableSkills(options.availableSkills ?? []),
    '',
    '## 议题 / 目标',
    draft.goal.trim() === '' ? '（未提供，以主持人现场说明为准）' : draft.goal.trim(),
    '',
    /*
     * 边界确认块（2026-09-23 · 用户要求「边界不清晰或目标模糊要先和用户沟通明确，
     * 再开始后续流程」）。判因（实测 · 会话 690079f3）：主持人把用户含糊的
     * 「容量门」自行转述成一个具体定义后直接开会，**会议结束后**才澄清，
     * 付出一整轮作废的代价；主持人自认「全仓查无你的原话，只有转述」。
     *
     * 为什么落在卡片上而不是新增一个工具：卡片是用户**唯一必看**的一屏（R1 机制），
     * 零新增交互步骤、零 token 增量（卡片本来就渲染），且它正是"主持人转述 → 用户核对"
     * 的那个交接点。三项与用户自建项目治理的 doing/next/notDoing/exit 同构。
     */
    '## 边界确认（★ 请核对你原话是否被准确转述）',
    /*
     * 用户原话回显（2026-09-23 · 用户要求「绝对要避免偏离用户指令」）。
     * 位置在"边界确认"之前：**先让用户看到自己的原话**，再看主持人的转述。
     * 若逐字原话与转述并列而不同，用户一眼能发现——这是防"转述覆盖原话"最便宜的机制。
     */
    ...(draft.userDirective === undefined || draft.userDirective.trim() === ''
      ? []
      : [
          '**你的原话（逐字）**：',
          `> ${draft.userDirective.trim().split('\n').join('\n> ')}`,
          '',
        ]),
    '主持人把你的话转述成了上面这段。**若与你原意不符，请在「我要修改」里写回你的原话。**',
    ...(boundary === undefined
      ? [
          '⚠ **本次未声明边界**（目标 / 完成标准 / 明确不做 三项都没填）。',
          '  ⇒ 若你本轮的诉求本身就不明确，请先在「我要修改」里用一句话说清，**不要带着模糊目标开会**——',
          '     那正是历史上一整轮会议作废的原因。',
        ]
      : [
          `- **要解决的现象**：${boundary.goal.trim() === '' ? '⚠（未填）' : boundary.goal.trim()}`,
          `- **算解决的标准**：${boundary.done.trim() === '' ? '⚠（未填）' : boundary.done.trim()}`,
          `- **明确不做 / 不许动**：${boundary.notDoing.trim() === '' ? '⚠（未填）' : boundary.notDoing.trim()}`,
          '',
          '> 「明确不做」这一项就是**防拆东墙的判据**：会议过程中每次改动都要对照它自检',
          '> 「有没有把别处弄坏 / 有没有越界」。填不出它，说明边界还没谈清。',
        ]),
    '',
    '---',
    '选「我要修改」时，请在输入框里写清改什么（例：把 reviewer 换成 zai-coding-cn/glm-5.2、预算降到 5 轮、加上 skill `pdf-fill`）。主持人据此更新草案后**会再弹一次**这张卡片。',
  ].join('\n')
}

/** 渲染"当前可选 skill"清单（空清单给出可操作提示）。 */
function formatAvailableSkills(available: readonly SkillListEntry[]): string {
  if (available.length === 0) {
    return '（本机当前没有可选 skill：把 skill 放进 `<工作区>/.dsh/skills/`、`<工作区>/.agents/skills/` 或 `<DSH_HOME>/skills/` 即会出现）'
  }
  const lines = available.slice(0, SKILL_LIST_LIMIT).map((skill) => {
    const description = skill.description === undefined || skill.description.trim() === '' ? '' : ` — ${skill.description.trim()}`
    return `  - \`${skill.name}\`${description}`
  })
  if (available.length > SKILL_LIST_LIMIT) {
    lines.push(`  - …另有 ${available.length - SKILL_LIST_LIMIT} 个`)
  }
  return lines.join('\n')
}

/**
 * 解析用户的卡片回答。
 *
 * 协议与 `intent.kind: 'plan-review'` 的语义一致：`selected` 含
 * `PLAN_APPROVE_LABEL` 即视为批准，其余选项（或只有 custom 文本）视为
 * 要求修改。不识别 intent 的 UI 会退回普通选项列表，答复编码完全相同。
 */
export function resolvePlanConfirmation(
  answer: { selected: string[]; custom?: string } | undefined,
  approveLabel: string = PLAN_APPROVE_LABEL,
): PlanConfirmation {
  if (answer === undefined) return { kind: 'unavailable', note: '' }
  const selected = Array.isArray(answer.selected) ? answer.selected : []
  const note = answer.custom === undefined ? '' : answer.custom.trim()
  if (selected.includes(approveLabel)) return { kind: 'approved' }
  if (note !== '') return { kind: 'revise', note }
  return { kind: 'unavailable', note: '' }
}
