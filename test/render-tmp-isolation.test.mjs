/**
 * 渲染产物共享目录（test/.render-tmp/）的**归属判据**。
 *
 * ## 判因（本会话四席独立撞到）
 *
 * 三处渲染测试各自 mkdtempSync 到**同一个**父目录，而目录名里不含任何归属信息
 * （composer-XXXX / badge-XXXX / run-XXXX）。node --test 默认**多进程并发**，
 * 于是"父目录里这个子目录是谁的"**不可判** —— 只能靠 mtime 猜，四席各自把对方的在途目录
 * 报成残留。父目录共享本身**是对的**（产物必须留在仓库内，否则 Node 找不到本仓 react，
 * 移出仓库 = 拆东墙补西墙）；缺陷是**清理归属不可判别**。
 *
 * ## 本文件判什么
 *
 * ① 口径函数（render-tmp-sandbox.mjs）：名字 → 归属 → 三桶（own / foreign / stale），
 *    含"名字不可解析"与"EPERM 视为存活"两类边界，用**聚合夹具**证明判别力（不拿真实盘面当证据）；
 * ② 存活探测：真起一个子进程 / 真等它退出，两个方向各一次（不是断言"函数存在"）；
 * ③ makeRenderTmpDir 的真实盘面：目录落在仓库内、名字带本进程 pid、清理后自己那份消失；
 * ④ 真实盘面的**所有格**：本进程自己那份必须为空（陈旧项只报红不抛出，见下）；
 * ⑤ **覆盖规则**（机检，防新文件抄回旧写法）：凡 test/*.test.mjs 里自己 mkdtempSync
 *    到 .render-tmp 的，目录名必须带归属（process.pid 或沙箱函数）。
 *
 * ## 与 mutation-probe-health.test.mjs R2 条的关系（分工，不重叠）
 *
 * R2 管的是"跑完有没有留"，且它对**新鲜项一律放过**（靠 mtime 猜，已如实登记为已知边界）。
 * 本条管的是"**谁**留下的" —— 归属一经确定，mtime 就不再参与判定：
 * 归属进程已退出 ⇒ 一定是残留，与本进程是不是同时在跑无关。
 * 两条各自成立，本文件**不改** R2（改它属另一席的处置面）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RENDER_TMP_DIR,
  makeRenderTmpDir,
  parseRenderTmpOwner,
  isPidAlive,
  classifyRenderTmp,
  scanRenderTmp,
} from './render-tmp-sandbox.mjs'

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url))

/* ── ① 名字 → 归属 ─────────────────────────────────────────────────────────── */

test('归属单元：<pid>-<tag>-<rand> 可解析；缺 pid / 非数字 pid / 旧式无归属名一律 null（不可证）', () => {
  assert.deepEqual(parseRenderTmpOwner('12345-composer-a1b2c3'), { pid: 12345, tag: 'composer' })
  assert.deepEqual(parseRenderTmpOwner('7-composer-panel-Zz9'), { pid: 7, tag: 'composer-panel' })
  // 旧式名字（本判据要消灭的形态）：读不出归属 ⇒ 必须判 null，而不是"顺手当成自己的"
  assert.equal(parseRenderTmpOwner('composer-Xy12ab'), null, '旧式前缀名没有 pid，归属不可证')
  assert.equal(parseRenderTmpOwner('run-Ab12Cd'), null)
  assert.equal(parseRenderTmpOwner('abc-composer-a1b2c3'), null, 'pid 非数字 ⇒ 归属不可证')
  assert.equal(parseRenderTmpOwner('12345-composer-'), null, '缺随机后缀 ⇒ 不是本模块建的')
  assert.equal(parseRenderTmpOwner('12345--a1b2c3'), null, '缺 tag ⇒ 不是本模块建的')
})

