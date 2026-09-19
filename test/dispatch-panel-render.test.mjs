/**
 * R-D-UI **渲染面**测试：把**生产代码**里的 `DispatchPanel` 真渲染成 HTML 再断言 DOM。
 *
 * 为什么需要（专家席在 R-D-UI 实测中点出的证据缺口）：
 * `dispatch-ui.test.mjs` 是**源码字符串**断言，只能证明"代码里写了渲染"——
 * 声明消费者 ≠ 渲染生效。verify 席明确拒绝把"接口返回正确字段"当成"UI 达成"。
 * 本文件补上这一段：真组件 → react-dom/server → 真 DOM → 真断言。
 *
 * ⚠ 只渲染 `DispatchPanel`（一个纯展示组件，无 hooks、无 IO），**不是**整个
 * `RoundTableView` 的挂载验证。这条边界写在这里，免得把局部渲染当端到端达成；
 * 视图级挂载由源码守卫 + 人工在 GUI 里确认共同覆盖。
 *
 * 依赖：TypeScript 自带 JSX 转换（仓库无 esbuild）+ 本地 react/react-dom（devDeps）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

/**
 * 把 TSX 源码转成可 import 的 ESM。
 *
 * ⚠ 转译产物必须写在**仓库内**（`test/.render-tmp/`），不能写系统临时目录：
 * Node 从该文件所在目录向上找 `node_modules`，写进 `%TEMP%` 就找不到本仓的
 * react —— 实测会以 "Cannot find package 'react'" 全红（那是一次真实的踩坑，
 * 留在这里免得有人"顺手"改回临时目录）。
 *
 * ⚠⚠ 该目录**必须先建**：它被 `.gitignore` 忽略，全新克隆上并不存在，
 * 直接 `mkdtempSync` 会以 ENOENT 全红（实测过）。所以这里显式 `mkdirSync`
 * —— 否则就是"我本地绿、别人一跑就红"。
 */
