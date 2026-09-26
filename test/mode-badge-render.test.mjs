/**
 * 讨论模式徽章的**渲染面**测试：把生产代码里的 `ModeBadge` 真渲染成 HTML 再断言 DOM。
 *
 * 为什么需要（v0.2.50 的核心约束）：上一版的问题不是"代码里没写徽章"，而是
 * **用户看不见状态** —— 空状态那一屏没有徽章，而打开 tab 本身就开了讨论模式，
 * 那一屏的输入框还会额外置上"切走也不关"的那一份。源码字符串断言只能证明
 * "写了 `<ModeBadge `",证明不了它真的渲得出内容；而 `state === null` 时它
 * 应当**什么都不画**，这一点在字符串层几乎无法可信地断言（分支可以写得很像）。
 *
 * 复用 `chat-composer-render.test.mjs` 的转译通道（TypeScript 自带 JSX 转换 +
 * 本仓 react/react-dom），产物写在 `test/.render-tmp/`（被 .gitignore 忽略）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
// 共享父目录的归属与清理口径同 chat-composer 一份（见 test/render-tmp-sandbox.mjs）。
import { makeRenderTmpDir } from './render-tmp-sandbox.mjs'

/** 转译一个 TSX 文件；`import type` 行删掉（Node 解析不到 `.ts` 后缀）。 */
async function loadTsx(absPath) {
  const { dir, cleanup } = makeRenderTmpDir('badge')
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
    // 断言的是**结构与内容**，不断言类名，所以换成一个恒等代理即可。
    .replace(
      /^import\s+(\w+)\s+from\s+['"][^'"]*\.module\.css['"];?$/gm,
      'const $1 = new Proxy({}, { get: (_target, prop) => String(prop) });',
    )
  const file = join(dir, 'Badge.mjs')
  writeFileSync(file, out, 'utf8')
  const mod = await import(pathToFileURL(file).href)
  return { mod, cleanup }
}

const BADGE = new URL('../src/client/ModeBadge.tsx', import.meta.url).pathname.replace(/^\//, '')

/** 文案桩：断言的是"这个键被真的渲染出来"，不是具体译文。 */
const T = {
  modeOn: 'LABEL_ON',
  modeOff: 'LABEL_OFF',
  modeOnHint: 'HINT_ON',
  modeOffHint: 'HINT_OFF',
  modePersistent: 'LABEL_PERSISTENT',
}
const t = (key) => T[key] ?? key

async function render(state) {
  const { mod, cleanup } = await loadTsx(BADGE)
  try {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const React = await import('react')
    return renderToStaticMarkup(React.createElement(mod.ModeBadge, { state, t }))
  } finally {
    cleanup()
  }
}

test('渲染面：开启时渲染出「开」文案与 on 标记（用户看得见状态）', async () => {
  const html = await render({ active: true, manual: false })
  assert.match(html, /LABEL_ON/, '开启状态没有渲染出「开」文案')
  assert.ok(!html.includes('LABEL_OFF'), '开启状态里混进了「关」文案')
  // data 属性而不是类名（类名由 CSS Module 哈希，测试不该依赖它）。
  assert.match(html, /data-rt-mode="on"/, '缺少 data-rt-mode=on 标记')
  assert.match(html, /HINT_ON/, 'title 提示没渲染出来')
})

test('渲染面：关闭时渲染出「关」文案与 off 标记', async () => {
  const html = await render({ active: false, manual: false })
  assert.match(html, /LABEL_OFF/, '关闭状态没有渲染出「关」文案')
  assert.ok(!html.includes('LABEL_ON'), '关闭状态里混进了「开」文案')
  assert.match(html, /data-rt-mode="off"/, '缺少 data-rt-mode=off 标记')
})

test('渲染面：真值未到时什么都不画（不画假状态）', async () => {
  // 这是本组断言的核心：先画一个"关"再跳成"开"，用户会看到一次不存在的状态变化。
  const html = await render(null)
  assert.equal(html, '', `state===null 时应当不渲染任何内容，实际渲染了：${html}`)
})

test('渲染面：`manual` 那一份带「切走仍开启」子标签，tab 那一份不带', async () => {
  // 两条写入源（/roundtable 命令、空状态输入框）都置 manual，而它**不随切走关闭** ——
  // 这正是用户需要知道的后果，也是旧文案「命令开启」成为假标签的地方。
  const persistent = await render({ active: true, manual: true })
  assert.match(persistent, /LABEL_PERSISTENT/, 'manual 的那一份没有标出"切走仍开启"')
  const tabOnly = await render({ active: true, manual: false })
  assert.ok(!tabOnly.includes('LABEL_PERSISTENT'), 'tab 那一份不该带"切走仍开启"（它切走就关）')
})
