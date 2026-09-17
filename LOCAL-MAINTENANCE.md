# 本地自维护说明（RoundTable 插件）

> **本目录 `D:\lk\FF\dsh-plugin-roundtable` 是本机唯一真相。**
> 上游 `9931666/dsh-plugin-roundtable` 仅作基线，不回合并也不依赖其更新。
> 2026-09-17 从 `D:\lk\deepseek\plugins\dsh-plugin-roundtable-main` 迁入工作区。

## 零、目录与部署关系（先读这一节）

```
D:\lk\FF\dsh-plugin-roundtable                    ← 唯一真相（改这里）
        ↑ junction
C:\Users\lk\.dsh\profiles\web\node_modules\@huanlin\dsh-plugin-roundtable
        ↑ 由 profiles/web/package.json 声明
"@huanlin/dsh-plugin-roundtable": "file:D:/lk/FF/dsh-plugin-roundtable"
```

宿主的 loader entry 落在 `profiles/web/node_modules/@huanlin/dsh-plugin-roundtable/lib/index.js`，
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

## 三、当前状态（2026-09-17 16:33 实测，迁入工作区后重跑）

- `tsc` host + client **双端 0 错误**；`node --test` **77/77 全绿**
- `tsdown` 构建通过：`lib/index.js` 168,382 bytes / `lib/client.js` 526,348 bytes
- 运行态：热重载后 `roundtable_list_presets` 实测返回 27 条（filter 亦生效）
- 部署链：`profiles/web/node_modules/@huanlin/dsh-plugin-roundtable` → junction → 本目录

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

第 4 步：**热重载**——调 `dev_reload_package '@huanlin/dsh-plugin-roundtable'`（免重启），
或重启宿主。**不需要再手工复制 lib/ 到任何地方**。

### 两条不要踩的坑

1. **别在本目录跑 `pnpm install --frozen-lockfile`**：`pnpm-lock.yaml` 与 `package.json` 已脱节
   （lockfile 是 0.1.1-rc.2 时代，manifest 是 0.1.5-rc.2），必然失败。
2. **别用裸 `npm install` 装别的依赖**：会按 `package.json` 重算依赖树，
   可能把 17 个 peer junction 换成实体包（体积暴涨且与宿主版本脱钩）。
   只装构建工具时用：`npm install --no-save --no-package-lock --cache .npm-cache <pkg>`。

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

| 位置 | 内容 |
|---|---|
| `C:\Users\lk\.dsh\profiles\web\node_modules\@huanlin\dsh-plugin-roundtable.bak-migrate-20260917-163419` | 迁移前的部署副本（实体） |
| `C:\Users\lk\.dsh\profiles\web\package.json.bak-migrate-20260917-163334` | 改指向前的 profile 清单 |
| `D:\lk\deepseek\plugins\dsh-plugin-roundtable-main` | **旧源目录（已停用）**，保留 `lib.bak-pre-RA-*` 与 `.npm-cache`（103 MB）可清 |
| `D:\lk\FF\.roundtable\role-presets-self-review\export.md` | 自审会议记录（60 KB） |
| `D:\lk\FF\.rt-self-review\` | 自审的四份证据材料 |

## 六、上游 PR（留档，不指望合并）

- PR #2：`https://github.com/9931666/dsh-plugin-roundtable/pull/2`（预设装配链）
- PR #3：`https://github.com/9931666/dsh-plugin-roundtable/pull/3`（工具白名单过滤）

上游实况（2026-09-17 侦察）：无 CONTRIBUTING、无 PR 模板、无 CODEOWNERS；
CI 只有 `publish.yml` 且**仅 tag 触发**（PR 不跑任何检查）；
维护者 `9931666` 最后推送 2026-09-13，唯一 issue 挂了 7 天 0 回复。
**决定不等待上游**，以本机为准自维护。
