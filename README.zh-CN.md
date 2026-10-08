# Node AI Development Tool

> 节点式 AI 软件 / 应用 / 游戏制作工作台 —— 把"AI 编程"做成拖拽节点画布。
> 从一句话需求,到生图、写代码、打包 exe,全部在画布上完成。

[English](./README.md) | [简体中文](./README.zh-CN.md)

![双工作区:软件制作 + 生图](screenshots/ui-main.png)

把复杂的 AI 开发拆成一张节点图:每个节点是 AI 的一个动作(项目 / 功能 / 审查 / 测试 / 出图 / 视频理解 / 打包),连线决定数据流向,点运行自动执行。底层逻辑与 ComfyUI 同构 —— 但 ComfyUI 只做图,这里做**软件、应用、游戏**。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 节点画布 | 拖拽搭建开发流水线:串行 / 并行 / 整合 / 子图,运行时可视化进度 |
| 双工作区 | **软件制作**与**生图**两个独立页面:生图页是完整生图工作流(正向/负向提示词→采样出图→输出),软件页是应用开发流水线 |
| 多模型接入 | API 服务商一键探测选模型;Ollama / LM Studio 等本地开源大模型直接接入,无需 Key |
| 本地模型直出生图 | 图像节点用 diffusers 直接加载本地 checkpoint(如 Anything V5)出图,**不依赖 SD WebUI 服务、不需要开任何窗口** |
| 交接节点 | 把图像节点产出的图片收集成素材清单,直接交接给下游软件节点使用 |
| 视频理解 | 视频节点抽帧 + 视觉模型分析,把"视频内容"变成文字交给下游改软件 |
| 多平台打包 | 输出节点一键产出 **Windows exe** / **Web 静态站点**(PWA,手机浏览器即用) / **Android apk**(Capacitor + Gradle,无 SDK 时自动降级为 Web 包) / **Godot 游戏 zip** —— 一条流水线四种产物 |
| 工作流导入导出 | 任意画布可存成 `.json` 工作流文件、随时恢复(ComfyUI 式),方便分享复用 |
| 内置模板 | 一键搭流水线:桌面应用(exe) / 手机网页应用 / 像素小游戏 / 完整生图工作流 / **agent 编排模板** |
| **工程化 agent 编排** | **智能体(循环)节点**同一角色多轮迭代(输出含完成标志自动收尾);**路由节点**让 LLM 看完上游成果后只激活一条出边分支、其余自动跳过 —— 真正的条件分支 |
| **图表(可视化)节点** | 把上游 JSON 数据用 ECharts SSR 渲染成 SVG(柱/折/饼/散点/漏斗),落盘 assets/generated/charts/,随打包交付 |
| **开源技能市场** | 粘贴任意公开 GitHub / Gitee 技能仓库 URL 一键安装(域名白名单 + 防 zip slip + 危险命令扫描),附精选官方技能包(anthropics/skills、obra/superpowers) |
| 游戏制作 | 游戏节点让 AI 产出完整 Godot 项目(zip 交付) |
| 质量闸门 | 审查(只读评审) / 测试(跑命令) / 文档 节点,软件质量闭环 |

## 一条完整流水线

```
[项目] → [功能(生成 Electron 应用)] → [审查] → [测试] → [输出(exe)]
                 ↑
[图像节点(本地模型直出 UI/图标)] → [交接节点(素材清单)]
```

AI 先按需求生成应用代码,同时本地模型直出界面素材,交接节点把素材路径交给软件节点,最后输出节点直接打包成可执行 exe。

## 生图工作区(ComfyUI 式独立页面)

生图页只做一件事:**完整生图工作流** —— 正向提示词节点 / 负向提示词节点 / 采样出图节点 / 图片输出节点,配上本地模型或 API 服务,拖出来即用。

```
[正向提示词(画面描述)] ──→ [采样出图(模型+参数)] ──→ [图片输出(落盘 assets/generated/)]
[负向提示词(不要什么)] ──┘
```

![像素地牢素材示例(本地模型直出)](./screenshots/dungeon-samples.png)

上图为本地模型直出的一组像素地牢游戏素材(场景 / 人物 / 怪物 / UI / 物品),在生图工作区产出后,经交接节点嵌入软件应用。

## agent 编排与可视化(v0.6.x)

**智能体(循环)节点** —— 一个角色多轮迭代:首轮走正常提示词模板;后续轮把上一轮产出续聊,直到回复含完成标志(`doneHint`)或达到最大轮次(maxRounds)。适合"规划 → 迭代 → 自检"。

**路由节点** —— LLM 决策点:看完上游成果后从出边里选一条(按编号或标签),选中的分支执行、其余自动跳过。拉 2 条以上出边、可给每条线起标签(routes),条件分支就出现了。

**图表节点** —— 数据模板里写 JSON(或接上游产出 `{{input}}`),选图表类型(柱/折/饼/散点/漏斗),ECharts SSR 渲染成 SVG 落盘 `assets/generated/charts/<标题>-<时间戳>/chart.svg`。在文档里引用这个相对路径,打包时会随应用一起交付。

