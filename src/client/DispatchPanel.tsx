/**
 * 调度面板（R-D-UI）：把本轮的**并行/串行取舍**与**专家候选池**画进拓扑页右栏。
 *
 * 为什么独立成模块（而不是内联在 `RoundTableView.tsx` 里）：
 *  1. **可渲染断言**：内联在 1900 行的视图里，任何测试都只能做"源码字符串"断言
 *     （证明"写了渲染"），无法证明"渲染出来的 DOM 是对的"。
 *     抽出来之后 `test/dispatch-render.test.mjs` 用 react-dom/server 真渲染它，
 *     断言真 DOM —— 这正是专家席对"声明消费者 ≠ 渲染生效"的那条要求。
 *  2. 视图已经逼近装配上限，抽模块符合本仓"逼近上限先抽模块函数"的纪律。
 *
 * 数据全部来自 host 快照（`WireMeeting.plan` / `talentPool` + `prefs.rolePresets`），
 * 本组件**不做任何判定**：不重算波次、不按 role 文本配对在场席。
 *
 * @module dsh-plugin-roundtable/client/DispatchPanel
 */

import type { RoundTableKey } from './locales.ts'
import type { WireDispatchPlan, WireRolePreset } from './wire.ts'

/**
 * 面板需要的样式类（由视图传入自己的 CSS Modules 对象，避免此处耦合样式实现）。
 *
 * 值允许 `undefined`：CSS Modules 的类型声明把类名标成 `string | undefined`
 * （`css-modules.d.ts`），而**运行时**它们总是存在。这里如实接受该类型 ——
 * 若在视图里用 `!` 断言抹掉，就等于把"类名可能不存在"这件事藏起来。
 */
export interface DispatchPanelStyles {
  digestSectionTitle: string | undefined
  kbRow: string | undefined
  kbName: string | undefined
  kbMeta: string | undefined
  kbError: string | undefined
  logRow: string | undefined
  logHead: string | undefined
  logFrom: string | undefined
  logTime: string | undefined
  logText: string | undefined
  manageHint: string | undefined
  panelEmpty: string | undefined
}

export interface DispatchPanelProps {
  /** 本轮调度计划（旧 host 不返回时 undefined ⇒ 视为"没做分析"）。 */
  plan: WireDispatchPlan | undefined
  /** 全局预设清单（来自 prefs.get，不随 1Hz 快照重复搬运）。 */
  presets: readonly WireRolePreset[]
  /** 本会议已在场的预设 id（来自快照的 talentPool.onStage）。 */
  onStageIds: ReadonlySet<string>
  /** 面板 id 打开设置页时的隐藏类（由视图的 panelClass 决定）。 */
  className: string
  /** 文案键渲染函数（视图的 translate）。 */
  t: (key: RoundTableKey) => string
  styles: DispatchPanelStyles
}

/** 把 `{n}` 占位替换成实际波次号。 */
function withNumber(template: string, n: number): string {
  return template.replace('{n}', String(n))
}

export function DispatchPanel(props: DispatchPanelProps): JSX.Element {
  const { plan, presets, onStageIds, className, t, styles } = props

  // 三态显式分叉，**绝不留白**：留白会被读成"本轮没任务"，
  // 而真相可能是"没做分析"或"计划坏了"。
  let body: JSX.Element
  if (plan === undefined || !plan.recorded) {
    body = <div className={styles.panelEmpty}>{t('dispatchNoPlan')}</div>
  } else if (!plan.parsable) {
    body = <div className={styles.panelEmpty}>{t('dispatchUnparsable')}</div>
  } else {
    body = (
      <>
        {plan.note !== '' ? (
          <div className={styles.logText}>{t('dispatchPlanNote')}：{plan.note}</div>
        ) : null}
        {plan.waves.map((wave) => (
          <div key={wave.wave}>
            <div className={styles.digestSectionTitle}>
              {withNumber(t('dispatchWave'), wave.wave)}
              {' · '}
              {wave.wave === 1
                ? t('dispatchWaveParallel')
                : withNumber(t('dispatchWaveWait'), wave.wave - 1)}
            </div>
            {wave.items.map((item) => (
              <div className={styles.kbRow} key={item.id}>
                <span className={styles.kbName} title={item.task}>{item.id}</span>
                <span className={styles.kbMeta}>→ {item.owner}</span>
              </div>
            ))}
          </div>
        ))}
      </>
    )
  }

  return (
    <section className={className} data-rt-panel="dispatch">
      <div className={styles.digestSectionTitle}>{t('dispatch')}</div>
      <div>
        {body}
        {/* 对账：计划说了发给谁 vs 实际发给谁（两类偏差分别列）。 */}
        {plan !== undefined && plan.undispatchedOwners.length > 0 ? (
          <div className={styles.kbError}>
            {t('dispatchUndispatched')}：{plan.undispatchedOwners.join('、')}
          </div>
        ) : null}
        {plan !== undefined && plan.unplannedDispatches.length > 0 ? (
          <div className={styles.kbMeta}>
            {t('dispatchUnplanned')}：{plan.unplannedDispatches.join('、')}
          </div>
        ) : null}
        {plan !== undefined && plan.gaps.length > 0 ? (
          <div>
            <div className={styles.digestSectionTitle}>{t('dispatchGap')}</div>
            {plan.gaps.map((gap) => (
              <div className={styles.kbRow} key={gap.item}>
                <span className={styles.kbName}>{gap.presetId}</span>
                <span className={styles.kbMeta}>
                  {gap.presetName}
                  {gap.onStage ? ` · ${t('dispatchGapOnStage')}` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {/* [越界转派]（单线制专属）：host 已按模式过滤，圆桌制恒空。 */}
        {plan !== undefined && plan.outOfScope.length > 0 ? (
          <div>
            <div className={styles.digestSectionTitle}>{t('dispatchOutOfScope')}</div>
            {plan.outOfScope.map((handoff) => (
              <div className={styles.logRow} key={`${handoff.round}-${handoff.fromSeat}-${handoff.item}`}>
                <div className={styles.logHead}>
                  <span className={styles.logFrom}>
                    {handoff.fromSeat}
                    {handoff.suggestedRole !== '' ? ` → ${handoff.suggestedRole}` : ''}
                  </span>
                  <span className={styles.logTime}>R{handoff.round}</span>
                </div>
                <div className={styles.logText}>{handoff.item}</div>
              </div>
            ))}
          </div>
        ) : null}
        {/* 专家候选池：清单是全局的（prefs），这里只叠加本会议的在场标记。 */}
        <div className={styles.digestSectionTitle}>{t('dispatchPoolTitle')}</div>
        {presets.length === 0 ? (
          <div className={styles.panelEmpty}>{t('dispatchPoolNone')}</div>
        ) : (
          <>
            {presets.map((preset) => (
              <div className={styles.kbRow} key={preset.id} title={preset.role}>
                <span className={styles.kbName}>{preset.name}</span>
                <span className={styles.kbMeta}>
                  {onStageIds.has(preset.id)
                    ? `${preset.id} · ${t('dispatchPoolOnStage')}`
                    : preset.id}
                </span>
              </div>
            ))}
            <div className={styles.manageHint}>{t('dispatchPoolHint')}</div>
          </>
        )}
      </div>
    </section>
  )
}
