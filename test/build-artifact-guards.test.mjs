/**
 * 构建产物完整性守卫（2026-09-23 · 实测事故后补）。
 *
 * ── 判因（本轮真实撞到）──────────────────────────────────────────────────────
 * `npx tsdown` 在**语法错误**时的行为是：先 `Cleaning N files`（删掉 lib/ 全部产物），
 * 再在打包阶段失败。于是仓里出现"**lib/ 被清空而构建失败**"的状态，而：
 *   · `npm test` 仍然全绿（337 pass）—— 因为测试直接读 `src/*.ts`，不读 `lib/`；
 *   · `tsc --noEmit` 报的是**预存**的宿主依赖漂移错误（与本事故无关），
 *     人很容易把"构建失败"归因到那批预存错误上，从而**忽略 lib/ 已被清空**。
 * ⇒ 宿主的 loader entry 指向 `lib/index.js`（junction），产物没了 = 插件加载不了，
 *   但**没有任何一条现有判据会发现**——测试绿、typecheck 的报错是"已知的"。
 *
 * 这正是本仓一直在剿的形态：**失败不可观测 / 绿得没有意义**。
 *
 * ── 本守卫查什么 ────────────────────────────────────────────────────────────
 * ① `lib/index.js` 与 `lib/client.js` 存在且非空（构建产物活着）；
 * ② 产物**比 src 新**（或至少不比 src 旧）——防"改了源码没重建"的漂移；
 * ③ 产物里含**本轮新增能力的标记**（防止产物是旧代：只重建了一半）。
 *
 * ⚠ 刻意不做的事：不在这里跑构建（守卫要快、无副作用）；不检查产物内容正确
 *   （那是夹具的活）。本件只回答一个问题：**"现在这份产物，是能加载的吗？"**
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const LIB = join(ROOT, 'lib')
const SRC = join(ROOT, 'src')

const newestMtime = (dir, filter) => {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(p, filter))
      continue
    }
    if (!filter(entry.name)) continue
    newest = Math.max(newest, statSync(p).mtimeMs)
  }
  return newest
}

test('构建产物存在且非空（防 tsdown 先清 lib/ 再失败 ⇒ 插件加载不了）', () => {
  for (const rel of ['index.js', 'client.js']) {
    const p = join(LIB, rel)
    assert.ok(existsSync(p), `lib/${rel} 不存在 —— 若刚跑过构建，说明 tsdown 在 Cleaning 之后失败了（它先删产物再报错）。请修语法错误后重新构建。`)
    assert.ok(statSync(p).size > 1024, `lib/${rel} 只有 ${statSync(p).size} 字节 —— 产物不完整`)
  }
})

test('构建产物不比 src 旧（防"改了源码没重建"的静默漂移）', () => {
  /*
   * ⚠ 过滤必须覆盖 `.tsx`（2026-09-23 独立复审实证的盲区）：
   * 早先只 `endsWith('.ts')`，于是改 `src/client/*.tsx`（本轮有 6 个）后不重建，
   * `lib/client.js` 与 `lib/types/client/**` 双双陈旧，而全部守卫仍然报绿。
   * 客户端源码同样进产物，判据不能漏它。
   */
  const srcNewest = newestMtime(SRC, (n) => n.endsWith('.ts') || n.endsWith('.tsx'))
  const libMain = statSync(join(LIB, 'index.js')).mtimeMs
  /*
   * ⚠ 容差 5 秒是**刻意的**，不是凑数：
   *   `git clone` / `git checkout` 是**逐个文件写盘**的，写 `lib/` 与写 `src/` 的先后
   *   顺序不由仓库内容决定 ⇒ 严格比较会在全新克隆上**随机假红**。
   *   而一条会随机假红的守卫比没有守卫更坏：它训练人忽略它。
   *   5 秒足以覆盖写盘抖动，又远小于"人改完源码忘了重建"的真实间隔（分钟级）。
   */
  const TOLERANCE_MS = 5000
  assert.ok(
    libMain + TOLERANCE_MS >= srcNewest,
    `lib/index.js（${new Date(libMain).toISOString()}）比 src/ 最新改动（${new Date(srcNewest).toISOString()}）旧 —— 产物是旧代，宿主加载的将不是当前源码。跑 \`npx tsdown -c tsdown.config.ts\` 重建。`,
  )
})

