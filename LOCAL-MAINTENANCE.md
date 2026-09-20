# 本地自维护说明（RoundTable 插件）

> **本目录 `D:\lk\FF\dsh-plugin-roundtable` 是本机唯一真相。**
> 上游 `9931666/dsh-plugin-roundtable` 仅作基线，不回合并也不依赖其更新。
> 远端自维护仓：`https://github.com/Fishsb/dsh-plugin-roundtable`（2026-09-20 在作者账号下新建，
> 与上游**无 fork 关系**，`origin/master` 即本目录 master）。
> 2026-09-17 从 `D:\lk\deepseek\plugins\dsh-plugin-roundtable-main` 迁入工作区。

## 零、目录与部署关系（先读这一节）

```
D:\lk\FF\dsh-plugin-roundtable                    ← 唯一真相（改这里）
        ↑ junction
C:\Users\lk\.dsh\profiles\web\node_modules\dsh-plugin-roundtable
        ↑ 由 profiles/web/package.json 声明
"dsh-plugin-roundtable": "file:D:/lk/FF/dsh-plugin-roundtable"
```

宿主的 loader entry 落在 `profiles/web/node_modules/dsh-plugin-roundtable/lib/index.js`，
而该目录是**指向本项目的 junction**。因此：

- **改本项目 `src/` → 重建 → 热重载**，即完成一次插件修改，**不存在第二份副本需要手工同步**。
- 旧的「源目录 vs 部署副本漂移」问题从此结构性消失（那是两份实体副本造成的）。
- 若哪天 junction 被 `pnpm install` 换成实体目录，按 `pnpm install` 会用 `file:` 指向重新装一次，
  内容仍来自本项目，**不会丢改动**；只是会退化成实体副本，需要留意后续两边不同步。

## 一、本机相对上游多了什么

上游 HEAD = `6078a5b1`（v0.2.35，2026-09-13）。本机在其之上有两处修复，均已跑通并实证：

### 1. 预设装配链（R-A）—— 新增

**问题**：v0.2.35 的 `rolePresets` 只被浏览器表单消费（`RoundTableView` 选中即填充 role/provider/model 后写 `user-actions.jsonl`）。agent 侧 `tools.ts` 全文无 `rolePresets` 引用，`plan_meeting` 与 `add_node` 都不接受预设引用。

**后果**：主持人自己建节点时（最常见路径）拿不到用户写的预设，只能临场编 role；且「预设库 → 会议节点」这条边在程序里**根本不存在**，任何机检都验不到它。

**改法**：
- 新增只读工具 `roundtable_list_presets`（返回 id/name/role/provider/model，支持子串过滤）
- `roundtable_add_node` 增加可选 `preset` 字段（填未显式给出的字段，显式参数优先；解析失败**报错**而非静默降级）
- `roundtable_plan_meeting.experts[]` 同样支持 `preset`，卡片显示**解析后**的 role 与来源
- `ToolsConfig.getRolePresets` 实时读取（与 `getExpertLimits` 同模式）
- usage 协议第 3 条要求主持人先调 `roundtable_list_presets`

### 2. 工具白名单按宿主注册表过滤

**问题**：`ToolRuntime.restrict()` 对宿主未注册的工具名会直接抛错，而 `NODE_ALLOWED_TOOLS` 是宿主无关的愿望清单（含 `bash` / `str_replace_editor` / `list_subagent_models`，本机实名是 `pwsh` / `edit` / `list_agents`）。

**后果**：`skill_delivery=direct` 时节点 spawn 必然失败，且报错指向本机不存在的工具名。

**改法**：`nodeToolRestriction(skillDelivery, isRegistered?)` 过滤 allow/deny，`spawnNode` 传入 `ctx.tools.get(name, captain) !== undefined`。查询以主持人视角进行是刻意的——`deny` 里的主持人专属工具在主持人视角下存在，必须保留才能真正挡住节点。

### 3. 主持人单一出口（R-B）—— 新增（v0.2.36）

**问题**：宿主 `dsh-subagent` 给每个 continuable 子代理的任务尾部硬编码追加"finish 前用 `send_message` 回传 parent"指引（`continuation-messages.withContinuableReturnGuidance`）。后果：专家正文逐条刷进主会话、主持人汇总形同虚设、决策卡片被后续专家输出顶掉、专家选定的方向在最终汇总里丢失。

