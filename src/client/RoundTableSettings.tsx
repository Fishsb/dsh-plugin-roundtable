/**
 * RoundTable preference page (settings.section): default collaboration mode
 * and budget defaults. Switching to egalitarian mode surfaces the safety
 * limits (max rounds / max tokens) with a warning-style hint.
 * @module dsh-plugin-roundtable/client/RoundTableSettings
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RpcCaller, RoundTablePrefs, WireFeedbackEntry, WireModelCatalog, WireProviderOption, WireRolePreset } from './wire.ts'
import type { RoundTableKey } from './locales.ts'
import { PRESET_AVATARS, AVATAR_MAX, presetAvatarGlyph, presetFallbackGlyph } from './preset-avatars.ts'
import styles from './RoundTableSettings.module.css'

export interface RoundTableSettingsInjected {
  rpc: RpcCaller
  t: (key: string) => string
}

export interface RoundTableSettingsProps extends RoundTableSettingsInjected {}

/** E1/E3 反馈的评分文案（列表元数据显示）。 */
const RATING_LABEL: Record<WireFeedbackEntry['rating'], string> = {
  good: '👍',
  meh: '😐',
  bad: '👎',
}

/** R3：右栏面板的文案键（id → 文案）。
 *  **id 集合以 host 的 `ROUNDTABLE_PANELS` 为准**：`prefs.get` 现回传 `panels`，
 *  本页只保留映射，不再自带一份 id 清单（旧 `PANEL_KEYS` 是第三处副本）。
 *  映射值收紧为 `RoundTableKey`，这样拼错文案键过不了 typecheck。 */
const PANEL_LABELS: Readonly<Record<string, RoundTableKey>> = {
  agents: 'agents',
  dispatch: 'dispatch',
  kb: 'kb',
}

/** B3：预设条数上限，与 host `rpc.ts` 的 `ROLE_PRESET_MAX` 保持一致
 *  （客户端提前拦截，服务端仍然会截断，两层都有）。 */
const ROLE_PRESET_LIMIT = 50

/** 编辑/新建共用的草稿形状（五个字段一次写全：名称、角色、路由、档位）。 */
interface PresetDraft {
  name: string
  /** 职能名（展示用短名）：群聊/拓扑上的人名。 */
  title: string
  /** 头像字形（内置集里的一个）。 */
  avatar: string
  role: string
  provider: string
  model: string
  reasoningEffort: string
}

/**
 * 预设表单（**唯一一个**编辑入口）。
 *
 * 刻意抽成独立组件而不是把 JSX 抄两遍：行内编辑（挂在条目内）与新建（挂在列表
 * 下方）用的是**同一张表单**，抄两遍必然漂移（历史上正是"模型设置藏在编辑表单、
 * 另一个入口又给一份"这种双写口造成了歧义）。抽出来后"模型 · 思考强度"只有一处
 * 可写，且行内挂载让"改的是第几条"与三个选择器同屏。
 */
