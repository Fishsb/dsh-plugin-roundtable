/**
 * 变异探针**运行时**覆盖门（2026-09-26 · arch 席落盘，采纳 B' 案）。
 *
 * ## 为什么需要这个文件（本轮实测缺口）
 *
 * test/mutate.mjs 的沙箱机制（拷贝私有副本 → 在副本里重跑 → 外层逐文件 sha 比对
 * → 给结论 → 删副本）是**行为**，而本仓对它的全部常驻守卫都是**静态读源码**：
 *   · mutation-probe-health.test.mjs 的 k1 扫的是"收尾调用有没有排在结论行之后"；
 *   · mutation-probe-health.test.mjs 本体的 execFileSync 全是 git（:399/:468/:713），
 *     chat-view.test.mjs 的 5 处引用全在注释里，double-truth-guards.test.mjs 无子进程导入。
 * ⇒ **探针一次都不被执行**，"机制被改坏"没有任何机检面。
 *
 * 本轮实测（arch 席，scratch 副本 + 单跑 k1）—— k1 对本会点名的三个破坏点**全盲**：
 *   掏空 cleanupSandbox（删 mutate.mjs:219 的 rmSync，保留 try/return 签名） → pass 1 / fail 0
 *   去掉外层 sha 比对（:349 digestDiff(before, after) → []）                  → pass 1 / fail 0
 *   去掉 exit6 分支的清理（:408 cleanupSandbox(sandbox) → null）              → pass 1 / fail 0
 *   正控：收尾调用**前移到首条结论行之前**                                     → pass 0 / fail 1（红）
 * ⇒ k1 判的是**位置**，不判"收尾有没有真的做事"。位置对而动作被掏空时，它看不见。
 *
 * ## 本门做什么（全部是**行为**断言，不含任何源码文本匹配）
 *
 * 每个场景 = 在 os.tmpdir() 里建一份**只属于本进程**的夹具副本（src/ + test/ +
 * package.json），把副本 package.json 的 scripts.test 换成**一行 node -e**，
 * 再起子进程跑副本里的 test/mutate.mjs。**"沙箱机制"与"套件时长"在这里被解耦**——
 * 于是每次运行从 6.3 s 降到 ~1.0 s，机制本身一字不改。
 *
 *   · **T1 冒烟**：探针真的跑到底（内层有判定行、外层有沙箱外证行，且是"零差异"分支）；
 *   · **T2 外证灵敏度**：让夹具的"真实仓库"在探针运行期间被改一个字节
 *     ⇒ 必须 exit 6 且外证行变"有差异"（破坏点②：sha 比对被掏空时这条转红）；
 *   · **T3 exit6 分支的清理**：T2 场景结束后**不得**留下 mutate-sandbox-*
 *     （破坏点③：fatalCleanup 被置空时这条转红）；
 *   · **T4 清理本体**：干净跑结束后同样不得留下副本
 *     （破坏点①：cleanupSandbox 被掏空时这条转红）；
 *   · **T5 转红自证**：把夹具里 exit6 分支的清理去掉 + 走 exit6 场景
 *     ⇒ **必须**留下副本。没有这一条，T3/T4 可能是"恒绿的空断言"（本仓反复剿的形态）。
 *
 * ⚠ 全部断言都是**行为**，一个字都不匹配源码文本：注释改写、变量改名都不会让它假红；
 *   它能红当且仅当探针**跑起来之后**行为变了。
 *
 * ## 转红实测（arch 席，在 scratch 副本里改 mutate.mjs 后单跑本门）
 *
 *   基线（不改）                             → exit 0，pass 5 / fail 0
 *   掏空 cleanupSandbox（:219 rmSync）       → exit 1，红：**T3 + T4**
 *   去掉 exit6 分支的清理（:408）            → exit 1，红：**T3 + T5**
 *   去掉外层 sha 比对（:349）                → exit 1，红：**T2 + T5**
 * 三个破坏点没有一个落空；归因都由"哪一条红"直接指出来。
 *
 * ## E 段：写盘前的三道自检（2026-09-26 补，本仓最后的"拒绝在真实仓库写盘"防线）
 *
 * `mutate.mjs` 在**真正开始变异之前**有三道自检（`:506` / `:510` / `:514`），
 * 任一不成立即 `exit 5` 拒绝运行。它们不是"锦上添花"，是**沙箱机制本体**：
 * 自检被掏空 ⇒ 探针会**直接在真实仓库里写变异体**（上一轮留毒事故的原始形态）。
 *
 * 而本门此前对它们**零覆盖**（实测：把 `:514` 那一整个 if 删掉，全量 npm test
 * 仍 433 全绿）。故补 E1/E2/E3 —— 全部复用现成夹具，**零额外拷贝成本**：
 *
 *   · **E1**：删掉 `MUTATE_REPO_ROOT`（同时给一个**命名合规**的沙箱根）⇒ exit 5 + "拒绝在未知根里运行"；
 *   · **E2**：沙箱根 = 仓库根 = 夹具根（**命名天然不合规**）⇒ **钉 `:510` 的告警语义**
 *     + 夹具 `src/` 摘要未变；
 *   · **E3**：沙箱根 = `<夹具根>/not-a-sandbox`（命名不合规、但 ≠ 仓库根）⇒ 钉 `:514` 的告警语义
 *     + 夹具 `src/` 摘要未变。
 *
 * ⚠⚠ **归因补正（2026-09-26 · verify 席复核 c1r 实测，本席逐形态复现——见下方矩阵）**：
 *   旧措辞写的是"E2 独立证明 `:510` 拦住了写盘""E3 把 MUTATE_REPO_ROOT 指成不含
 *   `mutate-sandbox-` 的目录"。**两处都与实现对不上**：
 *
 *     ① `:510` 与 `:514` 是**两条独立检查**，不是一条的三级；
 *     ② **真实仓库路径本身就不含 `mutate-sandbox-`** ⇒ E2 形态下 `:514` 恒真；
 *     ③ **E3 形态只摆布沙箱根，不摆布 `MUTATE_REPO_ROOT`**（它必须指向真的仓库根，
 *        否则 `:510` 不成立，检的就换了人）。
 *
 *   于是两形态的**检出归属是错位的**，本席逐条实测（4 组 × 3 形态，锚点见下）：
 *
 *     | 掏空 | E1 形态（缺根变量） | E2 形态（根==仓库） | E3 形态（命名不符） |
 *     |---|---|---|---|
 *     | 不改（基线） | exit 5 + `:506` 文案 | exit 5 + `:510` 文案 | exit 5 + `:514` 文案 |
 *     | 删 `:506` | **exit 1 / 无拒绝行** | exit 5（`:510` 仍拦） | exit 5（`:514` 仍拦） |
 *     | 删 `:510` | exit 5（`:506` 先拦） | **exit 5，但拒绝行变成 `:514` 的文案** | exit 5（`:514` 文案） |
 *     | 删 `:514` | exit 5（`:506` 仍拦） | exit 5（`:510` 仍拦） | **exit 1 / 无拒绝行 / `src/` 被写** |
 *
 *   ⇒ **正确说法**：**E1 是唯一把退出码钉在 `:506` 上的一条**；**E2 钉的是 `:510` 的告警语义
 *   （退出码由 `:514` 的语义兜底）**；**E3 钉 `:514` 的告警语义与"不写盘"**。
 *   三条**各自**对"所钉的那一行被删"敏感（矩阵里加粗那三个格子），故各自的**裁红能力成立**；
 *   但**不能**说成"三条分别独立证明三行都拦住了写盘"——退出码那一侧 `:514` 对 E2 有兜底作用。
 *   这正是本仓反复剿的"红得对、理由错"，故把矩阵写在这里，免得下一轮又被人按旧说法复述。
 *
 * ⚠ E2/E3 的 env 值**恒为死值**（夹具根、`<夹具根>/not-a-sandbox`），与探针内部逻辑零耦合 ——
 *   不存在"把内部逻辑当 oracle 抄进断言"的同义反复，只能靠行为通过。
 *
 * ⚠⚠ **E1–E3 必须直接把副本脚本当"内层"起**（2026-09-26 本席实测踩到，第一版就这么错的）：
 *   想用"给外层多传一个环境变量"来触发自检是**做不到的** —— 外层在起子进程时
 *   **硬覆盖** `MUTATE_REPO_ROOT`（`mutate.mjs:309` 的 `env: { ...process.env,
 *   [SANDBOX_ENV]: sandbox, MUTATE_REPO_ROOT: repoRoot }`），传进去的会被当场盖掉。
 *   实测（第一版）：E1/E2/E3 三条都跑到正常变异路径上（`exit 1`，还打印了"沙箱外证…零差异"），
 *   **读数是"自检没被触发"，而不是"自检被掏空"** —— 正是本仓在剿的"红得对、理由错"。
 *   故这三条走**独立的 `runSelfCheck`**：显式设 `MUTATE_SANDBOX_ROOT`（= 扮演外层的角色）
 *   再按场景摆布 `MUTATE_REPO_ROOT`。三种形态**各自只让一道自检处于"该开火"的位置**：
 *     · E1：沙箱根命名合规 + `MUTATE_REPO_ROOT` 缺失 ⇒ 只有 `:506` 会开火；
 *     · E2：沙箱根 = 仓库根 ⇒ `:510` 先开火（`:514` 同时成立，是兜底）；
 *     · E3：沙箱根命名不合规 + `MUTATE_REPO_ROOT` = 仓库根 ⇒ 只有 `:514` 会开火。
 *
 * ## 与既有纪律的关系（不冲突，且是加强）
 *
 * npm test 的既有期望是「**真实仓库**零写入」，本仓已把它做成常驻门
 * （mutation-probe-health.test.mjs 的「无残留门」+ 转红自证，:958-1028；
 * 其 :962-968 明写"用注入而不是真写盘"的理由是**并行测试会读到半改的源码**）。
 * 本门**不写真实仓库任何字节**：夹具在 os.tmpdir() 里、名字带 process.pid、
 * 跑完自己删；被写入的只有夹具自己那份副本。
 *
 * ⚠ **不给内层子进程共享 %TEMP%**：每个场景另建一个私有 child-tmp/ 目录，并把它经
 * TMPDIR/TMP/TEMP 传给子进程（node 的 os.tmpdir() 认 TMPDIR，本机实测）。
 * 于是"副本残留"这件事在**本场景自己的目录里**数得准，也不会与并发的别次运行互相数到对方。
 * （若让子进程共享 %TEMP%，两个并发实例的 mutate-sandbox-* 会互相当成自己的残留 —— 假红。）
 *
 * ## 边界（写清楚，免得被当成"探针全行为都被覆盖了"）
 *
 *   · 本门只钉**沙箱机制**（拷贝/重跑/外证/清理）这四条行为；"变异归因"
 *     （改坏源码后目标守卫红不红）**不在本门内** —— 那要跑整套 npm test，单条 ≈ 6.3 s，
 *     属于人工/专项运行，不属于常驻门。
 *   · 本门**不**断言"真实仓库零写入"：那由既有的「无残留门」管。在这里再比一次全仓 sha
 *     会与并发施工的正当改动撞成**假红**（本仓有前科，见上面 :962-968）。
 *   · 夹具自删失败**不改变任何判定**（照 cleanupSandbox 的口径：清理失败只出声）——
 *     否则一个 EPERM 就能把结论吞掉，那正是本轮在剿的形态。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

/** 仓库真实根（本文件在 test/ 下，副本的拷贝源）。**只读它，绝不写它。** */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 内层"套件"：一行 node -e。它让本门与 npm test 的真实时长解耦（6.3 s → ~1.0 s）。 */
const INNER_OK = 'node -e "console.log(1)"'
/**
 * 内层"套件"：往**夹具的真实仓库**（不是副本）追加一个字节。
 * 用途是 T2/T3/T5 —— 造出"外层该报 exit 6"的场景。
 * 真实路径经环境变量传入（子进程的 cwd 是副本，它推不出夹具根）。
 */
