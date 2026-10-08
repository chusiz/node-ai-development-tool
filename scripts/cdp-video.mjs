/* CDP 操作演示视频:驱动真实应用做一段操作,连续截帧 → ffmpeg 合成 mp4 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'

const PORT = 9335
const LIST_URL = `http://localhost:${PORT}/json/list`
const FRAMES = 'screenshots/frames'
const FPS = 5
const FRAME_MS = 200
const TOTAL_FRAMES = 80 // 16s

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
  child.stderr.on('data', () => { /* ignore */ })

  try {
    await waitPort(60000)
    if (existsSync(FRAMES)) rmSync(FRAMES, { recursive: true })
    mkdirSync(FRAMES, { recursive: true })

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
    const snap = async (i) => {
      const r = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      writeFileSync(`${FRAMES}/${String(i).padStart(4, '0')}.png`, Buffer.from(r.data, 'base64'))
    }

    await sleep(2500)

    /* 操作时间轴(帧号 = 拍摄时刻) */
    // 帧 0-10:软件画布静置
    for (let i = 0; i < 10; i++) { await snap(i); await sleep(FRAME_MS) }

    // 帧 10-25:打开添加节点菜单 → 滚动到底部 → 关闭
    await evalJs(`document.querySelector('.add-wrap button')?.click()`)
    for (let i = 10; i < 16; i++) { await snap(i); await sleep(FRAME_MS) }
    await evalJs(`document.querySelector('.add-menu')?.scrollTo(0, 99999)`)
    for (let i = 16; i < 22; i++) { await snap(i); await sleep(FRAME_MS) }
    await evalJs(`document.querySelector('.add-wrap button')?.click()`)
    for (let i = 22; i < 25; i++) { await snap(i); await sleep(FRAME_MS) }

    // 帧 25-35:选中节点,右栏对话 + agent/模型徽标
    await evalJs(`(() => {
      const n = document.querySelector('.react-flow__node')
      if (!n) return false
      const r = n.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x, clientY: y, button: 0 }))
      return true
    })()`)
    for (let i = 25; i < 35; i++) { await snap(i); await sleep(FRAME_MS) }

    // 帧 35-45:切「节点配置」页
    await evalJs(`document.querySelector('.inspector .tabs button:nth-child(2)')?.click()`)
    for (let i = 35; i < 45; i++) { await snap(i); await sleep(FRAME_MS) }
    await evalJs(`document.querySelector('.inspector .tabs button:nth-child(1)')?.click()`)

    // 帧 45-58:切换生图工作区
    await evalJs(`document.querySelector('.ws-tab[aria-label="生图"]')?.click()`)
    for (let i = 45; i < 58; i++) { await snap(i); await sleep(FRAME_MS) }

    // 帧 58-75:打开设置 → 关设置
    await evalJs(`document.querySelector('button[aria-label*="设置"]')?.click()`)
    for (let i = 58; i < 68; i++) { await snap(i); await sleep(FRAME_MS) }
    await evalJs(`(() => {
      const close = document.querySelector('.settings-panel .drawer-head button, .settings-close, .drawer-close')
      if (close) close.click()
      return !!close
    })()`)
    for (let i = 68; i < 75; i++) { await snap(i); await sleep(FRAME_MS) }

    // 帧 75-80:回到软件制作页收尾
    await evalJs(`document.querySelector('.ws-tab[aria-label="软件制作"]')?.click()`)
    for (let i = 75; i < TOTAL_FRAMES; i++) { await snap(i); await sleep(FRAME_MS) }

    console.log('FRAMES_DONE', TOTAL_FRAMES)
    ws.close()
  } finally {
    child.kill()
    setTimeout(() => process.exit(0), 1500)
  }
}

main().catch((e) => { console.error('ERR', e); try { process.exit(1) } catch {} })