function PresetForm(props: {
  draft: PresetDraft
  efforts: { id: string; name: string; description?: string }[]
  providers: WireProviderOption[]
  formRef: React.RefObject<HTMLDivElement>
  t: (key: string) => string
  /** true = 挂在该条预设内部（行内编辑），需独占整行；false = 挂列表下方（新建）。 */
  inline: boolean
  onDraft: (next: PresetDraft) => void
  onSave: () => void
  onCancel: () => void
}): JSX.Element {
  const { draft, efforts, providers, formRef, t, inline, onDraft, onSave, onCancel } = props
  const models = providers.find((provider) => provider.id === draft.provider)?.models ?? []
  const className = inline ? `${styles.presetForm} ${styles.presetFormInline}` : styles.presetForm
  return (
    <div className={className} ref={formRef}>
      <div className={styles.presetFormRow}>
        <label className={styles.label}>{t('settingsPresetName')}</label>
        <input
          className={styles.input}
          value={draft.name}
          placeholder={t('settingsPresetNamePlaceholder')}
          onChange={(event) => onDraft({ ...draft, name: event.target.value })}
        />
      </div>
      {/* 头像：内置字形集，一键选中。做成**可视选择器**而不是文本框 ——
          头像的价值在于「一眼认出是谁」，让用户手打 emoji 既难查又易漏。 */}
      <div className={styles.presetFormRow}>
        <label className={styles.label}>{t('settingsPresetAvatar')}</label>
        <div className={styles.avatarPicker}>
          <button
            type="button"
            className={[styles.avatarOption, draft.avatar === '' ? styles.avatarOptionActive : ''].filter(Boolean).join(' ')}
            title={t('settingsPresetAvatarNone')}
            onClick={() => onDraft({ ...draft, avatar: '' })}
          >
            <span className={styles.avatarPreview}>{presetFallbackGlyph(draft.title, draft.name)}</span>
          </button>
          {PRESET_AVATARS.map((glyph) => (
            <button
              key={glyph}
              type="button"
              className={[styles.avatarOption, draft.avatar === glyph ? styles.avatarOptionActive : ''].filter(Boolean).join(' ')}
              title={glyph}
              onClick={() => onDraft({ ...draft, avatar: glyph })}
            >
              <span className={styles.avatarPreview}>{glyph}</span>
            </button>
          ))}
        </div>
      </div>
      {/* 职能名：群聊/拓扑上的人名（与 name 的分工见 types.ts 注释）。 */}
      <div className={styles.presetFormRow}>
        <label className={styles.label}>{t('settingsPresetTitle')}</label>
        <input
          className={styles.input}
          value={draft.title}
          placeholder={t('settingsPresetTitlePlaceholder')}
          maxLength={16}
          onChange={(event) => onDraft({ ...draft, title: event.target.value })}
        />
      </div>
      <div className={styles.presetFormRow}>
        <label className={styles.label}>{t('settingsPresetRole')}</label>
        <input
          className={styles.input}
          value={draft.role}
          placeholder={t('settingsPresetRolePlaceholder')}
          onChange={(event) => onDraft({ ...draft, role: event.target.value })}
        />
      </div>
      <div className={styles.presetFormRow}>
        <label className={styles.label}>{t('settingsPresetModel')}</label>
        <div className={styles.presetModelRow}>
          <select
            className={styles.presetSelect}
            value={draft.provider}
            onChange={(event) => {
              // 换 provider ⇒ 路由与档位**同时**清空。只清 model 会留下
              // `deepseek @ high` 这种假值，到专家首个请求才炸
              // UNSUPPORTED_REASONING_EFFORT，症状与"模型慢"不可分辨。
              onDraft({ ...draft, provider: event.target.value, model: '', reasoningEffort: '' })
            }}
          >
            <option value="">{t('manageModelInherit')}</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>
            ))}
          </select>
          <select
            className={styles.presetSelect}
            value={draft.model}
            disabled={draft.provider === ''}
            onChange={(event) => {
              // 换 model ⇒ 档位同样清空（新模型未必声明同一档位）。
              onDraft({ ...draft, model: event.target.value, reasoningEffort: '' })
            }}
          >
            <option value="">{t('manageModelInherit')}</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.name || model.id}</option>
            ))}
          </select>
        </div>
      </div>
      <div className={styles.presetFormRow}>
        <label className={styles.label}>{t('settingsPresetEffortTitle')}</label>
        <div className={styles.presetModelRow}>
          <select
            className={styles.presetSelect}
            value={draft.reasoningEffort}
            // 无档位模型：控件保留但**置灰**并同屏给文案。隐藏会让"这个模型没有"
            // 与"设置没生效"两种状态同形，用户判不出来。
            disabled={efforts.length === 0}
            onChange={(event) => onDraft({ ...draft, reasoningEffort: event.target.value })}
          >
            <option value="">{t('manageModelInherit')}</option>
            {efforts.map((effort) => (
              <option key={effort.id} value={effort.id}>{effort.name || effort.id}</option>
            ))}
          </select>
        </div>
        {draft.model !== '' && efforts.length === 0 ? (
          <div className={styles.presetPanelWarn}>{t('settingsPresetEffortUnavailable')}</div>
        ) : (
          <div className={styles.presetPanelHint}>{t('settingsPresetEffortInheritHint')}</div>
        )}
      </div>
      <div className={styles.presetPanelHint}>{t('settingsPresetEffortOnlyNew')}</div>
      <div className={styles.presetFormActions}>
        <button type="button" className={styles.presetAddBtn} onClick={onSave}>
          {t('settingsPresetSave')}
        </button>
        <button type="button" className={styles.presetCancelBtn} onClick={onCancel}>
          {t('settingsPresetCancel')}
        </button>
      </div>
    </div>
  )
}


