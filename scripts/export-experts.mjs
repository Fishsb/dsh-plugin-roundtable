#!/usr/bin/env node
/**
 * 从**宿主当前真实落盘处**的 rolePresets 直出仓库展示用的专家团交付物。
 *
 * 为什么用脚本而不是手写：手写必然与磁盘真相漂移（本仓已有前科：
 * preset-index.md 立下「脚本直出，禁止手写」的规矩，同源同法）。
 *
 * 产出：
 *   EXPERTS.md     — 给仓库访客看的专家团说明书（分组表 + 完整角色定义）
 *   experts.yaml   — 可直接粘回设置的 rolePresets 片段
 *
 * 用法：
 *   node scripts/export-experts.mjs [--settings <path> | --patch <profile>/cordis.patch.yml] [--check | --selftest]
 *   --check 只校验**真源可解析且自洽**（席数/分组覆盖/id 唯一/字段齐全），**不写盘**。
 *           ⚠ 它**不与仓库里的 EXPERTS.md / experts.yaml 比对**：产物是否落后于真源，
 *           本脚本不判（2026-09-25 实测：把两份产物换成垃圾，--check 仍 exit=0）。
 *           要判漂移得自己跑一次不带 --check 的版本再用 git diff 看。
 *   --selftest 跑**判据级自检**（6 例沙箱：多候选·主源损坏/为空/不可达、显式单源·损坏不回
 *           落、显式单源·无预设段不得说"用户清空了预设"、显式单源·确实声明为空才这么说）。
 *           只读源码、只写系统临时目录，**不碰** EXPERTS.md / experts.yaml。
 *
 * 真源（2026-09-25 前只认 ~/.dsh/settings.yaml，而该文件本机已不存在 ⇒ --check 直接
 * ENOENT/exit=1）：现在按候选列表找第一个**真的含 rolePresets**的落盘处，找不到就高声
 * 失败并说明去哪配；候选顺序与支持形态见下方 CANDIDATES 注释。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const argv = process.argv.slice(2)
const CHECK = argv.includes('--check')
const si = argv.indexOf('--settings')
const EXPLICIT_SETTINGS = si >= 0 && argv[si + 1] !== undefined ? argv[si + 1] : undefined

/*
 * ══ 判据级自检：--selftest ══════════════════════════════════════════════════════
 * 判因（2026-09-25 · 红队实测）：A6/A9/A10 三处缺陷都是**真源解析的降级行为**，
 * 用眼睛看正常态永远发现不了（正常态只有一条候选可命中）。这里把三个沙箱场景
 * **机检化**，跑 `node scripts/export-experts.mjs --selftest` 即得结论：
 *   · 多候选 · 主源损坏   ⇒ 必须打印「主源不可读」且 OK 行带回落标记（A9）
 *   · 多候选 · 主源为空   ⇒ 必须打印「主源为空」且 OK 行带回落标记（A6）
 *   · 多候选 · 主源不可达 ⇒ 落到低优先级源，**不**打印回落标记（"没有"不是"坏了"）
 *   · 显式单源 · 损坏     ⇒ exit=1，**绝不**回落（C：显式单源行为是对的）
 * 自检只读、只写临时目录，**不碰** EXPERTS.md / experts.yaml。
 */
