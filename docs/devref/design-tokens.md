# 宿主设计令牌参考（DSH Web GUI）

> **为什么单独立档**：同一类缺陷在本仓与宿主各犯过一次 ——
> 引用了一个**看起来合理但从未定义**的 CSS 变量，声明静默失效、不报错。
> 亮色主题下靠继承值"看着还行"，暗色主题下才暴露，而截图与肉眼抽查都抓不到。
> 本档记录**宿主真实存在**的令牌，引用前照此核对；new 令牌先加进 `src/client/tokens.module.css`。

## 一、令牌住在哪（检索陷阱）

宿主**不在打包 CSS 里写主题**。`dsh-web-frontend/dist/assets/*.css` 全文
`:root` / `data-theme` / `prefers-color-scheme` 命中 **0 次**。

权威源是宿主插件 `dsh-client-ui-theme` 的**内联 CSS 字符串**，运行时由
`installThemeStyles()` 注入 `<style data-plugin-css>`：

```
<profile>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js
  L1148  design_platform_css_default   ← 静态色板 77 + 语义别名 101，明/暗两套
  L1154  gradient_shadow_text_*        ← 阴影阶 + 181 个排版 token
```

**别在 node_modules 里 grep 令牌名** —— 会得到假阴性。按「声明形式」（名字后跟冒号）回查才准。

## 二、主题切换机制

```
dark ? body.setAttribute("data-ds-dark-theme", "") : body.removeAttribute("data-ds-dark-theme")
documentElement.style.colorScheme = scheme
```
—— 出处：`dsh-client-ui-layout/lib/client.js` L516+。

**插件不要自写 `[data-theme]`、不要自读 `prefers-color-scheme`**：只消费 `var(--dsw-alias-*)` 即自动跟随两主题。
唯一例外是极端情形写 `:global(body[data-ds-dark-theme])`（宿主先例：primitives 的 `JsonTree.module.css:20`）。

## 三、本插件实际用到的 26 个宿主令牌（全部已核存在）

| 角色 | 宿主令牌 |
|---|---|
| 画布 / 内嵌下沉面 | `--dsw-alias-bg-module-platform` |
| 卡片 / 弹层表面 | `--dsw-alias-bg-layer-1`、`-2`、`-3` |
| 反相块（主持人节点） | `--dsw-alias-label-primary` + `--dsw-alias-label-primary-foreground` |
| 遮罩 | `--dsw-alias-bg-mask-1` |
| 交互底色 | `--dsw-alias-interactive-bg-hover`、`-hover-danger` |
| 描边 | `--dsw-alias-border-l2`、`-l3`、`-l4` |
| 文字三级 | `--dsw-alias-label-primary`、`-secondary`、`-tertiary`、`-caption`、`-primary-foreground` |
| 品牌 / 信息蓝 | `--dsw-alias-state-business-primary`、`--dsw-alias-button-info-hover` |
| 状态 | `--dsw-alias-state-error-primary`、`-secondary`；`state-success-primary`；`state-warn-primary`、`state-warn-label`；`state-idle-primary` |
| 焦点环 | `--dsw-alias-brand-primary` |
| 高度 | `--dsw-elevation-soft`、`--dsw-elevation-prominent` |

### ⚠ 三个反直觉点

1. **`--dsw-alias-brand-primary` 在亮色主题下是黑色（`#0f1115`），不是蓝色。**
   拿它当填充色会出现"半蓝半黑"。它只适合做**焦点环**（宿主全仓就这么用）。本插件的信息蓝走 `state-business-primary`。
2. **宿主自己也引用过不存在的令牌** —— `--dsw-alias-bg-layer-4`（`settings-form/fields.module.css:58`）与
   `--dsw-alias-label-error`（`SettingsForm.module.css:29`）在宿主全仓 0 定义。
   ⇒「宿主里出现过」**不等于**「存在」，必须按声明形式回查。
