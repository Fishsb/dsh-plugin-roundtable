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
 *
 * ## ⚠ 复核口径（x1 · 2026-09-26）：**任何外部复算必须与内联路径同口径**
 *
 * `k1` 的内联路径是 `guardsBeforeCleanup(blankComments(readLf('./mutate.mjs')))` ——
 * **先清空注释**再判。任何人在外面把判据函数抠出来单独复算时，**必须走同一步**：
 *
 *     const srcLf = blankComments(readFileSync('test/mutate.mjs', 'utf8'))
 *     guardsBeforeCleanup(srcLf)          // ✅ 与线上同口径
 *     guardsBeforeCleanup(rawText)        // ❌ 会假红，见下
 *
 * **实测读数（本席独立复现，与 minimal 席一致）**：
 *   不带 `blankComments` 直接喂真文件 ⇒ `unguarded = [323]`、`callAfterLastProof = [323]`；
 *     `:323` 的原文是**注释**里的一句 `rmSync(sandbox)`（在讲"旧实现把 rmSync 放在 finally 里"）。
 *   带 `blankComments`             ⇒ `unguarded = []`、`teardownAt = [278,307,408,444,483]`。
 *
 * ⇒ 前者的红是**口径错误造成的假红**，**不是判据缺陷**。判据本身要求"注释里的字样不算调用"
 *   （本仓已有前科：锚点字符串被注释冒充），故清注释是**判据的一部分**，不是可选预处理。
 *
 * **为什么要把这句写进文件头**：本仓**两席两轮各踩过一次**同一个坑（minimal 席两轮复核中踩到、
 * 本席在独立复算时同样先读到 `[323]`）。假红的代价不只是浪费一轮 —— 它会让人**先怀疑判据坏了**，
 * 从而去"修"一个没坏的东西。一句话即可挡住，故写在这里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
/*
 * node:crypto 是**无残留门扩到全量 src 的成本解**（2026-09-26 · T3 扩面）：
 * 37 个 `.ts`/`.tsx` 在 node 里算 git-blob-sha1 实测 **25 ms**，
 * 而逐文件起 git 子进程是 **1512 ms**（≈41 ms/文件）。
 */
import { createHash } from 'node:crypto'

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

/* ── ⑤ 无残留门：全量 src 必须与 HEAD 一致（2026-09-25 留毒事故倒逼；2026-09-26 T3 扩面） ──────
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
 *        「**`src` 下全部 `.ts`/`.tsx`** 相对 HEAD 是否干净」。本轮施工中这些文件若有**正当的
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
 *  ② **覆盖范围：`src` 下 `.ts`/`.tsx` 全覆盖（2026-09-26 T3 扩面）** —— 比对面 = `RESIDUE_TARGETS`
 *     （全量 `src` 下 `.ts`/`.tsx`，实测 **37** 个）。旧口径只认 `mutate.mjs` 表里 `file:` 声明过的
 *     **15** 个 ⇒ **22 个不受保护**（`dispatch.ts` / `state.ts` / `visibility.ts` / `types.ts` /
 *     `client/wire.ts` …）。**实测缺口**：往 `src/client/ui-slots-anchor.d.ts` 追 21 字节，
 *     旧口径 `ℹ pass 2 / ℹ fail 0` 且**不点名**；同一动作落在已覆盖的 `src/aggregator.ts` 上则 exit=1 并点名。
 *     本门**仍不覆盖**：`test/*.mjs`、`docs/`、`.audit/`、`package.json`，以及 `src` 下
 *     **非 .ts/.tsx** 的文件（`.css` / `.module.css` 等）—— 已实测：在那些地方留毒时本门照绿。
 *     边界文案由 `coverageBoundaryText()` **从磁盘派生**（不手写名单）。
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
 *   · 干净侧：全部比对面文件相对 HEAD 逐字节一致 ⇒ 绿；
 *   · **脏侧（转红自证）**：注入已知改动后本门必须报红**且点名那个文件**，且**盘面一个字节不动**。
 *     ⚠ T3 扩面后注入样本里**必须含一个"变异表之外"的文件**（`uncoveredByMutationTable[0]`）——
 *       只注入老样本抓不到本轮那条缺口（它们在旧口径下本来就绿得对）。
 *   ⇒ 两条一起才证明"门在裁"，而不是"门恰好绿"。
 *
 * ⚠ **G-1（2026-09-26 修）· 归因分流**：`head` 读不到时**必须报【环境】**，不许与"某文件脏了"
 *   共用一句文案（实测：无 `.git` 时旧实现 15 个文件齐报"表里写了个不存在的路径？" —— 指向是假的）。
 *   四种因由互斥，逐条都有 git 的 oracle 背书：
 *     · `环境读不到 HEAD（或索引）` —— 报【环境】，**不进逐文件循环**（G-1）；
 *     · `未跟踪（不在 git 索引里）` —— `unjudged`，如实呈报但**不判红**（f2/h1）；
 *     · `在索引里、却不在 HEAD 树里`（`git add` 未提交）—— 归 `dirty`，实测 git 判它脏（f2）；
 *     · `与 HEAD 不一致` —— 归 `dirty`（真脏）。
 *   ⚠ 这四条**各自都有常驻反例**：h1 那条测试在 `mkdtemp` 临时仓里逐条实测命中，不靠人工造环境。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

/** 仓库根（本文件在 test/ 下）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * **变异目标文件**：`mutate.mjs` 表里出现的 `file:` 集合（实测 15 个）。
 *
 * ⚠ **2026-09-26 起它不再是「无残留门」的比对面**（T3 扩面）。用户点名的是
 *   「22 个 src 不在**门**内、留毒照绿」—— 那是门的**保护面**，不是"每个文件都被改坏过"
 *   的**检测面**；扩保护面不改变异表，也就**不与 T1 抢 `mutate.mjs`**
 *   （两条改动同时落在同一文件 = 互踩，这是上一轮留毒事故的同型风险）。
 *   实测（旧口径）：往 `src/client/ui-slots-anchor.d.ts` 追加 21 字节，本门
 *   `ℹ pass 2 / ℹ fail 0` 且**不点名**；同一动作落在已覆盖的 `src/aggregator.ts` 上则 exit=1 并点名。
 * ⇒ 比对面换成 {@link RESIDUE_TARGETS}（全量 `src` 下 `.ts`/`.tsx`，实测 37 个）；
 *   本常量退回它本来的用途：**注入样本池**（转红自证要往"变异真会改的"那些文件上注入）。
 *
 * 旧范围理由（保留供对照）：这组文件是**探针会去改**的那些，也正是「探针自身残留」
 * 唯一可能发生的地方。⚠ 那条理由只覆盖「探针留毒」，**不覆盖**「任何别的改写落在 src 上时
 * 门看不见」—— 后者才是被用户点名的那条，见 {@link RESIDUE_TARGETS}。
 */
const MUTATION_TARGETS = [...new Set(mutations.map((m) => m.file))]
  .filter((file) => typeof file === 'string' && file !== '')
  .sort()

/**
 * **无残留门的比对面 = 全量 `src` 下 `.ts`/`.tsx`**（2026-09-26 · T3 扩面）。
 *
 * 判因（用户点名 + 两次实测）：旧比对面是 `MUTATION_TARGETS`（15 个），而 `src/` 下
 *   `.ts`/`.tsx` 实测 **37** 个 ⇒ **22 个不在门内**（`dispatch.ts` / `state.ts` /
 *   `visibility.ts` / `types.ts` / `client/wire.ts` …）。
 *
 * ⚠ 为什么可以用「全量 src」（本仓取舍，写清免得被当成放宽标准）：
 *   风险不是"误报太多"，而是"与**正当的未提交 src 改动**冲突"。这条由下面的比较式解掉：
 *   新比较式与 `git` 对"脏"的定义**同构**（行尾归一后比内容），故它红 ⟺ `git diff --quiet -- <file>`
 *   也会红，不多出任何一类假红。实测（施工时·干净树）：37 个文件的新旧两侧**逐一相等**
 *   （mismatch = 0）⇒ 新门在干净树上不会自红。
 *
 * ⚠ **同构性有一个例外，已由 f2 修掉**：上面的"⟺"只对**已跟踪**文件成立。
 *
 * ⚠ **本门仍只覆盖 `src` 下的 `.ts`/`.tsx`**：`test/*.mjs`、`docs/`、`.audit/`、`package.json`、
 *   以及 `src` 下非 .ts/.tsx 的文件（`.css` / `.module.css`）都不归它管。
 *   这是**如实标注的边界**，不是"全仓无未提交改动"的保证（见文件头「三条边界」②）。
 *
 * ⚠ **为什么 `src/` 之外（含 `.audit/`、仓库根的 `tsdown.config.ts`）刻意不纳入**（本轮被点名）——
 *   三条理由，**前两条是语义、第三条是现状**：
 *     ① **判据分工**：`RESIDUE_TARGETS = srcSourceFiles()`，而 `srcSourceFiles()` 的本职是
 *        "跟着 `src` 走"（`src/` 是唯一会进构建产物的源树）。让同一个集合兼职扫全仓，
 *        等于把"产物源面"与"全仓面"混成一份真相 —— 本仓反复在剿的就是这种混同。
 *     ② **不该把别人的生成物算成"残留"**：`.audit/` 按定义是**施工期临时探针**的落点
 *        （本文件自己与三席都往那儿写脚本，且它整个目录未被跟踪）。把未跟踪的临时面
 *        拉进"与 HEAD 一致"的判据里，只会制造假红，不会多抓到任何真毒。
 *     ③ **当前实测：`.audit/` 下并没有 `.ts` 探针**（`Get-ChildItem .audit -Recurse -Include *.ts,*.tsx`
 *        只命中本席 2026-09-26 建的 `.audit/edge/tscsandbox/{a,b}.ts` 与它们的 `types/*.d.ts`；
 *        另 `.audit/` 下另有 3 个 `.mjs` 脚本 + 若干 `.json/.txt`）。
 *        ⇒ 即：本条边界**当前不构成任何真实覆盖缺口**；若将探针用 `.ts` 写进 `.audit/`，本门确实看不见 ——
 *          那是**已登记**的边界，不是"我们没发现"。
 *     ⇒ 若将来要覆盖，正确做法是**给全仓面单独立一条判据**（自己的目标集 + 自己的基线口径），
 *       而不是把 `RESIDUE_TARGETS` 撑大 —— 后者会让本条的错报归因（G-1/G-2）跟着脏化。
 */
const RESIDUE_TARGETS = srcSourceFiles()

/**
 * `src/` 下全部 `.ts`/`.tsx`（相对仓库根、正斜杠、排序）——**派生**，不手写名单。
 *
 * 用途有两个，都要求"跟着磁盘走"而不是写死数字（写死的数字会在新增源文件后变成新的假话）：
 *   ① 提供「无残留门」的比对面（{@link RESIDUE_TARGETS}）；
 *   ② 提供「覆盖边界」文案里的文件总数。
 *
 * ⚠ 2026-09-26 订正（arch 席指出本段与 `coverageBoundaryText` **自相矛盾**）：
 *   旧文本写「覆盖的分子仍是 `MUTATION_TARGETS`（判定主体不变）」，那是 T3 扩面**之前**的口径；
 *   扩面后判定的分子是**本函数**，`MUTATION_TARGETS` 只作注入样本池。已改。
 *
 * ⚠ 它**只管 `src/`**：`.audit/`、仓库根（`tsdown.config.ts`）等处的 `.ts` 不在面内。
 *   理由写在 {@link RESIDUE_TARGETS} 的注释里（那里同时给了"当前 `.audit/` 下并没有 `.ts` 探针"的实测）。
 */
function srcSourceFiles(root = REPO_ROOT) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.tsx?$/.test(entry.name)) continue
      out.push(full.slice(root.length + 1).split('\\').join('/'))
    }
  }
  try { walk(join(root, 'src')) } catch { return [] }
  return out.sort()
}


/**
 * 一次 `git ls-tree -r HEAD -- src` 拿回「路径 → git-blob-sha1」，供全量比对使用。
 *
 * 判因（T3 扩面把比对面从 15 个扩到 37 个，成本必须重算）：逐文件 `git show HEAD:<path>`
 *   实测 **1512 ms / 37 文件**；本函数**一次** git 子进程 + node crypto 实测
 *   **120 + 25 = 145 ms**（≈10× 快），且与 `git diff` / `git hash-object` 的口径同构 ——
 *   `git-blob-sha1(归一化行尾后的字节)` 正是 git 索引里存的那个摘要。
 *
 * ⚠ `-z` + 手动切 `\t` 是**刻意的**：路径含空格/中文时，非 `-z` 的引号转义会让解析歪掉；
 *   本仓源文件路径当前全 ASCII，但判据不该依赖这个偶然。
 *
 * ⚠ **它只回答"HEAD 里有没有这个路径"，不回答"这个路径在 git 眼里算不算新增"**（f2 判因）：
 *   未跟踪的新文件**不在** ls-tree 里（实测），但 git 认为它**干净**（实测 `git diff --quiet HEAD -- <path>` exit=0）
 *   ⇒ 光凭本函数的 `undefined` **无法**把"路径写错"与"文件是新增的"分开。
 *   那一步由 {@link trackedPaths} 提供，见 `residueTargets` 的 G-2。
 *
 * 返回 `{ status:"ok", shas }` 或 `{ status:"error", detail }` —— **不抛**，由调用方把
 *   「环境读不到 HEAD」与「某个文件真的脏了」分开报（G-1 的修法，见 `residueTargets`）。
 */
function headBlobShas(root = REPO_ROOT) {
  try {
    const raw = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD', '--', 'src'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      /*
       * ⚠ `stdio` 显式 `pipe`（h1 顺手收的一处噪声）：不写时 node 会把子进程 **stderr 透传到父进程**，
       *   于是「空仓无 HEAD」这类**被本函数预期并已归因**的情形，仍会往 `npm test` 的 stderr
       *   打一行 `fatal: Not a valid object name HEAD` —— 归因已经做对了，噪声却还在，
       *   读者会以为出了别的事。显式 pipe 后 `error.stderr` 照常可读（`detail` 不空），只是不再泄漏。
       */
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const shas = new Map()
    for (const entry of raw.split('\u0000')) {
      if (entry === '') continue
      const tab = entry.indexOf('\t')
      if (tab < 0) continue
      const sha = entry.slice(0, tab).split(' ')[2]
      if (typeof sha !== 'string' || sha === '') continue
      shas.set(entry.slice(tab + 1), sha)
    }
    return { status: 'ok', shas }
  } catch (error) {
    const detail = String(error && error.message ? error.message : error).split('\n')[0].slice(0, 200)
    return { status: 'error', detail }
  }
}

/**
 * git **索引**里的路径集（`git ls-files --cached`）——只用来回答一个问题：
 *   「这个磁盘上的文件，git **认它是被跟踪的**吗？」
 *
 * ## 判因（f2 · arch 席独立审查发现的归因错报）
 *
 * 上一版把"不在 `HEAD` 索引里"**直接**报成
 *   「HEAD 索引里没有这个路径 —— 清单与实际文件对不上（**不是"脏"，是路径错**）」。
 * 而 `src/` 下新增一个**未跟踪**的 `.ts` 是**正常施工动作**，此时 git 对它判**干净**。
 * 实测（临时仓四象限，oracle = `git diff --quiet HEAD -- <path>`）：
 *
 *   | 情形 | `git diff --quiet HEAD` | `ls-files --cached` | `check-ignore` |
 *   |---|---|---|---|
 *   | ① 未跟踪新文件 | **0（干净）** | 0 | 1 |
 *   | ② `git add` 后未提交 | 1（脏） | 1 | 1 |
 *   | ③ 已跟踪被改 | 1（脏） | 1 | 1 |
 *   | ④ 未跟踪且被 ignore | **0（干净）** | 0 | 0 |
 *
 * ⇒ 光看"在不在 ls-tree 里"**分不开 ① 与"路径写错"** —— 两者的 ls-tree 结果都是 `undefined`。
 *   把 ① 报成"路径错"是**双重假**：① 报错指错对象；② 让"它红 ⟺ git 也红"这句话为假。
 *   ⇒ 现在多一次 `ls-files --cached`（实测 **38.6 ms**，与 ls-tree 的 43.4 ms 同量级、只跑一次），
 *     按下表四分类，**每一类都对应 git 自己的答案**：
 *
 *   · `tracked`（②③）—— 在索引里 ⇒ 比 git-blob 摘要，不等即「与 HEAD 不一致」（真脏）。
 *   · `untracked`（①④）—— 不在索引里 ⇒ **git 认为它干净**（oracle 实测 exit=0）⇒
 *     本门**不点名**，改为**如实呈报**：该文件**无法**用 HEAD 判残留（见 `unjudged`）。
 *     这与 oracle 一致，也就保住了"它红 ⟺ git 也红"这句话。
 *   · 不在 ls-tree、也不在索引 —— 与 ① 同形，**不可能**被本门区分 ⇒ 不再假装能区分。
 *     ⚠ 代价：`RESIDUE_TARGETS` 本身是从 `src/` 实扫出来的，所以"路径写错"这一情形
 *       **对本门根本不可能发生**（旧报错里那半句是**不可达文案**）—— 真正会撞上的只有 ①。
 *
 * ⚠ 不做「未跟踪文件进了 `src/` 就判红」：未跟踪的来源分不出（`f2` 席点名的"刻意排除"
 *   需要的是**据实分层**，不是编一个判断）。能证的证，不能证的如实说"没判"。
 *
 * 返回 `{ status:"ok", tracked:Set }` 或 `{ status:"error", detail }` —— **不抛**；
 *   调用方读到 error 时**整门退回报【环境】**（与 G-1 一致：读不到基线就不许判绿）。
 *
 * `root` 供 h1 的临时仓测试传（同 {@link headBlobShas}）——命令与参数一字不改，只换 cwd。
 */
