# Node AI Development Tool

> **节点式 AI 开发工作台 —— 拖、拉、交付。**
> 把"AI 编程"变成一张可视化画布:从一句话需求,到生图、写代码、审查与测试、打包 `.exe` / 网页应用 / Android APK / Godot 游戏 —— **全部在一张画布上完成**。

[English](./README.md) · [简体中文](./README.zh-CN.md)

---

## 演示(2 分钟操作实录)

真实应用内录制 —— 画布、节点、每个节点的 AI/agent 徽标、生图工作区与模型设置:

<video src="screenshots/demo-walkthrough.mp4" controls="controls" style="max-width: 100%; border-radius: 8px;"></video>

---

## 这是什么?

**Node AI Development Tool** 把复杂的 AI 开发拆成一张节点图。每个节点是 AI 的一个动作 —— 项目 / 功能 / 审查 / 测试 / 出图 / 视频理解 / 打包 / 质量闸门……连线决定数据流向,一键运行整条流水线,实时看进度。

底层逻辑与 **ComfyUI** 同构 —— 但 ComfyUI 只做图,这里交付**软件、应用、游戏**:Windows `.exe`、静态网页应用、Android `.apk`、Godot 游戏项目。

两个独立工作区(页面)并排存在:

| 工作区 | 作用 |
| --- | --- |
| **软件制作** | 应用开发流水线:项目 → 功能 → 审查 → 测试 → 输出,完全节点式的编程画布 |
| **生图** | ComfyUI 式生图工作流:正向提示词 / 负向提示词 / 采样出图 / 图片输出,完全节点式的生图画布 |
| **交接节点**(两侧都有) | 把生图工作区产出的图片收集成素材清单,交给软件节点 —— **生图与软件配合内建** |

## 真实界面截图(v0.6.6)

**软件制作主画布 —— 三节点的真实工作流:**

![软件制作画布,3 个节点](screenshots/01-software-canvas.png)

**每个节点卡片都显示自己的 AI agent + 模型徽标**(点选节点后右侧面板同样显示,且可单独更换):

![每个节点的 agent 与模型徽标 + 右侧面板](screenshots/02-inspector-agent-model.png)

**添加节点菜单**(可滚动,全部节点类型都能点到):

![添加节点菜单](screenshots/03-add-node-menu.png)

**节点配置面板**(每个节点单独的 agent / 提示词 / 项目文件夹 / 参数):

![节点配置面板](screenshots/04-node-config.png)

**生图工作区** —— ComfyUI 式独立页面(正向 / 负向提示词 → 采样出图 → 输出):

![生图工作区](screenshots/05-image-workspace.png)

**模型服务与设置**(API 服务商、一键探测自动选模型、本地模型):

![设置 — 模型服务](screenshots/06-settings.png)

## 示例产物:一整套像素地牢素材

由**本地图像模型**在生图工作区直出的一整套游戏素材(场景 / 英雄 / 幽灵 / 史莱姆 / 骷髅 / 物品 / UI),再经交接节点嵌入软件应用:

| 场景 | 英雄 | 幽灵 |
| --- | --- | --- |
| ![地牢场景](showcase/dungeon-scene.png) | ![地牢英雄](showcase/dungeon-hero.png) | ![地牢幽灵](showcase/dungeon-ghost.png) |

| 史莱姆 | 骷髅 | 物品 | UI |
| --- | --- | --- | --- |
| ![地牢史莱姆](showcase/dungeon-slime.png) | ![地牢骷髅](showcase/dungeon-skeleton.png) | ![地牢物品](showcase/dungeon-items.png) | ![地牢UI](showcase/dungeon-ui.png) |

下面这张是本地模型(`anything-v5` checkpoint,未启动任何 SD WebUI 服务)直出的另一套完整素材示例:

![本地模型直出的像素地牢素材](screenshots/dungeon-samples.png)

## 核心能力