**改法（三道闸 + 收料闭环）**：
- `NODE_DENIED_TOOLS` += 宿主 `send_message`（direct 白名单同步移除）——正文回传物理封死，产出只剩 `roundtable_speak`；
- persona 反指引：说破宿主回传要求，防止撞 deny 后重试；
- 发言格式：`[核心产出]` 自包含 + 单列 `[建议决策]` 行；aggregator 提取进 digest；
- usage 协议第 14 条：settlement 唤醒 = 收料时机（只 summarize 不播报）；全节点 idle 后一次汇总；决策前全 idle 检查；close 前必须已交付最终汇总。
- 信息不丢的机制：宿主结算通知仍会唤醒主持人（idle→queue / 忙→steer），transcript 是权威账本，每次结算强制过账。

**顺带修复**：①轮数预算从未生效（`beginRound` 是死代码，`meeting.round` 恒 0）→ 新增 captain-only 工具 `roundtable_next_round`，协议要求每轮派发前调用；②redteam 会议 persona 误标"主持人统筹"→ modeRule 三分支。

**已知边界**：宿主单行 settlement notice（无正文）仍在主会话，插件不可控。旧会议节点按旧 persona 运行到重建，新建会议即全覆盖。

### 4. 成员感知同步（R-C）—— 新增（v0.2.36）

**问题**：persona/总纲的名册是 spawn 时刻的编译快照，中途 add/remove 专家后在跑的节点和主持人都拿着过期名册。

**架构（两层模型）**：meeting.json 是名册唯一权威（持久层，锁保护）；persona/总纲只是快照（上下文层，不可更新）。不变量：拉取为主（`roundtable_status` nodes[] = 唯一权威名册），推送为辅（广播补偿快照），推送走 captain→node 会议内通道（不破坏 R-B 单一出口）。

- W1 `charter.ts`：名册表下加"编译时刻快照，当前以 roundtable_status nodes[] 为准"声明；
- W2 `members.ts`：modeRule 三分支统一带 rosterHint；`nodeWelcome` 按模式分叉（平等=可直达+先查册；红队=只报主持人；统筹=等派单），收尾统一查册句；
- W3 `index.ts`：usage 规则 5 每轮开头一次 status 查册（与规则 9 pending_actions 合并为一次调用）；规则 3/9 名册变更（含 UI 操作落地后）派新任务前必须 `to="all"` 广播；
- W4 `tools.ts`：`roundtable_send_message` 支持 `to="all"`（导出纯函数 `broadcastRecipients`：已出生、未 removed、排除发起者，节点发起时主持人恒在列）；锁内逐受众记转录、锁后扇出，返回 `key:wake|live|dropped` 逗号串；空受众抛错；非 egalitarian 节点发 all 仍被"只报主持人"闸门拦下。

### 5. 调度面（R-D）—— 新增（v0.2.42）

**问题**（用户实测反馈）：主持人模式只有**执行面**（自由文本 `roundtable_send_message`），
没有**候选面**与**计划面**。后果：轮 0 定名册后后续轮次只有这批人；任务一把抓全下发，
"哪些能并行、哪些必须串"在程序里不可表达也不落账（静默判据只测"派了没回"）。

**改法**：三件，零新增工具名 —— ① `roundtable_status` 增 `talent_pool`（专家库进每轮信息面）；
② `roundtable_next_round` 收 `plan[{id,task,owner,depends_on}]`（空依赖=同波并行，非空=1+max 波次；
环/悬挂/未知席/空计划一律拒绝；在场席 ≥2 时硬门必填；**先校验后推进**，非法计划不烧轮）；
③ `roundtable_status` 增 `round_signals`（计划 vs 实际对账 + `[越界转派]` 结构化提取）。
另修一处真隔离漏洞：status 的 `silence` 判据原本向节点泄露**全员席位名**（与 deny
`roundtable_summarize` 要防的假隔离同型）。

**落点**：`src/dispatch.ts`（新，纯函数）、`src/types.ts`（`presetId` / `RoundPlan` / `roundPlans` /
`MeetingUtterance.workItem`）、`src/tools.ts`、`src/index.ts`（usage 规则 3/5 + 新增 16）、
`test/dispatch.test.mjs`（新，52 例）、`test/silence.test.mjs`（守卫扩到含隔离裁剪）。