const INNER_DIRTY = 'node -e "require(\'node:fs\').appendFileSync(process.env.PROBE_REAL_SRC + \'/snapshot.ts\', \'//x\')"'

/**
 * 夹具拷什么：探针外层要 src/（取 sha 清单），内层要它**自己那一份** test/mutate.mjs
 * （外层会 `join(sandbox,'test','mutate.mjs')` 去重跑），package.json 用来换成一行内层测试。
 *
 * ⚠ **只拷 src/ 与单个文件，绝不整目录拷 test/**（2026-09-26 本席实测踩到，已改）：
 *   整拷 `test/` 时，**同波次的写席正在改 `test/*.test.mjs`**，`cpSync` 会撞上
 *   半写状态 —— 实测全量 `npm test` 三次里有一次本文件**整文件中止**
 *   （`ℹ tests 425` 对正常的 429，`✖ test\mutate-runtime.test.mjs`），
 *   而那一次的失败与探针本身毫无关系。这正是本会次要目标（并发下读席被写席中间态污染）
 *   的活体形态 ⇒ 修法是**缩小读取面**：只读 `test/mutate.mjs` 这一个受保护的主体，
 *   别席的文件一概不碰。`src/` 按本会边界是冻结的（须与 HEAD 逐字节一致），故安全。
 */
