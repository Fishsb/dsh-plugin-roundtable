/**
 * Locale dictionaries for the RoundTable browser UI.
 * @module dsh-plugin-roundtable/client/locales
 */

export const NS = 'roundtable'

export type RoundTableKey =
  | 'tab'
  | 'empty'
  | 'emptyHint'
  | 'meeting'
  | 'mode'
  | 'modeOrchestrated'
  | 'modeEgalitarian'
  | 'modeRedteam'
  | 'status'
  | 'round'
  | 'roundsBudget'
  | 'tokensBudget'
  | 'pendingDecision'
  | 'pendingDecisionOptions'
  | 'pendingDecisionHint'
  | 'manageEffectiveHint'
  | 'manageActionsApplied'
  | 'meetingDeleteDetail'
  | 'tokensBudgetHint'
  | 'gatewayDigest'
  | 'noDigest'
  | 'edgeSetForward'
  | 'edgeSetBidirectional'
  | 'edgeRemove'
  | 'edgeScopeHint'
  | 'edgeScopeHintEgalitarian'
  | 'edgeUndeliverableHint'
  | 'edgeConnectedSingleLine'
  | 'edgeLegend'
  | 'edgeConnected'
  | 'portConnect'
  | 'activityRunning'
  | 'activityIdle'
  | 'activityReady'
  | 'activityRemoved'
  | 'settingsNav'
  | 'settingsDefaultMode'
  | 'settingsDefaultModeHint'
  | 'settingsEgalitarianWarning'
  | 'settingsMaxRounds'
  | 'settingsMaxTokens'
  | 'settingsSave'
  | 'settingsSaved'
  | 'settingsLoadFailed'
  | 'settingsSaveFailed'
  | 'fetchFailed'
  | 'meetingSelect'
  | 'agents'
  | 'kb'
  | 'dispatch'
  | 'dispatchNoPlan'
  | 'dispatchUnparsable'
  | 'dispatchWave'
  | 'dispatchWaveParallel'
  | 'dispatchWaveWait'
  | 'dispatchGap'
  | 'dispatchGapOnStage'
  | 'dispatchUnplanned'
  | 'dispatchUndispatched'
  | 'dispatchOutOfScope'
  | 'dispatchPoolTitle'
  | 'dispatchPoolHint'
  | 'dispatchPoolNone'
  | 'dispatchPoolOnStage'
  | 'dispatchPoolAdHoc'
  | 'dispatchPlanNote'
  | 'activity'
  | 'kbEmpty'
  | 'noActivity'
  | 'editAgents'
  | 'editKb'
  | 'kbTitle'
  | 'kbPathLabel'
  | 'kbPathPlaceholder'
  | 'kbPathRequired'
  | 'kbSave'
  | 'kbSaved'
  | 'kbSaveFailed'
  | 'kbFiles'
  | 'kbLoadHint'
  | 'kbChanged'
  | 'kbBrowseHint'
  | 'kbNotSet'
  | 'meetingDelete'
  | 'meetingDeleteConfirm'
  | 'settingsShowAll'
  | 'settingsShowAllHint'
  | 'settingsShowAllOn'
  | 'settingsShowAllOff'
  | 'settingsLimitsTitle'
  | 'settingsSkillTitle'
  | 'settingsSkillDelivery'
  | 'settingsSkillDeliveryRelay'
  | 'settingsSkillDeliveryDirect'
  | 'settingsSkillDeliveryRelayHint'
  | 'settingsSkillDeliveryDirectHint'
  | 'skillsTitle'
  | 'skillsEmpty'
  | 'skillsDeliveryRelay'
  | 'skillsDeliveryDirect'
  | 'settingsPanelsTitle'
  | 'settingsPanelsHint'
  | 'panelOn'
  | 'panelOff'
  | 'settingsExpertMaxTokens'
  | 'settingsExpertMaxTokensHint'
  | 'settingsExpertMaxOpinions'
  | 'settingsExpertMaxOpinionsHint'
  | 'feedbackTitle'
  | 'feedbackEnabled'
  | 'feedbackEnabledHint'
  | 'feedbackPrivacyNote'
  | 'feedbackListEmpty'
  | 'feedbackListTitle'
  | 'feedbackClear'
  | 'feedbackCleared'
  | 'feedbackLoadFailed'
  | 'feedbackEntryMeta'
  | 'feedbackAskTitle'
  | 'feedbackAskGood'
  | 'feedbackAskMeh'
  | 'feedbackAskBad'
  | 'feedbackAskNotePlaceholder'
  | 'feedbackAskSkip'
  | 'feedbackAskSubmitted'
  | 'feedbackAskFailed'
  | 'pendingBadge'
  | 'usageButton'
  | 'usageNote'
  | 'usageUnavailable'
  | 'usageDormant'
  | 'usageFailed'
  | 'manageTitle'
  | 'managePendingNote'
  | 'manageExisting'
  | 'manageRemove'
  | 'manageRemoveConfirm'
  | 'manageRemovedSoon'
  | 'manageQueueFailed'
  | 'managePendingRemove'
  | 'managePendingAdd'
  | 'managePendingAddRole'
  | 'manageAddTitle'
  | 'manageName'
  | 'manageNamePlaceholder'
  | 'manageNameRequired'
  | 'manageNameTaken'
  | 'manageRole'
  | 'manageRolePlaceholder'
  | 'manageModel'
  | 'manageModelInherit'
  | 'manageAddBtn'
  | 'manageAddedSoon'
  | 'manageClose'
  | 'manageNoExperts'
  | 'reviewTitle'
  | 'reviewQuestion'
  | 'reviewPlan'
  | 'reviewViewpoints'
  | 'reviewEmpty'
  | 'reviewSupport'
  | 'reviewSupported'
  | 'reviewSupportedToast'
  | 'reviewEndorsed'
  | 'reviewEndorseFailed'
  | 'reviewHint'
  | 'reviewClose'
  | 'reviewBadge'
  | 'reviewOpen'
  | 'reviewStatusReviewing'
  | 'reviewStatusDone'
  | 'reviewPending'
  | 'reviewRejected'
  | 'reviewReject'
  | 'reviewRejectedDone'
  | 'reviewRejectedToast'
  | 'reviewPendingToast'
  | 'reviewRejectReasonPrompt'
  | 'reviewRejectReasonPlaceholder'
  | 'reviewRejectReasonRequired'
  | 'reviewRejectConfirm'
  | 'reviewRejectCancel'
  | 'reviewEvidenceRepro'
  | 'reviewEvidenceArgument'
  | 'reviewPassBadge'
  | 'reviewImpactTitle'
  | 'reviewImpactThresholdHint'
  | 'reviewImpactOk'
  | 'reviewExportHint'
  | 'settingsPresetsTitle'
  | 'settingsPresetSetDefault'
  | 'settingsPresetClearDefault'
  | 'settingsPresetDefaultBadge'
  | 'settingsPresetsHint'
  | 'settingsPresetsEmpty'
  | 'settingsPresetName'
  | 'settingsPresetNamePlaceholder'
  | 'settingsPresetRole'
  | 'settingsPresetRolePlaceholder'
  | 'settingsPresetModel'
  | 'settingsPresetAdd'
  | 'settingsPresetEdit'
  | 'settingsPresetSave'
  | 'settingsPresetCancel'
  | 'settingsPresetDelete'
  | 'settingsPresetInvalid'
  | 'settingsPresetLimit'
  | 'settingsPresetUpdated'
  | 'settingsPresetEffortTitle'
  | 'settingsPresetEffortInheritHint'
  | 'settingsPresetEffortUnavailable'
  | 'settingsPresetEffortOnlyNew'
  | 'managePresetLabel'
  | 'managePresetPlaceholder'
  | 'managePresetEmpty'
  | 'modeOn'
  | 'modeOff'
  | 'modeViaCommand'
  | 'modeOnHint'
  | 'modeOffHint'
  | 'viewTopology'
  | 'viewChat'
  | 'chatMembers'
  | 'chatEmpty'
  | 'chatEmptyHint'
  | 'chatInputPlaceholder'
  | 'chatSend'
  | 'chatSending'
  | 'chatSendFailed'
  | 'chatLoadFailed'
  | 'chatLoading'
  | 'chatYou'
  | 'chatTruncated'
  | 'chatToday'
  | 'chatRoundDivider'
  | 'chatToGateway'
  | 'chatToSeat'
  | 'emptyInputPlaceholder'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The roundtable topology tab + settings page copy. */
    roundtable: RoundTableKey
  }
}

