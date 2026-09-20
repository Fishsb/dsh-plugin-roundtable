/**
 * ChatComposer — 群聊输入条。
 *
 * **群聊窗口与「还没有会议」空状态窗口共用这一个组件**（用户要求：空状态那个
 * 窗口里的输入框就是群聊窗口的那一个）。
 *
 * 为什么不各写一份：两份拷贝会立刻漂移，而这三处语义必须始终一致 ——
 *   ① Enter 发送 / Shift+Enter 换行（聊天窗口的肌肉记忆）
 *   ② 发送中禁用（防重复提交）
 *   ③ 空文本拦截（trim 后为空不发）
 * 抽成一个组件后，改一次即两处生效；测试也只需钉一条接线（两处都引用它）。
 *
 * 组件**不做 IO**：`onSend` 由调用方给，因为两处的发送目标不同 ——
 * 群聊窗口发 `roundtable/say`（会议已存在），空状态发 `roundtable/steer`
 * （会议还不存在，这条消息去**开**一场会议）。
 *
 * @module dsh-plugin-roundtable/client/ChatComposer
 */

import { useState, type KeyboardEvent } from 'react'
import styles from './ChatView.module.css'

export interface ChatComposerProps {
  t: (key: string) => string
  /** 正在发送中（禁用输入并防止重复提交）。 */
  sending: boolean
  /** 由调用方决定这条消息发去哪里。 */
  onSend: (text: string) => void
  /** 占位文案的字典键（缺省 = 群聊窗口那一份）。 */
  placeholderKey?: string
  /** 强制禁用（调用方有额外条件时用；与 `sending` 取或）。 */
  disabled?: boolean
}

export function ChatComposer(props: ChatComposerProps): JSX.Element {
  const { t, sending, onSend, placeholderKey, disabled } = props
  const [draft, setDraft] = useState('')
  const blocked = sending || disabled === true
  const placeholder = t(placeholderKey ?? 'chatInputPlaceholder')

  const submit = (): void => {
    const text = draft.trim()
    // 空文本不发：既防误触，也让"发送"按钮的禁用态与行为一致。
    if (text === '' || blocked) return
    onSend(text)
    setDraft('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter 发送、Shift+Enter 换行 —— 与聊天窗口一致的肌肉记忆。
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    submit()
  }

  return (
    <div className={styles.composer}>
      <textarea
        className={styles.input}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={blocked}
        rows={1}
        aria-label={placeholder}
        data-rt-composer="input"
      />
      <button
        type="button"
        className={styles.sendButton}
        onClick={submit}
        disabled={blocked || draft.trim() === ''}
        data-rt-composer="send"
      >
        {sending ? t('chatSending') : t('chatSend')}
      </button>
    </div>
  )
}