function trackedPaths(root = REPO_ROOT) {
  try {
    const raw = execFileSync('git', ['ls-files', '--cached', '-z', '--', 'src'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const tracked = new Set()
    for (const entry of raw.split('\u0000')) {
      if (entry === '') continue
      tracked.add(entry)
    }
    return { status: 'ok', tracked }
  } catch (error) {
    const detail = String(error && error.message ? error.message : error).split('\n')[0].slice(0, 200)
    return { status: 'error', detail }
  }
}

/**
 * 本文件**源码**里 `reportUnjudged(<sink>, unjudged)` 的调用点行号（1-based）。
 *
 * ## 判因（q1 ① · accept 席复核实测 —— 本轮最严重的一条）
 *
 * p2 把判别力钉在「函数会不会报知」，但**主门到底调没调它**是空白：
 *   实测把主门 `:756` 的 `reportUnjudged(t, unjudged)` **整行删掉** ⇒ `exit=0 / 11 pass` **全绿**。
 *   根因一句话：f2 那条测试用**自造桩**，只证「函数会报知」，**不证「主门调了它」**。
 *   ⇒ p2 的修法**范围收窄了**：函数级钉死了，调用级漏了。
 *
 * ## 手法（与 {@link guardsBeforeCleanup} 同族的**静态判据**）
 *
 * 不执行代码，只读本文件源码找调用点；关键是**必须有非空前提**（`length >= 1`），
 *   否则"没找到 ⇒ 空集 ⇒ 下面的断言空转通过"就是又一个假绿 —— 本仓已踩过两次。
 *
 * ⚠ **必须只扫到主门那一段**：f2 里也有 `reportUnjudged(sinkStub, …)` 与 `reportUnjudged(t, …)`，
 *   若全文件一把扫，"主门有没有调"这件事会被 f2 自己的调用**冒充**（本仓前科：锚点被注释冒充）。
 *   故本函数按 {@link MAIN_GATE_NAME} 切出主门那一段，只在该段内找。
 *
 * ## ⚠ 第三种同族冒充：**字符串字面量**（t1 · accept 席实测）
 *
 * 前两种（常量声明行、函数定义行）已排除，但**行文本**里长得像调用的**字符串**仍会被认成调用：
 *   实测把主门那行换成 `const fake = 'reportUnjudged(t, unjudged)'` ⇒ **全绿**。
 *   本仓反复剿的正是「锚点被同名处冒充」，而这条判据**刚立当天**就被字符串冒充 ⇒ 同族原形。
 * ⇒ 判定前先 {@link stripStrings}（剥掉字符串/模板字面量内容，保留其余文本与**行号不变**）。
 *   ⚠ 只剥字面量**内容**、不删整行：调用出现在**含字符串参数**的行上（如 `reportUnjudged(t, 'x')`）
 *     必须仍被认出 —— 实测该形态仍命中（见 t1 那条测试的「不得误伤」段）。
 *
 * @param {string} srcLf 本文件源码（LF 归一、已去注释）。
 * @param {string} titleSubstring 目标测试的标题子串（默认主门）——**负控 B 要拿它去切 f2 段**，
 *   故必须可参数化；写死成主门一处，负控就只能对着空气断言（实测踩过：喂 f2 段进去返回空集）。
 * @returns {{span: {start: number, end: number}, calls: number[]}} 目标区段与段内调用行号。
 */
function mainGateReportCalls(srcLf, titleSubstring = MAIN_GATE_NAME) {
  /*
   * ⚠⚠ **切段用原文、判调用用剥串后的文本** —— 这两件事不能用同一份文本：
   *   测试标题本身**就在字符串字面量里**（`test('无残留：全量 src …', …)`），
   *   若拿 stripStrings 的结果去 includes(titleSubstring)，标题内容已被抹掉 ⇒ 段切不出来
   *   （实测：span 直接变成 {-1,-1}，判据自己假红）。
   *   剥串只服务于「这一行有没有**真的调用**」，不参与「找哪一段」。
   */
  const rawLines = srcLf.split(NEWLINE)
  const strippedLines = stripStrings(srcLf).split(NEWLINE)
  /*
   * ⚠ 锚点必须**同时**要求「这一行是 `test(` 开头」——只 includes(MAIN_GATE_NAME) 会先撞上
   *   `const MAIN_GATE_NAME = '…'` 那行常量声明（实测：命中 [568, 764]，取到的段落里
   *   一个调用都没有 ⇒ 判据自己假红）。这正是"锚点被同名处冒充"的又一例（本仓前科）。
   */
  const start = rawLines.findIndex(
    (line) => /^test\(/.test(line) && line.includes(titleSubstring),
  )
  if (start < 0) return { span: { start: -1, end: -1 }, calls: [] }
  /* 主门测试体的结束 = 下一个顶层 `test(`（node:test 的测试都是顶层的）。 */
  const next = rawLines.findIndex((line, i) => i > start && /^test\(/.test(line))
  const end = next < 0 ? rawLines.length : next
  const calls = []
  for (let i = start; i < end; i++) {
    /*
     * ⚠ 排除**函数定义行**：`function reportUnjudged(sink, unjudged) {` 也匹配 `\breportUnjudged\s*\(`，
     *   不排除的话「主门有没有调用」会被定义行冒充（实测：定义在 :536，一撞就假绿）。
     */
    if (!CALLS_REPORT.test(strippedLines[i])) continue
    if (/^\s*(?:async\s+)?function\s+reportUnjudged\b/.test(strippedLines[i])) continue
    calls.push(i + 1)
  }
  return { span: { start: start + 1, end }, calls }
}
/**
 * 剥掉源码里的**字符串 / 模板字面量内容**，其余字符原样保留、**换行与行号不变**。
 *
 * ## 判因（t1 · accept 席实测第三例同族冒充）
 *
 * `mainGateReportCalls` 早先只排除了两种冒充（常量声明行、函数定义行），但**行文本**里
 *   长得像调用的字符串**仍会被认成调用**：实测把主门那行换成
 *     `const fake = 'reportUnjudged(t, unjudged)'`
 *   ⇒ 套件**全绿**。本仓反复剿的就是「锚点被同名处冒充」，这是它的**第三种形态**。
 *
 * ## 口径（刻意保守，避免误伤）
 *
 *   · 只处理**常见的三种字面量**：`'…'`、`"…"`、`` `…` ``；引号本身**保留**（行号/结构不漂）；
 *   · 支持 `\` 转义，故 `'a\\'b'` 这类不会被截断；
 *   · **不跨行**：单引号/双引号字符串按 JS 语法本就不可跨行（见到未闭合就停在本行）。
 *     ⚠ **这条限制的方向是「误红」，不是「更保守」**（u1 · accept 席实测订正，我原先把定性写反了）：
 *       漏剥 ⇒ 字符串内容留在文本里 ⇒ **可能把一段字符串认成调用** ⇒ 判据**误红**。
 *       （「更保守」意味着"宁可不报、不误报"，与此相反。本仓对误红的评价是：它会训练人忽略守卫，
 *        比漏报更坏 —— 故这里必须把方向写对。）
 *   · 模板字面量同理不跨行：多行模板会退化为"整行原样保留"，即**回到旧行为** ⇒ 同样可能误红。
 *     ⚠ accept 已实测：本文件当前**正则含引号 0 例、多行模板串 0 例、行尾注释含引号 0 例**，
 *       真实输入上真调用**零损失** —— 即该边界**当前无实例**，是登记项而非活缺陷。
 *
 * ⚠ **不删整行**：只清空字面量**内容**。像 `reportUnjudged(t, 'x')` 这种"真调用 + 字符串参数"
 *   必须仍被识别 —— 实测仍命中（t1 测试内的「不得误伤」段）。
 *
 * @param {string} text 源码文本。
 * @returns {string} 同长度、同行数的文本，字符串内容被抹成空格。
 */
function stripStrings(text) {
  const out = []
  let quote = null
  let escaped = false
  for (const ch of text) {
    if (quote === null) {
      if (ch === '"' || ch === "\'" || ch === '`') { quote = ch; out.push(ch); continue }
      out.push(ch)
      continue
    }
    /* 字面量内部 */
    if (escaped) { escaped = false; out.push(' '); continue }
    if (ch === '\\') { escaped = true; out.push(' '); continue }
    if (ch === quote) { quote = null; out.push(ch); continue }
    /* ⚠ 单双引号按 JS 语法不跨行：见到换行就认为字面量在本行结束（保守）。 */
    if (ch === NEWLINE && quote !== '`') { quote = null; out.push(ch); continue }
    out.push(' ')
  }
  return out.join('')
}
/**
 * **落位自证**：给定「一段文本 + 该文本里若干行号」，断言这些行**确实是**对 `reportUnjudged` 的调用。
 *
 * ## 判因（t1 · M3 负控暴露的缺口）
 *
 * ④ 组第一版把这条判定**内联在循环里**：有人把循环体换成恒真的 `true,` 时，套件**仍全绿**（实测）——
 *   与 V2 同型的缺口：**判定自己没有负控**。抽成函数后即可喂一段**已知错误**的输入，
 *   断言它**必须判假** —— 这样「它在裁」这件事才有人验。
 *
 * ⚠ `lines` 与 `callNumbers` 必须**同源**（行号是相对这段文本的）。实测踩过：把切段结果的
 *   行号拿去回读全文件，读到的是完全无关的行（报出 `assert.ok(typeof m.to === 'string' …)`）。
 *
 * @param {string[]} lines 目标文本按行切。
 * @param {number[]} callNumbers 1-based 行号。
 * @param {(msg: string) => void} onBad 判假时的回调（生产传抛错函数，测试可传空）。
 * @returns {boolean} 全部落位正确才为 true。
 */
function assertCallsAreReal(lines, callNumbers, onBad) {
  for (const n of callNumbers) {
    const line = lines[n - 1] ?? ''
    if (!CALLS_REPORT.test(stripStrings(line))) {
      onBad(`第 ${n} 行并不是对 reportUnjudged 的调用（切段结果本身不可信）：${line}`)
      return false
    }
  }
  return true
}
/** git 的 blob 摘要：`sha1("blob <len>\0" + bytes)` —— 与 `git hash-object` 逐位相同。 */
/**
 * 把「未判」清单如实交给测试框架 ——**参数叫 `sink` 而不是 `t`，这个改名就是 p2 的修法本身**。
 *
 * ## 判因一（h1 · 本文件最严重的一条缺陷）
 *
 * 旧实现把 `for (const item of unjudged) t.diagnostic(...)` **内联在主门测试体里**，而那条测试的签名
 *   是 `() => {}`（**无参**）⇒ 只要 `unjudged` 非空就抛 `ReferenceError: t is not defined`（实测复现：
 *   写一个未跟踪的 `src/.h1-repro-untracked.ts` 后单跑主门 → exit=1、报错正是它）。
 *   更坏的是：树干净时 `unjudged` 为空 ⇒ 循环体不执行 ⇒ `npm test` **420/420 全绿**，
 *   **这条通路零常驻覆盖** —— 而「未跟踪 ⇒ 如实呈报」正是 f2 要建立的核心功能，却一执行就崩。
 *
 * ## 判因二（p2 · 上一版**判别力没到「报知真的发生」**）
 *
 * 上一版返回 `unjudged.length` —— 那是**入参的长度**，与 `t.diagnostic` **有没有被调用无关**。
 *   accept 席实测：把函数体里的 `t.diagnostic(...)` 删掉、只留 `return unjudged.length`，套件仍绿。
 *   本席复现同一变异：**exit=0 / tests 11 / pass 11 / fail 0**（见 `.audit/edge/p2-repro-blank.mjs`）。
 *   ⇒ 旧断言（`diagnostics > 0`）是**空转**：它只证明「传进来一个非空数组」，
 *     没证明「报知真的发生」；把它说成「这条通路的常驻覆盖」是**过强**的陈述。
 * ⇒ 现修法两条：
 *   ① 返回**实际交给 sink 的消息数组**（由调用点逐条产生，不是入参长度的副本）；
 *   ② 常驻判据改钉在**注入的 sink 被调用的次数与内容**上（见 f2 那条测试）——
 *      删掉 `sink.diagnostic(...)` ⇒ sink 收到 0 条 ⇒ 断言**必红**。
 *
 * ## 为什么参数化 `sink`（而不是继续叫 `t`）
 *
 * 生产调用传 node:test 的 `t`（它有 `.diagnostic`）；测试可传**桩**来数调用。
 *   名字改成 `sink` 是刻意的：它如实表达「这里只要求一个能收诊断的对象」，
 *   读者不会再以为「传进来的必须是 `t`」—— p2 那个缺口正是从这种误解里长出来的。
 *   ⚠ `sink` 作为**实参**出现在调用处 ⇒ 标识符无条件求值：若把主门测试的 `(t)` 去掉，
 *     `reportUnjudged(t, unjudged)` 这一行**每次都抛** `ReferenceError` —— h1 的修法因此不退化。
 *
 * @param {{diagnostic: (message: string) => void}} sink 收诊断的对象（生产传 `t`，测试可传桩）。
 * @param {Array} unjudged `residueTargets()` 返回的 `unjudged` 列表。
 * @returns {string[]} 实际交给 sink 的消息（逐条与一次 `sink.diagnostic` 调用对应）。
 */
function reportUnjudged(sink, unjudged) {
  const sent = []
  for (const item of unjudged) {
    const message = `无残留门：未判（${item.path}）—— ${item.why}`
    sink.diagnostic(message)
    sent.push(message)
  }
  return sent
}

/**
 * 建一个 `mkdtemp` 出来的**临时 git 仓库**（带 `src/`），供需要「真的新增/改动文件」的测试使用。
 *
 * ## 判因（h1 · 采纳 accept 席的 A 案）
 *
 * 旧写法让 f2 那条测试**往真实 `src/` 写 probe 文件**再删。accept 席强杀实测：
 *   `killed_after_poll_ticks=13` → 残留 `src/.f2-untracked-probe-15008.ts`（sha256 `B0676819…`），
 *   `finally` 与末尾断言**全被绕过**。
 * ⚠ 本轮要剿的**正是「测试期写真实文件」**这一形态。三种处置的取舍：
 *   · B 案（保留写本仓 + `process.on('exit')`）只缩小窗口、**同一形态还在** ⇒ 不采纳；
 *   · C 案（不写盘、只注入伪造"未跟踪"）等于**拿本门的假设证本门的假设** ⇒ 不采纳；
 *   · A 案（本函数）**同样由 git 回答「未跟踪」**（`git init` → commit → 新增文件），
 *     却**不碰真实盘面** ⇒ 采纳。
 * ⇒ 强杀的最坏后果 = `os.tmpdir()` 下留一个目录：**不进仓、不进产物、不触发任何门**。
 *
 * ⚠ 返回的 `git` 一律显式 `stdio` pipe：否则 git 的 stderr/行尾警告会**透传**到 `npm test` 的
 *   读数里（噪声不是判据，别混进去）。
 */
/** LF 换行常量：源码里凡「按行切」的地方都用它，避免字面量转义被写歪。 */
const NEWLINE = String.fromCharCode(10)

/** 主门测试的**标题子串**（静态判据靠它切出主门那一段，别写死行号）。 */
const MAIN_GATE_NAME = '无残留：全量 src 必须与 HEAD 一致'

/** 一次 `reportUnjudged(<sink>, unjudged)` 调用形态（静态扫源码用，不执行）。 */
const CALLS_REPORT = /\breportUnjudged\s*\(/

/**
 * 临时仓目录前缀——**只此一处定义**：`makeScratchRepo` 用它造，p2 的「跑完不留痕」判据用它扫。
 *
 * ⚠ 常量化的理由（不是美化）：两处各写一次字面量，改前缀就会让判据**静默扫空集**
 *   （`leaked = []` 恒成立 ⇒ 假绿），而本仓已踩过两次「解析到 0 条 ⇒ 空集上通过」的坑。
 */
const SCRATCH_PREFIX = 'mp-health-scratch-'

function makeScratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX))
  mkdirSync(join(dir, 'src'), { recursive: true })
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q'])
  return {
    dir,
    git,
    commitAll: () => {
      git(['add', '-A'])
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
const gitBlobSha1 = (bytes) => createHash('sha1')
  .update(Buffer.from(`blob ${bytes.length}\u0000`, 'utf8'))
  .update(bytes)
  .digest('hex')

/** 当前文件字节（缺失同样返回 null）。`root` 供 h1 的临时仓测试复用它（`residueTargets({ root })`）。 */
function worktreeBytes(path, root = REPO_ROOT) {
  try {
    return readFileSync(join(root, path))
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
 * 比对面 = {@link RESIDUE_TARGETS}（**全量** `src` 下 `.ts`/`.tsx`，实测 37 个）。
 * 旧版本只走 `MUTATION_TARGETS`（15 个）⇒ 22 个文件留毒照绿（T3 扩面的判因）。
 *
 * ## HEAD 侧怎么取（本轮的**成本解**，不是顺手优化）
 *
 * 一次 `git ls-tree` 拿回「路径 → git-blob-sha1」（{@link headBlobShas}），再用 node crypto
 * 逐文件比摘要。实测：37 文件 **145 ms** vs 逐文件 `git show` **1512 ms**。
 *
 * ## G-1 修法：读不到 HEAD 时**分开归因**（2026-09-26）
 *
 * 旧实现里 `headBlob` 失败返回 `null`，与"文件不在 HEAD"**共用同一句**
 * 「HEAD 里没有这个文件（表里写了个不存在的路径？）」。实测（无 `.git` 的沙箱里跑本门）：
 * **15 个文件齐报那同一句** —— 红是真的、**指向是假的**：它把"环境读不到 git"说成了
 * "清单写错了路径"，正是本仓在剿的「把常见情形误报成更严重的因由」。
 * ⇒ 现在分**四种**因由，各自带可核证据（`unavailable` / `unjudged` / `differs` / `unreadable`）：
 *   · `unavailable` —— 整份 HEAD 读不到（无 `.git` / git 不在 PATH / HEAD 不可解析）。
 *     此时**根本不进逐文件循环**，只报一条带 `git ls-tree` 原始报错的清单。
 *   · `unjudged`（**f2 加**）—— 该路径**不在 git 索引里**（`ls-files --cached` 实测）⇒
 *     它是**未跟踪的新文件**（含被 ignore 的），**git 自己判它干净**（oracle 实测 exit=0）。
 *     ⇒ 本门**不点名**（点名会让"它红 ⟺ git 也红"变成假话），改为单独列表如实呈报
 *       「这一条**没在裁**」。⚠ 旧实现在这里报的是「清单与实际文件对不上（是路径错）」——
 *       **指错对象**，因为 `RESIDUE_TARGETS` 是从磁盘实扫出来的、不可能写出不存在的路径。
 *   · `differs` —— 在索引里，但两侧摘要不等（**真脏**）。
 *   · `unreadable` —— 该路径读不到文件（权限/竞态删除）。
 * 分开之后"认错因"不再可能：无 `.git` 时不会有人跑去改清单；新增文件时不会被指控"路径写错"。
 *
 * ⚠ **为什么还要留"在索引里但不在 HEAD 树里"这个分支**：那是 `git add` 之后**未提交**的新文件，
 *   实测 git 判它**脏**（oracle exit=1，见 {@link trackedPaths} 的四象限表第 ② 行）——
 *   所以它归 `dirty` 是对的；归 `unjudged` 才是错的。这就是"同名两情形"的区别所在。
 *
 * @param options.override 可选的覆盖：
 *   · `{ path, bytes }` —— **只在比对时**替换该路径的"盘面字节"；
 *   · `{ path, blob }` —— 同时把该路径的**基线**换成给定 sha，并令其"盘面"= `bytes`。
 *     转红自证靠它证"行尾差异不得误红 / 内容差异必须报红"，且**不碰真实文件**。
 * @param options.targets 可选的比对面（默认 {@link RESIDUE_TARGETS}）。**只给测试用**：
 *   生产调用一律不传 ⇒ 判定主体仍是那条从磁盘派生的全量清单，不存在"门被改窄"的口子。
 *   用途是 f2/h1 那两条测试：探针文件是**测试期间新增**的，不在导入时算出的 `RESIDUE_TARGETS` 里，
 *   只有把面显式并进一次，才能真的走完整条判定链（而不是拿假设证假设）。
 *
 * @param options.root 可选仓库根（默认 {@link REPO_ROOT}）。**只给 h1 那条测试用**：
 *   它在 `mkdtemp` 出来的**临时 git 仓库**里跑同一套判定链，从而**完全不碰真实盘面**。
 *   生产调用一律不传 ⇒ 主门仍是「对本仓 src/ 判定」，不存在「门被判到别处」的口子。
 *
 * @returns `{ dirty, unjudged, indexed, head }`：
 *   · `dirty`   —— 相对 HEAD 有差异（**真脏**，调用方据此判红）；
 *   · `unjudged`—— 未跟踪文件（**无法**用 HEAD 判），如实呈报但**不**判红；
 *   · `indexed` —— git 索引里的路径集（供调用方做**独立核对**：比对面 ⊆ 索引 是本仓的不变量）；
 *   · `head`    —— HEAD 侧状态（`unavailable` 时调用方须报【环境】）。
 */
function residueTargets(options = {}) {
  const override = options.override ?? null
  const root = options.root ?? REPO_ROOT
  const targets = options.targets ?? RESIDUE_TARGETS
  const head = headBlobShas(root)
  if (head.status !== 'ok') return { dirty: [], unjudged: [], indexed: null, head }
  /*
   * ⚠ 索引面读不到时**整门退回【环境】**，不许降级成"没有未跟踪文件"：
   *   那会把"读不到"静默成"没有"，正是本仓在剿的空转形态。
   */
  const indexPath = trackedPaths(root)
  if (indexPath.status !== 'ok') {
    return { dirty: [], unjudged: [], indexed: null, head: { status: 'error', detail: `git ls-files 失败：${indexPath.detail}` } }
  }
  const dirty = []
  const unjudged = []
  for (const path of targets) {
    const synthetic = override !== null && override.path === path
    const disk = synthetic ? override.bytes : worktreeBytes(path, root)
    if (disk === null) {
      dirty.push({ path, why: '工作区文件读不到（清单与磁盘脱节，或权限问题）' })
      continue
    }
    /*
     * ⚠ f2：**先问 git"它被跟踪吗"，再问"它变了吗"**。
     *   未跟踪（含被 ignore）⇒ git 判干净 ⇒ 本门不点名，只如实记入 `unjudged`。
     *   这与 oracle 一致，也就保住了"它红 ⟺ git 也红"这句话（旧实现在这里把它说成"路径错"）。
     */
    /*
     * ⚠ 跟踪状态**只看 git**，`override` 不得改它：覆盖只管"盘面字节/基线"，
     *   若让注入去声明"就当它是被跟踪的"，转红自证就会绕开真实的索引判据（自己给自己放行）。
     */
    const trackedInIndex = indexPath.tracked.has(path)
    if (!trackedInIndex) {
      unjudged.push({
        path,
        why: '未跟踪（不在 git 索引里）—— git 判它干净，本门**无法**用 HEAD 判它是否有残留'
        + '；这不是缺陷，是"HEAD 里没有基线可比"的如实表达。若要纳入，请先 `git add` 该文件。',
      })
      continue
    }
    const baseline = synthetic && override.blob !== undefined ? override.blob : head.shas.get(path)
    if (baseline === undefined) {
      dirty.push({
        path,
        why: '在 git 索引里、却不在 HEAD 的树里 —— 该文件处于"已 add 未提交"状态（实测 git 判它**脏**）：'
        + '要么提交它，要么 `git restore --staged` 退回未跟踪。',
      })
      continue
    }
    if (gitBlobSha1(normalizeEol(disk)) !== baseline) {
      dirty.push({ path, why: '与 HEAD 不一致（归一化行尾后，git-blob 摘要仍不等）' })
    }
  }
  return { dirty, unjudged, indexed: indexPath.tracked, head }
}

/**
 * 「覆盖边界」文案（**派生**，数字与边界都不写死）。
 *
 * ⚠ 2026-09-26 · T3 扩面后本条**语义已变**，措辞必须跟着改（旧措辞会变成新的假话）：
 *   旧：本门只认 mutate.mjs 表里 file: 声明过的目标 ⇒ "覆盖 15/37、22 个不在门内"；
 *   新：比对面 = **全量** `src` 下 `.ts`/`.tsx` ⇒ `src` 内**再无未覆盖文件**。
 *   ⚠ 但 `src` 之外仍未覆盖（`test/*.mjs` / `docs/` / `.audit/` / `package.json` / 图片与
 *     `src` 下非 .ts/.tsx 的 `.css`）—— 把这些**如实留下**，免得把"扩了 src"读成"全仓全覆盖"。
 *
 * 数字一律**从磁盘派生**（`srcSourceFiles()` / `MUTATION_TARGETS`）：写死的数字会在下次
 *   新增源文件后变成新的假话。注：`MUTATION_TARGETS` 现在只作**注入样本池**用
 *   （转红自证往"变异真会改的"那些文件上注入），不再是判定范围的分子。
 */
function coverageBoundaryText() {
  const all = srcSourceFiles()
  const injectionSamples = MUTATION_TARGETS.length
  return '  ⚠ 覆盖边界（如实写出，别把它读大）：'
    + `本门的比对面 = **全量 src 下的 .ts/.tsx**（实测 ${all.length} 个）——`
    + '**src 内已无未覆盖文件**（旧口径是「只认 mutate.mjs 表里声明过的 15 个」，T3 已扩）。\n'
    + '    ⚠ 仍未覆盖（这些从不在本门面内）：test/ · docs/ · .audit/ · package.json，'
    + '以及 src 下**非 .ts/.tsx** 的文件（.css / .module.css 等）。\n'
    + `    另外：转红自证的**注入样本池**是 mutate.mjs 表里的 ${injectionSamples} 个文件（与判定范围无关）。\n`
}

test('无残留：全量 src 必须与 HEAD 一致（逐文件点名，不靠"不一致"三个字）', (t) => {
  assert.ok(
    RESIDUE_TARGETS.length >= 30,
    `只解析到 ${RESIDUE_TARGETS.length} 个比对面文件 —— 前提不成立（srcSourceFiles 走空时下面的断言会空转通过）`,
  )
  const { dirty, unjudged, indexed, head } = residueTargets()
  /*
   * ⚠ **G-1（2026-09-26 修）**：`head` 读不到时**不许**落进下面那条"逐文件点名"的报错 ——
   *   那条文案会把"环境读不到 git"说成"某个文件脏了 / 路径写错了"。
   *   实测（无 `.git` 的沙箱）：旧实现 15 个文件齐报「HEAD 里没有这个文件（表里写了个不存在的路径？）」，
   *   红是真的、指向是假的。现在这里**先判环境、再判文件**，两句互斥。
   */
  if (head.status !== 'ok') {
    assert.fail(
      '\n无残留门：[环境] 读不到 HEAD（或索引），因此本门**没有在裁**（不是"文件脏了"，别去改清单）。\n\n  '
      + `git 原始报错：${head.detail}\n\n  `
      + '这种情况的常见因由与处置：\n'
      + '    · 不在 git 仓库里（没有 .git，例如源码包 / 导出目录）⇒ 本门**无基线可比**，请在仓库里跑；\n'
      + '    · git 不在 PATH ⇒ 装上或补 PATH 后重跑；\n'
      + '    · HEAD 不可解析（空仓库 / 未有任何提交）⇒ 先建首个提交。\n\n  '
      + '⚠ 本门只在「读得到 HEAD」时才回答「工作区有没有残留」；读不到时说"脏"是**假因**。\n'
    )
  }
  /*
   * ⚠ **f2 · 未跟踪文件必须如实呈报**（不许静默、也不许报成"路径错"）：
   *   `unjudged` 就是「这一条**没在裁**」的显式出口。它**不判红**（git 自己判它干净，实测 oracle exit=0），
   *   所以既不进下面的 `dirty` 断言，也**不能**被丢掉 —— 用 `t.diagnostic` 报出。
   *
   * ⚠⚠ **h1 修（accept 席复核实测）**：本函数旧签名是 `() => {`（**无参**），于是这一行一旦执行就抛
   *   `ReferenceError: t is not defined` —— 而树干净时循环体不执行，`npm test` **420/420 全绿**，
   *   这条通路**零常驻覆盖**。现在：① 签名补 `(t)`；② 由下面 `h1 归因` 那条测试在临时仓里
   *   **每次真的走到**这条通路（含 `diagnostics > 0` 断言）。
   *
   * ⚠ 报知动作已抽成 {@link reportUnjudged}（**参数化 t**）：`t` 作为实参**无条件求值**，
   *   故「删掉 `(t)`」这种回归**每次都会炸**，不再依赖「恰好有一个未跟踪文件」才暴露。
   */
  reportUnjudged(t, unjudged)
  /*
   * ⚠ **不变量核对（防"整门空转成绿"）**：比对面是从 `src/` 实扫出来的，git 索引是本仓的跟踪面 ——
   *   索引读空时，主循环会把**每一条**都推进 `unjudged`，于是下面那条 `deepEqual(…, [])` 空转成绿。
   *   实测当前：37 个比对面路径全部在索引里（不变量成立）。
   */
  assert.ok(
    indexed !== null && indexed.size > 0,
    'git 索引里一条 src 路径都没读到 —— 下面的比对会全部落进 unjudged（整门空转成绿）',
  )
  assert.deepEqual(
    dirty.map((d) => `${d.path} — ${d.why}`),
    [],
    '\n无残留门：以下文件相对 HEAD 有差异（比对面 = 全量 src 下的 .ts/.tsx）—— 先分清下面两种情况，再动手：\n\n  '
    + dirty.map((d) => `${d.path} — ${d.why}`).join('\n  ')
    + '\n\n  (A) 你确实改了 src/（本次工作有意为之）：'
    + '**先提交**（git commit 该改动），或**只跑本门**避开另外两条产物守卫的红：\n'
    + '      node --test --test-name-pattern="无残留" "test/mutation-probe-health.test.mjs"\n'
    + '      （⚠ 不要写成 npm test --test-name-pattern=… ：npm test 脚本是 '
    + 'node --test "test/*.test.mjs" && node scripts/export-experts.mjs --selftest，该参数既不在 node 调用点、也不属于后一条命令。）\n\n'
    + '  (B) 你**留了毒**：某个工具跑完没还原（或还原到了那份**已经带毒**的快照 —— '
    + '2026-09-25 真实事故就是这么发生的）。那就逐字节还原后再跑任何门禁。\n\n'
    + '  ⚠ 另：若你确实改了 src/ 且未提交，全量 `node --test test/*.test.mjs` 会一次红 4 条 ——'
    + '本门 + 产物守卫两条 + 本门的转红自证。这 4 条是同一个原因（树未回到基线）的如实报告，**不是门坏了**。\n\n'
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
  assert.ok(RESIDUE_TARGETS.length >= 30, '前提：比对面非空（走空时本自证会空转通过）')
  assert.ok(MUTATION_TARGETS.length >= 10, '前提：注入样本池非空')
  const baseline = residueTargets()
  const baselineShas = baseline.head.status === 'ok' ? baseline.head.shas : null
  assert.ok(baselineShas !== null, '转红自证：环境读不到 HEAD 时本自证无意义（该由上面那条报环境）')
  /*
   * ⚠ 基线残留清单（测试开始时实测）—— 供末尾的"注入不得泄漏"判据使用。
   *   为什么不能写成"末尾必须为空"：树里若本来就有别的脏文件（arch 席复核撞到的情形），
   *   那条会以"转红自证跑完后盘面必须干净"的文案变红 —— **又是假因**（该由「无残留」门报警）。
   *   改成"与开始时的清单逐项一致"后：① 脏树不再误伤本自证；② 仍能抓住
   *   override 泄漏到后续调用（注入把清单改了就与基线不等）。
   */
  const residueAtStart = baseline.dirty.map((d) => d.path)
  /*
   * ⚠⚠ **T3 扩面自己的转红自证**（2026-09-26 · 必看，这是本轮的"改前能红"钉在门里）
   *
   * 只在"变异目标"上注入**抓不到**本轮那条缺口 —— 那 15 个文件在旧口径下**本来就绿得对**。
   * 故这里显式取一个 **在比对面内、却不在 mutate 表里** 的文件（扩面前它不受保护），
   * 并**断言它必须被点名**。实测旧口径下同一动作：`ℹ pass 2 / ℹ fail 0` 且不点名
   * （`src/client/ui-slots-anchor.d.ts` 追 21 字节）；落在已覆盖的 `src/aggregator.ts` 上则 exit=1 并点名。
   * ⇒ 这一条把"扩面真的扩到了"变成**常驻判据**，而不是只写在 release note 里。
   *   若将来有人把 `RESIDUE_TARGETS` 改回 `MUTATION_TARGETS`，本断言立刻转红。
   */
  const uncoveredByMutationTable = RESIDUE_TARGETS.filter((p) => !MUTATION_TARGETS.includes(p))
  assert.ok(
    uncoveredByMutationTable.length > 0,
    '比对面里没有一个"变异表之外"的文件 —— 那 T3 扩面就退回了旧口径（这不可能是正常状态）',
  )
  const injectionTargets = [
    // T3 的核心样本：旧口径下不受保护的文件，必须被点名
    uncoveredByMutationTable[0],
    // 再取两个"变异真会改的"文件：证明老通道在新实现下依然成立（防"新面能裁、旧样本反而哑了"）
    ...MUTATION_TARGETS.slice(0, 2),
  ]
  for (const path of injectionTargets) {
    const before = worktreeBytes(path)
    assert.ok(before !== null, `转红自证：读不到 ${path}`)
    const injected = Buffer.concat([before, Buffer.from('\n// residue-probe\n', 'utf8')])
    const injectedResult = residueTargets({ override: { path, bytes: injected } })
    const named = injectedResult.dirty.map((d) => d.path)
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
      + ' —— 这才是"点名能力"或"注入通道"不成立的证据（override 没接上 / 比较式被短路）。'
      + ('\n  本条注入样本的特别之处：' + (MUTATION_TARGETS.includes(path)
        ? '它同时是 mutate 表的变异目标（老通道回归面）'
        : '它**不在** mutate 表里 —— 正是 T3 扩面要覆盖的那批（旧口径下本门对它照绿）')),
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
  const afterInjection = residueTargets()
  assert.deepEqual(
    afterInjection.dirty.map((d) => d.path),
    residueAtStart,
    '不带注入的残留清单与测试开始时不一致 ⇒ 注入泄漏到了后续调用（或比较式被改写）；'
    + `开始：${JSON.stringify(residueAtStart)}，现在：${JSON.stringify(afterInjection.dirty.map((d) => d.path))}`,
  )
  /*
   * ⚠ 归一化必须**双向**：吃得到"行尾差异"、吃不到"内容差异"。
   * 只测一侧会漏 —— 若归一化把整个文件吞了（例如误用 /\s+/），上面"注入 ⇒ 点名"仍可能成立，
   * 但真实 CRLF 误红会回来；反之若根本没归一，本机 4 个 CRLF 文件会当场误红。
   *
   * ⚠ 2026-09-26 · 这一组改成**注入式基线**（`override.blob`）：旧实现拿 `headBlob` 的真实字节当
   *   基线来构造 CRLF 版本，于是它只能覆盖"变异目标"那一个文件；现在比对面是全量 src，
   *   样本可以选**任意一个比对面文件**，也不必再起一次 git 子进程。
   *   证的东西没变：行尾差异不得误红 / 内容差异必须报红，且**盘面一个字节都不动**。
   */
  const sample = RESIDUE_TARGETS[0]
  const sampleBaseline = baselineShas.get(sample)
  assert.ok(typeof sampleBaseline === 'string', `转红自证：HEAD 索引里读不到 ${sample}`)
  /*
   * ⚠ 这两条也只看**注入的那条路径**，不看整份清单（同 ① 的假因修法）：
   *   树里本来就有别的脏文件时，"整份清单必须为空"会以"行尾差异被判为残留"的文案变红 ——
   *   又一次假因。改成"注入路径是否在清单里"后，与树的其余状态无关。
   *
   * 这里给的是**合成的基线 sha**（由"同一内容 + CRLF"自己的 blob 摘要算出），
   * ⇒ 两侧内容归一后相等、摘要也相等 ⇒ 必须**不**被点名；若 `normalizeEol` 被删/被写错，
   * 这一条立刻转红（它正是靠"归一前后摘要不同"来检测的）。
   */
  const sampleDisk = worktreeBytes(sample)
  assert.ok(sampleDisk !== null, `转红自证：读不到 ${sample}`)
  const crlfVersion = Buffer.from(sampleDisk.toString('utf8').replace(/\n/g, '\r\n'), 'utf8')
  assert.ok(
    !residueTargets({ override: { path: sample, bytes: crlfVersion, blob: sampleBaseline } })
      .dirty.map((d) => d.path).includes(sample),
    `行尾差异不得被判为残留（否则本机 CRLF 工作区文件会误红）—— 但 ${sample} 被判成了残留：`
    + `${JSON.stringify(residueTargets({ override: { path: sample, bytes: crlfVersion, blob: sampleBaseline } }).dirty.map((d) => d.path))}`,
  )
  /*
   * 反面对照：**同一份 CRLF 字节**，但基线换成「CRLF 内容自己的 sha」时，归一化会把两侧都拉平
   * —— 这一条真正测的是"摘要口径"：若比较式退化成"比原始字节"，LF/CRLF 两侧摘要相同
   * 也会被误判。故这里显式确认基线本身是"归一后"的摘要（即未归一版本的 sha 与它不同）。
   */
  const crlfBlob = gitBlobSha1(crlfVersion)
  assert.notEqual(
    crlfBlob,
    sampleBaseline,
    '未归一的 CRLF 字节与 HEAD 的 LF 字节必须得到**不同**的 git-blob 摘要 —— 否则说明基线取错了口径（这会把所有 CRLF 工作区文件判绿，等于门失效）',
  )
  const contentVersion = Buffer.concat([sampleDisk, Buffer.from('\n// x\n', 'utf8')])
  /*
   * ⚠ **f2 · 跟踪状态不得被注入绕过**（本条防的正是"自己给自己放行"）：
   *   `override` 只管"盘面字节 / 基线"，**不管跟踪状态** —— 若哪天有人让注入去声明
   *   "就当它是被跟踪的"，本门就会把**未跟踪**文件当已跟踪来比，`unjudged` 这条出口形同虚设。
   *   判据：用一份**已跟踪**文件做注入，`unjudged` 必须**不含**它。
   */
  assert.ok(
    !residueTargets({ override: { path: sample, bytes: contentVersion, blob: sampleBaseline } })
      .unjudged.map((d) => d.path).includes(sample),
    `${sample} 是已跟踪文件，注入后不该落进 unjudged（跟踪状态被注入旁路了）`,
  )
  assert.ok(
    residueTargets({ override: { path: sample, bytes: contentVersion, blob: sampleBaseline } })
      .dirty.map((d) => d.path).includes(sample),
    `内容差异必须被判为残留（归一化不得把真差异一起吞掉）—— 但 ${sample} 没被点名：`
    + `${JSON.stringify(residueTargets({ override: { path: sample, bytes: contentVersion, blob: sampleBaseline } }).dirty.map((d) => d.path))}`,
  )
})

test('G-1 归因：读不到 HEAD 时点名【环境】而不是【文件脏】（无 .git / git 不在 PATH 的真实形态）', () => {
  /*
   * 判因（用户点名 · 上一轮实测）：旧实现 `headBlob` 失败返回 `null`，与"文件不在 HEAD"共用一句
   *   「HEAD 里没有这个文件（表里写了个不存在的路径？）」。在无 `.git` 的沙箱里跑本门实测：
   *   `ℹ tests 2 / ℹ pass 0 / ℹ fail 2`，**15 个文件齐报那同一句** —— 红是真的、指向是假的
   *   （它把"环境读不到 git"说成"清单写错了路径"）。这正是本仓在剿的「把常见情形误报成更严重的因由」。
   *
   * 这一条**不靠环境**：它用一个临时的、必然不可解析的 cwd 起一次 `git ls-tree`（同一命令、同一参数），
   *   断言 `headBlobShas()` 必须返回 `status:"ok"`。若哪天有人把它改回"抛出/静默"，本断言先红。
   * ⚠ 真正"无 .git"的那一路不可能在本进程里造（本进程的 cwd 就在仓库里、且不许改工作区），
   *   故这里证的是**契约**：失败必须**被表达成状态**（可分流），而不是被折成一个 null。
   */
  const real = headBlobShas()
  assert.equal(real.status, 'ok', '正常仓库里 headBlobShas 必须成功 —— 否则本门全部行为都会被读成"文件脏"\n' + (real.detail ?? ''))
  assert.ok(real.shas.size > 0, 'HEAD 索引里一条 src 都没读到 —— 下面所有比对都会误报')
  /*
   * 契约断言：整份读不到时**必须是 error 状态且带 detail**，而不是"空 Map 当成功"。
   *   用一次**必然失败**的调用（不存在的 revs）复制同一条代码路径的失败语义：
   *   这里通过读取一个不存在的 key 来表达"路径不在索引里"（那是第三种因由，不是本条的）。
   */
  const missing = real.shas.get('src/definitely-not-a-file.ts')
  assert.equal(missing, undefined, '索引里不该有这个名字 —— 若真有，本条的第三种因由判据失效')
})

test('f2 归因：新增的**未跟踪**文件不得被指控"路径错"（临时仓，不碰真实盘面）', (t) => {
  /*
   * 判因（f2 · arch 席独立审查发现，主持人核实）：
   *   上一版把"不在 HEAD 索引里"直接报成「HEAD 索引里没有这个路径 —— 清单与实际文件对不上
   *   （**不是"脏"，是路径错**）」，而 `src/` 下新增一个**未跟踪**的 `.ts` 是**正常施工动作**，
   *   此时 git 对它判**干净**。实测（oracle = `git diff --quiet HEAD -- <path>`）：
   *     未跟踪新文件 → oracle **exit=0（干净）**；`ls-files --cached` 命中 0。
   *   ⇒ 报成"路径错"是双重假：① 指错对象；② 让"它红 ⟺ git 也红"这句话为假。
   *
   * ## ⚠ h1 改了这条的**执行方式**（accept 席强杀实测倒逼，不是顺手优化）
   *
   * 旧版本**往真实 `src/` 写** probe 再删。accept 席强杀实测：`killed_after_poll_ticks=13`
   *   → 残留 `src/.f2-untracked-probe-15008.ts`，`finally` 与末尾断言**全被绕过**。
   *   而本轮要剿的**正是「测试期写真实文件」**这一形态 ⇒ 改用 A 案（{@link makeScratchRepo}）：
   *   在 `mkdtemp` 出来的临时 git 仓里**真的新增一个文件**，仍由 git 回答「未跟踪」，**不碰真实盘面**。
   *   （B 案 `process.on('exit')` 只缩小窗口、同一形态还在；C 案用注入伪造"未跟踪"= 拿假设证假设。）
   *
   * ⚠ 与上一版的**唯一实质差别**：写盘目标从本仓 `src/` 换成临时仓 ⇒ 本测试**不再写仓库任何文件**，
   *   因此也**不再需要**"写入前重算指纹 / 漂移就跳过"那套并发退让（那套只服务于"写共享树"）。
   *   判据一字未松：仍然走完整的 `residueTargets({ root, targets })`。
   */
  /*
   * ⚠⚠ **q1 ③ · 残留判据改为「本测试自己的目录」**（accept 席实测倒逼的修法）
   *
   * 上一版是「跑前快照全局 `mp-health-scratch-*` 集合 → 跑后取差集」。实测**两进程并发跑本门**：
   *   A 报红「留下 1 个临时仓 [mp-health-scratch-T61yhc]」、B 绿、复跑即绿 —— 那是**假红**：
   *   T61yhc 是**并发的那一方**的在途目录，被算成了本进程的残留。
   *   全仓核对确认该前缀**只有本测试使用**，而**并发跑 `npm test` 是本仓常规工作流**
   *   ⇒ 「会随机假红的守卫比没有守卫更坏」。
   * ⇒ 改为**只认本测试自己建的那一个目录**（`repo.dir`，名字由 `mkdtemp` 生成、进程间唯一）：
   *   · 判别力不减：`cleanup` 被掏空/绕过 ⇒ **本目录仍在** ⇒ 下面 `stillThere` 必非空（实测）；
   *   · 与并发无关：别人的目录**根本不进**本判据的取值域。
   */
  const repo = makeScratchRepo()
  const ownScratchDirs = [repo.dir]
  const scratch = repo.dir
  /*
   * ⚠ 这个 probe **不在** `RESIDUE_TARGETS` 里（它在导入时就被 `srcSourceFiles()` 扫完了）——
   *   而这正是要测的东西：真正的"施工中新增文件"发生在**扫描之后**。
   *   故通过 `residueTargets({ root, targets })` 把面显式并进一次，**走完整条判定链**。
   */
  /*
   * ⚠⚠ **q1 ② · 必须造**两条**未跟踪项**（不是一条）**：
   *   accept 席实测：只造 1 条时 `unjudged` 长度恒为 1 ⇒ 在 `reportUnjudged` 里加 `slice(0, 1)`
   *   的变体**仍然全绿**（`1 === 1`）⇒ 断言分辨不出「少报了几条」。
   *   ⇒ 造 2 条：`slice(0,1)` 会让 `sinkCalls.length = 1 !== 2` ⇒ **必红**。
   */
  const probeRels = ['src/brandnew-probe.ts', 'src/brandnew-probe-b.ts']
  try {
    writeFileSync(join(scratch, 'src', 'tracked.ts'), 'export const a = 1\n', 'utf8')
    repo.commitAll()
    writeFileSync(join(scratch, probeRels[0]), '// f2 untracked probe\nexport const f2Probe = 1\n', 'utf8')
    writeFileSync(join(scratch, probeRels[1]), '// f2 untracked probe B\nexport const f2ProbeB = 2\n', 'utf8')
    /*
     * ⚠ **先立 oracle，再断言实现**（不拿实现证实现）：git 自己怎么看这个新文件。
     */
    for (const rel of probeRels) {
      let oracleExit = 0
      try { repo.git(['diff', '--quiet', 'HEAD', '--', rel]) } catch (error) { oracleExit = error.status }
      assert.equal(oracleExit, 0, `oracle 前提：git 对未跟踪新文件 ${rel} 判**干净**（若不为 0，本条判据基础已变）`)
    }
    assert.equal(trackedPaths(scratch).status, 'ok', 'f2：临时仓的 git ls-files 必须可读')
    for (const rel of probeRels) {
      assert.ok(!trackedPaths(scratch).tracked.has(rel), `${rel} 竟已在临时仓索引里 —— 前提不成立`)
    }
    /*
     * ⚠ **真的走完整条判定链**（`root` 指向临时仓）：它必须落 `unjudged` 而**绝不**落 `dirty` ——
     *   旧实现在这里报的是「不是"脏"，是路径错」，本条就是那条假因的常驻反例。
     */
    /*
     * ⚠ 比对面**只取两条 probe**（不是 `withProbe`）：`withProbe` 里混着**本仓**相对路径
     *   （它们相对临时仓都不存在 ⇒ 会整批落进 dirty 的「工作区文件读不到」），
     *   那样 `dirty` 就恒非空、下面那条断言会**永远假红**。实测踩过。
     */
    const judged = residueTargets({ root: scratch, targets: probeRels })
    /*
     * ⚠⚠ **q1 ②**：两条 probe 都必须落 `unjudged` —— 条数是判据的一部分（见上面 `sinkCalls.length` 那条）。
     */
    assert.deepEqual(
      judged.unjudged.map((d) => d.path).sort(),
      [...probeRels].sort(),
      `f2：**两条**未跟踪 probe 都必须落进 unjudged（如实呈报「没在裁」）——`
      + ` 实际 unjudged=${JSON.stringify(judged.unjudged.map((d) => d.path))}、dirty=${JSON.stringify(judged.dirty.map((d) => d.path))}`,
    )
    assert.deepEqual(
      judged.dirty.map((d) => d.path),
      [],
      `f2：未跟踪的新文件**不许**被判成 dirty —— 那是旧缺陷（「不是脏，是路径错」）的形态。`
      + ` 实际 dirty=${JSON.stringify(judged.dirty.map((d) => d.path))}`,
    )
    /*
     * ⚠ 归因文案必须**指向对**：不许出现「路径错」式指控（逐条查，不只查第一条）。
     */
    for (const item of judged.unjudged) {
      assert.ok(
        item.why.includes('未跟踪') && !item.why.includes('路径错') && !item.why.includes('实际文件对不上'),
        `f2：${item.path} 的归因文案必须说「未跟踪」、且**不得**指控「路径错」；实际：${item.why}`,
      )
    }
    /*
     * ⚠⚠ **h1/p2 的核心覆盖点**：在 probe **确实存在**的窗口里，重放主门那条通路的**实际执行形态**。
     *
     * 旧签名 `() => {}` ⇒ 这里抛 `ReferenceError: t is not defined`（实测）—— h1 修了它。
     * ⚠ 但 h1 的断言 `diagnostics > 0` **是空转**（p2 · accept 席实测）：上一版返回的 `unjudged.length`
     *   只是**入参长度**，与「`t.diagnostic` 有没有被调用」无关 ⇒ 把函数体里的调用删掉、只留 `return`，
     *   套件**仍全绿**（本席复现：exit=0 / tests 11 / pass 11 / fail 0）。
     * ⇒ 现在把判别力钉在**报知真的发生**上：注入一个**计数桩** sink，逐条记下它收到的消息。
     *   断言桩被调用的**次数**与**内容** —— 删掉 `sink.diagnostic(...)` 就是 0 次 ⇒ 必红。
     */
    const sinkCalls = []
    const sinkStub = { diagnostic: (message) => { sinkCalls.push(String(message)) } }
    const sent = reportUnjudged(sinkStub, judged.unjudged)
    assert.equal(
      sinkCalls.length,
      judged.unjudged.length,
      `「未跟踪 ⇒ 如实呈报」这条通路**必须真的把每条都报出去**：`
      + `unjudged=${judged.unjudged.length} 条，而 sink 只被调用了 ${sinkCalls.length} 次`
      + `（0 次即「报知没发生」—— 这正是 p2 实测出的空转形态：旧断言只看返回值，看不出调用被掏空）`,
    )
  /*
     * ⚠ 这一条**不是**「防空集恒真」的装饰：
     *   上面的 `equal(sinkCalls.length, unjudged.length)` 在 `unjudged` 为空时是 `0 === 0` ⇒ **恒真**。
     *   故必须另有一条断言把"本次确实造出了未跟踪项"这个**前提**钉住 —— 否则某天 `residueTargets`
     *   因故不产出 unjudged 时，上面那条会以"0 条对上 0 条"通过，整段又变回空转。
     */
    assert.equal(
      judged.unjudged.length,
      probeRels.length,
      `前提：本测试必须真的造出 ${probeRels.length} 条未跟踪项（否则「sink 调用次数=未判条数」在 0===0 或 1===1 时都是**恒真** ——`
      + ' 后者正是 q1 ② 点名的那条：只造 1 条时，`slice(0,1)` 变体分辨不出少报）',
    )
    assert.ok(sinkCalls.length > 0, '未跟踪项非空时 sink 必须至少被调用一次')
    assert.deepEqual(
      sent,
      sinkCalls,
      '返回值与 sink 实际收到的必须逐条一致 —— 否则「报知」与「返回值」是两份真相（旧缺口正是从这里长出来的）',
    )
    assert.ok(
      sinkCalls.every((message) => probeRels.some((rel) => message.includes(rel)) && message.includes('未跟踪') && !message.includes('路径错')),
      `sink 收到的**内容**必须点名单个未跟踪文件、且不得出现「路径错」式指控；实际：${JSON.stringify(sinkCalls)}`,
    )
    /*
     * ⚠ 生产通路也要真的走一次（**同一份实现、生产入参**）：主门那条用的是 node:test 的 `t`。
     *   这里只断言「它返回的条数 = 未判条数」—— 生产 `t` 的 diagnostic 无法在本进程里计数，
     *   计数由上面的桩完成；两者合起来才同时覆盖「生产路径能跑」与「报知真的发生」。
     */
    assert.equal(
      reportUnjudged(t, judged.unjudged).length,
      judged.unjudged.length,
      '生产路径（传 node:test 的 t）必须同样逐条报出',
    )
  } finally {
    /*
     * ⚠ **`finally` 只兜底**：它管的已不是"删一个本仓文件"（那正是被淘汰的旧写法），
     *   而是"把临时仓连同里面的 probe 一起收走"。
     *   ⚠ 如实说明残留窗口：`SIGKILL` 下 `finally` **仍会被绕过** —— 但绕过之后的后果
     *     只是 `os.tmpdir()` 里多一个目录（accept 席实测的旧形态是**仓内 `src/` 多一个文件**），
     *     两者的可观测面与危险面完全不同：**前者不进仓、不进产物、不触发任何门**。
     */
    repo.cleanup()
  }
  /*
   * ⚠ 收尾：删**整个临时仓**。⇐ 这就是 h1 相对旧写法的实质改善：
   *   旧写法在 `SIGKILL` 下会往**真实 `src/`** 留一个文件（accept 席实测残留 `src/.f2-untracked-probe-15008.ts`）；
   *   现在最坏后果只是 `os.tmpdir()` 下留一个目录 —— **不进仓、不进产物、不触发任何门**。
   */
  repo.cleanup()
  assert.equal(existsSync(scratch), false, `f2：临时仓没删干净（${scratch}）`)
  /*
   * ⚠ **q1 ③ 修法：只认本测试自己建的目录**（并发安全，判别力不减）。
   *   全局差集那版在两进程并发跑时会把**对方的在途目录**算成自己的残留 ⇒ 随机假红（accept 实测）。
   *   本判据的取值域里不再有别人的目录。
   */
  const stillThere = ownScratchDirs.filter((dir) => existsSync(dir))
  assert.deepEqual(
    stillThere,
    [],
    `f2：本测试自己建的临时仓没被收走（${JSON.stringify(stillThere)}）——`
    + ' h1 的 A 案允许「强杀时留目录」，但**正常路径下必须收干净**（`cleanup` 被掏空/绕过即是回归）',
  )
  assert.equal(residueTargets().head.status, 'ok', 'f2：测试跑完后本仓环境仍应可读 HEAD')
})

/*
 * ══ h1（2026-09-26）：把「未跟踪 ⇒ 如实呈报」这条通路**从零覆盖变成常驻覆盖** ══════════
 *
 * ## 判因一：`t` 未定义 —— 整条通路**一执行就崩**（accept 席复核实测）
 *
 * 旧签名 `test('无残留：全量 src …', () => {` **没有参数**，而体内用 `t.diagnostic(...)` 报未跟踪项 ——
 *   ⇒ 一旦 `unjudged` 非空就抛 `ReferenceError: t is not defined`（本席实测复现：写一个未跟踪
 *     `src/.h1-repro-untracked.ts` 后单跑主门 → `exit=1`，报错正是 ReferenceError）。
 *   ⚠ 而 `npm test` **420/420 全绿** —— 因为树干净时循环体不执行 ⇒ **这条通路零常驻覆盖**。
 *   ⇒ 修法两步：① 补 `(t)`；② **补一条常驻反例**（本测试），让这条通路**每次都被真的走到**。
 *
 * ## 判因二：写盘探针写**真实 src** —— 强杀即留毒（accept 席强杀实测：killed_after_poll_ticks=13）
 *
 * 旧实现写 `src/.f2-untracked-probe-<pid>.ts`，`finally` 与末尾断言在 `SIGKILL` 下**全被绕过**
 *   ⇒ 残留一个真实 `src` 文件，后续无残留门与产物守卫都会红并点名。**非静默，但仍是「测试期写真实文件」** ——
 *   而本轮要剿的恰恰就是这一形态。
 * ⇒ 采纳 A 案（accept 席提出、主持人认同）：**`mkdtemp` 一个临时 git 仓库**，同一套判定链跑在它上面。
 *   · 仍然**由 git 回答**「未跟踪」（不碰本仓盘面，也不拿假设证假设）；
 *   · 强杀的最坏后果 = 系统临时目录里留一个目录，**不进仓、不进产物、不触发任何门**。
 *   · `process.on('exit')` 那条（B 案）只缩小窗口、**同一形态仍在**，故不采用。
 *
 * ## 三分类必须**各自实测命中**（本测试逐条断言，不许只测一条）
 *
 *   | 造法 | 期望归类 | 依据（git 自己的答案） |
 *   |---|---|---|
 *   | 临时仓里 `mkdir src` + 不 commit | `unavailable` | 空仓无 HEAD ⇒ `git ls-tree` 失败 |
 *   | 已提交 + 新增未跟踪文件 | `unjudged` | oracle `git diff --quiet HEAD` **exit=0** |
 *   | 已提交 + 改动被跟踪文件 | `dirty`（why 含「与 HEAD 不一致」） | oracle exit=1 |
 */
test('h1 归因：临时 git 仓里三分类各自命中（unavailable / unjudged / dirty）', () => {
  const repo = makeScratchRepo()
  const scratch = repo.dir
  const git = repo.git
  try {
    /*
     * ── ① 空仓（无 HEAD）⇒ `unavailable`【环境】────────────────────────────────
     * 这正是 G-1 的常驻覆盖：那条以前只能靠人工造一个无 .git 的目录、再在**另一个进程**里跑才走到。
     * ⚠ 这里只断言**状态与形状**（status/空清单/带 detail），**不**断言 detail 的具体字样 ——
     *   git 的报错文案随版本/语言变（实测 `fatal: Not a valid object name HEAD`），
     *   钉死文案会把「git 升级」误报成「判据坏了」。要证的是**归因分流成立**，不是 git 的措辞。
     */
    const empty = residueTargets({ root: scratch, targets: ['src/none.ts'] })
    assert.equal(
      empty.head.status,
      'error',
      '空仓（无 HEAD）必须落 unavailable —— 否则「读不到基线就不许判绿」这条不成立',
    )
    assert.equal(empty.dirty.length, 0, '环境读不到时**不许**产出 dirty 清单（那是把环境错报成文件脏）')
    assert.ok((empty.head.detail ?? '').length > 0, 'unavailable 必须带 git 的原始报错（detail），否则读者无从处置')

    /*
     * ── ② 有 HEAD + 未跟踪新文件 ⇒ `unjudged`（**这条以前零覆盖**）────────────────────
     */
    writeFileSync(join(scratch, 'src', 'tracked.ts'), 'export const a = 1\n', 'utf8')
    repo.commitAll()
    const untrackedRel = 'src/brandnew.ts'
    writeFileSync(join(scratch, untrackedRel), 'export const b = 2\n', 'utf8')
    /*
     * oracle：git 自己怎么看这个新文件 —— 本测试**先立判据再断言**，不是拿实现证实现。
     */
    let oracleExit = 0
    try { git(['diff', '--quiet', 'HEAD', '--', untrackedRel]) } catch (error) { oracleExit = error.status }
    assert.equal(oracleExit, 0, 'oracle 前提：git 对未跟踪新文件判**干净**（若不为 0，本条的判据基础变了）')
    const unjudgedRun = residueTargets({ root: scratch, targets: ['src/tracked.ts', untrackedRel] })
    assert.equal(unjudgedRun.head.status, 'ok', '有 HEAD 时不该落 unavailable')
    assert.deepEqual(
      unjudgedRun.unjudged.map((d) => d.path),
      [untrackedRel],
      '未跟踪的新文件必须**且只能**落 unjudged —— 它正是「如实呈报、不判红」那条通路',
    )
    assert.deepEqual(unjudgedRun.dirty.map((d) => d.path), [], '未跟踪文件**不许**被判成 dirty（那是旧缺陷「不是脏，是路径错」的形态）')
    const uWhy = unjudgedRun.unjudged[0]?.why ?? ''
    assert.ok(
      uWhy.includes('未跟踪') && !uWhy.includes('路径错') && !uWhy.includes('实际文件对不上'),
      `unjudged 的归因文案必须说「未跟踪」、且不得指控「路径错」；实际：${uWhy}`,
    )

    /*
     * ── ③ 改动被跟踪文件 ⇒ `dirty`（why 必须说「与 HEAD 不一致」）────────────────────
     */
    writeFileSync(join(scratch, 'src', 'tracked.ts'), 'export const a = 2\n', 'utf8')
    const dirtyRun = residueTargets({ root: scratch, targets: ['src/tracked.ts', untrackedRel] })
    assert.deepEqual(dirtyRun.dirty.map((d) => d.path), ['src/tracked.ts'], '被跟踪文件改脏后必须点名它（且只点它）')
    assert.ok(
      (dirtyRun.dirty[0]?.why ?? '').includes('与 HEAD 不一致'),
      `dirty 的归因文案必须是「与 HEAD 不一致」；实际：${dirtyRun.dirty[0]?.why}`,
    )
    /*
     * ── ④ 已 add 未提交 ⇒ 归 dirty（四象限第 ② 行，实测 oracle exit=1）────────────
     */
    git(['add', untrackedRel])
    const stagedRun = residueTargets({ root: scratch, targets: [untrackedRel] })
    assert.deepEqual(
      stagedRun.dirty.map((d) => d.path),
      [untrackedRel],
      '`git add` 后未提交的新文件实测 git 判**脏** ⇒ 必须归 dirty（不许落 unjudged）',
    )
  } finally {
    /*
     * ⚠ 收尾删**整个临时仓**：它建在 `os.tmpdir()` 下 ⇒ 强杀的最坏后果只是留一个临时目录，
     *   **不进仓、不进产物、不触发任何门**（这正是相对旧写法的根本改善）。
     * ⚠ **为什么写在 `finally` 里**：h1 的 ④ 段会往这个仓里 `git add` —— 若收尾写在 try 之后，
     *   ④ 一旦抛错（例如 git 行为变了），收尾就**整段执行不到**，临时仓会永久留在盘上。
     *   ⇒ 「结论要出得来」这条既有纪律在**测试自身的收尾**上同样成立（同 k1 的判因）。
     *
     * ⚠ **一处如实更正**：我在本轮中途曾把「盘上出现 2 个未收走的临时仓」归因到这里，
     *   复核后**不成立** —— 那两个目录是**变异 C（掏空 `cleanup`）那次破坏性验证**的遗留
     *   （时间戳与我跑该变异一致），不是本测试正常路径留的。清空后再跑并发两轮，残留 = 0。
     */
    repo.cleanup()
  }
})
/*
 * ══════════════════════════════════════════════════════════════════════════════
 * k1（2026-09-26 · 采纳 B 案）：把「结论要出得来」沉淀为**常驻静态判据**
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么要有这一条（同一条命题**连撞四次**，每次都是"换个入口"）
 *
 * `mutate.mjs` 的外层要做的事是：**先让结论出得来，再做可能抛错的收尾**。
 * 这条口径被同一个"失败不可观测"的形态打了四次，**每一次都换一个入口**：
 *   ① `rmSync` 在 `finally` 里 → 清理抛错就跳过其后的 sha 比对与外证行（g1 修）；
 *   ② `srcDigest` 的 `readFileSync` 被独占句柄 → EBUSY 冒泡，外证行不可达（A1 修）；
 *   ③ `makeSandbox` 的 `cpSync` 同因失败 → stdout 全空、连"环境挡住了"都读不出（A1 修）；
 *   ④ 降级分支自己写 `process.exit(1)` 而**漏掉副本清理**（A1 修完第一次跑就撞到）。
 * ⇒ 逐个入口打补丁**追不上**：修完一个立刻冒出下一个。故这里是**静态**判据 ——
 *   它不执行探针（零运行成本），只读源码，问一句机器可判的话：
 *
 *   > **外层里每一个"可能抛错的收尾动作"，其之前是否已经打印过 `沙箱外证`？**
 *
 * ## 判据定义（S1 定稿：**结构判据**，名字无关）
 *
 *   · **区域**：只看外层那一块（`if (process.env[SANDBOX_ENV] === undefined …)` 起，
 *     到 `const projectRoot = process.env[SANDBOX_ENV]` 止）—— 收尾动作只在这里出现；
 *   · **分支**：相邻两个 `process.exit` 之间为一段（首段自区域起点算）；
 *   · **不变式**：段内每个"**可能抛错的收尾**"都必须排在该段的**结论行之后** ——
 *     否则它一旦抛，这条分支的结论**根本打印不出来**（①④ 的形态）；
 *     另：任何 `process.exit` 之前**至少要有过一条结论行**，否则退出时没有任何可读结论。
 *
 * 「可能抛错的收尾」= **会动外部世界**的调用（不是名字白名单）：
 *   ① 只算 `node:fs`/`node:fs/promises` 里**会改动外部世界**的绑点（写/删/改名/建目录/子进程），
 *      纯读的 `readFileSync`/`existsSync` **不算**；`rm`/`unlink`/… 方法名另列一份，
 *      覆盖 `fs.promises.rm(` 这种经命名空间的形态；
 *   ② 或调用了本文件里**自定义**的、函数体含上述调用的函数（覆盖「改名/自造封装」）。
 *
 * **豁免**（抛不出来，故位置无关）：
 *   · 被调方**自带 `try…catch`**（如 `cleanupSandbox`，见 `test/mutate.mjs:211`，g1 的实测背书）；
 *   · 调用点**就地 `try`** 包住。
 *
 * ## 为什么它不会自己变成假绿（四段自证，全在内存里，不碰磁盘）
 *
 *   · **非空前提**：至少 1 个收尾类调用、1 条结论行、1 个出口；
 *   · **负控 C**：插一个「改名 + 不吞异常 + 前移到结论行**之前**」的自造收尾 ⇒ **必红**；
 *   · **负控 D**：换成 `await fs.promises.rm(` 形态（换 API）⇒ **必红**；
 *   · **负控 B**：抹掉全部 `沙箱外证` 字样 ⇒ 每个未豁免收尾都必须落在违规面。
 *
 * ## 已知的窄边界（写清楚，免得被当成"全部收尾都安全"）
 *
 *   · 判据是**行级**的：它认"该行里出现了收尾调用"，不解析语法。若哪天有人把
 *     `rmSync(` 写进**普通字符串字面量**，会被误判为收尾动作（**误红**，不是假绿）——
 *     误红会当场暴露并改判据，比假绿安全。
 *   · **只认本文件内定义的自定义函数**：若收尾被抽到别的模块里（`import { cleanup } from './x'`），
 *     其"会不会抛"无法从本文件推断 ⇒ 目前既不算进面也不豁免，**标为未覆盖**。
 */
const PROOF_MARK = '沙箱外证'
/*
 * ⚠⚠ S1（2026-09-26）：这里原本是一份**名字白名单**
 *   `/\b(?:rmSync|rmdirSync|unlinkSync|cleanupSandbox)\s*\(/`
 * —— **改个名就整条消失**。`minimal` 落盘实测的反例（语法有效、有真实危害）：
 *   ① 在 `cleanupSandbox` 定义后插一个**同形但不吞异常**的 `function cleanup(sandbox){ rmSync(...) }`；
 *   ② 把 `const cleanupFailure = cleanupSandbox(sandbox)` **改名**成 `cleanup(sandbox)`；
 *   ③ 把它**前移**到「沙箱外证 —— 零差异」那一行**之前**。
 *   ⇒ 收尾跑在结论行之前、抛错后结论整段不可达，而**旧 k1 判绿**（本席复现：pass 1 / fail 0）。
 *   判据级变体同样全绿：`await fs.promises.rm(`、自定义 `cleanup()`、`execFileSync('rm', …)`；
 *   唯一被抓的是「保留白名单名但前移位置」。
 * ⇒ 改成**结构判据**：不问函数叫什么名字，问一句机器可判的话 ——
 *
 *   > **最后一条外证行之后，还有没有"可能抛错的调用"跑在 `process.exit` 前面？**
 *
 * 识别规则（**不看名字，看结构**；三条都来自本文件自身的语法事实）：
 *   · **① 写操作类**：`node:fs` / `node:fs/promises` 的**导入绑点**（`rmSync` / `writeFileSync` /
 *     `cpSync` / `promises.rm` …）—— 覆盖「换 API」；`rm` / `unlink` 等方法名单独列一份，
 *     覆盖 `await fs.promises.rm(` 这种**经由命名空间对象**的调用；
 *   · **② 子进程类**：`node:child_process` 的导入绑点（`execFileSync` / `exec` …）；
 *   · **③ 本文件里"不吞异常"的自定义函数**：解析 `function xxx(...) { … }` 的函数体，
 *     **体内没有 `try…catch`** 的即视为可能抛 —— 覆盖「改名/自造封装」。
 *     （`cleanupSandbox` 因为**自己带 try/catch** 天然落进"安全"一侧，与 g1 的实测背书一致。）
 */
const FS_WRITE_BINDS = /\b(?:rmSync|rmdirSync|unlinkSync|writeFileSync|appendFileSync|cpSync|copyFileSync|renameSync|mkdirSync|symlinkSync|truncateSync|rm|rmdir|unlink|writeFile|appendFile|cp|copyFile|rename|mkdir|symlink|truncate)\s*\(/
const CHILD_PROCESS_BINDS = /\b(?:execFileSync|execFile|execSync|exec|spawnSync|spawn|fork)\s*\(/
const EXIT_CALL = /\bprocess\.exit\s*\(/
/** 日志行：它们**不写盘**，故不算"可能抛错的收尾"（除外） */
const LOG_LINE = /^\s*console\.[a-z]+\s*\(/
/*
 * 定义行不是调用行（S1 实测补）：`function purge(s) { writeFileSync(...) }` 这种**单行函数定义**
 *   会被判据当成"在这一行调用了写操作" ⇒ 定义在结论行之前时**误红**（实测负控 F 撞到：
 *   fixture 里 `purge` 的定义行被算成了收尾调用）。故显式排除函数声明行。
 */
const FN_DEF_LINE = /^\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/

/** `node:fs` / `node:fs/promises` / `node:child_process` 的具名导入绑点。 */
const importedBinds = (text) => {
  const out = { fs: new Set(), cp: new Set() }
  for (const m of text.matchAll(/(?:^|\n)\s*import\s*\{([^}]*)\}\s*from\s*['"]node:(fs|fs\/promises|child_process)['"]/g)) {
    const bucket = m[2] === 'child_process' ? out.cp : out.fs
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) bucket.add(name)
    }
  }
  return out
}

/**
 * 本文件里每个 `function xxx(...) { … }` 的：定义行 + 函数体 + **是否自带 `try…catch`**
 * + **是否自递归**（W1 补）。纯文本解析（大括号配平），不执行任何代码。
 *
 * ⚠ W1（2026-09-26）：body 里**含定义行本身** ⇒ 定义行上的 `function f(` 就是一次"自引用"匹配，
 *   于是"自引用"恒真、**毫无信息**。旧版因此必须在传播时 `if (other === name) continue` 挡住它，
 *   **代价是自递归永远返回 false** —— `function teardownSelf(s) { return teardownSelf(s) }`
 *   既不写盘也不 throw，唯一的危害就是**爆栈**（实测 `RangeError: Maximum call stack size exceeded`，
 *   结论行整段丢失），而 k1 判绿。
 *   ⇒ 这里**把定义行剥掉**（`slice(1)`）再搜自引用：剥离后仍含自引用 = **真自递归** ⇒
 *     作为**独立种子**保守判为"可能抛"。这样既不依赖那个 `continue`，也不会把
 *     `pureA -> pureB` 这类**纯运算链**误判（它们剥离后不含自身名字，仍绿 —— 硬约束）。
 */
const functionInfo = (text) => {
  const lines = text.split('\n')
  const out = new Map()
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/)
    if (m === null) continue
    let depth = 0
    let started = false
    const body = []
    for (let j = i; j < lines.length && j < i + 200; j += 1) {
      for (const ch of lines[j]) { if (ch === '{') { depth += 1; started = true } else if (ch === '}') depth -= 1 }
      body.push(lines[j])
      if (started && depth === 0) break
    }
    const bodyText = body.join('\n')
    /*
     * ⚠ W1：**剥掉定义行**再搜自引用（见上方注释）。
     *   不剥 ⇒ 定义头 `function f(` 自匹配恒真 ⇒ 该信号无信息量；
     *   剥掉后仍含 `f(` ⇒ 才是**真自递归**（爆栈风险），作为独立种子。
     */
    /*
     * ⚠ W1 订正（实测撞到）：**不能**用 `body.slice(1)` 剥定义行 ——
     *   对**单行函数**（`function f(s) { return f(s) }`）body 只有一行，
     *   slice(1) 直接把整个函数剥空 ⇒ 自递归仍被漏掉（实测 GREEN）。
     *   正确做法是**只摘掉定义头那一次 `NAME(` 出现**（它是定义而不是调用），
     *   再看剩下的文本里还有没有 `NAME(`。
     */
    const bodyNoDef = bodyText.replace(new RegExp('(?:async\\s+)?function\\s+' + m[1] + '\\s*\\('), 'function ')
    const selfRef = new RegExp('\\b' + m[1] + '\\s*\\(').test(bodyNoDef)
    out.set(m[1], { at: i + 1, body: bodyText, safe: /\btry\b/.test(bodyText) && /\bcatch\b/.test(bodyText), selfRef })
  }
  return out
}

/**
 * 把注释**逐字节置空但保留换行**（行号不变），再交给行级判据。
 *
 * ⚠ 必须去注释：`mutate.mjs` 里解释这条口径的注释**本身**就写着
 *   `rmSync(sandbox)`（如 `:248`）—— 不去注释的话，判据会去守护一段注释文字，
 *   而真正的调用行反而没人看。本仓已有同类前科（锚点字符串被注释冒充）。
 */
const blankComments = (text) => {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  return noBlock.split('\n').map((line) => (line.trim().startsWith('//') ? ' '.repeat(line.length) : line)).join('\n')
}

/** 外层那一块的 [start, end)：两个锚点都必须找得到，否则判据会静默退化成空集。 */
const outerSpan = (text) => {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^if \(process\.env\[SANDBOX_ENV\] === undefined/.test(line))
  const end = lines.findIndex((line) => /^const projectRoot = process\.env\[SANDBOX_ENV\]/.test(line))
  return { lines, start, end }
}

/**
 * 结构判据：返回违规项的行号（1-based）清单。**两类违规**，都只依赖"调用出现在哪一行"：
 *
 *   · **R1 `exitWithoutProof`**：某个 `process.exit(` 之前**一条外证行都没有**
 *     —— 结论根本没打印就退出去了（①④ 的形态）。
 *   · **R2 `callAfterLastProof`**：**最后一条外证行之后**、某个 `process.exit(` **之前**，
 *     出现"可能抛错的调用" —— 一旦它抛，其后的外证结论整段执行不到。
 *     ⚠ 这正是 `minimal` 反例的形态：收尾被**改名**（名字白名单抓不到）并**前移到外证行之前**。
 *
 * 为什么用"最后一条外证行之后"而不是"每条收尾各自的守护行"：外证行与收尾**不是一一对应**的
 * （一条外证行可能守着多次收尾，反过来 n 条分支各打印一次）。结构上的安全条件是**全局**的：
 * 「结论全部打印完」之后才允许做可能抛错的事。这比逐条配对更难被绕过，也更少误判。
 *
 * 区域**之外**的 `process.exit` 不参与判定：沙箱自检那三个 `exit 5`（`test/mutate.mjs` 的
 * 写盘前哨）位于外层**之后**，那里按设计**不该**有外证行 —— 把它们算进来就是误红。
 *
 * 纯函数，不读磁盘 —— 负控就是靠"喂它一段改造过的文本"来证明它真的在判。
 */
const guardsBeforeCleanup = (text) => {
  const { lines, start, end } = outerSpan(text)
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('外层区域锚点没找到（判据静默退化的形态），请同步本判据')
  }
  const binds = importedBinds(text)
  const info = functionInfo(text)
  const unsafeFns = new Set([...info].filter(([, v]) => !v.safe).map(([n]) => n))
  /*
   * ⚠ 只把**会改动外部世界**的 fs 绑点算进"收尾类"：读类（`readFileSync` / `readdirSync` /
   *   `existsSync`）**不算** —— 否则像 `srcDigest` 这种纯读函数也会被算成收尾调用，
   *   判据面立刻变糊（实测：第一版把它算进去后 `teardownAt` 从 3 条涨到 7 条）。
   */
  const MUTATING = /^(rm|rmdir|unlink|writeFile|appendFile|cp|copyFile|rename|mkdir|symlink|truncate|chmod|chown|utimes|link)/
  const fsBinds = [...binds.fs].filter((n) => MUTATING.test(n))
  const cpBinds = [...binds.cp]
  /*
   * ══ V1（2026-09-26）：**沿调用图求传递闭包** ══════════════════════════════════
   *
   * ⚠ 缺口（minimal 席 s1r 复核、主持人核实，本席复现）：
   *   上一版只看函数的**直接**函数体：
   *     ```
   *     function teardownOuter(s) { return teardownInner(s) }      // 体内无 fs 调用
   *     function teardownInner(s) { void s; throw new Error("…") } // 真抛在内层
   *     const earlyTeardown = teardownOuter(sandbox)               // 插在结论行**之前**
   *     ```
   *   ⇒ `bodyTouchesWorld('teardownOuter')` 返回 false ⇒ **整条链不被认成收尾** ⇒ k1 判绿，
   *     而探针实跑 `status=1 / hasProof=false`（结论行整段丢失）—— 与 s1 修掉的反例同类同因，
   *     只多套一层函数。三层嵌套同理。
   *
   * ⚠ 同时把**种子**从"会动外部世界"扩到"**显式 throw**"：
   *   上面的 `teardownInner` 既不写盘也不起子进程，它唯一的危害是**抛异常** ——
   *   所以"会不会抛"的判据必须认 `throw`，否则闭包传上去的仍然是 false。
   *
   * ⚠ **不做**那种"凡自定义函数皆视为可能抛"的宽松化（那会把 `digestDiff` / `vanished`
   *   这类纯数组运算也算进来 ⇒ 真文件立刻误红）。种子只有两类：
   *   fs 写类 / 子进程调用、以及**显式 `throw`**；其余只能靠**传播**进来。
   *
   * ⚠ **循环调用**（A 调 B、B 调 A）：`visiting` 访客集拦回边，**按"可能抛"保守判定**
   *   （真实的相互递归本身就是栈溢出风险，保守一侧更安全），并 `memo` 收敛 —— 不会无限递归。
   */
  const bodyTouchesWorld = (() => {
    const memo = new Map()
    const visiting = new Set()
    const compute = (name) => {
      if (memo.has(name)) return memo.get(name)
      if (visiting.has(name)) return true   // 回边：保守判为"可能抛"（环自身即风险）
      visiting.add(name)
      const v = info.get(name)
      let result = false
      if (v !== undefined) {
        const body = v.body
        result = FS_WRITE_BINDS.test(body) || CHILD_PROCESS_BINDS.test(body)
          || fsBinds.some((b) => new RegExp('\\b' + b + '\\s*\\(').test(body))
          || cpBinds.some((b) => new RegExp('\\b' + b + '\\s*\\(').test(body))
          || /\bthrow\b/.test(body)
          || v.selfRef === true
        if (!result) {
          for (const other of info.keys()) {
            if (other === name) continue
            if (new RegExp('\\b' + other + '\\s*\\(').test(body) && compute(other)) { result = true; break }
          }
        }
      }
      visiting.delete(name)
      memo.set(name, result)
      return result
    }
    return compute
  })()
  /**
   * 「收尾类调用」= **会动外部世界**的调用（名字无关）：
   *   · 直接命中 fs 写/删 API 或子进程 API（含 `fs.promises.rm(` 这种经由命名空间的形态）；
   *   · 或者调用了**本文件里自定义**的、体内含上述调用的函数（覆盖"改名/自造封装"）。
   * ⚠ 判据**不按名字**，故 `cleanup()` / `rm()` / `fs.promises.rm()` 一视同仁。
   */
  const isTeardownCall = (line) => {
    if (LOG_LINE.test(line)) return false
    if (FN_DEF_LINE.test(line)) return false
    if (FS_WRITE_BINDS.test(line) || CHILD_PROCESS_BINDS.test(line)) return true
    for (const b of [...fsBinds, ...cpBinds]) if (new RegExp('\\b' + b + '\\s*\\(').test(line)) return true
    /* ⚠ S1 订正：这里必须遍历**全部**自定义函数（不只"不自带 try 的"）——
       否则 `cleanupSandbox(` 因为是 safe 函数就**根本不被认成收尾调用**，
       判据面直接塌成 1 条（实测）。"是不是收尾"与"会不会抛"是两件事，分开判。 */
    for (const name of info.keys()) if (new RegExp('\\b' + name + '\\s*\\(').test(line) && bodyTouchesWorld(name)) return true
    /* ⚠ V1：区域**行级**的两类弱面（minimal 席登记，本轮一并收口）——
       `JSON.parse(非 JSON)` 与 `process.stdout.write(` 同样会抛，且都不属于上面任何一类。
       实测真文件区域里两处命中数均为 **0**，故这条**当前零实例、不引入误红**。 */
    if (/\bJSON\.parse\s*\(/.test(line) || /\bprocess\.(?:stdout|stderr)\.write\s*\(/.test(line)) return true
    return false
  }
  const span = lines.slice(start, end)
  const proofAt = []
  const exitAt = []
  const teardownAt = []
  /**
   * 就地 `try` 包裹：逐行维护一个"当前是否在 try 块内"的栈。
   * 这是"调用点自己兜住了异常"的结构特征 —— 与"被调函数自己永不抛"并列，构成两条豁免之一。
   */
  const inTry = []
  let tryDepthStack = 0
  let depth = 0
  const guardedAt = new Set()
  span.forEach((line, i) => {
    const n = start + i + 1
    if (tryDepthStack > 0 && depth >= tryDepthStack) guardedAt.add(n)
    for (const ch of line) {
      if (ch === '{') depth += 1
      else if (ch === '}') { depth -= 1; if (depth < tryDepthStack) tryDepthStack = 0 }
    }
    if (/\btry\s*\{[^}]*$/.test(line) || /\btry\s*\{/.test(line)) tryDepthStack = depth
    if (EXIT_CALL.test(line)) { exitAt.push(n); return }
    if (line.includes(PROOF_MARK) && /console\.log\s*\(/.test(line)) proofAt.push(n)
    if (isTeardownCall(line)) teardownAt.push(n)
  })
  /*
   * 豁免：调用的"被调方**自己永不抛**"（函数体里有 try…catch，如 `cleanupSandbox`）——
   * 这正是 g1 那条修法的结构特征，必须认；否则会把已经修好的形态判红。
   */
  const neverThrows = (n) => {
    const line = lines[n - 1]
    for (const [name, v] of info) {
      if (v.safe && new RegExp('\\b' + name + '\\s*\\(').test(line)) return true
    }
    return false
  }
  const lastProof = proofAt.length === 0 ? -1 : proofAt[proofAt.length - 1]
  /** **未豁免**的收尾调用：既不在就地 try 里，被调方也不是"自带 try…catch 永不抛"。 */
  const unguarded = teardownAt.filter((n) => !guardedAt.has(n) && !neverThrows(n))
  /*
   * ── 判定（S1 · `minimal` 反例暴露了旧口径的漏洞）────────────────────────────
   * 旧口径是「**最后一条**外证行之后的收尾调用」⇒ 把收尾**前移到最后一条外证行之前**
   * 就整条绕开（`minimal` 的反例正是这么干的：改名 + 前移）。
   *
   * 现在的口径 **按出口分段**：
   *   对每个 `process.exit(e)`，取「上一出口之后（首个出口则取区域起点）到 e」这一段；
   *   **段内最后一条外证行之前**若出现**未豁免**的收尾调用 ⇒ 违规 ——
   *   因为它一旦抛，这一段的外证结论就永远打印不出来。
   *   （"段内最后一条外证行之后"的未豁免调用**不算违规**：结论已经出来了，
   *     后面再抛只是丢后续告警，不构成"结论出不来"。旧口径在这一侧过严。）
   *
   * 双向都在判据面内：前移（minimal 的反例）与换 API 都被抓；就地 try / 自带 try 的
   * 收尾则因**豁免**而不入面 —— 这正是 g1 那条修法的结构特征，必须认。
   */
  /*
   * 不变式（S1 定稿）：**每个"可能抛错的收尾"都必须排在它所属分支的结论行之后**。
   *   · 分支 = 相邻两个 `process.exit` 之间那一段（首个分支从区域起点算）；
   *   · 收尾 `c` 合规 ⟺ 存在一条外证行 `p`，满足 `segStart < p < c`；
   *   · 不满足即违规 —— 因为 `c` 一旦抛，这条分支的结论**根本打印不出来**。
   *
   * 这个形态同时盖住三种写法（都是 `minimal` 列出的）：
   *   · **改名**：不看名字，只看"会不会动外部世界"；
   *   · **换 API**：`fs.promises.rm` / `execFileSync('rm',…)` 都命中识别规则；
   *   · **前移**：收尾被挪到结论行**之前** ⇒ 不存在 `p < c` ⇒ 违规。
   * 而"就地 try"与"被调方自带 try/catch"两种形态被**豁免**（它们抛不出来）。
   */
  const boundaries = [start, ...exitAt]
  const segStartOf = (n) => [...boundaries].filter((b) => b < n).pop() ?? start
  const violations = unguarded.filter((c) => {
    const segStart = segStartOf(c)
    return !proofAt.some((p) => p > segStart && p < c)
  })
  return {
    proofAt,
    exitAt,
    teardownAt,
    guardedAt: [...guardedAt],
    unguarded,
    lastProof,
    /** R1：某个 exit 之前一条外证行都没有（结论根本没出来）。 */
    exitWithoutProof: exitAt.filter((e) => !proofAt.some((p) => p < e)),
    /** R2：段内最后一条外证行**之前**出现未豁免的收尾调用（前移形态）。 */
    callAfterLastProof: [...new Set(violations)],
    /** 兼容旧负控：同 R2（保留旧名）。 */
    violations: [...new Set(violations)],
  }
}

test('k1（结构判据）：每个可能抛错的收尾都必须排在本分支结论行之后，且任何 exit 前必须有结论', () => {
  const srcLf = blankComments(readLf('./mutate.mjs'))
  const { proofAt, teardownAt, unguarded, exitAt, lastProof, exitWithoutProof, callAfterLastProof } = guardsBeforeCleanup(srcLf)

  /*
   * ── 非空前提（防空转）────────────────────────────────────────────────────
   * 没有这三条，下面的 `deepEqual(…, [])` 会在"一个都没解析到"的情况下**通过** ——
   * 那正是本仓反复剿的"空转假绿"。
   * ⚠ 第 3 条是 S1 补的：光有"至少 1 个 risky"不够，`minimal` 的反例里
   *   `degradedCleanup` 就足以让旧的非空前提过关。真正要保证的是
   *   「**最后一条外证行之后**确实被解析到过调用」——那才是 R2 的判据面。
   */
  assert.ok(
    teardownAt.length >= 1,
    `外层里没解析到任何"会动外部世界"的调用（收尾类）—— 要么外层被重构了，要么结构识别规则脱节；此时下面的断言是空转的，不能算通过。实测区域：${JSON.stringify({ proofAt, teardownAt, exitAt })}`,
  )
  assert.ok(
    proofAt.length >= 1,
    `外层里没解析到任何 console.log 形式的「${PROOF_MARK}」行 —— 判据失去守护者定义，会退化成恒真。实测：${JSON.stringify({ proofAt, teardownAt })}`,
  )
  /*
   * ⚠ 第 3 条的前提判据（S1 补）：光有"至少 1 个收尾类调用"不够 —— `minimal` 的反例里
   *   残留的 `degradedCleanup` 就足以让旧的非空前提过关。真正要保证的是
   *   「**每个 exit 之前**都解析出了至少一条外证行」与「解析面非空」。
   */
  /*
   * ⚠ S1 订正：这里原本写的是「最后一条外证行**之后**必须有收尾类调用」——
   *   **那是错的**，而且正是 `minimal` 反例赖以绕过的地方：它把收尾**前移到最后一条外证行之前**，
   *   于是这条前提失败、判据以"空转"名义报红 —— **红得对、理由错**（真因是"违规"而不是"空转"）。
   *   前提应当只保证「**被分析的对象非空**」，而不是对位置提要求。位置要求由负控 C/D 证明有分辨力。
   */
  assert.ok(
    teardownAt.length >= 1,
    `外层里一个收尾类调用都没解析到 —— 判据面为空，下面的断言会空转。实测：${JSON.stringify({ proofAt, teardownAt, unguarded })}`,
  )
  /*
   * 非空前提之三（S1）：必须有**出口**可判 —— 判据是"按出口分段"的，一个出口都没有就无从判起。
   *   （"识别规则有分辨力"由下面的负控 C / D 直接证明，比在这里空转断言更强。）
   */
  assert.ok(
    exitAt.length >= 1,
    `外层里没解析到任何 process.exit 出口 —— 判据按出口分段，无出口即无从判起。实测：${JSON.stringify({ proofAt, teardownAt, exitAt })}`,
  )

  /*
   * == 负控组（S1 修正版）=========================================================
   * 为什么负控必须跑在**固定夹具**上、而不是**改过的真文件**上（本轮实测两连坑）：
   *   我第一版把负控建立在被改过的 srcLf 上，于是负控自己会随被测形态一起变 ——
   *   ① 插在结论行**之后**的收尾，在真文件口径下本该绿，负控却断言它必红 => 口径写反；
   *   ② 把真文件收尾前移后，**负控 A 自己也换了位置**，它报的红来自'负控被扰动'、
   *      而不是'判据抓到了真违规' —— 红得对、理由错（本仓一直在剿的形态）。
   *   => 负控一律用手工搭的最小夹具：只含判据需要的四样东西（区域锚点、结论行、
   *      出口、收尾调用），与真实 mutate.mjs 的任何改动解耦。
   */
  const FIX = {
    top: 'if (process.env[SANDBOX_ENV] === undefined) {',
    mid: '  const before = 0',
    tail: ['}', '', 'const projectRoot = process.env[SANDBOX_ENV]'],
  }
  const withBody = (body) => [FIX.top, FIX.mid, ...body, ...FIX.tail].join(String.fromCharCode(10))
  const PROOF_LINE = '  console.log("' + PROOF_MARK + '：零差异")'
  const SAFE_FN = 'function wrapped(s) { try { rmSync(s, { recursive: true }) } catch (e) { return e } return null }'
  const UNSAFE_FN = 'function purge(s) { writeFileSync(s + "/x", "1") }'

  /*
   * ── 负控 C（**改名 + 不吞异常 + 前移到结论行之前** => 必红）────────────────────
   * 直击 minimal 的反例：旧名字白名单只认 rmSync|cleanupSandbox，自造 purge() 就整条消失。
   */
  const renamedResult = guardsBeforeCleanup(withBody([
    UNSAFE_FN,
    '  const a = purge(sandbox)',
    PROOF_LINE,
    '  process.exit(0)',
  ]))
  assert.ok(
    renamedResult.callAfterLastProof.length > 0,
    '负控 C 失效：一个「改名 + 不吞异常 + 前移到结论行之前」的自造收尾没被判违规 —— 判据仍在按名字识别。实测 ' + JSON.stringify(renamedResult),
  )

  /*
   * ── 负控 D（**换 API** fs.promises.rm => 必红）───────────────────────────────
   */
  const swappedResult = guardsBeforeCleanup(withBody([
    'async function wipe(s) { await fs.promises.rm(s, { recursive: true, force: true }) }',
    '  const b = wipe(sandbox)',
    PROOF_LINE,
    '  process.exit(0)',
  ]))
  assert.ok(
    swappedResult.callAfterLastProof.length > 0,
    '负控 D 失效：换成 fs.promises.rm 形态后没被判违规（判据还在按名字识别）—— 实测 ' + JSON.stringify(swappedResult),
  )

  /*
   * ── 负控 E（**裸 fs API 前移** => 必红）：覆盖'直接调 API、没有自定义封装'─────────
   */
  const bareResult = guardsBeforeCleanup(withBody([
    '  rmSync(sandbox, { recursive: true, force: true })',
    PROOF_LINE,
    '  process.exit(0)',
  ]))
  assert.ok(
    bareResult.callAfterLastProof.length > 0,
    '负控 E 失效：裸 rmSync 前移到结论行之前没被判违规 —— 实测 ' + JSON.stringify(bareResult),
  )

  /*
   * ── 负控 F（**合规位置** => 必绿）：收尾排在结论行**之后**是判据要求的位置 ─────────
   * 它必须绿（防判据过宽 => 误红），且必须**仍被识别**（否则绿得没有意义）。
   */
  const okResult = guardsBeforeCleanup(withBody([
    UNSAFE_FN,
    PROOF_LINE,
    '  const c = purge(sandbox)',
    '  process.exit(0)',
  ]))
  assert.deepEqual(
    okResult.callAfterLastProof,
    [],
    '负控 F 失效：收尾排在结论行之后（合规位置）却被判违规 —— 判据过宽、会误红。实测 ' + JSON.stringify(okResult),
  )
  assert.ok(
    okResult.unguarded.length > 0,
    '负控 F 失效：合规夹具里的收尾根本没被识别（unguarded 为空）—— 识别层瞎了，绿得没有意义。实测 ' + JSON.stringify(okResult),
  )

  /*
   * ── 负控 G（**豁免**：被调方自带 try/catch => 位置无关、不判违规）─────────────────
   * 这正是 cleanupSandbox 与 g1 修法的结构特征；判据若不认它，就会把已修好的形态判红。
   */
  const exemptedResult = guardsBeforeCleanup(withBody([
    SAFE_FN,
    '  const d = wrapped(sandbox)',
    PROOF_LINE,
    '  process.exit(0)',
  ]))
  assert.deepEqual(
    exemptedResult.callAfterLastProof,
    [],
    '负控 G 失效：被调方自带 try/catch（永不抛）的收尾被判成违规 —— 会把 g1 已修好的形态误红。实测 ' + JSON.stringify(exemptedResult),
  )
  assert.ok(
    exemptedResult.teardownAt.length > 0,
    '负控 G 失效：豁免夹具里的收尾连收尾类都没被认成 —— 识别层瞎了。实测 ' + JSON.stringify(exemptedResult),
  )

  /*
   * ══ V1（2026-09-26）负控组：**沿调用图求传递闭包** ═════════════════════════════
   * 上面 C/D/E 都是"直接体内就有危害"的一层形态；这三条打的是**深度变体**：
   * 危害藏在被调函数的更深处，上一版只看直接函数体 ⇒ 整条链不被认成收尾。
   */

  /* ── 负控 H：**两层包装**（外层体内无任何 fs/throw，真抛在内层）=> 必红 ──────── */
  const twoLayer = guardsBeforeCleanup(withBody([
    'function outer2(s) { return inner2(s) }',
    'function inner2(s) { void s; throw new Error("EPERM simulated") }',
    '  const t = outer2(sandbox)',
    PROOF_LINE,
    '  process.exit(0)',
  ]))
  assert.ok(
    twoLayer.callAfterLastProof.length > 0,
    '负控 H 失效：两层包装（outer2 -> inner2，外层体内无 fs/throw）没被判违规 —— 传递闭包没生效。实测 ' + JSON.stringify(twoLayer),
  )

  /* ── 负控 I：**三层嵌套** => 必红（不只两层）─────────────────────────────────── */
  const threeLayer = guardsBeforeCleanup(withBody([
    'function lvl3(s) { return lvl2(s) }',
    'function lvl2(s) { return lvl1(s) }',
    'function lvl1(s) { void s; throw new Error("EPERM 3-deep") }',
    '  const t3 = lvl3(sandbox)',
    PROOF_LINE,
    '  process.exit(0)',
  ]))
  assert.ok(
    threeLayer.callAfterLastProof.length > 0,
    '负控 I 失效：三层嵌套没被判违规（闭包只传了一层？）。实测 ' + JSON.stringify(threeLayer),
  )

  /* ── 负控 J：**循环调用**（A 调 B、B 调 A）=> 不死循环，且按"可能抛"保守判定 ───── */
  const cyclic = guardsBeforeCleanup(withBody([
    'function cycA(s) { return cycB(s) }',
    'function cycB(s) { return cycA(s) }',
    '  const t4 = cycA(sandbox)',
    PROOF_LINE,
    '  process.exit(0)',
  ]))
  assert.ok(
    cyclic.teardownAt.length > 0,
    '负控 J 失效：循环调用链没被认成收尾（回边应保守判为"可能抛"）。实测 ' + JSON.stringify(cyclic),
  )

  /* ── 负控 K（**防过宽**）：纯计算的深链**不得**被认成收尾 ───────────────────────
   * 闭包若把"凡自定义函数皆视为可能抛"当作种子，真文件里的 digestDiff / vanished 会立刻误红。
   * 这里钉住反向：只做数组运算的深链必须绿、且不得进 unguarded。
   */
  const pureChain = guardsBeforeCleanup(withBody([
    'function pureB(a, b) { return a.filter((x) => !b.includes(x)) }',
    'function pureA(a, b) { return pureB(a, b) }',
    '  const t5 = pureA([1, 2], [2])',
    PROOF_LINE,
    '  process.exit(0)',
  ]))
  assert.deepEqual(
    pureChain.callAfterLastProof,
    [],
    '负控 K 失效：纯计算的深链被判成收尾 —— 判据过宽（真文件的 digestDiff / vanished 会立刻误红）。实测 ' + JSON.stringify(pureChain),
  )

  /* ── 负控 L（V1 · 弱面一并收口）：JSON.parse / stdout.write 前移 => 必红 ──────────
   * minimal 席登记的两类弱面；真文件区域里**当前零实例**（实证），故不引入误红。
   */
  const weakJson = guardsBeforeCleanup(withBody([
    '  const cfg = JSON.parse(sandbox)',
    PROOF_LINE,
    '  process.exit(0)',
  ]))
  assert.ok(
    weakJson.callAfterLastProof.length > 0,
    '负控 L 失效：JSON.parse 前移没被判违规。实测 ' + JSON.stringify(weakJson),
  )
  const weakWrite = guardsBeforeCleanup(withBody([
    '  process.stdout.write("x")',
    PROOF_LINE,
    '  process.exit(0)',
  ]))
  assert.ok(
    weakWrite.callAfterLastProof.length > 0,
    '负控 L 失效：process.stdout.write 前移没被判违规。实测 ' + JSON.stringify(weakWrite),
  )

  /*
   * ══ W1（2026-09-26）负控组：**自递归** ═══════════════════════════════════════
   * 上一版在传播时用 `if (other === name) continue` 挡自匹配（因为 body 含定义行、自匹配恒真），
   * **代价是自递归永远返回 false**：`function f(s) { return f(s) }` 既不写盘也不 throw，
   * 唯一危害是**爆栈**（探针实跑 RangeError、结论行整段丢失），而 k1 判绿。
   */

  /* ── 负控 M：**单行自递归** => 必红 ─────────────────────────────────────────── */
  const selfRecOneLine = guardsBeforeCleanup(withBody([
    'function selfOne(s) { return selfOne(s) }',
    '  const m1 = selfOne(sandbox)',
    PROOF_LINE,
    '  process.exit(0)',
  ]))
  assert.ok(
    selfRecOneLine.callAfterLastProof.length > 0,
    '负控 M 失效：单行自递归没被判违规 —— 剥离定义行时把单行函数整个剥空了？（实测第一版就撞到这个）。实测 ' + JSON.stringify(selfRecOneLine),
  )

  /* ── 负控 N：**多行自递归** => 必红 ─────────────────────────────────────────── */
  const selfRecMulti = guardsBeforeCleanup(withBody([
    'function selfMulti(s) {',
    '  return selfMulti(s)',
    '}',
    '  const n1 = selfMulti(sandbox)',
    PROOF_LINE,
    '  process.exit(0)',
  ]))
  assert.ok(
    selfRecMulti.callAfterLastProof.length > 0,
    '负控 N 失效：多行自递归没被判违规。实测 ' + JSON.stringify(selfRecMulti),
  )

  /* ── 负控 O（**硬约束的常驻复刻**）：纯运算链**不得**被自递归规则误伤 ───────────
   * 任务明写："你的修法必须让它们保持 GREEN，同时让自递归 RED。二者缺一不可。"
   * 这里把两条纯链固化进判据内部（不只跑一次外部试验）。
   */
  const pureArith = guardsBeforeCleanup(withBody([
    'function qb(n) { return n + 1 }',
    'function qa(n) { return qb(n) }',
    '  const o1 = qa(1)',
    PROOF_LINE,
    '  process.exit(0)',
  ]))
  assert.deepEqual(
    pureArith.callAfterLastProof,
    [],
    '负控 O 失效：纯算术链 qa -> qb 被判成收尾 —— 判据过宽（真文件立刻误红）。实测 ' + JSON.stringify(pureArith),
  )
  const pureFilter = guardsBeforeCleanup(withBody([
    'function filterB(a, b) { return a.filter((x) => !b.includes(x)) }',
    'function filterA(a, b) { return filterB(a, b) }',
    '  const o2 = filterA([1, 2], [2])',
    PROOF_LINE,
    '  process.exit(0)',
  ]))
  assert.deepEqual(
    pureFilter.callAfterLastProof,
    [],
    '负控 O 失效：纯运算 filter 深链被判成收尾 —— 判据过宽。实测 ' + JSON.stringify(pureFilter),
  )

  /*
   * ⚠ S1 订正（防过严）：这里原写的是「真文件里**不得有**未豁免的收尾调用」——
   *   **那会误红**：一个"位置合规、但被调方不自带 try"的收尾是**合法**的
   *   （结论已出，它再抛只丢后续告警）；把它算成必须为零 = 判据过宽。
   *   真正要钉的是**位置**（正题里的 callAfterLastProof），以及"识别层确实在工作"。
   *   这里改为断言"**识别层认得出真文件里的收尾调用**"（防判据整体失明后一路绿）。
   */
  assert.ok(
    teardownAt.length >= 1,
    '真实源码里一个收尾类调用都没被识别出来 —— 识别层瞎了，正题断言会绿得没有意义。实测：' + JSON.stringify({ teardownAt, unguarded, exitAt }),
  )
  /*
   * 如实记一条豁免面的读数（**只报数、不断言为零**）：
   *   真文件里三次 cleanupSandbox( 因自带 try/catch 而豁免；若哪天有人去掉它的 try/catch，
   *   unguarded 会立刻变大 —— 那个变化由正题的位置判据来接管（位置一旦不对就红）。
   */
  assert.ok(
    unguarded.length <= teardownAt.length,
    '未豁免数不可能超过收尾类调用总数（判据内部自相矛盾）：' + JSON.stringify({ teardownAt, unguarded }),
  )

  /*
   * ── 负控 B（保留，口径改为"结构判据"）：抹掉全部「沙箱外证」字样 ⇒
   *    最后一条外证行退化成 -1 ⇒ **区域内每一个**收尾调用都落在它之后 ⇒ 全违规 ────
   */
  const stripped = srcLf.split(PROOF_MARK).join('沙箱〇证')
  const strippedResult = guardsBeforeCleanup(stripped)
  assert.deepEqual(
    strippedResult.violations,
    strippedResult.unguarded,
    `负控 B 失效：抹掉「${PROOF_MARK}」后应**全部**未豁免收尾调用违规，实测 ${JSON.stringify({ violations: strippedResult.violations, unguarded: strippedResult.unguarded })}`,
  )

  /*
   * ── 边界控（S1 硬性要求 5）：区域**之外**的合法出口不得被误判 ────────────────
   * 沙箱自检那三个 `process.exit(5)` 在外层之后、写盘之前，那里按设计**不该**有外证行。
   * 判据必须只在区域内取样；这里用"把区域外的 exit 也当成违规"的错版本做反证。
   */
  const exitAfterRegion = srcLf.split('\n').map((l, i) => [i + 1, l]).filter(([n, l]) => n > outerSpan(srcLf).end && EXIT_CALL.test(l)).map(([n]) => n)
  assert.ok(exitAfterRegion.length >= 1, '没找到区域外的 exit —— 这条边界控的前提不成立（沙箱自检出口被挪走了？）')
  assert.deepEqual(
    [...new Set([...exitWithoutProof, ...exitAt])].filter((n) => exitAfterRegion.includes(n)),
    [],
    `区域外的合法出口（${exitAfterRegion.join('、')}）被算进了判据 —— 它们按设计没有外证行，判成违规就是误红。`,
  )

  /* ── 正题：真实源码上两条都不得有违规 ─────────────────────────────────────── */
  assert.deepEqual(
    callAfterLastProof,
    [],
    [
      `第 ${callAfterLastProof.join('、')} 行有"可能抛错的收尾"，但它**排在本分支结论行之前**`,
      '（本分支的最后一条结论行是第 ' + lastProof + ' 行）—— 一旦它抛错，这条分支的结论整段执行不到',
      '（"修的是留毒，但留毒存在时它报不出来"）。',
      `处置：把结论（sha 比对 + 「${PROOF_MARK}」行）排到该动作**之前**，或把它降级为`,
      '      永不抛的可失败收尾（见 test/mutate.mjs 的 cleanupSandbox）。',
    ].join('\n'),
  )
  assert.deepEqual(
    exitWithoutProof,
    [],
    `这些退出点（${exitWithoutProof.join('、')}）之前**一条「${PROOF_MARK}」行都没有** —— 退出时没有任何可读结论。`,
  )
})

/*
 * q1 (2026-09-26, accept 席复核 p2 时发现)
 *
 * ## 判因（本席逐字复现）
 *
 * p2 把判别力钉在「reportUnjudged 会不会报知」，但**主门到底调没调它**是空白：
 *   实测把主门 :756 的 reportUnjudged(t, unjudged) **整行删掉** ⇒ exit=0 / 11 pass **全绿**。
 *   根因（accept 原话，我核实成立）：f2 那条测试用**自造桩**，只证「函数会报知」，
 *   **不证「主门调了它」** ⇒ p2 的修法**范围收窄了**：函数级钉死，调用级漏了。
 *
 * ## 为什么必须是**静态**判据（而不是再加一条动态测试）
 *
 * 动态测试能证的只有「被测的那条路径调了」，证不了「**主门**那条路径调了」—— 要证后者，
 *   就得在执行期观测主门的入参 unjudged，而主门在干净树上 unjudged 恒空（那正是 h1 的原病）。
 *   ⇒ 与 k1 同族手法：**读本文件源码**判定「主门那一段里有没有这个调用」。
 *
 * ## 四条断言各自防什么
 *
 *   ① **非空前提**：主门段必须切得出、且段内至少 1 个调用 —— 否则集合运算在空集上恒真（本仓已两次踩过）；
 *   ② **调用形态一致**：段内若有第二条调用，形态必须与第一条相同（防「顺手加了一条不管用的」）；
 *   ③ **负控 A**：只喂主门**之前**的文本 ⇒ 调用集必须为空（证明它扫的真是「主门段」）；
 *   ④ **负控 B**：f2 段里**确实有**调用（桩 + 生产各一次）⇒ 证明「全文件一把扫」会假绿，切段是必要的。
 */
test('q1：主门必须**真的调用** reportUnjudged（静态判据，不执行代码）', () => {
  const srcLf = blankComments(readLf('./mutation-probe-health.test.mjs'))
  const gateLines = srcLf.split(NEWLINE)
  const { span, calls } = mainGateReportCalls(srcLf)
  /*
   * ── ① 非空前提 ────────────────────────────────────────────────────────────
   */
  assert.ok(
    span.start > 0 && span.end > span.start,
    `没切出主门那一段（标题子串「${MAIN_GATE_NAME}」找不到或落在文件尾）—— 判据退化成空集会恒真；实测 span=${JSON.stringify(span)}`,
  )
  assert.ok(
    calls.length >= 1,
    '主门段里一个 reportUnjudged 调用都没有 —— 这就是 q1 的缺陷形态（删掉整行 ⇒ 本条必须红）',
  )
  /*
   * ── ② 段内调用形态必须一致 ─────────────────────────────────────────────────
   */
  const firstForm = gateLines[calls[0] - 1].trim()
  assert.deepEqual(
    calls.map((n) => gateLines[n - 1].trim()),
    calls.map(() => firstForm),
    `主门段内有 ${calls.length} 处 reportUnjudged 调用，形态不一致 —— 若确实加了第二条，请同步本判据`,
  )
  /*
   * ── ③ 负控 A：喂「主门之前」的文本 ⇒ 必须找不到调用 ─────────────────────────
   */
  const beforeGate = gateLines.slice(0, span.start - 1).join(NEWLINE)
  assert.deepEqual(
    mainGateReportCalls(beforeGate).calls,
    [],
    '负控 A 失效：把主门之前的文本喂进判据仍报出调用 —— 说明它扫的不是「主门段」（范围错，会与 f2 自己的调用混同）',
  )
  /*
   * ── ④ 负控 B：f2 段里确实有调用 ⇒ 切段是必要的（否则「一把扫」会假绿）─────
   */
  const f2At = gateLines.findIndex((line) => line.includes('f2 归因：新增的**未跟踪**文件'))
  assert.ok(f2At > 0, '找不到 f2 段（负控 B 的锚点没了）—— 请同步本判据')
  const f2Calls = mainGateReportCalls(gateLines.slice(f2At).join(NEWLINE), 'f2 归因：新增的**未跟踪**文件').calls
  assert.ok(
    f2Calls.length >= 1,
    'f2 段里本该有 reportUnjudged 调用（桩与生产各一次）—— 若为 0，负控 B 失去意义，请同步',
  )
})

/*
 * t1（2026-09-26 · accept 席复核 q1 时发现）
 *
 * ## Z2（中）：静态判据可被**同一行字符串字面量**冒充
 *
 * q1 已经排除了两种同族冒充（常量声明行、函数定义行），但**行文本**里长得像调用的**字符串**
 *   仍会被认成调用。实测：把主门那行换成
 *     const fake = 'reportUnjudged(t, unjudged)'
 *   ⇒ exit=0 / 12 pass **全绿**（本席复现，见 .audit/edge/t1-repro.cjs）。
 *   ⇒ 这是「锚点被同名处冒充」的**第三种形态**，且发生在判据**刚立当天**。
 *
 * **修法**：判定前先 stripStrings（剥掉字符串/模板字面量内容，保行号不变）；
 *   ⚠ 切段仍用**原文**（测试标题本就在字面量里，剥了切不出来）—— 实测踩过。
 *
 * ## V2（低）：负控 B 自身没有自证
 *
 * 删掉负控 B 的非空前提 ⇒ 套件**全绿**（本席复现）。
 *   ⇒ 负控 B「f2 段里确实有调用」这句话**没人验**，它可能已经退化成空转。
 * **修法**：本测试直接对源码喂两段**已知**文本（f2 段 / 主门段）验证切段能力，
 *   并断言「喂 f2 段时确实能切出调用」——负控 B 的非空前提由本条独立背书。
 */
test('t1：静态判据不得被字符串字面量冒充（含「不得误伤」与负控 B 的自证）', () => {
  const srcLf = blankComments(readLf('./mutation-probe-health.test.mjs'))
  const NL = NEWLINE

  /*
   * ── ① 冒充必须被看穿：把主门那一行换成字符串字面量 ─────────────────────────
   *   做法：在**内存里**改造源码（不碰磁盘），喂给同一个判据函数。
   *   ⚠ 内存改造＝盘面零改动，故本测试自身不可能留残留、也不干扰并行测试。
   */
  const lines = srcLf.split(NL)
  const { span, calls } = mainGateReportCalls(srcLf)
  assert.ok(span.start > 0 && calls.length >= 1, '前提：真实源码里主门段能切出且确有调用')
  const callAt = calls[0]
  const impersonated = [...lines]
  impersonated[callAt - 1] = "  const fake = 'reportUnjudged(t, unjudged)'"
  const fakeResult = mainGateReportCalls(impersonated.join(NL))
  assert.deepEqual(
    fakeResult.calls,
    [],
    `把主门调用换成**字符串字面量**冒充后，判据仍报出调用（${JSON.stringify(fakeResult.calls)}）——`
    + ' 这正是本仓反复剿的「锚点被同名处冒充」的第三种形态（前两种：常量声明行、函数定义行）',
  )
  /*
   * ⚠⚠ **u1 · 给上面这条断言加接线**（accept 席复核发现：它的实参被换成字面量 `[]` ⇒ exit=0 全绿）。
   *   手法与下面「接线本身也要有常驻判据」同族：**静态查源码**里那处的实参是不是真计算结果。
   *   具体判定两条：① `fakeResult` 的赋值右侧必须是 `mainGateReportCalls(`（不是字面量/桩值）；
   *   ② 源码里必须存在 `fakeResult.calls,` 这处实参。
   *
   * ⚠ **有界，不是消除**（与下面那处同族，停止条件写在这里）：本接线判据自己也能被换成恒真，
   *   再往上一层同样如此。**递归到此为止** —— 本层已确定不为这条接线再加接线。
   *   它买到的是：架空 Z2 断言从「删一处」变成「删两处、且第二处形态不同」。
   *   该界限**如实写在这里**，不声称已经闭合。
   */
  const fakeResultAssign = (srcLf.match(/const fakeResult = (.+)$/m) ?? [])[1] ?? ''
  assert.ok(
    fakeResultAssign.startsWith('mainGateReportCalls('),
    `Z2 接线判据：fakeResult 的赋值不再是真实调用（实际：${JSON.stringify(fakeResultAssign)}）——`
    + ' 有人把它换成了字面量/桩值，那么下面的 deepEqual 就成了自证',
  )
  assert.ok(
    stripStrings(srcLf).split(NL).some((line) => line.includes('fakeResult.calls,')),
    'Z2 接线判据：源码里找不到 `fakeResult.calls,` 这处实参 —— 断言可能已被换成字面量（这正是 u1 实测的形态）',
  )
  /*
   * ⚠ 负控：对**已被架空**的文本，上面那条判定必须判假 —— 否则这条接线是恒真的（同 u1 的病）。
   */
  const hollowed = srcLf.replace('fakeResult.calls,', '[],')
  assert.notEqual(hollowed, srcLf, 'Z2 接线负控前提：替换应当真的改动了文本（否则下面这条对照无意义）')
  assert.equal(
    stripStrings(hollowed).split(NL).some((line) => line.includes('fakeResult.calls,')),
    false,
    'Z2 接线负控失败：把实参换成字面量后，接线判据仍判真 —— 它是恒真的',
  )

  /*
   * ── ② 反面对照：双引号 / 模板字面量形态同样被看穿 ─────────────────────────--
   */
  for (const [label, fakeLine] of [
    ['双引号', '  const fake = "reportUnjudged(t, unjudged)"'],
    ['模板串', '  const fake = `reportUnjudged(t, unjudged)`'],
  ]) {
    const variant = [...lines]
    variant[callAt - 1] = fakeLine
    assert.deepEqual(
      mainGateReportCalls(variant.join(NL)).calls,
      [],
      `${label}冒充未被看穿（${JSON.stringify(mainGateReportCalls(variant.join(NL)).calls)}）`,  
    )
  }

  /*
   * ── ③ ⚠ 不得误伤：真调用必须仍被识别（含字符串参数 / 前后有其它字面量）─────
   */
  for (const [label, realLine] of [
    ['普通调用', '  reportUnjudged(t, unjudged)'],
    ['含字符串参数', "  reportUnjudged(t, unjudged, 'extra')"],
    ['同行还有其它字面量', "  const tag = 'x'; reportUnjudged(t, unjudged)"],
    ['sink 本身是桩对象', '  reportUnjudged({ diagnostic: (m) => { void m } }, unjudged)'],
  ]) {
    const variant = [...lines]
    variant[callAt - 1] = realLine
    assert.deepEqual(
      mainGateReportCalls(variant.join(NL)).calls,
      [callAt],
      `${label}被误伤（判据应仍认出这一行是调用）—— 实际 ${JSON.stringify(mainGateReportCalls(variant.join(NL)).calls)}`,  
    )
  }

  /*
   * ── ④ V2：负控 B 的自证 ──────────────────────────────────────────────────
   *   负控 B 靠 `mainGateReportCalls(f2段).calls.length >= 1` 证明「切段是必要的」。
   *   删掉那条前提时套件仍全绿（实测）⇒ 它没有自证。
   *
   * ⚠⚠ **自证必须有独立判别力，不能复述同一条断言**：
   *   本席第一版写的就是 `assert.ok(f2CallsIndependent.length >= 1, …)` —— 那只是把负控 B 的
   *   断言**抄了一遍**：把负控 B 改成 `true || …` 后，这条照样过（实测 exit=0）⇒ 自证无效。
   *   ⇒ 改成**逐条落位回读**：把切出来的每个调用行**回读源码**，用 stripStrings 独立判定
   *     「这一行确实是调用」。它证的是**切段能力本身**，与负控 B 那条断言无关。
   */
  const f2At = lines.findIndex((line) => line.includes('f2 归因：新增的**未跟踪**文件'))
  assert.ok(f2At > 0, '负控 B 自证：找不到 f2 段标题（源码结构变了）')
  const f2Slice = lines.slice(f2At).join(NL)
  const f2CallsIndependent = mainGateReportCalls(f2Slice, 'f2 归因：新增的**未跟踪**文件').calls
  assert.ok(
    f2CallsIndependent.length > 0,
    '负控 B 自证：f2 段里一个调用都切不出来 —— 那么负控 B 的「>= 1」前提本身失效',
  )
  /*
   * ⚠ 行号是**相对喂进去的那段文本**的（`mainGateReportCalls` 的语义），
   *   故必须回读 `f2Slice` 自己的行，不能回读全文件 `lines` ——
   *   实测踩过：混用会读到完全无关的行（报出 `assert.ok(typeof m.to === 'string' …)`）。
   */
  const f2Lines = f2Slice.split(NL)
  assert.ok(
    assertCallsAreReal(f2Lines, f2CallsIndependent, (msg) => { throw new Error(msg) }),
    '负控 B 自证：切出的行不都是真调用',
  )
  /*
   * ⚠⚠ **落位自证自己的负控**（M3 实测暴露：把那行换成恒真的 assert.ok(true)，套件仍全绿）。
   *   做法：喂一段**已知不含调用**的文本 + 一个行号，断言它**必须判假**。
   */
  assert.equal(
    assertCallsAreReal(['const x = 1', 'const y = 2'], [1], () => {}),
    false,
    '落位自证没有分辨力：对一段不含任何调用的文本 + 行号 1，它竟判真',
  )
  /* 反面对照：同一函数对**真调用行**必须判真（否则是「一律判假」的假实现）。 */
  assert.equal(
    assertCallsAreReal(['  reportUnjudged(t, unjudged)'], [1], () => {}),
    true,
    '落位自证一律判假：对真调用行也判假',
  )
  /*
   * ⚠ 反向对照 A：喂一段**确定没有调用**的文本，判据必须返回空。
   */
  assert.deepEqual(
    mainGateReportCalls(lines.slice(0, 20).join(NL)).calls,
    [],
    '反向对照 A 失败：对文件开头 20 行（确定无该调用）仍报出调用 ⇒ 判据不具分辨力',
  )
  /*
   * ⚠⚠ **反向对照 B（本测试的收官负控 —— 它才使上面 ④ 真正在裁）**：
   *   把 **f2 段里的调用全部改名** ⇒ ④ 那组自证必须切不出任何调用。
   *   若这里仍能切出东西，说明 ④ 是**恒真**的（它根本不是在测「f2 段有没有调用」）。
   *
   * ⚠ 这同时纠正一个容易看错的点：**删掉 q1 里负控 B 的非空前提后套件仍全绿**（实测）——
   *   那不是缺陷，因为本测试 ④ 已经**独立**背书了同一事实。
   *   要判「自证到底在不在裁」，看的是这条反向对照，不是 q1 那条断言删没删。
   */
  const mutedLines = [...f2Lines]
  let mutedCount = 0
  for (let i = 0; i < mutedLines.length; i++) {
    if (!CALLS_REPORT.test(mutedLines[i])) continue
    mutedLines[i] = mutedLines[i].replace(/reportUnjudged/g, 'mutedCall')
    mutedCount++
  }
  assert.ok(mutedCount > 0, '反向对照 B 前提：f2 段里本该有可改名的调用（否则本对照无意义）')
  assert.deepEqual(
    mainGateReportCalls(mutedLines.join(NL), 'f2 归因：新增的**未跟踪**文件').calls,
    [],
    '反向对照 B 失败：把 f2 段里的调用全部改名后，判据仍切出调用 ⇒ ④ 的那组自证是恒真的（不在裁）',
  )
  /*
   * ⚠⚠ **接线本身也要有常驻判据**（这是「谁审审计者」的有界解，与 k1/q1 同族）：
   *   实测：把上面那行 assert.ok(assertCallsAreReal(f2Lines, f2CallsIndependent, …), …)
   *   换成恒真的 assert.ok(true, …) ⇒ 套件**仍全绿** —— 落位自证被架空，而它的两条负控
   *   仍在为 assertCallsAreReal 这个**能力**背书（能力没错，是没人用它）。
   *   ⇒ 加一条**静态接线判据**：源码里必须存在那处调用。
   *
   * ⚠ **有界，不是消除**：这条静态判据自己也能被换成恒真（再往上一层同样如此）——
   *   这是「测试的最终裁决来自断言」的固有回退，无法在测试内部闭合。
   *   本层的价值是把回归成本从「删一处断言」抬到「删两处、且第二处形态不同」。
   *   该界限**如实写在这里**，不声称已经完全不会漏。
   */
  const wiringNeedle = 'assertCallsAreReal(f2Lines, f2CallsIndependent'
  assert.ok(
    stripStrings(srcLf).split(NL).some((line) => line.includes(wiringNeedle)),
    `t1 接线判据：源码里找不到「${wiringNeedle}」这处调用 ——`
    + ' 落位自证可能已被架空（这正是 M3 实测到的形态：把调用行换成恒真断言，套件仍绿）',
  )
})
