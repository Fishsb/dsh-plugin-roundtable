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
import { readFileSync } from 'node:fs'

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
