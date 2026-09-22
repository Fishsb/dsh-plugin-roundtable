// 加码复现：把工具数提到 18（贴近真实 DSH 会话的工具面）并延长多轮链，
// 给出塌缩最充分的触发机会。若仍不复现，才能说"本链路未命中该故障"。
import { writeFileSync } from 'node:fs';
import { KEY, BASE, MODELS, sleep } from './lib-dshapi.mjs';

const mk = (name, desc, props = {}) => ({ type: 'function', function: { name, description: desc, parameters: { type: 'object', properties: props, required: [] } } });
const TOOLS = [
  mk('roundtable_speak', '把贡献写入会议记录', { content: { type: 'string' }, to: { type: 'string' } }),
  mk('roundtable_status', '读取会议快照'),
  mk('roundtable_summarize', '拉取网关摘要'),
  mk('roundtable_next_round', '推进轮次并提交调度计划', { plan: { type: 'array', items: { type: 'object' } }, note: { type: 'string' } }),
  mk('roundtable_send_message', '给参与者发消息', { to: { type: 'string' }, content: { type: 'string' }, work_item: { type: 'string' } }),
  mk('roundtable_add_node', '新增专家席', { name: { type: 'string' }, role: { type: 'string' }, preset: { type: 'string' } }),
  mk('roundtable_remove_node', '移除专家席', { name: { type: 'string' } }),
  mk('roundtable_list_presets', '列出角色预设', { filter: { type: 'string' } }),
  mk('roundtable_request_decision', '请用户拍板', { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }),
  mk('roundtable_plan_meeting', '展示设置卡', { name: { type: 'string' }, goal: { type: 'string' }, experts: { type: 'array', items: { type: 'object' } } }),
  mk('roundtable_create', '创建会议', { name: { type: 'string' }, goal: { type: 'string' }, mode: { type: 'string' } }),
  mk('roundtable_export_meeting', '导出会议', { save: { type: 'boolean' } }),
  mk('read', '读文件', { file_path: { type: 'string' }, offset: { type: 'number' } }),
  mk('write', '写文件', { file_path: { type: 'string' }, content: { type: 'string' } }),
  mk('edit', '编辑文件', { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }),
  mk('grep', '搜索内容', { pattern: { type: 'string' }, path: { type: 'string' } }),
  mk('pwsh', '执行命令', { command: { type: 'string' }, description: { type: 'string' } }),
  mk('skill', '加载技能', { name: { type: 'string' } }),
];

function maxRepeatRun(s) { let best = 0, cur = 0, prev = ''; for (const ch of s) { if (ch === prev) cur++; else { cur = 1; prev = ch; } if (cur > best) best = cur; } return best; }

async function turn({ model, messages, effort = 'high' }) {
  const body = { model, messages, max_tokens: 3000, stream: true, stream_options: { include_usage: true }, tools: TOOLS, tool_choice: 'auto', reasoning_effort: effort };
  const t0 = performance.now();
  let res;
  try { res = await fetch(BASE + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) }); }
  catch (e) { return { err: `connect:${e.message}` }; }
  if (!res.ok) return { err: `HTTP ${res.status}` };
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', text = '', reasoning = '', usage = null; const tc = {};
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
      const d = j.choices?.[0]?.delta; if (!d) continue;
      if (d.content) text += d.content;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      for (const c of (d.tool_calls ?? [])) { const k = c.index ?? 0; tc[k] ??= { id: '', name: '', args: '' }; if (c.id) tc[k].id = c.id; if (c.function?.name) tc[k].name += c.function.name; if (c.function?.arguments) tc[k].args += c.function.arguments; }
    }
  }
  return { ms: Math.round(performance.now() - t0), text, reasoning, reasonChars: reasoning.length, textChars: text.length, outTok: usage?.completion_tokens ?? null, toolCalls: Object.values(tc), maxRun: maxRepeatRun(reasoning + text) };
}

const SYS = '你是圆桌会议主持人/专家席。必须使用工具推进会议。每轮：先看状态，再产出一席贡献，必要时推进轮次。严格按工具 schema 调用。';
const out = { runs: [], summary: {} };
const ROUNDS = 8;

console.log(`=== R. 加码复现：工具数=${TOOLS.length}（贴近真实会话工具面）每模型 ${ROUNDS} 轮 ===\n`);
for (const model of MODELS) {
  const msgs = [{ role: 'system', content: SYS }, { role: 'user', content: '开始：查看会议状态并产出你的贡献，然后推进到下一轮。' }];
  const runs = []; let bad = 0;
  for (let r = 1; r <= ROUNDS; r++) {
    const t = await turn({ model, messages: msgs });
    if (t.err) { console.log(`  ${model} r${r}: ERR ${t.err}`); runs.push({ r, err: t.err }); await sleep(250); continue; }
    const calls = t.toolCalls.map((c) => c.name).join(',') || '(无工具调用)';
    const degen = t.maxRun >= 20;
    if (degen) { bad++; console.log(`      >>> 塌缩! 样本: ${(t.reasoning || t.text).slice(0, 100).replace(/\s+/g, ' ')}`); }
    console.log(`  ${model} r${r}: ${String(t.ms).padStart(5)}ms out=${String(t.outTok).padStart(4)} reason=${String(t.reasonChars).padStart(5)}ch run=${String(t.maxRun).padStart(3)} ${degen ? '<<<' : '   '} | ${calls}`);
    runs.push({ r, ms: t.ms, outTok: t.outTok, reasonChars: t.reasonChars, maxRun: t.maxRun, degenerate: degen, calls });
    out.runs.push({ model, r, ...t });

    if (t.toolCalls.length) {
      msgs.push({ role: 'assistant', content: t.text || null, tool_calls: t.toolCalls.map((c, i) => ({ id: c.id || `call_${model}_${r}_${i}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
      for (const [i, c] of t.toolCalls.entries()) msgs.push({ role: 'tool', tool_call_id: c.id || `call_${model}_${r}_${i}`, content: JSON.stringify({ ok: true, note: `已执行 ${c.name}` }) });
    } else {
      msgs.push({ role: 'assistant', content: t.text || '(空)' });
      msgs.push({ role: 'user', content: '必须调用工具（roundtable_status 或 roundtable_speak 等），不要只回文本。' });
    }
    await sleep(250);
  }
  const ok = runs.filter((x) => !x.err);
  const withCalls = ok.filter((x) => x.calls && x.calls !== '(无工具调用)');
  out.summary[model] = { runs: ok.length, degenerate: bad, degenerateRate: ok.length ? +(bad / ok.length).toFixed(3) : null, toolCallRate: ok.length ? +(withCalls.length / ok.length).toFixed(3) : null, maxRunPeak: ok.length ? Math.max(...ok.map((x) => x.maxRun)) : null, avgOutTok: ok.length ? Math.round(ok.reduce((a, b) => a + b.outTok, 0) / ok.length) : null, avgMs: ok.length ? Math.round(ok.reduce((a, b) => a + b.ms, 0) / ok.length) : null };
  console.log('');
}

console.log('########## 汇总（18 工具 × 8 轮）##########');
for (const m of MODELS) {
  const s = out.summary[m];
  console.log(`${m}\n  塌缩 ${s.degenerate}/${s.runs} (${(s.degenerateRate * 100).toFixed(1)}%) | 最长重复run峰值=${s.maxRunPeak} | 工具调用率=${(s.toolCallRate * 100).toFixed(1)}% | 均耗时=${s.avgMs}ms | 均out=${s.avgOutTok}tok`);
}
writeFileSync(new URL('./toolcall-degeneration-18.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\n已写入 toolcall-degeneration-18.json');
