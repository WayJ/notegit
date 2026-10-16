# Notegit Design System — v2（工作台原型体系）

> **v2（2026-10-15，用户裁决「样式也按照静态原型页面做」）**：本版整体取代 v1（米色/珊瑚/衬线
> 编辑风，S9 基线——全文见 git history）。v1 的 token 语义（coral 主 CTA、cream 画布、
> 衬线 display）**全部废止**；本文件是仓库 UI 的唯一视觉契约（AGENTS.md 条款不变）。
> 原型来源：用户提供的静态样式稿（knowledge-workbench-preview.html，未入仓——其功能
> 设计提取见 docs/e4-workbench/reference-analysis.md，视觉 token 以本文件为唯一权威转录）。
>
> **适用范围**：产品 Web 全部页面（服务端渲染族）。marketing 站（site/）暂不切换，
> 待用户另行裁决（E5 D33）。

## 0. 总体气质

冷静、致密、工具感的企业工作台：灰蓝画布上白色表面卡承载内容，单一蓝 accent 只给
主行动，信息密度高（小字号、紧凑行高、表格为主），一切装饰让位于可扫读性。
**不是** v1 的暖色编辑杂志风——不再有米色画布、珊瑚、衬线大标题。

## 1. Color Tokens（唯一权威值；oklch 原样转录自原型）

### 表面
| token | 值 | 用途 |
|---|---|---|
| `--page` | `oklch(0.985 0.001 286.376)` | 页面/主内容底 |
| `--canvas` | `oklch(0.961 0.002 247.84)` | 侧栏底、分区带 |
| `--surface` | `oklch(1 0 0)` | 卡片、控件、表格底（纯白） |
| `--inset` | `oklch(0.979 0.002 247.839)` | 表头底、表尾条、内嵌条 |
| `--hover` | `oklch(0.97 0.002 247.839)` | 行/条目悬停 |
| `--line` | `oklch(0.946 0.003 264.542)` | 常规 1px 分隔 |
| `--line-strong` | `oklch(0.912 0.005 258.326)` | 控件描边 |

### 文字
| token | 值 | 用途 |
|---|---|---|
| `--ink` | `oklch(0.247 0.006 258.361)` | 标题与主文字 |
| `--ink2` | `oklch(0.506 0.01 264.477)` | 次要正文、控件文字 |
| `--ink3` | `oklch(0.695 0.009 264.505)` | 辅助说明、占位、时间戳 |

### Accent（蓝——主行动唯一色）
| token | 值 | 用途 |
|---|---|---|
| `--accent` | `oklch(0.626 0.205 254.947)` | 主按钮底、链接强调、选中态 |
| `--accent-ink` | `oklch(0.556 0.187 255.617)` | accent 上的文字/深强调文字 |
| `--tint` | `oklch(0.96 0.019 252.878)` | accent 淡底（选中行、图标片、导航当前项） |

### 语义
| token | 值 | 用途 |
|---|---|---|
| `--green` | `oklch(0.603 0.155 150.883)` | 成功/已发布状态点与文字 |
| `--green-tint` | `oklch(0.958 0.017 159.118)` | 成功淡底 |
| `--orange` | `oklch(0.689 0.179 49.902)` | 草稿/警示图形 |
| `--orange-ink` | `oklch(0.47 0.13 49.902)` | 警示文字 |
| `--orange-tint` | `oklch(0.964 0.021 67.581)` | 警示淡底 |
| `--error` | `#c64545` | 校验错误文字（v1 值保留——原型未定义，语义沿用） |

### 图标片装饰色（库卡/统计卡图标底的四色变奏；仅限图标片）
sand `#f7f1e7`/`#96713b` · lilac `#f0edff`/`#6c5bb0` · teal `#e8f6f3`/`#3e8f80` ·
accent 变奏=`--tint`/`--accent`。**不得**用于其他表面。

### 品牌标记
26px 圆角 8px 方片，`linear-gradient(145deg,#1677ff,#53b6ff)` 渐变底、白色
spike-mark 字标（Notegit 身份保留，容器形态随原型 brand-mark）。

### 代码/diff 深色面（功能性保留）
代码窗与 diff 视图保留深色面：底 `#23272e`（中性深灰蓝，替代 v1 暖黑），
diff 增行 `#8fd6a3`/删行 `#eda7a7` 语义色沿用。

## 2. Typography

- 字族：`Inter, -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif`（全站唯一字族——**无衬线 display**；代码块 JetBrains Mono 沿用）。
- 基准：`14px / 1.5`；数字列 `font-variant-numeric: tabular-nums`。
- 层级（尺寸/字距取原型值）：

