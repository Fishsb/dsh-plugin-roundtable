# .audit · 模型链路实测证据（2026-09-23）

本目录是 `docs/audit-2026-09-23-全量会话审计与优化方案.md` §14 的**原始证据**，
用于支撑「角色预设按任务类型分派」的结论。数字与结论见该文档 §14，此处只放可复现件。

## 为什么要有它

上一轮的分派理由取自**厂商自报榜单**（Terminal Bench 3.0 / CyberGym）。
本轮要回答的问题是：**本链路（dshapi 中转）上两个模型的真实速度各是多少。**
自报榜单答不了这个问题——独立综述已声明其跨 harness 不可比。
故此处全部是端到端实测读数，不是文档标称值。

## 可直接复现的脚本

| 脚本 | 回答什么 | 关键判据 |
|---|---|---|
| `bench/bench-final.mjs` | 访问速度（TTFT）· 输入 prefill 速率 · 输出 decode 速率 | TTFT 取**最小值**隔离服务端排队噪声；输出速率按**首字→收尾窗口**算，不用总耗时 |
| `bench/bench-prefill.mjs` | 净 prefill 速率（扣除排队基线） | 交错采样抵消负载漂移 + 两点法 |
| `bench/bench-toolcall18.mjs` | GLM 多工具 agentic 退化（社区报告 `!!!!!` 塌缩）是否命中本链路 | 18 个工具 × 8 轮；判据 = 连续 ≥20 个相同字符 |

| `bench/bench-toolcall.mjs` | GLM 多工具 agentic 退化（社区报告 `!!!!!` 塌缩）是否命中本链路 | 5 个圆桌真实工具 × 6 轮；判据 = 连续 ≥20 个相同字符 |
| `bench/bench-toolcall18.mjs` | 同上，加码版（贴近真实会话工具面） | 18 个工具 × 8 轮 |

运行（凭据**不落源码**：从 `DSHAPI_API_KEY` 环境变量或 `~/.dsh/.credentials.yaml` 读取，见
`bench/lib-dshapi.mjs`；直连不走代理）：

```bash
node .audit/bench/bench-final.mjs        # 访问速度 + prefill + decode
node .audit/bench/bench-prefill.mjs      # 净 prefill（扣排队基线）
node .audit/bench/bench-toolcall.mjs     # 多工具退化（5 工具）
node .audit/bench/bench-toolcall18.mjs   # 多工具退化（18 工具，加码）
```

另有 `.audit/scan-sessions.mjs` / `scan-meetings.mjs`（§1 全量会话审计的取材脚本）
与 `meetings.jsonl`（31 场圆桌会话的扫描结果）。

## 原始日志（`bench/bench-log-*.txt`）

日志是**未被加工的** stdout 留档，含中间探索与**纠错过程**，不要删：

| 日志 | 留档价值 |
|---|---|
| `bench-log.txt` · `-2` · `-3` · `-5` | 早期探索。**含我的判据错误**：先用「总耗时」得出「GLM 更快」的相反结论 |
| `bench-log-4-cache.txt` | 缓存命中排查：同 prompt 连发，`prompt_cache_hit_tokens` 从 512 → 6272，证明缓存确实在起作用 |
| `bench-log-6-prefill.txt` | 暴露**物理不可能数据**（60k prompt 的 TTFT 低于 12k）⇒ 发现 TTFT 被排队主导，改用 min 口径 |
| `bench-log-8-bimodal.txt` | GLM 输出速率**双峰**（65 vs 212 t/s）的排查 |
| `bench-log-9-burst.txt` | 双峰根因：非限流。连发 8+8 轮全为快档 ⇒ 属时间相关负载 |
| `bench-log-7-decompose.txt` | 排除「GLM 慢是因为想得多」：关思考后仍 213 vs 402 t/s |
| `bench-log-toolcall.txt` · `-toolcall18.txt` | 多工具退化复现（0/14 未复现），以及旁证 GLM 均耗时 2.1× |

## 保留的 JSON 结论

`bench-final.json` · `bench-result-6-prefill.json` · `toolcall-degeneration-18.json`
—— 与文档 §14 表格一一对应。

## 已删除的件

被后来脚本取代的探索迭代（`bench-models{,-2,-3,-5}.mjs`、`bench-bimodal.mjs`、
`bench-burst.mjs`、`bench-cache.mjs`、`bench-decompose.mjs` 及对应 JSON）已删，
其发现与纠错过程保留在上面的日志里。删除理由：同一结论不留两份实现。

⚠ 本目录脚本原先把 dshapi key 写成了明文，已改为经 `bench/lib-dshapi.mjs` 从
环境变量或 `~/.dsh/.credentials.yaml` 读取（`git grep sk-` 应为空）。
若曾把含明文 key 的提交推到公开远端，须 `git filter-repo` 并轮换该 key。

## 一条纪律（本目录存在的理由）

> 上一轮我用**总耗时**当判据，把「GLM 输出短」读成了「GLM 快」。
> 总耗时 = 排队 + 输入处理 + 输出长度 ÷ 速率，被输出长度严重污染。
> **代理指标非判据**——凡要断言速度，须给归一化速率，并说明分母是什么。

另：本目录工具在**无 `system` 消息**时发现中转站注入约 **520 token 隐藏前缀**
（`prompt="hi"` ⇒ `prompt_tokens=522`，3 次恒定）。
