// 严格 prefill 测量：两模型交错采样（抵消服务端负载漂移）+ 空基线扣除（分离排队/建连开销）
import { writeFileSync } from 'node:fs';
import { KEY, BASE, MODELS, sleep } from './lib-dshapi.mjs';
const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'.split(' ');
const filler = (n) => { let s = ''; for (let i = 0; i < n; i++) s += words[i % words.length] + ' '; return s; };

async function ttft({ model, content, maxTokens = 16 }) {
  const t0 = performance.now();
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model, messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content }],
      max_tokens: maxTokens, stream: true, stream_options: { include_usage: true },
    }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', usage = null, firstAt = null;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim(); if (p === '[DONE]') continue;
      let j; try { j = JSON.parse(p); } catch { continue; }
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta;
      if (d && ((d.content ?? '').length || (d.reasoning_content ?? '').length)) {
        if (firstAt === null) firstAt = performance.now();
      }
    }
  }
  return { ttftMs: firstAt ? +(firstAt - t0).toFixed(0) : null, inTok: usage?.prompt_tokens ?? null };
}

const SIZES = [0, 500, 2000, 5000, 12000, 30000, 60000];
const REPS = 3;
const data = {}; for (const m of MODELS) data[m] = {};

console.log('交错采样开始（每档每模型 3 次取中位）...\n');
for (const n of SIZES) {
  const content = n === 0 ? 'hi' : filler(n) + '\n\n只回复：OK';
  for (const model of MODELS) {
    const rows = [];
    for (let i = 0; i < REPS; i++) {
      const r = await ttft({ model, content });
      if (r.ttftMs) rows.push(r);
      await sleep(150);
    }
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const rec = {
      fillerWords: n,
      inTok: med(rows.map((r) => r.inTok)),
      ttftMs: med(rows.map((r) => r.ttftMs)),
      samples: rows.map((r) => `${r.inTok}tok/${r.ttftMs}ms`),
    };
    data[model][n] = rec;
    console.log(`${model} filler=${n}: in=${rec.inTok} tok  TTFT中位=${rec.ttftMs}ms  [${rec.samples.join(' | ')}]`);
  }
}

console.log('\n=== 线性拟合：TTFT = 基线(排队+建连) + inTok / prefill速率 ===');
const summary = {};
for (const model of MODELS) {
  const pts = SIZES.map((n) => data[model][n]).filter((r) => r.inTok);
  // 最小二乘
  const N = pts.length;
  const sx = pts.reduce((a, r) => a + r.inTok, 0), sy = pts.reduce((a, r) => a + r.ttftMs, 0);
  const sxx = pts.reduce((a, r) => a + r.inTok * r.inTok, 0), sxy = pts.reduce((a, r) => a + r.inTok * r.ttftMs, 0);
  const slope = (N * sxy - sx * sy) / (N * sxx - sx * sx);
  const intercept = (sy - slope * sx) / N;
  const rate = slope > 0 ? Math.round(1000 / slope) : null;
  summary[model] = { baseMs: +intercept.toFixed(0), slopeMsPerTok: +slope.toFixed(6), prefillTokPerS: rate };
  console.log(`${model}: 基线开销=${intercept.toFixed(0)}ms  斜率=${slope.toFixed(6)}ms/tok  => 净 prefill 速率 ≈ ${rate} tok/s`);
  // 也报最大档的边际速率
  const a = pts[pts.length - 3], b = pts[pts.length - 1];
  const marg = Math.round((b.inTok - a.inTok) / ((b.ttftMs - a.ttftMs) / 1000));
  console.log(`   （大 prompt 边际：${a.inTok}->${b.inTok} tok, ${a.ttftMs}->${b.ttftMs}ms => ${marg} tok/s）`);
}

writeFileSync(new URL('./bench-result-6-prefill.json', import.meta.url), JSON.stringify({ data, summary }, null, 2));
console.log('\n已写入 bench-result-6-prefill.json');
