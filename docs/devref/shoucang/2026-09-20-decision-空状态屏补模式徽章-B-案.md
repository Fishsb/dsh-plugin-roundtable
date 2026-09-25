# [项目事实] decision · 空状态屏补模式徽章（B 案）

- 卡类型：decision
- 溯源：release-notes/v0.2.50.md
- 源会话：session-4110fe62-2107-487a-a7b6-6e78eb7ae1e7
- 工作区：D:\lk\FF\dsh-plugin-roundtable

保留 manual 语义不动，只在空状态那一屏也显示徽章：抽 src/client/ModeBadge.tsx 两处共用同一组件；state===null 时什么都不渲染（不画假状态）。语言键 modeViaCommand → modePersistent，因 manual 有两个写入点，旧文案「命令开启」对输入框起草来源是假标签，改描述后果「切走 tab 仍开启」。验证：npm test 314/314、变异全扫 29/29、tsc 双端 0 错。