| 能力 | 说明 |
| --- | --- |
| **节点画布** | 拖拽搭建开发流水线:串行 / 并行 / 整合 / 子图,运行时可视化进度 |
| **双工作区** | **软件制作**与**生图**两个独立页面,每个项目各自的画布 |
| **每个节点独立的 AI 与 agent** | **每张节点卡片都显示自己跑在哪个 agent + 模型上**,每个节点都可以单独配置不同的 AI / agent(默认继承全局设置) |
| 多模型接入 | API 服务商一键探测自动选模型(火山方舟 / OpenAI / Anthropic / Ollama / LM Studio / 本地 CLI agent);本地开源大模型零 Key 接入 |
| 本地模型直出生图 | 图像节点用 diffusers 直接加载本地 checkpoint(如 Anything V5)出图,**不依赖 SD WebUI 服务、不需要开任何窗口** —— SD WebUI 可以卸载 |
| 交接节点 | 把图像节点产出的图片收集成素材清单,直接交接给下游软件节点 |
| 视频理解 | 视频节点抽帧 + 视觉模型分析,把"视频内容"变成文字交给下游改软件 |
| **多平台打包** | 输出节点一键产出 **Windows exe** / **Web 静态站点**(PWA) / **Android apk**(Capacitor + Gradle,无 SDK 时自动降级为 Web 包) / **Godot 游戏 zip** —— 一条流水线四种产物 |
| 反馈闭环 | **运行 → 报错 → 修复 → 再运行**:闸门节点(退出码 / 文本包含 / 正则校验)、自动修复(错误自动喂回 LLM)、8 个确定性工程节点(零 LLM token) |
| **工程化 agent 编排** | **智能体(循环)节点**同一角色多轮迭代(含完成标志自动收尾);**路由节点**让 LLM 只激活一条出边分支、其余自动跳过 —— 真正的条件分支 |
| **图表(可视化)节点** | 上游 JSON 数据经 ECharts SSR 渲染成 SVG(柱 / 折 / 饼 / 散点 / 漏斗),随打包交付 |
| **开源技能市场** | 粘贴任意公开 GitHub / Gitee 技能仓库 URL 一键安装(域名白名单 + 防 zip slip + 危险命令扫描),附精选官方技能包(anthropics/skills、obra/superpowers) |
| 工作流导入导出 | 任意画布存成 `.json` 工作流文件、随时恢复(ComfyUI 式),方便分享复用 |
| 内置模板 | 一键搭流水线:桌面应用(exe) / 手机网页应用 / 像素小游戏 / 完整生图工作流 / **agent 编排模板** |
| 游戏制作 | 游戏节点让 AI 产出完整 Godot 项目(zip 交付) |
| MCP Server | Claude / Cursor 可通过 `npm run mcp` 无头编排工作流 |
| 质量闸门 | 审查(只读评审) / 测试(跑命令) / 文档 节点,软件质量闭环 |

## 一条完整流水线

```
[项目] → [功能(生成 Electron 应用)] → [审查] → [测试] → [闸门] → [输出(exe)]
                 ↑
[图像节点(本地模型直出 UI/图标)] → [交接节点(素材清单)]
```

AI 先按需求生成应用代码,同时本地模型直出界面素材,交接节点把素材路径交给软件节点,最后输出节点直接打包成可执行 exe。

## 完整节点清单

**软件制作工作区** —— 每个节点都可以单独指定自己的 AI agent + 模型:

- **项目** — 项目文件夹 + 一句话需求(入口)。
- **功能** — 由 agent 生成 / 修改代码(串行或并行模式)。
- **审查** — AI 审查员只读评审代码。
- **测试** — 在项目里跑命令 / 测试套件。
- **闸门** — 确定性校验点:退出码模式或文本(包含 / 不包含 / 正则)模式;失败则拦住整条下游。
- **输出** — 打包成 `.exe` / Web / `.apk` / Godot zip。
- **图像** — 生成图片(本地模型直出或 API)。
- **交接** — 把图像节点产出收集成素材清单,交给软件节点。
- **游戏** — 生成完整 Godot 项目。
- **视频** — 抽帧 + 视觉分析 → 文字总结。
- **文档** — 根据上游产出写文档。
- **智能体(循环)** — 一个角色多轮迭代,含完成标志自动收尾。
- **路由** — LLM 决策点:只激活一条出边分支。
- **图表** — JSON 数据 → ECharts SSR → SVG。
- **Python** — 在项目目录跑任意 Python 脚本(子进程、目录锁定、零 token)。
- **子图** — 把节点分组为可复用子流程。
- **整合** — 合并并行分支。
- **工程节点(v0.6.6,确定性,零 token):** `lint`(tsc/任意命令)· `git`(status/commit/log/branch)· `deps`(依赖报告与缺失检测)· `context`(项目记忆 → `context.md`)· `contract`(提取 API 路由 → `openapi.yaml`)· `cost`(运行摘要与 token 估算)· `diff`(项目现状快照)· `deploy`(一键部署目录,生成 vercel.json / netlify.toml)。

**生图工作区** —— ComfyUI 式完整工作流:

- **正向提示词** — 想要什么(带预设与强度)。
- **负向提示词** — 不要什么。
- **采样出图** — 模型 + 参数(本地 checkpoint / API / SD WebUI 兼容本地命令)。
- **图片输出** — 落盘 `assets/generated/`,也可接**交接**节点。
- **交接** — 把图片送到软件制作工作区。