const FIXTURE_DIRS = ['src']
const FIXTURE_FILES = ['package.json', join('test', 'mutate.mjs')]

let seq = 0

/**
 * 建一份夹具副本并返回其路径。
 *
 * 目录名带 process.pid + 自增序号：**并发跑 npm test 是本仓常规工作流**，
 * 固定名会互踩（本仓已有反例式先例：preset-landing-discipline.test.mjs:413 用固定名的投毒文件）。
 */
function makeFixture(tag, options) {
  const opts = options || {}
  const innerTest = opts.innerTest || INNER_OK
  const sabotage = opts.sabotage || null
  const root = join(tmpdir(), 'mutate-runtime-fixture-' + process.pid + '-' + (seq += 1) + '-' + tag)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  try {
    for (const dir of FIXTURE_DIRS) cpSync(join(REPO, dir), join(root, dir), { recursive: true })
    mkdirSync(join(root, 'test'), { recursive: true })
    for (const file of FIXTURE_FILES) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      cpSync(join(REPO, file), join(root, file))
    }
    const pkgPath = join(root, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.scripts.test = innerTest
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
    if (sabotage !== null) {
      const probePath = join(root, 'test', 'mutate.mjs')
      const src = readFileSync(probePath, 'utf8')
      const next = sabotage(src)
      assert.notEqual(
        next, src,
        '夹具自证的破坏动作**没命中** —— 说明本门与 test/mutate.mjs 的当前结构脱节了；'
        + '请把本门的破坏锚点同步到实现（这一条红是"夹具失效"，不是"探针坏了"）。',
      )
      writeFileSync(probePath, next, 'utf8')
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
  return root
}

/**
 * 跑一次夹具里的探针；返回**纯数据**（调用方断言），并把夹具删掉。
 *
 * ⚠ 子进程的 tmpdir 被换成本场景私有的 child-tmp/（见文件头"为什么不共享 %TEMP%"）。
 * ⚠ 夹具自删失败**只出声**，绝不改变判定 —— 与 cleanupSandbox 同一口径。
 */
function runScenario(tag, options) {
  const root = makeFixture(tag, options)
  const childTmp = join(root, 'child-tmp')
  mkdirSync(childTmp, { recursive: true })
  /*
   * E 段：`SANDBOX_ENV_OVERRIDE` 里 **undefined 值 = 显式删除该变量**
   *（E1 要的就是"这个变量不存在"，而 `{...process.env, X: undefined}` 做不到删除）。
   */
  const env = {
    ...process.env,
    TMPDIR: childTmp,
    TMP: childTmp,
    TEMP: childTmp,
    PROBE_REAL_SRC: join(root, 'src').replace(/\\/g, '/'),
  }
  for (const [name, raw] of Object.entries((options || {}).env || {})) {
    if (raw === undefined) { delete env[name]; continue }
    /*
     * `FIXTURE_ROOT` / `FIXTURE_NOT_SANDBOX` 是**占位常量**，在这里解析成夹具路径：
     * 调用点（E2/E3）在模块顶层，拿不到 `root` —— 而探针里比的是
     * `resolve(projectRoot) === resolve(MUTATE_REPO_ROOT)`，**必须是绝对路径**，
     * 传相对串会让 `resolve` 按子进程 cwd（= 夹具根）算成夹具根下的子路径，判不到点上。
     */
    if (raw === 'FIXTURE_ROOT') env[name] = root
    else if (raw === 'FIXTURE_NOT_SANDBOX') env[name] = join(root, 'not-a-sandbox')
    else env[name] = raw
  }
  let exit = 0
  let out = ''
  try {
    try {
      out = execFileSync(process.execPath, [join(root, 'test', 'mutate.mjs'), '1'], {
        cwd: root,
        encoding: 'utf8',
        env: env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      })
    } catch (error) {
      /*
       * 非零退出是**结论**（探针自身就用 0/1/2/3/5/6 表达判定），不是本门出错。
       * 原样取它的退出码与两份输出 —— 与探针外层取子进程读数同一口径。
       */
      exit = typeof error.status === 'number' ? error.status : -1
      out = String(error.stdout || '') + String(error.stderr || '')
    }
    const leftovers = readdirSync(childTmp).filter((name) => name.startsWith('mutate-sandbox-'))
    return {
      exit: exit,
      out: out,
      leftovers: leftovers,
      childTmp: childTmp,
      proofLine: out.split('\n').find((line) => line.includes('沙箱外证')) || '(没有沙箱外证行)',
    }
  } finally {
    /*
     * ⚠ **先删内层那份私有 tmp**，再删夹具本体（2026-09-26 本席实测踩到）：
     *   内层探针的副本就建在 `child-tmp/` 里；若这一层没被删掉，夹具根会**整棵留下来
     *   （实测：跑完 3 次全量 `npm test` 后 %TEMP% 攒了 6 个 `mutate-runtime-fixture-*`，
     *   每个里面还套着 1 份 `mutate-sandbox-*`）—— 那正是本仓在剿的"残留"。
     *   两处都删的理由：`rmSync` 递归删根在 Windows 上会因句柄未释放而留下子项，
     *   先删最里面那层，命中"刚被用过"的窗口更小。
     */
    try {
      rmSync(childTmp, { recursive: true, force: true, maxRetries: 3 })
    } catch (error) {
      console.error('（提示：本场景的私有 tmp 没删掉：' + childTmp + ' —— ' + String(error) + '）')
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch (error) {
      console.error(
        '（提示：本门的夹具副本没删掉，留在 ' + root + ' —— '
        + (error instanceof Error ? error.message : String(error))
        + '；它只是临时副本，**不影响**上面的判定）',
      )
    }
  }
}

/**
 * **E 段专用**：把夹具里的副本脚本当**内层**直接起（自己扮演外层，显式给 `MUTATE_SANDBOX_ROOT`）。
 *
 * 为什么不复用 {@link runScenario}：那个跑的是**外层**，而外层会硬覆盖
 * `MUTATE_REPO_ROOT`（`mutate.mjs:309`）⇒ 传进去的场景值到不了自检那三行上
 * （见文件头 E 段的实测记录）。这里显式设好根、只摆布 `MUTATE_REPO_ROOT`。
 *
 * `sandboxRoot` / `repoRoot` 收的是"以夹具根为入参的函数"：三种形态（相等／不等且命名不合规／
 * 变量缺失）都只由调用点决定，与探针内部逻辑无关。
 */
/**
 * 夹具 `src/` 下每个文件的 sha256（用来判"这次运行有没有真的往那份 src 里写东西"）。
 *
 * ⚠ 为什么不是"扫某个标记串"（2026-09-26 本席实测踩到，第一版就这么错的）：
 *   第一版写的是"扫描 src 下所有文件里有没有 `//x`" —— 而真实源码里**本来就有**这个子串
 *   （`src/index.ts:534` 的 `new URL(req.url ?? '/', 'http://x')` 里含 `//x`），
 *   于是这条断言**恒为真**，E2/E3 当场假红。摘要比对没有这个毛病：
 *   它问的是"字节有没有变"，与源码内容长什么样无关。
 */
function srcDigest(root) {
  const map = new Map()
  const dir = join(root, 'src')
  const walk = (relative) => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const next = relative === '' ? entry.name : relative + '/' + entry.name
      if (entry.isDirectory()) { walk(next); continue }
      map.set(next, createHash('sha256').update(readFileSync(join(dir, next))).digest('hex'))
    }
  }
  walk('')
  return JSON.stringify([...map.entries()].sort())
}

function runSelfCheck(tag, sandboxRoot, repoRoot) {
  const root = makeFixture(tag)
  const env = { ...process.env, TMPDIR: join(root, 'child-tmp'), TMP: join(root, 'child-tmp'), TEMP: join(root, 'child-tmp') }
  mkdirSync(env.TMPDIR, { recursive: true })
  const srcBefore = srcDigest(root)
  env.MUTATE_SANDBOX_ROOT = sandboxRoot(root)
  if (repoRoot === null) delete env.MUTATE_REPO_ROOT
  else env.MUTATE_REPO_ROOT = repoRoot(root)
  let exit = 0
  let out = ''
  try {
    try {
      out = execFileSync(process.execPath, [join(root, 'test', 'mutate.mjs'), '1'], {
        cwd: root, encoding: 'utf8', env: env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
      })
    } catch (error) {
      exit = typeof error.status === 'number' ? error.status : -1
      out = String(error.stdout || '') + String(error.stderr || '')
    }
    /*
     * ⚠ 夹具 `src/` 在跑前跑后的摘要：自检若被掏空，探针会**直接往这里写变异体**
     *   （`new URL('../src/…', import.meta.url)` 相对副本脚本解析 ⇒ 落到夹具根的 src/）。
     *   这一读数用于**归因**（"自检没拦住 ⇒ 它真的写了"），它是 sha256 比对，
     *   与"源码里长什么样"无关（见 {@link srcDigest} 的实测记录）。
     */
    const wroteIntoFixtureSrc = srcDigest(root) !== srcBefore
    return { exit: exit, out: out, wroteIntoFixtureSrc: wroteIntoFixtureSrc }
  } finally {
    try { rmSync(join(root, 'child-tmp'), { recursive: true, force: true, maxRetries: 3 }) } catch { /* 只出声可忽略 */ }
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }) } catch { /* 同上 */ }
  }
}