试试内置 **agent-orchestration** 模板:项目 → 规划智能体 → 两条并行执行支路 → 整合 → 审查智能体 → 输出 exe。

## 反馈闭环与工程化节点群(v0.6.5 / v0.6.6)

从"单向流水线"变成 **运行 → 报错 → 修复 → 再运行**:

- **闸门节点** —— 链上的校验点:`exit` 模式跑命令看退出码,`text` 模式校验上游产出(包含 / 不包含 / 正则)。不通过 = 节点失败,下游全部拦住。
- **自动修复** —— 在 feature/agent 节点上打开 `autofix`,下游闸门/测试失败时,错误自动喂回 LLM 并重跑该子链(受 `maxRounds` 上限约束)。
- **8 个确定性工程化节点(零 LLM token)**:
  - `lint` 静态检查(默认 `npx tsc --noEmit`,退出码判定通过/失败);
  - `git` 本地版本控制(`status` / `commit` 自动带本地身份 / `log` / `branch`,**不推送外部**);
  - `deps` 依赖管理(自动识别 npm `package.json` / pip `requirements.txt`,报告清单与缺失);
  - `context` 项目记忆(风格 / 规范 / 接口清单,落盘 `assets/generated/context.md`,下游可引用);
  - `contract` 接口契约(从上游代码提取 `app.get/post…` 路由与 `fetch` 调用 → `openapi.yaml`);
  - `cost` 运行摘要(本轮各节点状态 / 耗时 / 产出规模,估算 token 成本);
  - `diff` 现状快照(文件树与类型分布,增量修改前先看现状);
  - `deploy` 一键部署(把 Web 产物复制到 `deploy/`,生成 `vercel.json` / `netlify.toml`)。

## 开源技能市场

技能抽屉新增「市场」页签:

- 粘贴任意公开仓库 URL —— `https://github.com/owner/repo` 或 `…/tree/main/<子目录>`(GitHub / Gitee)—— 点安装;
- 精选技能包:**anthropics/skills**(官方办公/检索/研究全家桶)与 **obra/superpowers**(社区全能技能集),一键整仓装齐;
- 安全三道关:域名白名单 → 防路径穿越(zip slip)→ 危险命令扫描(rm -rf、curl | sh 等)提示,先警告再落盘;
- 多技能仓库一次装齐所有技能。

## 快速开始

```bash
npm install          # 安装依赖(electron 已随包缓存)
npm run dev          # 启动应用(开发模式)
```

1. 拖入「项目」节点,填写项目文件夹与一句话需求;
2. 配置模型:设置 → 模型服务 → 填入 API Key 或启动本地模型(Ollama / LM Studio),一键探测自动选模型;
3. 搭好节点图 → 点运行 → 看节点逐个执行、产出落盘。

## 本地生图(不走 SD 服务)

图像节点出图方式选「本地命令」,命令指向 `scripts/txt2img.py`:

```bash
python scripts/txt2img.py \
  --prompt-file prompt.txt --out ./output \
  --n 1 --size 512x512 --seed 42 --negative "blurry, low quality"
```

- 模型:环境变量 `CHUSIZ_SD_CHECKPOINT` 指向任意 `.safetensors` 主模型(默认 `models/anything-v5.safetensors`);
- 负提示词:也可经环境变量 `CANVAS_NEGATIVE_PROMPT` 传入;
- 本地服务一键启停:`npm run sd:status | sd:start | sd:stop`(探测 SD WebUI 整合包,亦可只用直出模式)。

## 打包 exe

```bash
npm run dist         # 打包安装程序 → dist/chusiz-0.1.0-setup.exe
npm run icon         # 重新生成应用图标
```

软件节点 prompt 引导(产出可直接打包的 Electron 应用):

```
生成一个可直接打包成 Windows exe 的 Electron 应用:
package.json(main 指向 main.js, build.win.target 配 portable) + main.js + index.html,
界面用相对路径引用项目 assets/ 下的图片素材。
```

## 测试

```bash
npm run e2e          # 全量回归(1170 用例,含 LLM 探测 / 打包 / 出图 / 视频 / 交接 / agent 编排 / 图表 / 技能市场)
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
```

## 开源协议

[MIT](./LICENSE) —— 随意使用、修改、分发,保留版权声明即可。

## 贡献

欢迎一切形式的贡献:提 Issue、修 Bug、加节点类型、补文档。见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

**这个项目等待有缘人完善** —— 完整路线图见 [ROADMAP.md](./docs/ROADMAP.md)（工程可信 → 平台能力 → 生态商业化）。重点方向：节点插件 SDK、人工审批 / 策略护栏 / 密钥保险库 / 回滚节点、预算与成本控制、并行智能体投票、发布与部署节点、"AI 软件工厂"质量闭环。

v0.6.3（2026-10-08）：e2e 跨平台化（去硬编码盘符）、CLI 定位跨平台（which/PATH 兜底）、无 CLI 时 e2e SKIP 而非崩溃、生产代码调试日志清理、版本统一（tag `v0.6.3` + changelog）、3 个黄金工作流模板（企业级 AI 编程 / 游戏美术管线 / 多模型竞争）、Roadmap 文档。
