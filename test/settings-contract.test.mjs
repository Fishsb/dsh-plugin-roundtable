/**
 * 偏好契约守卫（2026-09-23 · ACT-373 迁移的独立审查缺陷 ①）。
 *
 * ── 判因 ──────────────────────────────────────────────────────────────────
 * 0.1.7 迁移把用户偏好从「独立 settings namespace」搬进插件自己的 `Config`
 * （字段标 `.volatile()`）。这带来一条**新的隐性契约**：
 *
 *   `RoundTablePreferences`（浏览器/工具消费的线形态，rpc.ts）
 *        ⇄  11 个 volatile Config 字段（index.ts）
 *
 * 两者必须**逐字同名**。理由不是洁癖，而是上游的实现细节：
 * `SettingsForms.write()` 会对 patch 的每个键做 `isVolatilePath` 校验，
 * 非 volatile 的键**直接抛错**。所以一旦某个字段只在一侧存在：
 *   · 只在线形态 → 设置页读得到、一写就被 schema 拒（用户看到保存失败）；
 *   · 只在 Config → 无人消费，静默的死配置。
 *
 * 而编译期**看不到**这件事：`Config` 的 schema 由 `z.object({...})` 推断，
 * 与手写的 `Config` 接口之间靠一句 `as unknown as z<Config>` 桥接
 * （schemastery 泛型不变性所致，见 index.ts 注释）——该 cast 会一并关掉
 * 「接口字段 ↔ schema 字段」的一致性检查。故这里用**源文本真字段**补回
 * 可见性：不硬编码清单，改一处名字两侧都要跟。
 *
 * ⚠ 刻意不做的事：不 import `src/index.ts`。本仓的测试环境依赖可能停在
 *   0.1.5（`.volatile()` 在那代不存在，import 即崩），且该 import 会把
 *   一次纯文本契约检查变成环境依赖。这里只读源码文本 —— 判据是**字段集合**，
 *   不是"某处出现过某个字符串"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(HERE, '..', 'src', rel), 'utf8')

/**
 * 剥掉行注释与块注释，**按字符扫描**而非正则替换。
 *
 * ── 为什么不能再用正则（两轮独立审查各实证一次）────────────────────────────
 * 早先版本是两条正则：先剥块注释，再剥行首行注释。两种坏法都被实测复现：
 *
 * ① **行尾 `//` 未剥**（第二轮审查 P1，M6d/M6a）：那条只匹配**行首**注释，
 *    行尾注释原样存活。于是把字段整行删掉、把原模式挂到上一行行尾
 *    （`maxTokens: …volatile(), // maxRounds: …volatile(),`）即可让守卫**报绿**，
 *    而运行时 `config.maxRounds` 已是 undefined —— 假绿 1/2 完整复活。
 * ② **块注释优先会吞活代码**（P2/P3）：先剥块注释，那么行注释里一个孤立的
 *    块注释起始符（如 `// 见 /* 标记`）会一路吞到下一个块注释结束符，把中间的
 *    活字段全吃掉；且正则不认字符串，`'http://x'` 这类真实写法（本仓
 *    src/index.ts 就有）一旦出现在解析区，`//` 之后会被当作注释截断。
 *
 * ⇒ 判据看的是**活代码**，所以这里按词法走一遍：字符串/模板串内原样保留，
 *    两种注释都丢弃（含行尾），与源码语义一致。
 */
function stripComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    // 字符串与模板串：整段原样保留（其中的 // 和 /* 都不是注释）。
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      out += ch
      i++
      while (i < text.length) {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] ?? ''); i += 2; continue }
        out += text[i]
        if (text[i] === quote) { i++; break }
        i++
      }
      continue
    }
    // 块注释（位置无关，行尾 `code /* c */` 也正确剥）。
    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      // 用空格占位：避免把两边的 token 粘成一个（如 `a/*c*/b` → `ab`）。
      out += ' '
      continue
    }
    // 行注释：**行首与行尾一视同仁**，剥到本行结束。
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    out += ch
    i++
  }
  return out
}

/**
 * 按**顶层逗号**切分一个 `{...}` 体（括号平衡），返回每段的原始文本。
 * 不走正则硬切：`rolePresets` 的值里嵌了 6 层括号，正则会在内层逗号上断错。
 */
function splitTopLevel(body) {
  const parts = []
  let depth = 0
  let current = ''
  let inString = null
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (inString !== null) {
      current += ch
      if (ch === '\\') { current += body[i + 1] ?? ''; i++; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; current += ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += ch
  }
  if (current.trim() !== '') parts.push(current)
  return parts
}

/** 取出 `marker` 之后第一对平衡 `{...}` 的**体内文本**。 */
function blockAfter(text, marker) {
  const at = text.indexOf(marker)
  assert.ok(at >= 0, `源码里找不到锚点：${marker}`)
  const open = text.indexOf('{', at)
  assert.ok(open >= 0, `锚点 ${marker} 之后没有 {`)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(open + 1, i) }
  }
  throw new Error(`锚点 ${marker} 的花括号不平衡`)
}

