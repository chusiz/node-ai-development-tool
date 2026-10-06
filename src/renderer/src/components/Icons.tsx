import type { JSX, ReactNode, SVGProps } from 'react'
import type { NodeIconName } from '../../../shared/nodeRegistry'

/**
 * 全应用唯一的图标集 —— 内联 SVG,**不引第三方图标包,也不再用 emoji**。
 *
 * ## 为什么把 emoji 全换掉
 *
 * 之前节点角标、添加菜单用的是 emoji(📁 / ↳ / ⑂ / ⇄ / 📦 / 🖼 / ✂)。
 * 三个问题:
 *   1. **字形不受控**:emoji 由系统字体渲染,Windows 是彩色卡通图,换台机器
 *      可能是另一套,Linux 上甚至掉成豆腐块 —— 同一张图在不同机器上长得不一样;
 *   2. **不会跟着主题走**:emoji 自带颜色,`color` 对它无效,于是角标文字
 *      已经按类型变色了,旁边那个小图形还杵着自己的调色板;
 *   3. **排版不可控**:emoji 的宽高/基线随字体变化,与 11px 的文字对齐时
 *      一行里几个角标的高度会飘。
 *
 * 换成内联 SVG 后这三件事全归 CSS 管:`stroke="currentColor"` 让图标与文字
 * 同色(于是 `kind-review` 之类改颜色时图标自动跟上),`width/height` 精确对齐,
 * 且渲染结果与机器无关。
 *
 * ## 为什么用 `stroke` 描边而不是填充路径
 *
 * 描边图标在 11–16px 这个尺寸下**笔画干净**;填充路径缩小到这个尺寸,
 * 细枝末节会糊成一团。统一 1.5 的描边宽度 + 圆头圆角,是这套图标能
 * 小到 11px(节点角标)又大到 18px(空态/弹窗)都可读的原因。
 *
 * ## 尺寸约定
 *
 * `viewBox="0 0 16 16"` 是所有图标的坐标基准;调用方只传 `size`(px),
 * 不传的话由 CSS 的 `font-size` 无关 —— 所以每处都显式给 size,别指望继承。
 */

/** 全部可用图标名。节点类型图标来自注册表(`NodeIconName`),其余是本组件专属的界面图标 */
export type IconName =
  | NodeIconName
  | 'scissors'
  | 'play'
  | 'close'
  | 'plus'
  | 'search'
  | 'keyboard'
  | 'settings'
  | 'skill'
  | 'alert'
  | 'info'
  | 'check'
  | 'logo'
  | 'mouse'
  | 'terminal'
  | 'clock'
  | 'stop'
  | 'dot'
  | 'minimize'
  | 'maximize'
  | 'restore'

/**
 * 图标表。每个 key 是一段 `<path>` / `<circle>` 之类的几何描述。
 *
 * ⚠️ 需要实心的地方(▶ 播放三角、齿轮中心点)**必须在自己的元素上**写
 * `fill="currentColor"`,不能改 `<svg>` 上的 `fill="none"` —— 那是所有图标的
 * 公共默认值,改它会让整套图标变成实心块。
 */
