# Architecture · Node AI Development Tool（v0.6.4）

本文解释代码为什么这样分，改代码前先读它，避免把依赖方向改坏。

## 1. 分层与依赖方向

```
┌─────────────────────────────────────────────────────────┐
│  src/renderer/   React 界面(画布、面板、RunBar)           │
│    只能 import: shared/*、electron-vite 自动注入的 preload │
├─────────────────────────────────────────────────────────┤
│  src/preload/    contextBridge —— 唯一的 IPC 桥           │
├─────────────────────────────────────────────────────────┤
│  src/shared/     纯数据 + 纯函数(禁止 import React/electron)│
│    nodeRegistry.ts  nodeTypes 驱动源                      │
│    canvas.ts      节点配置字段(NodeConfig/各 Params)       │
│    workflow.ts    spec 构造/校验/事件/运行态(纯函数)        │
│    ipc.ts         CH/EV 通道名 + RendererApi 类型契约      │
├─────────────────────────────────────────────────────────┤
│  src/main/       Electron 主进程                          │
│    ipc/register.ts  IPC handler + 内置动作注册 + 惰性工厂   │
│    workflow/runner.ts 调度器(真实执行,headless 可复用)      │
│    builtin/registry.ts 内置动作注册表                      │
│    packager/ imagegen/ videogen/ testrun/ chartgen/      │
│    pythonrun/ handoff/ mcp/ audit/ persist/ agents/      │
└─────────────────────────────────────────────────────────┘
```

铁律：

1. `shared` 不 import React / electron / 主进程模块（保持可被 e2e 与 MCP standalone 直接 import）。
2. `main` 可以 import `shared`；`renderer` 可以 import `shared`；`main` 与 `renderer` 之间**只通过 IPC** 通信。
3. 节点类型是**数据驱动**的：`shared/nodeRegistry.ts` 是唯一真相源，主进程运行期不回查注册表（由 `specFromGraph` 拍成 `WorkflowNodeSpec`）。

## 2. 一次运行发生了什么

1. 渲染端点「运行」→ `workflow:run`（传整份图快照 spec）。
2. 主进程 `WorkflowRunner.run`：
   - 图校验（warn 进节点日志）；
   - `buildIndex` 拓扑排序（环抛 `CycleError` 带环路径）；
   - 计算活跃集（targets 的祖先闭包）；
   - `schedule()` 按并发上限调度，`runNode` 分派：
     - `executor === 'session'` → agent 会话（走 SessionManager，LLM）；
     - `executor === 'builtin'` → `runBuiltinAction`（走 builtin/registry，不耗 token）。
3. 增量执行（v0.6.4）：builtin 节点输入未变（上游产出 + 配置指纹一致）→ 复用上次产出，不真实执行。
4. 结果 `RunState` 经 `workflow:run` 事件推回 + `persistRun` 落盘（重启后 RunBar 仍可见）。

## 3. 内置动作（builtin action）

注册表：`src/main/builtin/registry.ts`。执行器各自独立（packager / imagegen / testrun / videogen / chartgen / pythonrun / handoff），在 `ipc/register.ts` 用惰性工厂（首次用到才动态 import，冷启动不加载重模块）。

| action | 执行器 | 用途 | 产物 |
|---|---|---|---|
| package | Packager | exe/web/game 打包 | 产物路径 + 审计报告 |
| image / sampler | ImageGen | 本地直出 / SD WebUI / 云端 | 相对路径列表 |
| test | TestRunner | 项目里跑测试命令 | 测试输出文本 |
| video | VideoGen | 视频理解（抽帧+视觉模型） | 理解文本 |
| chart | ChartGen | ECharts SSR 出 SVG | 相对路径 + 说明 |
| python | PythonRunner | 子进程跑脚本 | stdout 文本 |
| handoff / image-output | Handoff | 素材交接 | 素材清单文本 |
| noop | — | prompt 数据源 | 提示词文本 |

## 4. 增量执行（v0.6.4）

- 指纹 = 上游产出摘要 + 本节点配置（动作 + 相关参数）的哈希。
- 上一轮成功运行态按 `canvasId` 从 `runs/` 目录取最新（`runLog.findLatestRunState`）。
- 匹配 → 节点标记 `reused`，产出/artifacts 从上次抄回；不匹配 → 正常执行。
- 只对 builtin 生效；会话节点每次真实对话。

## 5. 安全审计（v0.6.4）

- `src/main/audit.ts`：密钥扫描（sk-/AKIA/github_pat/PRIVATE KEY 等）+ `npm audit --json`。
- 输出节点打包前自动执行（`register.ts` 的 package action 包装层），报告进 notice 与
  `assets/generated/audit/audit-report.json`。
- 预览服务（web）起 127.0.0.1 随机端口静态服务，`startsWith(resolve(dir))` 防路径穿越。

## 6. MCP（v0.6.4）

- `src/main/mcp/server.ts`：JSON-RPC 2.0 over stdio（initialize / tools/list / tools/call）。
- `src/main/mcp/standalone.ts`：headless 入口，**复用真实调度器**（SessionManager + NodeLogHub + WorkflowRunner + 全部内置动作）。
- 工具：`list_nodes`、`run_workflow`、`get_node_result`。
- 用法：`npm run mcp`（Claude Desktop / Cursor 的 MCP client 配置指向该命令）。

## 7. 测试

- `scripts/e2e.ts`：无头回归（不启动 GUI），真实跑 spec → runner → 内置动作，断言状态/产出/落盘。
- 断点设计：`makeRunnerEnv` 注入假 session（LLM 调用可被 FakeEnv 替换），使 e2e 不需要真实 key 也能覆盖调度链路。
- 基线：1174 断言通过 / 0 失败。

## 8. 已知限制（诚实清单）

- Android APK：本机无 Android SDK 时降级为 PWA 包（不空手失败）。
- 本地生图：需要提取的运行时 + checkpoint（`D:\haowan\env\python-sd` 模式）。
- 真实 LLM 在线验证依赖账户余额；机制层由 FakeEnv / e2e 覆盖。
