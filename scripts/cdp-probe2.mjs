/* CDP 自包含探针:spawn electron → 等端口 → 在真实画布上测输入框 → 结束 */
import { spawn } from 'node:child_process'

const LIST_URL = 'http://localhost:9333/json/list'
const PORT = 9333

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
    try {
      const r = await fetch(LIST_URL)
      if (r.ok) return
    } catch { /* not yet */ }
    await sleep(400)
  }
  throw new Error('port never came up')
}

async function main() {
  // 直接用 electron.exe(不用 npx 链),kill 才能杀到真进程
  const electronExe = 'node_modules/electron/dist/electron.exe'
  const child = spawn(electronExe, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.on('data', (d) => process.stdout.write('[app-err] ' + d))

  try {
    await waitPort(60000)

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

    const overview = await evalJs(`(() => {
      const nodes = document.querySelectorAll('.react-flow__node').length
      const emptyBtn = !!document.querySelector('.canvas-empty button.primary')
      const tabs = [...document.querySelectorAll('.tabs button')].map(b => b.textContent.trim())
      return { nodeCount: nodes, emptyBtn, tabs, title: document.title }
    })()`)
    console.log('OVERVIEW', JSON.stringify(overview))

    // 点第一个节点(完整的 pointer/mouse 序列,模拟真实点击)
    const clicked = await evalJs(`(() => {
      const node = document.querySelector('.react-flow__node')
      if (!node) return 'no-node'
      const r = node.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        node.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }))
      }
      return 'clicked-node'
    })()`)
    console.log('CLICK', clicked)
    await sleep(1200)

    const check = await evalJs(`(() => {
      const ta = document.querySelector('.inspector .composer textarea')
      if (!ta) return { rendered: false }
      const r = ta.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return {
        rendered: true,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        disabled: ta.disabled,
        readOnly: ta.readOnly,
        tabIndex: ta.tabIndex,
        topElement: top ? top.tagName + '.' + String(top.className).slice(0, 40) : null,
        inViewport: r.top >= 0 && r.bottom <= innerHeight,
      }
    })()`)
    console.log('INPUT', JSON.stringify(check, null, 2))

    // CDP 真实鼠标点击输入框中心,验证焦点是否真的落进去
    if (check.rendered && check.rect) {
      const x = Math.round(check.rect.x + check.rect.w / 2)
      const y = Math.round(check.rect.y + check.rect.h / 2)
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await sleep(300)
      const focus = await evalJs(`(() => {
        const a = document.activeElement
        return a ? a.tagName + '.' + String(a.className).slice(0, 40) + ' @' + (a === document.querySelector('.inspector .composer textarea') ? 'TEXTAREA' : 'OTHER') : null
      })()`)
      console.log('REAL_CLICK_FOCUS', JSON.stringify(focus))
    }

    // 采样输入框一行,确认无覆盖
    const cover = await evalJs(`(() => {
      const ta = document.querySelector('.inspector .composer textarea')
      if (!ta) return null
      const r = ta.getBoundingClientRect()
      const probe = (x, y) => {
        const el = document.elementFromPoint(x, y)
        if (!el) return null
        const cs = getComputedStyle(el)
        return { tag: el.tagName, cls: String(el.className).slice(0, 40), pe: cs.pointerEvents, zi: cs.zIndex, pos: cs.position }
      }
      return [0.15, 0.4, 0.6, 0.85].map((f) => probe(r.left + r.width * f, r.top + r.height / 2))
    })()`)
    console.log('COVER', JSON.stringify(cover))

    // 有没有节点处于 running / 有多少节点
    const runState = await evalJs(`(() => {
      const el = document.querySelector('.inspector .badge')
      return el ? el.textContent : null
    })()`)
    console.log('RUNSTATE', JSON.stringify(runState))

    ws.close()
  } finally {
    child.kill()
    // 强制退出:electron 子进程即使没被杀干净,stdio 也可能吊着事件循环
    setTimeout(() => process.exit(0), 1500)
  }
}

main().catch((e) => { console.error('ERR', e); try { process.exit(1) } catch {} })
