/**
 * 变异探针：把实现精确改坏一处，跑测试看对应守卫是否**真的转红**。
 *
 * 为什么要这个："断言写了"与"断言有效"是两件事 —— 本仓已经踩过两次假绿
 * （锚点字符串同时出现在注释里、断言被挂载路径那次冒充）。
 *
 * 用法：node test/mutate.mjs <编号>
 *
 * ## 沙箱纪律（2026-09-25 留毒事故后的根因修法）
 *
 * 旧实现把变异**写进真实源文件**（`writeFileSync`），靠 `finally` 还原。两条实测缺陷：
 *   ① **进程被杀即留毒** —— `SIGKILL`／超时／被 `taskkill` 时 `finally` **不执行**
 *      （实测：起 `node test/mutate.mjs 1`，3 秒后强杀，`src/snapshot.ts` 留在变异态，
 *      sha256 `677DCA96…` ≠ 基线 `CD8C9FAD…`）；
 *   ② **并发互踩，且"还原"还原到的是别人的变异体** —— A 读到基线、B 读到 A 的变异体，
 *      B 的 `finally` 把 **A 的变异体**写回，盘上留毒而两个进程都自报成功。
 *      上一轮真实事故（`src/tools.ts:1443` 留成 `&& false`、后续一席把**带毒快照**
 *      "逐字节还原"并自证通过）正是这个形态。
 *
 * ⇒ 修法**不是**"再加一道兜底"，而是让写盘这件事**只发生在一次性的私有副本里**：
 *   本进程启动时先把仓库**拷进系统临时目录的一份沙箱**（`src/`+`test/`+`lib/`+`.git/`+配置，
 *   `node_modules` 走 junction 不复制），然后在**那份副本里**重跑本脚本（`MUTATE_SANDBOX_ROOT`
 *   指回副本根）。写与还原都作用在副本上：
 *   · 真实仓库**全程零写入** ⇒ 被杀、超时、被 taskkill 都没有毒可留；
 *   · 两个实例各拿各的副本 ⇒ 不存在"A 的变异体被 B 当成基线还原回去"的互踩；
 *   · 判据与既有的"无残留门"（与 HEAD 比）**天然一致**：真实树没动就不会红。
 *
 * ## 为什么不是"加载期钩子在内存里改源码"（已实测否掉，留档免得被重新提出）
 *
 * `node:module` 的 `registerHooks` + `--import` 确实能改**运行时 import 到的模块**，
 * 而且不碰磁盘。但它**只够覆盖本仓的一部分守卫**：本仓多数守卫是**读源码文本**的
 * 源码级护栏（`readFileSync('../src/x.ts')`，读的是磁盘字节），钩子改的是内存里的模块，
 * 它们看不见 ⇒ 那类变异在钩子形态下**恒绿**。全表 39 条实测（同一沙箱、同一命令）：
 *   · 钩子形态：PASS 9 ／ FAIL 14（"看见"了）／ **BLIND 16（模块根本没被 import）**；
 *   · 副本形态：**PASS 39 ／ FAIL 0 ／ 盲区 0**。
 * ⇒ 钩子形态会把 33 条已经有效的守卫读成"测不到"，代价远超收益，故不采用。
 *   （`process.stderr.write` 层面的 `fs.readFileSync` 补丁同样不行：本仓测试用的是
 *   **具名导入** `import { readFileSync } from 'node:fs'`，补丁只对 default 导入可见。）
 *
 * ## 边界（写清楚，免得被当成"全仓无残留"的保证）
 *
 *   · 沙箱目录在系统临时目录，**跑完即删**；被杀时会留一份**临时**副本（不是仓）。
 *     它不含真实仓库的写操作，留着也无毒；可由系统临时目录清理规则回收。
 *   · 副本里的 `.git` 是必需的：`npm test` 里的「无残留门」要拿 `git show HEAD:<path>` 当基线。
 *   · 沙箱自检（写盘前的最后一道）：内层进程断言「沙箱根 ≠ 真实仓库根」且
 *     沙箱根形如 `<tmp>/mutate-sandbox-*`，否则拒绝运行（exit 5）。
 *   · **外层跑前/跑后对真实仓库的整个 `src/` 逐文件取 sha256 并打印比对**：
 *     有任何差异即 exit 6 —— "没留毒"是实测结论，不是自述。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 由本文件所在位置推出的**仓库真实根**（沙箱自检与拷贝源都用它）。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/*
 * ══════════════════════════════════════════════════════════════════════════════
 * 沙箱引导（2026-09-25 根因修法）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 第一次进入（`MUTATE_SANDBOX_ROOT` 未设）：拷贝一份私有副本，设好根变量，
 * **用 `node:child_process` 在副本里重跑本脚本**——此后所有写入都只在副本里发生。
 * 第二次进入（变量已设）：什么都不拷，直接在副本里干活。
 *
 * 为什么用"拷贝 + 重跑"而不是"在内存里改模块"：见文件头「为什么不是加载期钩子」。
 */
const SANDBOX_ENV = 'MUTATE_SANDBOX_ROOT'

/** 拷贝清单：`src/` 是被写的对象，`test/`+`lib/` 是被测面，`.git/` 是无残留门的基线来源。 */
const COPY_DIRS = ['src', 'test', 'lib', 'scripts', '.git']
/** 与行尾契约有关的文件（副本里也必须同源，否则副本自己的门会红）。 */
const COPY_FILES = ['package.json', 'cordis.patch.yml', '.gitattributes']

/** 建一份副本并返回其根路径（`node_modules` 用 junction，不复制，省 72 MB / 2200 个文件）。 */
function makeSandbox() {
  const root = join(tmpdir(), `mutate-sandbox-${process.pid}-${Date.now().toString(36)}`)
  mkdirSync(root, { recursive: true })
  /*
   * ⚠ 建副本**半途失败**时，已 `mkdir` 的那个空目录会留下来（2026-09-25 实测补）：
   *   外层只有一个 "副本建好了" 的变量，失败时它是 `null` ⇒ 没人知道该删哪个目录，
   *   `%TEMP%` 就攒下一堆 `mutate-sandbox-*`（实测留下 1 份）。
   *   ⇒ 失败时**当场**把半成品删掉，并把"删不掉的那份"路径挂到错误上，
   *     让外层能如实点名（而不是把 `null` 当路径交给 `rmSync`）。
   *   `rmSync` 在这里**也必须**包 try：失败原因要随错误一起传出去，不能反过来吞掉原始错误。
   */
  let current = null
  try {
    for (const dir of COPY_DIRS) {
      const from = join(repoRoot, dir)
      if (!existsSync(from)) continue
      current = dir + '/'
      cpSync(from, join(root, dir), { recursive: true, preserveTimestamps: true })
    }
    for (const file of COPY_FILES) {
      const from = join(repoRoot, file)
      if (!existsSync(from)) continue
      current = file
      cpSync(from, join(root, file), { preserveTimestamps: true })
    }
    current = 'node_modules（junction）'
    symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'junction')
  } catch (error) {
    let leftover = null
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch (cleanupError) {
      leftover = root
    }
    const wrapped = error instanceof Error ? error : new Error(String(error))
    wrapped.halfBuiltSandbox = leftover
    /*
     * ⚠ **点名"卡在哪一步"**（2026-09-25 · N2）：
     *   `cpSync` 失败时的 message 只到**目标目录**级（实测裸 `EPIPE`，
     *   `path` 停在 `…\mutate-sandbox-xxx\lib`，**指不出**是哪个源文件），
     *   而本函数的注释一度自述"已点出具体是哪一项" —— **注释与实测矛盾**。
     *   ⇒ 由拷贝循环自己把**正在拷的那一项**（`current`）记下来，随错误传出去；
     *     调用方渲染告警时优先用它。这样"点不出"就变成"点得出"。
     *   ✅ **订正为"已修"（2026-09-25 · 独立复核席实测两种粒度）**：
     *     · 独占 `lib/index.js` ⇒ 告警印「卡在哪一步：**lib/**」；
     *     · 独占 `package.json` ⇒ 告警印「卡在哪一步：**package.json**」，且原始 message 带**真实源路径**。
     *     本席此前把它标成"拿不到触发用例"属**保守过度**（我用于构造的 `lib/index.js` 独占
     *     恰好没让 `cpSync` 失败），该标注不成立，已撤销。
     */
    wrapped.failedCopyStep = current
    throw wrapped
  }
  return root
}

