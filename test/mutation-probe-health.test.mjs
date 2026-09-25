/**
 * 变异探针**自身**的健康门（2026-09-23 立）。
 *
 * ## 为什么需要这个文件（实测病灶）
 *
 * `test/mutate.mjs` 是"断言写了 ≠ 断言有效"的反验收工具，但它**从不由 `npm test` 执行**——
 * `npm test` 只跑 `test/*.test.mjs`。后果有两个，都在 2026-09-23 实测到：
 *
 *   1. **锚点失配长期无人察觉**：本机 `core.autocrlf=true` 且仓内无 `.gitattributes`
 *      ⇒ 工作区 `src/rpc.ts` 是 CRLF，而多行锚点字面量的 `\n` 是 LF
 *      ⇒ `original.includes(from)` 恒 false ⇒ 探针在「锚点没找到」处 `exit 3` 退出，
 *      **从来没在测任何东西**。实测 **2 / 14 / 19 / 20 四条已死**（全在 rpc.ts）。
 *   2. **失效不可观测**：那四条死掉时，全仓 352 条测试**全绿**，没有任何信号。
 *
 * 这正是用户反复点名的「让失败不可观测」类缺陷：工具在，但它不说话。
 *
 * ## 本门做什么
 *
 * 逐条**静态**核对每条变异：① 锚点结构完整（有 file/from/to/expect）
 * ② `from` 在当前工作区文件里**真的找得到**（按实际行尾归一后匹配）。
 * 不跑 `npm test`（那要几分钟且与 test/*.test.mjs 重复），只做"锚点还活着吗"。
 *
 * ## 行尾纪律（本文件的首要坑）
 *
 * 本机 `core.autocrlf=true` 且仓内无 `.gitattributes` ⇒ git 检出时把**部分**文件写成 CRLF。
 * 实测分布（2026-09-23 全仓清点，148 个受控文件）：工作区 **13 个 CRLF / 111 个 LF**
 * （CRLF 集中在 `src/*.ts`、`package.json` 等被 autocrlf 判定为 text 的文件；
 * git **索引里存的却一律是 LF**）—— 即"哪些文件是 CRLF"是**不确定**的。
 * 锚点字面量里的换行是 LF，故**凡跨这两个世界比较，必须先归一到同一侧** ——
 * 本文件一律归一为 LF 再比。
 *
 * > ⚠ 本文件首版把这条写成了「本仓所有源文件都是 CRLF」——**实测证伪**（13/111）。
 * > 记录于此：连"行尾现状"这种看似显然的事实也必须实测，不能凭印象写进注释。
 *
 * 另一个首版真踩到的坑：解析 `mutate.mjs` 时用了 LF-only 正则 ⇒ 解析到 0 条
 * ⇒ 后两条断言在**空列表**上"通过"（**又一个假绿**）。
 * 故 test 1 的非空断言是其余各条的前提，且下面每一条都自带非空检查。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

/** 读文件并统一成 LF —— 见文件头「行尾纪律」。 */
const readLf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/**
 * 从 mutate.mjs 源码里抠出 (id, file, from, to, expect) 五元组。
 *
 * 为什么不用正则一把抓：`from`/`to` 是**含转义换行的字符串字面量**（`\n`、`\'`），
 * 贪心/非贪心都会切错。故用块扫描 + `eval` 还原字面量（仓库自有测试文件，内容可信）。
 * 输入已在 {@link readLf} 归一为 LF，故这里的 `\n` 锚点成立。
 */
