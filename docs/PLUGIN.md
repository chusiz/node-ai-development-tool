# Plugin / Extension Guide · Node AI Development Tool（v0.6.4）

本文回答「我想给这个工具加东西」，按从易到难排列。

## 1. 最简单：装开源 Skill（零代码）

- 设置页 → 技能 → 「从 URL 安装」：粘贴公开 GitHub / Gitee 技能仓库 URL 即装（整仓收集技能目录）。
- 内置技能市场（v0.6.2）精选：anthropics/skills、obra/superpowers 等一键装。
- Skill 装到用户技能目录，agent 会话自动可用。

## 2. 加一个「内置动作」节点（如新打包目标 / 新工具）

四处 + 一处执行器，全部是数据与组件映射：

1. `src/shared/canvas.ts`：给 `NodeConfig` 加专属参数字段（如 `myParams?: MyParams` + 接口）。
2. `src/shared/nodeRegistry.ts`：
   - `NodeKind`、`NodeIconName` 联合各加一行；
   - `NODE_TYPES` 加一条（label/badge/ports/executor:'builtin'/action:'my-action'/addEntries/normalize/validate）。
3. 执行器：新建 `src/main/<name>/index.ts` 实现 `run/cancel`，返回 `BuiltinActionResult`；
   在 `src/main/ipc/register.ts` 用惰性工厂注册 `registerBuiltinAction('my-action', …)`。
4. 渲染端：`components/NodeConfig/<Name>Config.tsx` + `panelRegistry.ts` 注册 + `flow/<Name>Node.tsx` + `nodeTypes.ts` 注册。

调度链路零改动——runner 只认 `action` 数据。

## 3. 加一个「会话类」节点（需要 LLM 的 agent 角色）

- 在 `nodeRegistry.ts` 加 kind，`executor: 'session'`；
- 在 `workflow.ts` 的 `specFromGraph` 与 runner 的 session 分派处补 composePrompt 分支；
- 渲染端面板参考 `AgentConfig.tsx`。

## 4. 接入 MCP 工具（消费外部工具，v0.6.4）

当前版本提供 **MCP Server 端**（外部 AI 助手调用本工具的工作流）。
**MCP Client 端**（本工具节点消费外部 MCP 工具）在 ROADMAP Phase 2，
暂未实现——届时新增一个 `mcp-client` 内置动作，用现成的 builtin 扩展路径接入即可。

## 5. 发布成独立 npm 包（Phase 3 规划）

ROADMAP Phase 3 计划将节点引擎 / 模型接入层 / 打包层拆为独立 npm 包。
当前阶段请直接 fork 仓库使用；拆分后会有迁移指南。

## 6. 打包发布

```bash
npm run dist    # Windows NSIS 安装包 → dist/chusiz-*.setup.exe
npm run mcp     # MCP Server(headless)
```

## 检查清单（新增节点时）

- [ ] `canvas.ts` 参数接口 + `NodeConfig` 字段
- [ ] `nodeRegistry.ts`：NodeKind / NodeIconName / NODE_TYPES（含 addEntries 进添加菜单）
- [ ] 执行器 + `register.ts` 注册（builtin 动作）
- [ ] `panelRegistry.ts` + `nodeTypes.ts` + 组件（否则画布渲染空白）
- [ ] `specFromGraph` 拷贝字段（builtin 节点参数）
- [ ] e2e 断言（`scripts/e2e.ts` 至少加一条 happy path）
- [ ] typecheck:node / typecheck:web 双绿