/**
 * 把一次 RPC 失败收敛成**可读的原因**。
 *
 * 为什么必须有它：此前三处写入口都只置一个布尔值，把服务端 `fail()` 带回的
 * 具体 message 与网络异常原文**全部丢掉**。后果是无论失败原因是鉴权 401、
 * 字段被净化拒绝、还是磁盘不可写，用户看到的永远是同一句「保存设置失败」——
 * **失败不可归因、也不可观测**。
 *
 * 实测代价（2026-09-25 排查「设置保存失败」）：服务端其实一直带着可读原因回包，
 * 但界面把它盖掉了，只能靠后侧探针把每个假设逐个排除，多花了一整轮。
 *
 * 收敛规则：服务端 message 优先 → 网络异常 `Error.message` → 固定兜底。
 * **不留白** —— 留白会被读成"没失败"。
 */
function rpcFailureText(
  result: { ok: false; error: { code: string; message: string } } | undefined,
  error?: unknown,
): string {
  const fromServer = result?.error?.message
  if (typeof fromServer === 'string' && fromServer !== '') return fromServer
  if (error instanceof Error && error.message !== '') return error.message
  if (error !== undefined && error !== null) return String(error)
  return 'unknown failure (no message from server)'
}

export function RoundTableSettings(props: RoundTableSettingsProps): JSX.Element {
  const { rpc, t } = props
  const [prefs, setPrefs] = useState<RoundTablePrefs | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  /**
   * 失败**原文**（服务端 message 或网络异常）。
   *
   * 为什么必须与布尔位并存：只置 `saveFailed = true` 会让「鉴权 401」
   * 「字段被拒」「磁盘不可写」在界面上完全同形——用户与排查者都拿不到
   * 归因线索（2026-09-25 实测代价见 `rpcFailureText` 的注释）。
   * 空串 = 没有可读原因（此时界面只显示标题句，不显示空的"原因"行）。
   */
  const [saveFailedReason, setSaveFailedReason] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<WireFeedbackEntry[]>([])
  const [feedbackLoadFailed, setFeedbackLoadFailed] = useState(false)
  const [feedbackCleared, setFeedbackCleared] = useState(false)
  /** 清空反馈失败的**原文**（同理由：`feedbackLoadFailed` 只说"失败"，不说为什么）。 */
  const [feedbackFailReason, setFeedbackFailReason] = useState('')
  // B3 角色预设：列表在 prefs 里，表单与"编辑中"是纯本地状态。
  const [providers, setProviders] = useState<WireProviderOption[]>([])
  const [presetFormOpen, setPresetFormOpen] = useState(false)
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null)
  const [presetDraft, setPresetDraft] = useState<{ name: string; title: string; avatar: string; role: string; provider: string; model: string; reasoningEffort: string }>({
    name: '',
    title: '',
    avatar: '',
    role: '',
    provider: '',
    model: '',
    reasoningEffort: '',
  })
  const [presetNotice, setPresetNotice] = useState<'saved' | 'failed' | 'invalid' | 'limit' | null>(null)
  /** 条目级保存回执（按预设 id）：页面级一句话说不清"改的是哪条"。 */
  const [presetSavedId, setPresetSavedId] = useState<string | null>(null)
  /** 预设写入失败的**原文**（同 `saveFailedReason` 的理由：只置 'failed' 无法归因）。 */
  const [presetFailReason, setPresetFailReason] = useState('')
  /** 模型目录读取失败（provider 粒度）；非空即在页顶显式提示，不与"无模型"同形。 */
  const [catalogFailures, setCatalogFailures] = useState<{ id: string; name: string; message: string }[]>([])
  /** 编辑表单的挂载点：行内编辑（挂在条目内）与新建（挂在列表下方）共用一把 ref。 */
  const formRef = useRef<HTMLDivElement | null>(null)

  // 模型下拉复用与专家管理同一份主机模型目录（含逐模型档位词表 + 失败清单）。
  useEffect(() => {
    void rpc<WireModelCatalog>('roundtable/models.list', {})
      .then((result) => {
        if (result.ok) {
          setProviders(Array.isArray(result.value?.providers) ? result.value.providers : [])
          const failures = result.value?.failures
          setCatalogFailures(Array.isArray(failures) ? failures : [])
        }
      })
      .catch(() => undefined)
  }, [rpc])

  /**
   * 编辑表单打开后滚入可视区（体验判据 M6）。
   *
   * `.presetList` 是 260px 滚动容器：点击「编辑」只保证**按钮**可见，浏览器不会
   * 为按钮下方新长出的表单滚动，表单会整块落在容器外 → 用户以为"点了没反应"。
   * `block:'nearest'` 只滚到刚好可见（不整页跳），且必须在**表单渲染后**调用，
   * 否则量到的是折叠高度，等于没滚。
   */
  useLayoutEffect(() => {
    if (!presetFormOpen) return
    const node = formRef.current
    if (node === null || typeof node.scrollIntoView !== 'function') return
    node.scrollIntoView({ block: 'nearest' })
  }, [presetFormOpen, editingPresetId])

  const loadFeedback = useCallback((): void => {
    void rpc<{ entries: WireFeedbackEntry[] }>('roundtable/feedback.list', {})
      .then((result) => {
        if (result.ok) {
          setFeedback(Array.isArray(result.value?.entries) ? result.value.entries : [])
          setFeedbackLoadFailed(false)
        } else {
          setFeedbackLoadFailed(true)
        }
      })
      .catch(() => setFeedbackLoadFailed(true))
  }, [rpc])

  const load = useCallback((): void => {
    void rpc<RoundTablePrefs>('roundtable/prefs.get', {})
      .then((result) => {
        if (result.ok) {
          setPrefs(result.value)
          setLoadFailed(false)
        } else {
          setLoadFailed(true)
        }
      })
      .catch(() => setLoadFailed(true))
  }, [rpc])

  useEffect(() => {
    load()
    loadFeedback()
  }, [load, loadFeedback])

  const patch = (next: Partial<RoundTablePrefs>): void => {
    setPrefs((previous) => previous === null ? null : { ...previous, ...next })
    setSaved(false)
  }

  /** R3：点亮/熄灭一个右栏面板（写入 hiddenPanels）。 */
  const togglePanel = (id: string): void => {
    setPrefs((previous) => {
      if (previous === null) return null
      const hidden = Array.isArray(previous.hiddenPanels) ? previous.hiddenPanels : []
      const nextHidden = hidden.includes(id) ? hidden.filter((entry) => entry !== id) : [...hidden, id]
      return { ...previous, hiddenPanels: nextHidden }
    })
    setSaved(false)
  }

  const save = (): void => {
    if (prefs === null || saving) return
    setSaving(true)
    setSaveFailed(false)
    setSaveFailedReason('')
    void rpc<RoundTablePrefs>('roundtable/prefs.set', {
      defaultMode: prefs.defaultMode,
      maxRounds: prefs.maxRounds,
      maxTokens: prefs.maxTokens,
      showAllMeetings: prefs.showAllMeetings,
      expertMaxTokens: prefs.expertMaxTokens,
      expertMaxOpinions: prefs.expertMaxOpinions,
      feedbackEnabled: prefs.feedbackEnabled,
      skillDelivery: prefs.skillDelivery === 'direct' ? 'direct' : 'relay',
      hiddenPanels: Array.isArray(prefs.hiddenPanels) ? prefs.hiddenPanels : [],
    })
      .then((result) => {
        setSaving(false)
        if (result.ok) {
          setPrefs(result.value)
          setSaved(true)
        } else {
          setSaveFailed(true)
          setSaveFailedReason(rpcFailureText(result))
        }
      })
      .catch((error: unknown) => {
        setSaving(false)
        setSaveFailed(true)
        setSaveFailedReason(rpcFailureText(undefined, error))
      })
  }

  const clearFeedback = (): void => {
    void rpc<{ cleared: number }>('roundtable/feedback.clear', {})
      .then((result) => {
        if (result.ok) {
          setFeedback([])
          setFeedbackCleared(true)
          setFeedbackFailReason('')
        } else {
          setFeedbackLoadFailed(true)
          setFeedbackFailReason(rpcFailureText(result))
        }
      })
      .catch((error: unknown) => {
        setFeedbackLoadFailed(true)
        setFeedbackFailReason(rpcFailureText(undefined, error))
      })
  }

  /* ---------------- B3：角色预设（改动立即落库，不必等底部保存） ---------------- */

  /** 新建预设的稳定 id；host 侧只在 id 缺失或重复时才重新分配。 */
  const newPresetId = (): string =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `preset-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

  /**
   * 写入整份偏好（含新的 rolePresets）。
   *
   * 刻意提交**完整对象**而不是只提交 `{ rolePresets }`：服务端
   * `scope.update` 究竟是合并还是整体替换，客户端无法确定；提交完整对象
   * 在两种语义下都正确，也与底部「保存」按钮的做法一致。
   */
  const persistPresets = (next: WireRolePreset[], savedId?: string): void => {
    if (prefs === null) return
    const full: RoundTablePrefs = { ...prefs, rolePresets: next }
    setPrefs(full)
    void rpc<RoundTablePrefs>('roundtable/prefs.set', { ...full })
      .then((result) => {
        if (result.ok) {
          setPrefs(result.value)
          setPresetNotice('saved')
          setPresetFailReason('')
          // 条目级回执（M1）：让用户看见"改的是哪一条"，而不是页脚一句话。
          setPresetSavedId(savedId ?? null)
        } else {
          setPresetNotice('failed')
          setPresetFailReason(rpcFailureText(result))
        }
      })
      .catch((error: unknown) => {
        setPresetNotice('failed')
        setPresetFailReason(rpcFailureText(undefined, error))
      })
  }

  /**
   * 打开编辑表单。
   *
   * **一条预设只有一个可写处**：模型与思考强度就在这张表单里（不再有第二个
   * "模型 · 思考强度"入口）。列表内点「编辑」= 行内展开（挂在该条下方，so
   * "改的是第几条"与表单同屏）；点「新建预设」= 挂在整个列表下方。
   */
  const openPresetForm = (preset?: WireRolePreset): void => {
    setPresetNotice(null)
    if (preset === undefined) {
      setEditingPresetId(null)
      setPresetDraft({ name: '', title: '', avatar: '', role: '', provider: '', model: '', reasoningEffort: '' })
    } else {
      setEditingPresetId(preset.id)
      setPresetDraft({
        name: preset.name,
        // 回填展示字段：漏了它们，用户"编辑一下再保存"就会把已设的头像/职能名抹掉。
        title: preset.title ?? '',
        avatar: preset.avatar ?? '',
        role: preset.role,
        provider: preset.provider ?? '',
        model: preset.model ?? '',
        reasoningEffort: preset.reasoningEffort ?? '',
      })
    }
    setPresetFormOpen(true)
  }

  const closePresetForm = (): void => {
    setPresetFormOpen(false)
    setEditingPresetId(null)
    setPresetDraft({ name: '', title: '', avatar: '', role: '', provider: '', model: '', reasoningEffort: '' })
  }

  const submitPreset = (): void => {
    if (prefs === null) return
    const name = presetDraft.name.trim()
    const role = presetDraft.role.trim()
    if (name === '' || role === '') {
      setPresetNotice('invalid')
      return
    }
    const current = Array.isArray(prefs.rolePresets) ? prefs.rolePresets : []
    if (editingPresetId === null && current.length >= ROLE_PRESET_LIMIT) {
      setPresetNotice('limit')
      return
    }
    // provider/model 必须成对：只有两者都选好才算"指定路由"，否则继承主持人。
    const routed = presetDraft.provider !== '' && presetDraft.model !== ''
    const effort = presetDraft.reasoningEffort.trim()
    // 职能名与头像：与 host 净化同规 —— **空则省略**，不写空串。
    const title = presetDraft.title.trim()
    const avatar = presetDraft.avatar.trim().slice(0, AVATAR_MAX)
    const entry: WireRolePreset = {
      id: editingPresetId ?? newPresetId(),
      name,
      ...(title === '' ? {} : { title }),
      ...(avatar === '' ? {} : { avatar }),
      role,
      ...(routed ? { provider: presetDraft.provider, model: presetDraft.model } : {}),
      ...(effort === '' ? {} : { reasoningEffort: effort }),
    }
    const next = editingPresetId === null
      ? [...current, entry]
      : current.map((preset) => (preset.id === editingPresetId ? entry : preset))
    persistPresets(next, entry.id)
    closePresetForm()
  }

  const deletePreset = (id: string): void => {
    if (prefs === null) return
    const current = Array.isArray(prefs.rolePresets) ? prefs.rolePresets : []
    persistPresets(current.filter((preset) => preset.id !== id))
    if (editingPresetId === id) closePresetForm()
  }

  /**
   * B3+：把某条预设设为**缺省值**（单一缺省，沿用宿主 `agent-presets.default` 语义；
   * 点同一条即取消）。缺省值只在"专家管理面板打开且表单为空"时用于预填，
   * 不改变任何既有语义（预置仍为空、加速仍靠手动选择）。
   */
  const toggleDefaultPreset = (id: string): void => {
    if (prefs === null) return
    const next: RoundTablePrefs = { ...prefs, defaultPresetId: prefs.defaultPresetId === id ? '' : id }
    setPrefs(next)
    void rpc<RoundTablePrefs>('roundtable/prefs.set', { ...next }).then((result) => {
      if (result.ok) setPrefs(result.value)
    })
  }

  /** 当前编辑表单所选模型声明的档位词表（宿主 `reasoning.efforts` 逐字）。 */
  const draftEfforts = (): { id: string; name: string; description?: string }[] => {
    const provider = providers.find((candidate) => candidate.id === presetDraft.provider)
    const model = provider?.models.find((candidate) => candidate.id === presetDraft.model)
    return model?.reasoning?.efforts ?? []
  }

  const formatTs = (ts: number): string => {
    try {
      const date = new Date(ts)
      const pad = (value: number): string => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    } catch {
      return String(ts)
    }
  }

  if (prefs === null) {
    return <div className={styles.note}>{loadFailed ? t('settingsLoadFailed') : '…'}</div>
  }

  const presets = Array.isArray(prefs.rolePresets) ? prefs.rolePresets : []

  return (
    <div className={styles.root}>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsDefaultMode')}</label>
        <select
          className={styles.select}
          value={prefs.defaultMode}
          onChange={(event) => patch({ defaultMode: event.target.value as RoundTablePrefs['defaultMode'] })}
        >
          <option value="orchestrated">{t('modeOrchestrated')}</option>
          <option value="egalitarian">{t('modeEgalitarian')}</option>
          <option value="redteam">{t('modeRedteam')}</option>
        </select>
        <div className={styles.hint}>{t('settingsDefaultModeHint')}</div>
        {prefs.defaultMode === 'egalitarian' ? (
          <div className={styles.warning}>{t('settingsEgalitarianWarning')}</div>
        ) : null}
      </div>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsMaxRounds')}</label>
        <input
          className={styles.input}
          type="number"
          min={0}
          value={prefs.maxRounds}
          onChange={(event) => {
            // 0 = 不限制（2026-09-24）：旧写法 `Math.max(1, …)` 会把用户刚敲下的 0
            // 立刻改写成 1 —— 用户看到自己输入被无声顶掉，且永远存不进"不限制"。
            const value = Math.max(0, Math.floor(Number(event.target.value) || 0))
            patch({ maxRounds: value })
          }}
        />
        {prefs.maxRounds === 0 ? <span className={styles.hint}>{t('settingsUnlimitedTag')}</span> : null}
      </div>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsMaxTokens')}</label>
        <input
          className={styles.input}
          type="number"
          min={0}
          step={1000}
          value={prefs.maxTokens}
          onChange={(event) => {
            // 同上：0 是合法值，不得回落到 1000。
            const value = Math.max(0, Math.floor(Number(event.target.value) || 0))
            patch({ maxTokens: value })
          }}
        />
        {prefs.maxTokens === 0 ? <span className={styles.hint}>{t('settingsUnlimitedTag')}</span> : null}
        <div className={styles.hint}>{t('settingsBudgetUnlimitedHint')}</div>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsShowAll')}</label>
        <label className={styles.switchRow}>
          <input
            type="checkbox"
            className={styles.switchInput}
            checked={prefs.showAllMeetings}
            onChange={(event) => patch({ showAllMeetings: event.target.checked })}
          />
          <span className={styles.switchTrack} aria-hidden="true" />
          <span className={styles.switchLabel}>{prefs.showAllMeetings ? t('settingsShowAllOn') : t('settingsShowAllOff')}</span>
        </label>
        <div className={styles.hint}>{t('settingsShowAllHint')}</div>
      </div>
      <div className={styles.sectionDivider} />
      <div className={styles.sectionTitle}>{t('settingsPanelsTitle')}</div>
      <div className={styles.field}>
        <div className={styles.panelToggles}>
          {(prefs.panels !== undefined && prefs.panels.length > 0 ? prefs.panels : Object.keys(PANEL_LABELS)).map((id) => {
            const labelKey = PANEL_LABELS[id]
            // host 新增了面板而客户端还没跟上：宁可不渲染，也不给一个"点了没用"的死开关
            if (labelKey === undefined) return null
            const visible = !(Array.isArray(prefs.hiddenPanels) ? prefs.hiddenPanels : []).includes(id)
            return (
              <button
                key={id}
                type="button"
                className={visible ? styles.panelToggleOn : styles.panelToggleOff}
                aria-pressed={visible}
                title={`${t(labelKey)} · ${visible ? t('panelOn') : t('panelOff')}`}
                onClick={() => togglePanel(id)}
              >
                <span className={styles.panelDot} aria-hidden="true" />
                <span className={styles.panelToggleLabel}>{t(labelKey)}</span>
              </button>
            )
          })}
        </div>
        <div className={styles.hint}>{t('settingsPanelsHint')}</div>
      </div>
      <div className={styles.sectionDivider} />
      <div className={styles.sectionTitle}>{t('settingsSkillTitle')}</div>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsSkillDelivery')}</label>
        <select
          className={styles.select}
          value={prefs.skillDelivery === 'direct' ? 'direct' : 'relay'}
          onChange={(event) => patch({ skillDelivery: event.target.value === 'direct' ? 'direct' : 'relay' })}
        >
          <option value="relay">{t('settingsSkillDeliveryRelay')}</option>
          <option value="direct">{t('settingsSkillDeliveryDirect')}</option>
        </select>
        <div className={styles.hint}>
          {prefs.skillDelivery === 'direct' ? t('settingsSkillDeliveryDirectHint') : t('settingsSkillDeliveryRelayHint')}
        </div>
      </div>
      <div className={styles.sectionDivider} />
      <div className={styles.sectionTitle}>{t('settingsPresetsTitle')}</div>
      <div className={styles.field}>
        <div className={styles.hint}>{t('settingsPresetsHint')}</div>
        {/* 目录读取失败：显式提示（否则与"这个 provider 没有模型"完全同形）。 */}
        {catalogFailures.length > 0 ? (
          <div className={styles.warning}>
            {catalogFailures.map((failure) => `${failure.name || failure.id}: ${failure.message}`).join(' / ')}
          </div>
        ) : null}
        {presets.length === 0 ? (
          <div className={styles.note}>{t('settingsPresetsEmpty')}</div>
        ) : (
          <div className={styles.presetList}>
            {presets.map((preset) => (
              <div key={preset.id} className={styles.presetItem}>
                <div className={styles.presetInfo}>
                  <div className={styles.presetName}>
                    {preset.name}
                    {prefs.defaultPresetId === preset.id ? (
                      <span className={styles.presetDefaultBadge}>{t('settingsPresetDefaultBadge')}</span>
                    ) : null}
                  </div>
                  <div className={styles.presetMeta}>{preset.role}</div>
                  <div className={styles.presetRoute}>
                    {preset.provider !== undefined && preset.provider !== '' && preset.model !== undefined && preset.model !== ''
                      ? `${preset.provider}/${preset.model}`
                      : t('manageModelInherit')}
                    {/* 档位摘要：不显示则用户无法察觉"设了档位但被净化层丢掉"。 */}
                    {preset.reasoningEffort !== undefined && preset.reasoningEffort !== ''
                      ? ` @${preset.reasoningEffort}`
                      : ''}
                  </div>
                  {presetSavedId === preset.id && presetNotice === 'saved' ? (
                    <div className={styles.presetItemNotice}>{t('settingsPresetUpdated')}</div>
                  ) : null}
                </div>
                <div className={styles.presetActions}>
                  <button type="button" className={styles.presetBtn} onClick={() => toggleDefaultPreset(preset.id)}>
                    {prefs.defaultPresetId === preset.id ? t('settingsPresetClearDefault') : t('settingsPresetSetDefault')}
                  </button>
                  <button
                    type="button"
                    className={styles.presetBtn}
                    aria-expanded={presetFormOpen && editingPresetId === preset.id}
                    onClick={() => {
                      // 再次点「编辑」＝收起（同一按钮既开又关，不需要额外的取消键）。
                      if (presetFormOpen && editingPresetId === preset.id) closePresetForm()
                      else openPresetForm(preset)
                    }}
                  >
                    {t('settingsPresetEdit')}
                  </button>
                  <button
                    type="button"
                    className={`${styles.presetBtn} ${styles.presetDeleteBtn}`}
                    onClick={() => deletePreset(preset.id)}
                  >
                    {t('settingsPresetDelete')}
                  </button>
                </div>
                {/* 行内编辑：点该条「编辑」时，表单就长在这一条下方 ——
                    "改的是第几条"与三个选择器同屏（列表本身是 260px 滚动容器）。 */}
                {presetFormOpen && editingPresetId === preset.id ? (
                  <PresetForm
                    draft={presetDraft}
                    efforts={draftEfforts()}
                    providers={providers}
                    formRef={formRef}
                    t={t}
                    inline
                    onDraft={setPresetDraft}
                    onSave={submitPreset}
                    onCancel={closePresetForm}
                  />
                ) : null}
              </div>
            ))}
          </div>
        )}
        {/* 新建预设：列表下方（没有"是哪一条"的问题）。 */}
        {presetFormOpen && editingPresetId === null ? (
          <PresetForm
            draft={presetDraft}
            efforts={draftEfforts()}
            providers={providers}
            formRef={formRef}
            t={t}
            inline={false}
            onDraft={setPresetDraft}
            onSave={submitPreset}
            onCancel={closePresetForm}
          />
        ) : null}
        {!presetFormOpen ? (
          <button type="button" className={styles.presetAddBtn} onClick={() => openPresetForm()}>
            + {t('settingsPresetAdd')}
          </button>
        ) : null}
        {presetNotice === 'saved' ? <span className={styles.saved}>{t('settingsPresetUpdated')}</span> : null}
        {presetNotice === 'failed' ? (
          <span className={styles.failed} title={presetFailReason}>
            {t('settingsSaveFailed')}
            {presetFailReason === '' ? null : `: ${t('settingsSaveFailedDetail')} ${presetFailReason}`}
          </span>
        ) : null}
        {presetNotice === 'invalid' ? <span className={styles.failed}>{t('settingsPresetInvalid')}</span> : null}
        {presetNotice === 'limit' ? (
          <span className={styles.failed}>{t('settingsPresetLimit').replace('{max}', String(ROLE_PRESET_LIMIT))}</span>
        ) : null}
      </div>
      <div className={styles.sectionDivider} />
      <div className={styles.sectionTitle}>{t('settingsLimitsTitle')}</div>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsExpertMaxTokens')}</label>
        <input
          className={styles.input}
          type="number"
          min={0}
          step={500}
          value={prefs.expertMaxTokens}
          onChange={(event) => {
            const value = Math.max(0, Math.floor(Number(event.target.value) || 0))
            patch({ expertMaxTokens: value })
          }}
        />
        <div className={styles.hint}>{t('settingsExpertMaxTokensHint')}</div>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>{t('settingsExpertMaxOpinions')}</label>
        <input
          className={styles.input}
          type="number"
          min={0}
          value={prefs.expertMaxOpinions}
          onChange={(event) => {
            const value = Math.max(0, Math.floor(Number(event.target.value) || 0))
            patch({ expertMaxOpinions: value })
          }}
        />
        <div className={styles.hint}>{t('settingsExpertMaxOpinionsHint')}</div>
      </div>
      <div className={styles.sectionDivider} />
      <div className={styles.sectionTitle}>{t('feedbackTitle')}</div>
      <div className={styles.field}>
        <label className={styles.label}>{t('feedbackEnabled')}</label>
        <label className={styles.switchRow}>
          <input
            type="checkbox"
            className={styles.switchInput}
            checked={prefs.feedbackEnabled !== false}
            onChange={(event) => patch({ feedbackEnabled: event.target.checked })}
          />
          <span className={styles.switchTrack} aria-hidden="true" />
          <span className={styles.switchLabel}>
            {prefs.feedbackEnabled !== false ? t('settingsShowAllOn') : t('settingsShowAllOff')}
          </span>
        </label>
        <div className={styles.hint}>{t('feedbackEnabledHint')}</div>
        <div className={styles.feedbackNote}>{t('feedbackPrivacyNote')}</div>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>{t('feedbackListTitle')}</label>
        {feedbackLoadFailed ? (
          <div className={styles.note} title={feedbackFailReason}>
            {t('feedbackLoadFailed')}
            {feedbackFailReason === '' ? null : `: ${t('settingsSaveFailedDetail')} ${feedbackFailReason}`}
          </div>
        ) : feedback.length === 0 ? (
          <div className={styles.note}>{t('feedbackListEmpty')}</div>
        ) : (
          <div className={styles.feedbackList}>
            {feedback.map((entry) => (
              <div key={entry.id} className={styles.feedbackItem}>
                <div className={styles.feedbackMeta}>
                  {t('feedbackEntryMeta')
                    .replace('{date}', formatTs(entry.ts))
                    .replace('{mode}', entry.mode)
                    .replace('{providers}', [...new Set([...entry.providers, ...entry.models])].join(', ') || '-')
                    .replace('{rounds}', String(entry.usedRounds))
                    .replace('{tokens}', String(entry.usedTokens))
                    .replace('{rating}', RATING_LABEL[entry.rating] ?? entry.rating)}
                </div>
                {entry.note !== undefined && entry.note !== '' ? (
                  <div className={styles.feedbackNoteText}>{entry.note}</div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <button type="button" className={styles.feedbackClearBtn} onClick={clearFeedback}>
          {t('feedbackClear')}
        </button>
        {feedbackCleared ? <span className={styles.saved}>{t('feedbackCleared')}</span> : null}
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.saveButton} disabled={saving} onClick={save}>
          {saving ? '…' : t('settingsSave')}
        </button>
        {saved ? <span className={styles.saved}>{t('settingsSaved')}</span> : null}
        {saveFailed ? (
          <span className={styles.failed} title={saveFailedReason}>
            {t('settingsSaveFailed')}
            {saveFailedReason === '' ? null : `: ${t('settingsSaveFailedDetail')} ${saveFailedReason}`}
          </span>
        ) : null}
      </div>
    </div>
  )
}