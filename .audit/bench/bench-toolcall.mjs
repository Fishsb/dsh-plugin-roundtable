// 复现社区报告：GLM-5.3-Flash 在多工具 agentic prompt 下思考退化成 '!!!!!' 循环
// 依据：sglang#36669 / opencode#45533 ("thinking output degenerates into repeated '!' under multi-tool agentic prompts")
// 判据：统计每个模型在「多工具 + 多轮」下的 ①异常输出率 ②reasoning 内容是否出现重复字符塌缩
// 场景刻意贴近圆桌专家工况：若干工具定义 + 要求连续调用
import { writeFileSync } from 'node:fs';
import { KEY, BASE, MODELS, sleep } from './lib-dshapi.mjs';

// 模拟圆桌的多个工具：专家必须调 speak 提交产出，还需 status/gateway 等
const TOOLS = [
  { type: 'function', function: { name: 'roundtable_speak', description: '把本席贡献写入会议记录（聚合网关输入）', parameters: { type: 'object', properties: { content: { type: 'string', description: '贡献全文，须以[核心产出]与[下一步建议]结尾' }, to: { type: 'string', description: '定向听众，可空' } }, required: ['content'] } } },
  { type: 'function', function: { name: 'roundtable_status', description: '读取会议快照：节点活动、预算、待办', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'roundtable_summarize', description: '拉取聚合网关摘要', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'roundtable_next_round', description: '推进到下一轮并提交调度计划', parameters: { type: 'object', properties: { plan: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, task: { type: 'string' }, owner: { type: 'string' }, kind: { type: 'string', enum: ['change', 'review', 'survey'] } }, required: ['id', 'task', 'owner'] } } }, required: ['plan'] } } },
  { type: 'function', function: { name: 'roundtable_send_message', description: '给某个参与者发消息', parameters: { type: 'object', properties: { to: { type: 'string' }, content: { type: 'string' } }, required: ['to', 'content'] } } },
];

// 构造一个塌缩检测：最长连续重复单字符 run
function maxRepeatRun(s) {
  let best = 0, cur = 0, prev = '';
  for (const ch of s) {
    if (ch === prev) { cur++; } else { cur = 1; prev = ch; }
    if (cur > best) best = cur;
  }
  return best;
}

async function turn({ model, effort, messages, tools }) {
  const body = { model, messages, max_tokens: 2500, stream: true, stream_options: { include_usage: true } };
  if (effort) body.reasoning_effort = effort;
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(BASE + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
  } catch (e) { return { err: `connect:${e.message}` }; }
  if (!res.ok) return { err: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };

  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', text = '', reasoning = '', usage = null;
  const toolCalls = {};   // index -> {id,name,args}
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
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', args: '' };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
        }
      }
    }
  }
  const tcs = Object.values(toolCalls);
  return {
    ms: Math.round(performance.now() - t0),
    text, reasoning,
    reasonChars: reasoning.length, textChars: text.length,
    outTok: usage?.completion_tokens ?? null,
    inTok: usage?.prompt_tokens ?? null,
    reasonTok: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    toolCalls: tcs,
    maxRun: maxRepeatRun(reasoning + text),
  };
}

const SYS = '你是圆桌会议的专家席。你必须使用提供的工具完成任务。先调 roundtable_status 查看会议状态，然后调 roundtable_speak 提交你的[核心产出]与[下一步建议]。';

const out = { runs: [], summary: {} };
const ROUNDS = 6;

console.log('=== Q. 多工具 agentic 退化复现（模拟圆桌专家：多工具定义 + 多轮工具调用）===');
console.log(`工具数=${TOOLS.length}  每模型 ${ROUNDS} 轮  档位=high\n`);

for (const model of MODELS) {
  const msgs = [{ role: 'system', content: SYS }, { role: 'user', content: '请开始：查看会议状态，然后产出你这一席的贡献。' }];
  let bad = 0, runs = [];
  for (let r = 1; r <= ROUNDS; r++) {
    const t = await turn({ model, effort: 'high', messages: msgs, tools: TOOLS });
    if (t.err) { console.log(`  ${model} r${r}: ERR ${t.err}`); runs.push({ r, err: t.err }); await sleep(300); continue; }
    const calls = t.toolCalls.map((c) => c.name).join(',') || '(无工具调用)';
    const degenerate = t.maxRun >= 20;   // 连续 ≥20 个相同字符 = 塌缩
    if (degenerate) bad++;
    console.log(
      `  ${model} r${r}: ${String(t.ms).padStart(5)}ms out=${String(t.outTok).padStart(4)} reason=${String(t.reasonChars).padStart(5)}ch ` +
      `最长重复run=${String(t.maxRun).padStart(4)} ${degenerate ? '<<< 塌缩!' : ''} | 工具: ${calls}`
    );
    if (degenerate) console.log(`      塌缩样本(前80字符): ${(t.reasoning || t.text).slice(0, 80).replace(/\s+/g, ' ')}`);
    runs.push({ r, ms: t.ms, outTok: t.outTok, reasonChars: t.reasonChars, textChars: t.textChars, maxRun: t.maxRun, degenerate, calls });
    out.runs.push({ model, r, ...t, toolCalls: t.toolCalls });

    // 把工具调用结果回灌，形成多轮
    if (t.toolCalls.length) {
      msgs.push({ role: 'assistant', content: t.text || null, tool_calls: t.toolCalls.map((c) => ({ id: c.id || `call_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
      for (const c of t.toolCalls) {
        msgs.push({ role: 'tool', tool_call_id: c.id || 'x', content: JSON.stringify({ ok: true, note: `已执行 ${c.name}`, round: r }) });
      }
    } else {
      msgs.push({ role: 'assistant', content: t.text || '(空)' });
      msgs.push({ role: 'user', content: '请继续：调用 roundtable_speak 提交你的贡献。' });
    }
    await sleep(300);
  }
  const ok = runs.filter((x) => !x.err);
  out.summary[model] = {
    runs: ok.length, degenerate: bad,
    degenerateRate: ok.length ? +(bad / ok.length).toFixed(3) : null,
    avgOutTok: ok.length ? Math.round(ok.reduce((a, b) => a + b.outTok, 0) / ok.length) : null,
    avgReasonChars: ok.length ? Math.round(ok.reduce((a, b) => a + b.reasonChars, 0) / ok.length) : null,
    maxRunPeak: ok.length ? Math.max(...ok.map((x) => x.maxRun)) : null,
    toolCallRate: ok.length ? +(ok.filter((x) => x.calls && x.calls !== '(无工具调用)').length / ok.length).toFixed(3) : null,
  };
  console.log('');
}

console.log('########## 汇总 ##########');
for (const m of MODELS) {
  const s = out.summary[m];
  console.log(`${m}: 塌缩 ${s.degenerate}/${s.runs} (${(s.degenerateRate * 100).toFixed(1)}%) | 最长重复run峰值=${s.maxRunPeak} | 均 reason=${s.avgReasonChars}ch | 工具调用率=${(s.toolCallRate * 100).toFixed(1)}%`);
}
writeFileSync(new URL('./toolcall-degeneration.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\n已写入 toolcall-degeneration.json');
