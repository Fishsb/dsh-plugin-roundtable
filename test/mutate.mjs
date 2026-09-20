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
    from: "            runtime.mode.set(sessionId, 'manual', true)\n            if (!steerCaptain(captain, judged.text)) {\n              return fail('the session rejected the message (steer failed)')\n            }",
    to: "            if (!steerCaptain(captain, judged.text)) {\n              return fail('the session rejected the message (steer failed)')\n            }\n            runtime.mode.set(sessionId, 'manual', true)",
    // 对调后"两句都在"，所以那些 include 断言全绿 —— 只有顺序断言会响，
    // 响的就是它。这正是本变异存在的意义：证明顺序断言不是摆设。
    expect: '必须先置讨论模式再 steer',
  },
  20: {
    name: 'say 只落盘不唤醒主持人（气泡出现了却永远不会有人回应）',
    file: 'src/rpc.ts',
    from: "            const delivered = captain === undefined\n              ? false\n              : steerCaptain(captain, `Message from the user (meeting group chat):\\n\\n${text}`)",
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
    from: 'steerCaptain(captain, `Message from the user (meeting group chat):\\n\\n${text}`)',
    to: 'steerCaptain(captain, text)',
    expect: '唤醒时没有标明这条来自用户',
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
  return blocks
}

const url = new URL(`../${mutation.file}`, import.meta.url)
const original = readFileSync(url, 'utf8')
if (!original.includes(mutation.from)) {
  console.error(`变异 ${id} 的锚点没找到（实现已变？）：${mutation.from.slice(0, 60)}`)
  process.exit(3)
}

let failed = 0
let attributed = false
try {
  writeFileSync(url, original.replace(mutation.from, mutation.to), 'utf8')
  let output = ''
  try {
    output = execFileSync('npm test', { cwd: projectRoot, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  const failLine = output.split('\n').find((line) => line.startsWith('# fail'))
  failed = Number.parseInt((failLine ?? '# fail NaN').replace('# fail ', ''), 10)
  const passLine = output.split('\n').find((line) => line.startsWith('# pass'))
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
  const attributedTo = matched
    .map((block) => (block.split('\n').find((line) => /^not ok /.test(line.trim())) ?? '').trim())
    .filter((line) => line !== '')
  console.log(`变异 ${id}：${mutation.name}`)
  console.log(`  ${failLine ?? '(无 # fail 行)'} / ${passLine ?? '(无 # pass 行)'}`)
  console.log(`  期望守卫文案：${mutation.expect}`)
  for (const line of attributedTo) console.log(`   ↳ 命中：${line.slice(0, 120)}`)
  if (failed > 0 && !attributed) {
    console.log(`  ⚠ 有 ${blocks.length} 个失败块，但没有一个含期望文案 —— 疑非目标守卫（或 expect 写错）`)
    for (const block of blocks.slice(0, 3)) {
      const line = block.split('\n').find((l) => /^not ok /.test(l.trim()))?.trim() ?? ''
      const err = block.split('\n').find((l) => /^\s*error: /.test(l))?.trim() ?? ''
      console.log(`     ${line.slice(0, 110)}  ${err.slice(0, 110)}`)
    }
  }
  console.log(`  判定：${failed > 0 && attributed ? 'PASS（目标守卫真的转红）' : failed > 0 ? 'FAIL（转红了，但不是这条守卫）' : 'FAIL（假绿：改坏了却报不出来）'}`)
} finally {
  // 逐字节还原：变异必须不留残留（否则下一次实跑会带着坏代码通过）。
  writeFileSync(url, original, 'utf8')
}

process.exit(failed > 0 && attributed ? 0 : 1)