**运行态抓到的两条缺陷**（夹具未覆盖，已在 v0.2.42 内修掉并补反例）：
① 派单文案里引用 `[越界转派]` 被当成真实转派 ⇒ 判据收紧为**行首标记** + 排除主持人/网关发言；
② 同一席位多个工作项时只派一个而席位口径全绿 ⇒ `send_message` 增 `work_item`（只认本轮计划里
真有的 id）并把对账升级为**三态**（tracked / untracked / never dispatched），不把"不可核"说成"没做"。

### 6. 调度面板 + 自审遗留清理（R-D-UI）—— 新增（v0.2.43）

**问题（自审 + 专家席当场抓到三条真缺陷）**：

1. **同一会议两个答案**（最该先修的一档）：`snapshot.ts` 调 `buildRoundSignals` 时漏传
   `onStageByPreset` ⇒ 同一场会议里 `status` 说"没漏派"、快照说 `unplannedDispatches:["arch"]`。
   根因不是"忘了传"，而是该参数是 **optional** 且判定者输入**没有单一装配入口** —— 漏传在类型层不报错。
2. **跨轮假绿**：计划 id 只要求"本轮内唯一"（跨轮复用合法），但对账扫全部轮次 ⇒ 本轮从未派发的
   `a1` 被上一轮同名记录冒充成"已追踪"。
3. **圆桌制报错信号**：`[越界转派]` 是单线制专属协议，却在 egalitarian 下也被收集。

**改法**：`onStageByPreset` 改**必填** + 新增 `onStagePresetMap()` 唯一装配入口（漏传=编译错误）；
追踪记录只认本轮；`buildRoundSignals` 收 `mode` 并在圆桌制显式置空（用对拍断言钉住"单线制仍必须收集"）。
另把 `[越界转派]` 判据收紧为**行首标记** + 排除主持人/网关发言（实测：主持人在派单里引用该标记曾被
当成 2 条真实转派）。判据单源化：`isDispatchableSeat` / `dispatchableSeatKeys`（可派单席）、
`presetLinkedSeatIds`（预设关联席，**语义不同不合并**）。

**UI 批次**：host 快照新增 `plan`（波次/对账/缺口/越界转派）与 `talentPool`（**只下发本会议的
在场标记**，全局清单走 `prefs.get`，1Hz 轮询不重复搬运）；新增 `src/client/DispatchPanel.tsx`
（纯展示、无 hooks/IO）挂进拓扑页右栏；落账计划不可解析时显示提示并**拒绝画空波次图**。
面板抽模块的理由是**证据强度**：内联在 1900 行视图里只能做源码字符串断言。

**落点**：`src/client/DispatchPanel.tsx`（新）、`src/snapshot.ts`、`src/client/{wire,locales,RoundTableView,RoundTableSettings}.tsx|ts`、
`src/rpc.ts`、`src/dispatch.ts`、`src/index.ts`、`test/dispatch-ui.test.mjs`（新）、
`test/dispatch-panel-render.test.mjs`（新，**真渲染**生产组件的 DOM 断言）。

**已知边界（未做，见 release-notes §6）**：GUI 根路径受宿主进程级 launch-token 鉴权保护，无凭据
不可进；伪造 cookie 会绕过鉴权，故**不做**。渲染证据止于 SSR 真渲染 + 源码接线守卫，完整浏览器
挂载留待用户在有鉴权的会话里目视确认。

### 7. 模式相关口径实证（R-D 收尾）—— 新增（v0.2.44）

按目标①逐条清理时又抓到三条真遗留，都是"同一件事两个判据/两条真相"：

1. **圆桌制对账假阳性**：对账"实际派发"只认主持人，但 egalitarian 的设计就是**专家互相直达**
   （charter 第二节）。探针实测 `arch→impl` 被整条忽略 ⇒ `impl` 报成漏派，连发起者 `arch` 也一起被报。
   修法：派发者随模式分叉（单线制只认主持人；圆桌制下节点→席位直达计入，发起者不自计；
   `captain`/`aggregator` 恒不算派发）。运行态实测：真 egalitarian 会议里 `impl` 实发 `arch` 后，
   `undispatchedOwners` 由 `["impl"]` 变为**空**。