3. **全局有 `corner-shape: superellipse(1.5)`**，通过 `*,:before,:after` 通配。
   正圆与胶囊（`border-radius: 50%` / `999px`）会被切成方块，必须显式 `corner-shape: round` 退出
   （宿主先例：`Switch.module.css`、`Tag.module.css`）。本插件 30 处已补。

## 四、视觉规格（宿主 primitives 实测）

| 控件 | 规格 |
|---|---|
| 主按钮 | radius 18px、高 36px、padding 0 14px、14px/22px |
| 紧凑按钮 | 高 28px、12px/18px、padding 0 10px、radius 14px |
| 次按钮 ghost | 无底，hover `interactive-bg-hover` |
| 次按钮 outline | `border: 0.5px solid --dsw-alias-border-l3` |
| **危险按钮** | **宿主无此变体**；先例只有文字型 `color: state-error-primary` 与 Tag 的 danger 音调 |
| 输入框 | 高 34px、padding 0 12px、radius 8px、`border: 0.5px solid border-l4`、bg `bg-layer-3`；`:focus-visible` 只换边框色 |
| 开关 | 36×20、radius 10px **+ corner-shape: round**、padding 2px；关 = `border-l3`、开 = `brand-primary`；滑块 16px `label-primary-foreground` |
| 标签 Tag | radius 999px **+ corner-shape: round**、padding 1px 8px、11px/17px/500；状态色 = `color-mix(in srgb, <state> 10%, transparent)` |
| 卡片 | `border: .5px solid border-l2` + `bg-layer-1` + radius 18px |
| 浮起卡片 | `box-shadow: elevation-stroke`、bg `bg-layer-3`、border 0、radius 14px |
| 对话框 | radius 24px、bg `bg-layer-2`、`box-shadow: elevation-prominent`、**border 0** |
| 菜单 | radius 16px、bg `--dsw-specific-menu`、`backdrop-filter: --dsw-menu-backdrop-filter` |
| 焦点环 | `:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px }` —— **宿主每个可聚焦控件都有** |

**间距无 token**（全仓 0 个 `--dsw-spacing/space`，0 处 `border-radius: var(--dsw…)`）。
实测节奏：2px 网格上的 `{2,4,6,8,10,12,14,16,24}`，**不是 4/8 严格倍数**。
字号有 8 档 token（`--dsw-font-xxxs-11` … `--dsw-font-xl-24`），宜用 shorthand `font: var(--dsw-font-xs-13)`。

## 五、本插件自己的令牌层

`src/client/tokens.module.css` 是**插件内所有色值的唯一出处**（`:root` + `--rt-` 前缀）。
三个 CSS Module 一律消费 `var(--rt-*)`，不再直接出现字面色值。

> **刻意保留的字面 hex**：`providers.tsx` 里 9 个第三方厂商品牌色（zai/openai/claude/qwen/kimi/gemini…），
> 用作头像底色。厂商品牌色**本就不应跟随主题翻转**，保持字面值是正确设计，不要"顺手"令牌化。

### 消费方自检（改完必须跑）

```powershell
# 1) 我引用的 --dsw-* 名字宿主是否真的定义了（按声明形式回查）
node -e "const fs=require('fs');const t=fs.readFileSync('<theme>/lib/client.js','utf8');const d=new Set([...t.matchAll(/(--dsw-[a-z0-9-]+)s*:/g)].map(m=>m[1]));const u=[...new Set([...fs.readFileSync('src/client/tokens.module.css','utf8').matchAll(/var((--dsw-[a-z0-9-]+))/g)].map(m=>m[1]))];console.log('缺失:',u.filter(n=>!d.has(n)))"

# 2) 三个模块里不应再有字面色值（rgba(/hex），除了 tokens 层与厂商品牌色
# 3) 改完必须重建 + 热重载，并核对产物：`lib/client.js` 是运行时真正加载的那份
```
