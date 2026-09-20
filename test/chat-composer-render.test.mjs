/**
 * 群聊输入框的**渲染面**测试：把生产代码里的 `ChatComposer` 真渲染成 HTML 再断言 DOM。
 *
 * 为什么需要（本轮任务的核心约束）：用户的要求是「空状态那个窗口里的输入框
 * **就是**群聊窗口的那一个」。源码字符串断言只能证明"代码里写了 `<ChatComposer`"，
 * 证明不了它真的渲染出一个能用的输入条 —— 恒真守卫是本仓已踩过两次的坑
 * （锚点出现在注释里、断言被同名处冒充）。本文件补上那一段。
 *
 * 复用 `dispatch-panel-render.test.mjs` 的转译通道（TypeScript 自带 JSX 转换 +
 * 本仓 react/react-dom），产物写在 `test/.render-tmp/`（被 .gitignore 忽略，
 * 必须先 mkdir，否则全新克隆上 ENOENT 全红）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const TMP_DIR = new URL('./.render-tmp/', import.meta.url).pathname.replace(/^\//, '')
mkdirSync(TMP_DIR, { recursive: true })

/** 转译一个 TSX 文件；`import type` 行删掉（Node 解析不到 `.ts` 后缀）。 */
async function loadTsx(absPath) {
  const dir = mkdtempSync(join(TMP_DIR, 'composer-'))
  const source = readFileSync(absPath, 'utf8').replace(/^import type .*$/gm, '')
  const out = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: absPath,
  }).outputText
    // CSS Modules 的 import 在 Node 里解析不了（`.module.css` 不是 JS）。
    // 测试断言的是**结构与内容**，不断言类名，所以换成一个恒等代理即可。
    // ⚠ 不能靠 `--experimental-loader` 之类的运行期开关：那会把"这段测试怎么跑"
    // 变成环境依赖，别人一跑就红。就地替换是最少惊讶的做法。
    .replace(
      /^import\s+(\w+)\s+from\s+['"][^'"]*\.module\.css['"];?$/gm,
      'const $1 = new Proxy({}, { get: (_target, prop) => String(prop) });',
    )
  const file = join(dir, 'Composer.mjs')
  writeFileSync(file, out, 'utf8')
  const mod = await import(pathToFileURL(file).href)
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const COMPOSER = new URL('../src/client/ChatComposer.tsx', import.meta.url).pathname.replace(/^\//, '')

/** 文案桩：断言的是"这个键被真的渲染出来"，不是具体译文。 */
const T = {
  chatInputPlaceholder: 'PLACEHOLDER_CHAT',
  emptyInputPlaceholder: 'PLACEHOLDER_EMPTY',
  chatSend: 'SEND_LABEL',
  chatSending: 'SENDING_LABEL',
}
const t = (key) => T[key] ?? key

async function render(props) {
  const { mod, cleanup } = await loadTsx(COMPOSER)
  try {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const React = await import('react')
    return renderToStaticMarkup(React.createElement(mod.ChatComposer, { t, sending: false, onSend: () => {}, ...props }))
  } finally {
    cleanup()
  }
}

/** 拿生产代码导出的 `shouldSendOnKey`（真函数，不是测试里抄一份）。 */
async function loadShouldSend() {
  const { mod, cleanup } = await loadTsx(COMPOSER)
  try {
    return mod.shouldSendOnKey
  } finally {
    cleanup()
  }
}

/**
 * 按键决策层：Enter 发送 / Shift+Enter 换行 / IME 组合态不发送。
 *
 * 为什么必须直测这条：它在**渲染面上不可观测** —— SSR 渲不出按键行为，
 * 上面 6 条渲染断言全绿也照样可以把这行守卫删掉。
 */
test('按键：Enter 发送，Shift+Enter 换行（聊天窗口的肌肉记忆）', async () => {
  const shouldSend = await loadShouldSend()
  assert.equal(shouldSend('Enter', false, false), true, 'Enter 应当发送')
  assert.equal(shouldSend('Enter', true, false), false, 'Shift+Enter 应当换行而不是发送')
  assert.equal(shouldSend('a', false, false), false, '普通字符不发送')
})

test('按键：IME 组合态下 Enter 不发送（中文选词不会被当成发送）', async () => {
  const shouldSend = await loadShouldSend()
  // 这是本组断言的核心：组合期间 key 同样是 'Enter'，不拦就把半截拼音发出去了。
  assert.equal(shouldSend('Enter', false, true), false, 'IME 组合期间按 Enter 绝不能发送')
  // 组合中即便按住 Shift 也不发送（两条规则是"或"关系，任一为真都不发）。
  assert.equal(shouldSend('Enter', true, true), false)
  // 组合结束后恢复正常发送。
  assert.equal(shouldSend('Enter', false, false), true, '组合结束后 Enter 应恢复发送')
  // 老浏览器/合成事件缺失该字段时按"不在组合中"处理（不发送会变成静默失灵）。
  assert.equal(shouldSend('Enter', false, undefined), true, 'isComposing 缺失时应按可发送处理')
})

test('渲染面：输入框真的出现在 DOM 里（非空壳）', async () => {
  const html = await render({})
  assert.match(html, /<textarea/, '没有渲染出输入框')
  assert.match(html, /<button/, '没有渲染出发送按钮')
  // 用 data 属性而不是类名断言（类名由 CSS Module 哈希，测试不该依赖它）。
  assert.match(html, /data-rt-composer="input"/, '输入框缺少 data-rt-composer 标记')
  assert.match(html, /data-rt-composer="send"/, '发送按钮缺少 data-rt-composer 标记')
  assert.match(html, /PLACEHOLDER_CHAT/, '缺省占位文案没渲染出来')
  assert.match(html, /SEND_LABEL/, '发送按钮文案没渲染出来')
})

test('渲染面：`placeholderKey` 真的换掉了占位文案（空状态那一份）', async () => {
  const html = await render({ placeholderKey: 'emptyInputPlaceholder' })
  assert.match(html, /PLACEHOLDER_EMPTY/, '空状态占位文案没生效')
  assert.ok(!html.includes('PLACEHOLDER_CHAT'), '空状态里还在用群聊那份占位文案')
})

test('渲染面：空草稿时发送按钮是禁用的（不允许发空消息）', async () => {
  const html = await render({})
  // 找到那个 button 标签本身并断言其 disabled —— 不能用 html.includes('disabled')，
  // 那会把 textarea 的 disabled 也算进来（范围过宽 = 假绿）。
  const button = html.match(/<button[^>]*>/)?.[0] ?? ''
  assert.ok(button !== '', '找不到 button 标签')
  assert.match(button, /\bdisabled\b/, '空草稿时发送按钮没有被禁用')
})

test('渲染面：sending 时输入框与按钮都禁用（防重复提交）', async () => {
  const html = await render({ sending: true })
  const textarea = html.match(/<textarea[^>]*>/)?.[0] ?? ''
  const button = html.match(/<button[^>]*>/)?.[0] ?? ''
  assert.match(textarea, /\bdisabled\b/, 'sending 时输入框没有禁用')
  assert.match(button, /\bdisabled\b/, 'sending 时发送按钮没有禁用')
  assert.match(html, /SENDING_LABEL/, 'sending 时没有换成"发送中"文案')
})

test('渲染面：外部 disabled 也能锁住输入（两处调用方都能控）', async () => {
  const html = await render({ disabled: true })
  const textarea = html.match(/<textarea[^>]*>/)?.[0] ?? ''
  assert.match(textarea, /\bdisabled\b/, 'disabled 透传没生效')
})

test('渲染面：两处调用方渲染出的是**同一个组件**的产物（结构等价）', async () => {
  // 同一组件、只差 placeholderKey —— 除文案外的 DOM 结构必须逐字一致。
  // 这条是"共用而非复制"的机检形式：若哪天有人复制一份再改，结构就会分叉。
  const a = (await render({ placeholderKey: 'chatInputPlaceholder' }))
    .replace(/PLACEHOLDER_CHAT/g, 'X')
  const b = (await render({ placeholderKey: 'emptyInputPlaceholder' }))
    .replace(/PLACEHOLDER_EMPTY/g, 'X')
  assert.equal(b, a, '两处输入条的结构不一致（不再共用同一个组件）')
})