test('归属单元：三桶边界由聚合夹具一次钉死（own / foreign 存活 / foreign 已死 / 不可证）', () => {
  const entries = [
    { name: '100-composer-aaaaaa' },   // 本进程
    { name: '200-badge-bbbbbb' },      // 他方，存活
    { name: '300-panel-cccccc' },      // 他方，已退出
    { name: 'composer-legacy000' },    // 旧式名，归属不可证
  ]
  const { own, foreign, stale } = classifyRenderTmp(entries, {
    selfPid: 100,
    isAlive: (pid) => pid === 200,
  })
  assert.deepEqual(own.map((e) => e.name), ['100-composer-aaaaaa'], 'pid 相等只可能是本进程自己')
  assert.deepEqual(foreign.map((e) => e.name), ['200-badge-bbbbbb'], '他方存活 ⇒ 不算残留（这一条就是"不互数"）')
  assert.deepEqual(
    stale.map((e) => e.name),
    ['300-panel-cccccc', 'composer-legacy000'],
    '归属进程已退出 / 归属不可证，都无人会再收它 ⇒ 残留',
  )
  // 反向：把"存活"一律判死 ⇒ foreign 必须为空（证明 isAlive 这一个输入真的在裁结论，不是摆设）
  const allDead = classifyRenderTmp(entries, { selfPid: 100, isAlive: () => false })
  assert.deepEqual(allDead.foreign, [], '把存活探测架空成恒假后，foreign 必须为空')
  assert.equal(allDead.stale.length, 3, '架空后剩下的三项都进残留桶')
})

/* ── ② 存活探测：真起进程 / 真等退出 ────────────────────────────────────────── */

test('存活探测（真机双向）：存活子进程 ⇒ 真；已退出子进程 ⇒ 假', () => {
  const exited = spawnSync(process.execPath, ['-e', '0'])
  assert.equal(isPidAlive(exited.pid), false, '已退出的子进程必须判死（否则残留永远被当成"在途"）')

  const live = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' })
  try {
    assert.equal(isPidAlive(live.pid), true, '存活子进程必须判活')
    assert.equal(isPidAlive(process.pid), true, '本进程自己必须判活')
  } finally {
    live.kill('SIGTERM')
  }
  // 边界：非法 pid 不抛异常、判死（否则一条坏目录名能把整轮测试打断）
  assert.equal(isPidAlive(0), false)
  assert.equal(isPidAlive(-1), false)
  assert.equal(isPidAlive(Number.NaN), false)
})

/* ── ③ makeRenderTmpDir：落在仓库内 + 名字带归属 + 清理干净 ─────────────────── */

test('建目录：落在仓库内、名字带本进程 pid、cleanup 后自己那份消失', () => {
  const { dir, cleanup } = makeRenderTmpDir('sandbox-selftest')
  try {
    assert.ok(dir.startsWith(RENDER_TMP_DIR), '产物必须落在仓库内的共享父目录（%TEMP% 下解析不到本仓 react）')
    const name = dir.slice(RENDER_TMP_DIR.length)
    const owner = parseRenderTmpOwner(name)
    assert.notEqual(owner, null, '本模块建的目录名必须能被解析出归属：' + name)
    assert.equal(owner.pid, process.pid, '归属必须是**建它的那个进程**')
    assert.equal(owner.tag, 'sandbox-selftest', 'tag 必须进目录名（人读盘时能分辨用途）')
    assert.ok(existsSync(dir), '目录必须真的建出来了')
  } finally {
    cleanup()
  }
  assert.equal(existsSync(dir), false, 'cleanup 必须只清自己那一份')
  assert.ok(existsSync(RENDER_TMP_DIR), '共享父目录本身不得被 cleanup 带走（别席还在用）')
})

test('建目录：非法 tag 必须抛（名字里塞进不可解析字符 = 归属又变得不可判）', () => {
  assert.throws(() => makeRenderTmpDir('bad/tag'), /只允许字母/)
  assert.throws(() => makeRenderTmpDir('坏的'), /只允许字母/)
})

/* ── ④ 真实盘面：自己那份必须为空 ─────────────────────────────────────────── */

const renderBucket = (list) => list.map((e) => e.name + '（' + e.why + '）').join('、')