function parseMutations(srcLf) {
  const starts = [...srcLf.matchAll(/\n  (\d+): \{\n/g)].map((m) => ({ id: Number(m[1]), at: m.index + 1 }))
  starts.push({ id: null, at: srcLf.length })
  // eslint-disable-next-line no-eval -- 还原本仓测试文件里的字符串字面量
  const lit = (s) => eval(s)
  const out = []
  for (let i = 0; i < starts.length - 1; i++) {
    const block = srcLf.slice(starts[i].at, starts[i + 1].at)
    const fields = {}
    /**
     * **逐行**取值，而不是拿 `from: … to: … expect:` 三段式正则。
     *
     * 为什么（首版两连坑，都是本门自己踩的假绿/误判）：
     *   ① 三段式正则在"字段值后夹了一行解释性注释"时抓不到（变异 19 的 `to:` 与
     *      `expect:` 之间就有注释）⇒ 误判「缺 to」；
     *   ② 放宽成"从 from: 抓到 expect:"又把 `to:` 那行也吞进去 ⇒ eval 出语法错。
     * 本仓的 `from`/`to` 字面量一律**写在单行**（换行用 `\n` 转义），故按行取即可，
     * 且天然不受夹在中间的注释行影响。
     */
    for (const line of block.split('\n')) {
      const m = line.match(/^    (file|from|to|expect): (.*)$/)
      if (m === null) continue
      // 去掉行尾那一个逗号（JS 对象字面量的分隔符），其余原样保留
      fields[m[1]] = m[2].replace(/,$/, '')
    }
    out.push({
      id: starts[i].id,
      file: fields.file === undefined ? undefined : lit(fields.file),
      from: fields.from === undefined ? undefined : lit(fields.from),
      to: fields.to === undefined ? undefined : lit(fields.to),
      expect: fields.expect === undefined ? undefined : lit(fields.expect),
    })
  }
  return out
}

const mutations = parseMutations(readLf('./mutate.mjs'))

test('变异探针表可解析（解析失败会让本门变成空转的假绿 —— 首版实测踩过）', () => {
  // 这条**必须是其余各条的前提**：解析到 0 条时，下面「没有死锚点」这类断言
  // 会在空集合上恒真。首版本文件就是这样自己假绿的。
  assert.ok(
    mutations.length >= 25,
    `只解析到 ${mutations.length} 条变异 —— 解析器与 mutate.mjs 结构脱节了（0 条时下面的断言会空转通过）`,
  )
})

test('锚点未失配：每条变异的 from 都能在当前工作区文件里找到（活锚点）', () => {
  assert.ok(mutations.length >= 25, '前提：解析必须非空') // 防空转，不依赖 test 1 的执行顺序
  const dead = []
  for (const m of mutations) {
    assert.ok(m.file !== undefined, `变异 ${m.id} 缺 file`)
    assert.ok(typeof m.from === 'string' && m.from !== '', `变异 ${m.id} 缺 from`)
    assert.ok(typeof m.to === 'string', `变异 ${m.id} 缺 to`)
    assert.ok(typeof m.expect === 'string' && m.expect !== '', `变异 ${m.id} 缺 expect`)
    const disk = readLf(`../${m.file}`)
    if (!disk.includes(m.from)) dead.push(`${m.id} (${m.file})`)
  }
  assert.deepEqual(
    dead,
    [],
    `以下变异的锚点在工作区文件里找不到 ⇒ 该探针静默失效、从来没在测东西：${dead.join('、')}。`
    + '修法：把锚点更新到当前实现。',
  )
})

test('变异编号连续且唯一（编号重复会让 mutate.mjs 静默覆盖前一条）', () => {
  assert.ok(mutations.length >= 25, '前提：解析必须非空') // 防空转
  const ids = mutations.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length, `编号有重复：${ids.join(',')}`)
  const sorted = [...ids].sort((a, b) => a - b)
  for (let i = 0; i < sorted.length; i++) {
    assert.equal(sorted[i], i + 1, `编号不连续（缺 ${i + 1}）—— mutate.mjs 的编号是命令行入口，缺号即无法触达`)
  }
})

test('反例自证：解析器对 CRLF 源的解析必须与 LF 一致（本文件的首要坑）', () => {
  // 直接对「未归一」的原文跑解析器：应当**解析不出来**。这证明归一不是摆设，
  // 且把"忘记归一"这个错误形态钉成一个可断言的已知事实。
  const raw = readFileSync(new URL('./mutate.mjs', import.meta.url), 'utf8')
  if (!raw.includes('\r\n')) {
    // 在 LF 检出的环境（Linux/CI）上这条不适用：归一与不归一等价。
    return
  }
  assert.equal(parseMutations(raw).length, 0, '未归一的 CRLF 文本不应被解析出来（否则归一那步是多余的）')
  assert.ok(parseMutations(readLf('./mutate.mjs')).length >= 25, '归一后必须能解析出来')
})

