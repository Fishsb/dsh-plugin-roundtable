/**
 * 用户亲口发言的**唯一标记**（host 侧，主持人可读面用）。
 *
 * ## 为什么需要
 *
 * `roundtable/say` 把用户在群聊窗口里打的话写成一条 `nodeKey: 'captain'` 的发言，
 * 只靠 `source: 'user'` 区分「用户亲口说的」与「主持人自己说的」。这个区分是**归因**
 * 问题，不是风格问题：主持人若把用户的话读成自己的话，它会以为"我已经表过态了"，
 * 于是不再回应 —— 用户看到自己说的话石沉大海。
 *
 * 但 `source` 字段此前**只到得了浏览器**（wire.ts），主持人可读的四处
 * （`roundtable_status` 的 recent / 汇聚网关 digest / 导出 / 小组件）全都不带它，
 * 于是声明里写的那条区分在 host 侧实际上不可达。
 *
 * ## 为什么做成一个共享函数
 *
 * 那句标记要在**四个互不相邻**的渲染点出现（status 行、digest 行、导出行…）。
 * 各写各的字面量必然漂移 —— 一处写「用户」、一处写「(user)」，主持人（和读它们的
 * 用户）就得学四套词。这里定义一次，四处引用。
 *
 * @module dsh-plugin-roundtable/utterance-source
 */

/** 一条发言是否真的是用户亲口说的（缺席 = 主持人/专家写的）。 */
export function isUserSourced(utterance: { source?: string }): boolean {
  return utterance.source === 'user'
}

/**
 * 人类可读的"用户亲口"标记（**不含**前后空格；非用户发言返回空串）。
 *
 * 刻意返回「（用户）」而不是「我」：读它的人可能不是用户本人 —— 主持人读它时要能
 * 立刻看出"这是用户说的，不是我说的"，而导出/群聊里"我"是相对视角、会误导。
 */
export function userSourceMark(utterance: { source?: string }): string {
  return isUserSourced(utterance) ? '（用户）' : ''
}