2. **`planned_owners` 算出来却没人看**：席位侧分母只在"有偏差时"渲染，读的人看不到比较基准。
   改为有计划就渲染；并加 `R-D-UI ⑧` 守卫（运行时 `Object.keys` 取字段，无消费者即红）。
3. **总纲与实现两条真相**：圆桌制段没说"不使用 `[越界转派]`"，而实现不收集它 ⇒ 专家照写、主持人收不到。
   补显式声明；并把 `persona.test.mjs` 的 A3 从"完全不含该标记"精确化为**按语境分**
   （不得教用 / 必须声明不用）—— 删掉声明句会让两条守卫同时红。

**硬门与模式的关系（显式化，非改动）**：用户口径"≥2 席必交计划"未按模式分叉，圆桌制同样适用；
理由（花钱 + 本轮意图）与断言（`requiresDispatchPlan.length === 2`）已写入代码注释与测试。

**落点**：`src/dispatch.ts`、`src/charter.ts`、`src/tools.ts`、`test/dispatch.test.mjs`（+4 → 62）、
`test/dispatch-ui.test.mjs`（+2 → 9）、`test/persona.test.mjs`（A3 精确化）。

### 8. 圆桌讨论模式（E 功能：两个入口，一个状态）—— 新增

**诉求（用户原话）**：① 在「圆桌会议」窗口内发消息默认就是圆桌讨论模式；② 插件自带一个
斜杠命令，用命令即开启该模式。

**做法**：会话级状态表 `src/mode.ts`，**一个有效值、两个来源标记**（这是全部要害）：

| 来源 | 谁写 | 何时写 |
|---|---|---|
| `auto` | 浏览器（`RoundTableView` 挂载/卸载的 effect） | 打开该 tab = 开，切走/关页 = 关 |
| `manual` | `/roundtable` 命令（host `commands` 注册） | 敲命令开/关 |

`active = auto \|\| manual`；**两者互不覆盖** —— tab 切走只撤 `auto`，命令开的模式仍生效。
`/roundtable off` 是唯一例外：它两份一起撤（否则用户敲了 off 而 tab 还开着，会看到"没变化"的假反馈）。

**模式的全部作用机制是一段条件化的 system prompt 段**（`roundtable:mode`，`order = 116 + 1`）：
按会话求值，开着时注入"本条消息按圆桌会议处理"，关闭返回空串。工具目录不变（请求缓存形状稳定，
与宿主 plan-mode 同一取舍）。尾部输入分类：裸调用=开、`off`/`关`=关、其余非空文本当**议题**
（开模式 + `agent.steer` 转交主持人，一次性启动会议）。

**边界（写清楚，别把机制当现状）**：状态是**进程内内存**，不落盘 —— DSH 重启或插件热重载后清零；
自愈路径是重新打开 tab，或再敲一次 `/roundtable`。因此徽章显示的是 **host 回包的真值**（`mode.get`
轮询 5s），不是本地猜测；真值未到前不画徽章（不闪假状态）。

**落点**：`src/mode.ts`（新，纯函数 + 状态表）、`src/index.ts`（命令注册 + 模式段）、
`src/rpc.ts`（`mode.get` / `mode.set`；`RoundTableRuntime.mode?` 可选字段）、
`src/client/{RoundTableView.tsx,wire.ts,locales.ts,RoundTableView.module.css}`、
`test/discussion-mode.test.mjs`（新，12 例：语义 7 + 接线守卫 5）。

**顺带修的坑（本条最该记的）**：为拿 `ctx.commands` 的类型，一度在本目录跑了裸
`npm install @deepseek-ai/dsh-commands` —— 它按 `package.json` **重算了依赖树，把 17 个 peer
junction 全换成实体副本**（rc.2，与宿主的 rc.1 脱钩），并留下 `node_modules/.package-lock.json`。
修复：36 个 `@deepseek-ai/*` 目录按维护纪律那套 `mklink /J` 重建回 junction，删掉
`node_modules/.package-lock.json`，`git checkout -- package-lock.json`（本仓 lock 早已脱节，不参与构建）。
**结论：本仓加 devDependency 只能手改 `package.json`，绝不再跑裸 `npm install`。**

