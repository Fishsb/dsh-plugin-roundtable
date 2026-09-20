/**
 * RoundTable topology tab: the "圆桌会议" conversation view.
 *
 * Minimal two-column layout:
 *   - main: meeting header (title/badges/budget) → topology canvas (captain
 *     anchor, ring of expert nodes with brand avatars, directed edges) →
 *     collapsible aggregation-gateway digest.
 *   - sidebar: expert status list, role breakdown, knowledge-base skeleton,
 *     recent-utterance activity log, and file outputs (none yet).
 *
 * The tab lists ALL meetings in the workspace (no session filter), so past
 * meetings stay visible across session switches, plugin updates and restarts;
 * a switcher dropdown is shown when more than one meeting exists.
 *
 * @module dsh-plugin-roundtable/client/RoundTableView
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcCaller, WireChatMessage, WireEdge, WireKbListing, WireMeeting, WireModelCatalog, WireModeState, WireNode, WireProviderOption, WireRolePreset, WireUsage } from './wire.ts'
import { fetchMeetings, fetchTranscript, steerSession } from './wire.ts'
import { BRAND_LOGOS } from './brand-logos.generated.ts'
import styles from './RoundTableView.module.css'
import { DispatchPanel } from './DispatchPanel.tsx'
import { ChatView } from './ChatView.tsx'
import { ChatComposer } from './ChatComposer.tsx'

export interface RoundTableViewInjected {
  rpc: RpcCaller
  /** Locale-bound translator for the roundtable namespace. */
  t: (key: string) => string
}

export interface RoundTableViewProps extends RoundTableViewInjected {
  sessionId: SessionId
}

interface Point { x: number; y: number }

interface EdgeMenuState {
  x: number
  y: number
  meetingId: string
  edge: WireEdge
}

interface DragState {
  from: string
  meetingId: string
  x: number
  y: number
}

const NODE_RADIUS = 34

/** Provider → brand avatar (logo image if bundled, else abbreviation + brand color). */
const PROVIDER_BRAND: Array<{ key: string; match: RegExp; abbr: string; color: string; dark?: boolean }> = [
  { key: 'zai', match: /^zai\b|zai\//i, abbr: 'ZAI', color: '#3859FF' },
  { key: 'deepseek', match: /deepseek/i, abbr: 'DS', color: '#4D6BFE' },
  { key: 'glm', match: /glm|zhipu|z\.ai|智谱/i, abbr: 'GLM', color: '#3859FF' },
  { key: 'openai', match: /openai|gpt/i, abbr: 'GPT', color: '#10A37F' },
  { key: 'claude', match: /anthropic|claude/i, abbr: 'CLD', color: '#D97757' },
  { key: 'qwen', match: /qwen|通义/i, abbr: 'QW', color: '#6E56CF' },
  { key: 'kimi', match: /moonshot|kimi/i, abbr: 'KM', color: '#16181D', dark: true },
  { key: 'gemini', match: /gemini/i, abbr: 'GM', color: '#4285F4' },
  { key: 'minimax', match: /minimax/i, abbr: 'MX', color: '#0A0A0A' },
]

/** Brand avatar for a provider: bundled logo (data URL) when available, else abbr + color. */
function providerBrand(provider: string): { abbr: string; color: string; logo?: string; dark?: boolean } {
  for (const brand of PROVIDER_BRAND) {
    if (!brand.match.test(provider)) continue
    return { abbr: brand.abbr, color: brand.color, logo: BRAND_LOGOS[brand.key], dark: brand.dark }
  }
  const abbr = provider.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '?'
  return { abbr, color: '#8a8a8a' }
}

/** CSS custom properties driving one message pulse from `from` to `to`. */
function flowStyle(from: Point, to: Point): CSSProperties {
  return {
    '--rt-fx': `${from.x}px`,
    '--rt-fy': `${from.y}px`,
    '--rt-tx': `${to.x}px`,
    '--rt-ty': `${to.y}px`,
  } as CSSProperties
}

/** Ring layout for one meeting inside a canvas of the given size. */
function layoutPositions(size: { w: number; h: number }, meeting: WireMeeting): Map<string, Point> {
  const positions = new Map<string, Point>()
  // Fall back to a sane canvas when the host container has not measured yet
  // (flex under a still-unsized slot reports 0 box). Without this, the ring
  // is empty on first paint and stays blank until a resize tick arrives —
  // the classic "topology is a big empty box" bug. A fixed default means the
  // nodes always have coordinates and the real size corrects them on the
  // next measure, mirroring the subagent-tree view which never goes blank.
  const w = size.w > 0 ? size.w : 900
  const h = size.h > 0 ? size.h : 480
  positions.set('captain', { x: Math.max(64, w * 0.10), y: h * 0.5 })
  positions.set('aggregator', { x: Math.max(150, w * 0.33), y: h * 0.5 })
  const nodes = meeting.nodes
  // 节点环占据画布右侧约 78% 的宽度，并**按可用高度铺开**：内边距只留一个
  // 节点半径 + 一圈呼吸空间，避免高画布时上下各空掉一半（"拓扑图下面一大
  // 片空白"）。宽度仍是硬约束，所以半径取两者的较小值。
  const centerX = w * 0.78
  const centerY = h * 0.5
  const radius = Math.max(
    NODE_RADIUS + 12,
    Math.min(w * 0.20, h * 0.5 - NODE_RADIUS - 18),
  )
  nodes.forEach((node, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(1, nodes.length)) * Math.PI * 2
    positions.set(node.key, {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    })
  })
  return positions
}

/** SVG arrowhead polygon points at (x, y) pointing along `angle`. */
function arrowPoints(x: number, y: number, angle: number, size = 7): string {
  const tip = { x, y }
  const back = {
    x: x - Math.cos(angle) * size,
    y: y - Math.sin(angle) * size,
  }
  const spread = size * 0.62
  const left = {
    x: back.x - Math.sin(angle) * spread,
    y: back.y + Math.cos(angle) * spread,
  }
  const right = {
    x: back.x + Math.sin(angle) * spread,
    y: back.y - Math.cos(angle) * spread,
  }
  return `${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`
}

/** Quadratic-bezier geometry for one edge, shared by the renderer (which
 *  draws the path) and the delete dot (which must sit on the curve's true
 *  midpoint, i.e. the point at t=0.5 — not the control point). */