test('行尾契约：.gitattributes 存在且把源文件固定为 LF（防本类缺陷再回来）', () => {
  // 这一条把 v0.2.55 的根因修法**变成常驻判据**，而不是只写在 release note 里。
  //
  // 为什么必须守：只要 `.gitattributes` 缺失（或被误删、被 `* text=auto` 之外的规则
  // 覆盖），git 就会在 Windows 上按 `core.autocrlf` 自由决定工作区行尾 ——
  // 于是"锚点是否失配"又变成**环境相关**的偶然，变异探针可能再次静默失效。
  // 本文件自己首版就栽过一次（见文件头「行尾纪律」）。
  const attrs = readLf('./../.gitattributes')

  assert.ok(attrs.trim() !== '', '.gitattributes 缺失或为空 —— 行尾契约不成立')
  // 必须存在一条把**所有**源文件固定为 LF 的规则（`*` 兜底 或 逐类型声明）
  assert.match(
    attrs,
    /^\*\s+text=auto\s+eol=lf\s*$/m,
    '缺少 `* text=auto eol=lf` 兜底规则 —— 未列出的新文件类型会退回不确定状态',
  )
  // 本仓的核心源文件类型必须显式声明（可被 grep 到，且不受未来 `*` 调整影响）
  for (const pattern of ['*.ts', '*.tsx', '*.mjs', '*.json', '*.md']) {
    assert.match(
      attrs,
      new RegExp(`^\\${pattern}\\s+text\\s+eol=lf\\s*$`, 'm'),
      `缺少显式规则：${pattern} text eol=lf`,
    )
  }
  // 二进制件必须被排除在行尾转换之外（否则 git 会改写字节、产物损坏）
  assert.match(attrs, /^\*\.png\s+binary\s*$/m, 'PNG 未被标为 binary（会被行尾转换损坏）')
  // 行尾敏感件：.ps1 在本仓为 LF，须显式固定（若将来加 .bat/.cmd 需单独声明 crlf）
  assert.match(attrs, /^\*\.ps1\s+text\s+eol=lf\s*$/m, '.ps1 未声明为 LF（本仓现状，须固定）')
  // ⚠ 反例防护：不得用 `* text=auto`（无 eol）兜底 —— 那等于没固定行尾
  assert.doesNotMatch(
    attrs,
    /^\*\s+text=auto\s*$/m,
    '`* text=auto`（无 eol）不给出行尾承诺 —— 等于没修',
  )
})

