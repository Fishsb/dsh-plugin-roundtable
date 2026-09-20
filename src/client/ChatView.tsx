/**
 * ChatView — 圆桌会议 Tab 内的「群聊」窗口（QQ 群聊形态）。
 *
 * 设计要点：
 *  - **纯展示组件**：自己不发 RPC。数据（messages/members/loading/error）与动作
 *    （onSend）全部由 `RoundTableView` 传入，这样换数据源（例如将来接真实 QQ 群）
 *    时 UI 不返工，只需换父级的取数实现。
 *  - **头像是现成的**：复用 `RoundTableView` 的 `providerBrand`（9 个 provider 的
 *    品牌 logo 已随包构建），不新增图片资源。
 *  - **`aggregator` 不画成人**：`MeetingUtterance` 里 `aggregator` 只出现在 `to`，
 *    不是发言者（见 types.ts 的注释）。它只作为气泡下方的旁注出现。
 *  - **滚动规则**：仅当用户已在底部附近时才自动滚到最新；正在上翻历史时**绝不**
 *    把他顶走 —— 否则新消息一到，读历史的人就丢失了位置。
 *
 * @module dsh-plugin-roundtable/client/ChatView
 */

import { useEffect, useMemo, useRef } from 'react'
import type { WireChatMessage, WireMeeting, WireNode } from './wire.ts'
import { ChatComposer } from './ChatComposer.tsx'
import styles from './ChatView.module.css'

export interface ChatViewBrand {
  abbr: string
  color: string
  logo?: string
  dark?: boolean
}

export interface ChatViewProps {
  meeting: WireMeeting
  /** 全量发言（升序，来自 `roundtable/transcript.list`）。 */
  messages: WireChatMessage[]
  /** 是否因为 host 侧上限而截断了更早的发言。 */
  truncated: boolean
  loading: boolean
  /** 加载/发送失败的一句话（空 = 无错误）。 */
  error: string
  /** 正在发送中（禁用输入并防止重复提交）。 */
  sending: boolean
  t: (key: string) => string
  /** 由父级提供的品牌头像解析（避免 UI 复制一份 provider 匹配表）。 */
  brandOf: (provider: string) => ChatViewBrand
  onSend: (text: string) => void
}

/** 距底部多少像素内算"贴底"（超过则不自动滚动）。 */
const STICKY_BOTTOM_PX = 48

/** 连续同人合并的间隔上限：超过就重新画头像与昵称（QQ 的分组习惯）。 */
const MERGE_WINDOW_MS = 3 * 60 * 1000

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