const ICONS: Record<IconName, ReactNode> = {
  // ---------- 节点类型 ----------
  /** 项目:文件夹 */
  project: (
    <path d="M1.8 4.6A1.6 1.6 0 0 1 3.4 3h2.3c.42 0 .83.17 1.13.47L7.9 4.6h4.7a1.6 1.6 0 0 1 1.6 1.6v5.2a1.6 1.6 0 0 1-1.6 1.6H3.4a1.6 1.6 0 0 1-1.6-1.6z" />
  ),
  /** 串行:三层叠加(在上游成果上叠加) */
  serial: (
    <>
      <path d="M8 1.9 14.2 5 8 8.1 1.8 5z" />
      <path d="M1.8 8 8 11.1 14.2 8" />
      <path d="M1.8 11 8 14.1 14.2 11" />
    </>
  ),
  /** 并行:一条干线分成两支 */
  parallel: (
    <>
      <path d="M1.8 8h3.4" />
      <path d="M5.2 8 9 4.4h3.2" />
      <path d="M5.2 8 9 11.6h3.2" />
      <path d="M10.6 2.8 12.4 4.4 10.6 6" />
      <path d="M10.6 10 12.4 11.6 10.6 13.2" />
    </>
  ),
  /** 整合:两支汇回一路 */
  merge: (
    <>
      <path d="M1.8 4.4h3.4L8.6 8" />
      <path d="M1.8 11.6h3.4L8.6 8" />
      <path d="M8.6 8h5.6" />
      <path d="M12.4 5.9 14.2 8 12.4 10.1" />
    </>
  ),
  /** 输出:打包箱 */
  output: (
    <>
      <path d="M8 1.9 14.2 5v6L8 14.1 1.8 11V5z" />
      <path d="M1.8 5 8 8.1 14.2 5" />
      <path d="M8 8.1v6" />
    </>
  ),
  /** 图像:相框 + 山 + 太阳 */
  image: (
    <>
      <rect x="1.8" y="3.4" width="12.4" height="9.2" rx="1.6" />
      <circle cx="5.4" cy="6.6" r="1.05" />
      <path d="M2.4 11.4 6 8.5l2.4 1.9 2-1.6 3.2 2.6" />
    </>
  ),
  /** 审查:盾牌 + 勾(只读评审) */
  review: (
    <>
      <path d="M8 1.8 13.2 3.7v4.5c0 3.1-2.1 5.2-5.2 6-3.1-.8-5.2-2.9-5.2-6V3.7z" />
      <path d="M5.7 8.1 7.3 9.7l3.1-3.3" />
    </>
  ),
  /** 测试:烧瓶 */
  test: (
    <>
      <path d="M6.4 2.4v3.9L3.1 11.6a1.45 1.45 0 0 0 1.25 2.2h7.3a1.45 1.45 0 0 0 1.25-2.2L9.6 6.3V2.4" />
      <path d="M5.4 2.4h5.2" />
      <path d="M4.5 9.8h7" />
    </>
  ),
  /** 文档:文本文件 */
  doc: (
    <>
      <path d="M4.1 2.2h4.8L13 6.3v7.2a1.3 1.3 0 0 1-1.3 1.3H4.1a1.3 1.3 0 0 1-1.3-1.3V3.5a1.3 1.3 0 0 1 1.3-1.3z" />
      <path d="M8.9 2.2v4.1H13" />
      <path d="M5.6 9h4.8" />
      <path d="M5.6 11.4h3.2" />
    </>
  ),
  /** 子图:一段被框起来的节点图(左进右出) */
  subgraph: (
    <>
      <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1.6" />
      <path d="M2.6 5.8H1" />
      <path d="M14.2 5.8h-1.6" />
      <circle cx="5.9" cy="5.8" r="1.1" />
      <circle cx="10.1" cy="10.1" r="1.1" />
      <path d="M7 5.8h1.9a1.3 1.3 0 0 1 1.3 1.3v1.9" />
    </>
  ),
  /** 游戏:手柄(Godot 游戏制作节点) */
  game: (
    <>
      <path d="M6.2 5.6 3.4 8.4a2 2 0 0 0 0 2.8l.6.6a2 2 0 0 0 2.8 0l1.2-1.2h0l1.2 1.2a2 2 0 0 0 2.8 0l.6-.6a2 2 0 0 0 0-2.8L9.8 5.6a1.7 1.7 0 0 0-3.6 0z" />
      <circle cx="5.4" cy="8.6" r="0.75" />
      <circle cx="8.6" cy="8.6" r="0.75" />
      <path d="M6.3 7.7v1.8M5.4 8.6h1.8" />
      <circle cx="11.6" cy="6.6" r="0.55" />
      <circle cx="12.6" cy="8" r="0.55" />
    </>
  ),
  /** 视频:播放器 + 播放键(视频理解节点) */
  video: (
    <>
      <rect x="1.8" y="3.4" width="12.4" height="9.2" rx="1.6" />
      <path d="M6.4 6.4v3.2L9.4 8z" fill="currentColor" stroke="none" />
    </>
  ),
  /** 交接:双向箭头(把素材交接给下游软件节点) */
  handoff: (
    <>
      <path d="M3.2 6.6h7.6" />
      <path d="M8.2 4.4 10.8 6.6 8.2 8.8" />
      <path d="M12.8 9.4H5.2" />
      <path d="M7.8 7.2 5.2 9.4l2.6 2.2" />
    </>
  ),
  /** 正向提示词:文字气泡 + 加号(生图工作区) */
  prompt: (
    <>
      <rect x="2" y="3.2" width="12" height="8.4" rx="1.8" />
      <path d="M5.2 6.4h5.6M5.2 8.8h3.4" />
      <path d="M12.4 10.6v2.6M11.1 11.9h2.6" />
    </>
  ),
  /** 采样出图:相机光圈(采样器) */
  sampler: (
    <>
      <circle cx="8" cy="8" r="5.2" />
      <path d="M8 2.8v3M8 10.2v3M2.8 8h3M10.2 8h3" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  /** 图片输出:输出箭 + 图片框(生图终点) */
  image_output: (
    <>
      <rect x="3.2" y="6.6" width="7.6" height="6" rx="1.3" />
      <circle cx="5.8" cy="8.4" r="0.7" />
      <path d="M3.6 12 6 10.2l1.6 1.2 1.4-1.1 2 1.7" />
      <path d="M8.4 4.2h4M10.4 2.4l2 1.8-2 1.8" />
    </>
  ),

  // ---------- v0.6.1 工程化 agent 编排 ----------
  /** 智能体:大脑 + 迭代环(带循环的 agent) */
  agent: (
    <>
      <circle cx="8" cy="6.6" r="3.6" />
      <path d="M3.6 6.6 1.4 6.6M14.6 6.6H12.4M6 12.6l-2.6 2M10 12.6l2.6 2" />
      <path d="M8 13.4v2" strokeDasharray="1.4 1.1" />
    </>
  ),
  /** 路由:分叉箭头(LLM 选一条分支) */
  router: (
    <>
      <path d="M1.8 8h4.4" />
      <path d="M6.2 4.2 8.6 8l-2.4 3.8" />
      <path d="M8.6 8H11M13.2 5.6l1.8 2.4-1.8 2.4" />
    </>
  ),
  /** 图表:柱 + 折线(可视化图形节点) */
  chart: (
    <>
      <path d="M3 13.5V2.6M3 13.5h11.4" />
      <path d="M4.6 11.4v-3M7.6 11.4V6M10.6 11.4V4.2M13.2 11.4V7.4" />
      <path d="M4.6 5.2l3 -2.2 3 3 2.6-2" />
    </>
  ),

  // ---------- 界面图标 ----------
  /** 剪刀:切断连线 */
  scissors: (
    <>
      <circle cx="3.6" cy="12.4" r="1.9" />
      <circle cx="3.6" cy="3.6" r="1.9" />
      <path d="M5.1 11.3 13.4 3.2" />
      <path d="M5.1 4.7 13.4 12.8" />
    </>
  ),
  /** 播放:实心三角 */
  play: (
    <path
      d="M5.4 3.5 12.4 8l-7 4.5z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  ),
  close: (
    <>
      <path d="M4.2 4.2 11.8 11.8" />
      <path d="M11.8 4.2 4.2 11.8" />
    </>
  ),
  /** 无边框窗口:最小化 —— 一条短横线 */
  minimize: <path d="M3.4 8h9.2" />,
  /** 无边框窗口:最大化(未最大化时显示)—— 一个方框 */
  maximize: <rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.2" />,
  /** 无边框窗口:还原(已最大化时显示)—— 两个叠放的小框 */
  restore: (
    <>
      <rect x="4.2" y="6" width="7.4" height="6" rx="1" />
      <path d="M6 6V4.9A1.5 1.5 0 0 1 7.5 3.4h4.1a1.5 1.5 0 0 1 1.5 1.5V9a1.5 1.5 0 0 1-1.5 1.5H10.6" />
    </>
  ),
  plus: (
    <>
      <path d="M8 3.4v9.2" />
      <path d="M3.4 8h9.2" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.1 10.1 13.9 13.9" />
    </>
  ),
  /** 键盘:键位格 */
  keyboard: (
    <>
      <rect x="1.6" y="4" width="12.8" height="8" rx="1.7" />
      <path d="M4.4 6.9h.01" />
      <path d="M6.9 6.9h.01" />
      <path d="M9.4 6.9h.01" />
      <path d="M11.9 6.9h.01" />
      <path d="M5.6 9.7h4.8" />
    </>
  ),
  /** 设置:三条滑轨 + 旋钮(比齿轮在小尺寸下清楚得多) */
  settings: (
    <>
      <path d="M2.4 4.4h11.2" />
      <path d="M2.4 8h11.2" />
      <path d="M2.4 11.6h11.2" />
      <circle cx="6" cy="4.4" r="1.5" />
      <circle cx="10.6" cy="8" r="1.5" />
      <circle cx="6" cy="11.6" r="1.5" />
    </>
  ),
  /** 技能:拼图块 */
  skill: (
    <path d="M6.1 2.4a1.6 1.6 0 0 1 3.2 0v.9h2.1a1 1 0 0 1 1 1v2.1h.9a1.6 1.6 0 0 1 0 3.2h-.9v2.1a1 1 0 0 1-1 1H9.3v-.9a1.6 1.6 0 0 0-3.2 0v.9H4a1 1 0 0 1-1-1V9.6h-.9a1.6 1.6 0 0 1 0-3.2H3V4.3a1 1 0 0 1 1-1h2.1z" />
  ),
  alert: (
    <>
      <path d="M8 2.4 14.5 13.4H1.5z" />
      <path d="M8 6.4v3.1" />
      <path d="M8 11.7h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.7" />
      <path d="M8 7.3v4" />
      <path d="M8 5.1h.01" />
    </>
  ),
  check: <path d="M3.3 8.4 6.4 11.5 12.7 4.9" />,
  /** 空画布的品牌标记:双层菱形 */
  logo: (
    <>
      <path d="M8 1.6 14.4 8 8 14.4 1.6 8z" />
      <path d="M8 5.3 10.7 8 8 10.7 5.3 8z" />
    </>
  ),
  /** 鼠标:滚轮矩形(快捷键表里的"鼠标操作"分组用) */
  mouse: (
    <>
      <rect x="5.4" y="2.4" width="5.2" height="11.2" rx="2.6" />
      <path d="M8 5v2.1" />
    </>
  ),
  /** 终端:测试命令 */
  terminal: (
    <>
      <rect x="1.8" y="3.4" width="12.4" height="9.2" rx="1.6" />
      <path d="M4.7 6.8 6.6 8.5l-1.9 1.7" />
      <path d="M8.4 10.4h3" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.7" />
      <path d="M8 4.6V8l2.5 1.6" />
    </>
  ),
  /** 停止:实心圆角方块(取消运行) */
  stop: (
    <rect
      x="4.3"
      y="4.3"
      width="7.4"
      height="7.4"
      rx="1.5"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.2"
    />
  ),
  /** 小圆点:用来标"有未提交的输入"这类状态,替代 ● 字符 */
  dot: <circle cx="8" cy="8" r="3.2" fill="currentColor" stroke="none" />,
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  /** 边长(px)。默认 14 —— 与正文小字同高 */
  size?: number
}

/**
 * 画一个图标。
 *
 * `aria-hidden` + `focusable="false"` 是刻意的:这些图标**永远是装饰**
 * (旁边一定有文字,或按钮自身带 `title`/`aria-label`)。让读屏软件念一遍
 * "文件夹 项目"没有意义,反而把按钮名字念重了。
 */
export function Icon({ name, size = 14, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {ICONS[name]}
    </svg>
  )
}

/** 类型角标用的图标(注册表给的 icon 名可能是 undefined —— 那种角标退回纯文字) */
export function NodeIcon({ name, size = 11 }: { name?: NodeIconName; size?: number }): JSX.Element | null {
  return name ? <Icon name={name} size={size} /> : null
}
