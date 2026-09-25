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

import { useEffect, useMemo, useRef, useState } from 'react'
import type { WireChatMessage, WireMeeting, WireNode, WireRolePreset } from './wire.ts'
import { presetAvatarGlyph, presetFallbackGlyph } from './preset-avatars.ts'
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
  /** 全局角色预设（来自 prefs.get）：提供头像与职能名。 */
  presets: readonly WireRolePreset[]
  onSend: (text: string) => void
}

/**
 * 这条正文是否**值得折叠**。
 *
 * 阈值不按像素而按字符：群聊气泡宽度随窗口变，按渲染行数判要测量 DOM、
 * 会引入二次渲染。480 字 ≈ 窄窗口下十余行 —— 低于它的气泡折起来反而碍事
 * （多一次点击），高于它的才会真的淹掉首屏。
 */
const FOLD_CHARS = 480

function foldable(text: string): boolean {
  return text.length > FOLD_CHARS
}

/** 距底部多少像素内算"贴底"（超过则不自动滚动）。 */
const STICKY_BOTTOM_PX = 48

/** 连续同人合并的间隔上限：超过就重新画头像与昵称（QQ 的分组习惯）。 */
const MERGE_WINDOW_MS = 3 * 60 * 1000

function timeOf(ts: number, localeTag: string): string {
  return new Date(ts).toLocaleTimeString(localeTag, { hour12: false, hour: '2-digit', minute: '2-digit' })
}

/**( 日期分组键：同一天归为一组。用本地日期串比较，跨时区不误判。 )
 * 刻意返回"原始日期串"作为**分组依据**，显示文案另由 dayLabelOf 决定 ——
 * 两者分开，分组正确性不会因为文案改中文/英文而改变。 */
function dayOf(ts: number, localeTag: string): string {
  return new Date(ts).toLocaleDateString(localeTag)
}

/**
 * 日期分隔条上的文案。
 *
 * 为什么不是裸日期：真实群聊（QQ/微信）对**最近两天**说"今天/昨天" —— 这是
 * 用户心里的锚点；只有更早的才回落到日期。裸日期把最常见的两种情况也变成
 * 需要心算的数字，而群聊恰恰最常看这两段。
 */
function dayLabelOf(ts: number, now: number, localeTag: string, t: (key: string) => string): string {
  const day = dayOf(ts, localeTag)
  if (day === dayOf(now, localeTag)) return t('chatToday')
  if (day === dayOf(now - 24 * 60 * 60 * 1000, localeTag)) return t('chatYesterday')
  return day
}

/** 一位群成员（发言者）的展示信息。 */
interface Member {
  key: string
  /** 昵称：优先预设的职能名，回落节点 key。 */
  label: string
  /** 职能名（预设 title）；空 = 未设。 */
  title: string
  role: string
  provider: string
  /** 头像字形。**不走 provider 品牌**：同一 provider 会拉起多个职能，
   *  全同图等于三个人长得一模一样（本机实测一场会议 3 个 deepseek 席）。 */
  glyph: string
}