function dayOf(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 一位群成员（发言者）的展示信息。 */
interface Member {
  key: string
  label: string
  role: string
  provider: string
  /** 是否是"我"（用户在群聊里亲口发的）。 */
  mine: boolean
}

export function ChatView(props: ChatViewProps): JSX.Element {
  const { meeting, messages, truncated, loading, error, sending, t, brandOf, onSend } = props
  const streamRef = useRef<HTMLDivElement | null>(null)
  /** 用户是否停在底部。默认 true；一旦上翻即置 false，滚回底部再置 true。 */
  const stickToBottom = useRef(true)

  // 成员表：主持人 + 未移除的专家。刻意把 `captain` 放第一位 —— 它是会议的信息枢纽。
  const members = useMemo((): Member[] => {
    const live: WireNode[] = meeting.nodes.filter((node) => node.status !== 'removed')
    const list: Member[] = [{
      key: 'captain',
      label: 'DeepSeek · 主持',
      role: t('meeting'),
      provider: 'deepseek',
      mine: false,
    }]
    for (const node of live) {
      list.push({
        key: node.key,
        label: node.key,
        role: node.role,
        provider: node.provider,
        mine: false,
      })
    }
    return list
  }, [meeting.nodes, t])

  const memberOf = useMemo((): Map<string, Member> => {
    const map = new Map<string, Member>()
    for (const member of members) map.set(member.key, member)
    return map
  }, [members])

  // 贴底时跟随最新；用户上翻则不打扰。
  useEffect(() => {
    const element = streamRef.current
    if (element === null) return
    if (!stickToBottom.current) return
    element.scrollTop = element.scrollHeight
  }, [messages.length])

  const onScroll = (): void => {
    const element = streamRef.current
    if (element === null) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    stickToBottom.current = distance <= STICKY_BOTTOM_PX
  }

  /** 渲染一条消息，并判断它是否是"合并"（与上一条同人且时间接近）。 */
  const renderMessage = (message: WireChatMessage, index: number): JSX.Element => {
    const previous = index > 0 ? messages[index - 1] : undefined
    const mine = message.source === 'user'
    const merged = previous !== undefined
      && previous.from === message.from
      && previous.source === message.source
      && message.ts - previous.ts < MERGE_WINDOW_MS
    const dayChanged = previous === undefined || dayOf(previous.ts) !== dayOf(message.ts)
    const roundChanged = previous === undefined || previous.round !== message.round
    const member = memberOf.get(message.from)
    const brand = message.from === 'captain' ? brandOf('deepseek') : brandOf(member?.provider ?? '')
    const label = mine ? t('chatYou') : (member?.label ?? message.from)
    const audience = message.to === ''
      ? t('chatToGateway')
      : t('chatToSeat').replace('{to}', message.to)

    return (
      <div key={message.id} style={{ display: 'contents' }}>
        {dayChanged ? <div className={styles.divider}>{dayOf(message.ts)}</div> : null}
        {roundChanged ? <div className={styles.divider}>{t('chatRoundDivider').replace('{n}', String(message.round))}</div> : null}
        <div
          className={[
            styles.row,
            mine ? styles.rowMine : styles.rowOther,
            merged ? styles.rowMerged : '',
          ].filter(Boolean).join(' ')}
          data-rt-msg={message.id}
          data-rt-from={message.from}
        >
          {merged ? (
            <div className={styles.avatarSlot} />
          ) : (
            <div
              className={[styles.avatar, brand.dark === true ? styles.avatarLight : ''].filter(Boolean).join(' ')}
              style={brand.logo === undefined ? { background: brand.color } : undefined}
              title={label}
            >
              {brand.logo === undefined
                ? <span className={styles.avatarAbbr}>{brand.abbr}</span>
                : <img className={styles.avatarImg} src={brand.logo} alt={label} />}
            </div>
          )}
          <div className={[styles.bubbleCol, mine ? styles.bubbleColMine : ''].filter(Boolean).join(' ')}>
            {merged ? null : (
              <div className={styles.senderLine}>
                <span className={styles.senderName}>{label}</span>
                {member !== undefined && member.role !== '' && !mine ? (
                  <span>{member.role}</span>
                ) : null}
                {mine ? <span className={styles.senderTag}>{t('chatYou')}</span> : null}
                <span className={styles.senderTime}>{timeOf(message.ts)}</span>
              </div>
            )}
            <div className={[
              styles.bubble,
              mine ? styles.bubbleMine : (message.from === 'captain' ? styles.bubbleCaptain : ''),
            ].filter(Boolean).join(' ')}>
              {message.text}
            </div>
            {/* 发言去向往气泡下方（QQ 没有这个，但会议的"发给谁"是真实信息，
                不显示会让单线制/圆桌制的差别在群聊里彻底不可见）。 */}
            {message.kind === 'speech' && !mine ? (
              <div className={[styles.bubbleMeta, mine ? styles.bubbleMetaRight : ''].filter(Boolean).join(' ')}>
                <span>{audience}</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.chat} data-rt-chat="root">
      <div className={styles.groupHeader}>
        <div className={styles.groupAvatar} aria-hidden="true">桌</div>
        <div className={styles.groupMeta}>
          {/* 刻意不重复会议名：Tab 头部的 titleRow 是唯一来源（抗堆叠）。
              这一行改为承担"群公告"角色 —— 会议目标 + 成员数。 */}
          <div className={styles.groupName} title={meeting.goal !== '' ? meeting.goal : meeting.name}>
            {meeting.goal !== '' ? meeting.goal : meeting.name}
          </div>
          <div className={styles.groupSub}>
            {t('chatMembers').replace('{n}', String(members.length))}
          </div>
        </div>
      </div>

      <div ref={streamRef} className={styles.stream} onScroll={onScroll} data-rt-chat="stream">
        {truncated ? (
          <div className={styles.truncated}>{t('chatTruncated').replace('{n}', String(messages.length))}</div>
        ) : null}
        {loading && messages.length === 0 ? (
          <div className={styles.loading}>{t('chatLoading')}</div>
        ) : null}
        {error !== '' ? <div className={styles.loadFailed}>{error}</div> : null}
        {!loading && messages.length === 0 && error === '' ? (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>{t('chatEmpty')}</div>
            <div className={styles.emptyHint}>{t('chatEmptyHint')}</div>
          </div>
        ) : null}
        {messages.map(renderMessage)}
      </div>

      <ChatComposer t={t} sending={sending} onSend={onSend} />
    </div>
  )
}
