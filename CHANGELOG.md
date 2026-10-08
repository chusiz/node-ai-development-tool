# Changelog

本文件记录 Node AI Development Tool（chusiz）的版本演进。版本号与 `package.json` 保持一致，每个 release 绑定 Git Tag（`vX.Y.Z`）。

## [0.6.6] - 2026-10-08 — UI/UX 收尾（同版本第二批次提交）

### 修复与体验
- **连线剪断改「悬停 + 按 E」**：不再有剪断按钮/图标/文字 —— 鼠标移到连线上高亮，按 `E` 即剪断；输入框打字时不会误触（排除 input/textarea/可编辑元素）。
- **顶栏按钮全部图标化 + 统一尺寸（34×28）**：工作区切换、技能、设置、窗口控制（最小化/最大化/关闭）全部只显图标，鼠标悬停显示文字；窗口控制按钮常驻顶栏首行右上角，不再掉到第二排；窄窗口按 1240/1060/920 三级逐级隐藏次要徽标防挤压。
- **移除 claude CLI 徽标 → 新增「当前模型」入口**：不再绑死 claude，图标 + 状态色（绿=已配置 / 红=未配置），点击打开设置；**选中会话节点时显示该节点实际生效的模型**（节点显式选的 > 该供应商默认 > 内置首选），每个节点可在「节点配置」里单独配置自己的 AI 与 agent。
- **添加节点菜单可滚动**：节点类型多（软件制作页 15+ 种）时菜单超屏被截断，现限制 `max-height` 并启用 `overflow-y: auto`，下方节点可滚动查看。
- 清理 `cli` 收窄变量的无用残留。

### 验证
- `npm run typecheck:node` / `typecheck:web` 双 0 错。
- `npm run e2e`：**通过 1277 / 跳过 10（LLM 402）/ 失败 0**（日志 `e2e-v066d.log`）。

## [0.6.6] - 2026-10-08 — 工程化节点群（整合版建议 P1/P2/P4 一次落地）

### 新增
- **反馈闭环收口（v0.6.5 随本版发布）**：Gate 节点（builtin `gate`）—— mode=exit 跑命令看退出码 / mode=text 校验上游文本（contains / not-contains / regex），不通过即失败并拦住下游；feature/agent 节点新增 `autofix` 参数，下游闸门/测试失败时自动把错误喂回 LLM 重跑（最大轮次上限、失败链重置、成功后继解拦）。
- **8 个确定性工程化节点（不耗 LLM token）**：
  - `lint` 静态检查（默认 `npx tsc --noEmit`，可自定义命令，退出码判定）；
  - `git` 本地版本控制（status / commit 自动 add+commit 带本地身份 / log / branch，**不 push 外部**）；
  - `deps` 依赖管理（自动识别 npm package.json / pip requirements.txt，报告清单与缺失检测）；
  - `context` 项目记忆（风格/规范/接口清单落盘 `assets/generated/context.md`，下游 {{prev}} 引用）；
  - `contract` 接口契约（从上游代码正则提取 app.get/post 等路由与 fetch 调用，生成 OpenAPI 骨架落盘）；
  - `cost` 运行摘要（调度器注入本轮全图状态/耗时/产出规模，估算 token 成本）；
  - `diff` 现状快照（递归扫描文件树/类型分布落盘，增量修改前先看现状）；
  - `deploy` 一键部署（复制 Web 产物到 `deploy/`，生成 vercel.json / netlify.toml / 静态说明）。
- 执行器 `src/main/toolkit/index.ts`：统一 safeCwd（Windows cwd 不存在时 spawn 会伪装 ENOENT）+ spawn 显式 shell + 超时 kill。
- 注册表/渲染端全量接入：8 节点注册、面板（按 kind 渲染专属字段）、节点卡片（就地运行按钮）、8 个新图标与 kind 配色、工作区白名单补齐（gate/python/lint/git/deps/context/contract/cost/diff/deploy 进入软件制作页）。
- e2e 第 34 节（34a..34g）：注册表/参数透传/分发与 runSummary 注入/真实执行器（context 落盘、contract 提取 3 路由、deps 双识别、diff 快照、deploy 复制+配置、git init→status→commit→干净、lint 退出码语义、cost 透传）。

### 验证
- `npm run typecheck:node` / `typecheck:web` 双 0 错。
- `npm run e2e`：**通过 1277 / 跳过 10（LLM 402）/ 失败 0**（日志 `e2e-v066.log`）。
- 测试目录全部 process.cwd() 相对化，e2e 不再依赖开发机盘符。

## [0.6.5] - 2026-10-08 — 反馈闭环（Gate + Auto-Fix）

### 新增
- **Gate 闸门节点**：见 0.6.6 描述（0.6.5 独立发布，随 0.6.6 一起打 tag）。
- **调度级 Auto-Fix 循环**：`maybeAutoFix` / `findAutofixTarget` / `resetSubgraphForFix`，`composePrompt` 注入 `【自动修复 · 上次验证失败信息】`。

### 验证
- `npm run e2e`：**通过 1227 / 跳过 10 / 失败 0**（日志 `e2e-v065d.log`）。