const TMP_DIR = new URL('./.render-tmp/', import.meta.url).pathname.replace(/^\//, '')
mkdirSync(TMP_DIR, { recursive: true })

async function loadTsx(absPath) {
  const dir = mkdtempSync(join(TMP_DIR, 'run-'))
  // `import type ...` 在转译后仍会留在输出里，Node 解析不到 `.ts` 后缀，故先删掉
  // —— 本组件运行时不依赖任何被 import 的类型。
  const source = readFileSync(absPath, 'utf8').replace(/^import type .*$/gm, '')
  const out = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: absPath,
  }).outputText
  const file = join(dir, 'DispatchPanel.mjs')
  writeFileSync(file, out, 'utf8')
  const mod = await import(pathToFileURL(file).href)
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const PANEL = new URL('../src/client/DispatchPanel.tsx', import.meta.url).pathname.replace(/^\//, '')

/** 与 locales.ts 同名的文案键映射（测试只关心"键是否被真的渲染出来"）。 */
const T = {
  dispatch: '调度',
  dispatchNoPlan: 'NO_PLAN',
  dispatchUnparsable: 'UNPARSABLE',
  dispatchWave: '第 {n} 波',
  dispatchWaveParallel: '立刻并发下发',
  dispatchWaveWait: '等第 {n} 波完成',
  dispatchPlanNote: '本轮意图',
  dispatchGap: '需新拉席位',
  dispatchGapOnStage: '该预设已在场',
  dispatchUnplanned: '计划外派发',
  dispatchUndispatched: '计划点名但本轮未派发',
  dispatchOutOfScope: '越界转派',
  dispatchPoolTitle: '专家候选池',
  dispatchPoolHint: 'POOL_HINT',
  dispatchPoolNone: 'POOL_NONE',
  dispatchPoolOnStage: '在场',
}
const t = (key) => T[key] ?? key

/** 样式表代理：本测试断言结构与内容，不断言类名。 */
const STYLES = new Proxy({}, { get: (_target, prop) => String(prop) })

const baseProps = {
  presets: [
    { id: 'verify', name: '独立验证', role: 'r' },
    { id: 'arch', name: '架构主审', role: 'r' },
  ],
  className: 'panel',
  t,
  styles: STYLES,
}

async function render(overrides) {
  const { mod, cleanup } = await loadTsx(PANEL)
  try {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const React = await import('react')
    return renderToStaticMarkup(React.createElement(mod.DispatchPanel, { ...baseProps, ...overrides }))
  } finally {
    cleanup()
  }
}

const emptyPlan = {
  recorded: false, note: '', parsable: true, waves: [],
  undispatchedOwners: [], unplannedDispatches: [], gaps: [], outOfScope: [],
}

test('渲染面①：有计划时波次图与并行/串行标注必须真的出现在 DOM 里', async () => {
  const html = await render({
    onStageIds: new Set(['verify', 'arch']),
    plan: {
      ...emptyPlan,
      recorded: true,
      note: '本轮先验波次',
      waves: [
        { wave: 1, items: [{ id: 'u1', task: 't1', owner: 'verify' }, { id: 'u2', task: 't2', owner: 'new:arch' }] },
        { wave: 2, items: [{ id: 'u3', task: 't3', owner: 'verify' }] },
      ],
      gaps: [{ item: 'u2', presetId: 'arch', presetName: '架构主审', onStage: true }],
    },
  })
  assert.match(html, /data-rt-panel="dispatch"/, '面板根节点必须带 host 认的 id')
  assert.match(html, /第 1 波 · 立刻并发下发/, '第一波必须标"立刻并发"（并行证据）')
  assert.match(html, /第 2 波 · 等第 1 波完成/, '第二波必须标"等上一波"（串行证据）')
  assert.match(html, /u1<\/span><span[^>]*>→ verify/, '波次项必须画出承接席')
  assert.match(html, /本轮意图：本轮先验波次/, 'note 必须显示')
  assert.match(html, /需新拉席位/, '缺口段必须显示')
  assert.match(html, /该预设已在场/, '缺口已在场标记必须显示')
})

test('渲染面②：缺计划必须渲染出显式提示，且不得出现任何波次（留白=误读成"没事"）', async () => {
  const html = await render({ onStageIds: new Set(), plan: { ...emptyPlan } })
  assert.match(html, /NO_PLAN/, '缺计划必须显式提示')
  assert.equal(html.includes('第 1 波'), false, '不得画出任何波次')
})

test('渲染面③：计划不可解析时必须提示，且不得画空波次图（旧版本/手工改坏）', async () => {
  const html = await render({
    onStageIds: new Set(),
    plan: { ...emptyPlan, recorded: true, parsable: false },
  })
  assert.match(html, /UNPARSABLE/, '不可解析必须提示')
  assert.equal(html.includes('波'), false, '不可解析时不得画波次图')
})

test('渲染面④：对账两类偏差与越界转派必须进 DOM；在场标记只认 host 给的集合', async () => {
  const html = await render({
    // 只有 verify 在场；arch 不在场 ⇒ 不得给它打"在场"标记
    onStageIds: new Set(['verify']),
    plan: {
      ...emptyPlan,
      recorded: true,
      waves: [{ wave: 1, items: [{ id: 'u1', task: 't', owner: 'verify' }] }],
      undispatchedOwners: ['arch'],
      unplannedDispatches: ['verify'],
      outOfScope: [{ fromSeat: 'impl', item: '数据迁移 | 该换人', suggestedRole: '数据与迁移', round: 2 }],
    },
  })
  assert.match(html, /计划点名但本轮未派发：arch/, '漏派必须显示')
  assert.match(html, /计划外派发：verify/, '计划外派发必须显示')
  assert.match(html, /越界转派/)
  assert.match(html, /数据与迁移/)
  assert.match(html, /独立验证/, '候选池必须渲染')
  // 在场标记：用具体串判定，避免子串误匹配
  assert.match(html, /verify · 在场/, '在场预设必须打标记')
  assert.equal(html.includes('arch · 在场'), false, '不在场的预设不得被打标记')
})

test('渲染面⑤：预设清单为空时给可操作提示（而不是空面板）', async () => {
  const html = await render({ presets: [], onStageIds: new Set(), plan: { ...emptyPlan } })
  assert.match(html, /POOL_NONE/, '空清单必须给提示')
})
