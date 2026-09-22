/**
 * 全盘会议统计（只读）：扫描所有 .roundtable 目录（跨工作区），
 * 输出每场会议的关键指标 → JSONL + 汇总。
 */
import fs from 'node:fs'
import path from 'node:path'

const SCAN_ROOTS = [
  'D:/FF',
  'D:/lk/FF',
  'C:/Users/lk/.dsh',
]
const OUT = process.argv[2] || 'D:/lk/FF/dsh-plugin-roundtable/.audit/meetings.jsonl'
const MAX_DEPTH = 7

function findMeetingDirs(root, depth = 0, acc = []) {
  if (depth > MAX_DEPTH) return acc
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '$RECYCLE.BIN') continue
    const p = path.join(root, e.name)
    if (e.name === '.roundtable') {
      let subs
      try { subs = fs.readdirSync(p, { withFileTypes: true }) } catch { continue }
      for (const s of subs) {
        if (!s.isDirectory()) continue
        const mf = path.join(p, s.name, 'meeting.json')
        if (fs.existsSync(mf)) acc.push({ dir: path.join(p, s.name), name: s.name })
      }
      continue
    }
    findMeetingDirs(p, depth + 1, acc)
  }
  return acc
}

const seen = new Set()
const meetings = []
for (const root of SCAN_ROOTS) {
  for (const m of findMeetingDirs(root)) {
    const key = m.dir.replace(/\\/g, '/').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    meetings.push(m)
  }
}

const ws = fs.createWriteStream(OUT)
const rows = []
for (const m of meetings) {
  let mj
  try { mj = JSON.parse(fs.readFileSync(path.join(m.dir, 'meeting.json'), 'utf8')) } catch { continue }
  let transcript = []
  const tf = path.join(m.dir, 'transcript.jsonl')
  if (fs.existsSync(tf)) {
    try {
      transcript = fs.readFileSync(tf, 'utf8').split('\n').filter((x) => x.trim()).map(JSON.parse)
    } catch { /* ignore */ }
  }
  const seats = (mj.nodes || []).length
  const presetIds = [...new Set((mj.nodes || []).map((n) => n.presetId).filter(Boolean))]
  const items = (mj.roundPlans || []).flatMap((p) => p.items || [])
  const row = {
    name: m.name,
    workspace: m.dir.replace(/\\/g, '/'),
    mode: mj.mode,
    round: mj.round ?? 0,
    status: mj.status,
    seats,
    presetIds,
    edges: (mj.edges || []).length,
    decisions: (mj.decisions || []).length,
    maxRounds: mj.budget?.maxRounds,
    maxTokens: mj.budget?.maxTokens,
    usedTokens: mj.budget?.usedTokens ?? 0,
    usedRounds: mj.budget?.usedRounds ?? 0,
    planCount: (mj.roundPlans || []).length,
    planItems: items.length,
    planItemsWithDeps: items.filter((i) => (i.dependsOn || []).length > 0).length,
    planItemsNewSeat: items.filter((i) => String(i.owner || '').startsWith('new:')).length,
    transcriptRows: transcript.length,
    transcriptChars: transcript.reduce((a, x) => a + (x.content || '').length, 0),
    speakers: [...new Set(transcript.map((x) => x.nodeKey))].length,
    workItemTagged: transcript.filter((x) => x.workItem).length,
    hasReview: fs.existsSync(path.join(m.dir, 'review.json')),
    hasExport: fs.existsSync(path.join(m.dir, 'export.md')),
    createdAt: mj.createdAt ?? 0,
    updatedAt: mj.updatedAt ?? 0,
  }
  rows.push(row)
  ws.write(JSON.stringify(row) + '\n')
}
ws.end(() => {
  console.error(`meetings: ${rows.length}`)
})