## 反馈闭环与工程化工具

从"单向流水线"变成 **运行 → 报错 → 修复 → 再运行**:

- **闸门节点** — 链上的校验点:`exit` 模式跑命令看退出码;`text` 模式校验上游产出(包含 / 不包含 / 正则)。不通过 = 节点失败,下游全部拦住。
- **自动修复** — 在 feature/agent 节点上打开 `autofix`,下游闸门/测试失败时,错误自动喂回 LLM 并重跑该子链(受 `maxRounds` 上限约束)。
- **节点级错误可视化** — 出错的节点直接在画布上显示错误摘要,一键 `fix` 按钮自动创建关联的修复节点。
- **增量执行** — 输入未变的部分复用上次运行结果(输入哈希缓存,零成本重跑)。
- **撤销 / 重做** — 每个画布编辑都可撤销。

## agent 编排与可视化(v0.6.x)

**智能体(循环)节点** — 一个角色多轮迭代:首轮走正常提示词模板;后续轮把上一轮产出续聊,直到回复含完成标志(`doneHint`)或达到最大轮次(maxRounds)。适合"规划 → 迭代 → 自检"。

**路由节点** — LLM 决策点:看完上游成果后从出边里选一条(按编号或标签),选中的分支执行、其余自动跳过。拉 2 条以上出边、可给每条线起标签(routes),条件分支就出现了。

**图表节点** — 数据模板里写 JSON(或接上游产出 `{{input}}`),选图表类型(柱/折/饼/散点/漏斗),ECharts SSR 渲染成 SVG 落盘 `assets/generated/charts/<标题>-<时间戳>/chart.svg`。在文档里引用这个相对路径,打包时会随应用一起交付。

试试内置 **agent-orchestration** 模板:项目 → 规划智能体 → 两条并行执行支路 → 整合 → 审查智能体 → 输出 exe。

## 快速开始

```bash
npm install          # 安装依赖(electron 已随包缓存)
npm run dev          # 启动应用(开发模式)
```

1. 拖入「项目」节点,填写项目文件夹与一句话需求;
2. 配置模型:设置 → 模型服务 → 填入 API Key 或启动本地模型(Ollama / LM Studio)。**一键探测自动选模型** —— 粘贴 Key 点探测,第一个有响应的模型自动选中(不用再在十几个版本里猜);
3. 如需要,给每个节点单独指定自己的 AI agent + 模型(默认继承全局设置);
4. 搭好节点图 → 点运行 → 看节点逐个执行、产出落盘。

### 功能节点的推荐提示词(生成 Electron exe)

```
生成一个可直接打包成 Windows exe 的 Electron 应用:
package.json(main 指向 main.js, build.win.target 配 portable) + main.js + index.html,
界面用相对路径引用项目 assets/ 下的图片素材。
```

## 本地模型 —— 零 API Key

**本地大语言模型:** 添加一个指向 Ollama / LM Studio 的服务商(`http://localhost:11434` 等)—— 探测会自动列出本地模型并选中能用的那个。CLI agent(如 Claude Code)也会被自动探测到,可让每个节点使用。

**本地生图(不走 SD 服务):** 图像节点出图方式选「本地命令」,命令指向 `scripts/txt2img.py`:

```bash
python scripts/txt2img.py \
  --prompt-file prompt.txt --out ./output \
  --n 1 --size 512x512 --seed 42 --negative "blurry, low quality"
```

- 模型:环境变量 `CHUSIZ_SD_CHECKPOINT` 指向任意 `.safetensors` 主模型(默认 `models/anything-v5.safetensors`);
- 负提示词:也可经环境变量 `CANVAS_NEGATIVE_PROMPT` 传入;
- 因为图像节点直接用 diffusers 出图,**SD WebUI 不再需要 —— 可以卸载**;
- 旧式 SD WebUI 整合包的一键启停(兼容保留):`npm run sd:status | sd:start | sd:stop`。

## 打包

```bash
npm run dist         # 打包安装程序 → dist/node-ai-development-tool-0.6.6-setup.exe
npm run icon         # 重新生成应用图标
```

**输出**节点可产出:Windows `.exe`(直接打包)/ Web 静态站点(PWA 就绪的 zip 或目录)/ Android `.apk`(有 SDK 时走 Capacitor + Gradle,否则自动降级为 Web 包)/ Godot 游戏 zip。

## 开源技能市场

技能抽屉新增「市场」页签:

- 粘贴任意公开仓库 URL —— `https://github.com/owner/repo` 或 `…/tree/main/<子目录>`(GitHub / Gitee)—— 点安装;
- 精选技能包:**anthropics/skills**(官方办公/检索/研究全家桶)与 **obra/superpowers**(社区全能技能集),一键整仓装齐;
- 安全三道关:域名白名单 → 防路径穿越(zip slip)→ 危险命令扫描(`rm -rf`、`curl | sh` 等)提示,先警告再落盘;
- 多技能仓库一次装齐所有技能。

## MCP Server(无头编排)

`npm run mcp` 启动 JSON-RPC-over-stdio 服务(`list_nodes` / `run_workflow` / `get_node_result`),与 GUI 共用同一套调度器 —— Claude、Cursor 或任何 MCP 客户端都可以编排你的工作流。

## 测试

```bash
npm run e2e          # 全量回归(1277 通过 / 10 跳过 / 0 失败:LLM 探测、打包、出图、视频、交接、agent 编排、图表、技能市场)
npm run typecheck:node && npm run typecheck:web
```

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `ARK_API_KEY` | 火山方舟 API Key(验证脚本) |
| `CHUSIZ_SD_CHECKPOINT` | 本地生图主模型(.safetensors 路径) |
| `CHUSIZ_SD_PYTHON` | 提取的 python 运行时(直出模式) |
| `CHUSIZ_SD_WEBUI_ROOT` | SD WebUI 整合包探测根目录 |
| `CANVAS_NEGATIVE_PROMPT` | 生图默认负提示词 |

## 目录结构

```
src/
  main/           # 主进程:工作流调度、内置动作执行器(打包/出图/测试/视频/交接)、本地服务
  shared/         # 节点注册表、画布图、工作流 spec(类型唯一真相源)
  renderer/       # React 画布界面:节点组件、配置面板、运行面板
scripts/
  e2e.ts          # 全量回归
  txt2img.py      # 本地模型直出(diffusers 加载 checkpoint)
  sd-local.ts     # 本地 SD 服务 status/start/stop
docs/
  ARCHITECTURE.md # 架构与插件设计
  PLUGIN.md       # 节点插件开发指南
  ROADMAP.md      # 工程可信 → 平台能力 → 生态
```

## 路线图

完整路线图见 [ROADMAP.md](./docs/ROADMAP.md)(工程可信 → 平台能力 → 生态)。重点方向:节点插件 SDK、人工审批 / 策略护栏 / 密钥保险库 / 回滚节点、预算与成本控制、并行智能体投票、发布与部署节点、"AI 软件工厂"质量闭环。

## 开源协议

[MIT](./LICENSE) —— 随意使用、修改、分发,保留版权声明即可。

## 贡献

欢迎一切形式的贡献:提 Issue、修 Bug、加节点类型、补文档。见 [CONTRIBUTING.md](./CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。

---

## 作者的话

> 这个项目始于一个个人实验:能否用一张节点画布让 AI 编程**看得见**——并且真正交付软件,而不只是演示?它已经长成了一个人无法独自完成的样子。
>
> **这个项目等待有缘人(或有缘的团队)继续完善它。** 每一个 issue、PR、新节点、新模板、新翻译,都在把它推进一步。如果你也曾想过"AI 编程工具就该长这样"——这里就是起点。路线图公开、代码 MIT、大门敞开。
>
> This project started as a personal experiment: can a node canvas make AI programming *visible* — and can it ship real software, not just demos? It has grown far beyond what one person can finish alone.
>
> **This project is waiting for the right person (or people) to take it further.** Every issue, PR, new node type, template or translation moves it forward. If you've ever thought "AI coding tools should work more like this" — this is the place. The roadmap is open, the code is MIT, and the door is wide open.
>
> —— chusiz(作者)

## 更新要点

- **v0.6.6(2026-10-08):** 工程化节点群(lint / git / deps / context / contract / cost / diff / deploy)+ UI 收尾 —— E 键剪断连线、顶栏图标化、每张节点卡片显示自己的 AI/agent 徽标。
- **v0.6.5:** 反馈闭环 —— 闸门节点 + 自动修复 + 节点级错误可视化 + 增量执行。
- **v0.6.4:** 应用内产物预览、打包前安全审计、MCP Server、Python 节点、启动懒加载、治理文档。
- **v0.6.3:** e2e 跨平台化、3 个黄金工作流模板、路线图文档。
- **更早的 v0.6.x:** agent 编排(循环 / 路由)、图表节点、技能市场、双工作区、本地生图、交接节点、多平台打包。