/**
 * 场景结果**记忆化**：T1/T4 共用一次"干净跑"，T2/T3 共用一次"exit6 跑"。
 * 这是本门把增量成本压在 ~3 次运行上的唯一支点（node:test 同一文件内按声明序串行执行）。
 */
const memo = new Map()
function scenario(tag, options) {
  if (!memo.has(tag)) memo.set(tag, runScenario(tag, options))
  return memo.get(tag)
}

/** 干净跑：内层一行 node -e，探针不该报沙箱失效。 */
function cleanRun() { return scenario('clean', { innerTest: INNER_OK }) }

/** exit6 场景：探针运行期间夹具的"真实仓库"被改一个字节 ⇒ 外层 sha 比对必须抓到。 */
function dirtyRun() { return scenario('dirty', { innerTest: INNER_DIRTY }) }

/** 去掉 exit6 分支的清理调用（把它换成 null，分支结构与退出码一字不改）。 */
function dropFatalCleanup(src) {
  return src.replace('    const fatalCleanup = cleanupSandbox(sandbox)', '    const fatalCleanup = null')
}

test('T1 冒烟：变异探针在夹具副本里真的跑到底（内层有判定、外层有外证行）', { timeout: 120000 }, () => {
  const r = cleanRun()
  assert.ok(
    r.exit === 0 || r.exit === 1,
    '探针退出码为 ' + r.exit + ' —— 夹具里它没跑成"（改坏了 ⇒ 守卫红/绿）"的常规形态。'
    + '实测预期 1（内层是一行 node -e，没有 # fail 行 ⇒ 探针判 FAIL）。原始读数：' + r.out.slice(0, 600),
  )
  assert.ok(
    r.out.includes('判定：'),
    '内层没有打印"判定："行 —— 探针没跑到出结论的地方。原始读数：' + r.out.slice(0, 600),
  )
  assert.ok(
    r.proofLine.includes('零差异'),
    '外层没有打印"零差异"外证行（实际：' + r.proofLine + '）—— 沙箱外证这条通路断了。',
  )
})

