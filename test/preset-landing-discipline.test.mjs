/**
 * 落点纪律守卫（2026-09-23 · 用户点明「项目是项目，角色预设是角色预设」）。
 *
 * ══ 判因（实测我自己的两次越位）════════════════════════════════════════════════
 *  ① `tools.ts` 的 close 提示曾让主持人去用 **`dispute` 预设** —— 而用户 28 席里
 *     **并没有这个预设**（幽灵引用）。主持人照做会扑空。
 *  ② `index.ts` 的 usage rule 18 曾把 `arch`/`verify`/`repro`… 当"标准答案"列出来。
 *  二者都把**用户的可变资产**（预设库可改名、可删除、可清空）写进了项目源码。
 *
 * ══ 判据演进（两次被实测打回，留档以免重犯）════════════════════════════════════
 * **v1「带引号的预设 id」⇒ 大量假阳性**：`'redteam'`（模式枚举）、`'repro'`（证据类型）、
 *   `'user'`（来源字段）与某些预设 id **同名碰撞**，但它们与预设毫无关系。
 *
 * **v2「反引号包裹的预设 id」⇒ 对"幽灵引用"结构性失明**：它遍历**用户现有的** id 集，
 *   而 `dispute` **不在**那个集合里（那正是"引用了一个不存在的预设"的定义）
 *   ⇒ 恰恰抓不到它本该抓的那一类。**判据方向是反的。**
 *
 * **v3（本版）「项目源码里的角色席引用，必须能在用户的预设库里解析到」**：
 *   不问"哪些 id 被写了"，而问"**写了的东西存在吗**"。
 *   做法：扫 model-facing 散文（`index.ts` 的 usage / `tools.ts` 的 description 与
 *   render 文案）里所有 `` `xxx` `` 反引号 token，凡是**长得像预设 id** 的
 *   （kebab-case ASCII），必须在用户的预设 id 集里能解析到；解析不到 ⇒ 幽灵引用，判红。
 *
 * ══ 判据边界（刻意留的余地，避免脆弱启发式）══════════════════════════════════
 *  · 只扫**反引号 token**：项目枚举（`kind: 'repro'`、`=== 'redteam'`）从不这样写；
 *    注释**整段剥离**（留档历史事故是合法的，且删掉注释里的教训比留着更坏）；
 *  · 只认 **kebab-case ASCII** 形状（`req-spec` / `dispute`），自然语言与中文不受影响；
 *  · 命中后还要**排除已登记的非预设白名单**（如工具名 `roundtable_*`、字段名
 *    `regression_risk`、模式名 `orchestrated`）——它们同样是反引号 token 但不是预设；
 *  · 读不到 settings.yaml ⇒ **跳过不判红**（环境侧缺失不该误报成代码问题）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SRC = new URL('../src/', import.meta.url)
const SETTINGS = join(homedir(), '.dsh', 'settings.yaml')

/**
 * 非预设的反引号 token 白名单：工具名 / 字段名 / 参数名 / 模式名 —— 它们不是角色预设。
 *
 * ⚠ 白名单是**判据的一部分**，不是"为了让它变绿"的补丁：这些词是**项目自己的词汇**
 * （参数名、工具名、领域枚举），与用户预设库无关。判据要区分的正是
 * 「项目词汇」与「用户资产」，白名单是那个区分的显式声明 ——
 * 每加一条都要能回答"它为什么属于项目而非用户"。
 */