/**
 * 从 Config 的 z.object 体里取出**标了 `.volatile()`** 的顶层字段名。
 *
 * ⚠ 必须先剥注释再解析（2026-09-23 独立复审实证的假绿）：
 * 早先版本直接对原文做 `part.includes('.volatile()')`，于是**把整行字段注释掉
 * 仍然算字段** —— 运行时 `config.maxRounds` 已 undefined（`.get()` 必崩），
 * 而本守卫报绿、0.1.7 的 tsc 也报绿，正属本仓在剿的"绿得没有意义"。
 * 反向同样成立：注释里随手写一句 `z.boolean().volatile(),` 会造成假红。
 */
function volatileConfigFields(indexSource) {
  const body = stripComments(blockAfter(indexSource, 'export const Config: z<Config> = z.object('))
  return splitTopLevel(body)
    /*
     * ⚠ 判据必须锚定**调用形态**，不能是子串 `includes('.volatile()')`
     * （第三轮独立审查实证的既有假绿）：句子 `.describe('.volatile()')`
     * 的子串同样含 `.volatile()`，于是把真 volatile 换成 describe 后，
     * 守卫仍数出 11 个字段（真 AST 是 10 个）—— 运行时会崩、守卫报绿。
     * 这里要求 `.volatile()` 作为**整段的结尾调用**出现（允许尾随空白）。
     */
    .filter((part) => /\.volatile\(\)\s*$/.test(part.trim()))
    .map((part) => {
      const m = part.match(/([A-Za-z_$][\w$]*)\s*:/)
      assert.ok(m, `无法从字段段里取出键名：${part.slice(0, 60).trim()}…`)
      return m[1]
    })
    .sort()
}

/** 从 `RoundTablePreferences` 接口体里取出全部字段名。 */
function preferenceInterfaceFields(rpcSource) {
  const body = stripComments(blockAfter(rpcSource, 'export interface RoundTablePreferences {'))
  return body
    .split('\n')
    .map((line) => line.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?:]/))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((name) => name !== 'readonly')
    .sort()
}

test('线形态字段集合 == Config 的 volatile 字段集合（防"只在一侧存在"的静默失效）', () => {
  const configFields = volatileConfigFields(read('index.ts'))
  const preferenceFields = preferenceInterfaceFields(read('rpc.ts'))

  assert.ok(configFields.length >= 11, `只解析到 ${configFields.length} 个 volatile 字段 —— 解析器或源码结构变了，先修解析再谈结论`)
  assert.deepEqual(
    configFields,
    preferenceFields,
    `Config 的 volatile 字段与 RoundTablePreferences 不一致：\n`
    + `  只在 Config：${configFields.filter((f) => !preferenceFields.includes(f)).join(', ') || '（无）'}\n`
    + `  只在线形态：${preferenceFields.filter((f) => !configFields.includes(f)).join(', ') || '（无）'}\n`
    + '只在 Config = 死配置；只在线形态 = 设置页写不进去（上游 write() 会拒绝非 volatile 键）。',
  )
})

test('偏好字段全部标了 .volatile()（防漏标 ⇒ 设置页读得到、写不进）', () => {
  const configFields = volatileConfigFields(read('index.ts'))
  const body = blockAfter(read('index.ts'), 'export const Config: z<Config> = z.object(')
  const allConfigFields = splitTopLevel(body)
    .map((part) => part.match(/([A-Za-z_$][\w$]*)\s*:/))
    .filter(Boolean)
    .map((m) => m[1])
  // 非偏好字段（普通 Config）必须与偏好字段**不重叠**，否则说明某个字段两头都想要。
  const ordinary = allConfigFields.filter((f) => !configFields.includes(f))
  for (const field of ordinary) {
    assert.ok(
      ['stateDir', 'memberProvider', 'maxNodes', 'memberMaxDepth', 'promptSectionOrder'].includes(field),
      `字段 "${field}" 既不是已知的普通 Config 字段，也没有标 .volatile() —— 新增偏好时必须标 .volatile()，否则设置页写不进去。`,
    )
  }
})

test('每个偏好字段都能从快照读面取到（防 Config 有、prefs.get() 漏）', () => {
  const configFields = volatileConfigFields(read('index.ts'))
  const index = read('index.ts')
  const getter = blockAfter(index, 'const prefs: PreferenceStore = {')
  const getterBody = stripComments(
    getter.includes('get: () => (') ? blockAfter(getter, 'get: () => (') : getter,
  )
  for (const field of configFields) {
    /*
     * ⚠ 判据必须落到**值来自同名字段**，不是"这行里出现过这个字段名"。
     * 本轮独立复审实证：只查存在性时，下面三种坏法**全部报绿**（且 0.1.7 tsc 也绿）：
     *   · 把 `maxRounds: config.maxRounds.get(),` 整行注释掉；
     *   · 值写死 `maxRounds: 999,`；
     *   · 错接引用 `maxRounds: config.maxTokens.get(),`（类型兼容的静默读错值）。
     * 所以这里要求同一行里既有 `field:` 又有 `config.field`/同名字段引用。
     */
    const line = getterBody.split('\n').find((l) => new RegExp(`\\b${field}\\s*:`).test(l)) ?? ''
    assert.notEqual(line, '', `prefs.get() 没有取 "${field}" —— Config 里有、读面漏了，设置页改了它消费者看不到。`)
    assert.ok(
      new RegExp(`config\\.${field}\\b`).test(line),
      `prefs.get() 的 "${field}" 没有从同名 Config 引用取值（当前行：${line.trim()}）`
      + ` —— 写死常量或错接到别的引用都会让设置页改了不生效，且类型检查看不见。`,
    )
  }
})
