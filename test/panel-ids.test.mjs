/**
 * 面板 id 一致性（批次 A ⑥）：**源码级断言**，不需要 DOM 运行时。
 *
 * 背景：面板 id 曾有**三处副本** —— host `ROUNDTABLE_PANELS`、client 的 id 清单、
 * 视图里 7 个 `data-rt-panel="<id>"` 字面量。任一处漂移都不会被任何测试发现
 * （`satisfies` 也抓不到，因为它是 map 回调里的多余字段）。
 *
 * 现行契约：id 的单源是 host（`rpc.ts` 的 `ROUNDTABLE_PANELS`，经 `prefs.get` 的
 * `panels` 字段下发给客户端）；客户端只保留 id → 文案键 的映射。本测试钉死三件事：
 *   1. 客户端的文案映射**不缺少** host 给的任何 id（缺了会渲染成死开关）；
 *   2. 视图里渲染出来的 `data-rt-panel` **都在** host 清单内（拼错即红）；
 *   3. 视图面板数 = host 清单里被渲染的数量（当前仍允许视图少于 host——
 *      例如 `review` 面板未渲染时数据仍在 host 清单里）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ROUNDTABLE_PANELS } from '../src/rpc.ts'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('客户端文案映射覆盖 host 的全部面板 id（缺一个就是死开关）', () => {
  const settings = read('../src/client/RoundTableSettings.tsx')
  const block = /const PANEL_LABELS[^{]*\{([\s\S]*?)\}/.exec(settings)?.[1] ?? ''
  const ids = [...block.matchAll(/^\s*([a-z]+)\s*:/gm)].map((m) => m[1])
  assert.ok(ids.length > 0, '应当解析出 PANEL_LABELS 的 id 列表')
  for (const id of ROUNDTABLE_PANELS) {
    assert.ok(ids.includes(id), `客户端映射缺少 host 面板 id：${id}`)
  }
})

test('视图渲染的 data-rt-panel 必须在 host 清单内（拼错即红）', () => {
  const view = read('../src/client/RoundTableView.tsx')
  const rendered = [...view.matchAll(/data-rt-panel="([a-z]+)"/g)].map((m) => m[1])
  assert.ok(rendered.length > 0, '应当解析出 data-rt-panel 属性')
  for (const id of rendered) {
    assert.ok(ROUNDTABLE_PANELS.includes(id), `视图里的面板 id 不在 host 清单内：${id}`)
  }
  assert.equal(new Set(rendered).size, rendered.length, '同一面板 id 不得渲染两次')
  // 不变量：host 清单里的每个面板都必须被渲染，且不多不少 ——
  // 否则要么留下"点了没事发生"的死开关，要么渲染出 host 不认的面板。
  assert.deepEqual([...rendered].sort(), [...ROUNDTABLE_PANELS].sort(),
    `视图渲染 ${rendered.length} 个面板，host 清单 ${ROUNDTABLE_PANELS.length} 个 —— 两者必须一一对应`)
})

test('host 清单自身：无重复、非空、与 host 与客户端集合交集非空', () => {
  assert.ok(ROUNDTABLE_PANELS.length > 0)
  assert.equal(new Set(ROUNDTABLE_PANELS).size, ROUNDTABLE_PANELS.length, 'host 面板 id 不得重复')
  const settings = read('../src/client/RoundTableSettings.tsx')
  const block = /const PANEL_LABELS[^{]*\{([\s\S]*?)\}/.exec(settings)?.[1] ?? ''
  const clientIds = [...block.matchAll(/^\s*([a-z]+)\s*:/gm)].map((m) => m[1])
  for (const id of clientIds) {
    assert.ok(ROUNDTABLE_PANELS.includes(id), `客户端多出的面板 id（host 不认）: ${id}`)
  }
})
