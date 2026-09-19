/**
 * 验收审计器：把「思考强度到底有没有进该席的模型请求头」变成可机检事实。
 *
 * 为什么必须按帧扫：`session.v3.jsonl.zstd` 是**多帧 zstd 首尾相接**（本仓实测一席
 * 216 帧）。用 `createZstdDecompress()` 流式解压只会吐出第一帧 —— 会得到
 * 「1 行、0 条 request/header」的**假红**，据此判「未贯通」是错的。所以这里按
 * magic `28 b5 2f fd` 逐帧扫描后逐帧解压。
 *
 * 判据（A5/A6，见验收定稿表）：
 *   A5 设了档位的席 → 每个 request/header 的 config.reasoningEffort 必须逐字等于设定值；
 *   A6 未设档位的席 → 请求头里**不得**出现 reasoningEffort（= 继承主持人路由，不得硬塞默认值）。
 *
 * 用法：
 *   node scripts/audit-reasoning-effort.mjs --state-dir .roundtable --meeting <会议id>
 *   node scripts/audit-reasoning-effort.mjs --session <session.v3.jsonl.zstd> [...更多文件]
 * 退出码：0 = 全体通过；1 = 有违例；2 = 用法错误。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 逐帧解压全部帧，返回解码后的完整文本。 */
function decodeSessionLog(file) {
  const buf = readFileSync(file)
  const offsets = []
  for (let at = buf.indexOf(ZSTD_MAGIC); at >= 0; at = buf.indexOf(ZSTD_MAGIC, at + 4)) offsets.push(at)
  let text = ''
  let ok = 0
  let failed = 0
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
      ok += 1
    } catch {
      failed += 1
    }
  }
  return { text, frames: ok, failed }
}

/** 取该会话日志里全部 request/header 的 config。 */
function headerConfigs(file) {
  const { text, frames, failed } = decodeSessionLog(file)
  const configs = []
  for (const line of text.split('\n')) {
    if (line === '' || !line.includes('"request/header"')) continue
    try {
      const parsed = JSON.parse(line)
      const config = parsed?.data?.header?.config
      if (config !== undefined) configs.push({ seq: parsed.seq, config })
    } catch {
      // 单行不可解析不致命：帧级失败已由 frames/failed 计数覆盖。
    }
  }
  return { configs, frames, failed }
}

/** 工作区路径 → 会话目录名（实测规则：`: \\ /` 全部换成 `-` 后再用 `--` 包裹）。 */
function workspaceSlug(workspace) {
  return `--${workspace.replace(/[\\/:]/g, '-')}--`
}

/** 在会话根下定位某个 childId 的日志（先按 slug 直查，再兜底递归）。 */
function locate(childId, workspace) {
  const direct = join(homedir(), '.dsh', 'sessions', workspaceSlug(workspace), childId, 'session.v3.jsonl.zstd')
  if (existsSync(direct)) return direct
  const root = join(homedir(), '.dsh', 'sessions')
  if (!existsSync(root)) return undefined
  for (const slug of readdirSync(root)) {
    const candidate = join(root, slug, childId, 'session.v3.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const argv = process.argv.slice(2)
const flag = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const sessions = []
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--session' && argv[index + 1] !== undefined) sessions.push(argv[index + 1])
}

const stateDir = flag('--state-dir')
const meetingId = flag('--meeting')
if (sessions.length === 0 && (stateDir === undefined || meetingId === undefined)) {
  console.error('usage: node scripts/audit-reasoning-effort.mjs --state-dir <dir> --meeting <id> | --session <log.zstd ...>')
  process.exit(2)
}

/** 待审条目：{seat, expected(设定值 or ''=继承), presetId, file} */
const targets = []
if (stateDir !== undefined && meetingId !== undefined) {
  const meetingFile = join(stateDir, meetingId, 'meeting.json')
  const meeting = JSON.parse(readFileSync(meetingFile, 'utf8'))
  for (const node of meeting.nodes ?? []) {
    if (node.status === 'removed' || node.id === '') continue
    const file = locate(node.id, stateDir.replace(/[\\/][^\\/]*$/, ''))
    targets.push({ seat: node.key, expected: node.reasoningEffort ?? '', presetId: node.presetId ?? '', file })
  }
} else {
  for (const file of sessions) {
    if (!existsSync(file) || !statSync(file).isFile()) {
      console.error(`not a file: ${file}`)
      process.exit(2)
    }
    targets.push({ seat: file.split(/[\\/]/).slice(-2)[0], expected: null, presetId: '', file })
  }
}

let violations = 0
let withEffort = 0
for (const target of targets) {
  if (target.file === undefined) {
    console.log(`SKIP ${target.seat} — 会话日志未定位（该席可能从未被拉起）`)
    continue
  }
  const { configs, frames, failed } = headerConfigs(target.file)
  const seen = configs.map((entry) => entry.config.reasoningEffort).filter((value) => value !== undefined)
  const label = target.expected === null ? '(仅审计：未与会议设定比对)' : target.expected === '' ? '继承主持人' : `设定=${target.expected}`
  console.log(`${target.seat} | ${label} | presetId=${target.presetId === '' ? '(空)' : target.presetId} | frames=${frames} failed=${failed} | headers=${configs.length} | 档位出现=${JSON.stringify([...new Set(seen)])}`)
  if (target.expected === null) continue
  if (target.expected === '') {
    // A6：未设档位不得出现 reasoningEffort。
    if (seen.length > 0) {
      console.log(`  ✗ A6 违例：该席未设档位，请求头却出现 ${JSON.stringify([...new Set(seen)])}`)
      violations += 1
    }
    continue
  }
  withEffort += 1
  if (configs.length === 0) {
    console.log('  ✗ A5 违例：一份 request/header 都没取到（分母不可判定，不得记绿）')
    violations += 1
    continue
  }
  const wrong = configs.filter((entry) => entry.config.reasoningEffort !== target.expected)
  if (wrong.length > 0) {
    console.log(`  ✗ A5 违例：${wrong.length}/${configs.length} 条请求头不是 ${target.expected}，例：seq=${wrong[0].seq} config=${JSON.stringify(wrong[0].config)}`)
    violations += 1
  }
}

if (withEffort === 0) {
  // 与判据表同一条纪律：分母为 0 时显式记 0，绝不报绿。
  console.log('⚠ A5 分母 = 0：没有任何一席设了档位 —— 判据不可判定，本次不得记为通过')
  process.exit(1)
}
console.log(`\nA5 分母 = ${withEffort}；违例 = ${violations}`)
process.exit(violations === 0 ? 0 : 1)