test('T2 外证灵敏度：真实仓库被改动一个字节时，外层必须 exit 6 且外证行变"有差异"', { timeout: 120000 }, () => {
  const r = dirtyRun()
  assert.equal(
    r.exit, 6,
    '夹具的"真实仓库"在探针运行期间被改了一个字节，外层却没报 exit 6（实际 ' + r.exit + '）——'
    + 'sha 比对这条通路失效了，而探针正是靠它保证"没留毒"。外证行：' + r.proofLine,
  )
  assert.ok(
    r.proofLine.includes('有差异'),
    '外证行没有如实报"有差异"（实际：' + r.proofLine + '）—— 退出码对了但结论行没说真话。',
  )
  assert.ok(
    r.out.includes('沙箱失效'),
    '没有"沙箱失效"告警行 —— 最严重的那一支没走到。原始读数：' + r.out.slice(0, 600),
  )
})

test('T3 exit6 分支的清理：报完"沙箱失效"之后，副本必须照样被删掉（不留残留）', { timeout: 120000 }, () => {
  const r = dirtyRun()
  assert.deepEqual(
    r.leftovers, [],
    '探针在 exit 6（最严重的那一支）之后留下了副本：' + JSON.stringify(r.leftovers)
    + '。这一支恰是最该清干净的地方 —— 残留那份里含**被改坏的源**。'
    + '（本门的 T5 已证明"残留"这个读数不是恒空的：破坏清理后它一定数得到东西。）',
  )
})