function edgeCurveGeometry(
  edge: WireEdge,
  meeting: WireMeeting,
  positions: Map<string, Point>,
): { x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; path: string; mx: number; my: number } | null {
  const from = positions.get(edge.from)
  const to = positions.get(edge.to)
  if (from === undefined || to === undefined) return null
  // host 已在快照里判定 implicit / deliverable，客户端不再解析 id 前缀
  // （旧写法 `id.startsWith('synthetic:')` 是"同一事实两个判定者"）。
  const synthetic = edge.implicit === true
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.max(1, Math.hypot(dx, dy))
  const ux = dx / len
  const uy = dy / len
  const fromDegree = meeting.edges.reduce((n, e) => n + (e.from === edge.from ? 1 : 0), 0)
  const fromIndex = meeting.edges.filter((e) => e.from === edge.from).findIndex((e) => e.id === edge.id)
  const toDegree = meeting.edges.reduce((n, e) => n + (e.to === edge.to ? 1 : 0), 0)
  const toIndex = meeting.edges.filter((e) => e.to === edge.to).findIndex((e) => e.id === edge.id)
  const hubFrom = edge.from === 'captain' || edge.from === 'aggregator'
  const hubTo = edge.to === 'captain' || edge.to === 'aggregator'
  const baseAngle = Math.atan2(uy, ux)
  const startAngle = baseAngle
    + (hubFrom ? (fromIndex - (fromDegree - 1) / 2) * 0.09 : fromDegree > 1 ? (fromIndex - (fromDegree - 1) / 2) * 0.16 : 0)
  const endAngle = baseAngle
    + (hubTo ? (toIndex - (toDegree - 1) / 2) * 0.09 : toDegree > 1 ? (toIndex - (toDegree - 1) / 2) * 0.16 : 0)
  const x1 = from.x + Math.cos(startAngle) * NODE_RADIUS
  const y1 = from.y + Math.sin(startAngle) * NODE_RADIUS
  const x2 = to.x + Math.cos(endAngle) * NODE_RADIUS
  const y2 = to.y + Math.sin(endAngle) * NODE_RADIUS
  const midX = (x1 + x2) / 2
  const midY = (y1 + y2) / 2
  const nx = -(y2 - y1)
  const ny = x2 - x1
  const nlen = Math.max(1, Math.hypot(nx, ny))
  const bow = synthetic ? 0.2 : 0.24
  const cx = midX + (nx / nlen) * nlen * bow
  const cy = midY + (ny / nlen) * nlen * bow
  const path = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`
  // Point on the curve at t=0.5 — the visual midpoint the delete dot should sit on.
  const mx = 0.25 * x1 + 0.5 * cx + 0.25 * x2
  const my = 0.25 * y1 + 0.5 * cy + 0.25 * y2
  return { x1, y1, x2, y2, cx, cy, path, mx, my }
}

function nodeStatusLabel(node: WireNode, translate: (key: string) => string): string {
  if (node.status === 'removed' || node.activity === 'removed') return translate('activityRemoved')
  if (node.activity === 'running') return translate('activityRunning')
  if (node.activity === 'idle') return translate('activityIdle')
  return translate('activityReady')
}

/** 专家列表排序权重：工作中(0) < 就绪/待唤醒(1) < 已退出(3，置底)。 */
function nodeListRank(node: { status: string; activity?: string }): number {
  if (node.status === 'removed' || node.activity === 'removed') return 3
  if (node.activity === 'running') return 0
  return 1
}

/** 来源对话短号前缀（显示在会议切换下拉里，区分不同对话开的会议）。 */
function sourcePrefix(captainSessionId: string): string {
  if (captainSessionId === '') return '对话'
  return `对话-${captainSessionId.slice(0, 4)}`
}

/** 与 host 端 sanitizeKey 一致：把显示名转成会议内稳定的节点 key。 */
function sanitizeKey(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? '' : cleaned
}

/** 人类可读的文件大小（B/KB/MB）。 */
function formatKbSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** 品牌头像：有 logo 图片则圆形显示，否则品牌色块 + 缩写。 */
function brandAvatar(brand: { abbr: string; color: string; logo?: string; dark?: boolean }, size: 'node' | 'list'): JSX.Element {
  const cls = size === 'node' ? styles.avatar : styles.agentAvatar
  // 透明 logo 垫白底保证彩色 logo 清晰；深色 logo（Kimi/MiniMax 深色系）垫深底避免白字隐形。
  const background = brand.logo === undefined
    ? brand.color
    : (brand.dark ? '#16181D' : '#ffffff')
  return (
    <div className={cls} style={{ background }}>
      {brand.logo !== undefined
        ? <img className={styles.avatarImg} src={brand.logo} alt={brand.abbr} title={brand.abbr} />
        : size === 'node'
          ? <span className={styles.avatarAbbr}>{brand.abbr}</span>
          : <span className={styles.agentAbbr}>{brand.abbr}</span>}
    </div>
  )
}

export function RoundTableView(props: RoundTableViewProps): JSX.Element {
  const { sessionId, rpc, t: translate } = props
  // The `sessionId` prop is kept for slot-interface compatibility, but the
  // tab queries ALL meetings in the workspace (no session filter): past
  // meetings stay visible across session switches, updates and restarts.
  const [meetings, setMeetings] = useState<WireMeeting[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [manageOpen, setManageOpen] = useState(false)
  const [providers, setProviders] = useState<WireProviderOption[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [form, setForm] = useState<{ name: string; role: string; provider: string; model: string; reasoningEffort: string }>({ name: '', role: '', provider: '', model: '', reasoningEffort: '' })
  // B3：设置页维护的角色预设（只读镜像，用于"选中即填充"）。
  const [presetList, setPresetList] = useState<WireRolePreset[]>([])
  /** B3+：当前下拉里选中的预设 id（修 `value=""` 导致"选完回弹、看不出选了什么"）。 */
  const [selectedPresetId, setSelectedPresetId] = useState('')
  /** B3+：host 下发的缺省预设 id（打开面板且表单为空时用它预填）。 */
  const [defaultPresetId, setDefaultPresetId] = useState('')
  /** 批次 B ⑤：逐节点用量（**按需**拉取，绝不进 1s 轮询）。 */
  const [usage, setUsage] = useState<WireUsage | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [kbOpen, setKbOpen] = useState(false)
  const [kbPathInput, setKbPathInput] = useState('')
  const [kbListing, setKbListing] = useState<WireKbListing | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const reviewAutoShown = useRef<string | null>(null)
  // C2 驳回必填理由：当前正在填写驳回理由的观点 id（null = 无进行中的驳回输入）。
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectDraft, setRejectDraft] = useState('')
  const [fetchFailed, setFetchFailed] = useState(false)
  const [menu, setMenu] = useState<EdgeMenuState | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(true)
  // R3：右栏面板可见性（设置页持久化的"点圆圈决定显示"）。
  const [hiddenPanels, setHiddenPanels] = useState<string[]>([])
  // E1/E4：反馈开关（设置页持久化；默认开）。未知时先假设开，取到偏好后校正。
  const [feedbackEnabled, setFeedbackEnabled] = useState(true)
  // 已询问过反馈的会议 id（localStorage 记忆，避免每次轮询都弹）。
  const [askedFeedback, setAskedFeedback] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem('roundtable:feedback-asked')
      const list = raw === null ? [] : JSON.parse(raw) as unknown
      return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [])
    } catch {
      return new Set()
    }
  })
  // 正在询问反馈的会议 id（null = 无）。
  const [askFeedbackFor, setAskFeedbackFor] = useState<string | null>(null)
  const [feedbackNote, setFeedbackNote] = useState('')
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  /**
   * 本会话的讨论模式读数（host 回包，不是本地猜测）。
   *
   * 默认 `null` = 尚未问过 host：徽章先不画，免得在真值回来前闪一个假状态。
   */
  const [modeState, setModeState] = useState<WireModeState | null>(null)
  /**
   * 视图切换：拓扑（原有窗口） / 群聊（QQ 群聊形态）。
   *
   * 刻意**不落盘**：这与「讨论模式不落盘」同一条理由 —— 这是"此刻在看什么"的
   * 交互意图，不是配置。写成持久配置的结果是用户下次打开这个 Tab 时莫名不在
   * 他默认预期的那个视图上，而他自己想不起来何时切的。
   */
  const [view, setView] = useState<'topology' | 'chat'>('topology')
  /** 群聊窗口的数据（按需拉取，**不进** 1Hz 轮询）。 */
  const [chatMessages, setChatMessages] = useState<WireChatMessage[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  /** host 侧因 limit 截断了更早发言（提示用户"上面还有"）。 */
  const [chatTruncated, setChatTruncated] = useState(false)
  /** 群聊发送中（禁用输入并防止重复提交）。 */
  const [chatSending, setChatSending] = useState(false)
  /** 空状态输入框专用：把议题交给主持人开一场会议。 */
  const [steerSending, setSteerSending] = useState(false)
  const [steerError, setSteerError] = useState('')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const hoverTimer = useRef<number | null>(null)

  // Reveal an edge's delete dot and KEEP it revealed briefly after the pointer
  // leaves the edge path, so the user can glide from the line onto the dot
  // (which sits at the curve's midpoint) without it vanishing. Entering the
  // dot cancels the pending clear.
  const setHoverEdge = useCallback((id: string): void => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
    setHoverEdgeId(id)
  }, [])
  const clearHoverEdge = useCallback((id: string): void => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => {
      setHoverEdgeId((current) => (current === id ? null : current))
      hoverTimer.current = null
    }, 180)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchMeetings(showAll ? undefined : String(sessionId))
      setMeetings(next)
      setFetchFailed(false)
    } catch {
      setFetchFailed(true)
    }
  }, [sessionId, showAll])

  // Load the 互通 preference once; it decides whether this tab lists every
  // meeting in the workspace (on) or only meetings this conversation started.
  // `hiddenPanels` (R3) additionally picks which right-column panels show.
  useEffect(() => {
    void rpc<{ showAllMeetings?: boolean; feedbackEnabled?: boolean; hiddenPanels?: string[]; rolePresets?: WireRolePreset[]; defaultPresetId?: string }>('roundtable/prefs.get', {})
      .then((result) => {
        if (result.ok) {
          if (typeof result.value?.showAllMeetings === 'boolean') setShowAll(result.value.showAllMeetings)
          if (typeof result.value?.feedbackEnabled === 'boolean') setFeedbackEnabled(result.value.feedbackEnabled)
          if (Array.isArray(result.value?.hiddenPanels)) setHiddenPanels(result.value.hiddenPanels)
          if (Array.isArray(result.value?.rolePresets)) setPresetList(result.value.rolePresets)
          // B3+：缺省预设（单一缺省值），用于打开专家管理面板时预填
          if (typeof result.value?.defaultPresetId === 'string') setDefaultPresetId(result.value.defaultPresetId)
        }
      })
      .catch(() => undefined)
  }, [rpc])

  /** R3：右栏面板的类名 —— 被用户在设置里关掉的面板加 hidden 类。 */
  const panelClass = (id: string): string =>
    [styles.panel, hiddenPanels.includes(id) ? styles.panelHidden : ''].filter(Boolean).join(' ')

  // Poll the snapshot every second — but never while the page is hidden. One
  // snapshot is a full aggregate of every meeting (measured 2026-09-19:
  // 301 KB / 44.5 ms over 16 meetings), so a backgrounded tab polling at 1 Hz
  // is pure waste; catch up on the first visible tick instead.
  useEffect(() => {
    let alive = true
    let inflight = false
    const tick = async (): Promise<void> => {
      if (inflight) return
      if (document.visibilityState === 'hidden') return
      inflight = true
      try {
        const next = await fetchMeetings(showAll ? undefined : String(sessionId))
        if (alive) {
          setMeetings(next)
          setFetchFailed(false)
        }
      } catch {
        if (alive) setFetchFailed(true)
      } finally {
        inflight = false
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 1000)
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void tick()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [sessionId, showAll])

  // Measure the canvas with a hard fallback. Some host containers report a
  // 0 box on first paint (flex under a yet-unsized slot), which would leave
  // the topology empty; we fall back to a sane default so nodes always have
  // coordinates, then correct to the real size once the layout settles.
  //
  // 依赖 `view`：切到群聊时画布卸载（containerRef 变 null），切回来时是**新**的
  // DOM 节点 —— 若不在切回时重跑，ResizeObserver 会一直盯着那个已卸载的旧节点，
  // 于是新画布拿到 size=0，节点全挤在默认坐标上。
  useEffect(() => {
    if (view !== 'topology') return
    const container = containerRef.current
    if (container === null) return
    const measure = (): void => {
      const w = container.clientWidth
      const h = container.clientHeight
      const next = { w: w > 0 ? w : 900, h: h > 0 ? h : 480 }
      setSize((previous) => (previous.w === next.w && previous.h === next.h ? previous : next))
    }
    measure()
    const raf = window.requestAnimationFrame(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => {
      window.cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [view])

  // Close the context menu on any click elsewhere.
  useEffect(() => {
    if (menu === null) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  /**
   * 讨论模式：本 tab 挂载 = 该会话进入"圆桌讨论模式"（`auto` 那一份）。
   *
   * 为什么挂在挂载/卸载而不是"打开下拉选一次"：用户的诉求是「在这个窗口里发
   * 消息默认就是圆桌讨论」—— 那么判据只能是"他此刻正看着这个 tab"，而不是
   * 一次性的点击。收起（切回聊天 tab / 关页面）时撤销自己那一份，命令开的
   * `manual` 不受影响。
   *
   * 写法上刻意 **不** 用 `await rpc(...).then(...)` 直接 setState：卸载后
   * 回包还在路上时 setState 会给 React 报警（且徽章会显示已不再成立的状态），
   * 用一个 alive 标志把晚到的回包丢掉。
   */
  useEffect(() => {
    let alive = true
    const write = async (active: boolean): Promise<void> => {
      const result = await rpc<WireModeState>('roundtable/mode.set', { sessionId: String(sessionId), active })
      if (!alive) return
      if (result.ok) setModeState(result.value)
    }
    void write(true)
    // 挂载即写一次，同时把真值读回来 —— 徽章显示 host 的实际状态（命令开的
    // 模式也会因此在徽章上亮起），不是"我这次写成功了"的自证。
    return () => {
      alive = false
      void rpc<WireModeState>('roundtable/mode.set', { sessionId: String(sessionId), active: false })
        .then((result) => { if (result.ok) return result.value })
        .catch(() => undefined)
    }
  }, [rpc, sessionId])

  // 命令开的模式也要能亮：轮询真值（1 次/5 秒，只在页面可见时）。
  // 比 mode.set 的回包更权威 —— 用户可能在另一个 tab 里敲了 /roundtable off。
  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      if (document.visibilityState === 'hidden') return
      const result = await rpc<WireModeState>('roundtable/mode.get', { sessionId: String(sessionId) })
      if (!alive || !result.ok) return
      setModeState(result.value)
    }
    const timer = window.setInterval(() => { void tick() }, 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [rpc, sessionId])

  // Auto-dismiss the connect-result toast after a short beat.
  useEffect(() => {
    if (toast === null) return
    const timer = window.setTimeout(() => setToast(null), 3000)
    return () => window.clearTimeout(timer)
  }, [toast])

  // Selected meeting (kept stable while the polled list refreshes), falling
  // back to the first meeting when the selection is missing or unset.
  const meeting = meetings.find((candidate) => candidate.id === selectedId) ?? meetings[0]

  /**
   * R-D-UI：本会议里**已在场**的预设 id 集合。
   *
   * 由 host 在快照里以 `presetId` 精确关联（`MeetingNode.presetId`），客户端只做
   * 集合化 —— 不按 role 文本比对（那是猜，且会与 host 的判定漂移）。
   * 旧 host 不返回 `talentPool` 时为空集：此时面板仍显示预设清单，只是不打在场标记。
   */
  const onStagePresetIds = useMemo(
    () => new Set((meeting?.talentPool?.onStage ?? []).map((entry) => entry.presetId)),
    [meeting?.talentPool],
  )

  /**
   * 传给 `DispatchPanel` 的样式类（模块自己不知道 CSS Modules 长什么样）。
   * 逐字段显式列出：漏一个会在 typecheck 报错，而不是运行时静默丢样式。
   */
  const dispatchPanelStyles = {
    digestSectionTitle: styles.digestSectionTitle,
    kbRow: styles.kbRow,
    kbName: styles.kbName,
    kbMeta: styles.kbMeta,
    kbError: styles.kbError,
    logRow: styles.logRow,
    logHead: styles.logHead,
    logFrom: styles.logFrom,
    logTime: styles.logTime,
    logText: styles.logText,
    manageHint: styles.manageHint,
    panelEmpty: styles.panelEmpty,
  }

  // 用量是按会议取的（`usage.get` 收 `meetingId`），所以换会议必须清掉上一场的结果：
  // 否则 agents 面板会继续显示**上一场**的逐节点 token/耗时，而且没有任何"旧数据"标记，
  // 那些数字看起来仍然是权威的（第 4 轮验收：三席独立命中，F1）。
  useEffect(() => {
    setUsage(null)
    // 群聊记录同样按会议隔离：换会议不清，会显示成新会议的发言。
    setChatMessages([])
    setChatError('')
    setChatTruncated(false)
  }, [meeting?.id])

  /** 拉一次群聊全量（首次进入 / 换会议）。 */
  const loadTranscript = useCallback(async (meetingId: string): Promise<void> => {
    setChatLoading(true)
    try {
      // 截断标记来自 host（它才知道全量），客户端不拿本地页大小常量去猜：
      // 两份常量一旦不同步，「更早的发言未载入」会静默消失。见 wire.ts 的注释。
      const page = await fetchTranscript(rpc, meetingId)
      setChatMessages(page.messages)
      setChatTruncated(page.truncated)
      setChatError('')
    } catch (error: unknown) {
      setChatError(translate('chatLoadFailed').replace('{msg}', error instanceof Error ? error.message : String(error)))
    } finally {
      setChatLoading(false)
    }
  }, [rpc, translate])

  /**
   * 增量补齐：把 `since` 之后的新发言合并进本地列表。
   *
   * 抽成一个函数而不是在三处各写一遍合并逻辑 —— 那段逻辑有**两个容易写错的
   * 不变式**（按 id 去重、合完必须重新按 ts 升序），写三遍就有三份会漂移的拷贝。
   */
  const mergeSince = useCallback(async (meetingId: string, since: number): Promise<void> => {
    const page = await fetchTranscript(rpc, meetingId, { since })
    if (page.messages.length === 0) return
    setChatMessages((current) => {
      const seen = new Set(current.map((message) => message.id))
      const merged = [...current]
      for (const message of page.messages) {
        if (seen.has(message.id)) continue
        seen.add(message.id)
        merged.push(message)
      }
      merged.sort((a, b) => a.ts - b.ts)
      return merged
    })
  }, [rpc])

  // 进入群聊视图时拉一次全量；之后靠下面的增量补齐跟上新发言。
  // 依赖 `view` 而不是常开：拓扑视图下不产生任何额外请求（响应体积验收项）。
  useEffect(() => {
    if (view !== 'chat') return
    const meetingId = meeting?.id
    if (meetingId === undefined) return
    if (chatMessages.length > 0) return
    void loadTranscript(meetingId)
  }, [view, meeting?.id, chatMessages.length, loadTranscript])

  /**
   * 增量补齐：会话有新发言时只拉 `since=本地最新 ts` 的那一段。
   *
   * 为什么不用 `meeting.recent` 直接追加：`recent` 的正文被截到 90 字
   * （snapshot.ts 的 compactText），把它当消息体会让群聊显示半截话。
   * 所以新发言一律回 host 取全文，`recent` 只用来**判断"有没有新的"**。
   */
  const latestRecentTs = meeting?.recent?.[0]?.ts ?? 0
  const latestChatTs = chatMessages.length === 0 ? 0 : chatMessages[chatMessages.length - 1]!.ts
  useEffect(() => {
    if (view !== 'chat') return
    const meetingId = meeting?.id
    if (meetingId === undefined) return
    if (latestRecentTs <= latestChatTs) return
    // 不设 alive 标志的理由：合并走的是函数式 setState（updater），晚到的回包
    // 在卸载后是 no-op，不会像直接 setState 那样给 React 报警。
    void mergeSince(meetingId, latestChatTs).catch(() => undefined)
  }, [view, meeting?.id, latestRecentTs, latestChatTs, mergeSince])

  /** 群聊发送：落一条主持人口吻的用户发言（host 侧标 `source: 'user'`）。 */
  const sendChat = useCallback(async (text: string): Promise<void> => {
    const meetingId = meeting?.id
    if (meetingId === undefined || chatSending) return
    setChatSending(true)
    try {
      const result = await rpc<{ id: string; ts: number; delivered: boolean }>('roundtable/say', { meetingId, text })
      if (!result.ok) throw new Error(result.error.message)
      // 不做乐观插入：以 host 回包为准回读一次增量，避免"显示了但没落库"。
      await mergeSince(meetingId, latestChatTs)
      // 落盘 ≠ 送达。host 没能唤醒主持人（会议没有活 agent）时如实告知 ——
      // 否则用户看到气泡出现，会以为主持人一定会回应，然后一直等下去。
      setChatError(result.value.delivered ? '' : translate('chatNotDelivered'))
    } catch (error: unknown) {
      setChatError(translate('chatSendFailed').replace('{msg}', error instanceof Error ? error.message : String(error)))
    } finally {
      setChatSending(false)
    }
  }, [rpc, meeting?.id, chatSending, latestChatTs, mergeSince, translate])

  /**
   * 空状态窗口的输入框：把这句话交给主持人**开一场会议**。
   *
   * 与 `sendChat` 的分工：`sendChat` 要求会议已存在（往群里发言）；这里用在会议
   * 还不存在时 —— host 侧会先把该会话标记为讨论模式，再 steer 给主持人，主持人
   * 据此出设置卡片并拉起专家队伍。会议建好后由 1Hz 快照轮询自动带出来，前端
   * 不需要"建完自己插一条"的乐观逻辑。
   */
  const startMeeting = useCallback(async (text: string): Promise<void> => {
    if (steerSending) return
    setSteerSending(true)
    try {
      await steerSession(rpc, String(sessionId), text)
      setSteerError('')
    } catch (error: unknown) {
      setSteerError(translate('chatSendFailed').replace('{msg}', error instanceof Error ? error.message : String(error)))
    } finally {
      setSteerSending(false)
    }
  }, [rpc, sessionId, steerSending, translate])

  // E1：会议结束（status ended）且反馈开启、本会议尚未问过 → 弹轻量反馈。
  useEffect(() => {
    if (meeting === undefined || !feedbackEnabled) return
    if (meeting.status !== 'ended') return
    if (askFeedbackFor !== null) return
    if (askedFeedback.has(meeting.id)) return
    // 带评审的会议在评审窗口关闭后仍属 ended；统一在 ended 时问一次即可。
    setAskFeedbackFor(meeting.id)
    setFeedbackNote('')
  }, [meeting, feedbackEnabled, askedFeedback, askFeedbackFor])

  const markFeedbackAsked = (meetingId: string): void => {
    const next = new Set(askedFeedback)
    next.add(meetingId)
    setAskedFeedback(next)
    try {
      window.localStorage.setItem('roundtable:feedback-asked', JSON.stringify([...next]))
    } catch {
      // Storage unavailable: keep in-memory only.
    }
  }

  // 提交反馈（E1/E3）：匿名结构化字段 + 可选一句说明。
  const submitFeedback = (rating: 'good' | 'meh' | 'bad'): void => {
    if (meeting === undefined || askFeedbackFor === null) return
    const target = meetings.find((candidate) => candidate.id === askFeedbackFor)
    const note = feedbackNote.trim()
    void rpc<{ id: string }>('roundtable/feedback.append', {
      meetingId: askFeedbackFor,
      mode: target?.mode ?? meeting.mode,
      providers: target?.nodes.map((node) => node.provider).filter((value) => value !== '') ?? [],
      models: target?.nodes.map((node) => node.model).filter((value) => value !== '') ?? [],
      usedRounds: target?.budget.usedRounds ?? 0,
      usedTokens: target?.budget.usedTokens ?? 0,
      rating,
      note: note === '' ? undefined : note,
    })
      .then((result) => {
        if (result.ok) {
          markFeedbackAsked(askFeedbackFor)
          setAskFeedbackFor(null)
          setToast({ kind: 'ok', text: translate('feedbackAskSubmitted') })
        } else {
          setToast({ kind: 'err', text: result.error?.message ?? translate('feedbackAskFailed') })
        }
      })
      .catch(() => setToast({ kind: 'err', text: translate('feedbackAskFailed') }))
  }

  // 针锋相对：评审就绪（status=ready）时自动弹出评审窗口（每会议只自动弹一次）。
  useEffect(() => {
    if (meeting === undefined) return
    const review = meeting.review
    if (review !== null && review.status === 'ready' && reviewAutoShown.current !== meeting.id) {
      reviewAutoShown.current = meeting.id
      setReviewOpen(true)
    }
  }, [meeting])

  // 用户对观点表态（V0.2.2 三态：支持/驳回/取消；本地即时更新，RPC 持久化+通知主持人）。
  // 驳回必填理由（C2）：status='rejected' 时 rejectReason 必须非空，否则 RPC 拒绝。
  const setViewpointStatus = (viewpointId: string, status: 'pending' | 'endorsed' | 'rejected', rejectReason?: string): void => {
    if (meeting === undefined) return
    void rpc<{ changed: boolean; status: string }>('roundtable/review.setStatus', {
      meetingId: meeting.id,
      viewpointId,
      status,
      reject_reason: status === 'rejected' ? rejectReason : undefined,
    })
      .then((result) => {
        if (result.ok) {
          setMeetings((previous) => previous.map((candidate) => {
            if (candidate.id !== meeting.id || candidate.review === null) return candidate
            return {
              ...candidate,
              review: {
                ...candidate.review,
                viewpoints: candidate.review.viewpoints.map((viewpoint) =>
                  viewpoint.id === viewpointId
                    ? {
                        ...viewpoint,
                        status,
                        endorsed: status === 'endorsed',
                        rejected: status === 'rejected',
                        rejectReason: status === 'rejected' ? rejectReason : viewpoint.rejectReason,
                      }
                    : viewpoint,
                ),
              },
            }
          }))
          setToast({
            kind: 'ok',
            text: status === 'endorsed'
              ? translate('reviewSupportedToast')
              : status === 'rejected'
                ? translate('reviewRejectedToast')
                : translate('reviewPendingToast'),
          })
        } else {
          setToast({ kind: 'err', text: result.error?.message ?? translate('reviewEndorseFailed') })
        }
      })
      .catch(() => setToast({ kind: 'err', text: translate('reviewEndorseFailed') }))
  }

  const positions = useMemo(
    () => meeting === undefined ? new Map<string, Point>() : layoutPositions(size, meeting),
    [meeting, size],
  )

  // Top-layer delete dots for REAL edges: positioned at each edge's bezier
  // midpoint but rendered ABOVE the nodes (the SVG layer sits under the nodes,
  // so a dot at a midpoint that lands inside a node would be hidden). Shown
  // while that edge is hovered, and never for synthetic implied edges.
  const edgeRemoveDots = useMemo(() => {
    if (meeting === undefined) return []
    const dots: { id: string; cx: number; cy: number }[] = []
    for (const edge of meeting.edges) {
      if (edge.implicit === true) continue
      const geo = edgeCurveGeometry(edge, meeting, positions)
      if (geo === null) continue
      dots.push({ id: edge.id, cx: geo.mx, cy: geo.my })
    }
    return dots
  }, [meeting, positions])

  // Drag-to-connect: follow the pointer and drop on a target node. All drag
  // coordinates are canvas-relative (node positions are canvas-relative too),
  // so the free end tracks the cursor exactly instead of drifting to a
  // self-chosen endpoint.
  //
  // Drop targeting is COORDINATE-based: we pick the nearest node position to
  // the release point (within a radius). This is robust against the cursor
  // landing on an edge path or port dot — DOM closest()/elementFromPoint can
  // miss the node under a line, which is exactly why user↔pm wiring failed
  // silently before. Coordinate hit-testing cannot be blocked by a line.
  useEffect(() => {
    if (drag === null) return
    const move = (event: MouseEvent): void => {
      const rect = containerRef.current?.getBoundingClientRect()
      const x = rect === undefined ? event.clientX : event.clientX - rect.left
      const y = rect === undefined ? event.clientY : event.clientY - rect.top
      setDrag((previous) => previous === null ? null : { ...previous, x, y })
    }
    const up = (event: MouseEvent): void => {
      const from = drag.from
      const meetingId = drag.meetingId
      const x = drag.x
      const y = drag.y
      setDrag(null)
      // Find the nearest node to the release point within a generous radius.
      let bestKey: string | null = null
      let bestDist = Number.POSITIVE_INFINITY
      const hitRadius = 70
      for (const [key, point] of positions) {
        const dist = Math.hypot(point.x - x, point.y - y)
        if (dist < bestDist) {
          bestDist = dist
          bestKey = key
        }
      }
      const to = bestKey
      if (to === null || to === from || bestDist > hitRadius) return
      void rpc<unknown>('roundtable/edge.add', { meetingId, from, to, direction: 'forward' })
        .then((result) => {
          if (result.ok) {
            // 单线制下"连线"不改变通信权限，所以成功 toast 必须说清它到底成功的是什么，
            // 否则拖完一条专家↔专家的线会得到"已连接"，用户据此以为改动了权限（批次 A/B 遗留）。
            const template = meeting?.mode === 'egalitarian' ? 'edgeConnected' : 'edgeConnectedSingleLine'
            setToast({ kind: 'ok', text: translate(template).replace('{from}', from).replace('{to}', to) })
            void refresh()
          } else {
            setToast({ kind: 'err', text: result.error?.message ?? '连线失败' })
          }
        })
        .catch(() => setToast({ kind: 'err', text: '连线失败：无法连接会议服务' }))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [drag, refresh, rpc, positions, meeting?.mode])

  // Recent messages (≤3s old) drive a one-shot flow pulse along their edge.
  const activeMessages = useMemo(() => {
    if (meeting === undefined) return []
    const cutoff = Date.now() - 3000
    return (meeting.messages ?? []).filter((message) => message.ts >= cutoff).slice(0, 4)
  }, [meeting])

  const handleEdgeAction = useCallback((action: 'forward' | 'bidirectional' | 'remove'): void => {
    if (menu === null) return
    if (action === 'remove') {
      void rpc<unknown>('roundtable/edge.remove', { meetingId: menu.meetingId, edgeId: menu.edge.id })
        .then(() => refresh())
        .catch(() => undefined)
    } else {
      void rpc<unknown>('roundtable/edge.set', { meetingId: menu.meetingId, edgeId: menu.edge.id, direction: action })
        .then(() => {
          // 显式确认（批次 B ⑦）：原先只重画线型、没有任何文字反馈，
          // 用户点完"设为双向"不确定是否生效。refresh() 本来就有（:629/:633）。
          setToast({ kind: 'ok', text: translate(action === 'bidirectional' ? 'edgeSetBidirectional' : 'edgeSetForward') })
          refresh()
        })
        .catch(() => undefined)
    }
    setMenu(null)
  }, [menu, refresh, rpc])

  // ---- Knowledge-base (阅览版) -----------------------------------------
  // The KB is a plain folder on disk: the UI only shows the path and lists
  // the first level (names/formats/sizes). File contents are never opened in
  // the UI — the captain reads and relays them to experts on demand.
  const loadKbList = useCallback((path: string): void => {
    if (meeting === undefined || path === '') return
    void rpc<WireKbListing>('roundtable/kb.list', { meetingId: meeting.id })
      .then((result) => {
        if (result.ok) {
          setKbListing(result.value)
        } else {
          setKbListing({ path: '', configured: false, error: result.error?.message ?? 'kb list failed', files: [] })
        }
      })
      .catch(() => setKbListing({ path: '', configured: false, error: 'kb list failed', files: [] }))
  }, [meeting, rpc])

  const openKb = (): void => {
    setKbOpen(true)
    setKbPathInput(meeting?.kbPath ?? '')
    setKbListing(null)
    if (meeting !== undefined && meeting.kbPath !== '') loadKbList(meeting.kbPath)
  }

  const closeKb = (): void => {
    setKbOpen(false)
    setKbListing(null)
  }

  // Save the KB path (validated on the host), record the change for the
  // captain (user-action kb-path), then refresh the listing. Checking
  // "已修改知识库部分内容" additionally records that file contents changed so
  // the captain re-browses to refresh its understanding.
  const saveKbPath = (): void => {
    if (meeting === undefined) return
    const path = kbPathInput.trim()
    if (path === '') {
      setToast({ kind: 'err', text: translate('kbPathRequired') })
      return
    }
    void rpc<{ path: string }>('roundtable/kb.path.set', { meetingId: meeting.id, path })
      .then((result) => {
        if (!result.ok) {
          setToast({ kind: 'err', text: result.error?.message ?? translate('kbSaveFailed') })
          return
        }
        const saved = result.value.path
        const actions: { kind: 'kb-path'; text: string }[] = [{ kind: 'kb-path', text: `修改了知识库路径为 ${saved}` }]
        void Promise.allSettled(actions.map((action) => rpc<unknown>('roundtable/user-actions.append', {
          meetingId: meeting.id,
          kind: action.kind,
          text: action.text,
        }))).then(() => {
          setToast({ kind: 'ok', text: translate('kbSaved') })
          setKbPathInput(saved)
          loadKbList(saved)
          void refresh()
        })
      })
      .catch(() => setToast({ kind: 'err', text: translate('kbSaveFailed') }))
  }

  // Pending expert edits derived from the meeting's user-actions file: keys
  // queued for removal (still in the roster, awaiting the captain) and keys
  // queued for addition (not yet in the roster). The UI marks both so the
  // user sees "下一轮生效" instead of the action silently doing nothing.
  const pendingAddKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const action of meeting?.pendingActions ?? []) {
      if (action.kind === 'add-node' && action.nodeKey !== '') keys.add(action.nodeKey)
    }
    return keys
  }, [meeting])
  const pendingRemoveKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const action of meeting?.pendingActions ?? []) {
      if (action.kind === 'remove-node' && action.nodeKey !== '') keys.add(action.nodeKey)
    }
    return keys
  }, [meeting])
  const pendingActionCount = (meeting?.pendingActions ?? []).length

  // 生效信号（批次 A ⑩）：待办从 >0 归零 = 主持人已执行 → 一次性提示。
  // 复用快照 1s 轮询推导出的 pendingActionCount，不需要任何新通道。
  const prevPendingCount = useRef(0)
  useEffect(() => {
    const prev = prevPendingCount.current
    prevPendingCount.current = pendingActionCount
    if (prev > 0 && pendingActionCount === 0) {
      setToast({ kind: 'ok', text: translate('manageActionsApplied') })
    }
  }, [pendingActionCount, translate])

  const openManage = (): void => {
    setManageOpen(true)
    setModelsLoaded(false)
    // B3+：表单为空时用**缺省预设**预填（单一缺省值语义）；没有缺省就保持空表单。
    // 预填走 applyPreset（唯一填充点），不在此处另抄一份字段映射。
    const fallback = presetList.find((preset) => preset.id === defaultPresetId)
    if (fallback !== undefined) applyPreset(fallback.id)
    void rpc<WireModelCatalog>('roundtable/models.list', {})
      .then((result) => {
        if (result.ok && Array.isArray(result.value.providers)) setProviders(result.value.providers)
        setModelsLoaded(true)
      })
      .catch(() => setModelsLoaded(true))
  }

  /**
   * 批次 B ⑤：**按需**拉逐节点用量（provider 上报真实值 + transcript 口径耗时）。
   * 刻意不进 1s 快照：host 侧 `sessionProjections.snapshot()` 会物化投影，
   * 每秒对每个专家折叠一次日志是不可接受的成本。
   */
  const loadUsage = (): void => {
    if (meeting === undefined) return
    setUsageLoading(true)
    void rpc<WireUsage>('roundtable/usage.get', { meetingId: meeting.id })
      .then((result) => {
        setUsageLoading(false)
        if (result.ok) setUsage(result.value)
        else setToast({ kind: 'err', text: result.error?.message ?? translate('usageFailed') })
      })
      .catch(() => {
        setUsageLoading(false)
        setToast({ kind: 'err', text: translate('usageFailed') })
      })
  }

  const closeManage = (): void => {
    setManageOpen(false)
    setForm({ name: '', role: '', provider: '', model: '', reasoningEffort: '' })
    setSelectedPresetId('')
  }

  // 第 4 轮验收缺口：三个 `role="dialog"` 弹窗此前只能点遮罩或关闭按钮退出
  // （`src/client` 全目录 `Escape|keydown|onKeyDown` 零命中）。Esc 关闭是最小可验证
  // 的一步；focus trap / 焦点回位**仍挂账**，不与本次混做（键盘行为回归难归因）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // 一次只关最上层：评审 > 专家管理 > 知识库（与 DOM 中的叠加顺序相反）。
      if (reviewOpen) {
        setReviewOpen(false)
        return
      }
      if (manageOpen) {
        closeManage()
        return
      }
      if (kbOpen) closeKb()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [reviewOpen, manageOpen, kbOpen, closeManage, closeKb])

  // Queue an expert removal: only the user-actions file is written; the
  // captain performs roundtable_remove_node next round.
  const queueRemove = (node: WireNode): void => {
    const confirmed = window.confirm(translate('manageRemoveConfirm').replace('{name}', node.key))
    if (!confirmed) return
    const text = `删除了专家 ${node.key}`
    void rpc<unknown>('roundtable/user-actions.append', {
      meetingId: meeting?.id,
      kind: 'remove-node',
      nodeKey: node.key,
      text,
    })
      .then((result) => {
        if (result.ok) {
          setToast({ kind: 'ok', text: translate('manageRemovedSoon').replace('{name}', node.key) })
          void refresh()
        } else {
          setToast({ kind: 'err', text: result.error?.message ?? translate('manageQueueFailed') })
        }
      })
      .catch(() => setToast({ kind: 'err', text: translate('manageQueueFailed') }))
  }

  // Queue an expert addition: written to the user-actions file; the captain
  // spawns the node (roundtable_add_node) next round. Empty model = inherit
  // the captain's current route.
  const submitAdd = (): void => {
    if (meeting === undefined) return
    const key = sanitizeKey(form.name)
    if (key === '') {
      setToast({ kind: 'err', text: translate('manageNameRequired') })
      return
    }
    const exists = meeting.nodes.some((node) => node.key === key && node.status !== 'removed')
    const queued = pendingAddKeys.has(key)
    if (exists || queued) {
      setToast({ kind: 'err', text: translate('manageNameTaken').replace('{name}', key) })
      return
    }
    const role = form.role.trim()
    const provider = form.provider
    const model = form.model
    const reasoningEffort = form.reasoningEffort.trim()
    const effortSuffix = reasoningEffort === '' ? '' : ` @ ${reasoningEffort}`
    const text = `新增了专家 ${key}${role !== '' ? `（角色：${role}）` : ''}${provider !== '' ? `，模型 ${provider}/${model}${effortSuffix}` : '，使用主持人默认模型'}`
    void rpc<unknown>('roundtable/user-actions.append', {
      meetingId: meeting.id,
      kind: 'add-node',
      nodeKey: key,
      role,
      provider,
      model,
      // 档位必须走**结构化字段**：只塞进 text 会让主持人只能靠解析自然语言取它，
      // 静默丢失是必然的（且这份 text 正是第二份真相的来源）。
      reasoningEffort,
      text,
    })
      .then((result) => {
        if (result.ok) {
          setToast({ kind: 'ok', text: translate('manageAddedSoon').replace('{name}', key) })
          setForm({ name: '', role: '', provider: '', model: '', reasoningEffort: '' })
          setSelectedPresetId('')
          void refresh()
        } else {
          setToast({ kind: 'err', text: result.error?.message ?? translate('manageQueueFailed') })
        }
      })
      .catch(() => setToast({ kind: 'err', text: translate('manageQueueFailed') }))
  }

  const handleProviderChange = (provider: string): void => {
    // 换路由 ⇒ 档位一并清空（旧档位可能不在新模型的词表里）。
    setForm((previous) => ({ ...previous, provider, model: '', reasoningEffort: '' }))
  }

  /** 专家管理表单当前所选模型声明的档位词表（与设置页同一个数据契约）。 */
  const formEfforts = (): { id: string; name: string; description?: string }[] => {
    const provider = providers.find((candidate) => candidate.id === form.provider)
    const model = provider?.models.find((candidate) => candidate.id === form.model)
    return model?.reasoning?.efforts ?? []
  }

  /**
   * B3：选中预设 → 填充 role/provider/model/reasoningEffort；专家 key 仍由用户自己填。
   *
   * **唯一填充点**：缺省预设预填也走这里，不另写第二份（两份会各自漂移）。
   */
  const applyPreset = (id: string): void => {
    setSelectedPresetId(id)
    const preset = presetList.find((candidate) => candidate.id === id)
    if (preset === undefined) return
    setForm((previous) => ({
      ...previous,
      role: preset.role,
      provider: preset.provider ?? '',
      model: preset.model ?? '',
      reasoningEffort: preset.reasoningEffort ?? '',
    }))
  }

  if (meeting === undefined) {
    return (
      <div className={styles.root}>
        <div className={styles.main}>
          <div className={styles.emptyState}>
            <div className={styles.emptyTitle}>{translate('empty')}</div>
            <div className={styles.emptyHint}>{translate('emptyHint')}</div>
            {/* 输入框与群聊窗口**是同一个组件**（用户要求）：在这里打字等于给
                这个会话开一场会议 —— 语义与 `/roundtable <议题>` 一致。 */}
            <div className={styles.emptyComposer}>
              <ChatComposer
                t={translate}
                sending={steerSending}
                onSend={(text) => { void startMeeting(text) }}
                placeholderKey="emptyInputPlaceholder"
              />
            </div>
            {steerError !== '' ? <div className={styles.fetchFailed}>{steerError}</div> : null}
            {fetchFailed === true ? <div className={styles.fetchFailed}>{translate('fetchFailed')}</div> : null}
          </div>
        </div>
      </div>
    )
  }

  const modeLabel = meeting.mode === 'egalitarian'
    ? translate('modeEgalitarian')
    : meeting.mode === 'redteam'
      ? translate('modeRedteam')
      : translate('modeOrchestrated')
  const roundsPct = meeting.budget.maxRounds <= 0 ? 0
    : Math.min(100, (meeting.budget.usedRounds / meeting.budget.maxRounds) * 100)
  const tokensPct = meeting.budget.maxTokens <= 0 ? 0
    : Math.min(100, (meeting.budget.usedTokens / meeting.budget.maxTokens) * 100)

  const renderEdge = (edge: WireEdge): JSX.Element | null => {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (from === undefined || to === undefined) return null
    // host 已在快照里判定 implicit / deliverable，客户端不再解析 id 前缀
  // （旧写法 `id.startsWith('synthetic:')` 是"同一事实两个判定者"）。
  const synthetic = edge.implicit === true

    // Bundle edges by shared origin so a hub's outgoing wires fan out like
    // ribs from the same rim point instead of stabbing every direction; this
    // is the "start from one anchor, split toward many ends" look. We offset
    // each edge's start tangent by its index within the origin's bundle.
    const fromDegree = meeting.edges.reduce((n, e) => n + (e.from === edge.from ? 1 : 0), 0)
    const fromIndex = meeting.edges.filter((e) => e.from === edge.from).findIndex((e) => e.id === edge.id)
    const toDegree = meeting.edges.reduce((n, e) => n + (e.to === edge.to ? 1 : 0), 0)
    const toIndex = meeting.edges.filter((e) => e.to === edge.to).findIndex((e) => e.id === edge.id)

    // Directional unit vector source -> target.
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len = Math.max(1, Math.hypot(dx, dy))
    const ux = dx / len
    const uy = dy / len
    // Start tangent: base direction plus a per-index fan offset (radians).
    // For the big hubs (captain/aggregator) we COLLAPSE the outlet into a
    // narrow band pointed toward the target instead of fanning all around the
    // node — that is the "one bus, splitting outward" look the cap wants, so
    // five lines leave the captain as a clean radiated bundle rather than
    // stabbing in five directions. Expert↔expert edges keep the small fan.
    const hubFrom = edge.from === 'captain' || edge.from === 'aggregator'
    const hubTo = edge.to === 'captain' || edge.to === 'aggregator'
    const startAngle = Math.atan2(uy, ux)
      + (hubFrom ? (fromIndex - (fromDegree - 1) / 2) * 0.09 : fromDegree > 1 ? (fromIndex - (fromDegree - 1) / 2) * 0.16 : 0)
    const endAngle = Math.atan2(uy, ux)
      + (hubTo ? (toIndex - (toDegree - 1) / 2) * 0.09 : toDegree > 1 ? (toIndex - (toDegree - 1) / 2) * 0.16 : 0)

    // Pull the two anchors back to the node rim (NODE_RADIUS).
    const x1 = from.x + Math.cos(startAngle) * NODE_RADIUS
    const y1 = from.y + Math.sin(startAngle) * NODE_RADIUS
    const x2 = to.x + Math.cos(endAngle) * NODE_RADIUS
    const y2 = to.y + Math.sin(endAngle) * NODE_RADIUS

    const head = arrowPoints(x2, y2, endAngle)
    const tail = edge.direction === 'bidirectional' ? arrowPoints(x1, y1, startAngle + Math.PI) : null

    // Quadratic bezier with a larger bow so the mid-point clears other nodes,
    // reducing the "line hidden behind a node" clutter.
    const midX = (x1 + x2) / 2
    const midY = (y1 + y2) / 2
    const nx = -(y2 - y1)
    const ny = x2 - x1
    const nlen = Math.max(1, Math.hypot(nx, ny))
    const bow = synthetic ? 0.2 : 0.24
    const cx = midX + (nx / nlen) * nlen * bow
    const cy = midY + (ny / nlen) * nlen * bow
    const path = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`

    // Role-based coloring: captain-outbound wires use a warm accent so the
    // captain reads as the single source "all lines come from here" (a bus),
    // aggregator wires a cool accent, and expert↔expert wires stay neutral.
    const involvesCaptain = edge.from === 'captain' || edge.to === 'captain'
    const involvesAggregator = edge.from === 'aggregator' || edge.to === 'aggregator'
    const roleClass = synthetic
      ? (involvesCaptain ? styles.edgeSyntheticCaptain : involvesAggregator ? styles.edgeSyntheticAggregator : styles.edgeSynthetic)
      : (involvesCaptain ? styles.edgeCaptain : involvesAggregator ? styles.edgeAggregator : edge.direction === 'bidirectional' ? styles.edgeBidirectional : styles.edgeForward)
    const arrowClass = synthetic
      ? (involvesCaptain ? styles.edgeArrowSyntheticCaptain : involvesAggregator ? styles.edgeArrowSyntheticAggregator : styles.edgeArrowSynthetic)
      : (involvesCaptain ? styles.edgeArrowCaptain : involvesAggregator ? styles.edgeArrowAggregator : styles.edgeArrow)
    // host 侧已判定这条通道**能不能真投递**（`deliverable`）。单线制下专家↔专家的线
    // 只是"转达顺序"的可视化、不能投递 —— 必须让用户看得出来，否则拖完弹"已连接"
    // 会让人误以为改动了通信权限。（第 4 轮验收：该字段此前是"只写不读"的中间值。）
    const undeliverable = edge.deliverable === false
    const wireClass = undeliverable ? `${roleClass} ${styles.edgeUndeliverable}` : roleClass
    return (
      <g
        key={edge.id}
        className={styles.edgeGroup}
        onMouseEnter={() => setHoverEdge(edge.id)}
        onMouseLeave={() => clearHoverEdge(edge.id)}
        onContextMenu={(event) => {
          if (synthetic) return
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY, meetingId: meeting.id, edge })
        }}
      >
        {undeliverable ? <title>{translate('edgeUndeliverableHint')}</title> : null}
        <path d={path} fill="none" className={wireClass} />
        <polygon points={head} className={arrowClass} />
        {tail !== null ? <polygon points={tail} className={arrowClass} /> : null}
      </g>
    )
  }

  const renderNode = (key: string, label: string, kind: 'captain' | 'aggregator' | 'node'): JSX.Element | null => {
    const point = positions.get(key)
    if (point === undefined) return null
    const node = kind === 'node' ? meeting.nodes.find((candidate) => candidate.key === key) : undefined
    const removed = kind === 'node' && (node?.status === 'removed' || node?.activity === 'removed')
    const breathing = kind === 'node' && !removed && node?.activity === 'running'
    const brand = kind === 'node' && node !== undefined ? providerBrand(node.provider) : null
    // Convert a screen-space pointer to canvas-relative coordinates. The
    // topology canvas is absolutely-positioned inside the conversation slot, so
    // `clientX/clientY` must be offset by the canvas bounding rect — otherwise
    // the free end of a dragged connector flies off on its own instead of
    // tracking the cursor. This is the bug that made "拉线终点不跟鼠标".
    const startDrag = (clientX: number, clientY: number): void => {
      const rect = containerRef.current?.getBoundingClientRect()
      const x = rect === undefined ? clientX : clientX - rect.left
      const y = rect === undefined ? clientY : clientY - rect.top
      setDrag({ from: key, meetingId: meeting.id, x, y })
    }
    return (
      <div
        key={key}
        data-rt-key={key}
        data-rt-meeting={meeting.id}
        className={[
          styles.node,
          kind === 'captain' ? styles.captainNode : '',
          kind === 'aggregator' ? styles.aggregatorNode : '',
          removed ? styles.nodeRemoved : '',
          breathing ? styles.breathing : '',
        ].filter(Boolean).join(' ')}
        style={{ left: point.x, top: point.y }}
        title={node === undefined ? label : `${label}${node.role !== '' ? ` · ${node.role}` : ''}`}
      >
        {brand !== null ? brandAvatar(brand, 'node') : null}
        <div className={styles.nodeLabel}>{label}</div>
        {kind === 'node' ? (
          <div className={styles.nodeMeta}>
            {node?.activity === 'running' ? translate('activityRunning') : ''}
          </div>
        ) : null}
        {/* Connection ports: a small hit-dot on each side of the node, like a
            Dify workflow port. Drag from one to wire a directed edge. The dots
            sit on the node rim so the wire visibly "grows out of" the expert. */}
        {(['n', 'e', 's', 'w'] as const).map((dir) => (
          <div
            key={dir}
            className={`${styles.port} ${styles[`port${dir.toUpperCase()}`]}`}
            role="button"
            tabIndex={0}
            aria-label={translate('portConnect')}
            data-port-dir={dir}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              startDrag(event.clientX, event.clientY)
            }}
          />
        ))}
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <div className={[styles.main, view === 'chat' ? styles.mainChat : ''].filter(Boolean).join(' ')} data-rt-view={view}>
        <div className={styles.viewTabs} role="tablist" aria-label={translate('viewTopology')}>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'topology'}
            className={[styles.viewTab, view === 'topology' ? styles.viewTabActive : ''].filter(Boolean).join(' ')}
            onClick={() => setView('topology')}
          >
            {translate('viewTopology')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'chat'}
            className={[styles.viewTab, view === 'chat' ? styles.viewTabActive : ''].filter(Boolean).join(' ')}
            onClick={() => setView('chat')}
          >
            {translate('viewChat')}
          </button>
        </div>
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <span className={styles.meetingName}>{meeting.name}</span>
            {meetings.length > 1 ? (
              <select
                className={styles.meetingSelect}
                value={meeting.id}
                onChange={(event) => setSelectedId(event.target.value)}
                aria-label={translate('meetingSelect')}
              >
                {meetings.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {sourcePrefix(candidate.captainSessionId)} · {candidate.name}
                  </option>
                ))}
              </select>
            ) : null}
            <span className={styles.badge}>{modeLabel}</span>
            <span className={styles.badge}>{meeting.status}</span>
            <span className={styles.round}>{translate('round')} {meeting.round}</span>
            {/* 讨论模式徽章（E 功能）：本 tab 打开即亮；命令开的模式也会亮。
                `null` = 还没问到 host，先不画 —— 不闪假状态。 */}
            {modeState === null ? null : (
              <span
                className={[styles.modeBadge, modeState.active ? styles.modeBadgeOn : ''].filter(Boolean).join(' ')}
                title={modeState.active ? translate('modeOnHint') : translate('modeOffHint')}
              >
                {modeState.active ? translate('modeOn') : translate('modeOff')}
                {modeState.manual ? <span className={styles.modeBadgeManual}>{translate('modeViaCommand')}</span> : null}
              </span>
            )}
            {meeting.review !== null ? (
              <button
                type="button"
                className={styles.reviewBadge}
                title={translate('reviewOpen')}
                onClick={() => setReviewOpen(true)}
              >
                {translate('reviewBadge')}
                {meeting.review.status === 'ready'
                  ? ` · ${meeting.review.viewpoints.length}`
                  : meeting.review.status === 'done'
                    ? ` · ${translate('reviewStatusDone')}`
                    : ` · ${translate('reviewStatusReviewing')}`}
              </button>
            ) : null}
          </div>
          <div className={styles.budgetRow}>
            <span className={styles.budgetLabel}>{translate('roundsBudget')}</span>
            <div className={styles.budgetBar}>
              <div className={styles.budgetFill} style={{ width: `${roundsPct}%` }} />
            </div>
            <span className={styles.budgetValue}>{meeting.budget.usedRounds}/{meeting.budget.maxRounds}</span>
            <span className={styles.budgetLabel}>{translate('tokensBudget')}</span>
            <div className={styles.budgetBar}>
              <div className={styles.budgetFillTokens} style={{ width: `${tokensPct}%` }} />
            </div>
            {/* 口径标注（批次 A ⑫）：只挂 title，不改共用标签（`tokensBudget`
                同时渲染在设置页，改它会把设置页一起改掉）。 */}
            <span className={styles.budgetValue} title={translate('tokensBudgetHint')}>
              {meeting.budget.usedTokens}/{meeting.budget.maxTokens}
            </span>
          </div>
          {meeting.pendingDecisions.length > 0 ? (
            <div className={styles.decisionBanner}>
              <span className={styles.decisionTag}>{translate('pendingDecision')}</span>
              {meeting.pendingDecisions.map((decision) => (
                <span key={decision.id} className={styles.decisionQuestion}>
                  {decision.question}
                  {decision.options.length > 0 ? `（${translate('pendingDecisionOptions')}：${decision.options.join(' / ')}）` : ''}
                </span>
              ))}
              {/* 指路句（批次 A ⑨）：**刻意不加按钮** —— 回答决策的 RPC 不存在，
                  加了就是第二个"点了没反应"的假入口。 */}
              <span className={styles.decisionHint}>{translate('pendingDecisionHint')}</span>
            </div>
          ) : null}
        </div>
        {view === 'topology' ? (
          <>
        <div ref={containerRef} className={[styles.canvas, drag !== null ? styles.canvasDragging : ''].filter(Boolean).join(' ')}>
          <svg className={styles.edgeLayer} width={size.w > 0 ? size.w : 900} height={size.h > 0 ? size.h : 480}>
            {meeting.edges.map(renderEdge)}
            {drag !== null && positions.get(drag.from) !== undefined ? (
              (() => {
                const start = positions.get(drag.from)
                if (start === undefined) return null
                const end = { x: drag.x, y: drag.y }
                const midX = (start.x + end.x) / 2
                const midY = (start.y + end.y) / 2
                const nx = -(end.y - start.y)
                const ny = end.x - start.x
                const len = Math.max(1, Math.hypot(nx, ny))
                const bow = 0.14
                const cx = midX + (nx / len) * len * bow
                const cy = midY + (ny / len) * len * bow
                const d = `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`
                return <path d={d} fill="none" className={styles.dragLine} />
              })()
            ) : null}
          </svg>
          {renderNode('captain', 'DeepSeek · 主持', 'captain')}
          {renderNode('aggregator', '汇聚网关', 'aggregator')}
          {meeting.nodes.filter((node) => node.status !== 'removed').map((node) => renderNode(node.key, node.key, 'node'))}
          {edgeRemoveDots.map((dot) => (
            <button
              key={dot.id}
              type="button"
              className={[styles.edgeRemove, hoverEdgeId === dot.id ? styles.edgeRemoveActive : ''].filter(Boolean).join(' ')}
              style={{ left: dot.cx, top: dot.cy }}
              aria-label={translate('edgeRemove')}
              onMouseEnter={() => setHoverEdge(dot.id)}
              onMouseLeave={() => clearHoverEdge(dot.id)}
              onClick={() => {
                void rpc<unknown>('roundtable/edge.remove', { meetingId: meeting.id, edgeId: dot.id })
                  .then(() => refresh())
                  .catch(() => undefined)
              }}
            >
              ×
            </button>
          ))}
          {activeMessages.map((message) => {
            const from = positions.get(message.from)
            const to = positions.get(message.to)
            if (from === undefined || to === undefined) return null
            return <div key={message.id} className={styles.msgPulse} style={flowStyle(from, to)} />
          })}
          {/* 常驻图例（批次 A ⑧）：复用时层覆盖，不占侧栏、不加面板。
              单线制下"连线 = 通信权限"是错的直觉，必须常驻说清。 */}
          <div className={styles.legend}>
            <span className={styles.legendTitle}>{translate('edgeLegend')}</span>
            <span className={styles.legendText}>
              {translate(meeting.mode === 'egalitarian' ? 'edgeScopeHintEgalitarian' : 'edgeScopeHint')}
            </span>
          </div>
          {toast !== null ? (
            <div className={styles.toast}>
              <span className={toast.kind === 'ok' ? styles.toastOk : styles.toastErr}>{toast.text}</span>
            </div>
          ) : null}
        </div>
          </>
        ) : null}
        {/* 发言时间轴（批次 B ③）：原 activity 面板的**唯一独占信息**是时间戳
            （digest 由 aggregator 产出、不含时间），故并进摘要区作第二视图。
            ⚠ 群聊视图下**不渲染**这一段：群聊窗口已经用气泡+时间展示了同一批发言，
            两处并列就是同一份信息的第二份拷贝（抗堆叠）。时间戳信息不丢 ——
            群聊气泡自带完整时间，这里只是在群聊视图下让位。 */}
        {view === 'topology' ? (
        <details className={styles.digest}>
          <summary>{translate('gatewayDigest')}</summary>
          <pre className={styles.digestBody}>{meeting.digest || translate('noDigest')}</pre>
          <div className={styles.digestSectionTitle}>{translate('activity')}</div>
          {(meeting.recent ?? []).length === 0 ? (
            <div className={styles.panelEmpty}>{translate('noActivity')}</div>
          ) : (meeting.recent ?? []).map((utterance) => (
            <div className={styles.logRow} key={utterance.id}>
              <div className={styles.logHead}>
                <span className={styles.logFrom}>{utterance.from} → {utterance.to}</span>
                <span className={styles.logTime}>
                  {new Date(utterance.ts).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
              </div>
              <div className={styles.logText}>{utterance.text}</div>
            </div>
          ))}
        </details>
        ) : (
        <ChatView
          meeting={meeting}
          messages={chatMessages}
          truncated={chatTruncated}
          loading={chatLoading}
          error={chatError}
          sending={chatSending}
          t={translate}
          brandOf={providerBrand}
          onSend={(text) => { void sendChat(text) }}
        />
        )}
      </div>

      <aside className={styles.sidebar}>
        <div className={styles.sidebarActions}>
          {pendingActionCount > 0 ? (
            <span className={styles.pendingBadge} title={translate('manageEffectiveHint')}>
              {translate('pendingBadge').replace('{n}', String(pendingActionCount))}
            </span>
          ) : null}
          <button
            type="button"
            className={styles.meetingDelete}
            aria-label={translate('meetingDelete')}
            title={translate('meetingDelete')}
            onClick={() => {
              // 防误删（批次 A ⑪）：confirm 里说清"会删什么 + 想留档先导出"。
              // ⚠ 这不是鉴权：RPC 通道拿不到调用者身份，"带 sessionId" 属自证可伪造。
              const confirmed = window.confirm(
                `${translate('meetingDeleteConfirm').replace('{name}', meeting.name)}\n\n${translate('meetingDeleteDetail')}`,
              )
              if (!confirmed) return
              void rpc<unknown>('roundtable/meeting.delete', {
                meetingId: meeting.id,
                // 防误删护栏：带上本会议的 captainSessionId，会话对不上则拒绝
                // （**不是鉴权** —— RPC 路由拿不到调用者身份，payload 可伪造）。
                captainSessionId: meeting.captainSessionId,
              })
                .then(() => { setSelectedId(undefined); void refresh() })
                .catch(() => undefined)
            }}
          >
            🗑 {translate('meetingDelete')}
          </button>
        </div>
        <section className={panelClass('agents')} data-rt-panel="agents">
          <div className={styles.panelTitleRow}>
            <span className={styles.panelTitle}>{translate('agents')}</span>
            <button
              type="button"
              className={styles.panelAdd}
              aria-label={translate('usageButton')}
              title={translate('usageButton')}
              onClick={loadUsage}
              // 端点会**惰性折叠整条会话日志**（第一方文档：snapshot 物化投影），
              // 连点等于重复折叠。此前只换了字符（`…`），按钮仍可点。
              disabled={usageLoading}
            >
              {usageLoading ? '…' : '⏱'}
            </button>
            <button
              type="button"
              className={styles.panelAdd}
              aria-label={translate('editAgents')}
              title={translate('editAgents')}
              onClick={openManage}
            >
              ＋
            </button>
          </div>
          <div className={styles.panelBody}>
            {/* 用量条（按需显示；口径在 usageNote 里写明，防拿估算当账单） */}
            {usage === null ? null : (
              <div className={styles.usageStrip}>
                <div className={styles.usageNote}>{translate('usageNote')}</div>
                {usage.nodes.map((entry) => (
                  <div className={styles.usageRow} key={entry.key}>
                    <span className={styles.usageKey}>{entry.key}</span>
                    <span
                      className={styles.usageValue}
                      // 明细用 provider 真实字段名，不翻译：这是**数据字段**不是界面文案，
                      // 翻成中文反而断掉了与投影字段的可追溯性。
                      title={entry.provider_tokens === null
                        ? undefined
                        : Object.entries(entry.provider_tokens).map(([field, value]) => `${field}: ${value}`).join('\n')}
                    >
                      {entry.provider_total === null
                        // 两种"没有值"必须分开说：投影没挂 vs 该席当前无活会话。
                        // 原先一律说"宿主未挂投影"，与端点自己回的
                        // `projections_available: true` 直接矛盾（第 4 轮验收）。
                        ? translate(usage.projections_available ? 'usageDormant' : 'usageUnavailable')
                        : `${String(entry.provider_total)} tok`}
                      {/* 耗时优先用该席 agent 的真实累计（`subagentTiming`）；
                          `~` = 回合进行中（数字还会涨）。没有 agent 投影时才退回
                          会议发言跨度，并显式标 (transcript) 防两个口径被当成一回事。 */}
                      {entry.agent_ms === null
                        ? (entry.transcript_span_ms === null
                            ? ''
                            : ` · ${Math.round(entry.transcript_span_ms / 1000)}s (transcript)`)
                        : ` · ${entry.agent_active ? '~' : ''}${(entry.agent_ms / 1000).toFixed(1)}s`}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {[...meeting.nodes]
              .sort((a, b) => nodeListRank(a) - nodeListRank(b))
              .map((node) => {
              const brand = providerBrand(node.provider)
              const removed = node.status === 'removed' || node.activity === 'removed'
              const queuedRemove = pendingRemoveKeys.has(node.key)
              return (
                <div className={[styles.agentRow, removed ? styles.agentRowRemoved : ''].filter(Boolean).join(' ')} key={node.key}>
                  {brandAvatar(brand, 'list')}
                  <div className={styles.agentInfo}>
                    <div className={styles.agentName}>{node.key}</div>
                    <div className={styles.agentRole}>{node.role}</div>
                  </div>
                  {queuedRemove ? (
                    <span className={styles.agentQueuedRemove}>{translate('managePendingRemove')}</span>
                  ) : (
                    <span className={node.activity === 'running' ? styles.agentStatusWorking : removed ? styles.agentStatusRemoved : styles.agentStatus}>
                      {nodeStatusLabel(node, translate)}
                    </span>
                  )}
                </div>
              )
            })}
            {/* 技能并入 agents 脚部一行（批次 B ④）：清单属会议、传递方式属全局偏好，
                原先独占一个面板且无任何操作能力。 */}
            <div className={styles.agentSkillFooter}>
              <span className={styles.agentSkillLabel}>
                {translate('skillsTitle')}：
                {(meeting.skills ?? []).length === 0
                  ? translate('skillsEmpty')
                  : (meeting.skills ?? []).join('、')}
              </span>
              <span className={styles.skillDeliveryLabel}>
                {meeting.skillDelivery === 'direct'
                  ? translate('skillsDeliveryDirect')
                  : translate('skillsDeliveryRelay')}
              </span>
            </div>
          </div>
        </section>

        <DispatchPanel
          plan={meeting.plan}
          presets={presetList}
          onStageIds={onStagePresetIds}
          className={panelClass('dispatch')}
          t={translate}
          styles={dispatchPanelStyles}
        />
        <section className={panelClass('kb')} data-rt-panel="kb">
          <div className={styles.panelTitleRow}>
            <span className={styles.panelTitle}>{translate('kb')}</span>
            <button
              type="button"
              className={styles.panelAdd}
              aria-label={translate('editKb')}
              title={translate('editKb')}
              onClick={openKb}
            >
              ＋
            </button>
          </div>
          <div className={styles.panelBody}>
            {meeting.kbPath !== '' ? (
              <div className={styles.kbPathRow} title={meeting.kbPath}>{meeting.kbPath}</div>
            ) : (
              <div className={styles.panelEmpty}>{translate('kbNotSet')}</div>
            )}
          </div>
        </section>





      </aside>

      {kbOpen ? (
        <div className={styles.manageOverlay} onClick={closeKb}>
          <div
            className={styles.manageModal}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-label={translate('kbTitle')}
          >
            <div className={styles.manageTitle}>
              {translate('kbTitle')} · {meeting.name}
            </div>

            <div className={styles.kbPathForm}>
              <div className={styles.manageFormRow}>
                <label className={styles.manageLabel}>{translate('kbPathLabel')}</label>
                <input
                  className={styles.manageInput}
                  value={kbPathInput}
                  placeholder={translate('kbPathPlaceholder')}
                  onChange={(event) => setKbPathInput(event.target.value)}
                />
              </div>
              <button type="button" className={styles.manageAddBtn} onClick={saveKbPath}>
                {translate('kbSave')}
              </button>
            </div>

            <div className={styles.manageSectionTitle}>{translate('kbFiles')}</div>
            <div className={styles.kbList}>
              {kbListing === null ? (
                <div className={styles.panelEmpty}>{translate('kbLoadHint')}</div>
              ) : kbListing.error !== '' ? (
                <div className={styles.kbError}>{kbListing.error}</div>
              ) : kbListing.files.length === 0 ? (
                <div className={styles.panelEmpty}>{translate('kbEmpty')}</div>
              ) : (
                kbListing.files.map((entry) => (
                  <div className={styles.kbRow} key={entry.name}>
                    <span className={entry.kind === 'dir' ? styles.kbKindDir : styles.kbKindFile}>
                      {entry.kind === 'dir' ? '📁' : '📄'}
                    </span>
                    <span className={styles.kbName} title={entry.name}>{entry.name}</span>
                    {entry.kind === 'file' ? (
                      <span className={styles.kbMeta}>
                        {entry.ext !== '' ? `.${entry.ext}` : ''}
                        {entry.size > 0 ? ` · ${formatKbSize(entry.size)}` : ''}
                        {/* host 判定的摘要有效性：false = 读过但文件已变 → 提示重读 */}
                        {entry.valid === false ? ` · ${translate('kbChanged')}` : ''}
                      </span>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            <div className={styles.manageFooter}>
              <span className={styles.manageHint}>{translate('kbBrowseHint')}</span>
              <button type="button" className={styles.manageCloseBtn} onClick={closeKb}>
                {translate('manageClose')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {manageOpen ? (
        <div className={styles.manageOverlay} onClick={closeManage}>
          <div
            className={styles.manageModal}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-label={translate('manageTitle')}
          >
            <div className={styles.manageTitle}>
              {translate('manageTitle')} · {meeting.name}
            </div>
            {pendingActionCount > 0 ? (
              <div className={styles.managePendingNote}>{translate('managePendingNote')}</div>
            ) : null}

            <div className={styles.manageSectionTitle}>{translate('manageExisting')}</div>
            <div className={styles.manageList}>
              {meeting.nodes.map((node) => {
                const brand = providerBrand(node.provider)
                const removed = node.status === 'removed' || node.activity === 'removed'
                const queuedRemove = pendingRemoveKeys.has(node.key)
                return (
                  <div className={[styles.manageRow, removed ? styles.agentRowRemoved : ''].filter(Boolean).join(' ')} key={node.key}>
                    {brandAvatar(brand, 'list')}
                    <div className={styles.agentInfo}>
                      <div className={styles.agentName}>{node.key}</div>
                      <div className={styles.agentRole}>
                        {node.role !== '' ? `${node.role} · ` : ''}{node.provider !== '' ? `${node.provider}/${node.model}` : '（未指定模型）'}
                      </div>
                    </div>
                    {removed ? (
                      <span className={styles.manageStatusTag}>{translate('activityRemoved')}</span>
                    ) : queuedRemove ? (
                      <span className={styles.managePendingTag}>{translate('managePendingRemove')}</span>
                    ) : (
                      <button
                        type="button"
                        className={styles.manageRemoveBtn}
                        onClick={() => queueRemove(node)}
                      >
                        {translate('manageRemove')}
                      </button>
                    )}
                  </div>
                )
              })}
              {meeting.nodes.length === 0 && pendingAddKeys.size === 0 ? (
                <div className={styles.panelEmpty}>{translate('manageNoExperts')}</div>
              ) : null}
              {[...pendingAddKeys].map((key) => (
                <div className={styles.manageRow} key={`pending-${key}`}>
                  <div className={styles.managePendingAvatar}>＋</div>
                  <div className={styles.agentInfo}>
                    <div className={styles.agentName}>{key}</div>
                    <div className={styles.agentRole}>{translate('managePendingAddRole')}</div>
                  </div>
                  <span className={styles.managePendingTag}>{translate('managePendingAdd')}</span>
                </div>
              ))}
            </div>

            <div className={styles.manageSectionTitle}>{translate('manageAddTitle')}</div>
            <div className={styles.manageForm}>
              <div className={styles.manageFormRow}>
                <label className={styles.manageLabel}>{translate('managePresetLabel')}</label>
                {presetList.length === 0 ? (
                  <div className={styles.manageHint}>{translate('managePresetEmpty')}</div>
                ) : (
                  <select
                    className={styles.manageSelect}
                    value={selectedPresetId}
                    onChange={(event) => applyPreset(event.target.value)}
                  >
                    <option value="">{translate('managePresetPlaceholder')}</option>
                    {presetList.map((preset) => {
                      const routed = preset.provider !== undefined && preset.provider !== ''
                        && preset.model !== undefined && preset.model !== ''
                      return (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}{routed ? ` · ${preset.provider}/${preset.model}` : ''}
                          {preset.reasoningEffort !== undefined && preset.reasoningEffort !== '' ? ` @${preset.reasoningEffort}` : ''}
                        </option>
                      )
                    })}
                  </select>
                )}
              </div>
              <div className={styles.manageFormRow}>
                <label className={styles.manageLabel}>{translate('manageName')}</label>
                <input
                  className={styles.manageInput}
                  value={form.name}
                  placeholder={translate('manageNamePlaceholder')}
                  onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))}
                />
              </div>
              <div className={styles.manageFormRow}>
                <label className={styles.manageLabel}>{translate('manageRole')}</label>
                <input
                  className={styles.manageInput}
                  value={form.role}
                  placeholder={translate('manageRolePlaceholder')}
                  onChange={(event) => setForm((previous) => ({ ...previous, role: event.target.value }))}
                />
              </div>
              <div className={styles.manageFormRow}>
                <label className={styles.manageLabel}>{translate('manageModel')}</label>
                <select
                  className={styles.manageSelect}
                  value={form.provider}
                  onChange={(event) => handleProviderChange(event.target.value)}
                >
                  <option value="">{translate('manageModelInherit')}</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>
                  ))}
                </select>
                <select
                  className={styles.manageSelect}
                  value={form.model}
                  disabled={form.provider === '' || !modelsLoaded}
                  onChange={(event) => {
                    // 换模型 ⇒ 清档位（与 handleProviderChange 同一口径）。
                    const model = event.target.value
                    setForm((previous) => ({ ...previous, model, reasoningEffort: '' }))
                  }}
                >
                  <option value="">{translate('manageModelInherit')}</option>
                  {(providers.find((provider) => provider.id === form.provider)?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>{model.name || model.id}</option>
                  ))}
                </select>
              </div>
              <div className={styles.manageFormRow}>
                <label className={styles.manageLabel}>{translate('settingsPresetEffortTitle')}</label>
                <select
                  className={styles.manageSelect}
                  value={form.reasoningEffort}
                  disabled={formEfforts().length === 0}
                  onChange={(event) => setForm((previous) => ({ ...previous, reasoningEffort: event.target.value }))}
                >
                  <option value="">{translate('manageModelInherit')}</option>
                  {formEfforts().map((effort) => (
                    <option key={effort.id} value={effort.id}>{effort.name || effort.id}</option>
                  ))}
                </select>
                {form.model !== '' && formEfforts().length === 0 ? (
                  <span className={styles.manageHint}>{translate('settingsPresetEffortUnavailable')}</span>
                ) : null}
              </div>
              <button type="button" className={styles.manageAddBtn} onClick={submitAdd}>
                {translate('manageAddBtn')}
              </button>
            </div>

            <div className={styles.manageFooter}>
              <span className={styles.manageHint}>{translate('manageEffectiveHint')}</span>
              <button type="button" className={styles.manageCloseBtn} onClick={closeManage}>
                {translate('manageClose')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {reviewOpen && meeting?.review !== null ? (
        <div className={styles.manageOverlay} onClick={() => setReviewOpen(false)}>
          <div
            className={styles.reviewModal}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-label={translate('reviewTitle')}
          >
            <div className={styles.manageTitle}>
              {translate('reviewTitle')} · {meeting.name}
            </div>
            {meeting.review!.reviewPass > 0 ? (
              <div className={styles.manageHint}>
                {translate('reviewPassBadge')
                  .replace('{pass}', String(meeting.review!.reviewPass))
                  .replace('{max}', String(meeting.review!.maxReviewPass))}
              </div>
            ) : null}
            <div className={styles.reviewBody}>
              <div className={styles.reviewLeft}>
                <div className={styles.reviewSectionTitle}>{translate('reviewQuestion')}</div>
                <div className={styles.reviewQuestion}>{meeting.review!.question}</div>
                <div className={styles.reviewSectionTitle}>{translate('reviewPlan')}</div>
                <div className={styles.reviewPlan}>{meeting.review!.plan}</div>
              </div>
              <div className={styles.reviewRight}>
                <div className={styles.reviewSectionTitle}>
                  {translate('reviewViewpoints')}（{meeting.review!.viewpoints.length}）
                </div>
                {meeting.review!.status === 'ready' ? (
                  <div className={`${styles.reviewImpactBar} ${meeting.review!.viewpoints.filter((viewpoint) => viewpoint.endorsed).length >= 3 ? styles.reviewImpactWarn : ''}`}>
                    <span>{translate('reviewImpactTitle')}</span>
                    <span>
                      {translate('reviewEndorsed')} {meeting.review!.viewpoints.filter((viewpoint) => viewpoint.endorsed).length}
                    </span>
                    <span>
                      {translate('reviewRejected')} {meeting.review!.viewpoints.filter((viewpoint) => viewpoint.rejected).length}
                    </span>
                    <span>
                      {translate('reviewPending')} {meeting.review!.viewpoints.filter((viewpoint) => viewpoint.status === 'pending').length}
                    </span>
                    {meeting.review!.viewpoints.filter((viewpoint) => viewpoint.endorsed).length >= 3
                      ? <span>{translate('reviewImpactThresholdHint')}</span>
                      : <span>{translate('reviewImpactOk')}</span>}
                  </div>
                ) : null}
                <div className={styles.reviewList}>
                  {meeting.review!.viewpoints.length === 0 ? (
                    <div className={styles.panelEmpty}>{translate('reviewEmpty')}</div>
                  ) : (
                    meeting.review!.viewpoints.map((viewpoint) => {
                      const brand = providerBrand(viewpoint.nodeKey === 'captain' ? '' : viewpoint.nodeKey)
                      return (
                        <div key={viewpoint.id} className={styles.reviewItem}>
                          <div className={styles.reviewItemHead}>
                            {brandAvatar(brand, 'list')}
                            <span className={styles.reviewNode}>{viewpoint.nodeKey}</span>
                            {viewpoint.seq > 0 ? <span className={styles.reviewSeq}>观点 {viewpoint.seq}</span> : null}
                            <span className={styles.reviewDimension}>{viewpoint.dimension}</span>
                            {viewpoint.status === 'endorsed' ? (
                              <span className={styles.reviewEndorsed}>{translate('reviewEndorsed')}</span>
                            ) : viewpoint.status === 'rejected' ? (
                              <span className={styles.reviewRejected}>{translate('reviewRejected')}</span>
                            ) : (
                              <span className={styles.reviewPending}>{translate('reviewPending')}</span>
                            )}
                          </div>
                          {viewpoint.quote !== undefined && viewpoint.quote !== '' ? (
                            <div className={styles.reviewQuote}>“{viewpoint.quote}”</div>
                          ) : null}
                          <div className={styles.reviewContent}>{viewpoint.content}</div>
                          {viewpoint.evidence !== undefined && viewpoint.evidence.text !== '' ? (
                            <div className={styles.reviewEvidence}>
                              <span className={styles.reviewEvidenceLabel}>
                                {viewpoint.evidence.kind === 'repro'
                                  ? `[${translate('reviewEvidenceRepro')}] `
                                  : `[${translate('reviewEvidenceArgument')}] `}
                              </span>
                              {viewpoint.evidence.text}
                            </div>
                          ) : null}
                          {viewpoint.status === 'rejected' && viewpoint.rejectReason !== undefined && viewpoint.rejectReason !== '' ? (
                            <div className={styles.reviewRejectReason}>
                              {translate('reviewReject')}：{viewpoint.rejectReason}
                            </div>
                          ) : null}
                          <div className={styles.reviewActions}>
                            {meeting.review!.status === 'done' ? null : (
                              <>
                                <button
                                  type="button"
                                  className={viewpoint.status === 'endorsed' ? styles.reviewSupportDone : styles.reviewSupport}
                                  onClick={() => setViewpointStatus(viewpoint.id, viewpoint.status === 'endorsed' ? 'pending' : 'endorsed')}
                                >
                                  {viewpoint.status === 'endorsed' ? translate('reviewSupported') : translate('reviewSupport')}
                                </button>
                                {rejectingId === viewpoint.id ? (
                                  <div className={styles.reviewRejectBox}>
                                    <label className={styles.reviewRejectLabel}>{translate('reviewRejectReasonPrompt')}</label>
                                    <textarea
                                      className={styles.reviewRejectInput}
                                      value={rejectDraft}
                                      autoFocus
                                      onChange={(event) => setRejectDraft(event.target.value)}
                                      placeholder={translate('reviewRejectReasonPlaceholder')}
                                    />
                                    <div className={styles.reviewRejectActions}>
                                      <button
                                        type="button"
                                        className={styles.reviewReject}
                                        onClick={() => {
                                          const reason = rejectDraft.trim()
                                          if (reason === '') {
                                            setToast({ kind: 'err', text: translate('reviewRejectReasonRequired') })
                                            return
                                          }
                                          setViewpointStatus(viewpoint.id, 'rejected', reason)
                                          setRejectingId(null)
                                          setRejectDraft('')
                                        }}
                                      >
                                        {translate('reviewRejectConfirm')}
                                      </button>
                                      <button
                                        type="button"
                                        className={styles.reviewSupportDone}
                                        onClick={() => {
                                          setRejectingId(null)
                                          setRejectDraft('')
                                        }}
                                      >
                                        {translate('reviewRejectCancel')}
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    className={viewpoint.status === 'rejected' ? styles.reviewRejectDone : styles.reviewReject}
                                    onClick={() => {
                                      if (viewpoint.status === 'rejected') {
                                        setViewpointStatus(viewpoint.id, 'pending')
                                      } else {
                                        setRejectingId(viewpoint.id)
                                        setRejectDraft('')
                                      }
                                    }}
                                  >
                                    {viewpoint.status === 'rejected' ? translate('reviewRejectedDone') : translate('reviewReject')}
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </div>
            <div className={styles.manageFooter}>
              <span className={styles.manageHint}>{translate('reviewHint')} {translate('reviewExportHint')}</span>
              <button type="button" className={styles.manageCloseBtn} onClick={() => setReviewOpen(false)}>
                {translate('reviewClose')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {menu !== null ? (
        <div
          className={styles.contextMenu}
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className={styles.contextMenuTitle}>
            {menu.edge.from} → {menu.edge.to}
          </div>
          {/* 菜单首行即说明（批次 A ⑧）：右键是用户主动询问"这条线是什么"的时刻 */}
          <div className={styles.contextMenuNote}>
            {translate(meeting.mode === 'egalitarian' ? 'edgeScopeHintEgalitarian' : 'edgeScopeHint')}
          </div>
          <button type="button" className={styles.contextMenuItem} onClick={() => handleEdgeAction('forward')}>
            {translate('edgeSetForward')}
          </button>
          <button type="button" className={styles.contextMenuItem} onClick={() => handleEdgeAction('bidirectional')}>
            {translate('edgeSetBidirectional')}
          </button>
          <button type="button" className={styles.contextMenuItemDanger} onClick={() => handleEdgeAction('remove')}>
            {translate('edgeRemove')}
          </button>
        </div>
      ) : null}
      {askFeedbackFor !== null ? (
        <div className={styles.feedbackBar}>
          <div className={styles.feedbackBarTitle}>{translate('feedbackAskTitle')}</div>
          <div className={styles.feedbackBarActions}>
            <button type="button" className={styles.feedbackRating} onClick={() => submitFeedback('good')}>
              {translate('feedbackAskGood')}
            </button>
            <button type="button" className={styles.feedbackRating} onClick={() => submitFeedback('meh')}>
              {translate('feedbackAskMeh')}
            </button>
            <button type="button" className={styles.feedbackRating} onClick={() => submitFeedback('bad')}>
              {translate('feedbackAskBad')}
            </button>
          </div>
          <input
            className={styles.feedbackBarNote}
            value={feedbackNote}
            placeholder={translate('feedbackAskNotePlaceholder')}
            onChange={(event) => setFeedbackNote(event.target.value)}
          />
          <div className={styles.feedbackBarFooter}>
            <button
              type="button"
              className={styles.feedbackSkip}
              onClick={() => {
                if (askFeedbackFor !== null) markFeedbackAsked(askFeedbackFor)
                setAskFeedbackFor(null)
              }}
            >
              {translate('feedbackAskSkip')}
            </button>
          </div>
        </div>
      ) : null}
      {fetchFailed === true ? <div className={styles.fetchFailed}>{translate('fetchFailed')}</div> : null}
    </div>
  )
}
