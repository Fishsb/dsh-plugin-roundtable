/**
 * 构建产物完整性守卫（2026-09-23 立 · 2026-09-26「T2」换判据）
 *
 * ── 判因（第一轮，2026-09-23 实测事故）──────────────────────────────────
 * `npx tsdown` 在**语法错误**时的行为是：先 `Cleaning N files`（删掉 lib/ 全部产物），
 * 再在打包阶段失败。于是仓里出现"**lib/ 被清空而构建失败**"的状态，而：
 *   · `npm test` 仍然全绿 —— 因为测试直接读 `src/*.ts`，不读 `lib/`；
 *   · `tsc --noEmit` 报的是**预存**的宿主依赖漂移错误（与本事故无关）。
 * ⇒ 宿主的 loader entry 指向 `lib/index.js`（junction），产物没了 = 插件加载不了，
 *   但**没有任何一条现有判据会发现**。
 *
 * ── 第二轮换判据的判因（T2，2026-09-26 实测）───────────────────────────
 * 旧判据是"新鲜度"：`lib` 比 `src` 新即绿。**它的病是"与构建成败无关"，不是"恒真"**
 * （⚠ 用词订正，2026-09-26 F-5）：旧判据**会**变红 —— 实测本轮开工时它就因 `src/aggregator.ts`
 * 被编辑过而红了两条。准确的说法是：**它给出的红/绿与"那次构建成不成功"无关**，三例：
 *  ① `tsc` 默认 **emit-on-error**（两份 tsconfig 均未设 `noEmitOnError`）⇒ 失败的那次
 *     调用**照样重写每个 `.d.ts`** ⇒ mtime 被推到"刚刚"。实测：失败调用后
 *     `lib/types/client/RoundTableView.d.ts` 的 mtime 前进了 4.5 秒。
 *     ⇒ 这一例的失效形态是"**失败也绿**"（与"恒真"不同：编辑 src 后它照样会红）。
 *  ② 只 `touch`（**内容一个字节没变**）即可把陈旧的 lib 刷成"比 src 新" ⇒ 假绿。
 *  ③ 扫描面命中 0 个文件时 `newestMtime` 回 `0` ⇒ 断言**空真**（空真绿）。
 * ⇒ **mtime 不承载"构建是否成功 / 产物是不是这份源码"的语义**；加细比（更细的时间戳、
 *   或把时间戳换成内容 SHA）也救不了 —— 病根是指标的**语义**，不是它的**精度**。
 *
 * ── 本守卫现在查什么 ──────────────────────────────────────────────────
 * ① `lib/index.js` 与 `lib/client.js` 存在且非空；
 * ② 产物**引用的 chunk 全都存在且非空**（防"入口在、chunk 缺/空"的加载期崩溃；
 *   连**裸副作用 import** `import "./x.js"` 的形态也在判据内 —— 见下方 F-1 注释）；
 * ③ **产物内嵌的源码 == 工作区源码**（时钟无关的同一性判据，取代旧的新鲜度判据）；
 * ④ 产物里含**本轮新增能力的标记**（防产物是旧代：只重建了一半）；
 * ⑤ `lib/types` 是当前源码的**镜像**（每个 src 文件都有 `.d.ts` 且含其导出名）；
 * ⑥ 声明面不含已从上游删除的 API。
 *
 * ⚠ ③ 的载体：`tsdown` 的 `sourcemap` 把每个 src 文件的**当次构建字节**内嵌进
 *   `sourcesContent`（实测覆盖 `src` 下全部 35 个 `.ts`/`.tsx`）。于是"这份 lib 出自哪份
 *   源码"变成一句**可判定**的话，不再依赖任何时钟。
 *
 * ⚠ 刻意不做的事：不在这里跑构建（守卫要快、无副作用）；**不解析 `tsc` 退出码**。
 *   后者是刻意的：本机 `tsc` 的 25 条错误（host 24 = index.ts 18 + members.ts 6 / client 1）
 *   **全部**是 peer 树的上游漂移（junction 指向全局 dsh 0.1.5-rc.2，宿主已是 prefix 0.1.7-rc.1）
 *   —— 实测把类型映射到 0.1.7-rc.1 树后**双端 exit 0**。若在此处判"退出码非零即红"，
 *   本机将**常驻假红**，而本文件自己的纪律写着"一条会随机假红的守卫比没有守卫更坏"。
 *   ⇒ 本守卫判的是**结果**（产物内容是否等于当前源码），不是**进程**（那次命令的退出码）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const LIB = join(ROOT, 'lib')
const SRC = join(ROOT, 'src')
const TYPES = join(LIB, 'types')

/**
 * 递归列出 `dir` 下满足 `filter` 的文件**绝对路径**。
 *
 * ⚠ N3 修（2026-09-26）：**跳过点号前缀的名字**。旧版只挡 `node_modules` / `.git`，
 *   于是任何**临时/探针文件**（实测：另一席的 `src/.f2-untracked-probe-18732.ts`）
 *   都会进扫描面 ⇒ 被当成"应该出现在产物里的构建源" ⇒ 守卫**随机假红**。
 *   点号前缀是"非构建输入"的通用约定（`.gitignore` 的 `*.bak-*` 同理），挡掉它
 *   既消除了这处假红，又不会漏掉任何真实源码（`src` 下无点号前缀的真实源文件，实测）。
 */