## 二、改动落在哪些文件
| 文件 | 改动 |
|---|---|
| `src/tools.ts` | `RolePresetLike` / `resolvePreset`（已 export 供测试）/ `getRolePresets` / `roundtable_list_presets` / `add_node.preset` / `plan_meeting.experts[].preset` |
| `src/plan.ts` | `formatMeetingDraft` 支持 `preset` / `unresolved`，卡片标注来源与未解析告警 |
| `src/index.ts` | 接入 `getRolePresets`；工具名清单加 `roundtable_list_presets`；usage 第 3 条改写 |
| `src/members.ts` | `nodeToolRestriction` 增加 `isRegistered` 参数并过滤 |
| `test/preset-binding.test.mjs` | 新增 8 例（import 用到的 `resolvePreset` 必须 export） |
| `test/tool-restriction.test.mjs` | 新增 10 例 |
| `test/plan.test.mjs` | 新增 3 例（卡片来源标注 / 未解析告警 / 不误报） |
| `src/members.ts` (R-B) | deny += `send_message` / `roundtable_next_round`；allow -= `send_message`；persona 反指引 + modeRule 三分支 |
| `src/charter.ts` (R-B) | 第三节：`[核心产出]` 自包含、`[建议决策]` 行、单一出口原则 |
| `src/aggregator.ts` (R-B) | digest 提取 `[建议决策]` 附到条目 |
| `src/index.ts` (R-B) | usage 第 5/6 条改写 + 新增第 14 条单一出口纪律；工具清单加 `roundtable_next_round` |
| `src/tools.ts` (R-B) | 新工具 `roundtable_next_round`（beginRound + 超限持久化 muted） |
| `test/tool-restriction.test.mjs` (R-B) | +3 例 |
| `test/budget.test.mjs` (R-B) | +4 例（beginRound / 触顶闭麦 / 解麦联动） |
| `test/aggregator.test.mjs` / `test/persona.test.mjs` (R-B) | 新建（4 + 4 例） |
| `src/charter.ts` (R-C) | 名册表下加快照新鲜度声明（W1） |
| `src/members.ts` (R-C) | modeRule 三分支 rosterHint + `nodeWelcome` 按模式分叉（W2） |
| `src/index.ts` (R-C) | usage 规则 3/5/9：每轮一次 status 查册 + 名册变更 `to="all"` 广播义务（W3） |
| `src/tools.ts` (R-C) | `roundtable_send_message` 支持 `to="all"`；导出纯函数 `broadcastRecipients`（W4） |
| `test/broadcast.test.mjs` (R-C) | 新建 4 例（广播受众集合 / 空名册边界） |
| `test/persona.test.mjs` (R-C) | +4 例（rosterHint 三分支 / welcome 分叉 / 查册收尾句 / charter 快照声明） |
| `src/mode.ts` (E) | 新：`SessionModeTable`（两来源互不覆盖）/ `parseModeCommand` / `runModeCommand` / `modeSectionText` |
| `src/index.ts` (E) | `/roundtable` 命令注册（`ctx.inject(['commands'])`）+ `roundtable:mode` 条件段 + `runtime.mode` 接线 |
| `src/rpc.ts` (E) | `roundtable/mode.get`、`roundtable/mode.set`（输入校验：空 sessionId / 非布尔 active 一律拒绝） |
| `src/client/RoundTableView.tsx` (E) | 挂载/卸载 effect 写 `auto`（cleanup 用 `alive` 标志丢掉晚到回包）+ 5s 轮询 `mode.get` + 头部模式徽章 |
| `src/client/{wire,locales}.ts` (E) | `WireModeState`；5 个文案键（zh/en 各一份） |
| `test/discussion-mode.test.mjs` (E) | 新：12 例 |

## 三、当前状态（2026-09-20 实测，E 功能「圆桌讨论模式」落地后）

- 版本 `0.2.45`（package.json 与 src/version.ts 逐字一致闸门通过）
- `tsc` host + client **双端 0 错误**；`node --test` **273/273 全绿**（23 个文件）
- **运行态实测（E 功能）**：RPC 探针六种输入全符合预期 —— `mode.set(true)` → `active:true`；
  `mode.get` 回读一致；`set(false)` 归零；空 `sessionId` 与 `active:"yes"` 各自被拒（不写垃圾键）。
  斜杠命令清单实测 8 条，第 7 位即 `roundtable`，描述与输入提示逐字一致（`compact/export/feedback/
  goal/permission/plan/roundtable/scnote`）；热重载后复跑，命令与端点均保持不变