test('T4 清理本体：干净跑结束不得留下任何副本', { timeout: 120000 }, () => {
  const r = cleanRun()
  assert.deepEqual(
    r.leftovers, [],
    '干净跑之后留下了副本：' + JSON.stringify(r.leftovers)
    + ' —— cleanupSandbox 的实际删除动作被掏空（或副本删除失败且没出声）。外证行：' + r.proofLine,
  )
})

test('T5 转红自证：把 exit6 分支的清理去掉后，T3 的判据必须数得到残留（否则 T3/T4 是空断言）', { timeout: 120000 }, () => {
  const r = scenario('exit6-sabotaged', { innerTest: INNER_DIRTY, sabotage: dropFatalCleanup })
  /*
   * ⚠ 先钉**场景前提**（2026-09-26 实测补）：本席在"同时掏空 sha 比对"的对照里撞到
   *   —— 那时 exit6 分支根本不可达（改坏了也报不出来），于是"清理被去掉"这件事
   *  在这个场景里**没有机会发生**，残留自然是空的，本条的"没数到残留"就会红成
   *  一句**指向错误**的归因（说"T3/T4 是空断言"，真因其实在 T2 那条通路）。
   *   本仓明令剿的就是这个形态（mutation-probe-health.test.mjs 的"红得对、理由错"）。
   *   故这里显式先断言 exit === 6：场景没成立就说"场景没成立"，不冒充"空断言"。
   */
  assert.equal(
    r.exit, 6,
    '（夹具前提）本条的破坏场景要求探针**走到 exit 6**，实际退出码 ' + r.exit + '：'
    + 'exit6 分支在本夹具里不可达（多半是 sha 比对那条通路先坏了 —— 见 T2）。'
    + '外证行：' + r.proofLine,
  )
  assert.ok(
    r.leftovers.length > 0,
    '把 exit6 分支的清理换成 null 之后，居然一份副本残留都没数到 —— 那么 T3/T4 的"零残留"断言是'
    + '**恒真的空断言**，抓不到任何东西（本仓反复剿的形态）。原始读数：'
    + JSON.stringify({ exit: r.exit, proof: r.proofLine }),
  )
})