| 级 | 规格 | 用途 |
|---|---|---|
| h1 | 21px / 650 / −0.035em | 页标题 |
| h2/区块头 | 13.5px / 600 / −0.01em | 区块标题（附 `--ink3` 11px 副题） |
| 卡片标题 | 12.5px / 600 | 库卡/统计标签 |
| 表格正文 | 11.5px / 550 行内强调、400 常规 | 表格/列表 |
| 辅助 | 10–11px / `--ink3` | 元数据、时间戳、徽章 |
| 按钮文字 | 12.5px / 550 | 按钮 |

- v1 的衬线 display、负大字距、粗字重排版全部废止。

## 3. Radius / Shadow / Spacing

- 圆角：chip 6px（`--r-chip`）· 控件/输入 8px（`--r-control`）· 卡片 10px（`--r-card`）·
  整窗/弹层 14px（`--r-window`）· 主按钮=**胶囊 999px** · 徽章/标签=胶囊。
- 阴影（唯一值）：`--shadow: 0 1px 2px rgba(31,33,36,.04), 0 8px 24px rgba(31,33,36,.05)`
  ——只上在 surface 卡与浮层；平面区块（侧栏、表头、内嵌条）零阴影、靠 `--line` 分隔。
- 间距节奏：区块间 19–22px；卡内 13–15px；工具条与区块头下 8–10px。紧凑制
  （v1 的 32px 大卡垫与 96px section 节奏废止）。

## 4. 布局骨架

- 顶栏 56px：品牌方片＋字标（650 字重、−0.025em）＋分隔线＋工作区名；右侧账户
  （28px 圆章 `#e9f3ff` 底 accent-ink 字）与主 CTA。
- 侧栏 224px（≤680px 收 58px 图标条）：底 `--canvas`、右缘 `--line`；分区标签
  10.5px/600/`--ink3`/字距 .07em；导航项 36px 高、圆角 `--r-control`、图标 17px +
  文字 13px/500；当前项=`--tint` 底 + `--accent-ink` 文字（**无 coral**）。
- 内容区：max-width 1220px 居中，padding 27px 34px 32px。
- 断点：≤1020px（侧栏 190px、隐藏次要表格列）、≤680px（侧栏图标条、隐藏次级列、
  无横向滚动）；表格 <768px 横滚兜底保留。
- 数据表统一以 `.table-scroll` 横滚容器包裹（S21-T1 / D43）：容器
  `overflow-x: auto`、表格 `min-width: max-content`——列按内容定宽、不压缩折行，
  窄屏（390px）在卡内横滚、视口不溢出。
- 统计卡（stat-card）值与标签按整词换行、禁止逐字竖排（S21-T1 / D43）：≤680px
  三卡单列堆叠，卡内文本 `min-width: 0` 防长值撑破。

## 5. 组件规范（对既有类名的落位）

| 组件 | 规范 |
|---|---|
| 主按钮 | 40px 高、胶囊、`--accent` 底白字、内高光 `inset 0 1px 0 rgba(255,255,255,.14)` |
| 次按钮/小操作 | 27–40px、`--surface` 底 `--line` 描边、`--r-control`/7px、`--ink2` 字 |
| 输入/搜索框 | 40px、`--surface` 底 `--line-strong` 描边、内阴影 `inset 0 1px 2px rgba(31,33,36,.03)`；⌘K 角标=10px `--line` 描边小片 |
| 统计卡 | `--surface` 底 `--r-card` + `--shadow`；左 34px 图标片（tint/green-tint/orange-tint 三变奏）+ 标签 11.5px `--ink2` + 值 17px/620/tabular |
| 库卡 | `--r-card` + `--shadow`、min-height 114px；图标片 30px 四色变奏；标题 12.5px/600；底部两行 10.5px `--ink3`/`--ink2` 计数 |
| 文档表 | 表头 10px/550 `--ink3` 于 `--inset` 底；行 hover=`--hover`；文件图标片 29×32 圆角 6px（MD 徽标）；标签 chips=9.5px 胶囊 `--inset` 底 `--ink2` 字 |
| 状态点 | 6px 圆点 + 10px 文字：已发布=`--green`、草稿/警示=`--orange-ink` |
| 表尾条 | `--inset` 底 10px `--ink3` 声明文字 |
| 页脚 | 浅色（`--page` 底、上缘 `--line`、10–11px `--ink3`）——v1 深色页脚废止 |
| 登录页 | `--canvas` 底居中白卡（`--r-window` + 大一级阴影） |

## 6. 不变量（跨版本不变）

- 插值唯一通道服务端 HTML 转义；结构由服务端模板生成——样式切换零行为变化。
- 单 accent 纪律：蓝只用于主 CTA/链接强调/选中态；图标片四色仅限图标底。
- 不引入本表之外的新表面色/新字族；修订本文件与修订契约同权（先文档后代码）。
