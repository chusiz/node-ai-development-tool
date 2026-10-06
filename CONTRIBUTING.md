# 贡献指南

欢迎来到 Node AI Development Tool 的贡献者社区!这个项目由一人起步,等待有缘人一起完善。

## 你可以做什么

- **提 Issue**:报 Bug、建议新节点类型、新功能,都可以开 Issue;
- **修 Bug / 加功能**:Fork 后提交 Pull Request;
- **补文档 / 教程**:README、示例工作流、接入教程;
- **测试**:跑 e2e,报告覆盖率不足的地方。

## 开发环境

- Node.js 20+、npm 10+;
- Windows 优先(macOS / Linux 理论上可用,未充分验证);
- 本地生图需要一张 Stable Diffusion 主模型(.safetensors),经 `CHUSIZ_SD_CHECKPOINT` 指定。

## 开发流程

```bash
npm install
npm run dev            # 启动应用
npm run typecheck:node && npm run typecheck:web   # 类型检查
npm run e2e            # 全量回归(提交前必跑)
```

## 代码约定

- `src/shared/` 是**唯一真相源**:节点类型在 `nodeRegistry.ts` 注册,加新节点 = 注册一条声明 + 渲染端组件 + 配置面板 + 执行器;
- 内置动作执行器在 `src/main/builtin/registry.ts` 注册(不耗 token 的节点);
- 界面组件映射在 `renderer/src/flow/nodeTypes.ts` 与 `renderer/src/components/NodeConfig/panelRegistry.ts` 各加一行;
- 提交前:typecheck 双绿 + e2e 全绿(依赖真实 LLM 的用例会自动跳过)。

## 提 PR 前检查

1. 没有把本地路径、API Key、凭据写进代码(一律用环境变量);
2. 新节点类型带上了 e2e 断言;
3. README 同步更新(新能力进「核心能力」表)。

## 行为准则

友好、尊重、就事论事。中文或英文交流都可以。
