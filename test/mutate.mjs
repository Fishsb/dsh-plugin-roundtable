/**
 * 变异探针：把实现精确改坏一处，跑测试看对应守卫是否**真的转红**。
 *
 * 为什么要这个："断言写了"与"断言有效"是两件事 —— 本仓已经踩过两次假绿
 * （锚点字符串同时出现在注释里、断言被挂载路径那次冒充）。
 *
 * 用法：node test/mutate.mjs <编号>
 * 每个变异自己负责恢复原文件（finally 里还原字节），不留残留。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
  { anchor: mutation.from.replace(/\n/g, '\r\n'), replacement: mutation.to.replace(/\n/g, '\r\n') },
  { anchor: mutation.from, replacement: mutation.to },
]
const hit = candidates.find((candidate) => original.includes(candidate.anchor))
if (hit === undefined) {
  console.error(`变异 ${id} 的锚点没找到（实现已变？）：${mutation.from.slice(0, 60)}`)
  process.exit(3)
}
const anchor = hit.anchor
const replacement = hit.replacement

let failed = 0
let attributed = false
/** 归因命中块数（PASS 只要求 >0；两者不等 = 套件里另有红灯） */
let attributedBlocks = 0
try {
  writeFileSync(url, original.replace(anchor, replacement), 'utf8')
  let output = ''
  try {
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
} finally {
  // 逐字节还原：变异必须不留残留（否则下一次实跑会带着坏代码通过）。
  writeFileSync(url, original, 'utf8')
}

/*
 * 判定汇总（2026-09-25 加）：单条运行时，"PASS + 其它失败块" 与 "PASS" 看起来一样，
 * 而前者其实是**假绿在场**（别的原因把套件弄红了，目标守卫只是碰巧也红了）。
 * 归因块仍是 PASS 的唯一判据；这一行只是把并列失败数报出来，不留白。
 */
if (failed > 0 && attributed && attributedBlocks < failed) {
  console.log(`  ⚠ 另有 ${failed - attributedBlocks} 个失败块不含本变异的期望文案 —— 归因仍成立，但套件里还有别的红灯`)
}
process.exit(failed > 0 && attributed ? 0 : 1)