const NON_PRESET_TOKENS = new Set([
  // 协作模式与 skill 传递方式（项目自己的领域枚举）
  'orchestrated', 'egalitarian', 'redteam', 'relay', 'direct',
  // 工具名（项目注册的，不随用户变）
  'roundtable_list_presets', 'roundtable_add_node', 'roundtable_create', 'roundtable_status',
  'roundtable_plan_meeting', 'roundtable_send_message', 'roundtable_next_round', 'roundtable_close',
  'roundtable_speak', 'roundtable_summarize', 'roundtable_request_decision', 'roundtable_export_meeting',
  'roundtable_kb_digest', 'roundtable_proxy_think', 'roundtable_connect', 'roundtable_disconnect',
  'roundtable_actions_clear', 'roundtable_set_budget', 'roundtable_start_review',
  'roundtable_collect_review', 'roundtable_finish_review', 'roundtable_export_review', 'roundtable_remove_node',
  // 工具参数名与字段名（add_node / plan_meeting / plan item 的接口词汇）
  'preset', 'role', 'provider', 'model', 'key', 'name', 'task', 'owner', 'kind', 'to', 'content', 'id',
  'change', 'review', 'survey', 'depends_on', 'work_item', 'regression_risk',
  'boundary_not_doing', 'boundary_goal', 'boundary_done', 'user_directive', 'skip_plan_card',
  'plan_card_skipped', 'talent_pool', 'round_signals', 'on_stage', 'skill_delivery',
  // 会议状态与审计 kind（领域枚举）
  'active', 'muted', 'ended', 'archived', 'capacity-over', 'gate-reject', 'all', 'captain', 'aggregator',
])

/** 只扫 model-facing 散文：usage 段与工具 description/render 文案。 */
function modelFacingText() {
  const files = ['index.ts', 'tools.ts']
  return files
    .map((f) => ({ name: f, text: readFileSync(new URL(f, SRC), 'utf8') }))
    .map(({ name, text }) => ({
      name,
      // 剥离注释（留档历史不判）与 import/type 行（那不是在跟模型说话）
      text: text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
        .split('\n')
        .filter((line) => !/^\s*(import|export type|export interface)/.test(line))
        .join('\n'),
    }))
}

/** 从 settings.yaml 抽 rolePresets 的 id 集。 */
function userPresetIds() {
  if (!existsSync(SETTINGS)) return undefined
  const raw = readFileSync(SETTINGS, 'utf8')
  const at = raw.indexOf('rolePresets:')
  if (at < 0) return undefined
  const ids = [...raw.slice(at).matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => m[1].replace(/['"]/g, ''))
  return ids.length === 0 ? undefined : ids
}

test('落点纪律：项目源码不得引用用户预设库里「不存在」的角色 id（幽灵引用）', () => {
  const ids = userPresetIds()
  if (ids === undefined) {
    console.log('  （跳过：读不到 settings.yaml 的 rolePresets —— 环境侧缺失，不判红）')
    return
  }
  const known = new Set(ids)
  const offenders = []
  for (const { name, text } of modelFacingText()) {
    // 反引号 token，形状像预设 id 的（kebab-case ASCII，字母开头）
    for (const m of text.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`/g)) {
      const token = m[1]
      if (NON_PRESET_TOKENS.has(token)) continue
      if (known.has(token)) continue // 解析得到 = 合法引用
      const line = text.slice(0, m.index).split('\n').length
      const snippet = text.slice(Math.max(0, m.index - 70), m.index + 60).replace(/\s+/g, ' ')
      offenders.push(`src/${name}:${line} → \`${token}\`  …${snippet}…`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '项目源码引用了**用户预设库里并不存在**的角色 id（幽灵引用：主持人照做会扑空）。'
    + '预设是用户资产（可改名、可删除、可清空），项目不得点名任何具体 id；'
    + '应改为**按职责描述**，让主持人从 roundtable_list_presets / talent_pool 动态挑。违规：\n  '
    + offenders.join('\n  '),
  )
})

test('落点纪律：动态挑席能力必须保留（不得为通过上一条而删掉预设链）', () => {
  const all = ['tools.ts', 'index.ts', 'dispatch.ts', 'rpc.ts']
    .map((f) => readFileSync(new URL(f, SRC), 'utf8'))
    .join('\n')
  /*
   * 反向守卫：上一条禁止"点名预设"，但**不能**因此把预设能力整体删掉。
   * 这条钉住"动态候选池"仍在 —— 否则守一条会拆另一条（正是拆东墙补西墙）。
   */
  assert.match(all, /getRolePresets/, '须保留读取用户预设库的能力')
  assert.match(all, /resolvePreset\(/, '须保留按引用动态解析预设（不依赖具体 id）')
  assert.match(all, /roundtable_list_presets|buildTalentPool|talent_pool/, '须保留让主持人动态挑席的入口')
})


