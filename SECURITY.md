# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.6.x   | :white_check_mark: |
| < 0.6   | :x:                |

## Reporting a Vulnerability

请**不要**公开 Issue 报告安全漏洞。通过以下方式私密报告：

- GitHub 仓库 `Security` 标签页 → `Report a vulnerability`（推荐）
- 或发邮件到维护者（仓库主页可见）

请附上：影响版本、复现步骤、影响面评估。我们会尽快确认并回复，修复后统一发布公告（不含利用细节）。

## 安全设计（本项目内置的防护）

1. **密钥库加密存储**：模型 API Key 不落 `settings.json` 明文，走独立加密存储（`src/shared/secrets.ts`）。
2. **生成代码安全审计（v0.6.4）**：输出节点打包前自动运行：
   - 密钥泄露扫描（sk- / AKIA / github_pat / PRIVATE KEY 等模式），命中即列入报告；
   - `npm audit` 依赖漏洞审计，critical/high 数量进报告。
   - 报告落盘 `assets/generated/audit/audit-report.json`，随项目交付。
3. **权限最小化**：Python 节点子进程工作目录锁定在项目目录；内置动作的产物写项目内 `assets/generated/`。
4. **预览服务防穿越**：产物预览的本地静态服务校验 `startsWith(解析后根目录)`，拒绝路径穿越。
5. **缩略图白名单**：渲染进程取图只能传「项目文件夹 + 相对路径」，主进程做前缀 / realpath / 扩展名 / 大小校验。

## 已知边界（供评估风险时参考）

- MCP Server（`npm run mcp`）以本机用户权限运行，连接的 AI 助手可以执行工作流。仅在本机、受信任环境启用。
- 运行时节点（python / test）的代码执行以本机用户权限运行；请勿把不受信任的工作流文件当作可执行代码运行。