export function ChatView(props: ChatViewProps): JSX.Element {
  const { meeting, messages, truncated, loading, error, sending, t, brandOf, presets, onSend } = props
  const streamRef = useRef<HTMLDivElement | null>(null)
  /**
   * 已展开的长消息 id 集合。
   *
   * 用 Set 而不是"每条的 boolean"：消息列表按 1Hz 增量合并会重建对象，
   * 挂在消息上的布尔位会随重建丢失（用户展开过的又折回去）。id 是稳定的。
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  /** 渲染时刻（一次算好）：日期分组要拿它判"今天/昨天"，逐条 new Date 既慢
   *  又可能跨过午夜造成同一次渲染里两条消息判到不同的"今天"。 */
  const nowTs = Date.now()
  /** 当前语言的 BCP-47 标签（日期/时间格式化用）。
   *  取自字典而非硬编码：它是**唯一随语言刷新的通道**（t 依赖 locale revision）。 */
  const localeTag = t('localeTag')
  /** 用户是否停在底部。默认 true；一旦上翻即置 false，滚回底部再置 true。 */
  const stickToBottom = useRef(true)

  // 成员表：主持人 + 未移除的专家。刻意把 `captain` 放第一位 —— 它是会议的信息枢纽。
  /** 预设索引：节点靠 presetId 反查它的头像与职能名。 */
  const presetOf = useMemo((): Map<string, WireRolePreset> => {
    const map = new Map<string, WireRolePreset>()
    for (const preset of presets) map.set(preset.id, preset)
    return map
  }, [presets])

  const members = useMemo((): Member[] => {
    const live: WireNode[] = meeting.nodes.filter((node) => node.status !== 'removed')
    const list: Member[] = [{
      key: 'captain',
      label: t('captainLabel'),
      title: t('captainLabel'),
      role: t('meeting'),
      provider: 'deepseek',
      glyph: t('groupAvatarGlyph'),
    }]
    for (const node of live) {
      const preset = node.presetId === undefined ? undefined : presetOf.get(node.presetId)
      const title = preset?.title ?? ''
      list.push({
        key: node.key,
        // 昵称优先职能名（用户给人看的标签），回落节点 key。
        label: title !== '' ? title : node.key,
        title,
        role: node.role,
        provider: node.provider,
        glyph: presetAvatarGlyph(preset?.avatar, presetFallbackGlyph(title, node.key)),
      })
    }
    return list
  }, [meeting.nodes, t, presetOf])

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
    /**
     * 连续同人合并（QQ 的分组习惯）。窗口 3 分钟。
     *
     * ⚠ **用户自己的消息永不参与合并**：合并会吞掉 senderLine —— 那里面有
     * 时间戳与「我」标签。对"我说的话"来说，这两样都不能省：用户需要确认
     * 自己那句话是**什么时候**说的（等回应时尤其如此）。
     * 实测：`user → user` 连续两句会被合并（`captain → user` 不会，因为
     * source 不同）—— 所以只挡 user 这一支即可。
     */
    const merged = previous !== undefined
      && message.source !== 'user'
      && previous.from === message.from
      && previous.source === message.source
      && message.ts - previous.ts < MERGE_WINDOW_MS
    const dayChanged = previous === undefined || dayOf(previous.ts, localeTag) !== dayOf(message.ts, localeTag)
    const roundChanged = previous === undefined || previous.round !== message.round
    const member = memberOf.get(message.from)
    const brand = message.from === 'captain' ? brandOf('deepseek') : brandOf(member?.provider ?? '')
    const label = mine ? t('chatYou') : (member?.label ?? message.from)
    const audience = message.to === ''
      ? t('chatToGateway')
      : t('chatToSeat').replace('{to}', message.to)
    /**
     * 非普通发言的类别徽标。
     *
     * 为什么必须显示：真实 transcript 里 `kind` 有 speech / retrieval /
     * proxy-thinking 三种（本机实测 168 行：157 speech + 11 retrieval）。
     * 检索与代思考**不是专家本人的观点** —— 把它们与发言同形渲染，读者会把
     * 「我去查了什么」当成「我主张什么」。这是信息**性质**的差别，不是装饰。
     * speech 是默认类别，标出来只是噪声，故不标。
     */
    const kindBadge = message.kind === 'retrieval'
      ? t('chatKindRetrieval')
      : message.kind === 'proxy-thinking'
        ? t('chatKindProxyThinking')
        : ''
    /** 工作项 id：本轮派单里的哪一项。空串 = 不属于任何工作项。 */
    const workItem = message.workItem

    return (
      <div key={message.id} style={{ display: 'contents' }}>
        {dayChanged ? (
          <div className={styles.dayDivider}>
            <span className={styles.dayLabel}>{dayLabelOf(message.ts, nowTs, localeTag, t)}</span>
          </div>
        ) : null}
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
              className={[styles.avatar, styles.avatarGlyph].filter(Boolean).join(' ')}
              title={label}
            >
              <span className={styles.avatarAbbr}>{member?.glyph ?? brand.abbr}</span>
            </div>
          )}
          <div className={[styles.bubbleCol, mine ? styles.bubbleColMine : ''].filter(Boolean).join(' ')}>
            {merged ? null : (
              <div className={styles.senderLine}>
                <span className={styles.senderName}>{label}</span>
                {kindBadge === '' ? null : <span className={styles.kindBadge}>{kindBadge}</span>}
                {member !== undefined && member.role !== '' && !mine ? (
                  <span>{member.role}</span>
                ) : null}
                {mine ? <span className={styles.senderTag}>{t('chatYou')}</span> : null}
                <span className={styles.senderTime}>{timeOf(message.ts, localeTag)}</span>
              </div>
            )}
            <div
              className={[
                styles.bubble,
                mine ? styles.bubbleMine : (message.from === 'captain' ? styles.bubbleCaptain : ''),
                expanded.has(message.id) ? '' : styles.bubbleClamped,
              ].filter(Boolean).join(' ')}
            >
              {message.text}
            </div>
            {/* 长发言折叠：**不裁正文**（wire.ts 明说群聊要看全文），只做
                信息分级 —— 实测单条最长 10821 字、168 条里 >800 字有 140 条，
                不折叠则首屏要被超长文本淹掉。 */}
            {foldable(message.text) && !expanded.has(message.id) ? (
              <button
                type="button"
                className={styles.expandToggle}
                onClick={() => setExpanded((prev) => new Set(prev).add(message.id))}
              >
                {t('chatExpand')}
              </button>
            ) : null}
            {/* 发言去向往气泡下方（QQ 没有这个，但会议的"发给谁"是真实信息，
                不显示会让单线制/圆桌制的差别在群聊里彻底不可见）。 */}
            {/* 去往与工作项是**独立于 kind** 的两个维度（Slack 同构）：
                kind 说的是"这是什么性质的话"，to 说的是"这话发给谁"。
                原先把两者压进同一个 kind === 'speech' 判断，等于用"是不是
                普通发言"去决定"显示不显示收件人" —— 一旦出现别种 kind 的
                定向发言，收件人就会凭空消失。 */}
            {!mine && (message.to !== '' || message.kind !== 'speech') ? (
              <div className={styles.bubbleMeta}>
                <span>{audience}</span>
                {workItem === '' ? null : (
                  <span className={styles.workItemTag}>
                    {t('chatWorkItem').replace('{id}', workItem)}
                  </span>
                )}
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
        <div className={styles.groupAvatar} aria-hidden="true">{t('groupAvatarGlyph')}</div>
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