const walkFiles = (dir, filter) => {
  const out = []
  const step = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.name === 'node_modules') continue
      const p = join(d, entry.name)
      if (entry.isDirectory()) { step(p); continue }
      if (filter(entry.name)) out.push(p)
    }
  }
  step(dir)
  return out
}

/** 参与构建的源码 = `src` 下的 `.ts`/`.tsx`，**排除** `.d.ts`（声明补丁不产 JS）。 */
const isBuildSource = (n) => (n.endsWith('.ts') || n.endsWith('.tsx')) && !n.endsWith('.d.ts')

const SRC_FILES = walkFiles(SRC, isBuildSource)

/** 只把 `\r\n` 折成 `\n`，用于把"行尾差异"从"真差异"里分开报。 */
const stripCrlf = (s) => s.replace(/\r\n/g, '\n')

/** `identical` / `eol-only` / `differs` —— 判据只认 `identical`。 */
const relation = (disk, embedded) => {
  if (disk === embedded) return 'identical'
  if (stripCrlf(disk) === stripCrlf(embedded)) return 'eol-only'
  return 'differs'
}

test('构建产物存在且非空（防 tsdown 先清 lib/ 再失败 ⇒ 插件加载不了）', () => {
  for (const rel of ['index.js', 'client.js']) {
    const p = join(LIB, rel)
    assert.ok(existsSync(p), `lib/${rel} 不存在 —— 若刚跑过构建，说明 tsdown 在 Cleaning 之后失败了（它先删产物再报错）。请修语法错误后重新构建。`)
    assert.ok(statSync(p).size > 1024, `lib/${rel} 只有 ${statSync(p).size} 字节 —— 产物不完整`)
  }
})