/* ── ⑤ 无残留门：变异目标文件必须与 HEAD 一致（2026-09-25 留毒事故倒逼） ──────────
 *
 * 判因（真实事故）：`src/tools.ts:1443` 曾被留成 `if (captainLive !== undefined && false) {`，
 * 基线树带毒、`npm test` 5 条失败，主持人半小时后才发现。而本文件当时**一条都不红** ——
 * 因为上面 4 条全是**静态锚点检查**，没有任何一条问过"工作区是否已回到基线"。
 * 实测（2026-09-25，本门改造前）：把 `src/tools.ts` 的
 * `if (captainLive !== undefined) {` 改成 `&& true`（等价但不同字节）后，
 * 本门 **`ℹ pass 5 / ℹ fail 0`** ⇒ 缺口真实存在。
 *
 * ## 判定口径：与 HEAD 比（选择理由）
 *
 * ⚠ 三种口径都被实测否掉两种，剩下 HEAD：
 *   ① **"与开工快照比"**（自己存一份 {path→sha} 到临时文件）——**会误红，已实测否掉**：
 *      本仓正常工作流就是"边改边跑"，本轮施工期间 `git status` 本来就有
 *      `test/mutate.mjs` 等未提交改动；若把"开工时那一份"当基线，任何一个**正当的**
 *      源码改动都会让本门变红。且快照文件本身是 git 之外的状态，会漂（陈旧、被清理）。
 *   ② **"与当前工作区比"** —— 同义反复，恒真，等于没有门。
 *   ③ **与 HEAD 比（采用）** —— 语义是"**相对最后一次提交，工作区有没有改动**"，
 *      而这恰好是"有没有残留"的**可判定**形态：`git diff --quiet HEAD -- <file>`
 *      就是 git 自己对"脏"的定义，不引入任何 git 之外的状态。
 *      ⇒ **口径边界（必须写清，免得被当成"无未提交改动"的保证）**：本门盖的是
 *        「**变异目标文件**相对 HEAD 是否干净」。本轮施工中这些文件若有**正当的
 *        未提交改动**，本门会红 —— 那是**有意的**：要么先提交该改动，要么把它排除在
 *        验证窗口之外。本门**不**声称"全仓无未提交改动"（那会与正常施工冲突，见①）。
 *
 * ## ⚠ 三条边界（被拦者必读 —— 免得把「我改了 src」误判成「门坏了」）
 *
 *  ① **与正当的未提交 src 改动天然冲突**：若你确实改了 `src/` 且**未提交**，本门会红；
 *     而全量 `node --test test/*.test.mjs` 会一次出现 **4 条红**，全部由同一个原因引起 ——
 *       · `build-artifact-guards`「产物不比 src 旧」（src mtime 一改即红）；
 *       · `build-artifact-guards`「类型声明不比 src 旧」（同上）；
 *       · 本门「无残留」；
 *       · 本门的转红自证（它末尾也会跑一次不带注入的 `residueTargets()`）。
 *     ⇒ **这不是门坏了，是"树未回到基线"的如实报告。**
 *     ⚠ 实测状态（诚实标注）：主持人实测读数为 `417/413/4`；我**只复核了这 4 条的触发点**
 *     （逐条位置见上），**未自行复现**（复现要把 src 改脏 = 破坏性验证，须申请单席专窗）。
 *     ⇒ 正确做法二选一：(a) 先提交（`git commit` 该 src 改动）；(b) **只跑本门**：
 *       `node --test --test-name-pattern="无残留" "test/mutation-probe-health.test.mjs"`
 *       —— ⚠ **不要**写成 `npm test --test-name-pattern=…`：package.json 的 test 脚本是
 *       `node --test "test/*.test.mjs" && node scripts/export-experts.mjs --selftest`，
 *       该参数既不在 node 调用点、又不属于后一条命令。
 *
 *  ② **覆盖范围有限（别当成"全仓无残留"的保证）**：本门只覆盖 `mutate.mjs` 表里
 *     `file:` 声明过的**变异目标文件**（实测 **15** 个：src/ 根下 10 个 .ts + src/client/ 下 5 个 .tsx）。
 *     **非目标文件**的残留（`test/*.mjs`、`docs/`、`.audit/`、`package.json` 等）不归它管 ——
 *     已实测：只在非目标文件里留毒时，本门照绿。
 *     理由见下面 `MUTATION_TARGETS` 的注释（范围刻意收窄，避免把正常施工的红算进来）。
 *
 *  ③ **判据口径 = 与 HEAD 比 + `行尾归一后`逐字节**：本机 `core.autocrlf=true`，
 *     4 个目标文件工作区是 CRLF 而 HEAD 里是 LF（实测 `src/rpc.ts` 1263 处 /
 *     `src/members.ts` 509 / `src/client/locales.ts` 12 / `src/client/RoundTableView.tsx` 1）。
 *     归一**只替换 `\r\n`**（`normalizeEol` 只做这一件事，保留 BOM 与其余全部字节），
 *     故真差异照抓 —— 转红自证是**双向**的：行尾差异不得误红 / 内容差异必须报红。
 *     **已知极窄盲区**：非法 UTF-8 序列经 `toString('utf8')` 解码会被折成 U+FFFD，
 *     两个**不同**的非法序列可能折成同一串 ⇒ 这种差异本门分辨不了。
 *     本仓源文件都是合法 UTF-8，故该盲区当前不构成实际缺口（写在此以免被当成"逐字节全等"）。
 *
 * ## 与 mutate.mjs 的两侧对照（§1.2：两侧都要）
 *
 * 只有"干净"一侧是**不完整**的判据：磁盘脏了要红，磁盘干净时若门自己是坏的（比如
 * 读了别的路径）也会绿。故本组同时断言：
 *   · 干净侧：全部变异目标文件相对 HEAD 逐字节一致 ⇒ 绿；
 *   · **脏侧（转红自证）**：逐个目标**种入一个已知的等价改动**（`text → text`，
 *     只多一个空格）后，本门必须报红**且点名那个文件**，然后立刻逐字节还原。
 *   ⇒ 两条一起才证明"门在裁"，而不是"门恰好绿"。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

/** 仓库根（本文件在 test/ 下）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 本组只看**变异目标文件**：即 `mutate.mjs` 表里出现的 `file:` 集合。
 *
 * 范围理由（避免"顺手扫全仓"把正常施工的红算进来）：这组文件正是**探针会去改**的那些，
 * 也正是"残留"唯一可能发生的地方；`.audit/`、`docs/` 等与探针无关的改动不该影响本门。
 *
 * ⚠ **覆盖边界（写在此处，供被拦者直接读到）**：范围收窄的代价是**非目标文件不受本门保护** ——
 *   在 `test/*.mjs`、`docs/`、`.audit/`、`package.json` 等处留毒时本门**照绿**（已实测）。
 *   本门只是"探针残留"的观测面，**不是**"全仓无未提交改动"的保证（见文件头「三条边界」②）。
 */