- **接线守卫**（`test/discussion-mode.test.mjs`）：host 真注册了 `/roundtable`、提示词段真按会话条件化、
  客户端挂载/卸载真写 `auto` 且徽章读 host 真值、RPC 两端点存在且校验输入、`mode?` 可选字段真被接线
- **反验收（变异实测，九组全红）**：M1–M4 打语义层、W1–W5 打接线层。其中 **W1/W3 首轮是 fail=0 的假绿**
  （W1：注释里含同一字符串，断言匹配到了注释；W3：只查"文件里出现过 active:false"，被挂载路径那次冒充），
  已就地修强：新增 `stripLineComments` + cleanup 切片内断言。⚠ 变异脚本**不要用 `Set-Content` 回写**源文件
  （会把 UTF-8 中文写成 ANSI，实测把 `src/index.ts` 写坏、read 直接报 `invalid UTF-8`）
- **环境修复**：36 个 `@deepseek-ai/*` peer 目录重建回 junction（原被裸 `npm install` 换成 rc.2 实体副本，
  与宿主 rc.1 脱钩）；`node_modules/.package-lock.json` 已删；`package-lock.json` 已还原
- 历史快照：R-C（0.2.36 / 100 例）、R-D host 侧（0.2.42 / 217 例）、R-D-UI（0.2.43 / 235 例）、
  R-D 收尾（0.2.44 / 241 例）—— 均已被上文取代，留作基线对照
- **接线审计**：快照 `plan` 8 字段、`talentPool` 2 字段、`buildRoundSignals` 13 字段 —— **逐个**有消费者
- 部署链：`profiles/web/node_modules/dsh-plugin-roundtable` → junction → 本目录

## 四、维护纪律

### 唯一真相就是本目录

改动的正确姿势（**不再有第二份实体副本要同步**）：

```powershell
cd D:\lk\FF\dsh-plugin-roundtable

# 1) 类型检查（双端）
node node_modules\typescript\bin\tsc -p tsconfig.json --noEmit
node node_modules\typescript\bin\tsc -p tsconfig.client.json --noEmit

# 2) 测试（逐文件跑；目录模式会因沙箱 EPERM 失败，属已知环境限制）
Get-ChildItem test\*.test.mjs | ForEach-Object { node --test $_.FullName }

# 3) 构建（产物直接落本目录 lib/，junction 让它立即可被宿主读到）
node node_modules\tsdown\dist\run.mjs -c tsdown.config.ts
```

第 4 步：**热重载**——调 `dev_reload_package 'dsh-plugin-roundtable'`（免重启），
或重启宿主。**不需要再手工复制 lib/ 到任何地方**。
### 两条不要踩的坑

1. **别在本目录跑 `pnpm install --frozen-lockfile`**：`pnpm-lock.yaml` 与 `package.json` 已脱节
   （lockfile 是 0.1.1-rc.2 时代，manifest 是 0.1.5-rc.2），必然失败。
2. **别用裸 `npm install` 装别的依赖**：会按 `package.json` 重算依赖树，
   可能把 17 个 peer junction 换成实体包（体积暴涨且与宿主版本脱钩）。
   只装构建工具时用：`npm install --no-save --no-package-lock --cache .npm-cache <pkg>`。
   ⚠ **2026-09-20 实测：这个坑已经真的踩过一次** —— 为加一个 devDependency 跑了裸
   `npm install @deepseek-ai/dsh-commands`，36 个 `@deepseek-ai/*` 目录全部被换成实体副本
   （rc.2，宿主是 rc.1），并生成 `node_modules/.package-lock.json`。**加 devDependency 只手改
   `package.json` 三处（peer / peerMeta / devDeps）**，不跑 npm install。

3. **别用 `Set-Content` 回写 `src/` 下的源文件**（做变异测试/批量替换时最容易犯）：
   PowerShell 默认按 ANSI 落盘，`src/index.ts` 的中文实测被写坏（33138 → 33016 字节，
   read 工具报 `invalid UTF-8`）。要么只走 editor 工具，要么显式 `-Encoding utf8` 并改后回读核对。

