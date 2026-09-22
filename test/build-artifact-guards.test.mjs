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
  const srcNewest = newestMtime(SRC, (n) => n.endsWith('.ts'))
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
  ]) {
    assert.ok(bundle.includes(needle), `lib/index.js 缺少「${why}」的标记 "${needle}" —— 产物不是当前源码的构建结果`)
  }
})