const MUTATION_TARGETS = [...new Set(mutations.map((m) => m.file))]
  .filter((file) => typeof file === 'string' && file !== '')
  .sort()

/**
 * `src/` 下全部 `.ts`/`.tsx`（相对仓库根、正斜杠、排序）——**派生**，不手写名单。
 *
 * 用途只有一个：让「覆盖边界」文案里的分母与未覆盖清单**跟着磁盘现状走**，
 * 而不是写死一个数字（写死的数字会在新增源文件后变成新的假话）。
 * 覆盖的分子仍是 `MUTATION_TARGETS`（判定主体不变，见下）。
 */
function srcSourceFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.tsx?$/.test(entry.name)) continue
      out.push(full.slice(REPO_ROOT.length + 1).split('\\').join('/'))
    }
  }
  try { walk(join(REPO_ROOT, 'src')) } catch { return [] }
  return out.sort()
}

/** `src/` 下**不在**变异目标里、因而不受无残留门保护的文件（派生）。 */
function uncoveredSrcFiles() {
  const covered = new Set(MUTATION_TARGETS)
  return srcSourceFiles().filter((file) => !covered.has(file))
}

/** `git show HEAD:<path>` 的字节；文件在 HEAD 不存在时返回 null（下面据此判红，不静默跳过）。 */
function headBlob(path) {
  try {
    return execFileSync('git', ['show', `HEAD:${path}`], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

/** 当前文件字节（缺失同样返回 null）。 */
function worktreeBytes(path) {
  try {
    return readFileSync(join(REPO_ROOT, path))
  } catch {
    return null
  }
}

/**
 * 两侧比较：**行尾归一后**比字节。
 *
 * ⚠ 为什么是"归一后"而不是裸字节比（实测，否则本门当场误红 4 个文件）：
 *   本机 `core.autocrlf=true`，`.gitattributes`（2026-09-23 立）规定 `text eol=lf`，
 *   但**在该文件建立之前就已检出的工作区文件仍是 CRLF**。实测（2026-09-25 本门施工时）：
 *   `src/rpc.ts` 工作区 1263 个 CRLF / HEAD 0、`src/members.ts` 509 / 0、
 *   `src/client/locales.ts` 12 / 0、`src/client/RoundTableView.tsx` 1 / 0 ——
 *   裸字节比会把这 4 个文件全判成"残留"，而 `git diff --quiet HEAD -- <file>` 对它们
 *   **全部 exit 0**（git 认为干净）。
 *   ⇒ 判据必须与 git 的判定同构：**归一化后比较内容**。归一也恰好是 git 自己做的事
 *     （索引侧存的就是 LF），故这不是"放宽标准"，而是"与口径同一把尺"。
 *
 * 归一**保留** BOM 与其余字节（只替换 \r\n），故"真的改了内容"仍会被抓到 —— 见脏侧自证。
 *
 * ⚠ **极窄盲区**：`toString('utf8')` 把非法 UTF-8 序列折成 U+FFFD ⇒ 两个**不同**的非法序列
 *   可能折成同一串，本门分辨不了。本仓源文件都是合法 UTF-8，故当前不构成实际缺口；
 *   写在这里是为了不让本门被当成"逐字节全等"（见文件头「三条边界」③）。
 */
const normalizeEol = (buf) => Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')

/**
 * 返回相对 HEAD 有残留的目标文件清单（逐文件比对，供报错点名）。
 *
 * @param options.override 可选的 `{ path, bytes }`：**只在比对时**替换该路径的"盘面字节"。
 *   仅供转红自证使用 —— 它让"注入改动 ⇒ 必须点名该文件"可以**完全不碰真实文件**地证出来。
 */
function residueTargets(options = {}) {
  const override = options.override ?? null
  const dirty = []
  for (const path of MUTATION_TARGETS) {
    const head = headBlob(path)
    const disk = override !== null && override.path === path
      ? override.bytes
      : worktreeBytes(path)
    if (head === null || disk === null) {
      dirty.push({ path, why: head === null ? 'HEAD 里没有这个文件（表里写了个不存在的路径？）' : '工作区文件读不到' })
      continue
    }
    if (!normalizeEol(head).equals(normalizeEol(disk))) dirty.push({ path, why: '与 HEAD 逐字节不一致（归一化行尾后仍有差异）' })
  }
  return dirty
}

/**
 * 「覆盖边界」文案（**派生**，数字与点名清单都不写死）。
 *
 * 判因（2026-09-25 · arch 席复核）：本门只认 mutate.mjs 表里 file: 声明过的目标。
 * 实测 `src/` 下 `.ts`/`.tsx` 共 **37** 个，而表里只声明 **15** 个 ⇒ **22 个 src 文件不在门内**
 * （含 `dispatch.ts` / `state.ts` / `visibility.ts` / `types.ts` / `wire.ts` 等）。
 * 在那些文件里留毒，本门**照绿**（实测：只把 `src/tools.ts` 改脏时本门报红，而
 * `src/dispatch.ts` 同样改脏时本门不报 —— 因为它不在 MUTATION_TARGETS 里）。
 * ⚠ 旧文案只写了"test/ · docs/ · .audit/ 等非目标文件"，读起来像"src 全覆盖"，
 *   会让人误以为 src 全在门内 —— 那是**如实性**缺陷，不是措辞问题。
 *
 * 数字与点名一律**从磁盘派生**（`srcSourceFiles()` / `uncoveredSrcFiles()`）：
 * 写死的 "37/15/22" 会在任何一次新增源文件后变成新的假话。
 */
function coverageBoundaryText() {
  const all = srcSourceFiles()
  const uncovered = uncoveredSrcFiles()
  // 高危遗漏优先点名（这些是"留毒后门照绿"且影响面大的文件）；其余按字典序补足，最多列 6 个。
  const hot = ['src/dispatch.ts', 'src/state.ts', 'src/visibility.ts', 'src/types.ts', 'src/client/wire.ts']
  const named = [...hot.filter((f) => uncovered.includes(f)), ...uncovered.filter((f) => !hot.includes(f))]
  const shown = named.slice(0, 6)
  return '  ⚠ 覆盖范围有限（这不是"src 全覆盖"，也不是"全仓无残留"的保证）：'
    + `本门只认 mutate.mjs 表里 file: 声明过的变异目标文件 —— 实测覆盖 **${MUTATION_TARGETS.length} / ${all.length}** 个 src 下的 .ts/.tsx，`
    + `**${uncovered.length} 个 src 文件不在门内**` + '（含 ' + shown.join(' · ')
    + (uncovered.length > shown.length ? ` 等 ${uncovered.length} 个` : '')
    + '）；这些文件里留毒时本门**照绿**（实测）。\n'
    + '    范围数字与清单**由磁盘派生**（不手写名单）——这是刻意的：手写名单会与 mutate.mjs 表漂移成两份真相。\n'
    + '    另外 test/ · docs/ · .audit/ · package.json 等也都不归它管。\n'
}

test('无残留：变异目标文件必须与 HEAD 一致（逐文件点名，不靠"不一致"三个字）', () => {
  assert.ok(MUTATION_TARGETS.length >= 10, `只解析到 ${MUTATION_TARGETS.length} 个变异目标文件 —— 前提不成立（解析脱节）`)
  const dirty = residueTargets()
  assert.deepEqual(
    dirty.map((d) => `${d.path} — ${d.why}`),
    [],
    '\n无残留门：以下变异目标文件相对 HEAD 有差异 —— 先分清下面三种情况，再动手：\n\n  '
    + dirty.map((d) => `${d.path} — ${d.why}`).join('\n  ')
    + '\n\n  ⚠ 先看这条（免得把"我改了 src"误判成"门坏了"）：若你**确实改了 src/ 且未提交**，'
    + '本次全量 node --test 会一次红 4 条 ——\n'
    + '    ① 本门「无残留」 ② 产物守卫「产物不比 src 旧」 ③ 产物守卫「类型声明不比 src 旧」'
    + ' ④ 本门的转红自证（它末尾也会跑一次不带注入的比对）。\n'
    + '    这 4 条红是同一个原因（树未回到基线）的如实报告，**不是门坏了**。'
    + '（主持人实测读数 417/413/4；本席只复核了 4 条红的触发点，未自行改脏 src 复现 —— 见文件头「三条边界」①）\n\n'
    + '  (A) 你确实改了 src/（本次工作有意为之）：'
    + '**先提交**（git commit 该改动），或**只跑本门**避开另外两条产物守卫的红：\n'
    + '      node --test --test-name-pattern="无残留" "test/mutation-probe-health.test.mjs"\n'
    + '      （⚠ 不要写成 npm test --test-name-pattern=… ：npm test 脚本是 '
    + 'node --test "test/*.test.mjs" && node scripts/export-experts.mjs --selftest，该参数既不在 node 调用点、也不属于后一条命令。）\n'
    + '      本门不声称"全仓无未提交改动"，只声称"这些变异目标文件相对 HEAD 是干净的"。\n\n'
    + '  (B) 你**留了毒**：变异探针跑完没还原（或还原到了开工时那份**已经带毒**的快照 —— '
    + '2026-09-25 真实事故就是这么发生的）。那就逐字节还原后再跑任何门禁。\n\n'
    + coverageBoundaryText()
    + '  两种都不许在带毒树上继续跑门禁或重建产物。',
  )
})

test('无残留门的转红自证：注入已知改动必须**点名该文件**报红（且不碰真实文件）', (t) => {
  /*
   * ⚠ 没有这一条，上面那条可能只是"恰好绿"（比如比错了路径、或 normalizeEol 把差异吃掉了）。
   *
   * ⚠⚠ 为什么用**注入**而不是"真的写盘再还原"（2026-09-25 施工中改主意，理由可复核）：
   *   `npm test` 的多个测试文件是**并行**跑的，而 `src/tools.ts` 等目标文件正被别的测试
   *   读取（大量 `assert.match(read('tools.ts'), …)`）。"写盘→比→还原"这段窗口里，
   *   并行的另一个测试会读到**半改**的源码 ⇒ 制造一次**随机假红**。
   *   那正是本仓反复在剿的"让失败不可观测"形态，只是换了个方向（假红会训练人忽略守卫）。
   *   ⇒ 故转红自证改为**只在比对函数入参处替换盘面字节**：盘面**一个字节都不动**，
   *     因此本测试自身不可能留残留，也不可能干扰并行测试；而"注入差异 ⇒ 必须点名"照旧被证。
   *
   * 真实盘面侧的转红证据不靠本测试，靠**事故与施工中的实测**（可复核）：
   *   把 `src/tools.ts` 改成事故毒形态（`if (captainLive !== undefined && false) {`，
   *   sha256 = 82d41c9b28303c15…）后，本门 `ℹ fail 2` 并点名 `src/tools.ts`（实测 2026-09-25）；
   *   等价改写 `&& true`、以及非 tools 目标 `src/budget.ts` 的改写，同样被点名。
   */
  assert.ok(MUTATION_TARGETS.length >= 10, '前提：目标清单非空')
  /*
   * ⚠ 基线残留清单（测试开始时实测）—— 供末尾的"注入不得泄漏"判据使用。
   *   为什么不能写成"末尾必须为空"：树里若本来就有别的脏文件（本次 arch 席复核撞到的情形），
   *   那条会以"转红自证跑完后盘面必须干净"的文案变红 —— **又是假因**（该由「无残留」门报警）。
   *   改成"与开始时的清单逐项一致"后：① 脏树不再误伤本自证；② 仍能抓住
   *   override 泄漏到后续调用（注入把清单改了就与基线不等）。
   */
  const residueAtStart = residueTargets().map((d) => d.path)
  for (const path of MUTATION_TARGETS.slice(0, 3)) {
    const before = worktreeBytes(path)
    assert.ok(before !== null, `转红自证：读不到 ${path}`)
    const injected = Buffer.concat([before, Buffer.from('\n// residue-probe\n', 'utf8')])
    const dirty = residueTargets({ override: { path, bytes: injected } })
    const named = dirty.map((d) => d.path)
    /*
     * ⚠ 判据从"精确相等"改成"**必然包含注入路径**"（2026-09-25 · arch 席复核发现的假因）：
     *   "精确相等"在**树里已有别的脏文件**时会失败 —— 而那跟本自证要证的东西无关。
     *   实测（把 src/tools.ts 改脏后单跑本门，注入 src/aggregator.ts）：
     *     报错 = 「残留清单应与注入路径**精确相等**（实际：["src/aggregator.ts","src/tools.ts"]）
     *             —— 不等即"点名能力"或"注入通道"有一个不成立」
     *   ⇒ **假因**：探针好好的，真实原因只是树里有另一个脏文件。
     *   这正是本仓 mutate.mjs:370-379 明令防的"把常见情形误报成更严重的因由"。
     *   ⇒ 现在分成两件事分别断言、分别归因：
     *       ① 注入路径**必须在**清单里 —— 这才是"点名能力/注入通道成立"的证据；
     *       ② 清单里**额外的**条目只报"树里另有残留"，**不**指控本自证。
     */
    assert.ok(
      named.includes(path),
      `注入 ${path} 的改动后，本门没在残留清单里点名它（实际清单：${JSON.stringify(named)}）`
      + ' —— 这才是"点名能力"或"注入通道"不成立的证据（override 没接上 / 比较式被短路）。',
    )
    const others = named.filter((candidate) => candidate !== path)
    if (others.length > 0) {
      /*
       * ⚠ 这里**不放断言**：这些额外条目与本自证要证的东西无关（Δ=注入 vs 基线）。
       *   用 `t.diagnostic` 如实打一行信息即可 —— 放一条恒真断言（如 deepEqual(others, others)）
       *   比不放更坏：它会冒充覆盖（本仓最忌讳的形态）。
       */
      t.diagnostic(
        `转红自证信息：本次注入 ${path} 期间，清单里另有 ${others.length} 个脏文件 ${JSON.stringify(others)}`
        + ' —— 与本自证无关（它只注入比对入参、不碰盘面）；请以上面「无残留」门的清单为准。',
      )
    }
    // 注入只影响比对入参：盘面必须自始至终干净（本测试不写盘，故这可由实测机械核对）。
    assert.ok(
      worktreeBytes(path).equals(before),
      `${path} 在转红自证期间被改动了 —— 本测试承诺不碰真实文件（碰了就会与并行测试互相干扰）`,
    )
  }
  // 不带注入的比对必须与测试开始时**逐项一致**：防 override 泄漏到后续调用（空转形态）。
  assert.deepEqual(
    residueTargets().map((d) => d.path),
    residueAtStart,
    '不带注入的残留清单与测试开始时不一致 ⇒ 注入泄漏到了后续调用（或比较式被改写）；'
    + `开始：${JSON.stringify(residueAtStart)}，现在：${JSON.stringify(residueTargets().map((d) => d.path))}`,
  )
  /*
   * ⚠ 归一化必须**双向**：吃得到"行尾差异"、吃不到"内容差异"。
   * 只测一侧会漏 —— 若归一化把整个文件吞了（例如误用 /\s+/），上面"注入 ⇒ 点名"仍可能成立，
   * 但真实 CRLF 误红会回来；反之若根本没归一，本机 4 个 CRLF 文件会当场误红。
   */
  const sample = MUTATION_TARGETS[0]
  const head = headBlob(sample)
  assert.ok(head !== null, `转红自证：HEAD 里读不到 ${sample}`)
  /*
   * ⚠ 这两条也只看**注入的那条路径**，不看整份清单（同 ① 的假因修法）：
   *   树里本来就有别的脏文件时，"整份清单必须为空"会以"行尾差异被判为残留"的文案变红 ——
   *   又一次假因。改成"注入路径是否在清单里"后，与树的其余状态无关。
   */
  const crlfVersion = Buffer.from(head.toString('utf8').replace(/\n/g, '\r\n'), 'utf8')
  assert.ok(
    !residueTargets({ override: { path: sample, bytes: crlfVersion } }).map((d) => d.path).includes(sample),
    `行尾差异不得被判为残留（否则本机 4 个 CRLF 工作区文件会误红）—— 但 ${sample} 被判成了残留：`
    + `${JSON.stringify(residueTargets({ override: { path: sample, bytes: crlfVersion } }).map((d) => d.path))}`,
  )
  const contentVersion = Buffer.concat([head, Buffer.from('\n// x\n', 'utf8')])
  assert.ok(
    residueTargets({ override: { path: sample, bytes: contentVersion } }).map((d) => d.path).includes(sample),
    `内容差异必须被判为残留（归一化不得把真差异一起吞掉）—— 但 ${sample} 没被点名：`
    + `${JSON.stringify(residueTargets({ override: { path: sample, bytes: contentVersion } }).map((d) => d.path))}`,
  )
})
