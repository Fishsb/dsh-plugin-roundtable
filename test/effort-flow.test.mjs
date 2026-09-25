/**
 * 思考强度（reasoning effort）全链判据（A1 / A2 / A12 + 接线旁证）。
 *
 * 背景：设置页每条预设新增「模型 · 思考强度」行内面板，档位要一路走到专家节点
 * （预设 → 净化层 → user-actions → add_node → agentOptions）。这条链上**任何一个
 * 中间层不认这个字段，全链就静默丢失**——接口仍返回成功，UI 仍显示"已保存"。
 * 所以本文件盯的不是"功能在不在"，而是"丢没丢、失败可不可分辨"：
 *
 *   A1  净化层成对断言：给了就逐字保留，没给就**不得凭空出现该键**；
 *   A2  词表来源唯一：`buildModelCatalog` 的档位逐元素等于宿主 resolveModelInfo
 *       的返回值（不自造词表、不本地枚举）；
 *   A12 「模型不提供推理」与「目录读取失败」不得同形：失败进 failures[]，
 *       且**单模型失败不得把整个 provider 清空**（旧写法 catch { models = [] }）。
 *
 * 另加两条接线旁证（源码级，不需要 DOM）：面板内的档位控件必须在测（A12 的
 * 消费面）且滚动调用必须是 `block:'nearest'`（M6：`block:'start'` 会滚动整页）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildModelCatalog, sanitizeRolePresets } from '../src/rpc.ts'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/* ---------------------------------------------------------------- *
 * A1：净化层透传（唯一净化点——此处不认该字段即全链静默丢）
 * ---------------------------------------------------------------- */

test('A1 净化层：带档位的条目逐字保留 reasoningEffort', () => {
  const [entry] = sanitizeRolePresets([
    { id: 'p1', name: '安全审查', role: '挑毛病', provider: 'dshapi', model: 'm', reasoningEffort: 'high' },
  ])
  assert.equal(entry.reasoningEffort, 'high')
})

test('A1 净化层：未给档位的条目**不得**出现该键（成对断言，防"凭空写键"）', () => {
  const [entry] = sanitizeRolePresets([
    { id: 'p1', name: '安全审查', role: '挑毛病', provider: 'dshapi', model: 'm' },
  ])
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'reasoningEffort'), false)
})

test('A1 净化层：空白档位视为继承（trim 后为空即不落键）', () => {
  const [entry] = sanitizeRolePresets([
    { id: 'p1', name: '安全审查', role: '挑毛病', reasoningEffort: '   ' },
  ])
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'reasoningEffort'), false)
})

test('A1 净化层：档位可**单独**给出（不需要 provider/model 成对）', () => {
  const [entry] = sanitizeRolePresets([
    { id: 'p1', name: '继承路由但指定档位', role: 'r', reasoningEffort: 'max' },
  ])
  assert.equal(entry.reasoningEffort, 'max')
  assert.equal(entry.provider, undefined)
  assert.equal(entry.model, undefined)
})

test('A1 净化层：档位超长被截断（与其余字段同一口径）', () => {
  const [entry] = sanitizeRolePresets([
    { id: 'p1', name: 'n', role: 'r', reasoningEffort: 'x'.repeat(200) },
  ])
  assert.equal(entry.reasoningEffort.length, 40)
})

test('A1 净化层：28 条预设往返不丢字段（含档位）', () => {
  const input = Array.from({ length: 28 }, (_, index) => ({
    id: `p${index}`,
    name: `预设 ${index}`,
    role: `角色 ${index}`,
    provider: 'dshapi',
    model: 'm',
    ...(index % 2 === 0 ? { reasoningEffort: 'high' } : {}),
  }))
  const out = sanitizeRolePresets(input)
  assert.equal(out.length, 28)
  assert.equal(out.filter((entry) => entry.reasoningEffort === 'high').length, 14)
  assert.equal(out.filter((entry) => Object.prototype.hasOwnProperty.call(entry, 'reasoningEffort')).length, 14)
})

/* ---------------------------------------------------------------- *
 * A2 / A12：模型目录（词表唯一来源 + 失败可分辨）
 * ---------------------------------------------------------------- */

/** 桩 llm：按 provider 名给不同行为（成功 / listModels 抛错 / 单模型抛错）。 */
function llmStub({ failingListModels = [], failingModel = '' } = {}) {
  return {
    listProviders: () => [
      { id: 'good', name: '好 provider' },
      { id: 'bad-list', name: '枚举失败 provider' },
      { id: 'bad-model', name: '单模型失败 provider' },
    ],
    listModels: async (provider) => {
      if (failingListModels.includes(provider)) throw new Error('no api key')
      if (provider === 'bad-model') {
        return failingModel === ''
          ? [{ id: 'ok-model', name: 'OK' }]
          : [{ id: 'ok-model', name: 'OK' }, { id: failingModel, name: 'BOOM' }]
      }
      return [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }]
    },
    resolveModelInfo: async (provider, model) => {
      if (provider === 'bad-model' && failingModel !== '' && model === failingModel) throw new Error('adapter exploded')
      if (model === 'm2') return { id: model, name: 'M2' } // 不提供推理 ⇒ reasoning 缺席
      return {
        id: model,
        name: model,
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High', description: '更用力' },
          ],
          defaultEffort: 'high',
        },
      }
    },
  }
}