test('产物引用的 chunk 全都在且非空（防「入口在、chunk 缺/空」的加载期崩溃）', () => {
  /*
   * ⚠ F-1 修（2026-09-26，本轮**本席自己**引入的两处假绿，独立审查席实测复现）：
   *  ① 旧扫描面只跑 `['index.js','client.js']` 两个条目，且正则
   *     `/(?:from\s*|import\s*\(\s*)["'](\.\/[^"']+\.js)["']/g` **只认**
   *     `from "./x.js"` 与 `import("./x.js")` 两种形态，**漏掉裸副作用** `import "./x.js"`。
   *     实测：往 `lib/index.js` 加一行 `import "./obs-missing-C.js"`（该 chunk 不存在）
   *     ⇒ 守卫 **pass 6 / fail 0**。
   *  ② 非空断言只盖那两个入口 ⇒ 把被引用的 `lib/state-DIInFaLH.js` 截成 **0 字节**
   *     ⇒ 守卫 **pass 6 / fail 0**。
   * 修法：扫描面**改为 `lib` 下全部 `*.js`**（chunk 也会 import 别的 chunk：实测
   *   `edge-helper-*.js` 引用 2 个、`state-D86ZFRZA.js` 引用 1 个、`workspace-candidates-B7isleLt.js`
   *   引用 1 个，旧扫描面**完全看不到**），且每个被引用者同时断言**存在**与**非空**。
   */
  /*
   * ⚠ N2 修（2026-09-26）：扫描面原为 `readdirSync(LIB)` —— **只列根目录一层**，
   *   `lib` 下任何**子目录**里的 `.js` 都被漏掉。改为递归遍历 `lib` 下全部 `.js`。
   *   （实测当前产物全在 `lib/` 根、`lib/types/**` 里 0 个 `.js`，故这条**当前无实例**；
   *   但 `tsdown` 换 chunk 命名/子目录输出后就会静默变窄 —— 属"未来会咬人"的同源窗口。）
   */
  const entries = walkFiles(LIB, (n) => n.endsWith('.js') && !n.endsWith('.map')).sort()
  assert.ok(entries.length > 0, 'lib/ 下没有任何 .js 产物')
  /*
   * ⚠ N1 修（2026-09-26）：上一版正则 `[^"'\n]{0,200}?` 有**两个**窗口约束，
   *   而本轮实测证明**绑定约束是 `{0,200}` 上限**（不是「排除 \n」）：
   *     `lib/index.js`        关键字→路径间隔 **498** 字符（整行 520，**单行无换行**）
   *     `lib/state-D86ZFRZA.js` 间隔 **520** 字符（整行 542，**单行无换行**）
   *   逐项对照（同一组真实产物）：
   *     变体                        index.js  state-D86ZFRZA.js
   *     现行 `[^"'\n]{0,200}?`            4            0      ← 漏
   *     只去上限 `[^"'\n]*?`              5            1      ← 够
   *     只去 \n  `[^"']{0,200}?`          4            0      ← 仍漏（证明罪在 200）
   *   ⇒ 上一轮的 5 个自证样本**全是短单行**（长 15–26 字符），所以自证**测不出**这个窗口。
   *
   *   现在采用 `[^"';]*?`：**同时**去掉 \n 排除与 200 上限（修掉长/跨行），
   *   并**显式排除 `;`** —— 它比 "完全不加约束" 更严：`import foo\n;\nconst s = "./x.js"`
   *   这种**跨语句**形态下 `[^"']*?` 会误抓，`[^"';]*?` 不会（见下方负样本）。
   *   真实产物上两者命中集**完全相同**（逐文件对照 7 个产物，计数一致）。
   */
  const re = /(?:^|[^\w$.])(?:import|export|require)\b[^"';]*?["'](\.\/[^"']+\.js)["']/g
  /*
   * 解析自证（防「解析器自己悄悄失效」——本仓已有过两次同类事故：锚点字符串被注释冒充、
   * 断言被挂载路径那次冒充）。
   *
   * ⚠ 样本组必须**覆盖窗口的两个维度**（2026-09-26 N1 的教训）：上一轮的 5 个正样本
   *   **全是短单行**（15–26 字符），而真实产物里咬人的是 **498/520 字符的单行**
   *   ⇒ 自证全绿而判据已瞎。故现在正样本按 **宽度 × 长度** 两维枚举：
   *     宽度：`from` / `export … from` / 动态 `import()` / 裸 `import` / `require`
   *     长度：短单行(≤30) / 跨行 / 单行 > 1000 字符
   */
  const parseHits = (s) => { re.lastIndex = 0; const out = []; let m; while ((m = re.exec(s)) !== null) out.push(m[1]); return out };
  const LONG = 'import { ' + Array.from({ length: 120 }, (_, i) => `a${i} as `).join(', ') + ' } from "./x.js"';
  const CROSS = 'import {\n  a,\n  b,\n} from "./x.js"';
  const positives = [
    ['from 短单行', 'import { a } from "./x.js"'],
    ['export-from 短单行', 'export { a } from "./x.js"'],
    ['动态 import() 短单行', 'import("./x.js")'],
    ['裸 import 短单行', 'import "./x.js"'],
    ['require 短单行', 'require("./x.js")'],
    ['from 跨行', CROSS],
    ['from 单行 >1000 字符（N1 的真实形态）', LONG],
    ['裸 import 跨行', 'import\n  "./x.js"'],
  ];
  for (const [name, sample] of positives) {
    assert.deepEqual(parseHits(sample), ['./x.js'], `解析器漏了形态「${name}」（长 ${sample.length}）：${sample.slice(0, 80)}… —— 扫描窗口又变窄了（N1 的原始形态）。`)
  }
  assert.ok(LONG.length > 1000, `长样本只有 ${LONG.length} 字符 —— 它不足以覆盖 N1 的窗口（真实产物实测 498/520 字符）`)
  const negatives = [
    ['普通字符串', 'const s = "./x.js"'],
    ['跨语句（import 后接分号再出现字符串）', 'import foo\n;\nconst s = "./x.js"'],
  ];
  for (const [name, sample] of negatives) {
    assert.deepEqual(parseHits(sample), [], `解析器把「${name}」也当成 chunk 引用（会误红）：${sample}`)
  }
  /*
   * ⚠ P1 修（2026-09-26 · \u300c半截同源\u300d）：收集面已改递归（N2），但**解析基准**仍写死 `LIB` ⇒
   *   收集到了子目录里的产物，却拿**根目录**去解析它的相对引用。两种后果（arch 沙箱实测）：
   *     · 子目录 chunk 引**同目录真实存在**的 `./b.js` ⇒ 被报「引用了不存在的 chunk」= **假红**；
   *     · 子目录 map 按规范写 `../../src/...` ⇒ 被报「源文件已不在工作区」。
   *   修法：基准换成**引用方自己所在的目录**（`dirname`）。
   *   ⇒ 相对引用的语义本来就是"相对引用它的那个文件"，与产物放在哪一层无关。
   */
  const refs = []
  for (const abs of entries) {
    const text = readFileSync(abs, 'utf8')
    let m
    while ((m = re.exec(text)) !== null) refs.push({ from: abs, spec: m[1] })
  }
  assert.ok(refs.length > 0, '没解析到任何 chunk 引用 —— 解析器与产物形态脱节了（0 命中时下面的断言会空转通过）。若 tsdown 改为不拆包，请同步更新本行。')
  const target = (r) => resolve(dirname(r.from), r.spec)
  const label = (r) => `${relative(LIB, r.from).split(sep).join('/')} -> ${r.spec}`
  const absent = refs.filter((r) => !existsSync(target(r))).map(label).sort()
  assert.deepEqual(absent, [], `产物引用了不存在的 chunk：${absent.join(', ')} —— 入口能加载、import 到它就崩。`)
  const empty = refs.filter((r) => existsSync(target(r)) && statSync(target(r)).size === 0).map(label).sort()
  assert.deepEqual(empty, [], `产物引用的这些 chunk 是 0 字节：${empty.join(', ')} —— 入口在、chunk 空，加载到它就崩，而旧判据只查两个入口的大小。`)
})