/**
 * `src/` 下每个文件的 sha256 清单（`相对路径 → 摘要`）。
 *
 * 用途：外层在跑副本前后各取一次，**逐文件比对**真实仓库有没有被动过。
 * 为什么按目录取而不是只取本变异的目标文件：目标文件要从变异表里查，而变异表
 * 定义在本块**之后**（会撞 TDZ）—— 顺带这条也更严：任何一个 src 文件被改动都抓得到。
 */
function srcDigest(root) {
  const map = new Map()
  const unreadable = []
  /*
   * **存在性**与**可读性**必须分开（2026-09-25 · N1）。
   * 为什么：N1 的根因正是把两者混为一谈 —— 读不到 ⇒ 不进 `map` ⇒ 对比时被读成
   * 「这个文件**消失**了」⇒ 落进最高严重度分支 ⇒ **假 exit 6**。
   * 实测（本席，延迟 1.8 s 用 `FileShare.None` 独占真实 `src/snapshot.ts`，
   * 该文件锁前后 sha256 均为 `cd8c9fad…`、**从未被改动**）：
   *   `status=6` + stderr `⚠ 沙箱失效：… src/snapshot.ts（消失）`。
   * ⇒ 撤销一个存在的文件，与读不出一个存在的文件，是两件事，必须两张表。
   *   `present` = `readdir` 看到的路径集合（与能不能读出字节无关）；
   *   `map`      = 真的读出字节的那些。
   */
  const present = new Set()
  const walk = (relative) => {
    const dir = join(root, relative)
    if (!existsSync(dir)) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      /*
       * 目录本身列举失败（不是文件）：与文件同一个口径 —— 记进 `unreadable`、
       * 从 `present` 里**整体缺席**，交给调用方按缺项告警；**绝不**让异常冒泡到
       * 结论之前（否则外证行又会不可达，那正是 g1/A1 一路在剿的形态）。
       */
      unreadable.push({ path: `${relative === '' ? 'src' : relative}/`, why: `目录列举失败 — ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}` })
      return
    }
    for (const entry of entries) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) { walk(next); continue }
      present.add(next)
      /*
       * ⚠ **读不到 ≠ 没差异**（2026-09-25 · 同一条命题的第二个入口，g1 修好清理后暴露出来）：
       *   `readFileSync` 在 Windows 上会因杀毒软件／索引器／别席门禁持有独占句柄而抛
       *   **EBUSY**。旧实现让它直接冒泡 ⇒ 进程崩在调用点，**外证行照旧不可达** ——
       *   与 g1 修的 `finally` 是**同一条命题的两个入口**，只修一个等于给刚修好的保证又开一个洞。
       *   实测（本席，`FileShare.None` 独占 `src/snapshot.ts`）：
       *     `status=1 / stdoutBytes=0 / hasProof=false`，
       *     堆栈 `at walk (test/mutate.mjs:109:49) → at srcDigest (:112:3) → at :154:18`。
       *   ⇒ 降级为**可读的缺项**：读不到的文件进 `unreadable`，**不进** `map`。
       *
       *   ⚠⚠ **降级绝不能变成假绿**：把"读不到"当成"零差异"会让外证退化成一条恒真读数。
       *   所以这里只**记录**缺项，判定与文案由调用方负责 —— 外层会把"有缺项"与"零差异"
       *   **分开渲染**，且**不给** exit 6 的通过（见外层的三分支）。
       */
      try {
        map.set(next, createHash('sha256').update(readFileSync(join(root, next))).digest('hex'))
      } catch (error) {
        unreadable.push({ path: next, why: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
      }
    }
  }
  walk('src')
  return { map, unreadable, present }
}

/**
 * 删副本；**永不抛**，返回失败原因（成功返回 `null`）。
 *
 * 为什么把 `rmSync` 包起来而不是直接调用（2026-09-25 · 本条修法的核心）：
 *   Windows 上删一个刚被 `execFileSync` 用过的目录会命中 **EPERM/EBUSY**（杀进程、
 *   文件句柄尚未释放）。旧实现把它放在 `finally` 里 ⇒ **异常从 finally 抛出，
 *   其后的 sha 比对与 `沙箱外证` 行整段不执行** ⇒ 「修的是留毒，但留毒存在时它报不出来」。
 *   ⇒ 这里把"清理"降级为**可失败的收尾**：它**只能**返回一个原因字符串，
 *     绝不能以异常形式改变本进程的结论（退出码由外证比对决定）。
 *   `maxRetries` 保留：绝大多数 EPERM 是瞬时的，重试三次能自愈；治不好的那一次才报警。
 */
function cleanupSandbox(sandbox) {
  /*
   * `null` = 外层根本没建起副本 —— 没有东西可删，**直接返回 null（成功态）**。
   * 不加这一句会走到 `rmSync(null)` → `TypeError: The "path" argument must be of type string`，
   * 实测会把"外证未取得"这条真告警**污染**成一条假故障（2026-09-25 踩到并修）。
   */
  if (sandbox === null || sandbox === undefined) return null
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 })
    return null
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
}

/**
 * 两份清单的差异（空数组 = 逐文件逐字节一致）。
 *
 * ⚠ **只比两侧都读出字节的文件**（2026-09-25 · N1 修法）。
 *   旧版直接判 `!after.has(path)` 就记"消失"，而 `after` 里**根本不含**读不到的文件
 *   ⇒ 「读不到」被伪装成「消失」⇒ 假报最严重的 `exit 6`（实测见 `vanished()` 注释）。
 *   现在 `map` 只收读成功的文件，故 `!after.has(path)` 只可能是**真的不在**；
 *   而"真的不在"另由 `vanished()` 用两张 `present` 表复核 —— 两张判据互不替代。
 */
function digestDiff(before, after) {
  const changed = []
  for (const [path, hash] of before) {
    if (!after.has(path)) changed.push(`${path}（消失）`)
    else if (after.get(path) !== hash) changed.push(path)
  }
  for (const path of after.keys()) if (!before.has(path)) changed.push(`${path}（新增）`)
  return changed
}

/**
 * 相对上一次快照**真的不见了**的路径 —— 判据是两张 `present` 表，与"能不能读出字节"无关。
 *
 * 为什么不能拿 `map` 当"存在"用：读不到的文件不在 `map` 里，用它判"消失"就会把
 * 「被别席门禁独占几秒」误报成「源文件被删」—— 这正是 N1 的实测形态：
 *   `FileShare.None` 延迟 1.8s 独占真实 `src/snapshot.ts`（该文件锁前后 sha256 均为
 *   `cd8c9fad…`，**从未被改动**）⇒ 旧版 `status=6` + stderr `src/snapshot.ts（消失）`。
 * 反过来，**真的**消失（`before.present` 有而 `after.present` 没有）仍然报红：
 *   `present` 来自 `readdir`，删掉的文件不会出现在里面 ⇒ 这条**灵敏度未被削弱**。
 */
function vanished(before, after) {
  const gone = []
  for (const path of before.present) if (!after.present.has(path)) gone.push(path)
  for (const path of after.present) if (!before.present.has(path)) gone.push(`${path}（新增）`)
  return gone
}