export const zh: Record<RoundTableKey, string> = {
  tab: '圆桌会议',
  empty: '当前工作区还没有圆桌会议',
  emptyHint: '在下面的输入框里说一句议题，主持人就会拉起一支专家队伍并出现在这里；也可以回到聊天说「开个圆桌会议讨论……」。历史会议会一直保留在这个 Tab 里，随时可以切换查看。',
  meeting: '会议',
  mode: '协作模式',
  modeOrchestrated: '主持人统筹',
  modeEgalitarian: '多模型平等',
  modeRedteam: '针锋相对',
  status: '状态',
  round: '轮',
  roundsBudget: '轮数',
  tokensBudget: 'Token',
  pendingDecision: '待人类决策',
  pendingDecisionOptions: '选项',
  pendingDecisionHint: '请回到本对话的聊天窗口，在选项卡片里点一个选项回答；答完后这里会自动消失。',
  manageActionsApplied: '已生效：主持人执行了待办里的专家改动。',
  meetingDeleteDetail: '会议记录、针锋相对评审记录与导出文件（export.md）会一起删除，无法恢复。想留档请先回聊天窗口说「导出这场会议」。',
  tokensBudgetHint: '按发言文本估算，不含系统提示词与工具开销',
  gatewayDigest: '汇聚网关 · 结构化摘要',
  noDigest: '（暂无发言）',
  edgeSetForward: '设为单向通道',
  edgeSetBidirectional: '设为双向通道',
  edgeRemove: '删除连线',
  edgeScopeHint: '这条线只表示主持人按此顺序转达。专家之间互不相识，收不到彼此的消息；跨专家讨论一律由主持人代转。',
  edgeScopeHintEgalitarian: '圆桌制（多模型平等）：专家互相看得见，可以直接给对方派活并抄送主持人 —— 这里的连线就是真实可用的对话通道。',
  edgeUndeliverableHint: '单线制：这条连线不改变通信权限，只表示主持人按此顺序转达。',
  edgeConnectedSingleLine: '已连接 {from} → {to}（单线制：此连线不表示专家之间能直接通话，只表示转达顺序）',
  edgeLegend: '连线含义',
  edgeConnected: '已连上 {from} → {to}（线只表示主持人照此转达）',
  portConnect: '从此端口拖出连线',
  activityRunning: '工作中',
  activityIdle: '空闲',
  activityReady: '待唤醒',
  activityRemoved: '已退出',
  settingsNav: '圆桌会议',
  settingsDefaultMode: '默认协作模式',
  settingsDefaultModeHint: '主持人统筹：一切经由主持人转达；多模型平等：专家互相直达辩论，超预算自动闭麦（选择它会弹出安全限制）。',
  settingsEgalitarianWarning: '已选择「多模型平等」：专家互相直达、无主持人中转，请务必设置足够的轮数/Token 上限，超限将自动闭麦。',
  settingsMaxRounds: '默认最大轮数',
  settingsMaxTokens: '默认 Token 预算',
  settingsSave: '保存',
  settingsSaved: '已保存',
  settingsLoadFailed: '读取设置失败',
  settingsSaveFailed: '保存设置失败',
  fetchFailed: '拉取会议状态失败，正在重试…',
  meetingSelect: '切换会议',
  agents: '专家',
  dispatch: '调度',
  dispatchNoPlan: '本轮未记录调度计划 —— 未做并行/串行分析（主持人应在派单前用 roundtable_next_round 交计划）。',
  dispatchUnparsable: '本轮落账的计划无法解析（可能是旧版本写入或被手工改动）—— 不画波次图，请主持人重新交一份计划。',
  dispatchWave: '第 {n} 波',
  dispatchWaveParallel: '立刻并发下发',
  dispatchWaveWait: '等第 {n} 波完成',
  dispatchGap: '需新拉席位',
  dispatchGapOnStage: '该预设已在场',
  dispatchUnplanned: '计划外派发',
  dispatchUndispatched: '计划点名但本轮未派发',
  dispatchOutOfScope: '越界转派（该换人）',
  dispatchPoolTitle: '专家候选池',
  dispatchPoolHint: '预设清单在「设置 → 圆桌会议 → 角色预设」维护；会议中途可用它拉人。',
  dispatchPoolNone: '尚未定义任何角色预设（列表空着，等你自己建）。',
  dispatchPoolOnStage: '在场',
  dispatchPoolAdHoc: '临时角色',
  dispatchPlanNote: '本轮意图',
  kb: '知识库',
  activity: '发言记录',
  kbEmpty: '该文件夹内暂无文件',
  noActivity: '（暂无发言）',
  editAgents: '新增 / 修改专家',
  editKb: '知识库管理',
  kbTitle: '知识库阅览',
  kbPathLabel: '路径',
  kbPathPlaceholder: '输入电脑上的文件夹路径（支持相对工作区路径）',
  kbPathRequired: '请输入知识库路径',
  kbSave: '保存并阅览',
  kbSaved: '知识库路径已保存，已记录待主持人同步',
  kbSaveFailed: '保存知识库路径失败',
  kbFiles: '文件列表',
  kbLoadHint: '输入路径并保存后，这里会显示文件夹内的文件列表',
  kbChanged: '内容已变更',
  kbBrowseHint: '仅供阅览：点击文件无反应；专家需要内容时由主持人读取并转交。',
  kbNotSet: '未设置知识库路径',
  meetingDelete: '删除会议',
  meetingDeleteConfirm: '确定删除会议「{name}」？此操作不可恢复（会议文件将被永久删除）。',
  settingsShowAll: '互通（跨对话查看会议）',
  settingsShowAllHint: '开启：查看所有对话开启的圆桌会议；关闭：仅查看当前对话开启的圆桌会议。',
  settingsShowAllOn: '开启',
  settingsShowAllOff: '关闭',
  settingsLimitsTitle: '回答限制（省 token）',
  settingsSkillTitle: 'Skill（DSH 原生能力）',
  settingsSkillDelivery: 'skill 传递方式',
  settingsSkillDeliveryRelay: '主持人中转',
  settingsSkillDeliveryDirect: '专家直接调用',
  settingsSkillDeliveryRelayHint: '主持人读取 skill 正文后按需转交专家：省 token、行为可预测。',
  settingsSkillDeliveryDirectHint: '专家自己用 skill 工具加载：更自主，但每个专家都会各自读取一遍。',
  skillsTitle: '已选 skill',
  skillsEmpty: '本次会议未选 skill',
  skillsDeliveryRelay: '传递方式：主持人中转',
  skillsDeliveryDirect: '传递方式：专家直接调用',
  settingsPanelsTitle: '右栏面板显示',
  settingsPanelsHint: '点亮的圆圈 = 在「圆桌会议」页右栏显示该面板；暗掉的即隐藏（保存后立即生效）。',
  panelOn: '显示',
  panelOff: '隐藏',
  settingsExpertMaxTokens: '专家每轮输出上限（token）',
  settingsExpertMaxTokensHint: '每次专家调用模型的输出 token 上限（max_tokens）；0 = 不限制（用模型默认）。',
  settingsExpertMaxOpinions: '专家每轮最多意见数',
  settingsExpertMaxOpinionsHint: '每轮最多提出的意见条数（提示词约束）；0 = 不限制。',
  pendingBadge: '{n} 条操作待下一轮生效',
  usageButton: '查看逐节点用量',
  usageNote: 'provider 上报值；s = 该席 agent 累计耗时（~ 进行中）；预算条是本地字符估算，口径不同',
  usageUnavailable: '无法取 provider 值：宿主未挂 session-projection',
  usageDormant: '该席当前无活会话（会议暂停或未唤醒）；数字仍在它的会话里，唤醒后可读',
  usageFailed: '用量读取失败',
  manageTitle: '专家管理',
  managePendingNote: '以下操作已记录，主持人将在下一轮对话中逐条执行；执行失败会保留记录。',
  manageExisting: '现有专家',
  manageRemove: '删除',
  manageRemoveConfirm: '确定删除专家「{name}」？会议状态将在主持人下一轮执行时更新。',
  manageRemovedSoon: '已记录：专家 {name} 将在下一轮移除',
  manageQueueFailed: '记录操作失败',
  managePendingRemove: '待移除',
  managePendingAdd: '待生效',
  managePendingAddRole: '新增专家 · 待主持人拉入',
  manageAddTitle: '新增专家',
  manageName: '名称',
  manageNamePlaceholder: '如 researcher（唯一标识）',
  manageNameRequired: '请输入专家名称',
  manageNameTaken: '专家 {name} 已存在',
  manageRole: '角色',
  manageRolePlaceholder: '如 安全审查',
  manageModel: '模型',
  manageModelInherit: '（继承主持人默认）',
  manageAddBtn: '加入队列',
  manageAddedSoon: '已记录：专家 {name} 将在下一轮加入',
  manageEffectiveHint: '改动会记下来，主持人下次回话时才真正生效。想立刻生效，回到聊天窗口发一句「继续」即可。',
  manageClose: '关闭',
  manageNoExperts: '暂无专家，可通过下方表单新增',
  reviewTitle: '针锋相对 · 方案评审',
  reviewQuestion: '用户提出的问题',
  reviewPlan: '主持人提供的方案与说明',
  reviewViewpoints: '专家挑刺观点',
  reviewEmpty: '（暂无观点，评审还在进行中）',
  reviewSupport: '支持（认定为缺陷）',
  reviewSupported: '已认定',
  reviewSupportedToast: '已认定该缺陷，将进入后续方案修改',
  reviewEndorsed: '已认定为缺陷',
  reviewEndorseFailed: '标记失败',
  reviewHint: '点击「支持」= 认定该缺陷真实存在，将进入后续方案修改。',
  reviewClose: '关闭',
  reviewBadge: '针锋相对',
  reviewOpen: '打开评审',
  reviewStatusReviewing: '评审中',
  reviewStatusDone: '已完成',
  reviewPending: '待审/未表态',
  reviewRejected: '已驳回',
  reviewReject: '驳回',
  reviewRejectedDone: '已驳回',
  reviewRejectedToast: '已驳回该观点（审阅后否定）',
  reviewPendingToast: '已取消标记',
  reviewRejectReasonPrompt: '驳回需填写理由（必填，将计入评审记录）：',
  reviewRejectReasonPlaceholder: '例如：该缺陷基于误解，方案已覆盖此场景…',
  reviewRejectReasonRequired: '请填写驳回理由后再确认',
  reviewRejectConfirm: '确认驳回',
  reviewRejectCancel: '取消',
  reviewEvidenceRepro: '可复现步骤',
  reviewEvidenceArgument: '论证链',
  reviewPassBadge: '第 {pass}/{max} 轮评审',
  reviewImpactTitle: '影响概览',
  reviewImpactThresholdHint: '已认定缺陷较多，建议据此重新协商方案后再修订。',
  reviewImpactOk: '已认定缺陷已记录，可按此修订方案。',
  reviewExportHint: '导出完整评审记录（Markdown）请在对话中让主持人调用导出。',
  feedbackTitle: '用户反馈',
  feedbackEnabled: '会议结束后询问轻量反馈',
  feedbackEnabledHint: '开启：会议结束（评审关闭）后弹一次 1 键有用度询问；可随时在此关闭。',
  feedbackPrivacyNote: '隐私边界：仅记录协作模式、专家 provider/模型、轮数/Token 用量、时间戳与可选一句说明；绝不记录对话内容。文件为工作区级 feedback.jsonl（建议加入 .gitignore），可一键清空。',
  feedbackListEmpty: '（暂无已收集的反馈）',
  feedbackListTitle: '已收集的反馈',
  feedbackClear: '清空全部反馈',
  feedbackCleared: '已清空反馈',
  feedbackLoadFailed: '读取反馈失败',
  feedbackEntryMeta: '{date} · {mode} · {providers} · {rounds} 轮 / {tokens} token · {rating}',
  feedbackAskTitle: '这场会议对你有帮助吗？（1 键，匿名，可在设置里关闭）',
  feedbackAskGood: '有帮助',
  feedbackAskMeh: '一般',
  feedbackAskBad: '没帮助',
  feedbackAskNotePlaceholder: '最卡的点是什么？（可选）',
  feedbackAskSkip: '跳过',
  feedbackAskSubmitted: '谢谢反馈！可随时在设置 → 圆桌会议 → 用户反馈中关闭或清空。',
  feedbackAskFailed: '反馈提交失败',
  settingsPresetsTitle: '角色预设',
  settingsPresetSetDefault: '设为缺省',
  settingsPresetClearDefault: '取消缺省',
  settingsPresetDefaultBadge: '缺省',
  settingsPresetsHint: '自己建几个常用角色，之后在会议的「专家管理」里选中即可自动填好角色说明与模型，不必每次手打。预设是全局偏好，改动不会影响已经创建的会议；插件不预置任何内置角色。',
  settingsPresetsEmpty: '还没有预设。填下面两个必填项就能建第一条。',
  settingsPresetName: '预设名称',
  settingsPresetNamePlaceholder: '例：安全审查',
  settingsPresetRole: '角色说明',
  settingsPresetRolePlaceholder: '例：从安全视角挑毛病，只报可利用的风险与复现路径',
  settingsPresetModel: '模型（可空 = 继承主持人）',
  settingsPresetAdd: '新建预设',
  settingsPresetEdit: '编辑',
  settingsPresetSave: '保存预设',
  settingsPresetCancel: '取消',
  settingsPresetDelete: '删除',
  settingsPresetInvalid: '预设名称与角色说明都不能为空',
  settingsPresetLimit: '预设数量已达上限（{max} 条），请先删除不用的',
  settingsPresetUpdated: '预设已更新',
  settingsPresetEffortTitle: '思考强度',
  settingsPresetEffortInheritHint: '选「继承」= 跟随主持人；改了只影响之后新加入的专家。',
  settingsPresetEffortUnavailable: '当前模型未提供推理等级。',
  settingsPresetEffortOnlyNew: '只影响之后新加入的专家，已在场的专家不变。',
  managePresetLabel: '角色预设',
  managePresetPlaceholder: '选择预设自动填充',
  managePresetEmpty: '还没有预设：去「设置 → 圆桌会议 → 角色预设」新建一个。',
  modeOn: '讨论模式 · 开',
  modeOff: '讨论模式 · 关',
  modeViaCommand: '（命令开启）',
  modeOnHint: '本会话已处于圆桌讨论模式：在这里发的每条消息都按圆桌会议处理（先出设置卡）。关闭用聊天框里的 /roundtable off。',
  modeOffHint: '本会话未处于圆桌讨论模式：把「圆桌会议」tab 打开即可自动开启，或在聊天框敲 /roundtable 手动开启。',
  viewTopology: '拓扑',
  viewChat: '群聊',
  chatMembers: '{n} 位成员',
  chatEmpty: '群里还没有发言',
  chatEmptyHint: '会议开始后，主持人与专家的发言会实时出现在这里。',
  chatInputPlaceholder: '以主持人身份说一句…（Enter 发送，Shift+Enter 换行）',
  chatSend: '发送',
  chatSending: '发送中…',
  chatSendFailed: '发送失败：{msg}',
  chatLoadFailed: '群聊记录加载失败：{msg}',
  chatLoading: '正在加载群聊记录…',
  chatYou: '我',
  chatTruncated: '仅显示最近 {n} 条；更早的发言未载入。',
  chatToday: '今天',
  chatRoundDivider: '第 {n} 轮',
  chatToGateway: '→ 汇聚网关',
  chatToSeat: '→ {to}',
  emptyInputPlaceholder: '说一句话，主持人就来开局…（Enter 发送）',
}