/**
 * 盘面门。
 *
 * ⚠ **必须抽成函数**（c3 修：判因由 verify 给出、本席复核成立）：判定原先内联在 test 体里，
 *   于是"造一个 stale 项再断言它红"这件事**在结构上无法发生** —— 夹具调不到 test 体内的判定。
 *   后果实测：本仓两轮全量运行时 `test/.render-tmp` = `[]`，该门**在空盘面上恒真**
 *   （`[] === []`），与"判过了"不可分辨。抽成函数后，⑥ 的盘面夹具可以直接对着它造红/清绿。
 *
 * @param {Array<object>|null} entries 盘面项；`null` = 目录不存在（**显式**：不算通过、也不算红）
 */
function assertNoOwnResidue(entries) {
  if (entries === null) {
    // 目录不存在**不算红**：全新克隆上它就是不存在。但必须**显式**说明本次是"没有目录"，
    // 否则"没判"会被读成"判过了"（与 R2 同一口径）。
    assert.equal(existsSync(RENDER_TMP_DIR), false, '目录不存在必须是真的不存在')
    return
  }
  const { own, foreign, stale } = classifyRenderTmp(entries, { selfPid: process.pid })
  assert.deepEqual(
    own.map((e) => e.name),
    [],
    '本进程自己的临时目录残留：' + renderBucket(own) + ' —— 本判据体自己就是全体渲染测试的样例，'
    + '这里非空说明某个 loadTsx 的 cleanup 没走到（try/finally 被拆了？）',
  )
  if (foreign.length > 0) {
    globalThis.process.stderr.write(
      'ℹ render-tmp 归属判据：另有 ' + foreign.length + ' 项属**活着的他方进程**：' + renderBucket(foreign)
      + '\n  （未判红 —— 这正是"并发跑两个渲染测试不再互数"的落点。）\n',
    )
  }
  /*
   * ⚠ stale（归属已消失）**当场判红**，不再只是出声 —— 这是 c3 的第二处修正。
   *
   * 改前：stale 只 `process.stderr.write` ⇒ 盘面上真有"死进程留下的目录"时，退出码仍是 0。
   * 实测（本席 c3 前）：盘上放 `999999-panel-deadprobe`，跑本文件得 7/7 pass、exit 0 ——
   * **门看着它、却裁不动它**，正是本仓反复剿的"失败不可观测"。
   * 改后：同一次读数必须红（见 ⑥ 的盘面夹具，那条夹具就是这条断言的常驻形态）。
   *
   * 为什么现在敢判红（前三轮不敢的理由已不成立）：判别不再依赖 mtime 猜测，
   * 而归**属进程已退出**是客观事实 —— 它不可能是"在途并发"，故不会误伤并发方。
   */
  assert.deepEqual(
    stale.map((e) => e.name),
    [],
    '归属已消失的遗留（不可能是并发窗口）：' + renderBucket(stale)
    + ' —— 归属进程已退出，没有任何活进程会再收它。清掉后再跑；'
    + '若是历史遗留（旧式无归属名），删除该目录即可（.render-tmp/ 被 .gitignore 忽略，对 git 面零影响）。',
  )
}

/* ── ⑥ 盘面夹具：造 stale 必红 / 清掉回绿（让 ④ 不再在空盘面上恒真）────────────── */

/**
 * 造一个**归属已消失**的盘面项：pid 取一个不可能存在的值（`isPidAlive` 会判死）。
 *
 * ⚠ 用真盘面而不是 mock：内存夹具（§① 那条）证明的是**谓词**的判别力，
 *   而这里要证的是"**门自己**在真盘面上会红" —— `scanRenderTmp` → `classifyRenderTmp` →
 *   `assertNoOwnResidue` 整条链路一起动。两者的失败模式不同（mock 绿而真链路断是常态）。
 * ⚠ `finally` 里必清：夹具自己造残留又不清，就把这条门变成了它要剿的那种缺陷。
 */
