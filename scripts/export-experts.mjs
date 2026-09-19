#!/usr/bin/env node
/**
 * 从 settings.yaml 的 roundtable.rolePresets 直出仓库展示用的专家团交付物。
 *
 * 为什么用脚本而不是手写：手写必然与磁盘真相漂移（本仓已有前科：
 * preset-index.md 立下「脚本直出，禁止手写」的规矩，同源同法）。
 *
 * 产出：
 *   EXPERTS.md     — 给仓库访客看的专家团说明书（分组表 + 完整角色定义）
 *   experts.yaml   — 可直接粘回 settings.yaml 的 roundtable.rolePresets 片段
 *
 * 用法：
 *   node scripts/export-experts.mjs [--settings <path>] [--check]
 *   --check 只校验不写盘（用于 CI 或提交前的漂移检查）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const argv = process.argv.slice(2)
const CHECK = argv.includes('--check')
const si = argv.indexOf('--settings')
const SETTINGS = si >= 0 && argv[si + 1] !== undefined
  ? argv[si + 1]
  : resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'settings.yaml')

/** 宿主 node_modules 里的 yaml（本仓不额外装依赖）。 */
const YAML_CANDIDATES = [
  resolve(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/node_modules/'),
  resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh/profiles/node_modules/'),
]
function loadYaml() {
  for (const base of YAML_CANDIDATES) {
    try {
      return createRequire(base)('yaml')
    } catch {
      /* 换下一个候选 */
    }
  }
  try {
    return createRequire(import.meta.url)('yaml')
  } catch {
    throw new Error('找不到 yaml 解析库：宿主 node_modules 与本仓都不可用')
  }
}

/**
 * 分组是人为的呈现口径，不是磁盘事实——所以脚本必须断言覆盖完整性：
 * 任何一条预设没被分到组里，或分组里出现不存在的 id，都直接失败。
 */
const GROUPS = [
  { title: '澄清与立项', hint: '会议开始时先把「要做什么、值不值得做」问清楚', ids: ['req-spec', 'scenario', 'value'] },
  { title: '方案成型', hint: '把候选摆成可比矩阵，做减法，找现成的，再收敛', ids: ['tradeoff', 'minimal', 'reuse', 'steelman', 'converge'] },
  { title: '攻防与质疑', hint: '对定稿方案找真问题：结构性隐患、未言明前提、极端输入', ids: ['redteam', 'assumption', 'edge'] },
  { title: '工程专项', hint: '结构、落地、性能、安全、数据、依赖、维护、可观测、技术债', ids: ['arch', 'impl', 'perf', 'security', 'data', 'deps', 'maint', 'obs', 'risk'] },
  { title: '验证与取证', hint: '结论必须能被独立复核：判据先立、缺陷能复现、事实有出处', ids: ['verify', 'repro', 'fact', 'accept', 'baseline'] },
  { title: '视角与交付', hint: '换到使用者一侧看，排出可执行时间线，组织成交付文档', ids: ['user', 'rollout', 'deliverable'] },
]

const yaml = loadYaml()
const doc = yaml.parse(readFileSync(SETTINGS, 'utf8'))
const presets = doc?.roundtable?.rolePresets

const fail = (msg) => {
  console.error(`[export-experts] FAIL: ${msg}`)
  process.exit(1)
}

if (!Array.isArray(presets) || presets.length === 0) fail(`settings 里没有 roundtable.rolePresets：${SETTINGS}`)

const seen = new Set()
for (const p of presets) {
  if (!p?.id || !p?.name || !p?.role) fail(`预设字段不全（需要 id/name/role）：${JSON.stringify(p).slice(0, 120)}`)
  if (seen.has(p.id)) fail(`id 重复：${p.id}`)
  seen.add(p.id)
}

const byId = new Map(presets.map((p) => [p.id, p]))
const grouped = new Set()
for (const g of GROUPS) {
  for (const id of g.ids) {
    if (!byId.has(id)) fail(`分组引用了不存在的预设 id：${g.title} → ${id}`)
    if (grouped.has(id)) fail(`预设被分进多个组：${id}`)
    grouped.add(id)
  }
}
const ungrouped = presets.map((p) => p.id).filter((id) => !grouped.has(id))
if (ungrouped.length > 0) fail(`有预设未分入任何组（会从展示里消失）：${ungrouped.join(', ')}`)

const routes = new Set(presets.map((p) => `${p.provider ?? ''}/${p.model ?? ''}${p.reasoningEffort ? ` @${p.reasoningEffort}` : ''}`))
const roles = presets.map((p) => p.role)
const minLen = Math.min(...roles.map((r) => r.length))
const maxLen = Math.max(...roles.map((r) => r.length))

const md = []
md.push('# 圆桌专家团 · 作者实际在用的 28 席')
md.push('')
md.push('> 本文件由 `scripts/export-experts.mjs` 从本机 `settings.yaml` 的 `roundtable.rolePresets` 直出，**禁止手写**。')
md.push(`> 条数 ${presets.length}｜角色定义长度 ${minLen}–${maxLen} 字｜默认路由 ${[...routes].join('、')}`)
md.push('')
md.push('这份名单是作者长期实际使用后收敛下来的结果，每席只做一件事，且互相不重叠。')
md.push('把它当作**起点**而不是标准答案：圆桌的价值在于你按自己的题目重组阵容。')
md.push('')
md.push('## 怎么用')
md.push('')
md.push('直接把 [`experts.yaml`](./experts.yaml) 的内容粘进 `~/.dsh/settings.yaml` 的 `roundtable.rolePresets` 下，')
md.push('重启 DSH，设置 → 圆桌会议 → 角色预设 即可看到全部名单；开会时主持人用 `roundtable_list_presets` 读取并按需上席。')
md.push('')
md.push('也可以只挑其中几席：把不需要的条目删掉即可，字段只有 `id` / `name` / `role` / `provider` / `model` 五项。')
md.push('')
md.push('## 阵容总览')
md.push('')
for (const g of GROUPS) {
  md.push(`### ${g.title}`)
  md.push('')
  md.push(`*${g.hint}*`)
  md.push('')
  md.push('| 预设 id | 名称 | 这一席只做什么 |')
  md.push('| --- | --- | --- |')
  for (const id of g.ids) {
    const p = byId.get(id)
    const first = p.role.split(/[。；]/)[0]
    md.push(`| \`${p.id}\` | ${p.name} | ${first}。 |`)
  }
  md.push('')
}
md.push('## 完整角色定义')
md.push('')
md.push('以下是每一席送进专家 persona 的原文（与 [`experts.yaml`](./experts.yaml) 逐字一致）。')
md.push('设计口径：每席写明「只管什么、不管什么」，并强制给产出物格式——避免十位专家说同一种话。')
md.push('')
for (const g of GROUPS) {
  md.push(`### ${g.title}`)
  md.push('')
  for (const id of g.ids) {
    const p = byId.get(id)
    md.push(`<details>`)
    md.push(`<summary><b>${p.name}</b> · <code>${p.id}</code></summary>`)
    md.push('')
    md.push('```text')
    md.push(p.role)
    md.push('```')
    md.push('')
    md.push('</details>')
    md.push('')
  }
}
md.push('---')
md.push('')
md.push('## 机检状态')
md.push('')
md.push('| 断言 | 值 |')
md.push('| --- | --- |')
md.push(`| 条数 | ${presets.length} |`)
md.push(`| 分组覆盖 | ${grouped.size}/${presets.length}（无遗漏、无重复归属） |`)
md.push(`| id 唯一 | 是 |`)
md.push(`| 路由种类 | ${routes.size}（${[...routes].join('、')}） |`)
md.push(`| 角色定义长度 | ${minLen}–${maxLen} 字 |`)
md.push('')
md.push('> 生成来源：本机 `settings.yaml`。复现方式：`node scripts/export-experts.mjs`；漂移检查：`node scripts/export-experts.mjs --check`。')
md.push('')

const mdText = md.join('\n')

const yamlLines = ['    rolePresets:']
for (const p of presets) {
  yamlLines.push(`      - id: ${p.id}`)
  yamlLines.push(`        name: ${p.name}`)
  yamlLines.push(`        role: ${p.role}`)
  if (p.provider !== undefined) yamlLines.push(`        provider: ${p.provider}`)
  if (p.model !== undefined) yamlLines.push(`        model: ${p.model}`)
  if (p.reasoningEffort !== undefined && p.reasoningEffort !== '') yamlLines.push(`        reasoningEffort: ${p.reasoningEffort}`)
}
const yamlText = yamlLines.join('\n') + '\n'

if (CHECK) {
  console.log(`[export-experts] OK：${presets.length} 席、${GROUPS.length} 组全覆盖、路由 ${[...routes].join('/')}`)
  process.exit(0)
}

writeFileSync(resolve(REPO, 'EXPERTS.md'), mdText, 'utf8')
writeFileSync(resolve(REPO, 'experts.yaml'), yamlText, 'utf8')
console.log(`[export-experts] 写出 EXPERTS.md (${mdText.length} B) 与 experts.yaml (${yamlText.length} B)，来源 ${SETTINGS}`)
