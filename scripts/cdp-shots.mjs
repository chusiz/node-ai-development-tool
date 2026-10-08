/* CDP 截图采集:驱动真实应用到各场景并保存 PNG(自包含:spawn→截→杀) */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const PORT = 9334
const LIST_URL = `http://localhost:${PORT}/json/list`
const OUT = 'screenshots'

function rpc(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== id) return
      ws.removeEventListener('message', onMsg)
      if (m.error) reject(new Error(JSON.stringify(m.error)))
      else resolve(m.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitPort(timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(LIST_URL); if (r.ok) return } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('port never came up')
}

async function main() {
  const electronExe = 'node_modules/electron/dist/electron.exe'
  const child = spawn(electronExe, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.on('data', () => { /* 忽略 Electron 噪声 */ })

  try {
    await waitPort(60000)
    mkdirSync(OUT, { recursive: true })

    const list = await (await fetch(LIST_URL)).json()
    const page = list.find((t) => t.type === 'page')
    if (!page) throw new Error('no page target')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let seq = 0
    const call = (method, params) => rpc(ws, ++seq, method, params)

    for (let i = 0; i < 40; i++) {
      const r = await call('Runtime.evaluate', { expression: `!!document.querySelector('.app')`, returnByValue: true })
      if (r.result.value) break
      await sleep(500)
    }
    const evalJs = async (expr) => {
      const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) return { __err: r.exceptionDetails.text }
      return r.result.value
    }
    const shot = async (name) => {
      const r = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      writeFileSync(`${OUT}/${name}`, Buffer.from(r.data, 'base64'))
      console.log('SHOT', name)
    }

    // 0) 等画布渲染稳定
    await sleep(2500)

    // 1) 主画布(软件制作,已有节点)
    await evalJs(`document.querySelector('.ws-tab[aria-label="软件制作"]')?.click()`)
    await sleep(1500)
    await shot('01-software-canvas.png')

    // 2) 选中第一个节点 → Inspector 显示 agent + 模型徽标
    await evalJs(`(() => {
      const n = document.querySelector('.react-flow__node')
      if (!n) return false
      const r = n.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x, clientY: y, button: 0 }))
      return true
    })()`)
    await sleep(1200)
    await shot('02-inspector-agent-model.png')

    // 3) 添加节点菜单(滚动修复后可见全部)
    await evalJs(`document.querySelector('.add-wrap button')?.click()`)
    await sleep(800)
    await shot('03-add-node-menu.png')
    await evalJs(`document.querySelector('.add-wrap button')?.click()`) // 关掉

    // 4) 节点配置页
    await evalJs(`(() => {
      const t = document.querySelector('.inspector .tabs button:nth-child(2)')
      if (t) t.click()
      return true
    })()`)
    await sleep(900)
    await shot('04-node-config.png')
    await evalJs(`(() => {
      const t = document.querySelector('.inspector .tabs button:nth-child(1)')
      if (t) t.click()
      return true
    })()`)

    // 5) 生图工作区
    await evalJs(`document.querySelector('.ws-tab[aria-label="生图"]')?.click()`)
    await sleep(1500)
    await shot('05-image-workspace.png')

    // 6) 设置面板(模型服务)
    await evalJs(`document.querySelector('button[aria-label*="设置"]')?.click()`)
    await sleep(1200)
    await shot('06-settings.png')

    ws.close()
  } finally {
    child.kill()
    setTimeout(() => process.exit(0), 1500)
  }
}

main().catch((e) => { console.error('ERR', e); try { process.exit(1) } catch {} })
