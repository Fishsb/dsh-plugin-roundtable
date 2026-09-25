/**
 * T3 判据：插件自注册的 web 路由必须要求**已鉴权的浏览器会话**。
 *
 * ══ 缺陷背景（圆桌会议「执行席与约束调整决策」实测）══════════════════════
 * 宿主 webServer 的 `GET /` 返回 **401**（它有 BrowserAuth），而本插件自注册的
 * `/plugins/dsh-plugin-roundtable/rpc` 不带任何凭据 `POST` 却返回 **200**
 * —— 同一进程、同一端口。后果不在"外部攻击者"（宿主只监听 127.0.0.1），而在
 * **在场的专家节点**：它持 pwsh，一条本机 HTTP 请求即可调 `user-actions.append`
 * 伪造「用户要求增删专家」，而主持人下一轮会照单执行。
 *
 * ══ 判据取向（为什么这样断言）════════════════════════════════════════════
 * 本判据**不测运行时**（真机 HTTP 探测属于 exec 轮），而测**接线完整性**：
 * 这类"防线写了却没接"的假绿在本仓反复出现过（见 notes「判据接线闭环」：
 * 计算/派发/消费三段齐才算接）。所以三条断言分别钉住：
 *   ① 鉴权函数存在且**复用宿主**（不自造令牌，避免与宿主判据分叉成两套真源）；
 *   ② **两个**自注册路由都接了闸（只接 RPC = 锁前门留窗户，快照含 transcript）；
 *   ③ 浏览器侧 fetch 带 `credentials`（否则同源 cookie 不发，UI 全线 401）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('T3 ①：存在统一鉴权闸，且复用宿主 BrowserAuth（connection.requestRejection）', () => {
  const index = read('../src/index.ts')
  assert.match(index, /function rejectUnauthenticated\(/, '必须存在统一的拒绝判定函数')
  assert.match(
    index,
    /requestRejection\(/,
    '必须复用宿主的 requestRejection —— 自造共享密钥会与宿主鉴权真源分叉成两套',
  )
  assert.match(
    index,
    /401|403/,
    '必须能返回非 2xx 的拒绝状态（否则"拒绝"只是名义）',
  )
})

test('T3 ②：**两个**自注册路由都接了闸（不得锁前门留窗户）', () => {
  const index = read('../src/index.ts')
  // RPC 路由
  const rpcAt = index.indexOf('path: RPC_ROUTE')
  assert.ok(rpcAt > 0, 'RPC 路由必须仍存在')
  const rpcBlock = index.slice(rpcAt, rpcAt + 4000)
  assert.match(rpcBlock, /rejectUnauthenticated\(/, 'RPC 路由必须过鉴权闸')
  // 快照路由：同一暴露类（插件自注册，不在宿主 401 闸门内），
  // 且快照含 transcript 与专家配置 —— 泄露面不比 RPC 小。
  const stateAt = index.indexOf("path: '/plugins/dsh-plugin-roundtable/state'")
  assert.ok(stateAt > 0, '快照路由必须仍存在')
  const stateBlock = index.slice(stateAt, stateAt + 2000)
  assert.match(stateBlock, /rejectUnauthenticated\(/, '快照路由必须同样过鉴权闸（同一暴露类）')
})

test('T3 ③：浏览器侧调用带 credentials（否则同源 cookie 不发 → UI 全线 401）', () => {
  const wire = read('../src/client/wire.ts')
  const rpcAt = wire.indexOf("fetch('/plugins/dsh-plugin-roundtable/rpc'")
  assert.ok(rpcAt > 0, 'RPC fetch 必须仍存在')
  assert.match(wire.slice(rpcAt, rpcAt + 400), /credentials:\s*'same-origin'/, 'RPC fetch 必须带 same-origin 凭据')
  const stateAt = wire.indexOf('/plugins/dsh-plugin-roundtable/state${query}')
  assert.ok(stateAt > 0, '快照 fetch 必须仍存在')
  assert.match(wire.slice(stateAt, stateAt + 400), /credentials:\s*'same-origin'/, '快照 fetch 必须带 same-origin 凭据')
})

test('T3 ④：鉴权失败方向是"拒"，不是"放行"（拿不准就拒）', () => {
  const index = read('../src/index.ts')
  const at = index.indexOf('function rejectUnauthenticated(')
  const body = index.slice(at, at + 1800)
  // connection 缺席时不得直接 return undefined 放行，必须落回回环判据
  assert.match(body, /isLoopbackAddress\(/, 'connection 缺席时必须落回回环兜底，绝不整段放行')
  assert.match(body, /catch\s*\{[\s\S]{0,200}return 401/, '鉴权实现抛错时必须拒绝（内部异常不得变成后门）')
})
