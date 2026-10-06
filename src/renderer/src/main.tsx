import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useSettingsStore } from './stores/settingsStore'
// 顺序有讲究:React Flow 的基础样式在最前,我们的主题在后才能覆盖它
import '@xyflow/react/dist/style.css'
import './styles/theme.css'
import './styles/canvas.css'

const el = document.getElementById('root')
if (!el) throw new Error('#root 不存在')

const root = createRoot(el)

/*
 * 先把设置读回来再渲染。
 *
 * 因为 runtimeStore 的消息裁剪上限(maxItemsPerNode 等)取自 settings ——
 * 若先渲染,第一批消息会在兜底默认值下被裁掉一次,拿到真值后**不会长回来**。
 * 一次 invoke 的等待换掉整类"重启后才正常"的怪 bug,值得。
 *
 * load() 内部自己吞异常(失败时只置 error 字段),所以这里不会卡住不渲染。
 */
void useSettingsStore
  .getState()
  .load()
  .then(() => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
