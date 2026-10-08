/* CDP 实证:复现「点输入框没反应」—— 检查输入框位置被谁覆盖、点击后焦点落到哪 */
const LIST_URL = 'http://localhost:9333/json/list'

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

async function main() {
  const list = await (await fetch(LIST_URL)).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let seq = 0
  const call = (method, params) => rpc(ws, ++seq, method, params)

  // 等渲染进程就绪(检测到 .app)
  for (let i = 0; i < 30; i++) {
    const r = await call('Runtime.evaluate', { expression: `!!document.querySelector('.app')`, returnByValue: true })
    if (r.result.value) break
    await sleep(500)
  }

  const evalJs = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true })
    return r.result.value
  }

  // 1) 选中一个节点:有节点就点画布上的节点,空画布就点「+ 放置项目节点」
  const clicked = await evalJs(`(() => {
    const node = document.querySelector('.react-flow__node')
    if (node) { node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 200, clientY: 200 })); node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 200, clientY: 200 })); node.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 200 })); return 'node' }
    const b = document.querySelector('.canvas-empty button.primary')
    if (b) { b.click(); return 'empty-btn' }
    return 'none'
  })()`)
  console.log('CLICKED', clicked)
  await sleep(1500)

  // 2) 输入框现在应该渲染了(配置页也常驻 Composer)
  const info = await evalJs(`(() => {
    const ta = document.querySelector('.inspector .composer textarea')
    if (!ta) return { rendered: false }
    const r = ta.getBoundingClientRect()
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    const top = document.elementFromPoint(cx, cy)
    // 先点一下,再看焦点
    ta.click()
    const afterClick = document.activeElement ? document.activeElement.tagName + '.' + (document.activeElement.className || '') : null
    return {
      rendered: true,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      disabled: ta.disabled,
      pointerEvents: getComputedStyle(ta).pointerEvents,
      topElement: top ? top.tagName + '.' + (typeof top.className === 'string' ? top.className : '') : null,
      topElPointerEvents: top ? getComputedStyle(top).pointerEvents : null,
      afterClick,
      visible: r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0
    }
  })()`)
  console.log('INPUT_CHECK', JSON.stringify(info, null, 2))

  // 3) 检查是否有全屏/大面积的透明覆盖层挡住 inspector 区域
  const cover = await evalJs(`(() => {
    const ta = document.querySelector('.inspector .composer textarea')
    if (!ta) return null
    const r = ta.getBoundingClientRect()
    const probe = (x, y) => {
      const el = document.elementFromPoint(x, y)
      if (!el) return null
      const cs = getComputedStyle(el)
      return { tag: el.tagName, cls: typeof el.className === 'string' ? el.className.slice(0, 60) : '', pe: cs.pointerEvents, zi: cs.zIndex, pos: cs.position, opacity: cs.opacity }
    }
    // 沿输入框一行取 5 个采样点,看 elementFromPoint 都是谁
    const out = []
    for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      out.push(probe(r.left + r.width * fx, r.top + r.height * 0.5))
    }
    return out
  })()`)
  console.log('COVER_CHECK', JSON.stringify(cover, null, 2))

  // 4) 画布上是否有残留探针/浮层
  const floats = await evalJs(`(() => {
    const sel = ['.probe-pop', '.guide-mask', '.guide-fab', '.edge-cut', '.react-flow__edgelabel-renderer', '.react-flow__attribution']
    const out = {}
    for (const s of sel) {
      const els = document.querySelectorAll(s)
      out[s] = els.length
      if (els.length) {
        const el = els[0]
        const r = el.getBoundingClientRect()
        out[s + '_rect'] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), pe: getComputedStyle(el).pointerEvents, zi: getComputedStyle(el).zIndex }
      }
    }
    return out
  })()`)
  console.log('FLOATS_CHECK', JSON.stringify(floats, null, 2))

  ws.close()
}

main().catch((e) => { console.error('ERR', e); process.exit(1) })
