/**
 * 讨论模式徽章 —— 拓扑页头部与「还没有会议」空状态窗口**共用这一个组件**。
 *
 * ## 为什么必须抽出来
 *
 * 同一枚徽章要在两处出现（有会议时的头部、无会议时的空状态屏）。两份拷贝会立刻
 * 漂移，而它承载的是一条**状态事实** —— 两处说法不一致时，用户不知道该信哪个。
 * 所以标记、文案、显示条件只定义一次（与 `ChatComposer` 同一理由）。
 *
 * ## 为什么空状态那一屏必须显示它（v0.2.50）
 *
 * 打开「圆桌会议」tab 本身就开启讨论模式（`auto` 那一份），**不需要碰任何输入框**。
 * 而空状态输入框会把同一会话的 `manual` 那一份也置上，那一份**切走 tab 不会被撤**
 * —— 于是用户"只是在这一屏打了个字"，之后回到聊天却发现每条消息都被当议题处理，
 * 而那一屏此前**没有任何徽章**可看（有会议的头部才显示）。徽章补上这块可见性。
 *
 * ## 为什么子标签说的是「切走 tab 仍开启」而不是「命令开启」
 *
 * `manual` 现在有两个写入点：`/roundtable` 命令**与**空状态输入框（`roundtable/steer`）。
 * 原先的文案 `（命令开启）` 只对前一个成立 —— 用户在输入框里打了一句话，徽章却断言
 * 他敲过命令，那是**假标签**。改成描述**后果**（不随切走而关闭）对两个来源都成立，
 * 而且正是用户此刻需要知道的事。
 *
 * ## 不画假状态
 *
 * `state === null`（真值还没问到）时**什么都不画** —— 先画一个"关"再跳成"开"，
 * 用户会看到一次不存在的状态变化。
 *
 * @module dsh-plugin-roundtable/client/ModeBadge
 */

import type { RoundTableKey } from './locales.ts'
import type { WireModeState } from './wire.ts'
import styles from './RoundTableView.module.css'

export interface ModeBadgeProps {
  /** host 回包的三态；`null` = 还没问到（此时不画）。 */
  state: WireModeState | null
  /** 文案键渲染函数（视图的 translate）。 */
  t: (key: RoundTableKey) => string
}

export function ModeBadge(props: ModeBadgeProps): JSX.Element | null {
  const { state, t } = props
  if (state === null) return null
  return (
    <span
      data-rt-mode={state.active ? 'on' : 'off'}
      className={[styles.modeBadge, state.active ? styles.modeBadgeOn : ''].filter(Boolean).join(' ')}
      title={state.active ? t('modeOnHint') : t('modeOffHint')}
    >
      {state.active ? t('modeOn') : t('modeOff')}
      {/* 只标"不会随切走而关闭"的那一份；tab 那一份本来就会随切走关掉，不必标。 */}
      {state.manual ? <span className={styles.modeBadgeManual}>{t('modePersistent')}</span> : null}
    </span>
  )
}