test('A2 词表来源唯一：档位逐元素等于宿主 resolveModelInfo 的返回值', () => {
  return buildModelCatalog(llmStub()).then((catalog) => {
    const good = catalog.providers.find((provider) => provider.id === 'good')
    const m1 = good.models.find((model) => model.id === 'm1')
    const m2 = good.models.find((model) => model.id === 'm2')
    assert.deepEqual(m1.reasoning.efforts.map((effort) => effort.id), ['off', 'high'])
    assert.deepEqual(m1.reasoning.efforts.map((effort) => effort.name), ['Off', 'High'])
    assert.equal(m1.reasoning.defaultEffort, 'high')
    // 宿主声明"不提供推理" ⇒ reasoning **缺席**（不是空对象、不是空数组）
    assert.equal(m2.reasoning, undefined)
    assert.equal(Object.prototype.hasOwnProperty.call(m2, 'reasoning'), false)
    assert.deepEqual(catalog.failures, [])
  })
})

test('A12 provider 级枚举失败：记 failures，provider 条目仍在（不凭空少项）', async () => {
  const catalog = await buildModelCatalog(llmStub({ failingListModels: ['bad-list'] }))
  const bad = catalog.providers.find((provider) => provider.id === 'bad-list')
  assert.ok(bad !== undefined, '枚举失败的 provider 必须仍然出现在下拉里')
  assert.deepEqual(bad.models, [])
  assert.equal(catalog.failures.length, 1)
  assert.equal(catalog.failures[0].id, 'bad-list')
  assert.match(catalog.failures[0].message, /no api key/)
  // 成功的 provider 不受影响
  assert.equal(catalog.providers.find((provider) => provider.id === 'good').models.length, 2)
})

test('A12 单模型失败：只降级该模型，**不得**把同 provider 的其它模型清空', async () => {
  const catalog = await buildModelCatalog(llmStub({ failingModel: 'boom' }))
  const provider = catalog.providers.find((entry) => entry.id === 'bad-model')
  assert.deepEqual(provider.models.map((model) => model.id), ['ok-model', 'boom'])
  const boom = provider.models.find((model) => model.id === 'boom')
  assert.equal(Object.prototype.hasOwnProperty.call(boom, 'reasoning'), false)
  // 失败必须可分辨：进 failures 且带得出模型 id
  assert.equal(catalog.failures.length, 1)
  assert.match(catalog.failures[0].message, /boom/)
  assert.match(catalog.failures[0].message, /adapter exploded/)
})

test('A12 失败与"不支持推理"不同形：前者有 failures 记录，后者没有', async () => {
  const clean = await buildModelCatalog(llmStub())
  const dirty = await buildModelCatalog(llmStub({ failingModel: 'boom' }))
  assert.equal(clean.failures.length, 0, '正常目录不得有失败记录')
  assert.equal(dirty.failures.length, 1, '读取失败必须留痕')
})

test('A12 llm 服务未挂载：返回空目录 + 空失败（UI 显示"无模型"，不是崩溃）', async () => {
  const catalog = await buildModelCatalog(undefined)
  assert.deepEqual(catalog, { providers: [], failures: [] })
})

test('A12 宿主返回非法档位（空 id/重名）被丢弃而非透出', async () => {
  const llm = {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ id: 'm', name: 'M' }],
    resolveModelInfo: async () => ({
      id: 'm',
      name: 'M',
      reasoning: {
        efforts: [{ id: '', name: '空 id' }, { id: 'high', name: 'High' }, { id: 'high', name: '重名' }],
      },
    }),
  }
  const catalog = await buildModelCatalog(llm)
  assert.deepEqual(catalog.providers[0].models[0].reasoning.efforts.map((effort) => effort.id), ['high'])
})

test('A12 defaultEffort 不在词表内时被丢弃（宿主规范：必须落在 efforts[].id 里）', async () => {
  const llm = {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ id: 'm', name: 'M' }],
    resolveModelInfo: async () => ({
      id: 'm',
      name: 'M',
      reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'nope' },
    }),
  }
  const catalog = await buildModelCatalog(llm)
  assert.equal(catalog.providers[0].models[0].reasoning.defaultEffort, undefined)
})

