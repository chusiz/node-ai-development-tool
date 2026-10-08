import { useSettingsStore } from '../stores/settingsStore'

/**
 * 界面语言层(v0.6.6 起)。
 *
 * 语言开关住在 settings.ui.language(`en` = 默认,方便海外查看;`zh` = 简体中文)。
 * 只翻译**界面壳文本**(按钮 / 标题 / 提示 / 面板),不翻译用户数据
 * (节点标题、提示词、项目名)与注册表数据(节点 label 在添加菜单里经
 * `nodeEntryLabel()` 显示层翻译,数据本身仍是中文 —— 画布存档不受语言影响)。
 *
 * t(key) 在渲染组件里每次调用读一次 store —— 文本量小,不值得做 memo;
 * 语言切换时由订阅它的组件(顶栏语言入口等)触发整树重渲。
 */

export type Lang = 'en' | 'zh'

export interface LangText {
  en: string
  zh: string
}

/** 键 → 双语文本。键名按「所属组件.用途」起,避免与节点 kind 混淆 */
const DICT: Record<string, LangText> = {
  /* ---- 通用 ---- */
  'common.save': { en: 'Save', zh: '保存' },
  'common.saved': { en: 'Saved', zh: '已保存' },
  'common.discard': { en: 'Discard', zh: '撤销' },
  'common.close': { en: 'Close', zh: '关闭' },
  'common.cancel': { en: 'Cancel', zh: '取消' },
  'common.loading': { en: 'Loading…', zh: '读取中…' },
  'common.reset': { en: 'Reset to default', zh: '恢复默认' },
  'common.resetAll': { en: 'Reset all', zh: '重置全部' },

  /* ---- 顶栏 ---- */
  'topbar.project': { en: 'Switch project (each project has its own image & app canvases)', zh: '切换项目(每个项目有独立的生图与软件画布)' },
  'topbar.model': { en: 'Current model', zh: '当前模型' },
  'topbar.modelConfigure': { en: 'Configure model', zh: '配置模型' },
  'topbar.skills': { en: 'Installed skills', zh: '管理已安装的技能' },
  'topbar.shortcuts': { en: 'Keyboard shortcuts (?)', zh: '键盘快捷键 (?)' },
  'topbar.settings': { en: 'Settings (Ctrl+,)', zh: '设置 (Ctrl+,)' },
  'topbar.language': { en: 'Language', zh: '语言' },
  'topbar.nodes': { en: '{n} nodes', zh: '{n} 个节点' },
  'topbar.saving': { en: 'Saving…', zh: '保存中…' },
  'topbar.saveFailed': { en: 'Save failed', zh: '存盘失败' },
  'topbar.modelTitle.node': { en: 'Node “{name}”: {agent} · {model} — each node can switch its own AI/agent in Node config', zh: '节点「{name}」:{agent} · {model} — 每个节点可在节点配置里单独换 AI/agent' },
  'topbar.modelTitle.defaultAgent': { en: 'default agent', zh: '默认 agent' },
  'topbar.modelTitle.defaultModel': { en: 'default model', zh: '默认模型' },
  'topbar.modelTitle.global': { en: 'Global default model: {model} — click to open settings (each node can set its own model/agent)', zh: '全局默认模型:{model} — 点击设置(每个节点可单独配置自己的模型/agent)' },
  'topbar.modelTitle.none': { en: 'No default model configured — click to open settings (Volcano Ark / Gemini / local models supported)', zh: '未配置默认模型 — 点击设置(支持火山方舟 / Gemini / 本地模型等)' },
  'ws.app': { en: 'App Builder', zh: '软件制作' },
  'ws.image': { en: 'Image Generation', zh: '生图' },

  /* ---- 画布工具条 ---- */
  'canvas.addNode': { en: 'Add node', zh: '添加节点' },
  'canvas.addNodeHint': { en: 'Add node (Ctrl+K)', zh: '添加节点 (Ctrl+K)' },
  'canvas.deleteSelected': { en: 'Delete selected', zh: '删除选中' },
  'canvas.deleteSelectedHint': { en: 'Delete selected node (Delete)', zh: '删除选中节点 (Delete)' },
  'canvas.deleteSelectedDisabled': { en: 'Select a node first', zh: '先点选一个节点' },
  'canvas.disconnectEdge': { en: 'Cut edge', zh: '断开连线' },
  'canvas.disconnectEdgeHint': { en: 'Cut this edge (Delete)', zh: '切断这条连线 (Delete)' },
  'canvas.encapsulate': { en: 'Group into subgraph', zh: '封装成子图' },
  'canvas.encapsulateHint': { en: 'Encapsulate the selected nodes into one subgraph node (it still executes when run)', zh: '把选中的节点封装成一个子图节点(运行时照常展开执行)' },
  'canvas.workflow': { en: 'Workflow', zh: '工作流' },
  'canvas.workflowHint': { en: 'Workflow: export/import JSON, apply templates', zh: '工作流:导出/导入 JSON、一键套用模板' },
  'canvas.exportWf': { en: 'Export workflow (.json)', zh: '导出工作流 (.json)' },
  'canvas.importWf': { en: 'Import workflow (.json)', zh: '导入工作流 (.json)' },
  'canvas.templates': { en: 'One-click templates', zh: '一键模板' },
  'canvas.hintLine': { en: 'Drag nodes · pull the right dot to connect · hover an edge & press E to cut · click a node to chat in the right panel · ', zh: '拖节点 · 拉右边的点连线 · 鼠标移到线上按 E 剪断 · 点节点在右栏对话 · ' },
  'canvas.shortcuts': { en: 'Shortcuts', zh: '快捷键' },
  'canvas.shortcutsHint': { en: 'All keyboard shortcuts (?)', zh: '全部快捷键 (?)' },
  'canvas.menuSelect': { en: 'Select', zh: '选择' },
  'canvas.menuAdd': { en: 'Add', zh: '添加' },
  'canvas.menuDirect': { en: 'direct pick', zh: '直选' },
  'canvas.exportDialogTitle': { en: 'Export workflow', zh: '导出工作流' },
  'canvas.importDialogTitle': { en: 'Import workflow', zh: '导入工作流' },
  'canvas.exported': { en: 'Workflow exported: {p}', zh: '工作流已导出:{p}' },
  'canvas.exportFailed': { en: 'Export failed: {e}', zh: '导出失败:{e}' },
  'canvas.readFailed': { en: 'Read failed: {e}', zh: '读取失败:{e}' },
  'canvas.imported': { en: 'Workflow imported ({n} nodes)', zh: '工作流已导入({n} 个节点)' },
  'canvas.importFailed': { en: 'Import failed', zh: '导入失败' },
  'canvas.templateApplied': { en: 'Template “{label}” applied: {desc}', zh: '已套用模板「{label}」:{desc}' },
  'canvas.templateFailed': { en: 'Apply failed', zh: '套用失败' },
  'template.desktop-app': { en: 'Desktop app (exe)', zh: '桌面软件 (exe)' },
  'template.desktop-app.desc': { en: 'Project → Electron app → Review → Test → exe output, one complete desktop pipeline', zh: '项目 → 生成 Electron 应用 → 审查 → 测试 → 输出 exe,一条完整桌面软件流水线' },
  'template.mobile-web': { en: 'Web app (mobile-ready)', zh: 'Web 应用(手机可用)' },
  'template.mobile-web.desc': { en: 'Project → Web app → static site output (mobile-ready / APK later)', zh: '项目 → 生成 Web 应用 → 输出 Web 站点(手机浏览器即用 / 可进一步打 APK)' },
  'template.pixel-game': { en: 'Pixel game (Godot)', zh: '像素游戏 (Godot)' },
  'template.pixel-game.desc': { en: 'Local model assets → handoff → game → Godot project zip', zh: '项目 → 本地模型出像素素材 → 交接 → 游戏 → 输出 Godot 项目 zip' },
  'template.image-flows': { en: 'Image generation flow', zh: '生图流水线' },
  'template.image-flows.desc': { en: 'Positive / negative prompts → sampling → image output (local model direct)', zh: '正向 / 负向提示词 → 采样出图 → 图片输出(本地模型直出)' },
  'template.agent-orchestration': { en: 'Agent orchestration', zh: 'Agent 编排' },
  'template.agent-orchestration.desc': { en: 'Planner → two parallel branches → merge → reviewer → exe output (agentic engineering demo)', zh: '规划智能体 → 两条并行执行支路 → 整合 → 审查智能体 → 输出 exe(工程化 agent 编排示例)' },
  'template.enterprise-ai-coding': { en: 'Enterprise AI coding pipeline', zh: '企业级 AI 编码流水线' },
  'template.enterprise-ai-coding.desc': { en: 'Requirements → plan → critique → code → test → security review → exe — auditable, pausable, resumable', zh: '需求 → 规划 → 批评审查 → 编码 → 测试 → 安全审查 → 打包 exe —— 可审查、可暂停、可恢复的工程化流水线' },

  /* ---- 运行条 ---- */
  'run.runAll': { en: 'Run all', zh: '跑全部' },
  'run.runSelected': { en: 'Run selected', zh: '只跑选中' },
  'run.input': { en: 'Input', zh: '输入' },
  'run.ctrlEnter': { en: 'Ctrl+Enter run all', zh: 'Ctrl + Enter 跑全部' },
  'run.shortcuts': { en: 'Shortcuts', zh: '快捷键' },
  'run.runAllTitle': { en: 'Run the whole graph in connection order ({keys})', zh: '按连线顺序跑完整张图 ({keys})' },
  'run.runAllTitleEmpty': { en: 'Add a node first', zh: '先加个节点' },
  'run.runSelectedTitle': { en: 'Run selected node with its upstream ({keys})', zh: '只跑选中节点(连同它的上游)({keys})' },
  'run.cancel': { en: 'Cancel', zh: '取消' },
  'run.inputPlaceholder': { en: 'One sentence for this run (optional)\nInjected as {{input}} after each source node prompt', zh: '给这次运行的一句话(可选)\n会作为 {{input}} 拼在每个源头节点的提示词后面' },
  'run.inputHint': { en: 'Only affects this run; not saved into node config', zh: '只影响这次运行,不写进节点配置' },
  'run.checkTitle': { en: 'Expand pre-run checks', zh: '展开查看运行前检查提示' },
  'run.check': { en: 'Checks {n}', zh: '检查 {n}' },
  'run.tallyTitle': { en: 'done / total', zh: '完成 / 总数' },
  'run.failedN': { en: '{n} failed', zh: '失败 {n}' },
  'run.skippedN': { en: '{n} skipped', zh: '跳过 {n}' },
  'run.waitingN': { en: '{n} waiting', zh: '等待 {n}' },
  'run.failReasons': { en: 'Fail reasons {n}', zh: '失败原因 {n}' },
  'run.startFailed': { en: 'Failed to start: {e}', zh: '发起失败:{e}' },
  'run.cycleNodes': { en: 'Nodes in the cycle:', zh: '环上的节点:' },
  'run.gotIt': { en: 'Got it', zh: '知道了' },
  'run.noEdgesHint': { en: 'Nodes are not connected yet — each runs on its own and results don’t flow', zh: '节点之间还没连线 —— 现在它们各跑各的,不会互相传递结果' },
  'run.shortcutsTitle': { en: 'All keyboard shortcuts (?)', zh: '查看全部快捷键 (?)' },
  'run.status.running': { en: 'Running', zh: '运行中' },
  'run.status.done': { en: 'All done', zh: '全部完成' },
  'run.status.failed': { en: 'Has failures', zh: '有失败' },
  'run.status.cancelled': { en: 'Cancelled', zh: '已取消' },
  /* 节点徽标(RunNodeChip):单节点运行状态 */
  'run.statusPrefix': { en: 'This run', zh: '本次运行' },
  'run.node.queued': { en: 'Queued', zh: '排队' },
  'run.node.waiting': { en: 'Waiting for upstream', zh: '等待上游' },
  'run.node.running': { en: 'Running', zh: '运行中' },
  'run.node.done': { en: 'Done', zh: '完成' },
  'run.node.failed': { en: 'Failed', zh: '失败' },
  'run.node.skipped': { en: 'Skipped', zh: '已跳过' },
  'run.node.cancelled': { en: 'Cancelled', zh: '已取消' },

  /* ---- 节点卡片 ---- */
  'node.idle': { en: 'Idle', zh: '空闲' },
  'node.running': { en: 'Running', zh: '运行中' },
  'node.done': { en: 'Done', zh: '完成' },
  'node.failed': { en: 'Failed', zh: '失败' },
  'node.interrupted': { en: 'Interrupted', zh: '被中断' },
  'node.skipped': { en: 'Skipped', zh: '跳过' },
  'node.noChatYet': { en: 'No conversation yet', zh: '还没有对话' },
  'node.renameHint': { en: 'Double-click to rename', zh: '双击改名' },
'node.agentChipTitle': { en: 'AI & model for this node: {label}\n(change per node in Node config)', zh: '这个节点用的 AI 与模型:{label}\n(在节点配置里可单独更换)' },

  /* ---- Inspector ---- */
  'inspector.nothingSelected': { en: 'Nothing selected', zh: '还没有选中节点' },
  'inspector.pickHint': { en: 'Click any node on the canvas, then talk to it in the input below. To make it modify your project, choose the project folder in “Node config”.', zh: '点画布上的任意一个节点,在下面的输入框里跟它说话。要让它改你的项目,再去「节点配置」里选项目文件夹' },
  'inspector.chatTab': { en: 'Chat', zh: '对话' },
  'inspector.configTab': { en: 'Node config', zh: '节点配置' },
  'inspector.newSession': { en: 'New session', zh: '新会话' },
  'inspector.continueSession': { en: 'rounds · same session', zh: '轮·续用同一会话' },
  'inspector.diagnosis': { en: 'Diagnosis', zh: '诊断' },
  'inspector.interruptedNote': { en: 'Last run was interrupted (the app quit) and didn’t finish. You can continue the conversation.', zh: '上次运行被中断(应用已退出),这一轮没有跑完。可以直接继续对话。' },
  'inspector.send': { en: 'Send', zh: '发送' },
  'inspector.enterSend': { en: 'Enter send · Shift+Enter newline', zh: 'Enter 发送·Shift+Enter 换行' },
  'inspector.you': { en: 'You', zh: '你' },
  'inspector.runningPlaceholder': { en: 'Running…', zh: '正在运行…' },
  'inspector.cancel': { en: 'Cancel', zh: '取消' },
  'inspector.sendWord': { en: 'send', zh: '发送' },
  'inspector.newlineWord': { en: 'newline', zh: '换行' },
  'inspector.stdinNote': { en: 'prompt via stdin · spawns the CLI directly (no cmd.exe)', zh: 'prompt 走 stdin · 直接 spawn CLI(不经 cmd.exe)' },
  'inspector.trimmedNote': { en: 'Older {n} messages folded (kept on disk, loadable in a future version)', zh: '已折叠更早的 {n} 条(在磁盘里,后续版本可按需加载)' },
  'inspector.empty': { en: 'No conversation for this node yet', zh: '这个节点还没有对话' },
  'inspector.emptySub': { en: 'Type a message below and it will run with its own session', zh: '在下面输入一句话,它会用自己的会话跑' },
  'inspector.backToBottom': { en: 'Back to bottom', zh: '回到底部' },
  'inspector.noSelection': { en: 'No node selected', zh: '还没有选中节点' },
  'inspector.noSelectionSub': { en: 'Click any node on the canvas and talk to it in the input below.', zh: '点画布上的任意一个节点,在下面的输入框里跟它说话' },
  'inspector.noSelectionSub2': { en: 'To let it modify your project, pick the project folder in “Node config”.', zh: '要让它改你的项目,再去「节点配置」里选项目文件夹' },
  'inspector.newSessionTitle': { en: 'Clear this node’s session and disk logs; the next message starts a fresh session', zh: '清空这个节点的会话与磁盘日志,下一句话会是全新会话' },
  'inspector.rounds': { en: 'rounds', zh: '轮' },
  'inspector.sameSession': { en: 'same session continues', zh: '续用同一会话' },
  'inspector.agentTitle': { en: 'AI & model used by this node (change per node in Node config)', zh: '这个节点用的 AI 与模型(可在节点配置里单独更换)' },

  /* ---- 首次运行横幅(FirstRunBanner) ---- */
  'firstrun.title': { en: 'No', zh: '未检测到' },
  'firstrun.titleTail': { en: 'detected — every node on the canvas will fail to run', zh: '—— 画布上所有节点都会跑不起来' },
  'firstrun.hint1': { en: 'This app is a graphical shell; the real work is done by the Claude Code CLI installed on this machine (it is not bundled). Install it first:', zh: '这个应用是图形外壳,真正干活的是本机安装的 Claude Code CLI(不会被打进安装包)。先在命令行装好:' },
  'firstrun.copy': { en: 'Copy', zh: '复制' },
  'firstrun.copied': { en: 'Copied', zh: '已复制' },
  'firstrun.hint2': { en: 'Installed but still seeing this? It’s not in the default location — point the', zh: '已经装了却还是这里报错?说明它不在默认位置 —— 去设置里手动指一下' },
  'firstrun.exePath': { en: 'executable path', zh: '可执行文件路径' },
  'firstrun.hint3': { en: 'in Settings and it takes effect immediately.', zh: '即可,改完立即生效。' },
  'firstrun.probeErr': { en: 'Probe error', zh: '探测报错' },
  'firstrun.recheck': { en: 'Re-check', zh: '重新检测' },
  'firstrun.gotoSettings': { en: 'Open Settings', zh: '去设置' },
  'firstrun.docs': { en: 'Docs', zh: '文档' },
  'firstrun.hide': { en: 'Hide for now', zh: '暂时隐藏' },

  /* ---- 消息气泡(MessageBubble) ---- */
  'msg.diagTag': { en: 'Diag', zh: '诊断' },
  'msg.sessionEstablished': { en: 'Session established', zh: '会话已建立' },
  'msg.thinking': { en: 'Thinking', zh: '思考' },
  'msg.toolUse': { en: 'Tool call · {name}', zh: '调用工具 · {name}' },
  'msg.toolResult': { en: 'Tool result', zh: '工具结果' },
  'msg.errorWord': { en: 'error', zh: '错误' },
  'msg.emptyWord': { en: '(empty)', zh: '(空)' },
  'msg.roundEnd': { en: 'Round ended', zh: '本轮结束' },
  'msg.ok': { en: 'OK', zh: '成功' },
  'msg.failed': { en: 'Failed', zh: '异常' },
  'msg.error': { en: 'Error', zh: '错误' },
  'msg.foldedKB': { en: 'Folded {kb}KB', zh: '已折叠 {kb}KB' },
  'msg.loading': { en: 'Loading…', zh: '读取中…' },
  'msg.expand': { en: 'Expand', zh: '展开' },
  'msg.collapse': { en: 'Collapse', zh: '收起' },
  'msg.truncated': { en: 'truncated', zh: '已截断' },

  /* ---- 节点卡片(NodeShell,v0.6.6) ---- */
  'node.renameTitle': { en: 'double-click to rename', zh: '双击改名' },
  'node.deleteTitle': { en: 'Delete this node', zh: '删除这个节点' },
  'node.runTitle': { en: 'Run this node (with its upstream)', zh: '只跑这个节点(连同它的上游)' },
  'node.upstreamTitle': { en: 'Upstream: {n}', zh: '上游:{n}' },
  'node.fixTitle': { en: 'Send to Auto-Fix: {e}', zh: '一键送修:{e}' },
  'node.youPrefix': { en: 'You', zh: '你' },
  'node.noChat': { en: 'No conversation yet', zh: '还没有对话' },
  'node.fix': { en: 'Fix', zh: '送修' },

  /* ---- 设置 ---- */
'settings.restartNote': { en: 'Saved, but these need a {items} restart to take effect:', zh: '已保存,但这些改动要{items}重启才生效:' },
  'settings.limits': { en: 'Message list caps', zh: '消息列表封顶' },
  'settings.limitsNote': { en: 'Renderer-side trimming; saves immediately, no restart needed.', zh: '这些是渲染进程侧的裁剪,保存即生效,不需要重启。' },
  'settings.workflow': { en: 'Workflow', zh: '工作流' },
  'settings.ui': { en: 'Interface & shortcuts', zh: '界面与快捷键' },
  'settings.language': { en: 'Interface language', zh: '界面语言' },
  'settings.shortcuts': { en: 'Keyboard shortcuts', zh: '快捷键' },
  'settings.shortcutsNote': { en: 'Click Edit, then press the new key combination. Delete = reset this one to default; Esc = cancel. Ctrl/Cmd are treated as the same modifier.', zh: '点「编辑」后按下新组合键。Delete = 恢复该动作默认键位;Esc = 取消。Ctrl 与 Cmd 视为同一修饰键。' },
  'settings.edit': { en: 'Edit', zh: '编辑' },
  'settings.listening': { en: 'Press new keys… (Esc cancel, Delete reset)', zh: '按下新组合键…(Esc 取消,Delete 恢复默认)' },
'settings.conflict': { en: '“{other}” already uses that combination — change it first.', zh: '「{other}」已占用该组合,请先改掉它。' },
  'settings.defaultKeys': { en: 'Default', zh: '默认' },
  'settings.currentKeys': { en: 'Current', zh: '当前' },

  /* ---- 设置:界面与快捷键(UiSection,v0.6.6) ---- */
  'settings.title': { en: 'Settings', zh: '设置' },
  'settings.tab.perf': { en: 'Performance', zh: '性能' },
  'settings.tab.model': { en: 'Models & Agents', zh: '模型与 Agent' },
  'settings.tab.ui': { en: 'Interface & Shortcuts', zh: '界面与快捷键' },
  'settings.tab.adv': { en: 'Advanced', zh: '高级' },
  'settings.close': { en: 'Close', zh: '关闭' },
  'settings.loading': { en: 'Loading settings…', zh: '读取设置中…' },
  'settings.save': { en: 'Save', zh: '保存' },
  'settings.saved': { en: 'Saved', zh: '已保存' },
  'settings.discard': { en: 'Discard', zh: '撤销' },
  'settings.msgCap': { en: 'Message list caps', zh: '消息列表封顶' },
  'settings.msgCapHint': { en: 'Renderer-side trimming — takes effect immediately, no restart needed.', zh: '这些是渲染进程侧的裁剪,保存即生效,不需要重启。' },
  'settings.workflowTitle': { en: 'Workflow', zh: '工作流' },
  'settings.limits.maxItemsPerNode': { en: 'Messages per node', zh: '每节点消息上限' },
  'settings.limits.maxItemsPerNode.hint': { en: 'Oldest are folded first, with “N folded” noted', zh: '超出后从头部折叠,并提示「已折叠 N 条」' },
  'settings.limits.maxToolResultChars': { en: 'Inline tool result cap (chars)', zh: '工具结果内联上限 (字符)' },
  'settings.limits.maxToolResultChars.hint': { en: 'Overflow goes to disk, fetched on expand', zh: '超出部分落到磁盘,展开时按需取回' },
  'settings.limits.maxThinkingChars': { en: 'Inline thinking cap (chars)', zh: '思考内联上限 (字符)' },
  'settings.limits.maxResultChars': { en: 'Result cap per round (chars)', zh: '本轮结果上限 (字符)' },
  'settings.limits.stderrTailLines': { en: 'stderr lines kept', zh: 'stderr 保留行数' },
  'settings.limits.stderrTailLines.hint': { en: 'Diagnostics only, not in the message stream', zh: '只做诊断,不进消息流' },
  'settings.limits.diagRingSize': { en: 'Diagnostic ring buffer', zh: '诊断环形缓冲条数' },
  'settings.limits.diagRingSize.hint': { en: 'Unrecognized (raw) events kept', zh: '未识别事件(raw)的保留量' },
  'settings.workflow.maxParallel': { en: 'Max parallel nodes (1–4)', zh: '并发节点上限 (1–4)' },
  'settings.workflow.maxParallel.hint': { en: 'Conservative for 16GB RAM + API rate limits', zh: '16GB 内存 + API 限流下的保守值' },
  'settings.workflow.inlineLimitBytes': { en: 'Upstream output inline cap (bytes)', zh: '上游产出内联上限 (字节)' },
  'settings.workflow.inlineLimitBytes.hint': { en: 'Overflow injects a file path downstream instead', zh: '超出改为向下游注入文件路径' },
  'settings.uiTitle': { en: 'Interface & Shortcuts', zh: '界面与快捷键' },
  'settings.languageHint': { en: 'Applies to the whole UI after you save. English is the default for overseas users.', zh: '保存后全局生效。默认英文,方便海外用户。' },
  'settings.recording': { en: '…press keys', zh: '…请按键' },
  'settings.recordHint': { en: 'Click, then press the new key combination', zh: '点击后按下新的组合键' },
  'settings.change': { en: 'Change', zh: '改键' },
  'settings.cancel': { en: 'Cancel', zh: '取消' },
  'settings.resetHint': { en: 'Restore the default key(s)', zh: '恢复默认键位' },

  /* ---- 快捷键帮助浮层(sc.*,v0.6.6) ---- */
  'sc.title': { en: 'Keyboard shortcuts', zh: '快捷键' },
  'sc.sub': { en: 'While typing in an input, only combos with a modifier key still work', zh: '输入框里打字时,只有带修饰键的组合仍然生效' },
  'sc.close': { en: 'Close (Esc)', zh: '关闭 (Esc)' },
  'sc.searchPlaceholder': { en: 'Search keys, names or hints, e.g. “zoom”, “Ctrl+S”, “save”', zh: '搜按键、名称或说明,比如「缩放」「Ctrl+S」「保存」' },
  'sc.clear': { en: 'Clear search', zh: '清空搜索' },
  'sc.none': { en: 'No shortcut matches “{q}”.', zh: '没有匹配「{q}」的快捷键。' },
  'sc.mouse': { en: 'Mouse operations', zh: '鼠标操作' },
  'sc.mouse.drag': { en: 'Drag a node', zh: '拖动节点' },
  'sc.mouse.drag.hint': { en: 'Position is saved with the canvas', zh: '位置会随画布一起存盘' },
  'sc.mouse.connect': { en: 'Pull the right dot to connect', zh: '拖右侧圆点连线' },
  'sc.mouse.connect.hint': { en: 'Wrong-direction links are rejected on the spot with a reason', zh: '方向不对的连线会被当场拒绝并说明原因' },
  'sc.mouse.cutEdge': { en: 'Hover an edge and press the cut key', zh: '鼠标移到线上按剪断键' },
  'sc.mouse.cutEdge.hint': { en: 'You can also select the edge and press Delete', zh: '也可以点选连线后按 Delete' },
  'sc.mouse.rename': { en: 'Double-click a node title', zh: '双击节点标题' },
  'sc.mouse.rename.hint': { en: 'Rename in place, no need for the config panel', zh: '就地改名,不用跑到右栏的配置页' },
  'sc.mouse.pan': { en: 'Scroll to pan the canvas', zh: '滚轮上下平移画布' },
  'sc.mouse.box': { en: 'Drag on empty canvas to multi-select', zh: '空白处拖拽框选' },
  'sc.mouse.box.hint': { en: 'Move / delete the selection together', zh: '选中后可一起拖动 / 删除' },
  'sc.foot': { en: 'Press Esc to close layers · this table renders the live keymap, same source as real behavior', zh: '按 Esc 逐层关闭浮层 · 这份表由当前键位直接渲染,与真实行为同源' },

  /* ---- 快捷键分组(帮助浮层) ---- */
  'group.run': { en: 'Run', zh: '运行' },
  'group.edit': { en: 'Edit', zh: '编辑' },
  'group.view': { en: 'View', zh: '视图' },
  'group.nav': { en: 'Navigate', zh: '导航' },
  'shortcut.run-all': { en: 'Run the whole graph', zh: '跑完整张图' },
  'shortcut.run-all.hint': { en: 'In connection order; same as “Run all”', zh: '按连线顺序,与运行条的「▶ 跑全部」等价' },
  'shortcut.run-selected': { en: 'Run selected node', zh: '只跑选中节点' },
  'shortcut.run-selected.hint': { en: 'Runs its upstream too', zh: '连同它的上游一起跑' },
  'shortcut.cancel-run': { en: 'Cancel current run', zh: '取消当前运行' },
  'shortcut.save': { en: 'Save canvas now', zh: '立即保存画布' },
  'shortcut.save.hint': { en: 'Normally auto-saved every 500ms; this writes immediately', zh: '平时是 500ms 自动存盘,这个是"现在就写"' },
  'shortcut.undo': { en: 'Undo', zh: '撤销' },
  'shortcut.undo.hint': { en: 'Nodes / edges / drags / config edits, up to 50 steps', zh: '加删节点 / 连线 / 拖动 / 改配置都可回退,最多 50 步' },
  'shortcut.redo': { en: 'Redo', zh: '重做' },
  'shortcut.redo.hint': { en: 'Re-do the last undone step', zh: '把刚撤销的那一步再做回来' },
  'shortcut.delete-node': { en: 'Delete selected node / cut selected edge', zh: '删除选中的节点 / 切断选中的连线' },
  'shortcut.delete-node.hint': { en: 'Edge cuts immediately; node asks once and interrupts a running node', zh: '连线直接断;节点会问一次,运行中会先中断' },
  'shortcut.add-node': { en: 'Add node', zh: '添加节点' },
  'shortcut.add-node.hint': { en: '↑↓ to pick, Enter to confirm, number keys direct-pick', zh: '菜单里 ↑↓ 选,Enter 确认,数字键直选' },
  'shortcut.focus-composer': { en: 'Talk to selected node', zh: '给选中节点说话' },
  'shortcut.focus-composer.hint': { en: 'Focus the right-panel input', zh: '把光标送进右栏输入框' },
  'shortcut.duplicate-node': { en: 'Duplicate selected node', zh: '复制选中节点' },
  'shortcut.duplicate-node.hint': { en: 'Copies the node + its outgoing edges, offset to the right', zh: '复制节点及其出边,向右偏移摆放' },
  'shortcut.rename-node': { en: 'Rename selected node', zh: '重命名选中节点' },
  'shortcut.rename-node.hint': { en: 'Same as double-clicking the title', zh: '等价于双击标题' },
  'shortcut.cut-edge': { en: 'Cut edge under cursor', zh: '剪断鼠标下的连线' },
  'shortcut.cut-edge.hint': { en: 'Hover an edge, then press the key', zh: '鼠标移到线上,按该键剪断' },
  'shortcut.fit-view': { en: 'Zoom to fit', zh: '缩放到刚好装下' },
  'shortcut.chat-tab': { en: 'Switch to Chat tab', zh: '切到对话页' },
  'shortcut.chat-tab.hint': { en: 'For the selected node', zh: '选中节点的对话页' },
  'shortcut.config-tab': { en: 'Switch to Node config tab', zh: '切到节点配置页' },
  'shortcut.config-tab.hint': { en: 'For the selected node', zh: '选中节点的配置页' },
  'shortcut.toggle-workspace': { en: 'Switch workspace', zh: '切换工作区' },
  'shortcut.toggle-workspace.hint': { en: 'App Builder ↔ Image Generation', zh: '软件制作 ↔ 生图' },
  'shortcut.shortcuts-help': { en: 'Open/close this shortcut table', zh: '打开/关闭这份快捷键表' },
  'shortcut.settings': { en: 'Open settings', zh: '打开设置' },
  'shortcut.toggle-skills': { en: 'Open/close skill manager', zh: '打开/关闭技能管理器' },
  'shortcut.export-workflow': { en: 'Export workflow JSON', zh: '导出工作流 JSON' },
  'shortcut.import-workflow': { en: 'Import workflow JSON', zh: '导入工作流 JSON' },
  'shortcut.focus-project': { en: 'Focus project switcher', zh: '聚焦项目切换器' },
  'shortcut.escape': { en: 'Close overlay / back to canvas', zh: '关闭浮层 / 回到画布' },
  'shortcut.escape.hint': { en: 'Layer by layer: overlay → menu → deselect', zh: '逐层关:浮层 → 菜单 → 取消选中' },

  /* ---- 节点显示名(添加菜单 / 卡片,en 覆盖;zh 直接用注册表中文) ---- */
  'node.project': { en: 'Project', zh: '' },
  'node.feature': { en: 'Feature', zh: '' },
  'node.review': { en: 'Review', zh: '' },
  'node.test': { en: 'Test', zh: '' },
  'node.doc': { en: 'Document', zh: '' },
  'node.output': { en: 'Output', zh: '' },
  'node.image': { en: 'Image', zh: '' },
  'node.handoff': { en: 'Handoff', zh: '' },
  'node.game': { en: 'Game', zh: '' },
  'node.video': { en: 'Video', zh: '' },
  'node.agent': { en: 'Agent', zh: '' },
  'node.router': { en: 'Router', zh: '' },
  'node.chart': { en: 'Chart', zh: '' },
  'node.python': { en: 'Python', zh: '' },
  'node.subgraph': { en: 'Subgraph', zh: '' },
  'node.merge': { en: 'Merge', zh: '' },
  'node.gate': { en: 'Gate', zh: '' },
  'node.lint': { en: 'Lint', zh: '' },
  'node.git': { en: 'Git', zh: '' },
  'node.deps': { en: 'Dependencies', zh: '' },
  'node.context': { en: 'Context', zh: '' },
  'node.contract': { en: 'Contract', zh: '' },
  'node.cost': { en: 'Cost', zh: '' },
  'node.diff': { en: 'Diff', zh: '' },
  'node.deploy': { en: 'Deploy', zh: '' },
  'node.prompt': { en: 'Positive prompt', zh: '' },
  'node.prompt_negative': { en: 'Negative prompt', zh: '' },
  'node.sampler': { en: 'Sampler', zh: '' },
  'node.image_output': { en: 'Image output', zh: '' },
}