if (process.env[SANDBOX_ENV] === undefined || process.env[SANDBOX_ENV] === '') {
  /*
   * ── 外层（**唯一接触真实仓库的那一层**）────────────────────────────────────
   * 本层只做三件事：建副本 → 在副本里重跑本脚本 → 删副本。
   * 并在跑前/跑后对**真实仓库里本变异的目标文件**取 sha256 比对：
   * 两张不等 ⇒ 沙箱漏了，当场高声失败（exit 6），而不是"应该是没动过"。
   */
  const beforeDigest = srcDigest(repoRoot)
  const before = beforeDigest.map
  let sandbox = null
  let setupFailure = null
  /** 建副本半途失败时**没能删掉**的那份目录（由 `makeSandbox` 挂在错误上）；没有则为 `null`。 */
  let setupLeftover = null
  /** 建副本时**正在拷的那一项**（`src/` / `lib/` / `package.json` 之类）；由 `makeSandbox` 挂在错误上。 */
  let setupStep = null
  try {
    sandbox = makeSandbox()
  } catch (error) {
    /*
     * ⚠ **判据的第三个入口**（2026-09-25 · A1 修完第一次跑就撞到，实测）：
     *   独占句柄不只挡 `readFileSync`，也挡 `cpSync` —— 实测把 `src/snapshot.ts` 独占后，
     *   修好 `srcDigest` 的版本**照样 stdout 全空**，崩在
     *   `Error: EPIPE … at cpSync (test/mutate.mjs:84) → at makeSandbox (:175)`。
     *   ⇒ 「把结论排在任何可能抛错的动作之前」这条口径**必须对建副本这一站同样成立**：
     *     建副本失败**不阻断**后面的外证比对（外证只读真实仓库，与副本是否建成无关）。
     *   为什么不是"再包一层 try 了事"：副本建不起来时**探针根本没跑**，那时的 stdout 若为空，
     *     复核者读不出"是环境挡住了，还是探针坏了"。故这一支照样把外证行打出来，
     *   并**点名是哪一步失败**、给非零退出码（见下面的第四分支）。
     */
    setupFailure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    setupLeftover = (error !== null && typeof error === 'object' && typeof error.halfBuiltSandbox === 'string')
      ? error.halfBuiltSandbox
      : null
    setupStep = (error !== null && typeof error === 'object' && typeof error.failedCopyStep === 'string')
      ? error.failedCopyStep
      : null
  }
  let code = 1
  if (setupFailure === null) {
    /*
     * ⚠ 必须跑**副本里那一份**本脚本，不能跑真实仓库这一份：脚本内的 `../${mutation.file}`
     * 是相对 `import.meta.url` 解析的 —— 跑真实那一份，写就会落到真实仓库（自毁沙箱）。
     */
    const sandboxSelf = join(sandbox, 'test', 'mutate.mjs')
    try {
      execFileSync(process.execPath, [sandboxSelf, ...process.argv.slice(2)], {
        cwd: sandbox,
        env: { ...process.env, [SANDBOX_ENV]: sandbox, MUTATE_REPO_ROOT: repoRoot },
        stdio: 'inherit',
      })
      code = 0
    } catch (error) {
      /*
       * 子进程把自己判为 FAIL/BLIND 时是非零退出 —— 那是**结论**，不是本层出错。
       * 原样透传它的退出码，不改写、不吞掉。
       */
      code = typeof error.status === 'number' ? error.status : 1
    }
  }
  /*
   * ⚠ **顺序本身就是判据**（2026-09-25 · "留毒防线 2 不可达"的根因修法）：
   *   旧实现把 `rmSync(sandbox)` 放在 `finally` 里 ⇒ **清理一旦抛错，其后的 sha 比对与
   *   `沙箱外证` 行整段被跳过**。实测（本席按"沙箱一出现就杀"固定口径复现）：
   *   `SAW-SANDBOX=True at 0.18s / KILLED-at=0.2s` ⇒ stdout **完全为空**、**外证行缺失**、
   *   `%TEMP%` 留 1 份 `mutate-sandbox-*`。即「**修的是留毒，但留毒存在时它报不出来**」，
   *   正是本轮要剿的"失败不可观测"。
   *   ⇒ **结论先出、清理后做**：sha 比对与外证行**必须**排在任何可能抛错的动作之前；
   *     清理失败降级为**告警**（如实报出副本路径），**不得**改变或吞掉上面的结论。
   *   为什么不给清理失败一个独立退出码：它会与本块更严重的结论（exit 6 = 沙箱失效）
   *   争夺同一个出口；而清理失败时"真实仓库未被写入"这一外证结论**仍然成立**，
   *   用一个不可能与 0/6 混淆的**告警行 + 完整路径**如实报出即可（见下）。
   */
  /*
   * ⚠ 「读不到」与「零差异」必须**分开渲染**（2026-09-25 · A1）：把读不到当成零差异，
   *   外证就退化成一条**恒真读数** —— 那是比"报不出来"更坏的结果（它会让假绿看起来像证据）。
   *   故 `changed` 只由**两侧都读成功**的文件算得；缺项单独成一条 `⚠ 外证未取得` 告警，
   *   并且**不给** exit 0 的通行证（见下面的三分支）。
   */
  const afterDigest = srcDigest(repoRoot)
  const after = afterDigest.map
  /*
   * ⚠ **两个"差异"必须分开算**（2026-09-25 · N1）：
   *   · `changed`  = 两侧都读出字节、但字节不同的文件 —— 只有这一种才算"沙箱失效"；
   *   · `gone`     = 名字在 `present` 里真的少了/多了的文件（用两张 `present` 表算，
   *                  与"能不能读出字节"无关）。
   *   旧版把"读不到"混进 `changed`（因为它不在 `after.map` 里）⇒ 假 exit 6。
   */
  const changed = digestDiff(before, after)
  const gone = vanished(beforeDigest, afterDigest)
  /*
   * 再兜一层：`changed` 里任何以"（消失）"结尾的项，必须能被 `gone` 佐证。
   * 为什么还要这一道 —— 两张表来自同一个 `readdir` 快照，理论上不会打架；
   * 但一旦将来有人改了 `srcDigest` 的收集口径，这一句会把"读不到被当成消失"
   * **当场**变成一条可读的告警，而不是又一次静默的假 exit 6。
   * 命中时把该项从 `changed` 降级（它本来就落在 `unreadable` 里，信息不丢）——
   * 保守原则：宁可报"未取得"，不可假报"失效"。
   */
  const goneSet = new Set(gone)
  const stripVanish = (c) => c.replace('（消失）', '')
  /*
   * ⚠ **两个方向都要挡**（2026-09-25 · N1 及其对称形态）：
   *   · 「消失」方向：`after` 读不到 ⇒ 不在 `after.map` ⇒ 旧版记"消失" ⇒ 假 exit 6（N1 实测）；
   *   · 「新增」方向：**`before` 读不到** ⇒ 不在 `before.map` ⇒ 旧版记"新增" ⇒ 同样假 exit 6。
   *     这个方向本轮一并实测确认（在 1.8s 窗口内只锁前一次读取），故一起挡。
   *   挡法不是"放宽"，而是**换一张表复核**：只要该路径在 `present` 里两次都在，它就既没
   *   消失也没新增；此时的"差异"只可能来自读不出字节，而那已经记在 `unreadable` 里 ⇒
   *   从"确切差异"摘出来，**信息一点不丢**，只是不再冒充最严重等级。
   */
  const unverifiedVanish = changed.filter((c) => c.endsWith('（消失）') && !goneSet.has(stripVanish(c)))
  const unverifiedAppear = changed.filter((c) => c.endsWith('（新增）') && !goneSet.has(c))
  const changedConfirmed = changed.filter((c) => !unverifiedVanish.includes(c) && !unverifiedAppear.includes(c))
  /*
   * 去重（2026-09-25 实测）：同一个文件在读前/读后都可能失败 —— 不去重会把
   * `src/snapshot.ts` 印成两条，复核者会误以为有两个文件出问题。
   * 按路径合并，保留两处的失败原因（便于分辨"只有一侧读不到"）。
   */
  const unreadableMap = new Map()
  for (const u of [...beforeDigest.unreadable, ...afterDigest.unreadable]) {
    if (!unreadableMap.has(u.path)) unreadableMap.set(u.path, [])
    const whys = unreadableMap.get(u.path)
    if (!whys.includes(u.why)) whys.push(u.why)
  }
  const unreadable = [...unreadableMap].map(([path, whys]) => ({ path, why: whys.join(' / ') }))

  /*
   * `沙箱外证`：把"真实仓库的 src/ 一个字节都没动"变成**当场可读的实测结论**。
   * 这是本修法唯一需要的证据形态 —— 不是"我承诺不写真实文件"，而是"写完读回来仍然逐文件相同"。
   * 三分支（顺序即优先级：有差异 > 未取得 > 零差异）：
   *   ① 有差异 ⇒ exit 6（**不受缺项影响**：读得到的那部分已经证明被改了）；
   *   ② 有缺项 ⇒ **不报"零差异"**，改报「⚠ 外证未取得」，并**退出码取非 0**（见下）；
   *   ③ 否则 ⇒ 零差异（唯一可以报这三个字的形态）。
   */
  if (changedConfirmed.length > 0) {
    console.log(`沙箱外证：真实仓库 src/ 共 ${before.size} 个文件，跑完逐文件比对 —— 有差异`)
    console.error(`⚠ 沙箱失效：真实仓库的 src/ 被改动了（这是本探针绝不允许发生的事）：${changedConfirmed.join('、')}`)
    /*
     * ⚠ **最严重的那一支出，也必须清理副本**（2026-09-25 · N4）。
     *   旧实现这一支**直接 `process.exit(6)`、没有 `cleanupSandbox`**（对照降级支与正常支都有）
     *   ⇒ 恰在"沙箱失效"这个最严重的告警上，留下一份**带变异体的**副本。实测（本席，
     *   scratch 根 + 假 npm 拉长窗口 + 后台改脏 `src/a.ts`）：`status=6`、`leftovers=1`。
     *   更讽刺的是：残留那份里的 `src/` 正是被改坏的源（`obs` 实测残留内 `src/snapshot.ts`
     *   sha `677dca96…` ≠ 基线）—— 告警说"真实仓库被动了"，而它自己留了一份动过的东西。
     *   ⇒ 补上清理，**不改退出码语义**：清理失败**只出声**，结论仍是 6。
     *   顺序照旧遵守本块总口径：**结论（行 + 退出码）先定，清理后做**；
     *   故这里先打印、再清理、最后 exit(6)。
     */
    const fatalCleanup = cleanupSandbox(sandbox)
    if (fatalCleanup !== null) {
      console.error([
        '⚠ 沙箱副本清理失败（**不影响**上面的结论：真实仓库 src/ 确实被改动了）',
        `    副本留在：${sandbox}`,
        `    失败原因：${fatalCleanup}`,
        '    ⚠ 该副本内含**被改坏的源**，比常规残留更该尽快删掉；确认无其他实例在用后手动删除。',
      ].join('\n'))
    }
    process.exit(6)
  }
  if (unreadable.length > 0) {
    /*
     * 守卫本身受 I/O 干扰而失效时，必须**显式失败**，不能悄悄放过。
     * 退码取 **1**：本次派单硬性要求「退出码语义不变（0/1/2/3/5/6）」，
     *   故**不新开** 7/8 之类出口。选 1 不是随手挑 —— 外层本来就用 1 表示
     *   「**没有拿到子进程的判定**」（见上面 catch：`error.status` 非数字时的兜底）。
     *   两个形态语义同族：**"本轮没有可信结论"**；而 0（探针判定 PASS）绝不会与之混淆。
     * 未读到的文件名逐条点名，让复核者能自己重跑。
     *
     * ⚠ 这一支**仍然打印 `沙箱外证` 行**（措辞为「未取得」而不是「零差异」）：
     *   「结论要出得来」与「结论不得虚报」是两件事，两个都要满足 ——
     *   行照打（可 grep、可被上游脚本读到），但**绝不**出现"零差异"三个字。
     */
    console.log('沙箱外证：真实仓库 src/ 共 ' + before.size + ' 个文件，跑完逐文件比对 —— 未取得（有文件读不到，见下方告警）')
    console.error([
      `⚠ 沙箱外证未取得：真实仓库 src/ 有 ${unreadable.length} 个文件读不到 —— 因此**不能**断言"两侧一致"；已成功读到并比过的 ${before.size} 个文件内容相同`,
      ...unreadable.map((u) => `    ${u.path} — ${u.why}`),
      '    处置：外证**没有取得**，因此本条运行**不能**作为"真实仓库未被改动"的证据；',
      '          确认没有杀毒/索引器/其它进程占着这些文件后重跑。',
    ].join('\n'))
    /*
     * ⚠ 降级分支**也要清理副本**（2026-09-25 实测补）：第一次写这一支时直接 `process.exit(1)`，
     *   结果每次降级都在 `%TEMP%` 留一份 `mutate-sandbox-*`（实测残留 1 份、age 0.9 min）。
     *   复用同一个 `cleanupSandbox`：它**永不抛**，所以不会反过来把刚刚救回来的结论再吞掉。
     */
    const degradedCleanup = cleanupSandbox(sandbox)
    if (degradedCleanup !== null) {
      console.error(`    （另：副本也未删掉，留在 ${sandbox} —— ${degradedCleanup}）`)
    }
    if (setupLeftover !== null) {
      /*
       * 建副本半途失败的**半成品目录**：`makeSandbox` 已尽力删过，删不掉才挂在这里。
       * 与"清理失败"同一个口径：如实点名，不吞。
       */
      console.error(`    （另：未建成的半成品副本也留在 ${setupLeftover}，确认无人占用后手动删除）`)
    }
    process.exit(1)
  }
  /*
   * ⚠ 第四分支：**副本没建起来 ⇒ 探针没跑 ⇒ 本轮结果未知**（2026-09-25 · A1）。
   *   与「外证未取得」同一口径：行照打、退出码非 0（取 1，理由同上）。
   *   为什么放在最后：上面三分支回答的是"真实仓库有没有被动过"——
   *   它们的结论**不依赖副本是否建成**，所以必须**优先出得来**；
   *   这一支回答的是"本轮有没有真的测到东西"，是**次一级**的结论。
   */
  if (setupFailure !== null) {
    /*
     * ⚠ 这一行**不写"零差异"**：本轮探针根本没跑，把它印成"零差异"会让人
     *   把「真实仓库未被动过」误读成「这次变异的守卫通过了」—— 正是本轮在剿的假绿形态。
     *   改印「未跑（零差异）」并紧跟告警，两个事实都不丢。
     */
    console.log('沙箱外证：真实仓库 src/ 共 ' + before.size + ' 个文件，跑完逐文件比对 —— 未跑（真实仓库未被动过，但本轮未执行变异探针）')
    console.error([
      '⚠ 沙箱副本未能建立，本轮**没有真的跑过变异探针**（退出码 1：本轮无可信判定）。',
      `    失败原因：${setupFailure}`,
      setupStep === null
        ? '    卡在哪一步：无法定位（错误未携带拷贝步骤信息）—— 见下方原始 message 里的 path。'
        : `    卡在哪一步：${setupStep}`,
      '    注意：上面只证明**真实仓库未被改动**，**不能**当作"变异被守卫抓到"的证据。',
      '    处置：多为有进程（杀毒/索引器/别席门禁）占着该目录/文件；确认后重跑。',
    ].join('\n'))
    process.exit(1)
  }
  console.log(`沙箱外证：真实仓库 src/ 共 ${before.size} 个文件，跑完逐文件比对 —— 零差异`)
  const cleanupFailure = cleanupSandbox(sandbox)
  if (cleanupFailure !== null) {
    /*
     * 清理失败**必须出声** —— 沉默会把"留了一份带变异体的临时副本"变成不可观测。
     * 报**完整路径**（让人能自己去删）+ **原因**，并显式声明它与上面的外证结论无关，
     * 免得读日志的人把两件事混成一件。
     */
    console.error([
      '⚠ 沙箱副本清理失败（**不影响**上面的外证结论：真实仓库 src/ 零差异，未留毒）',
      `    副本留在：${sandbox}`,
      `    失败原因：${cleanupFailure}`,
      '    处置：它只是临时副本（不含对真实仓库的任何写入），确认无其他实例在用后手动删除该目录即可。',
    ].join('\n'))
  }
  process.exit(code)
}