## [0.6.4] - 2026-10-08 — 工程加固与平台能力（改进建议全落地）

### 新增
- **节点级错误可视化 + 一键送修**：节点运行失败时卡片出现「送修」按钮，自动新建「修复:xxx」功能节点并连线到出错节点下游（进撤销历史）。
- **产物预览内置化**：输出节点「预览产物」—— web 起本地静态服务开浏览器、exe 直接启动、game 打开产物目录。
- **安全审计（打包前自动执行）**：`src/main/audit.ts` 密钥扫描（sk-/AKIA/ark-/github_pat/PRIVATE KEY 等 6 类，跳过 node_modules/.git/dist 与点文件）+ `npm audit --json`；报告落盘 `assets/generated/audit/audit-report.json`。
- **增量执行**：builtin 节点按输入指纹复用上次产出（`reused` 标记），未变输入不再重跑。
- **MCP Server**：`npm run mcp` headless 启动，JSON-RPC 2.0 over stdio，工具 `list_nodes` / `run_workflow` / `get_node_result`，复用真实调度器 —— Claude / Cursor 可直接编排。
- **Python 节点**：子进程跑脚本（cwd 锁定项目目录、超时 5..3600s、stdout 交下游），复用 AI/ML 生态不耗 token。
- **启动懒加载**：packager/imagegen/videogen/chartgen/testrun/pythonrun 全部动态 import，画布先可用。
- **新手引导**：画布右上角「?」5 步交互式引导。
- **治理文档**：CONTRIBUTING.md 重写、CODE_OF_CONDUCT.md、SECURITY.md、docs/ARCHITECTURE.md、docs/PLUGIN.md、docs/实现与验证报告-v0.6.4.md。

### 工程
- 双端 typecheck 0 错误；e2e 新增第 32 节（python/增量/审计/MCP），全量 **通过 1194 / 跳过 10（LLM 402 余额不足）/ 失败 0**。

## [0.6.3] - 2026-10-08 — 工程可信度收尾

### 修复（社区回馈的 3 个真问题）
- **e2e 硬编码开发机盘符**：`scripts/e2e.ts` 的 `CWD` 与沙箱断言、`scripts/run-image-local.ts` 的工程路径全部改为基于 `process.cwd()` / 相对路径 —— 测试套件现在可在 Linux / macOS 上完整运行。
- **claude locator 跨平台**：`src/main/agents/cli/locator.ts` 的 PATH 查找不再只依赖 Windows `where` —— 新增 `which`（Linux/macOS）与 PATH 遍历兜底，`detect()` 在非 Windows 平台也能定位 CLI。
- **e2e 无 CLI 时 SKIP 而非崩溃**：探测失败现在走 `skip()`（机制断言仍由第 18 节合成适配器覆盖），而不是让整个套件在第二节直接崩掉。
- **移除生产代码调试日志**：`src/main/agents/api/session.ts` 中残留的 `console.error('[CHAT_HTTP]')`（FULLFLOW-DEBUG 标记）已清理。

### 新增
- **3 个黄金工作流模板**（对应改进建议"成熟度最高的组合"）：
  - `enterprise-ai-coding` 企业级 AI 编程：需求 → 规划 → 审查 → 编码 → 测试 → 审查(安全) → 打包 exe
  - `game-art-pipeline` AI 游戏美术管线：生图(风格/批量) → 素材交接 → 游戏工程 → 打包
  - `multi-agent-competition` 多模型竞争：项目 → 并行实现 → 整合对比 → 测试评估 → 输出
- **`docs/ROADMAP.md`**：把改进建议整理成开源路线图（工程可信 → 平台能力 → 生态商业化），供社区按优先级接单。

### 工程
- 产品版本与代码版本统一：`package.json` `0.1.0` → `0.6.3`（与 README / 报告一致）；新增本 CHANGELOG；打 Git Tag `v0.6.3`。

## [0.6.2] - 2026-10-06 — 图表节点 + 开源技能市场

- chart 可视化节点（ECharts SSR → SVG，柱/折/饼/散点/漏斗，5 种数据形状宽容解析，产物随项目打包）。
- 开源技能市场：GitHub/Gitee URL 一键安装（域名白名单 + zip slip 防护 + 危险命令扫描），市场页签 + 精选技能集。

## [0.6.1] - 2026-10-06 — 工程化 agent 编排

- agent（智能体循环）节点：多轮迭代，`doneHint` 完成标志提前收尾。
- router（LLM 路由）节点：从出边选一条分支激活，其余自动跳过。
- 内置 `agent-orchestration` 模板。

## [0.6.0] - 2026-10-06 — 多平台完整制作

- 输出节点四目标：exe / Web 静态站点 / Android apk（无 SDK 自动降级 PWA）/ Godot 游戏 zip。
- 工作流 JSON 导入导出（ComfyUI 式）；内置 4 个模板；游戏增强。

## [0.5.0] - 2026-10-06 — 双工作区 + 多项目 + 开源发布

- 生图 / 软件制作双页面拆分；交接节点跨页素材共享；多项目并行；本地模型直出生图；exe 直接打包；开源到 GitHub。
