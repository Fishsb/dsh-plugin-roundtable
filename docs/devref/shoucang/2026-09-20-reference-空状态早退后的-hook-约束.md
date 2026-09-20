# [项目事实] reference · 空状态早退后的 hook 约束

- 卡类型：reference
- 溯源：src/ChatComposer.tsx · v0.2.48
- 源会话：session-4110fe62-2107-487a-a7b6-6e78eb7ae1e7
- 工作区：D:\lk\FF\dsh-plugin-roundtable

`if (meeting === undefined) return ...` 这个早退分支之后不得再出现 hook。有无会议是同一组件的两次渲染，hooks 数量不一致会在切到下一个会议时抛错。steerSending/startMeeting 均置于早退之前，并有守卫固化该顺序。