const projectRoot = process.env[SANDBOX_ENV]
/*
 * ⚠ 沙箱自检（**写盘前的最后一道**）：将要写入的根必须是副本、**不是**真实仓库。
 * `MUTATE_REPO_ROOT` 由外层显式传入（本进程的 `import.meta.url` 在副本里，
 * 仅凭它推不出真实仓库位置），故这里比对的是外层给的真实根。
 */
if (process.env.MUTATE_REPO_ROOT === undefined) {
  console.error('变异探针拒绝在未知根里运行：缺少 MUTATE_REPO_ROOT（无法证明"写的不是真实仓库"）。')
  process.exit(5)
}
if (resolve(projectRoot) === resolve(process.env.MUTATE_REPO_ROOT)) {
  console.error('变异探针拒绝在**真实仓库**里运行：沙箱根指向了仓库本身（这会重新引入留毒）。')
  process.exit(5)
}
if (!projectRoot.includes('mutate-sandbox-')) {
  console.error(`变异探针拒绝运行：沙箱根看起来不像本脚本建的副本目录（${projectRoot}）。`)
  process.exit(5)
}

const mutations = {
  1: {
    name: '快照 recent 上限 20→200（群聊扩容污染 1Hz 轮询体）',
    file: 'src/snapshot.ts',
    from: 'out.length < 20;',
    to: 'out.length < 200;',
    expect: '快照轮询体不得被群聊扩容',
  },
  2: {
    name: 'say 去掉 source:user（主持人无法区分用户亲口说的话）',
    file: 'src/rpc.ts',
    from: "                  content: text,\n                  source: 'user',",
    to: '                  content: text,',
    expect: 'say 没有标 source=user',
  },
  3: {
    name: 'say 绕开 state 层自己写文件',
    file: 'src/rpc.ts',
    from: 'await appendUtterance(stateRoot, meetingId, utterance)',
    to: "await writeFile(meetingDirOf(stateRoot, meetingId) + '/transcript.jsonl', JSON.stringify(utterance))",
    expect: 'say 没有调用 appendUtterance',
  },
  4: {
    name: 'transcript.list 无界读（去掉条数夹取）',
    file: 'src/rpc.ts',
    from: 'const limit = clampTranscriptLimit(body?.limit)',
    to: 'const limit = Number.MAX_SAFE_INTEGER',
    expect: '条数夹取',
  },
  5: {
    name: 'transcript.list 的 since 变成 >=（增量补齐重复送回边界那条）',
    file: 'src/rpc.ts',
    from: 'utterance.ts > since',
    to: 'utterance.ts >= since',
    expect: 'since 是严格大于',
  },
  6: {
    name: '窗口切分取头部而不是尾部（群聊看到最旧的发言）',
    file: 'src/rpc.ts',
    from: 'filtered.slice(filtered.length - limit)',
    to: 'filtered.slice(0, limit)',
    expect: '取尾部',
  },
  7: {
    name: '群聊组件混用拓扑样式模块',
    file: 'src/client/ChatView.tsx',
    from: "from './ChatView.module.css'",
    to: "from './RoundTableView.module.css'",
    expect: 'ChatView 未使用独立样式模块',
  },
  8: {
    name: 'sendChat 改成乐观插入（先塞列表再回读）',
    file: 'src/client/RoundTableView.tsx',
    from: "      if (!result.ok) throw new Error(result.error.message)",
    to: "      if (!result.ok) throw new Error(result.error.message)\n      setChatMessages((current) => current)",
    expect: '乐观插入',
  },
  9: {
    name: '画布测量 effect 去掉 view 依赖（切回拓扑后观测器盯着卸载的 DOM）',
    file: 'src/client/RoundTableView.tsx',
    from: "      observer.disconnect()\n    }\n  }, [view])",
    to: '      observer.disconnect()\n    }\n  }, [])',
    expect: '没有依赖 view',
  },
  10: {
    name: '英文字典删掉一个群聊键（另一种语言显示键名）',
    file: 'src/client/locales.ts',
    from: "  chatSend: 'Send',\n",
    to: '',
    expect: 'Expected values to be strictly deep-equal',
  },
  11: {
    name: '空状态内联一份自己的 textarea（输入框不再与群聊共用）',
    file: 'src/client/RoundTableView.tsx',
    from: '              <ChatComposer\n                t={translate}\n                sending={steerSending}\n                onSend={(text) => { void startMeeting(text) }}\n                placeholderKey="emptyInputPlaceholder"\n              />',
    to: '              <textarea className={styles.input} />',
    expect: '空状态没有用共享的 ChatComposer',
  },
  12: {
    name: '空状态改调 say 而不是 steer（会议还不存在却当会议发言发）',
    file: 'src/client/RoundTableView.tsx',
    from: 'await steerSession(rpc, String(sessionId), text)',
    to: "await rpc('roundtable/say', { meetingId: '', text })",
    expect: 'startMeeting 没有调用 steerSession',
  },
  13: {
    name: 'steer 复用命令解析（"off" 会被当命令静默退模式）',
    file: 'src/rpc.ts',
    from: 'runtime.mode.set(sessionId, \'manual\', true)',
    to: "runModeCommand(runtime.mode, sessionId, judged.text); runtime.mode.set(sessionId, 'manual', true)",
    expect: 'steer 复用了命令解析',
  },
  14: {
    name: 'steer 无活会话时假装成功（不报错）',
    file: 'src/rpc.ts',
    from: "            if (captain === undefined) {\n              // 会话没有活 agent（页面刚刷新、会话已归档…）：明确报错，不假装已送达。\n              return fail(`session \"${sessionId}\" has no live agent to steer`)\n            }",
    to: '            if (captain === undefined) return ok({ active: true, auto: false, manual: true })',
    expect: '缺少"无活会话"的显式失败',
  },
  15: {
    name: 'ChatComposer 的 placeholderKey 失效（空状态显示群聊那份占位文案）',
    file: 'src/client/ChatComposer.tsx',
    from: "const placeholder = t(placeholderKey ?? 'chatInputPlaceholder')",
    to: "const placeholder = t('chatInputPlaceholder')",
    expect: '空状态占位文案没生效',
  },
  16: {
    name: 'ChatComposer 的 disabled 不透传到 textarea（sending 时仍能重复提交）',
    file: 'src/client/ChatComposer.tsx',
    from: '        disabled={blocked}',
    to: '        disabled={false}',
    expect: '输入框没有禁用',
  },
  17: {
    name: 'ChatComposer 空草稿也允许点发送（发空消息）',
    file: 'src/client/ChatComposer.tsx',
    from: '        disabled={blocked || draft.trim() === \'\'}',
    to: '        disabled={blocked}',
    expect: '空草稿时发送按钮没有被禁用',
  },
  18: {
    name: 'hooks 挪到早退之后（无会议时少跑一个 hook，React 抛错）',
    file: 'src/client/RoundTableView.tsx',
    from: "  const modeLabel = meeting.mode === 'egalitarian'",
    to: '  const [__probe] = useState(false)\n  const modeLabel = meeting.mode === \'egalitarian\'',
    expect: '早退之后出现了 hooks',
  },
  19: {
    name: 'steer 把「先置模式再转交」对调（议题送达时主持人还不知道要按圆桌处理）',
    file: 'src/rpc.ts',
    from: "            runtime.mode.set(sessionId, 'manual', true)\n            if (!steerCaptain(captain, { kind: 'user-topic' }, judged.text)) {\n              return fail('the session rejected the message (steer failed)')\n            }",
    to: "            if (!steerCaptain(captain, { kind: 'user-topic' }, judged.text)) {\n              return fail('the session rejected the message (steer failed)')\n            }\n            runtime.mode.set(sessionId, 'manual', true)",
    // 对调后"两句都在"，所以那些 include 断言全绿 —— 只有顺序断言会响，
    // 响的就是它。这正是本变异存在的意义：证明顺序断言不是摆设。
    expect: '必须先置讨论模式再 steer',
  },
  20: {
    name: 'say 只落盘不唤醒主持人（气泡出现了却永远不会有人回应）',
    file: 'src/rpc.ts',
    from: "            const delivered = captain === undefined\n              ? false\n              : steerCaptain(captain, { kind: 'meeting-group-chat' }, text)",
    to: '            const delivered = captain !== undefined',
    expect: 'say 没有唤醒主持人',
  },
  21: {
    name: 'status 的 recent_utterances 把 from_user 写死 false（主持人分不清是谁说的）',
    file: 'src/tools.ts',
    from: "          from_user: utterance.source === 'user',",
    to: '          from_user: false,',
    expect: 'roundtable_status 的 recent_utterances 没有真的从 source 推导 from_user',
  },
  22: {
    name: '汇聚网关 digest 不标用户发言（主持人把自己的话读成用户的话）',
    file: 'src/aggregator.ts',
    from: '${from}${userSourceMark(utterance)} → ${to}',
    to: '${from} → ${to}',
    expect: '汇聚网关 digest 没标出用户亲口的发言',
  },
  23: {
    name: '客户端重新引入本地页大小常量并拿它猜截断（host 上限一改提示就静默消失）',
    file: 'src/client/RoundTableView.tsx',
    from: '      setChatTruncated(page.truncated)',
    to: '      const TRANSCRIPT_PAGE = 200\n      setChatTruncated(page.messages.length >= TRANSCRIPT_PAGE)',
    expect: '客户端仍在用本地页大小常量推断截断',
  },
  24: {
    name: 'ChatComposer 去掉 IME 组合态守卫（中文选词时把半截拼音发出去）',
    file: 'src/client/ChatComposer.tsx',
    from: '  if (isComposing === true) return false\n',
    to: '',
    expect: 'IME 组合期间按 Enter 绝不能发送',
  },
  25: {
    name: '导出不标用户发言（留档里用户的话与主持人的话长得一样）',
    file: 'src/tools.ts',
    from: '${utterance.nodeKey}${userSourceMark(utterance)}',
    to: '${utterance.nodeKey}',
    expect: '导出没标出用户亲口的发言',
  },
  26: {
    name: 'truncated 恒为 false（丢了更早的发言却告诉用户看全了）',
    file: 'src/rpc.ts',
    from: '  const truncated = filtered.length > limit',
    to: '  const truncated = false',
    expect: '超出上限必须报截断',
  },
  27: {
    name: '唤醒主持人时裸传用户原文（主持人分不清是用户说的还是插件注入的）',
    file: 'src/rpc.ts',
    from: "steerCaptain(captain, { kind: 'meeting-group-chat' }, text)",
    to: 'steerCaptain(captain, text)',
    expect: '唤醒时没有声明出处',
  },
  28: {
    name: '空状态那一屏不画徽章（用户在这一屏打字后"切走仍开"完全不可见）',
    // ⚠ 两处徽章写法**逐字相同**，replace 只换第一处 —— 而第一处正是空状态那一屏
    // （空状态在早退体里，头部在早退体之后）。这恰好是本次变异要打的位置；
    // 若将来两处写法分化，本变异会换错地方，届时应改成带上下文的锚点。
    file: 'src/client/RoundTableView.tsx',
    from: '<ModeBadge state={modeState} t={translate} />',
    to: '<span />',
    expect: '空状态那一屏没有徽章',
  },
  29: {
    name: '徽章在真值未到时照画（先画"关"再跳"开"，用户看到一次不存在的状态变化）',
    file: 'src/client/ModeBadge.tsx',
    from: 'if (state === null) return null',
    to: 'if (false) return null',
    expect: '真值未到前不得画徽章',
  },
  30: {
    // 本次修复的**原始病灶**（2026-09-23 实测于 session-ef265a8a）：命令路径把议题
    // 裸投给主持人，正文首行没有出处 —— 主持人读不出"这是用户给的议题"。
    // 守卫⑦ 必须抓到这个形态，否则修了也白修（下次重构会再漏）。
    name: '命令路径裸投议题（主持人读不出这句话是谁说的）',
    file: 'src/index.ts',
    from: "          steerCaptain(invocation.agent, { kind: 'user-topic' }, outcome.steerText)",
    // 0.1.7（ACT-373）：`kind: 'plugin'` 这个共享 catch-all 已从上游
    // `MessageSourceMap` 删除，变异体改用当下**合法**的裸 source 形态
    // ——否则这份"回归形态"自身就不再是可编译的真实反面例子。
    to: "          invocation.agent.steer(createUserMessage({ content: [{ type: 'text', text: outcome.steerText }], source: { kind: 'user' } }))",
    expect: '裸 steer',
  },
  31: {
    name: '封皮工厂掏空（provenanceLabel 不再产出"来自用户"，投递变成无出处）',
    file: 'src/members.ts',
    from: "      return 'Message from the user (round-table topic):'",
    to: "      return ''",
    expect: 'provenanceLabel 缺少封皮片段',
  },
  32: {
    // 2026-09-23 吸收 P10「成功标准须可量化」新增的 check 字段。
    // 本变异打的是它的**消费面**：把导出物里的检查方式整行删掉。
    // 若 double-truth-guards ⑩-a / boundary-check-render 真的在管用，必转红。
    name: '导出物丢掉「怎么检查」（判据退化成没人验得了的完成）',
    file: 'src/tools.ts',
    from: '    out.push(`- **怎么检查**：${meeting.boundary.check.trim() === \'\' ? \'（未声明）\' : meeting.boundary.check.trim()}`)',
    to: '    // removed',
    expect: '导出物须留检查方式',
  },
  33: {
    // 打**总纲**那一侧：这是 P10 量化的真实落点（每个专家的 persona）。
    // check 不进总纲 ⇒ 专家看不到"到底拿什么验"，只能凭 done 的文字自行想象。
    name: '总纲丢掉「怎么检查才算达标」（专家看不到验收方式）',
    file: 'src/charter.ts',
    from: '          `- 怎么检查才算达标：${meeting.boundary.check.trim() === \'\' ? \'（未声明）\' : meeting.boundary.check.trim()}`,\n',
    to: '',
    expect: '总纲必须含检查方式正文',
  },
  34: {
    // 2026-09-24「0 = 不限制」的**核心判据**。改成恒 false = 0 不再表示不限制
    // （等价于回到旧实现 `round >= maxRounds`：0 成了最严格的上限，第 1 轮就闭麦）。
    name: '0 不再表示不限制（budgetUnlimited 恒假 ⇒ 旧行为复活）',
    file: 'src/budget.ts',
    from: '  return !(limit > 0)',
    to: '  return false',
    expect: '0 必须表示不限制',
  },
  35: {
    // 打**设置卡**这一面：用户确认的那一屏把 0 说成"超限自动闭麦"，
    // 等于把他要求的"不限制"写成反面，而他会在这一屏点确认。
    name: '设置卡把 0 说成「超限自动闭麦」（与 0=不限制 正好相反）',
    file: 'src/plan.ts',
    from: '    ? `${limit} ${unit}（= 不限制：该轴永不闭麦）`',
    to: '    ? `${limit} ${unit}（超限自动闭麦）`',
    expect: '设置卡必须让用户看见"不限制"三个字',
  },
  36: {
    // 打**客户端设置页**：用户敲下 0 被 `Math.max(1, …)` 立刻改写成 1，
    // 于是"不限制"永远存不进偏好 —— 这是"用户的要求被无声改写"的原形。
    name: '设置页把 maxRounds 的 0 顶成 1（不限制永远存不进偏好）',
    file: 'src/client/RoundTableSettings.tsx',
    from: '            const value = Math.max(0, Math.floor(Number(event.target.value) || 0))\n            patch({ maxRounds: value })',
    to: '            const value = Math.max(1, Math.floor(Number(event.target.value) || 1))\n            patch({ maxRounds: value })',
    expect: 'maxRounds 不得把 0 顶成 1',
  },
  37: {
    // 打**status 消费面**：退回手拼 `used/max` ⇒ 不限制的轴显示成 `42/0`，
    // 主持人会把它读成"预算越用越少"，与"不限制"正好相反。
    name: 'status 退回手拼 used/max（不限制的轴显示成 42/0）',
    file: 'src/tools.ts',
    from: '    `Budget: ${budgetAxisText(Number(budget.max_rounds), Number(budget.used_rounds))} rounds, ${budgetAxisText(Number(budget.max_tokens), Number(budget.used_tokens))} tokens (spoken-text estimate only — NOT the real LLM spend)`,',
    to: '    `Budget: ${String(budget.used_rounds)}/${String(budget.max_rounds)} rounds, ${String(budget.used_tokens)}/${String(budget.max_tokens)} tokens (spoken-text estimate only — NOT the real LLM spend)`,',
    expect: 'status 不得再手拼 used/max',
  },
  38: {
    // 回归面 B（2026-09-25 独立审查实测、本席复验）：让**边参与送达** —— 无匹配边即拒投。
    // 后果：①-e 的**第一处**断言（delivered 必须 wake）转红。
    // 锚点选**下游调用行**而非分支条件行：它唯一（`prepared.recipient.id` 全文件仅此一处），
    // 且是"投递真的发生"的唯一落点 —— 改它即等价于"接口假装投递了"。
    name: '边参与送达（无匹配边即拒投，delivered 退化为 dropped）',
    file: 'src/tools.ts',
    from: '        const accepted = await deliverToNode(ctx, captainLive, prepared.recipient.id, content, exec.signal)',
    to: '        const accepted = captainLive !== undefined && prepared.meeting.edges.some((edge) => edge.to === prepared.recipient.key)',
    expect: '①-e',
  },
  39: {
    // 回归面 D2（2026-09-25 独立审查实测、本席复验）：删掉 deliverToNode 的下游 sendMessage 调用。
    // 后果最阴：**接口仍返回 wake**（"成功"），但没有任何子代理被唤醒（结果未达成）——
    // 只有"下游真的收到"这一层断言抓得到。它是"接口成功 ≠ 结果达成"的活体标本。
    name: 'deliverToNode 删掉下游调用（返回 wake，但没人被唤醒）',
    file: 'src/members.ts',
    from: "    await ctx.subagents.sendMessage(\n      captain,\n      childId as SessionId,\n      [{ type: 'text', text }],\n      { signal },\n    )",
    to: '    void captain\n    void childId\n    void text\n    void signal',
    // 归因取**诊断串**而不是测试标题：本变异响的是 ①-e 的**第二处**断言
    // （"送达必须是**真的唤醒**了那个子代理"）—— 它上面还有一条 assert.equal(delivered, 'wake')。
    // 钉标题会与同时变红的其它块混淆；钉这句则只在"下游真被掏空"时出现，无二义。
    // ⚠ 口径：expect 与断言文案必须**连标点逐字**相同（node:test 打印整条消息，差一字即不归因）。
    // 归因取**测试标题**（块首那行 ✖）而不是某条断言原文：①-e 体内有两处断言，
    // 两种坏法各响一处（掏空下游 ⇒ 第二处响；架空分支 ⇒ 第一处响），绑死其中一条
    // 会让另一种坏法被判「非目标守卫」——本席实测：本仓工作区当前带残留变异时，
    // 第一处先响，钉第二处那句即判 FAIL。钉标题两者都收，且仍能排除"别的测试红了"。
    expect: '①-e C-1',
  },
}