function withDeadOwnerEntry(fn) {
  mkdirSync(RENDER_TMP_DIR, { recursive: true })
  const dir = join(RENDER_TMP_DIR, '999999-c3fixture-dead')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  try {
    return fn()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('盘面夹具：stale 项必须被判红（改前：只出声、exit 0 —— 实测漏判）；清掉即回绿', () => {
  // 阳性方向：盘上真有一个"归属进程已退出"的目录 ⇒ 门必须红
  const boom = withDeadOwnerEntry(() => {
    try {
      assertNoOwnResidue(scanRenderTmp())
      return null
    } catch (error) {
      return error
    }
  })
  assert.notEqual(boom, null, '盘面上有 stale 项时，门**必须**判红 —— 判不红就是"看着它、裁不动它"')
  assert.match(boom.message, /999999-c3fixture-dead/, '红的时候必须点名是哪一项（给不出位置的红等于没红）')
  assert.match(boom.message, /归属进程已退出/, '红必须说清判据（是"归属已消失"，不是"看着像残留"）')
  // 阴性方向：夹具清掉后同一判定必须回绿（证明上面的红**确实由该项造成**，不是门本就常红）
  assertNoOwnResidue(scanRenderTmp())
})

/* ── ⑦ 覆盖规则：新文件不得抄回"无归属"的写法 ────────────────────────────── */

/**
 * 去掉行内的注释与**字符串字面量**，只留可判的代码骨架。
 *
 * ## 为什么必须剔（本席 c3 实测，两处都踩到）
 *
 * ① **注释**：改前的审面拿整份文件的整行去匹配，而**本文件自己的注释**里就写着
 *    `mkdtempSync(join(tmpdir(), SCRATCH_PREFIX))` 与"修法：…mkdtempSync(join(TMP_DIR, …))"
 *    —— 注释成了审面的替身（本仓剿过两次的"锚点被注释冒充"，这里是第三种形态：
 *    注释既能把别处误报成违规，也能让真正的违规行看着"已经审过了"）。
 * ② **字符串**：⑦ 的自证用例把违规源码**当字符串字面量**写在测试里，若不剔字符串，
 *    那条用例自己就会入面（自指）。剔掉字符串后，夹具里的代码片段不再被当成真调用，
 *    而真实调用的判定不受影响（调用点的目录名字符串本来就只是第二实参）。
 *
 * ⚠ 判定用的是"剔后"的骨架，但**变量声明要在原 src 上查**（声明里的
 *   `'./.render-tmp/'` 正是字符串，剔了就查不到 —— 那会让改名形态又逃逸）。
 */
function stripStrings(line) {
  return line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

/**
 * 去掉**块注释**与整行注释。
 *
 * ⚠ 必须**按整份源**去，不能逐行去（c3 第三次踩到同一形态）：块注释跨行，
 *   逐行的块注释正则对跨行的那几行无效 ⇒ **本文件自己的文档注释**里写的
 *   `mkdtempSync(join(HOLD, 'offender-'))` 会入面，变成"注释冒充锚点"的第三种形态
 *   （前两种：注释让判据恒真 / 让真违规看着已审）。
 */
function stripBlockComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, ' ')
}

/**
 * 判定"这个文件里哪些**建临时目录的行**是往共享渲染目录建的"。
 *
 * ## 入面口径：按**行为**（建目录的去向），不按变量名/文件名（c3 第三条修正）
 *
 * 改前要求该行**字面**出现 `TMP_DIR` / `render-tmp` / `makeRenderTmpDir` ——
 * 于是"把变量改个名"（`const HOLD = fileURLToPath(new URL('./.render-tmp/', …))`
 * 再 `mkdtempSync(join(HOLD, 'offender-'))`）就**整份漏审**。
 * **实测（c3 前，同一种违规、只把变量名换掉）：本门 7/7 全绿，违规文件被判通过。**
 * 现在入面只问一件事：该行建的目录**是不是共享目录** ——
 *   · `mkdtempSync(join(<变量>, …))` ⇒ 去原 src 里查 `<变量>` 的声明是否指向 `render-tmp`；
 *   · `mkdtempSync(join('<字面路径含 render-tmp>', …))` ⇒ 直接入面；
 *   · `makeRenderTmpDir(…)` ⇒ 入面（它就是本共享目录的沙箱函数）。
 * **明确排除**（c3 实测红）：`mkdtempSync(join(tmpdir(), SCRATCH_PREFIX))`
 * （`mutation-probe-health.test.mjs:950`）是**系统临时目录**，属 mutate 沙箱那条线
 * （`test/mutate.mjs:80`），与本目录无关 —— 只按"第一实参是不是 render-tmp"取，故不误报。
 *
 * @param {string} src 文件源码
 * @returns {{ text: string, code: string }[]}
 */
function renderTmpMkdtempLines(src) {
  const out = []
  const noComments = stripBlockComments(src)
  for (const raw of noComments.split(/\r?\n/)) {
    const code = stripStrings(raw)
    if (!/\bmkdtempSync\s*\(|\bmakeRenderTmpDir\s*\(/.test(code)) continue
    if (/\bmakeRenderTmpDir\s*\(/.test(code)) { out.push({ text: raw.trim(), code }); continue }
    if (/\bmkdtempSync\s*\(\s*join\s*\(\s*['"][^'"]*render-tmp/.test(code)) {
      out.push({ text: raw.trim(), code }); continue
    }
    const m = /\bmkdtempSync\s*\(\s*join\s*\(\s*([A-Za-z_$][\w$]*)/.exec(code)
    if (m === null) continue
    // 变量声明在**去注释后**的源上查（声明里的路径是字符串，剔字符串时会被抹掉）
    const decl = new RegExp('(?:const|let|var)\\s+' + m[1] + '\\s*=[\\s\\S]{0,120}?render-tmp')
    if (decl.test(noComments)) out.push({ text: raw.trim(), code })
  }
  return out
}

/**
 * 审一个文件：入面了就按"目录名必须带归属"裁。
 *
 * @param {string} src 文件源码
 * @param {string} file 文件名（只用于报告）
 * @param {{ isCallOverride?: (line: string) => boolean }} [opts] 仅自证用：便于把谓词架空后对照
 * @returns {{ audited: boolean, offenders: string[] }}
 */
function auditRenderTmpOwnership(src, file, opts = {}) {
  let calls = renderTmpMkdtempLines(src)
  if (opts.isCallOverride !== undefined) {
    // 架空形态：把"入面谓词"换成给定实现（自证用，用来证明谓词真的在裁结论）
    calls = stripBlockComments(src).split(/\r?\n/)
      .filter((l) => opts.isCallOverride(stripStrings(l)))
      .map((l) => ({ text: l.trim(), code: stripStrings(l) }))
  }
  if (calls.length === 0) return { audited: false, offenders: [] }
  const importsSandbox = /from '\.\/render-tmp-sandbox\.mjs'/.test(src)
  const offenders = []
  for (const call of calls) {
    // 走沙箱函数的：import 了就算合规（pid 由沙箱负责）；原地写的：必须自己把 pid 拼进名字
    const ok = /\bmakeRenderTmpDir\s*\(/.test(call.code)
      ? importsSandbox
      : call.code.includes('process.pid')
    if (!ok) offenders.push(file + '：' + call.text)
  }
  return { audited: true, offenders }
}
test('覆盖规则：凡**自己 mkdtemp 到 .render-tmp** 的文件都在审面内，且目录名必须带归属', () => {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs'))
  const offenders = []
  const audited = []
  for (const file of files) {
    const src = readFileSync(join(TEST_DIR, file), 'utf8')
    const verdict = auditRenderTmpOwnership(src, file)
    if (!verdict.audited) continue
    audited.push(file)
    offenders.push(...verdict.offenders)
  }
  /*
   * ⚠ 下限取 **2**（不是 3）：入面口径改成"按行为"以后，`chat-composer` / `mode-badge`
   *   两处**只 import 沙箱函数**（`makeRenderTmpDir` 在沙箱模块里，不在它们源文件里），
   *   它们不再入面 —— 这不是漏审，而是**审面收敛到了唯一实现处**：
   *   沙箱模块自身的 `process.pid` 由 §③ 那条单元直接裁，两处调用方由"import 即合规"批处理。
   *   故实打实入面的就是 `dispatch-panel-render`（原地写法）与**本文件自己**
   *   （它用 `makeRenderTmpDir`）+ 上面对沙箱模块 §③ 的直裁，合起来覆盖三处调用点。
   */
  assert.ok(
    audited.length >= 2,
    '至少要审到两处**真在往共享目录建临时目录**的文件（自审失败：检查面本身消失了？）实际 '
    + audited.length + '：' + audited.join('、'),
  )
  assert.deepEqual(
    offenders,
    [],
    '以下位置的临时目录名**不带归属**：\n  ' + offenders.join('\n  ')
    + '\n⇒ 目录名读不出 pid，"这是残留还是别人的在途"又变回不可判（本会话四席各自撞到的形态）。'
    + '\n修法：改用 test/render-tmp-sandbox.mjs 的 makeRenderTmpDir(tag)，'
    + '或就地写成 mkdtempSync(join(TMP_DIR, process.pid + 中划线 + tag))。',
  )
})

test('覆盖规则自证：违规源必须被判为违规（谓词恒真则本门空转 —— 必须抓住）', () => {
  /*
   * 判因（c3 第二条）：⑦ 的谓词本身就是判据，而它**从没被负控撞过**。
   * 用手写的违规源（两种形态）直接撞 `renderTmpMkdtempLines` + 入面口径，
   * 不碰磁盘、不依赖别处有没有违规文件 —— 空盘面上也照样判。
   */
  const isViolation = (src, name) => auditRenderTmpOwnership(src, name).offenders.length > 0
  // 形态 A：旧式前缀名（本会话撞到的原形）
  assert.equal(
    isViolation(
      "const TMP_DIR = new URL('./.render-tmp/', import.meta.url)\n"
      + "const d = mkdtempSync(join(TMP_DIR, 'composer-'))\n",
      'legacy-prefix',
    ),
    true,
    '旧式前缀名必须判违规 —— 判不出来就是谓词恒假/审面为空',
  )
  // 形态 B：**只改变量名**（c3 前整份漏审的那一种）
  assert.equal(
    isViolation(
      "const HOLD = fileURLToPath(new URL('./.render-tmp/', import.meta.url))\n"
      + "const d = mkdtempSync(join(HOLD, 'offender-'))\n",
      'renamed-var',
    ),
    true,
    '只把变量改名不得逃逸 —— 入面按行为取，不按变量名取',
  )
  // 阴性：合规写法（沙箱函数 / 原地拼 pid）不得被误报
  assert.equal(
    isViolation("import { makeRenderTmpDir } from './render-tmp-sandbox.mjs'\nconst { dir } = makeRenderTmpDir('composer')\n", 'sandbox'),
    false,
    '走沙箱函数的合规写法不得被误报为违规',
  )
  assert.equal(
    isViolation("const d = mkdtempSync(join(TMP_DIR, process.pid + '-panel-'))\n", 'inline-pid'),
    false,
    '原地拼 pid 的合规写法不得被误报为违规',
  )
  // 阴性：非渲染目录（系统临时目录）不属本条射程 —— 不得把它算进来
  assert.equal(
    isViolation("const dir = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX))\n", 'system-tmp'),
    false,
    '系统临时目录是另一条线（mutate 沙箱），不属本条射程',
  )
  /*
   * 反向自证：把谓词**架空成恒真**（下面的 `hollowedIsCall` 就是那种形态 ——
   * 它认任何一行）后，合规写法会被误报 ⇒ 上面那条阴性断言会红。
   * 这里只断言"两种谓词在合规源上给出**不同**结论"，把"谓词真的在裁"变成可机检事实。
   */
  const hollowedIsCall = () => true
  const sandboxSrc = "import { makeRenderTmpDir } from './render-tmp-sandbox.mjs'\nconst { dir } = makeRenderTmpDir('composer')\n"
  const realVerdict = auditRenderTmpOwnership(sandboxSrc, 'sandbox').offenders.length
  const hollowedVerdict = auditRenderTmpOwnership(sandboxSrc, 'sandbox', { isCallOverride: hollowedIsCall }).offenders.length
  assert.notEqual(
    realVerdict,
    hollowedVerdict,
    '真谓词与"恒真谓词"必须给出不同结论 —— 相同说明真谓词已被架空（本门从此空转）',
  )
})
