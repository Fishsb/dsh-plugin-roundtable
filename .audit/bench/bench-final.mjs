// 终版严格测量：以「多次取最小值」隔离服务端排队噪声，分离三个量
//   ① 访问速度：建连/TTFT（净排队基线）
//   ② 输入 tokens 速度：prefill tok/s（按 TTFT 增量 / token 增量）
//   ③ 输出 tokens 速度：decode tok/s（按首字→收尾窗口）
// 依据：TTFT 被排队延迟主导（实测出现过 60k prompt 的 TTFT 低于 12k），
//       故用 min 作为「真实能力」估计量、median 作为「实际体验」估计量，两者都报。
import { writeFileSync } from 'node:fs';
import { KEY, BASE, MODELS, sleep } from './lib-dshapi.mjs';
const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'.split(' ');
const filler = (n) => { let s = ''; for (let i = 0; i < n; i++) s += words[i % words.length] + ' '; return s; };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mn = (a) => Math.min(...a);
const mx = (a) => Math.max(...a);

async function req({ model, effort = 'low', messages, maxTokens }) {
  const body = { model, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } };
  if (effort) body.reasoning_effort = effort;
  const t0 = performance.now();
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', usage = null, firstAt = null, nDelta = 0;
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
        nDelta++;
        if (firstAt === null) firstAt = performance.now();
      }
    }
  }
  const end = performance.now();
  return {
    ttftMs: firstAt ? Math.round(firstAt - t0) : null,
    totalMs: Math.round(end - t0),
    decodeMs: firstAt ? Math.round(end - firstAt) : null,
    inTok: usage?.prompt_tokens ?? null,
    outTok: usage?.completion_tokens ?? null,
    reasonTok: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    nDelta,
  };
}

const out = { ttft: {}, decode: {}, summary: {} };

// ---------- ① 访问速度 + ② 输入速率 ----------
console.log('=== ① / ② 访问速度与输入(prefill)速率 ===');
console.log('每档 6 次，交错采样；min=真实能力估计，med=实际体验估计\n');
const SIZES = [0, 1000, 5000, 20000];
for (const n of SIZES) {
  const content = n === 0 ? 'hi' : filler(n) + '\n\n只回复：OK';
  for (const model of MODELS) {
    const rows = [];
    for (let i = 0; i < 6; i++) {
      const r = await req({ model, messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content }], maxTokens: 16 });
      if (!r.error) rows.push(r);
      await sleep(120);
    }
    const rec = {
      filler: n,
      inTok: rows[0]?.inTok ?? null,
      ttftMin: mn(rows.map((r) => r.ttftMs)),
      ttftMed: med(rows.map((r) => r.ttftMs)),
      ttftMax: mx(rows.map((r) => r.ttftMs)),
      samples: rows.map((r) => r.ttftMs),
    };
    out.ttft[`${model}|${n}`] = rec;
    console.log(`${model} filler=${String(n).padStart(5)}: in=${String(rec.inTok).padStart(6)}tok  TTFT min=${String(rec.ttftMin).padStart(5)} med=${String(rec.ttftMed).padStart(5)} max=${String(rec.ttftMax).padStart(6)}ms  [${rec.samples.join(' ')}]`);
  }
  console.log('');
}

// ---------- 净 prefill：以 min 口径做两点法 ----------
console.log('=== 净输入速率（用 min 口径做两点法：Δtok / Δttft）===');
for (const model of MODELS) {
  const a = out.ttft[`${model}|0`], b = out.ttft[`${model}|20000`];
  const rate = Math.round((b.inTok - a.inTok) / ((b.ttftMin - a.ttftMin) / 1000));
  const rateMed = Math.round((b.inTok - a.inTok) / ((b.ttftMed - a.ttftMed) / 1000));
  out.summary[`prefill_${model}`] = { byMin: rate, byMed: rateMed, dTok: b.inTok - a.inTok, dTtftMin: b.ttftMin - a.ttftMin };
  console.log(`${model}: Δtok=${b.inTok - a.inTok}  Δttft(min)=${b.ttftMin - a.ttftMin}ms => ${rate} tok/s (min口径)`);
  console.log(`              Δttft(med)=${b.ttftMed - a.ttftMed}ms => ${rateMed} tok/s (med口径)`);
}

// ---------- ③ 输出速率 ----------
console.log('\n=== ③ 输出(decode)速率 · 固定 prompt 压满输出，每模型 6 次 ===');
const P = '请输出从 1 到 400 的整数，用英文逗号分隔，不要任何其他文字、不要换行、不要解释。';
for (const model of MODELS) {
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const r = await req({ model, messages: [{ role: 'user', content: P }], maxTokens: 1200 });
    if (!r.error && r.decodeMs > 400) rows.push(r);
    await sleep(150);
  }
  const rates = rows.map((r) => r.outTok / (r.decodeMs / 1000));
  const rec = {
    outTokSamples: rows.map((r) => r.outTok),
    ttftSamples: rows.map((r) => r.ttftMs),
    decodeMsSamples: rows.map((r) => r.decodeMs),
    rateMin: +mn(rates).toFixed(1), rateMed: +med(rates).toFixed(1), rateMax: +mx(rates).toFixed(1),
    outTokMed: med(rows.map((r) => r.outTok)),
  };
  out.decode[model] = rec;
  console.log(`${model}: 输出速率 ${rec.rateMin} ~ ${rec.rateMed}(中位) ~ ${rec.rateMax} tok/s | 实际产出 ${rec.outTokMed} tok`);
  console.log(`  每次: ${rows.map((r) => `${r.outTok}tok/${r.decodeMs}ms=${(r.outTok / (r.decodeMs / 1000)).toFixed(0)}t/s`).join('  ')}`);
  await sleep(300);
}

// ---------- 汇总表 ----------
console.log('\n\n########## 汇总 ##########');
const L = (s) => console.log(s);
L('指标                     | V4.1F            | GLM-5.3F');
L('-------------------------|------------------|------------------');
for (const key of ['0', '1000', '5000', '20000']) {
  const a = out.ttft[`deepseek-v4.1-flash|${key}`], b = out.ttft[`glm-5.3-flash|${key}`];
  L(`${('TTFT in=' + a.inTok + 'tok').padEnd(24)} | ${(a.ttftMin + 'ms(min)').padEnd(16)} | ${(b.ttftMin + 'ms(min)').padEnd(16)}`);
}
const pa = out.summary['prefill_deepseek-v4.1-flash'], pb = out.summary['prefill_glm-5.3-flash'];
L(`${'净 prefill 速率'.padEnd(24)} | ${(pa.byMin + ' tok/s').padEnd(16)} | ${(pb.byMin + ' tok/s').padEnd(16)}`);
const da = out.decode['deepseek-v4.1-flash'], db = out.decode['glm-5.3-flash'];
L(`${'输出 decode 速率(中位)'.padEnd(24)} | ${(da.rateMed + ' tok/s').padEnd(16)} | ${(db.rateMed + ' tok/s').padEnd(16)}`);
L(`${'输出 decode 速率(最快)'.padEnd(24)} | ${(da.rateMax + ' tok/s').padEnd(16)} | ${(db.rateMax + ' tok/s').padEnd(16)}`);
L(`${'输出速率稳定性(min~max)'.padEnd(24)} | ${(da.rateMin + '~' + da.rateMax).padEnd(16)} | ${(db.rateMin + '~' + db.rateMax).padEnd(16)}`);

writeFileSync(new URL('./bench-final.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\n已写入 bench-final.json');