4. **改动不生效时，第一件事是查部署链是不是还指着本目录**（本仓最隐蔽的一类故障）：
   `profiles/web/node_modules/dsh-plugin-roundtable` 是**自动装配出来的**，只要跑过一次裸
   `npm install`（见第 2 条）或 `pnpm install`，就**可能从 junction 退化成实体副本**。
   退化后你改本目录，运行时装载的却是那份冻结的旧副本 —— 症状极具误导性：
   **产物里明明有这段代码（grep 得到），接口却报 `unknown endpoint`**，看起来像"代码写错了"。

   ⚠ **2026-09-20 实测踩到**：加完 `mode.get` / `mode.set` 两个端点后，`lib/index.js` 里两个
   `case` 都在，但接口一直回 `unknown endpoint: roundtable/mode.get`；同时 `prefs.get` 等**旧端点
   正常**（因为旧副本也有它们）—— 这个"新端点全废、老端点照常"的组合正是退化的指纹。

   现场取证（两条命令足够定性）：
   ```powershell
   $a = 'C:\Users\lk\.dsh\profiles\web\node_modules\dsh-plugin-roundtable'
   # ① 是不是 reparse point：报 'not a reparse point' = 实体副本（退化）
   cmd /c "fsutil reparsepoint query `"$a`" 2>&1"
   # ② 字节比对：与项目产物不一致 = 装载的不是你改的那份
   (Get-FileHash "$a\lib\index.js").Hash -eq (Get-FileHash 'D:\lk\FF\dsh-plugin-roundtable\lib\index.js').Hash
   ```
   修复（先留档再重建，切勿直接删）：
   ```powershell
   $p = 'C:\Users\lk\.dsh\profiles\web\node_modules'
   Rename-Item "$p\dsh-plugin-roundtable" "$p\dsh-plugin-roundtable.bak-entity-$(Get-Date -Format yyyyMMdd-HHmmss)"
   cmd /c mklink /J "$p\dsh-plugin-roundtable" "D:\lk\FF\dsh-plugin-roundtable"
   ```
   最后**必须热重载 + 调一次端点**才算完（`dev_reload_package roundtable`）；只看 `git status` 或
   grep 产物**不算验证**——那正是这次误判成"代码问题"的起因。

### node_modules 说明（可重建，不必联网装 peer）

17 个 `@deepseek-ai/*` peer 包用 **junction** 指向宿主
（`C:\Users\lk\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules`），
另装 `typescript` + `tsdown` 两个构建工具。损坏时重建 junction 即可：

```powershell
$hostNm = 'C:\Users\lk\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules'
$peers = 'cordis','schemastery','dsh-agent','dsh-client-connection','dsh-client-locale',
  'dsh-client-ui-conversation','dsh-client-ui-settings','dsh-host-webserver','dsh-llm',
  'dsh-session','dsh-settings','dsh-skill','dsh-subagent','dsh-system-prompt','dsh-tools',
  'dsh-user-questions','dsh-workspace'
foreach ($p in $peers) {
  cmd /c mklink /J "D:\lk\FF\dsh-plugin-roundtable\node_modules\@deepseek-ai\$p" "$hostNm\@deepseek-ai\$p"
}
npm install --no-save --no-package-lock --cache .npm-cache typescript@5.9.2 tsdown@0.15.6
```

## 五、备份留档（旧目录产物，可删）

> **2026-09-20 清算**：本节所列多项**实测已不存在**，逐项复核结果如下（`Test-Path` 直出）。
> 保留此表是为了记住"哪些曾存在、为什么可删"，而不是当作现存清单。

| 位置 | 内容 | 2026-09-20 复核 |
|---|---|---|
| `C:\Users\lk\.dsh\profiles\web\node_modules\@huanlin\dsh-plugin-roundtable.bak-migrate-20260917-163419` | 迁移前的部署副本（实体） | **已删**（4.02 MB，旧包名 `@huanlin/*` 时代残留，不在装配链上） |
| `C:\Users\lk\.dsh\profiles\web\node_modules\@huanlin\dsh-plugin-roundtable.bak-copy-drift-20260919` | 副本漂移备份（实体） | **已删**（73.68 MB，同上） |
| `C:\Users\lk\.dsh\profiles\web\package.json.bak-migrate-20260917-163334` | 改指向前的 profile 清单 | 仍在（1.6 KB，成本可忽略） |
| `D:\lk\deepseek\plugins\dsh-plugin-roundtable-main` | **旧源目录（已停用）** | **本就不存在**——文档曾记「保留 `lib.bak-pre-RA-*` 与 `.npm-cache`（103 MB）可清」，实测目录早已清掉，此条是过时记录 |
| `D:\lk\FF\.roundtable\role-presets-self-review\export.md` | 自审会议记录 | 仍在（属会议数据，**不动**） |
| `D:\lk\FF\.rt-self-review\` | 自审的四份证据材料 | 仍在（4 份，**不动**） |

### 本仓内已清（2026-09-20）

| 位置 | 内容 | 判据 |
|---|---|---|
| `.npm-cache/` | 本地构建缓存（**103.34 MB**） | 本仓 `.gitignore:10` 自己写明「可达 100 MB+」；重装构建工具时会按需重建：`npm install --no-save --no-package-lock --cache .npm-cache <pkg>` |
| `tset/word.txt` | `test` 的**误拼目录**，内容仅 `1223` | 顶层 `test/` 下无同名文件；已 `git rm` 从版本库摘除 |
| `src/members.ts.bak-allowlist-20260917-132322` | 旧版 `members.ts`（284 行 vs 现行 321 行） | 全仓源码/测试/脚本**零引用**（grep 确认）；已 `git rm` |
| `test/.render-tmp/` | 渲染测试临时产物目录（当时为空） | `.gitignore:15` 已忽略，下次跑测试会自建 |

## 六、包名与发布链路（2026-09-20 变更）

- **包名去 scope**：`@huanlin/dsh-plugin-roundtable` → `dsh-plugin-roundtable`。
  理由：`@huanlin` 是上游作者的 npm scope，本仓已独立维护，不该继续挂在别人的命名空间下。
  改动落在四处（缺一处即装配失败）：
  1. 本仓 `package.json` 的 `name`（另加 `"private": true`，明确不发布 npm）
  2. 本仓 `cordis.patch.yml` 的 `name:`
  3. 本仓 `tsdown.config.ts` 的 `const ID`（客户端 bundle 的 `__ModuleLoader__.load({id})` 与 CSS `data-plugin`）
  4. profile 侧：`profiles/web/package.json`（dependencies + bundles）与 `profiles/web/cordis.yml` 的 `name:`
- **junction**：`profiles/web/node_modules/dsh-plugin-roundtable` → 本目录。
  旧名 `node_modules/@huanlin/dsh-plugin-roundtable` 的 junction **保留作运行期兼容垫片**
  （当前进程仍按旧名解析）；确认新版运行正常并**重启 DSH** 后可删。
  > **2026-09-20 复核**：`@huanlin/` 下已无活 junction，只剩两个 `.bak-*` 实体备份，
  > 均已删除（77.7 MB）。当前 `profiles/web/node_modules/dsh-plugin-roundtable` 已是
  > **Junction → `D:\lk\FF\dsh-plugin-roundtable`**（`LinkType=Junction` 实测），
  > 改源码后构建即被宿主读到，**不需要再手工复制 `lib/`**。
- **发布链路已拆**：删除 `.github/workflows/publish.yml`（GitHub Actions 发布工作流）、
  远端 Release 与 tag v0.2.45、仓内上游快照 `.upstream/roundtable-v0.2.35-upstream.tar.gz`。
  **本仓不发 npm、不打 Release**；`release-notes/` 仅作变更记录留存。

## 七、上游关系（历史留档）

RoundTable 最初由 [@huanlin](https://github.com/9931666) 创作并开源（MIT），
仓库 [`9931666/dsh-plugin-roundtable`](https://github.com/9931666/dsh-plugin-roundtable)。
原作者已停止维护，本仓自其 **v0.2.35** 基线接手，**独立维护、不回合并、不依赖上游更新**。

- 上游最后推送：2026-09-13；上游仓库仍存在（未归档），源码与 MIT 版权声明完整保留自上游
- 曾提交的两个上游 PR（#2 预设装配链 / #3 工具白名单过滤）**未合并**，相关改动已在本仓自行落地
- 本仓不向上游回推、也不等待上游