/*
 * ══════════════════════════════════════════════════════════════════════════════
 * E 段（2026-09-26 · 补 verify 席实测出的缺口）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 三道自检的位置、以及**逐形态的检出归属矩阵**见文件头「E 段」（⚠ 先读那张表：
 * `:510` 与 `:514` 是两条独立检查，E2 形态下 `:514` 恒真、会兜住退出码）。
 * 改动前本门对它们**零覆盖**：把 `:514` 那一整个 `if` 删掉，全量 npm test 仍 433 全绿。
 * 这三条把它们变成常驻判据。
 *
 * ⚠ 三条**全部复用夹具**（不额外拷贝）：E1/E2/E3 都是"立刻拒绝"的路径，
 *   探针走不到写盘与内层重跑，故每条实测 ~0.2 s（见文件头成本说明）。
 */

/*
 * ⚠ E1 是三条里**唯一**把"退出码 5"钉在 `:506` 上的一条：本形态下沙箱根命名合规、
 *   `MUTATE_REPO_ROOT` 缺失，故 `:510`（比相等，undefined 比不出）与 `:514`（命名合规）
 *   都不会开火。实测掏空 `:506` ⇒ 本形态 exit 1 且无拒绝行（矩阵见文件头）。
 */
test('E1 自检一：缺 MUTATE_REPO_ROOT 时必须 exit 5 拒绝（探针不得在未知根里写盘）', { timeout: 120000 }, () => {
  const r = runSelfCheck(
    'e1-no-repo-root',
    (root) => join(root, 'child-tmp', 'mutate-sandbox-e1'),
    null,
  )
  assert.equal(
    r.exit, 5,
    '缺 MUTATE_REPO_ROOT 时探针的退出码是 ' + r.exit + '（应为 5）—— `:506` 这道自检没有拦住，'
    + '而它正是"将要写入的根到底是不是真实仓库"唯一的证明来源。原始读数：' + r.out.slice(0, 600),
  )
  assert.ok(
    r.out.includes('拒绝在未知根里运行'),
    '缺少"拒绝在未知根里运行"的告警 —— 退出码对了但没说清拒绝的理由（复核者读不出为什么）。'
    + '原始读数：' + r.out.slice(0, 600),
  )
})

/*
 * ⚠⚠ **E2 钉的是什么（归因补正 · 2026-09-26 verify 席实测，本席逐形态复现）**：
 *   本形态下沙箱根 = 仓库根 = 夹具根 ⇒ `:510` 与 `:514` **同时成立**
 *   （**真实仓库路径天然不含 `mutate-sandbox-`**），且 `:510` 先开火。
 *   故掏空 `:510` 后**退出码仍然是 5**（`:514` 兜住），变的是**拒绝行文案**
 *   （从 "拒绝在**真实仓库**里运行" 变成 "看起来不像本脚本建的副本目录"）。
 *   ⇒ 本条**独立敏感的是告警语义**（以及 `src/` 摘要未变）；退出码那一侧由 `:514` 的语义兜底。
 *   **不能**说成"E2 证明 `:510` 拦住了写盘" —— 那是本仓在剿的"红得对、理由错"。
 *   （逐形态矩阵见文件头；实锚点：掏空 `:510` ⇒ 本形态拒绝行变成 `:514` 文案，退出码仍 5。）
 */