export const en: Record<RoundTableKey, string> = {
  tab: 'RoundTable',
  empty: 'No round-table meeting in this workspace yet',
  emptyHint: 'Type a topic in the box below and the captain will assemble a team of experts right here — or go back to chat and say "start a round-table meeting to discuss…". Past meetings stay in this tab and can be switched back to anytime.',
  meeting: 'Meeting',
  mode: 'Mode',
  modeOrchestrated: 'Orchestrated',
  modeEgalitarian: 'Egalitarian',
  modeRedteam: 'Adversarial review',
  status: 'Status',
  round: 'Round',
  roundsBudget: 'Rounds',
  tokensBudget: 'Tokens',
  pendingDecision: 'Awaiting human decision',
  pendingDecisionOptions: 'Options',
  pendingDecisionHint: "Answer it in this conversation's chat window — pick an option on the card; this banner disappears once you answer.",
  manageActionsApplied: "Done: the captain applied your pending expert changes.",
  meetingDeleteDetail: 'Its transcript, review record and export.md are removed for good. To keep a copy, first say “export this meeting” in the chat window.',
  tokensBudgetHint: 'Estimated from spoken text only — excludes system prompt and tool overhead',
  gatewayDigest: 'Aggregation gateway · structured digest',
  noDigest: '(no contributions yet)',
  edgeSetForward: 'Set forward',
  edgeSetBidirectional: 'Set bidirectional',
  edgeRemove: 'Remove edge',
  edgeScopeHint: "This line only shows how the captain passes things along. The experts don't know about each other and never receive each other's messages — the captain relays everything.",
  edgeScopeHintEgalitarian: 'Round-table (egalitarian): experts see each other and may task each other directly, cc-ing the captain — the lines here are real messaging channels.',
  edgeUndeliverableHint: 'Single-line mode: this edge grants no messaging right — it only shows the captain’s relay order.',
  edgeConnectedSingleLine: 'Connected {from} → {to} (single-line mode: this edge does not mean the experts can talk directly; it shows relay order)',
  edgeLegend: 'What a line means',
  edgeConnected: 'Connected {from} → {to} (the line only means the captain relays this way)',
  portConnect: 'Drag from this port to connect',
  activityRunning: 'working',
  activityIdle: 'idle',
  activityReady: 'ready',
  activityRemoved: 'removed',
  settingsNav: 'RoundTable',
  settingsDefaultMode: 'Default collaboration mode',
  settingsDefaultModeHint: 'Orchestrated: the captain relays everything. Egalitarian: experts debate each other directly and the budget mutes the meeting when exceeded (a warning asks for safety limits).',
  settingsEgalitarianWarning: 'Egalitarian selected: experts talk to each other directly with no captain relay — set generous round/token caps; exceeding them mutes the meeting.',
  settingsMaxRounds: 'Default max rounds',
  settingsMaxTokens: 'Default token budget',
  settingsSave: 'Save',
  settingsSaved: 'Saved',
  settingsLoadFailed: 'Failed to load preferences',
  settingsSaveFailed: 'Failed to save preferences',
  fetchFailed: 'Failed to fetch meeting state, retrying…',
  meetingSelect: 'Switch meeting',
  agents: 'Agents',
  dispatch: 'Dispatch',
  dispatchNoPlan: 'No dispatch plan for this round — no parallel/serial analysis (the captain should pass one to roundtable_next_round before dispatching).',
  dispatchUnparsable: 'This round\'s recorded plan cannot be parsed (written by an older version or hand-edited) — no wave chart is drawn; ask the captain to re-submit a plan.',
  dispatchWave: 'Wave {n}',
  dispatchWaveParallel: 'dispatch now, in parallel',
  dispatchWaveWait: 'after wave {n}',
  dispatchGap: 'needs a new seat',
  dispatchGapOnStage: 'already on stage',
  dispatchUnplanned: 'Dispatched but not planned',
  dispatchUndispatched: 'Planned but not dispatched this round',
  dispatchOutOfScope: 'Out-of-scope handoffs (needs a different seat)',
  dispatchPoolTitle: 'Talent pool',
  dispatchPoolHint: 'The preset catalogue lives in Settings → RoundTable → Role presets; pull one mid-meeting from here.',
  dispatchPoolNone: 'No role presets defined yet (the list stays empty until you create one).',
  dispatchPoolOnStage: 'on stage',
  dispatchPoolAdHoc: 'ad-hoc role',
  dispatchPlanNote: 'Round intent',
  kb: 'Knowledge base',
  activity: 'Activity',
  kbEmpty: 'No files in this folder yet',
  noActivity: '(no contributions yet)',
  editAgents: 'Add or edit agents',
  editKb: 'Manage knowledge base',
  kbTitle: 'Knowledge base (browse)',
  kbPathLabel: 'Path',
  kbPathPlaceholder: 'A folder on this computer (relative paths resolve against the workspace)',
  kbPathRequired: 'Please enter a knowledge-base path',
  kbSave: 'Save & browse',
  kbSaved: 'Knowledge-base path saved; change recorded for the captain',
  kbSaveFailed: 'Failed to save the knowledge-base path',
  kbFiles: 'Files',
  kbLoadHint: 'Enter a path and save to see the file list here',
  kbChanged: 'changed since last read',
  kbBrowseHint: 'Browse-only: clicking a file does nothing; the captain reads and relays content to experts when needed.',
  kbNotSet: 'No knowledge-base path set',
  meetingDelete: 'Delete meeting',
  meetingDeleteConfirm: 'Delete meeting "{name}"? This cannot be undone (the meeting files will be permanently removed).',
  settingsShowAll: 'Show meetings across conversations',
  settingsShowAllHint: 'On: show every round-table meeting. Off: only meetings started by this conversation.',
  settingsShowAllOn: 'On',
  settingsShowAllOff: 'Off',
  settingsLimitsTitle: 'Answer limits (save tokens)',
  settingsSkillTitle: 'Skills (DSH native)',
  settingsSkillDelivery: 'Skill delivery',
  settingsSkillDeliveryRelay: 'Captain relays',
  settingsSkillDeliveryDirect: "Experts load it themselves",
  settingsSkillDeliveryRelayHint: 'The captain reads the skill and relays what matters: fewer tokens, predictable behaviour.',
  settingsSkillDeliveryDirectHint: 'Each expert loads the skill itself with the skill tool: more autonomy, but every expert reads it separately.',
  skillsTitle: 'Selected skills',
  skillsEmpty: 'No skill selected for this meeting',
  skillsDeliveryRelay: 'Delivery: captain relays',
  skillsDeliveryDirect: 'Delivery: experts load themselves',
  settingsPanelsTitle: 'Right column panels',
  settingsPanelsHint: 'A lit circle shows that panel in the RoundTable tab; dimmed panels are hidden (takes effect after saving).',
  panelOn: 'shown',
  panelOff: 'hidden',
  settingsExpertMaxTokens: 'Expert output cap per round (tokens)',
  settingsExpertMaxTokensHint: 'max_tokens per expert model request; 0 = unlimited (provider default).',
  settingsExpertMaxOpinions: 'Max opinions per expert round',
  settingsExpertMaxOpinionsHint: 'Opinion count cap per round (prompt constraint); 0 = unlimited.',
  pendingBadge: '{n} pending action(s), effective next round',
  usageButton: "Per-node usage",
  usageNote: "Provider-reported; s = that seat's agent time (~ = turn in flight); the budget bar is a local text estimate — different measures",
  usageUnavailable: 'No provider value: the host has no session-projection mounted',
  usageDormant: 'No live session for this seat right now (meeting paused or not woken) — the numbers still live in its session and become readable once it is woken',
  usageFailed: "Failed to read usage",
  manageTitle: 'Expert management',
  managePendingNote: 'The actions below are recorded; the captain executes them one by one next round. Failed actions stay recorded.',
  manageExisting: 'Existing experts',
  manageRemove: 'Remove',
  manageRemoveConfirm: 'Remove expert "{name}"? The meeting state updates when the captain executes it next round.',
  manageRemovedSoon: 'Recorded: expert {name} will be removed next round',
  manageQueueFailed: 'Failed to record the action',
  managePendingRemove: 'pending removal',
  managePendingAdd: 'pending join',
  managePendingAddRole: 'New expert · waiting for the captain',
  manageAddTitle: 'Add expert',
  manageName: 'Name',
  manageNamePlaceholder: 'e.g. researcher (unique key)',
  manageNameRequired: 'Please enter an expert name',
  manageNameTaken: 'Expert {name} already exists',
  manageRole: 'Role',
  manageRolePlaceholder: 'e.g. security reviewer',
  manageModel: 'Model',
  manageModelInherit: '(inherit captain default)',
  manageAddBtn: 'Queue',
  manageAddedSoon: 'Recorded: expert {name} will join next round',
  manageEffectiveHint: 'Your change is recorded; it takes effect when the captain next replies. Want it now? Say "continue" in the chat window.',
  manageClose: 'Close',
  manageNoExperts: 'No experts yet — add one with the form below',
  reviewTitle: '针锋相对 · plan review',
  reviewQuestion: 'User\'s question',
  reviewPlan: 'Plan & explanation',
  reviewViewpoints: 'Expert objections',
  reviewEmpty: '(no objections yet, review in progress)',
  reviewSupport: 'Support (real flaw)',
  reviewSupported: 'Endorsed',
  reviewSupportedToast: 'Endorsed as a real flaw; it will feed the plan revision',
  reviewEndorsed: 'endorsed flaw',
  reviewEndorseFailed: 'Endorse failed',
  reviewHint: 'Click "Support" to confirm a real flaw — it feeds the next plan revision.',
  reviewClose: 'Close',
  reviewBadge: 'Adversarial review',
  reviewOpen: 'Open review',
  reviewStatusReviewing: 'reviewing',
  reviewStatusDone: 'done',
  reviewPending: 'unreviewed',
  reviewRejected: 'rejected',
  reviewReject: 'Reject',
  reviewRejectedDone: 'Rejected',
  reviewRejectedToast: 'Rejected after review; it will not feed the plan revision',
  reviewPendingToast: 'Marking cleared',
  reviewRejectReasonPrompt: 'Rejecting requires a reason (required, kept in the review record):',
  reviewRejectReasonPlaceholder: 'e.g. this flaw is based on a misunderstanding; the plan already covers it…',
  reviewRejectReasonRequired: 'Please enter a reject reason before confirming',
  reviewRejectConfirm: 'Confirm reject',
  reviewRejectCancel: 'Cancel',
  reviewEvidenceRepro: 'Reproduction steps',
  reviewEvidenceArgument: 'Argument chain',
  reviewPassBadge: 'Review pass {pass}/{max}',
  reviewImpactTitle: 'Impact overview',
  reviewImpactThresholdHint: 'Several flaws were endorsed — consider renegotiating the plan before revising.',
  reviewImpactOk: 'Endorsed flaws are recorded; revise the plan accordingly.',
  reviewExportHint: 'To export the full review record (Markdown), ask the captain to export it in the conversation.',
  feedbackTitle: 'User feedback',
  feedbackEnabled: 'Ask for lightweight feedback when a meeting ends',
  feedbackEnabledHint: 'On: shows one 1-tap usefulness question after a meeting/review closes; turn it off here anytime.',
  feedbackPrivacyNote: 'Privacy: only the collaboration mode, expert provider/model, round/token usage, timestamp and an optional one-line note are recorded — never conversation content. Stored in the workspace-level feedback.jsonl (consider .gitignore); can be wiped with one click.',
  feedbackListEmpty: '(no feedback collected yet)',
  feedbackListTitle: 'Collected feedback',
  feedbackClear: 'Clear all feedback',
  feedbackCleared: 'Feedback cleared',
  feedbackLoadFailed: 'Failed to load feedback',
  feedbackEntryMeta: '{date} · {mode} · {providers} · {rounds} rounds / {tokens} tokens · {rating}',
  feedbackAskTitle: 'Was this meeting useful? (1 tap, anonymous, disable in settings)',
  feedbackAskGood: 'Useful',
  feedbackAskMeh: 'Meh',
  feedbackAskBad: 'Not useful',
  feedbackAskNotePlaceholder: 'What was the biggest pain point? (optional)',
  feedbackAskSkip: 'Skip',
  feedbackAskSubmitted: 'Thanks! Manage or clear feedback anytime under Settings → RoundTable → User feedback.',
  feedbackAskFailed: 'Failed to submit feedback',
  settingsPresetsTitle: 'Role presets',
  settingsPresetSetDefault: "Set as default",
  settingsPresetClearDefault: "Clear default",
  settingsPresetDefaultBadge: "default",
  settingsPresetsHint: 'Save the roles you use often; picking one in the meeting\'s expert manager fills in the role text and model for you, so you stop retyping them. Presets are global preferences — editing them never changes a meeting that already exists, and no built-in role is shipped.',
  settingsPresetsEmpty: 'No presets yet. The two required fields below create the first one.',
  settingsPresetName: 'Preset name',
  settingsPresetNamePlaceholder: 'e.g. Security review',
  settingsPresetRole: 'Role description',
  settingsPresetRolePlaceholder: 'e.g. Attack from a security angle: exploitable risks and repro paths only',
  settingsPresetModel: 'Model (empty = inherit the captain)',
  settingsPresetAdd: 'New preset',
  settingsPresetEdit: 'Edit',
  settingsPresetSave: 'Save preset',
  settingsPresetCancel: 'Cancel',
  settingsPresetDelete: 'Delete',
  settingsPresetInvalid: 'Preset name and role description are both required',
  settingsPresetLimit: 'Preset limit reached ({max}) — delete one first',
  settingsPresetUpdated: 'Presets updated',
  settingsPresetEffortTitle: 'Reasoning effort',
  settingsPresetEffortInheritHint: '"Inherit" follows the captain; a change only affects experts added afterwards.',
  settingsPresetEffortUnavailable: 'This model provides no reasoning levels.',
  settingsPresetEffortOnlyNew: 'Only affects experts added afterwards; seated experts stay unchanged.',
  managePresetLabel: 'Role preset',
  managePresetPlaceholder: 'Pick a preset to autofill',
  managePresetEmpty: 'No presets yet — create one under Settings → RoundTable → Role presets.',
  modeOn: 'Discussion mode · on',
  modeOff: 'Discussion mode · off',
  modeViaCommand: '(via command)',
  modeOnHint: 'This session is in round-table discussion mode: every message sent here is handled as a round-table meeting (starting with the settings card). Turn it off with /roundtable off in the chat box.',
  modeOffHint: 'This session is not in round-table discussion mode: open the “RoundTable” tab to turn it on automatically, or type /roundtable in the chat box.',
  viewTopology: 'Topology',
  viewChat: 'Group chat',
  chatMembers: '{n} members',
  chatEmpty: 'No messages yet',
  chatEmptyHint: 'Once the meeting starts, the captain and the experts will show up here in real time.',
  chatInputPlaceholder: 'Speak as the captain… (Enter to send, Shift+Enter for a newline)',
  chatSend: 'Send',
  chatSending: 'Sending…',
  chatSendFailed: 'Send failed: {msg}',
  chatLoadFailed: 'Failed to load the transcript: {msg}',
  chatLoading: 'Loading the transcript…',
  chatYou: 'Me',
  chatTruncated: 'Showing the latest {n}; earlier messages are not loaded.',
  chatToday: 'Today',
  chatRoundDivider: 'Round {n}',
  chatToGateway: '→ gateway',
  chatToSeat: '→ {to}',
  emptyInputPlaceholder: 'Say something and the captain will start… (Enter to send)',
}
