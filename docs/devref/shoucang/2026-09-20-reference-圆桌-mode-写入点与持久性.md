# [项目事实] reference · 圆桌 mode 写入点与持久性

- 卡类型：reference
- 溯源：release-notes/v0.2.50.md
- 源会话：session-4110fe62-2107-487a-a7b6-6e78eb7ae1e7
- 工作区：D:\lk\FF\dsh-plugin-roundtable

isActive = auto || manual。只开关「圆桌会议」Tab → 写 auto，切走 tab 自动撤销；敲 /roundtable 或在空状态输入框打字 → 写 manual，切走 tab 仍开启。清 manual 只有 /roundtable off 或重启进程两条路。实测法：假会话 id 直打 RPC 逐档录 mode.get。徽章原只在有会议时的头部渲染（早退体之后），空状态那屏在早退体内故缺徽章；modeState 在早退前已拉到，非取数失败。
