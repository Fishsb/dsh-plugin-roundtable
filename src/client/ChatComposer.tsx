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

/**
 * 这次 keydown 是否应当**发送**？
 *
 * 抽成纯函数（而不是内联在 JSX 的 handler 里）是为了能被直接断言 —— 这两条规则
 * 各有一个容易写错的边界，而它们**在渲染面上不可观测**（SSR 渲不出按键行为）：
 *
 *   - **IME 组合态**：中文/日文输入法里「按 Enter 选定候选词」与「按 Enter 发送」
 *     是同一个键，组合期间 `key` 同样是 `'Enter'`。不拦就会在用户选词时把半截拼音
 *     或未完成的正文发出去 —— 而占位文案恰恰在宣传「Enter 发送」，等于诱导踩坑。
 *   - **Shift+Enter** 必须换行而不是发送。
 *
 * ⚠ `isComposing` 在 React 合成事件上**不存在**，必须从 `nativeEvent` 取
 * （宿主自己的编辑器也这么判：`dsh-client-ui-conversation` 里
 * `if (e.isComposing()) return`）。
 *
 * @param key         `KeyboardEvent.key`
 * @param shiftKey    是否按住 Shift
 * @param isComposing 原生事件的 IME 组合态（缺失/undefined 视为「不在组合中」，
 *                    与浏览器把该属性默认置 false 一致）
 * @returns 真 = 这一下 Enter 应该发送
 */
export function shouldSendOnKey(
  key: string,
  shiftKey: boolean,
  isComposing: boolean | undefined,
): boolean {
  if (key !== 'Enter') return false
  if (shiftKey) return false
  if (isComposing === true) return false
  return true
}

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
    // 决策落在 shouldSendOnKey（纯函数、可直测）：Enter 发送 / Shift+Enter 换行 /
    // IME 组合态不发送。这里只负责把事件字段取出来。
    if (!shouldSendOnKey(event.key, event.shiftKey, event.nativeEvent.isComposing)) return
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