if (argv.includes('--selftest')) {
  const pathMod = { join: joinPath }
  const os = { tmpdir }
  const selfPath = fileURLToPath(import.meta.url)
  const sandbox = mkdtempSync(pathMod.join(os.tmpdir(), 'export-experts-selftest-'))
  const homeDir = pathMod.join(sandbox, 'home')
  const profileName = 'theprofile'
  const profileDir = pathMod.join(homeDir, '.dsh', 'profiles', profileName)
  mkdirSync(profileDir, { recursive: true })

  const BROKEN = 'id: [unclosed\n  - broken:\n    - :::\n'
  const EMPTY_PATCH = '- id: roundtable\n  name: dsh-plugin-roundtable\n  config:\n    rolePresets: []\n'
  /*
   * 旧源必须**覆盖 GROUPS 的全部 id**，否则脚本会因"分组引用了不存在的预设 id"直接 fail，
   * 自检就分不清"回落标注对不对"与"数据本身不合法"。故这里按官方 28 席 id 造齐。
   */
  const SELFTEST_IDS = [
    'req-spec', 'scenario', 'value', 'tradeoff', 'minimal', 'reuse', 'converge', 'steelman',
    'redteam', 'assumption', 'edge', 'arch', 'impl', 'perf', 'security', 'data', 'deps', 'maint',
    'obs', 'risk', 'verify', 'repro', 'fact', 'accept', 'baseline', 'user', 'rollout', 'deliverable',
  ]
  const LEGACY = [
    'roundtable:',
    '  rolePresets:',
    ...SELFTEST_IDS.flatMap((id) => [
      `    - id: ${id}`,
      `      name: ${id}`,
      `      role: role of ${id}`,
      '      provider: legacy-prov',
      `      model: MARKER-LEGACY-${id}`,
    ]),
    '',
  ].join('\n')

  /*
   * 沙箱把 `USERPROFILE` 指到临时家目录（这是"多候选"路径成立的前提），
   * 于是宿主那份 yaml 解析库需要显式带过去 —— 见 `DSH_YAML_BASE` 注释。
   */
  const yamlBase = [
    resolve(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/node_modules/'),
    resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh/profiles/node_modules/'),
  ].find((base) => {
    try { createRequire(base)('yaml'); return true } catch { return false }
  }) ?? ''
  if (yamlBase === '') {
    console.error('[export-experts] SELFTEST 无法运行：找不到 YAML 解析库（宿主 node_modules 的 yaml）。')
    console.error('  ⇒ 这不是判据被打破，而是**环境缺依赖**：请在 DSH 宿主可用的机器上跑，或设 DSH_YAML_BASE 指向含 yaml 的 node_modules。')
    process.exit(2)
  }
  const run = (extraEnv) => {
    const env = { ...process.env, USERPROFILE: homeDir, DSH_PROFILE: profileName, DSH_YAML_BASE: yamlBase, ...extraEnv }
    delete env.DSH_PROFILE_DIR
    delete env.DSH_HOME
    const r = spawnSync(process.execPath, [selfPath, '--check'], { env, encoding: 'utf8', windowsHide: true })
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
  }
  const cases = []
  const record = (name, pass, detail) => cases.push({ name, pass, detail })

  // ── ① 多候选 · 主源损坏（A9）──
  writeFileSync(pathMod.join(profileDir, 'cordis.patch.yml'), BROKEN, 'utf8')
  writeFileSync(pathMod.join(homeDir, '.dsh', 'settings.yaml'), LEGACY, 'utf8')
  {
    const r = run()
    record('multi/broken-primary', r.code === 0 && /主源不可读/.test(r.out) && /已回落/.test(r.out), r.out.split('\n').slice(0, 3).join(' ⏎ '))
  }

  // ── ② 多候选 · 主源为空（A6，键确实声明）──
  writeFileSync(pathMod.join(profileDir, 'cordis.patch.yml'), EMPTY_PATCH, 'utf8')
  {
    const r = run()
    record('multi/empty-primary', r.code === 0 && /主源为空/.test(r.out) && /已回落/.test(r.out), r.out.split('\n').slice(0, 3).join(' ⏎ '))
  }

  // ── ③ 多候选 · 主源不可达（"没有"不是"坏了"：不得标注回落）──
  rmSync(pathMod.join(profileDir, 'cordis.patch.yml'), { force: true })
  {
    const r = run()
    record('multi/missing-primary', r.code === 0 && !/已回落/.test(r.out) && /MARKER-LEGACY/.test(r.out), r.out.split('\n').slice(0, 3).join(' ⏎ '))
  }

  // ── ④ 显式单源 · 损坏 ⇒ exit=1，绝不回落 ──
  writeFileSync(pathMod.join(profileDir, 'cordis.patch.yml'), BROKEN, 'utf8')
  {
    const r = run()
    const explicit = spawnSync(process.execPath, [selfPath, '--check', '--patch', pathMod.join(profileDir, 'cordis.patch.yml')], {
      env: { ...process.env, USERPROFILE: homeDir, DSH_PROFILE: profileName, DSH_YAML_BASE: yamlBase },
      encoding: 'utf8',
      windowsHide: true,
    })
    const out = (explicit.stdout ?? '') + (explicit.stderr ?? '')
    record('explicit/broken-no-fallback', explicit.status === 1 && /FAIL/.test(out) && !/MARKER-LEGACY/.test(out), out.split('\n').slice(0, 2).join(' ⏎ '))
    void r
  }

  // ── ⑤ 显式单源 · 合法 YAML 但**从未有过** roundtable 段 ⇒ 诊断不得说"用户清空了预设"（A10）──
  {
    const noPresetPath = pathMod.join(sandbox, 'no-preset-settings.yaml')
    writeFileSync(noPresetPath, 'i18n:\n  locale: zh\n', 'utf8')
    const r = spawnSync(process.execPath, [selfPath, '--check', '--settings', noPresetPath], {
      env: { ...process.env, USERPROFILE: homeDir, DSH_PROFILE: profileName, DSH_YAML_BASE: yamlBase },
      encoding: 'utf8',
      windowsHide: true,
    })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    record(
      'explicit/no-preset-section-not-mislabeled',
      r.status === 1 && !/用户清空了预设/.test(out),
      out.split('\n').filter((l) => l.trim() !== '').slice(0, 3).join(' ⏎ '),
    )
  }

  // ── ⑥ 显式单源 · **确实声明了** rolePresets: [] ⇒ 此时才该说"用户清空了预设"（A10 反面对照）──
  {
    const emptiedPath = pathMod.join(sandbox, 'emptied-settings.yaml')
    writeFileSync(emptiedPath, 'roundtable:\n  rolePresets: []\n', 'utf8')
    const r = spawnSync(process.execPath, [selfPath, '--check', '--settings', emptiedPath], {
      env: { ...process.env, USERPROFILE: homeDir, DSH_PROFILE: profileName, DSH_YAML_BASE: yamlBase },
      encoding: 'utf8',
      windowsHide: true,
    })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    record(
      'explicit/declared-empty-is-labeled',
      r.status === 1 && /用户清空了预设/.test(out),
      out.split('\n').filter((l) => l.trim() !== '').slice(0, 3).join(' ⏎ '),
    )
  }

  rmSync(sandbox, { recursive: true, force: true })
  for (const c of cases) console.log(`[selftest] ${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.pass ? '' : '  → ' + c.detail}`)
  const failed = cases.filter((c) => !c.pass)
  if (failed.length > 0) {
    console.error(`[export-experts] SELFTEST FAILED：${failed.length}/${cases.length}`)
    process.exit(1)
  }
  console.log(`[export-experts] SELFTEST OK：${cases.length}/${cases.length}`)
  process.exit(0)
}

/*
 * ══ 真源解析（2026-09-25 修 · 单一路径，失败响亮）══════════════════════════════════
 * 判因：本脚本原先只认 ~/.dsh/settings.yaml 一条死路径，而该文件在本机**已不存在**
 * （2026-09-25 实测只剩 settings.yaml.bak-* 与 settings.yaml.imported），于是
 * `--check` 直接 ENOENT / exit=1 —— 与 test/preset-landing-discipline.test.mjs 里
 * 那条 v3 死路径同根因：**判据挂在了一个属于用户的可变资产路径上**。
 *
 * 现在的口径：
 *  ① `--settings <path>` 显式给定 ⇒ 只认它（可复现、可测，CI/复核都用这条）；
 *  ② 否则按 `--patch <path>`（可选）或环境里能确定的宿主 profile patch 解析
 *     `<profile>/cordis.patch.yml` 里 id 为 `roundtable` 那条的 `config.rolePresets`
 *     —— 这是本机**当前真实**的预设落盘处（实测 28 席）；
 *  ③ 全部候选都不可达 ⇒ **高声失败**并说明去哪儿配，绝不静默产出空/半清单。
 */
const CANDIDATES = (() => {
  // 显式给出的真源就是**唯一**真源：写错了必须响亮失败，不许悄悄回落到自动探测
  // （否则"我明明指定了 X"与"其实读的是 Y"会同时成立 —— 又一种双真相）。
  if (EXPLICIT_SETTINGS !== undefined) return [{ kind: 'settings', path: EXPLICIT_SETTINGS }]
  const pi = argv.indexOf('--patch')
  if (pi >= 0) {
    return argv[pi + 1] === undefined
      ? [{ kind: 'patch', path: '' }]
      : [{ kind: 'patch', path: argv[pi + 1] }]
  }
  const env = (name) => {
    const v = process.env[name]
    // ⚠ 空串要当"未设置"：`DSH_PROFILE=''` 不能靠 ?? 兜底（'' 不是 nullish），
    // 否则会拼出 `.dsh/profiles/ `（带空目录名）这种静默失效路径。
    return v === undefined || v === '' ? undefined : v
  }
  const home = env('USERPROFILE') ?? env('HOME')
  const profile = env('DSH_PROFILE') ?? 'web'
  /*
   * ⚠ **显式优先级数组**（2026-09-25 修 · 红队实测两个缺陷）：
   * 缺陷①（优先级倒置）：上一版用 `for (…profiles) list.unshift(…)` 组装，unshift 把
   *   数组**反序**了 —— 最显式的 `DSH_PROFILE_DIR` 被排到硬编码家目录路径之后。
   *   红队实测：`DSH_PROFILE_DIR=<decoy>`（3 席）在 `DSH_PROFILE='web'` 下被真实 profile
   *   （28 席）压后，输出 28 席、不含 decoy ⇒ 显式环境变量形同虚设。
   *   现在改为**按顺序 push**，优先级从高到低逐条读得出来：
   *     ① DSH_PROFILE_DIR（宿主直接给的绝对目录，最权威）
   *     ② DSH_HOME + DSH_PROFILE（宿主给的根 + 档名）
   *     ③ ~/.dsh/profiles/<DSH_PROFILE ?? 'web'>（硬编码默认，兜底）
   *     ④ ~/.dsh/settings.yaml（旧位置，本机已不存在，仅兜底）
   */
  const list = []
  const profileDir = env('DSH_PROFILE_DIR')
  if (profileDir !== undefined) list.push({ kind: 'patch', path: resolve(profileDir, 'cordis.patch.yml') })
  const dshHome = env('DSH_HOME')
  if (dshHome !== undefined) list.push({ kind: 'patch', path: resolve(dshHome, 'profiles', profile, 'cordis.patch.yml') })
  if (home !== undefined) {
    list.push({ kind: 'patch', path: resolve(home, '.dsh', 'profiles', profile, 'cordis.patch.yml') })
    list.push({ kind: 'settings', path: resolve(home, '.dsh', 'settings.yaml') })
  }
  return list
})()

/** 宿主 node_modules 里的 yaml（本仓不额外装依赖）。 */
const YAML_CANDIDATES = [
  /*
   * ⚠ `DSH_YAML_BASE` 是给 **--selftest** 用的：自检会刻意把 `USERPROFILE` 指向临时沙箱
   * （否则测不了"多候选"路径），而宿主装着 yaml 的那份 node_modules 在**真实**家目录下。
   * 不设它时本项为空串，`createRequire('')` 抛错后被跳过，行为与从前完全一致。
   */
  process.env.DSH_YAML_BASE ?? '',
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

const fail = (msg) => {
  console.error(`[export-experts] FAIL: ${msg}`)
  process.exit(1)
}

/**
 * 把一份候选真源解析成 rolePresets 数组；**不抛**，一律返回一个状态对象
 * `{status: 'ok'|'empty'|'unreadable'|'missing', ...}`，由调用方决定是换候选还是
 * 响亮失败 —— 换候选时静默，全败时必须高声。
 *
 * ⚠ 状态取值（2026-09-25 verify 终审实测订正：本条原写「解析不出就返回 undefined」，
 *   而实际六处 return 无一返回 undefined）：
 *   · 'ok'         —— 解析出非空 rolePresets；
 *   · 'empty'      —— 文件在、**确实声明了** rolePresets（值可能为 []，也可能是非数组值），
 *                     归入「用户清空/写坏了预设」这一合法态分支（诊断措辞已注明）；
 *   · 'unreadable' —— 文件可读但 YAML 解析失败（带解析器报错首行）；
 *   · 'missing'    —— 读不到文件，或这份文件根本不是预设源（连 rolePresets 键都没有）。
 *
 * 两种真源形态：
 *  · kind='settings' —— 老式 settings.yaml，预设位于 `roundtable.rolePresets`；
 *  · kind='patch'    —— 宿主 profile 的 cordis.patch.yml，是一份**patch 数组**，
 *                       预设位于 **id==='roundtable'** 那条的 `config.rolePresets`。
 *                       ⚠ 必须按 patch 数组逐条找入口，不能假定它在数组首位；
 *                       且**必须按 entry.id 精确筛**——否则会读到别家插件的 rolePresets
 *                       并照样打印 OK（2026-09-25 红队实测的静默读错源）。
 */
/**
 * 该对象上是否**确实声明了** `rolePresets` 这个键（哪怕值是 `[]`）。
 *
 * 用途：把"用户把预设清空了"（键在、值为空 —— 合法态）与"这份文件根本不是预设源"
 * （键都没有 —— 例如只写了 i18n 的 settings.yaml）分开。用 `Object.hasOwn` 而非
 * `in`，避免把原型链上的同名属性误当成声明。
 */
function declaresRolePresets(holder) {
  return holder !== null && typeof holder === 'object' && Object.hasOwn(holder, 'rolePresets')
}

function presetsOf(source) {
  let raw
  try {
    raw = readFileSync(source.path, 'utf8')
  } catch {
    // 文件不在 / 读不了：注意这两种都进 'missing'（对使用者而言都是"没有这个东西"）
    return { status: 'missing', path: source.path }
  }
  let doc
  try {
    doc = yaml.parse(raw)
  } catch (error) {
    /*
     * ⚠ **读坏 ≠ 不存在**（2026-09-25 修 · 红队实测 A9）：
     * YAML 解析失败上一版与"文件根本不在"返回**同一个 'missing'**，于是
     * 【多候选自动探测】∧【主源存在但读坏】∧【存在更低优先级且可解析的候选】时，
     * 脚本**静默回落**到旧源、`--check` exit=0、**不带任何回落标注**
     * （红队沙箱实测：真源打印成 settings.yaml，主源损坏一事完全不可见）。
     * 现在给独立状态 'unreadable'，并带上解析器的报错首行，让"坏了"这件事可见。
     */
    const detail = String(error && error.message ? error.message : error).split('\n')[0].slice(0, 120)
    return { status: 'unreadable', path: source.path, detail }
  }
  if (source.kind === 'patch') {
    const entries = Array.isArray(doc) ? doc : [doc]
    /*
     * ⚠ **必须筛 entry.id === 'roundtable'**（2026-09-25 修 · 红队实测缺陷）：
     * 上一版只看 `entry?.config?.rolePresets` 存不存在，而本注释上一段就写着
     * "预设位于 id==='roundtable' 那条"——声明与实检不一致。红队构造"patch 数组首条是
     * **别家插件**且带 config.rolePresets"的假 patch 后实测：脚本读到**别家插件的 28 席**，
     * 照样打印 OK ⇒ 静默读错源。现在只认 id 精确等于 'roundtable' 的那条。
     *
     * 附带收益（可复现的"先红"）：假 patch 会因 roundtable 那条只有 1 席而立即
     * 触发 GROUPS 覆盖断言 —— 错源不再能装成绿。
     */
    let roundtableEntry
    for (const entry of entries) {
      if (entry?.id !== 'roundtable') continue
      roundtableEntry = entry
      const found = entry?.config?.rolePresets
      if (Array.isArray(found) && found.length > 0) {
        return { status: 'ok', presets: found, via: `${source.path} (patch entry id=roundtable)` }
      }
    }
    /*
     * ⚠ **"存在但为空"必须与"文件根本不在"分开**（2026-09-25 修 · 红队实测 A6）：
     * 用户把预设清空（rolePresets: []）或该条目缺此键，都是**合法态**，不是"文件不可达"。
     * 上一版把两者都当 undefined，于是**静默**落到低优先级的旧位置，把旧数据当真理写进
     * 交付物、`--check` 还报裸 OK（红队沙箱实测：来源判定 = settings.yaml，路由是旧值）。
     * 现在返回 status='empty' 让调用方**显式标注回落**。
     */
    /*
     * ⚠ **empty 必须收紧为"文件里确实存在 rolePresets 段落"**（2026-09-25 修 · 红队实测 A10）：
     * 上一版只要"有 id=roundtable 的条目"就报 'empty'，于是 `--settings` 指向一份
     * 合法但**从未有过** roundtable 段的 YAML（例如 `{i18n:{locale:'zh'}}`）时，诊断会说
     * 「用户清空了预设」—— 把排查引向错误方向。只有**条目里真的写了 rolePresets 这个键**
     * （哪怕值是 []）才算"清空"；键都不存在 ⇒ 这份文件根本不是预设源 ⇒ 'missing'。
     */
    // ⚠ 声明在 **entry.config** 上（不是 entry 本身）—— 别把持有者搞错，否则 empty 永远落不到。
    return roundtableEntry !== undefined && declaresRolePresets(roundtableEntry.config)
      ? { status: 'empty', path: source.path }
      : { status: 'missing', path: source.path }
  }
  const found = doc?.roundtable?.rolePresets
  if (!Array.isArray(found) || found.length === 0) {
    /*
     * 老式 settings.yaml 同样收紧（A10）：只有**文件里确实写了 roundtable.rolePresets 这个键**
     * 才叫"用户清空了预设"；键都不存在（例如一份只写了 i18n 的合法 YAML）不是预设源。
     */
    return declaresRolePresets(doc?.roundtable)
      ? { status: 'empty', path: source.path }
      : { status: 'missing', path: source.path }
  }
  return { status: 'ok', presets: found, via: source.path }
}

const resolvedSource = (() => {
  const skipped = []
  for (const source of CANDIDATES) {
    const hit = presetsOf(source)
    if (hit.status === 'ok') return { ...hit, skipped }
    /*
     * 两种"主源在这、但没给出预设"的情形都要记账 —— 否则被更低优先级顶替时无从标注：
     *  · 'empty'      文件在且**声明了** rolePresets，只是空的（用户清空预设，合法态）——A6；
     *  · 'unreadable' 文件在但**读坏/解析失败**。上一版把它与 'missing' 同值，
     *                 于是"主源损坏却静默用了旧源"完全不可见 —— A9，红队实测。
     */
    if (hit.status === 'empty' || hit.status === 'unreadable') skipped.push(hit)
  }
  return { status: 'none', skipped }
})()

if (resolvedSource.status === 'none') {
  const emptyOnes = resolvedSource.skipped.filter((hit) => hit.status === 'empty')
  const brokenOnes = resolvedSource.skipped.filter((hit) => hit.status === 'unreadable')
  const emptyHint = (emptyOnes.length === 0 && brokenOnes.length === 0)
    ? ''
    : (emptyOnes.length === 0 ? '' : `\n  其中**文件在、且确实声明了 rolePresets 但内容为空**（用户清空了预设，属合法态）：\n`
        + emptyOnes.map((hit) => `    · ${hit.path}`).join('\n'))
      + (brokenOnes.length === 0 ? '' : `\n  其中**文件在但读坏/解析失败**（不是"没有预设"）：\n`
        + brokenOnes.map((hit) => `    · ${hit.path}：${hit.detail}`).join('\n'))
  fail(
    '找不到任何可用的真源（以下候选全部不可达或其中没有 rolePresets）：\n'
    + CANDIDATES.map((c) => `  - [${c.kind}] ${c.path}`).join('\n')
    + emptyHint
    + '\n  怎么办：① 显式指定 —— `node scripts/export-experts.mjs --settings <path>`'
    + '（老式 settings.yaml 形态）或 `--patch <profile>/cordis.patch.yml`（宿主 profile 形态）；'
    + '② 或在 DSH 里打开「设置 → 圆桌会议 → 角色预设」写一条预设，'
    + '它会落到当前 profile 的 cordis.patch.yml（id=roundtable 那条的 config.rolePresets）。',
  )
}

const SETTINGS = resolvedSource.via
const presets = resolvedSource.presets

/*
 * ⚠ **回落标注**（2026-09-25 修 · 红队实测 A6）：
 * 若"更高优先级的候选**存在且可解析**、但里面没有 rolePresets"（用户清空预设的合法态），
 * 最后由**更低优先级**的候选顶替 —— 必须显式说明，否则读的人会以为读的就是主源。
 * 判定与打印都在这里做一次，`--check` 与写盘模式共用。
 */
const FALLBACK_NOTE = resolvedSource.skipped.length === 0
  ? ''
  : '⚠ ' + resolvedSource.skipped.map((hit) => (
    hit.status === 'unreadable'
      ? `主源不可读（${hit.path}：${hit.detail}）`
      : `主源为空（${hit.path}）`
  )).join('、') + `，已回落至 ${SETTINGS}`
// 任何模式下都打印**实际命中的真源路径**（A6 ①），随后（仅在真回落时）打印回落标注。
console.log(`[export-experts] 真源：${SETTINGS}`)
if (FALLBACK_NOTE !== '') console.log('[export-experts] ' + FALLBACK_NOTE)

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
md.push('> 本文件由 `scripts/export-experts.mjs` 从**当前实际命中的预设真源**（宿主 profile 的 `cordis.patch.yml`，或显式 `--settings` / `--patch`）直出，**禁止手写**。')
md.push(`> 条数 ${presets.length}｜角色定义长度 ${minLen}–${maxLen} 字｜默认路由 ${[...routes].join('、')}`)
md.push('')
md.push('这份名单是作者长期实际使用后收敛下来的结果，每席只做一件事，且互相不重叠。')
md.push('把它当作**起点**而不是标准答案：圆桌的价值在于你按自己的题目重组阵容。')
md.push('')
md.push('## 怎么用')
md.push('')
md.push('在 DSH「设置 → 圆桌会议 → 角色预设」里逐条建立，或把 [`experts.yaml`](./experts.yaml) 的内容粘进**当前 profile** 的 `cordis.patch.yml`（`id: roundtable` 那条的 `config.rolePresets`）下，')
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
md.push('> 生成来源：当前实际命中的预设真源（见脚本运行时打印的「真源：」行）。复现方式：`node scripts/export-experts.mjs`。')
md.push('>')
md.push('> ⚠ `node scripts/export-experts.mjs --check` **只校验真源可解析且自洽**，**不与本文件比对** —— 要判本文件是否落后于真源，跑一次不带 `--check` 的版本再看 `git diff`。')
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
  // 措辞按事实写：只说"真源已解析并自洽"，不说"与产物一致"（见文件头 --check 说明）。
  /*
   * A6 ②：`--check` **不得**报裸 OK —— 回落到低优先级源时，把警告写进同一行。
   */
  console.log(
    `[export-experts] OK（真源已解析且自洽；**未**与仓库产物比对）：${presets.length} 席、${GROUPS.length} 组全覆盖、路由 ${[...routes].join('/')}`
    + (FALLBACK_NOTE === '' ? '' : ' ｜ ⚠ 已回落（更高优先级的候选没给出预设，原因见上方标注）'),
  )
  process.exit(0)
}

writeFileSync(resolve(REPO, 'EXPERTS.md'), mdText, 'utf8')
writeFileSync(resolve(REPO, 'experts.yaml'), yamlText, 'utf8')
console.log(`[export-experts] 写出 EXPERTS.md (${mdText.length} B) 与 experts.yaml (${yamlText.length} B)，来源 ${SETTINGS}`)