test('产物含本轮新增能力的标记（防产物只重建了一半）', () => {
  const bundle = readFileSync(join(LIB, 'index.js'), 'utf8')
  /*
   * 这三条标记对应 2026-09-23 新增的两条用户全流程要求：
   *   ① 澄清前置（usage rule 1）—— 边界不清先问用户；
   *   ② 防拆东墙（usage rule 17 + boundary + regression_risk 渲染）。
   * 若产物里没有它们，说明打包出来的不是当前源码（或功能被回退了）。
   */
  for (const [needle, why] of [
    ['clear enough to meet on', '澄清前置（rule 1：边界/目标不清先回问用户）'],
    ['NO ROBBING PETER TO PAY PAUL', '防拆东墙规则（rule 17）'],
    ['regression self-check', 'regression_risk 的可见面（status 渲染）'],
    ['本会议的边界声明', '边界声明进总纲（每个专家的 persona）'],
    ['怎么检查才算达标', '边界可判定性（吸收 P10「成功标准须可量化」的 check 字段）'],
    ['UNLIMITED (never mutes on rounds)', '预算 0 = 不限制（0.2.57）：工具参数描述里的取值语义'],
    ['0 = 不限制', '预算 0 = 不限制（0.2.57）：设置卡 / 设置页给用户看的口径'],
    ['∞', '预算 0 = 不限制（0.2.57）：不限制的轴渲染成 ∞ 而非 N/0'],
    /*
     * 0.2.58：专家席从「只审」到「动手」—— 本批四处的产物标记。
     * 缺任一条 ⇒ 打包出来的不是当前源码（该能力被回退，或产物是旧代）。
     */
    ['EXECUTION IS PART OF THE JOB', '执行协议 usage 条（rule 20：change 项必须真的改到工作区）'],
    ['执行协议', 'charter 条件式执行段（仅 boundary.notDoing 非空时注入）'],
    ['same-wave file overlap', 'P5 同波次文件重叠的可见面（status 渲染）'],
    ['requires an authenticated browser session', 'T3 插件自注册路由的鉴权闸'],
  ]) {
    assert.ok(bundle.includes(needle), `lib/index.js 缺少「${why}」的标记 "${needle}" —— 产物不是当前源码的构建结果`)
  }
})

/*
 * 2026-09-23（ACT-373 独立审查的缺陷 2）实测：
 *   `npx tsdown` 只重写 **运行时** 产物（lib/index.js / lib/client.js），它
 *   **不产出 `lib/types/**`**；声明来自 `tsc --emitDeclarationOnly`（`npm run build`
 *   里的后两步）。于是走"只 tsdown"的路径时，`lib/types` 会静默停留在**旧代**，
 *   而 package.json 的 types/exports/files 全部指向它 ⇒ 发布出去的类型面在说谎，
 *   且当时**没有任何一条判据看 `lib/types`**（本文件此前只覆盖 lib/*.js）。
 *   实测残留就是已随 0.1.7 删除的上游 API：`SettingsScope` / `fallbackPrefs` /
 *   `SETTINGS_NAMESPACE`。
 *
 * ⇒ 这两条把"声明面是旧代 / 声明面在说已被删除的 API"变成**可观测失败**。
 */
const TYPES = join(LIB, 'types')

test('类型声明存在且不比 src 旧（防 tsdown 只重建运行时、lib/types 静默停在旧代）', () => {
  assert.ok(existsSync(TYPES), 'lib/types 不存在 —— 跑 `npx tsc -p tsconfig.json --emitDeclarationOnly && npx tsc -p tsconfig.client.json --emitDeclarationOnly` 产出声明。')
  const srcNewest = newestMtime(SRC, (n) => n.endsWith('.ts') || n.endsWith('.tsx'))
  const typesNewest = newestMtime(TYPES, (n) => n.endsWith('.d.ts'))
  const TOLERANCE_MS = 5000
  assert.ok(typesNewest > 0, 'lib/types 里没有任何 .d.ts')
  assert.ok(
    typesNewest + TOLERANCE_MS >= srcNewest,
    `lib/types 最新声明（${new Date(typesNewest).toISOString()}）比 src/ 最新改动（${new Date(srcNewest).toISOString()}）旧 —— 类型面是旧代，宿主/消费者看到的不是当前契约。`,
  )
})

test('类型声明不含已从上游删除的 API（防声明面保留无法被消费的谎话）', () => {
  const declarations = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) { walk(p); continue }
      if (entry.name.endsWith('.d.ts')) declarations.push([p, readFileSync(p, 'utf8')])
    }
  }
  walk(TYPES)
  /*
   * 这三条是 0.1.7-rc.1 对 dsh-settings 的破坏性变更里**被删除**的面：
   *   · `SettingsForms.register` 及 `SettingsScope` 类型 —— 换成了 volatile Config + update(entryId)。
   * 它们若仍出现在声明里，说明 `lib/types` 是迁移前的旧代（消费者 import 它必然编译失败）。
   */
  for (const [needle, why] of [
    ['SettingsScope', '0.1.7 已从 dsh-settings 删除的类型（迁移前残留）'],
    ['fallbackPrefs', '0.1.7 迁移前的偏好字段（已换成 prefs/setPrefs）'],
    ['SETTINGS_NAMESPACE', '0.1.7 已废弃的自建 settings namespace'],
  ]) {
    const hits = declarations.filter(([, text]) => text.includes(needle)).map(([p]) => p.replace(ROOT, ''))
    assert.equal(hits.length, 0, `lib/types 里仍有「${why}」"${needle}"：${hits.join(', ')} —— 类型面是旧代，需重新产出声明。`)
  }
})
