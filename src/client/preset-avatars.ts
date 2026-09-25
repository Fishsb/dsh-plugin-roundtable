/**
 * 角色预设的内置头像集。
 *
 * ## 为什么是「字形」而不是图片
 *
 * 1. **高频重绘面**：群聊与拓扑都是 1Hz 快照驱动的重绘面，图片要额外处理
 *    加载态、失败态与缓存，而字形是纯文本，零额外状态。
 * 2. **离线/内网**：外链图片会碎；内置图片则要随包打进 `lib/client.js`
 *    （本插件客户端产物已 600KB 量级，每张图都是净增）。
 * 3. **主题无关**：emoji 与几何符号自带颜色或随 `currentColor`，不需要为明暗
 *    两套主题各准备一份资源。
 * 4. **数据结构便宜**：存的是一个短串，进快照几乎不增体积。
 *
 * ## 选形原则
 *
 * 覆盖圆桌会议里**真实会出现的职能族**（需求/架构/实现/审查/测试/安全/数据/
 * 文档/协调…），每个字形在 28px 圆形里都能一眼分辨；不追求语义精确，追求
 * **彼此好区分** —— 头像的作用是"这条是谁说的"，不是"这个人是干什么的"
 * （后者由 `title` 职能名承担）。
 *
 * @module dsh-plugin-roundtable/client/preset-avatars
 */

/** 可选头像（有序：面板按此顺序铺开，常用的靠前）。 */
export const PRESET_AVATARS: readonly string[] = [
  '🎯', '🧭', '📐', '🏗️', '⚙️', '🔧', '🔬', '🧪',
  '🛡️', '🔐', '📊', '🧮', '📚', '📝', '🗣️', '🧩',
  '⚖️', '🔭', '🧵', '🎨', '🚦', '🪜', '🧱', '🕸️',
]

/** 头像最大长度（与 host 侧净化上限一致，含 emoji 变体选择符）。 */
export const AVATAR_MAX = 8

/**
 * 取头像要显示的字形。
 *
 * 判定顺序：**自定义头像 → provider 品牌字形 → 名称首字**。
 * 空白或超长一律视为"未设置"（超长防的是有人把整段文本塞进这个字段）。
 */
export function presetAvatarGlyph(avatar: string | undefined, fallback: string): string {
  const raw = typeof avatar === 'string' ? avatar.trim() : ''
  if (raw === '' || raw.length > AVATAR_MAX) return fallback
  return raw
}

/**
 * 没有头像时用**名称首字**兜底（而不是 provider 品牌）。
 *
 * 为什么不回落 provider：在圆桌里，同一个 provider 会拉起多个不同职能的专家
 * （本机实测一场会议里 3 个 deepseek 席）。全部回落成同一个品牌 logo，等于
 * "三个人长得一模一样"——那比没有头像更糟。用名称首字至少彼此可分。
 */
export function presetFallbackGlyph(title: string, name: string): string {
  const source = title.trim() !== '' ? title : name
  const first = [...source.trim()][0]
  return first === undefined ? '•' : first
}
