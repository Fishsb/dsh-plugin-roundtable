/**
 * 全会话圆桌使用面扫描器（只读）。
 * 逐个解压 sessions/**.zstd（多帧），仅保留含 "roundtable" 的行，避免整量入内存。
 * 输出：每会话的圆桌工具调用序列 + 用户消息摘要 → JSONL
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ROOT = 'C:/Users/lk/.dsh/sessions'
const OUT = process.argv[2] || 'D:/lk/FF/dsh-plugin-roundtable/.audit/scan.jsonl'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function framesOf(buf) {
  const idx = []
  let i = 0
  for (;;) {
    const p = buf.indexOf(MAGIC, i)
    if (p < 0) break
    idx.push(p)
    i = p + 1
  }
  idx.push(buf.length)
  const out = []
  for (let k = 0; k < idx.length - 1; k++) {
    try { out.push(zlib.zstdDecompressSync(buf.subarray(idx[k], idx[k + 1]))) } catch { /* 跳过坏帧 */ }
  }
  return out
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (e.name === 'session.v3.jsonl.zstd') acc.push(p)
  }
  return acc
}

const files = walk(ROOT)
const ws = fs.createWriteStream(OUT)
let done = 0

for (const f of files) {
  const sessionId = path.basename(path.dirname(f))
  const workdir = path.basename(path.dirname(path.dirname(f)))
  let raw
  try { raw = fs.readFileSync(f) } catch { continue }
  const bufs = framesOf(raw)

  const rtCalls = []
  const userMsgs = []
  const rtResults = []
  let firstTs = null, lastTs = null
  let sawRoundtablePreset = false

  for (const b of bufs) {
    const text = b.toString('utf8')
    if (firstTs === null) {
      const m = text.match(/"time":(\d{13})/)
      if (m) firstTs = Number(m[1])
    }
    const m2 = text.match(/"time":(\d{13})/g)
    if (m2) lastTs = Number(m2[m2.length - 1].replace(/\D/g, ''))

    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      if (!line.includes('roundtable')) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (o.type === 'tool/call') {
        const nm = o.data?.name || ''
        if (nm.startsWith('roundtable')) {
          let args = {}
          try { args = JSON.parse(o.data.arguments || '{}') } catch { /* ignore */ }
          rtCalls.push({ seq: o.seq, name: nm, args, callId: o.data.callId, turn: o.data.turn, step: o.data.step })
        }
      } else if (o.type === 'tool/result') {
        const t = JSON.stringify(o.data?.message?.content || '').slice(0, 4000)
        if (t.includes('roundtable')) rtResults.push({ seq: o.seq, text: t })
      } else if (o.type === 'user/message') {
        const c = o.data?.content
        const txt = Array.isArray(c) ? c.map((x) => x.text || '').join('') : String(c || '')
        if (txt.trim() && !txt.startsWith('Current runtime context') && !txt.startsWith('<system-reminder')) {
          userMsgs.push(txt.replace(/\s+/g, ' ').slice(0, 400))
        }
      } else if (o.type === 'agent-preset/selected') {
        /* noop */
      }
    }
    if (text.includes('roundtable')) sawRoundtablePreset = true
  }

  if (rtCalls.length > 0) {
    ws.write(JSON.stringify({
      sessionId, workdir, file: f.replace(/\\/g, '/'),
      compressedBytes: raw.length,
      rtCallCount: rtCalls.length,
      rtCalls: rtCalls.map((c) => ({ name: c.name, seq: c.seq, turn: c.turn, args: c.args })),
      userMsgs,
      firstTs, lastTs,
    }) + '\n')
  }
  done++
  if (done % 20 === 0) process.stderr.write(`  ...${done}/${files.length}\n`)
}

ws.end(() => process.stderr.write(`done. scanned ${files.length} files -> ${OUT}\n`))
