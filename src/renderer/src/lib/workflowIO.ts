import { useGraphStore } from '../stores/graphStore'

/**
 * 工作流 JSON 的导出 / 导入(v0.6.6 起与快捷键 Ctrl+E / Ctrl+I 共用)。
 *
 * 从 Canvas 的「工作流」菜单里抽出来:同一套走对话框的流程,菜单按钮和
 * 快捷键各调一次,不会出现"按钮能导出、快捷键导出不了"的漂移。
 * 用户反馈用 alert 提示 —— 与菜单里原来的行为保持一致,不做静默。
 */

export async function exportWorkflowFile(): Promise<void> {
  const res = await window.api.dialog.saveFile(
    'Export workflow',
    'workflow.json',
    [{ name: 'Node AI Development Tool workflow', extensions: ['json'] }],
  )
  if (!res.ok || !res.data) return
  const path = res.data
  const ok = await window.api.fs.writeText(path, useGraphStore.getState().exportWorkflow())
  if (ok.ok) alert(`Workflow exported: ${path}`)
  else alert(`Export failed: ${ok.error ?? 'unknown error'}`)
}

export async function importWorkflowFile(): Promise<void> {
  const res = await window.api.dialog.pickFile('Import workflow', [
    { name: 'Node AI Development Tool workflow', extensions: ['json'] },
    { name: 'All files', extensions: ['*'] },
  ])
  if (!res.ok || !res.data) return
  const path = res.data
  const rd = await window.api.fs.readText(path)
  if (!rd.ok) {
    alert(`Read failed: ${rd.error ?? 'unknown error'}`)
    return
  }
  const imp = useGraphStore.getState().importWorkflow(rd.data)
  alert(
    imp.ok
      ? `Workflow imported (${useGraphStore.getState().nodes.length} nodes)`
      : (imp.error ?? 'Import failed'),
  )
}
