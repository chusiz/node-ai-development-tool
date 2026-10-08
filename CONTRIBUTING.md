# Contributing to Node AI Development Tool

感谢你愿意让这个项目变得更好。项目当前由极少数维护者维护，你的每一条 Issue、PR 都会加速它走向成熟。

## 先读这些

- [README.md](./README.md) 了解产品定位与能力边界
- [docs/ROADMAP.md](./docs/ROADMAP.md) 了解方向与优先级
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) 了解代码分层与「为什么这么写」
- [docs/PLUGIN.md](./docs/PLUGIN.md) 了解如何扩展节点 / 执行器 / 技能市场

## 如何报告 Bug

1. 先搜 [Issues](https://github.com/chusiz/node-ai-development-tool/issues)，确认没有重复。
2. 标题写清「现象 + 场景」，例如：`输出节点打包 Web 应用时 index.html 为空白`。
3. 正文包含：
   - 复现步骤（最好贴一张工作流截图，或导出 JSON 画布）
   - 期望行为 vs 实际行为
   - 运行环境：OS、版本号、打包目标（exe / web / game）
   - 节点日志尾部（画布下方 RunBar 可复制）
4. 标签：`bug`、`good first issue`、`question` 等由维护者补，你不需要会打标签。

## 如何提功能建议

- 用 Issue 模板 `Feature request`。
- 说清楚：你卡在哪个真实场景里、期望的最小可用形态是什么。
- 不要写「做一个像 X 平台的全套功能」——拆成可独立验证的一步。

## 本地开发

```bash
npm install
npm run dev            # 启动 Electron + 渲染进程热更新
npm run typecheck:node # 主进程类型检查
npm run typecheck:web  # 渲染进程类型检查
npm run e2e            # 无头 e2e(不需要 GUI)
npm run dist           # 打 NSIS 安装包(Windows)
npm run mcp            # 运行 MCP Server(headless,供 Claude/Cursor 连接)
```

> 当前 e2e 断言基线：通过 1174 / 跳过若干（真实 LLM 余额不足时）/ 失败 0。提交前必须保证失败为 0。

## 提交规范

- 分支：`fix/xxx`、`feat/xxx`、`docs/xxx`，一个 PR 只做一件事。
- Commit message：`<type>: <简述>`，如 `feat: python 节点支持子进程执行`、`fix: e2e 硬编码盘符导致跨平台失败`。
- 中文提交说明即可，保持简洁。
- 不要提交 `dist/`、`.tmp/`、`node_modules/`、日志文件（已在 .gitignore）。

## 代码风格

- TypeScript strict；主进程/渲染进程/共享三层的依赖方向不可破坏（见 ARCHITECTURE.md）。
- `src/shared/` 禁止 import React / electron —— 那里只放纯数据与纯函数。
- 新节点类型要同步改四处：`shared/nodeRegistry.ts`（数据）、`renderer/.../panelRegistry.ts`（面板）、`renderer/.../nodeTypes.ts`（组件）、`shared/canvas.ts`（配置字段）。
- 加 IPC 通道要同步：`shared/ipc.ts`（CH + 类型）→ `preload/index.ts`（bridge）→ 主进程 handler。
- 生产代码不留调试日志；e2e 的硬编码本地路径必须改为 `process.cwd()` 相对路径。

## 审查流程

- 维护者会尽快 review；小 PR（≤200 行）通常当周合入。
- 如果 2 周没动静，在 PR 里 @ 维护者提醒一次即可，不要刷屏。
- 合入 PR 由维护者执行（当前没有 CI 机器人，会手动跑 e2e 后 merge）。

## 从哪开始

- 标签 `good first issue`：已标注适合新人的任务。
- 优先挑「修一个真实 bug」而不是「加一个全新子系统」——后者建议先开 Issue 讨论设计。
