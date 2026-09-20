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
    from: "                content: text,\n                source: 'user',",
    to: '                content: text,',
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
    expect: '混用了拓扑样式模块',
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
    expect: '缺少 chatSend',
  },
  11: {
    name: '空状态内联一份自己的 textarea（输入框不再与群聊共用）',
    file: 'src/client/RoundTableView.tsx',
    from: '              <ChatComposer\n                t={translate}\n                sending={steerSending}\n                onSend={(text) => { void startMeeting(text) }}\n                placeholderKey="emptyInputPlaceholder"\n              />',
    to: '              <textarea className={styles.input} />',
    expect: '空状态块里内联了自己的 textarea',
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
}

const id = process.argv[2]
const mutation = mutations[id]
if (mutation === undefined) {
  console.error(`未知变异编号 ${id}；可用：${Object.keys(mutations).join(', ')}`)
  process.exit(2)
}

const url = new URL(`../${mutation.file}`, import.meta.url)
const original = readFileSync(url, 'utf8')
if (!original.includes(mutation.from)) {
  console.error(`变异 ${id} 的锚点没找到（实现已变？）：${mutation.from.slice(0, 60)}`)
  process.exit(3)
}

let failed = 0
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
  // 判定只看 fail 数：基线本来 0 失败，所以"变异后 > 0"就是守卫真的抓到了。
  // ⚠ 不能用输出里有没有那句断言文案 —— 测试名本身也在输出里，即使通过也会命中
  // （这一条正是本探针自己踩过的假绿，第一版就是这么判的）。
  console.log(`变异 ${id}：${mutation.name}`)
  console.log(`  ${failLine ?? '(无 # fail 行)'} / ${passLine ?? '(无 # pass 行)'}`)
  console.log(`  判定：${failed > 0 ? 'PASS（守卫真的转红）' : 'FAIL（假绿：改坏了却报不出来）'}`)
} finally {
  // 逐字节还原：变异必须不留残留（否则下一次实跑会带着坏代码通过）。
  writeFileSync(url, original, 'utf8')
}

process.exit(failed > 0 ? 0 : 1)