test('E2 自检二：沙箱根指向真实仓库时必须 exit 5 拒绝，且告警必须是 `:510` 的语义（退出码由 `:514` 兜底）', { timeout: 120000 }, () => {
  const r = runSelfCheck('e2-root-is-repo', (root) => root, (root) => root)
  assert.equal(
    r.exit, 5,
    '沙箱根指向"真实仓库"时探针的退出码是 ' + r.exit + '（应为 5）—— 自检整体没拦住，'
    + '那意味着探针会在真实仓库里写变异体（上一轮留毒事故的原始形态）。'
    + '（⚠ 退出码这一侧 `:510`/`:514` 任一成立即可为 5，故它的**独立**归因不在本行，在下面告警那一条。）'
    + '原始读数：' + r.out.slice(0, 600),
  )
  assert.ok(
    r.out.includes('拒绝在**真实仓库**里运行'),
    '拒绝行不是 `:510` 的语义（缺"拒绝在真实仓库里运行"）—— 这一条才是 E2 **独立**钉的东西：'
    + '退出码可以被 `:514` 兜住，但"根指向了仓库本身"这句告警只有 `:510` 会打。'
    + '原始读数：' + r.out.slice(0, 600),
  )
  assert.equal(
    r.wroteIntoFixtureSrc, false,
    '探针在"根 == 仓库"的形态下**真的写了**（夹具 `src/` 跑前跑后摘要不同）—— 这条自检是'
    + '"绝不写真实仓库"的最后一道防线，它一破就等于上一轮留毒事故重演。',
  )
})

/*
 * ⚠⚠ **E3 钉的是什么（归因补正 · 2026-09-26）**：
 *   本形态**只摆布沙箱根**（= `<夹具根>/not-a-sandbox`，命名不合规），`MUTATE_REPO_ROOT`
 *   仍指向**真的仓库根** —— 两条都必要：不摆布 `MUTATE_REPO_ROOT`（即不把它设成仓库根）
 *   的话 `:510` 不成立，检的就换了人。
 *   于是本形态下**只有 `:514` 会开火** ⇒ 它是三条里**唯一**把"exit 5 + 该告警"钉在
 *   `:514` 上的一条。掏空 `:514` 后本形态实测 **exit 1 + 无拒绝行 + 夹具 `src/` 被写**
 *   （写入目标是 `new URL('../src/…', import.meta.url)`，相对副本脚本解析 ⇒ 落到夹具根的 src/，
 *   真实运行里那一份就是**真实仓库**）。
 */
test('E3 自检三：沙箱根命名不含 mutate-sandbox- 时必须 exit 5 拒绝（并真的没写盘）', { timeout: 120000 }, () => {
  const r = runSelfCheck(
    'e3-bad-sandbox-name',
    (root) => join(root, 'not-a-sandbox'),
    (root) => root,
  )
  assert.equal(
    r.exit, 5,
    '沙箱根不像本脚本建的副本目录时，探针的退出码是 ' + r.exit + '（应为 5）——'
    + '这道"命名自检"（`:514`）被绕过了；本形态下没有别的检查会兜住它（`:506` 因根变量存在而跳过、'
    + '`:510` 因沙箱根 ≠ 仓库根而跳过）。原始读数：' + r.out.slice(0, 600),
  )
  assert.ok(
    r.out.includes('看起来不像本脚本建的副本目录'),
    '缺少"不像本脚本建的副本目录"的告警 —— 退出码可能是别的检查兜的，但这句文案只有 `:514` 会打。'
    + '原始读数：' + r.out.slice(0, 600),
  )
  /*
   * ⚠ 这一条同时钉住"掏空它会发生什么"：路径不合规时探针若继续跑，写入目标是
   *   `new URL('../src/…', import.meta.url)` —— 相对**副本脚本**解析 ⇒ 落到夹具根的 src/，
   *   而真实运行里那一份就是**真实仓库**。故这里断言它一个字都没写。
   */
  assert.equal(
    r.wroteIntoFixtureSrc, false,
    '探针在"沙箱根命名不合规"的形态下**真的写了**（夹具 `src/` 跑前跑后摘要不同）——'
    + '这道命名自检是"拒在真实仓库写盘"的第三道防线，破了就等于把变异体写进真实源码。',
  )
})