/* ---------------------------------------------------------------- *
 * 接线旁证（源码级）：面板在测 + 滚动参数正确
 * ---------------------------------------------------------------- */

test('接线旁证：编辑表单渲染档位控件（disabled 由词表长度决定）', () => {
  const settings = read('../src/client/RoundTableSettings.tsx')
  assert.match(settings, /disabled=\{efforts\.length === 0\}/, '档位控件必须按词表可得性置灰')
  assert.match(settings, /settingsPresetEffortUnavailable/, '无档位时必须同屏给文案，不能静默消失')
})

test('接线旁证：模型与档位只有一个可写处（不得再有第二个"模型 · 思考强度"入口）', () => {
  const settings = read('../src/client/RoundTableSettings.tsx')
  // 双写口是历史上歧义的来源：模型/档位必须只在 PresetForm 这一张表单里。
  const providersSelects = settings.match(/value=\{draft\.provider\}/g) ?? []
  const effortSelects = settings.match(/value=\{draft\.reasoningEffort\}/g) ?? []
  assert.equal(providersSelects.length, 1, `provider 下拉应只渲染一处，实际 ${providersSelects.length}`)
  assert.equal(effortSelects.length, 1, `档位下拉应只渲染一处，实际 ${effortSelects.length}`)
  // 那条独立的第二行按钮（settingsPresetEffortBtn）已删除，不得回归
  assert.doesNotMatch(settings, /settingsPresetEffortBtn/, '不应再有独立的"模型 · 思考强度"按钮')
  assert.doesNotMatch(read('../src/client/locales.ts'), /settingsPresetEffortBtn/, '该文案键应已删除')
})

test('接线旁证：编辑表单行内挂载（独占整行），否则会被渲染成第四列', () => {
  const settings = read('../src/client/RoundTableSettings.tsx')
  assert.match(settings, /styles\.presetFormInline/, '行内编辑需带独占整行的类')
  const css = read('../src/client/RoundTableSettings.module.css')
  assert.match(css, /\.presetFormInline\s*\{[^}]*flex-basis:\s*100%/, '该类必须 flex-basis:100%')
  assert.match(css, /\.presetItem\s*\{[^}]*flex-wrap:\s*wrap/, '.presetItem 必须允许换行')
})

test('接线旁证：换 provider/model 时必须**同时清空**档位（否则留下 @high 假值）', () => {
  const settings = read('../src/client/RoundTableSettings.tsx')
  // provider 变更处与 model 变更处都要出现 reasoningEffort 的清空
  const clears = settings.match(/reasoningEffort: ''/g) ?? []
  assert.ok(clears.length >= 3, `换路由清空档位应出现 ≥3 处（表单 provider/model + 草稿初始化等），实际 ${clears.length}`)
  const manage = read('../src/client/RoundTableView.tsx')
  assert.match(manage, /provider, model: '', reasoningEffort: ''/, '专家管理面板换 provider 同样要清档位')
})

test('接线旁证：编辑表单打开后滚动用 block:nearest（start/center 会滚动整页）', () => {
  const settings = read('../src/client/RoundTableSettings.tsx')
  assert.match(settings, /scrollIntoView\(\{ block: 'nearest' \}\)/)
  assert.doesNotMatch(settings, /scrollIntoView\(\{[^}]*block: '(start|center)'/)
})

test('接线旁证：档位必须走结构化字段进 user-actions（不能只塞进 text）', () => {
  const manage = read('../src/client/RoundTableView.tsx')
  // 定位 submitAdd 的 append 调用（add-node），不是 applyPendingActions 的批量重放。
  // 锚点用**函数名**而不是那句中文文案：文案是可以被翻译/改写的（本轮把它
  // 换成了 t('actionAddNode') 以支持中英切换），而守卫真正要验的是「结构化
  // 档位字段有没有出现在 submitAdd 的 append 载荷里」。用文案当锚点会让任何
  // 一次文案改动都变成假红 —— 那是守卫在测自己，不是在测行为。
  const at = manage.indexOf('const submitAdd')
  assert.ok(at > 0, '锚点不存在：submitAdd 函数')
  // 用固定窗口而不是 `})` 切片：text 模板里的 `${...}` 本身就含 `}`，会提前截断。
  // 窗口从 700 放宽到 1600：锚点改成函数名后窗口起点提前了，而 submitAdd 里
  // 的校验分支本来就有几十行 —— 700 会把 append 调用切在窗口外（假红）。
  // 断言本身未变：仍要求窗口内同时看到 append 调用与结构化 reasoningEffort。
  const window = manage.slice(at, at + 1600)
  assert.match(window, /'roundtable\/user-actions\.append'/, '窗口内必须能看到 append 调用')
  assert.match(window, /reasoningEffort,/, 'add-node 的 payload 必须带结构化 reasoningEffort 字段')
})