test('产物内嵌的源码逐字节等于工作区源码（时钟无关的同一性判据）', () => {
  /*
   * ⚠ H2 修（2026-09-26）：集合的收集面原为 `readdirSync(LIB)` —— **只列根目录一层**，
   *   与同文件里 `entries`（已改递归，见上方 N2 修）**不一致**。
   *   ⇒ 同源两个收集面必须用同一把尺，否则"防漏"只防了一半。
   *
   * ⚠ **如实标注：当前无子目录 `.js.map` 实例**（实测 `lib` 递归找 `.js.map` = 5 个，
   *   全部在 `lib/` 根；`lib/types/**` 下 0 个）⇒ 这条是**预防性一致**，
   *   **不得记作现存缺陷**。它防的是"未来 tsdown 把 chunk 或 map 输出到子目录后静默变窄"，
   *   与 N2 是同一个窗口、同一个修法。
   */
  const maps = walkFiles(LIB, (n) => n.endsWith('.js.map')).sort()
  const mapLabel = (p) => relative(LIB, p).split(sep).join('/')
  assert.ok(maps.length > 0, 'lib/ 下没有任何 .js.map —— 产物未携带可判定的源码副本（tsdown 的 sourcemap 被关掉了？）')
  const covered = new Set()
  const wrong = []
  const missingSource = []
  for (const m of maps) {
    let parsed
    try { parsed = JSON.parse(readFileSync(m, 'utf8')) } catch (error) { assert.fail(`lib/${mapLabel(m)} 不是合法 JSON：${error.message}`) }
    const sources = parsed.sources ?? []
    const contents = parsed.sourcesContent ?? []
    assert.equal(contents.length, sources.length, `lib/${mapLabel(m)} 的 sources 与 sourcesContent 长度不一致 —— 产物没内嵌源码，本判据的载体不在。`)
    for (let i = 0; i < sources.length; i += 1) {
      /*
       * ⚠ P1 修（2026-09-26 · 半截同源）：`sources[i]` 按 sourcemap 规范是**相对 map 自己**的
       *   路径，故基准必须是 `dirname(m)` 而不是 `LIB`。当前 5 份 map 全在 `lib/` 根
       *   （`dirname` 与 `LIB` 等价），故**仓内行为不变**；改的是子目录实例的语义。
       */
      const abs = resolve(dirname(m), sources[i])
      if (!existsSync(abs)) { missingSource.push(`${mapLabel(m)} -> ${sources[i]}`); continue }
      covered.add(abs)
      const rel = relative(ROOT, abs).split(sep).join('/')
      const grade = relation(readFileSync(abs, 'utf8'), contents[i])
      if (grade !== 'identical') wrong.push(`${rel}(${grade})`)
    }
  }
  assert.deepEqual(missingSource, [], `以下源文件已不在工作区，产物却仍嵌着它：${missingSource.join('; ')} —— 产物是旧代。`)
  assert.deepEqual(wrong.sort(), [], `产物内嵌的源码与工作区不一致：${wrong.join(', ')} —— 产物不是当前源码构建出来的（改了源码没重建，或被换成了旧代？）。跑 node node_modules/tsdown/dist/run.mjs -c tsdown.config.ts 重建。`)
  const uncovered = SRC_FILES.map((p) => relative(ROOT, p).split(sep).join('/')).filter((rel) => !covered.has(join(ROOT, rel))).sort()
  assert.deepEqual(uncovered, [], `这些源文件没有出现在任何产物 map 的 sourcesContent 里：${uncovered.join(', ')} —— 要么产物漏了它，要么本判据的覆盖断言需要更新。`)
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
 *   里的后两步）。于是走"只 tsdown"的路径时，`lib/types` 会静默停留在**旧代**。
 *
 * ⚠ 2026-09-26（T2）换判据：旧版比"`lib/types` 最新 mtime 是否比 `src` 新"——**恒真**
 *   （tsc 失败也重写声明，见文件头判因①）。现改为**镜像**判据：每个 src 文件都必须有
 *   对应的 `.d.ts`，且该文件里必须出现源文件的**全部导出名**。声明若停在旧代，导出名
 *   集合就会对不上（新增的导出名必然缺失），与本机是否存在 peer 漂移无关。
 */
test('类型声明是当前源码的镜像（每个 src 文件都有 .d.ts，且含其全部导出名）', () => {
  assert.ok(existsSync(TYPES), 'lib/types 不存在 —— 跑 `npx tsc -p tsconfig.json --emitDeclarationOnly && npx tsc -p tsconfig.client.json --emitDeclarationOnly` 产出声明。')
  const missingDts = []
  const missingNames = []
  for (const abs of SRC_FILES) {
    const rel = relative(SRC, abs).split(sep).join('/')
    const dts = join(TYPES, rel.replace(/\.tsx?$/, '.d.ts'))
    if (!existsSync(dts)) { missingDts.push(rel); continue }
    const text = readFileSync(dts, 'utf8')
    const names = [...readFileSync(abs, 'utf8').matchAll(/^export\s+(?:declare\s+)?(?:const|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
    for (const n of new Set(names)) {
      if (n.length < 4) continue
      if (!new RegExp('\\b' + n + '\\b').test(text)) missingNames.push(`${rel}:${n}`)
    }
  }
  assert.deepEqual(missingDts, [], `这些源文件没有对应的类型声明：${missingDts.join(', ')} —— 声明面漏了它，消费者 import 会失败。`)
  assert.deepEqual(missingNames.sort(), [], `类型声明里找不到这些导出名：${missingNames.join(', ')} —— 声明是旧代（或该文件的声明产出没跑成功）。`)
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