const id = process.argv[2]
const mutation = mutations[id]
if (mutation === undefined) {
  console.error(`未知变异编号 ${id}；可用：${Object.keys(mutations).join(', ')}`)
  process.exit(2)
}

/**
 * 从 TAP 输出里切出每个失败测试的**证据块**（`not ok` 行起，到下一个
 * `ok`/`not ok`/`# ` 行为止，含其间的 `error:` 诊断）。
 *
 * 为什么要切块而不是全文搜 `expect`：断言消息出现在**失败块内部**，而测试名、
 * 位置、`error:` 字段都在同一块里。全文搜会把"另一条测试恰好也提了这句词"算成命中。
 */
function failingBlocks(output) {
  const blocks = []
  let cur = null
  for (const line of output.split('\n')) {
    if (/^not ok /.test(line.trim())) {
      if (cur !== null) blocks.push(cur.join('\n'))
      cur = [line]
    } else if (/^(ok |not ok |# )/.test(line.trim())) {
      if (cur !== null) { blocks.push(cur.join('\n')); cur = null }
    } else if (cur !== null) cur.push(line)
  }
  if (cur !== null) blocks.push(cur.join('\n'))
  if (blocks.length > 0) return blocks
  /*
   * spec 报告回退（2026-09-25 本席实测）：`npm test` 在此环境下跑出的是 node 的
   * **spec** reporter，不是 TAP —— 没有任何 `not ok` 行，只有末尾一个
   * `✖ failing tests:` 段，段内每块以 `test at <file>:<line>:<col>` 起头。
   * 不认这个形态，归因判定就永远看不到失败块 ⇒ 每条**已经红了**的变异都被读成
   * 「FAIL（假绿）」。两种形态都要认，且 TAP 优先（老环境/老 node 不受影响）。
   */
  const lines = output.split('\n')
  const start = lines.findIndex((line) => /^\s*\u2716\s*failing tests:?\s*$/.test(line))
  if (start < 0) return []
  let fallback = null
  for (const line of lines.slice(start + 1)) {
    if (/^\s*test at \S+:\d+:\d+\s*$/.test(line)) {
      if (fallback !== null) blocks.push(fallback.join('\n'))
      fallback = [line]
    } else if (fallback !== null) fallback.push(line)
  }
  if (fallback !== null) blocks.push(fallback.join('\n'))
  return blocks
}

const url = new URL(`../${mutation.file}`, import.meta.url)
const original = readFileSync(url, 'utf8')

/**
 * 行尾归一：锚点字面量按 **LF** 写，而磁盘上的源文件可能是 **CRLF**。
 *
 * 为什么必须做（2026-09-23 实测，属"让失败不可观测"类缺陷）：本机
 * `core.autocrlf=true` 且仓内无 `.gitattributes` ⇒ `src/rpc.ts` 等工作区文件是 CRLF，
 * 而多行锚点里的 `\n` 是 LF ⇒ `original.includes(from)` 恒 false ⇒ 探针在 `exit 3`
 * 处"锚点没找到"就退出，**从来没在测任何东西**。实测 4 条已死（2/14/19/20，全在
 * rpc.ts），而 `npm test` 不跑本文件 ⇒ 这四条失效对全部门禁**完全不可见**
 * （已立 test/mutation-probe-health.test.mjs 为常驻门）。
 *
 * 归一放在**比较与替换**两处（而不是改写锚点字面量）：锚点保持可读的 LF 写法，
 * 与工作区实际行尾解耦 —— 换到 LF 检出的环境（Linux/CI）同样成立。
 */
/*
 * ⚠ 2026-09-25 实测**第三类失效**（本席复核时发现，与"实现已变"无关）：
 *   旧判据 `original.includes('\r\n') ? CRLF : LF` 是"整个文件选一种行尾"。
 *   但工作区文件可以**混用**：`src/client/RoundTableView.tsx` 2157 个 LF 里夹 **1** 个
 *   裸 CR，`src/client/locales.ts` 夹 **12** 个。于是整条锚点被切成 CRLF，而正文是 LF
 *   ⇒ `includes` 恒 false ⇒ 变异 9/10/11 在下面 `exit 3` 处**静默退出，从来没在测东西**。
 *   （mutation-probe-health 抓不到：它按 **LF 归一后**比对 from，那一步恒成立。）
 * 故改成两侧都试，命中的那一侧同时用于 replace；两侧都不中才判"锚点没找到"。
 */
const candidates = [
  { from: mutation.from.replace(/\n/g, '\r\n'), to: mutation.to.replace(/\n/g, '\r\n') },
  { from: mutation.from, to: mutation.to },
]
/*
 * ⚠ 命中判定与替换必须**同一把尺**（2026-09-25 沙箱化时踩到并修）：
 *   锚点字面量一律按 LF 写，而副本里的源文件行尾是**原样拷来**的（本机 `core.autocrlf=true`
 *   下 `src/rpc.ts` 等仍是 CRLF）。故先按上面 `candidates` 两侧都试，
 *   **谁在裸正文里出现就选谁**，判命中与随后的 `replace` 都用这一版。
 *
 *   ⚠ 反面教训（1.0 版真的这么写过，已实测出 6 条假绿）：若改成"按 LF 归一判命中、
 *     再取 LF 那一版去替换"，判命中会恒真，但 `original.replace(LF 锚点, …)` 在 CRLF
 *     正文里**找不到**锚点 ⇒ `replace` 静默返回原文 ⇒ 写回的是**没改过的原文**
 *     ⇒ 套件全绿 ⇒ 全表 39 条里 6 条（9/10/11/24/33/36）被读成"假绿"。
 *     这类"判据成立但动作落空"的形态必须靠**两侧都验**（命中 + 真的变了）才抓得到。
 */
const hit = candidates.find((candidate) => original.includes(candidate.from))
if (hit === undefined) {
  console.error(`变异 ${id} 的锚点没找到（实现已变？）：${mutation.from.slice(0, 60)}`)
  process.exit(3)
}
/**
 * ⚠ 选中的那一版必须与**正文同侧** —— 这是 2026-09-25 沙箱化时踩到的**真 bug**（已实测）：
 *   1.0 版这里写的是"按 LF 归一判命中、再取 LF 那一版去替换"。判命中确实成立
 *   （归一后 includes 恒真），但 `original.replace(anchor, replacement)` 作用在**裸正文**上：
 *   正文是 CRLF 时，LF 版锚点在里面**找不到** ⇒ `replace` 静默返回原文 ⇒ 写盘写回的是
 *   **没被改过的原文** ⇒ 套件当然全绿 ⇒ 全表 39 条里 6 条被读成"假绿"
 *   （实测 id 9 / 10 / 11 / 24 / 33 / 36；这 6 条正好是 CRLF 正文 + 多行锚点的那几条）。
 *   ⇒ 命中判定用**裸正文**（与旧实现同口径：两边都试，谁在正文里就选谁），
 *     替换也用同一版 —— 判命中与替换用同一把尺，才不会出现"判定成立但替换落空"。
 *   （原 1.0 版留下的 `originalLf` / `lf()` 已随本次修正一并删除：留着会让人以为
 *     "归一那一路"还在起作用，而它恰恰是这 6 条假绿的来源。）
 */
const anchor = hit.from
const replacement = hit.to

let failed = 0
let attributed = false
/** 归因命中块数（PASS 只要求 >0；两者不等 = 套件里另有红灯） */
let attributedBlocks = 0
/*
 * ⚠ 写盘只落在**副本根**（`projectRoot` 由外层经 `MUTATE_SANDBOX_ROOT` 传入，
 * 上面已断言它不是真实仓库）。
 *
 * ⚠⚠ **本段与旧实现不再同形**（2026-09-25 订正：旧注释写的是"同样的 writeFileSync、
 *   同样的 finally 还原"，而代码里**既没有 `finally`、也没有还原** —— 那句注释会误导复核者）。
 *   现在只剩 `writeFileSync` 一处写盘，写进的是**一次性副本**：没有、也**不需要**"还原"这个动作**——
 *   副本本身就是耗材（外层跑完就删），真实仓库全程零写入，因此**不存在**“该把哪一份快照写回去”这个问题
 *   —— 上一轮事故（还原到**带毒快照**并自证通过）正是因为“还原”这个动作存在。
 *   并发互踩也随之消失：两个实例各写各的副本，不存在共享可变状态。
 *
 * 本块的 `catch` 不是"还原"，而是**读数取源兼容**：子进程非零退出时报告可能在 stderr（见下）。
 */
let output = ''
try {
  writeFileSync(url, original.replace(anchor, replacement), 'utf8')
  output = execFileSync('npm test', { cwd: projectRoot, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error) {
    /*
     * ⚠ 失败输出**不能**只取 stdout（2026-09-25 本席实测）：
     *   子进程非零退出时 node:test 把整份报告**写到 stderr**，stdout 只剩 npm 的两行头。
     *   于是下面所有解析都作用在一份「没有 # fail、没有失败块」的空报告上，
     *   每条已经红了的变异都会被读成「FAIL（假绿）」。原实现正是这样全表误判。
     *   两份都取、各取更长的那份，是唯一与 reporter 去向无关的取法。
     *   ⚠ 与 npm 自身错误路径不冲突：那时两份都没有测试报告，期望文案搜不到，
     *   结果同样是「不归因」——不会因此把某条变异错判成有效。
     */
    const streams = [String(error.stdout ?? ''), String(error.stderr ?? '')]
    output = streams[0].length >= streams[1].length ? streams[0] : streams[1]
  }
  /*
   * 读数须同时认两种 reporter（2026-09-25 实测）：TAP 的 `# fail N` / `# pass N`，
   * 与 spec 的 `ℹ fail N` / `ℹ pass N`。只认 TAP 时，spec 环境下
   * failed 恒为 NaN ⇒ **所有变异都被判假绿**，而探针自己不会因此报错。
   */
  const failLine = output.split('\n').find((line) => line.startsWith('# fail') || line.startsWith('\u2139 fail'))
  failed = Number.parseInt((failLine ?? '# fail NaN').replace(/^(# fail|\u2139 fail)\s*/, ''), 10)
  const passLine = output.split('\n').find((line) => line.startsWith('# pass') || line.startsWith('\u2139 pass'))
  // 归因判定（v0.2.49 加严）：**必须有一个失败块里出现本变异的 expect 文案**。
  //
  // 为什么不能只看 `# fail > 0`：那个判据区分不出
  //   (a) 目标守卫抓到了这次变异；还是
  //   (b) 别的原因把套件弄红了（把源码改成语法错误时，整个文件的测试都会红，
  //       而目标守卫**根本没机会执行**）—— 实测两者都报 `# fail > 0`。
  // 于是探针会把"编译崩了"读成"18 条守卫全部有效"，这正是不该出现的不归因假绿。
  const blocks = failingBlocks(output)
  const matched = blocks.filter((block) => block.includes(mutation.expect))
  attributed = matched.length > 0
  attributedBlocks = matched.length
  /*
   * 失败块的两种表头都要认（TAP: `not ok`；spec: `test at <file>:<line>:<col>` 之后那行
   * `✖ <测试名>`）。只认 TAP 时，attributedTo 恒为空 —— 即便判定为 PASS，
   * 也报不出**是哪条守卫**抓到的，归因就成了无法复核的结论。
   */
  const blockHead = (block) => {
    for (const line of block.split('\n')) {
      const t = line.trim()
      if (/^not ok /.test(t) || /^\u2716 /.test(t)) return t
    }
    return ''
  }
  const attributedTo = matched.map(blockHead).filter((line) => line !== '')
  console.log(`变异 ${id}：${mutation.name}`)
  console.log(`  ${failLine ?? '(无 # fail 行)'} / ${passLine ?? '(无 # pass 行)'}`)
  console.log(`  期望守卫文案：${mutation.expect}`)
  for (const line of attributedTo) console.log(`   ↳ 命中：${line.slice(0, 120)}`)
  if (failed > 0 && !attributed) {
    console.log(`  ⚠ 有 ${blocks.length} 个失败块，但没有一个含期望文案 —— 疑非目标守卫（或 expect 写错）`)
    for (const block of blocks.slice(0, 3)) {
      const line = blockHead(block)
      // spec reporter 用 `✖ <类型> [ERR_...]: <消息>` 而不是 TAP 的 `error: ` 行。
      const err = block.split('\n').map((l) => l.trim()).find((l) => /^error: /.test(l) || /^[A-Za-z]*Error \[/.test(l)) ?? ''
      console.log(`     ${line.slice(0, 110)}  ${err.slice(0, 110)}`)
    }
  }
console.log(`  判定：${failed > 0 && attributed ? 'PASS（目标守卫真的转红）' : failed > 0 ? 'FAIL（转红了，但不是这条守卫）' : 'FAIL（假绿：改坏了却报不出来）'}`)

/*
 * 判定汇总（2026-09-25 加）：单条运行时，"PASS + 其它失败块" 与 "PASS" 看起来一样，
 * 而前者其实是**假绿在场**（别的原因把套件弄红了，目标守卫只是碰巧也红了）。
 * 归因块仍是 PASS 的唯一判据；这一行只是把并列失败数报出来，不留白。
 */
if (failed > 0 && attributed && attributedBlocks < failed) {
  console.log(`  ⚠ 另有 ${failed - attributedBlocks} 个失败块不含本变异的期望文案 —— 归因仍成立，但套件里还有别的红灯`)
}
/*
 * 退出码：0 = PASS（目标守卫真的转红）／1 = FAIL（没红，或红了但不是这条守卫）。
 * ⚠ 外层的"真实仓库 sha 未变"实证在**外层的 stdout**上（见文件头），
 *   而"没有留毒"这件事由**结构**保证：本进程的写目标恒为副本。
 */
process.exit(failed > 0 && attributed ? 0 : 1)