/** 当前语言。settings 未加载时默认 en(海外优先) */
export function currentLang(): Lang {
  return useSettingsStore.getState().payload?.current?.ui?.language ?? 'en'
}

/**
 * 类型角标的英文名(zh 模式回原文)。注册表的 badge.text 是中文短词
 * (项目 / 串行 / 并行 / 整合 / 输出…),英文界面下用这张表覆盖。
 */
const NODE_BADGE_EN: Record<string, string> = {
  项目: 'Project',
  串行: 'Serial',
  并行: 'Parallel',
  整合: 'Merge',
  输出: 'Output',
  图像: 'Image',
  审查: 'Review',
  测试: 'Test',
  闸门: 'Gate',
  静态检查: 'Lint',
  版本控制: 'Git',
  交接: 'Handoff',
  游戏: 'Game',
  视频: 'Video',
  文档: 'Docs',
  图表: 'Chart',
  智能体: 'Agent',
  路由: 'Router',
  子图: 'Subgraph',
  提示词: 'Prompt',
  正向提示词: 'Prompt',
  负向提示词: 'Negative',
  图片输出: 'Image Out',
  Python: 'Python',
}

export function badgeText(text: string): string {
  if (currentLang() === 'zh') return text
  return NODE_BADGE_EN[text] ?? text
}

/** 翻译。缺键 / 缺译文时回退 fallback(组件给的默认文案);{var} 由 vars 替换 */
export function t(key: string, fallback = '', vars?: Record<string, string>): string {
  const hit = DICT[key]
  let out: string
  if (!hit) out = fallback || key
  else {
    const lang = currentLang()
    out = hit[lang] || hit.en || fallback || key
  }
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v)
  }
  return out
}

/** 节点添加菜单 / 卡片显示的英文名:en 用字典,zh 用注册表原文(中文) */
export function nodeEntryLabel(kind: string, registryLabel: string): string {
  if (currentLang() === 'en') return t(`node.${kind}`, registryLabel)
  return registryLabel
}

/** 订阅语言变化的 hook(顶栏语言入口等)。返回 { lang, t } */
export function useLang(): { lang: Lang; t: typeof t } {
  // zustand 选择器返回原始类型,Object.is 比较安全
  useSettingsStore((s) => s.payload?.current?.ui?.language)
  return { lang: currentLang(), t }
}
