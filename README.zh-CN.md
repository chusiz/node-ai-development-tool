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
| 直接打包 exe | 输出节点内置 electron-builder,把软件节点生成的 Electron 应用打成 Windows 单文件 exe(双击即用,无需 Godot) |
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
npm run e2e          # 全量回归(1100 用例,含 LLM 探测 / 打包 / 出图 / 视频 / 交接节点)
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

**这个项目等待有缘人完善** —— 下一版可以做:apk/web 打包、ComfyUI 工作流直通、更多内置节点(音频/图表/OCR)、插件市场。
