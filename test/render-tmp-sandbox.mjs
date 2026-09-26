/**
 * 渲染面测试的**共享临时目录**沙箱：让「清理归属」变得**可判别**。
 *
 * ## 判因（2026-09-26：本会话四个席位**独立**撞到同一处互数）
 *
 * `chat-composer-render.test.mjs` / `mode-badge-render.test.mjs` / `dispatch-panel-render.test.mjs`
 * 三处各自 `mkdtempSync(join(TMP_DIR, '<前缀>-'))`。**父目录共享是对的**——产物必须落在仓库内，
 * 否则 Node 从产物所在目录向上找 `node_modules` 会以 "Cannot find package 'react'" 全红
 * （真实踩坑，见 `dispatch-panel-render.test.mjs` 头注释），**移出仓库 = 拆东墙补西墙**。
 * 真正的缺陷在**目录名里没有任何归属信息**：`node --test` 默认**多进程并发**跑
 * `test/*.test.mjs`，任何"扫父目录"的判据只能靠 mtime 猜"这是残留还是别人的在途"
 * ⇒ 四席各自看到对方的在途目录，各自报同一处。
 *
 * ## 判别式（唯一一条，不叠加启发式）
 *
 * 目录名 = `<pid>-<tag>-<mkdtemp 随机后缀>`。**pid 就是归属**：
 *
 *   · pid === 本进程           → 本进程自己没清干净 ⇒ **残留**（本进程原地在跑也不例外：收尾就该干净）
 *   · pid !== 本进程 且 进程存活 → **他方在途**，本判据**不判它残留**（这就是"不互数"）
 *   · pid !== 本进程 且 进程已退出 → 收它的人已不存在 ⇒ **残留**
 *   · 名字读不出 pid           → 归属**不可证**（无法证明有活进程正在用它）⇒ **残留**
 *
 * 存活探测用 `process.kill(pid, 0)`。**本机实测（Node v24.21.0 / Windows）**：
 * 自身 → ok；已退出的子进程 → `ESRCH`；存活子进程 → 不抛；SIGTERM 后 → `ESRCH`；
 * 权限不足（`EPERM`，跨用户）→ **按存活算**（宁可放过，不把权限问题说成"残留"）。
 *
 * ## 已知边界（如实登记，未消除）
 *
 * pid 会被复用：若某个死进程的 pid 恰好被一个无关的活进程占用，则该目录被判"他方在途"
 * 而**放过**（假绿方向，非假红）。窗口是"上一轮跑完到下一次复用"之间的巧合，
 * 且判据另有静态面兜底（`render-tmp-isolation.test.mjs` 钉住谁在写这个目录）。
 * 这是**有界**取舍，不是"消除"——沿用本仓 k1 的停止条件。
 */
import { mkdirSync, mkdtempSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 仓库内共享父目录。
 *
 * ⚠ 必须落在**仓库内**（见头注释：`%TEMP%` 下 Node 解析不到本仓 react）；
 * ⚠ 必须先自建（`.gitignore` 忽略了它，全新克隆上不存在 ⇒ ENOENT 全红）。
 * 这两条**唯一的实现处**就在下面两行 —— 渲染测试只许经本模块取目录，
 * 免得"自建目录 / 落在仓库内"被逐文件抄写（抄写的那一份改了、别处不改即失效）。
 */
export const RENDER_TMP_DIR = fileURLToPath(new URL('./.render-tmp/', import.meta.url))

/** `<pid>-<tag>-<rand>`；`tag` 允许中划线分段（如 `composer-panel`）。 */
const OWNER_NAME = /^(\d+)-([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)-([A-Za-z0-9]+)$/

/**
 * 建一个**归属明确**的临时目录：目录名以本进程 pid 开头。
 *
 * @param {string} tag 该目录的用途标记（写入目录名，便于人读盘时分辨是谁的）
 * @returns {{ dir: string, cleanup: () => void }} 用完必须调 `cleanup()`
 */
export function makeRenderTmpDir(tag) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(tag)) {
    throw new Error('render-tmp tag 只允许字母/数字/中划线，实际：' + tag)
  }
  mkdirSync(RENDER_TMP_DIR, { recursive: true })
  const dir = mkdtempSync(join(RENDER_TMP_DIR, process.pid + '-' + tag + '-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * 从目录名读出归属。
 * @returns {{ pid: number, tag: string } | null} 读不出则 `null`（**不可证**，调用方按残留处理）
 */
export function parseRenderTmpOwner(name) {
  const m = OWNER_NAME.exec(name)
  if (m === null) return null
  return { pid: Number(m[1]), tag: m[2] }
}

/** 存活探测（语义见头注释"本机实测"）。 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但本进程无权探测 ⇒ 算活；ESRCH = 不存在
    return error.code === 'EPERM'
  }
}

/**
 * 把盘面上的项按**归属**分桶。纯函数（存活与身份都由参数注入）⇒ 夹具可确定性。
 *
 * @param {Array<{name: string, isDir?: boolean, mtimeMs?: number}>} entries
 * @param {{ selfPid: number, isAlive?: (pid: number) => boolean }} opts
 * @returns {{ own: object[], foreign: object[], stale: object[] }}
 */
export function classifyRenderTmp(entries, opts) {
  const isAlive = opts.isAlive ?? isPidAlive
  const own = []
  const foreign = []
  const stale = []
  for (const entry of entries) {
    const owner = parseRenderTmpOwner(entry.name)
    if (owner === null) {
      stale.push({ ...entry, why: '名字读不出归属（无法证明有活进程正在用它）' })
      continue
    }
    if (owner.pid === opts.selfPid) {
      own.push({ ...entry, why: '本进程自己的目录' })
      continue
    }
    if (isAlive(owner.pid)) {
      foreign.push({ ...entry, why: '归属进程 pid=' + owner.pid + ' 仍存活（在途，不是残留）' })
      continue
    }
    stale.push({ ...entry, why: '归属进程 pid=' + owner.pid + ' 已退出，无人会再收它' })
  }
  return { own, foreign, stale }
}

/**
 * 读盘面（`mtimeMs` 只作**展示用证据**，不参与判定 —— 判定只用归属，见头注释）。
 * @returns {Array<object> | null} 目录不存在时返回 `null`（**显式**，调用方须说明"本次未取得结论"）
 */
export function scanRenderTmp() {
  try {
    return readdirSync(RENDER_TMP_DIR, { withFileTypes: true }).map((entry) => {
      let mtimeMs = Number.NaN
      try { mtimeMs = statSync(join(RENDER_TMP_DIR, entry.name)).mtimeMs } catch { /* 竞态：对方正在收走它 */ }
      return { name: entry.name, isDir: entry.isDirectory(), mtimeMs }
    })
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
