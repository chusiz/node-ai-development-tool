/**
 * 生成应用图标 build/icon.ico(以及一张 256 的 PNG 供预览)。
 *
 * 为什么手写编码器而不是装 sharp/pngjs:
 *   - 图标是一次性的构建资产,为它往 devDependencies 里塞一个原生图像库
 *     (还有各平台的预编译二进制)不划算;
 *   - 图形本身极简(圆角底 + 三颗节点 + 两条连线),像素级算术足够,
 *     PNG 就是 zlib + 扫描线,node 自带 zlib。
 *
 * 图形语义:画布上的一条流水线 —— 左上「项目」→ 右上「并行」→ 下方「整合」,
 * 与产品本身是同一个隐喻。
 *
 * 用法:node scripts/makeIcon.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const OUT_DIR = path.resolve(import.meta.dirname, '..', 'build')

/* ---------------- 画布 ---------------- */

const SIZE = 256

/** 直接把像素画在一个 Float 数组里(0..1 的 RGBA),最后再量化成 8bit */
function createCanvas(n) {
  return { n, px: new Float64Array(n * n * 4) }
}

function blend(canvas, x, y, [r, g, b], a) {
  if (a <= 0 || x < 0 || y < 0 || x >= canvas.n || y >= canvas.n) return
  const i = (y * canvas.n + x) * 4
  const p = canvas.px
  const na = a + p[i + 3] * (1 - a)
  if (na <= 0) return
  p[i] = (r * a + p[i] * p[i + 3] * (1 - a)) / na
  p[i + 1] = (g * a + p[i + 1] * p[i + 3] * (1 - a)) / na
  p[i + 2] = (b * a + p[i + 2] * p[i + 3] * (1 - a)) / na
  p[i + 3] = na
}

/** 圆角矩形的覆盖率(解析法:按到圆角中心的距离算,边缘 1px 抗锯齿) */
function roundRectCoverage(x, y, cx, cy, w, h, r) {
  const dx = Math.abs(x + 0.5 - cx) - (w / 2 - r)
  const dy = Math.abs(y + 0.5 - cy) - (h / 2 - r)
  const ox = Math.max(dx, 0)
  const oy = Math.max(dy, 0)
  const d = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0) - r
  return Math.min(Math.max(0.5 - d, 0), 1)
}

/** 线段的覆盖率:点到线段的距离,沿法向 1px 软化 */
function segmentCoverage(x, y, x1, y1, x2, y2, halfWidth) {
  const px = x + 0.5
  const py = y + 0.5
  const vx = x2 - x1
  const vy = y2 - y1
  const wx = px - x1
  const wy = py - y1
  const len2 = vx * vx + vy * vy || 1
  const t = Math.min(Math.max((wx * vx + wy * vy) / len2, 0), 1)
  const dx = wx - vx * t
  const dy = wy - vy * t
  const d = Math.sqrt(dx * dx + dy * dy) - halfWidth
  return Math.min(Math.max(0.5 - d, 0), 1)
}

const hex = (s) => [
  parseInt(s.slice(1, 3), 16) / 255,
  parseInt(s.slice(3, 5), 16) / 255,
  parseInt(s.slice(5, 7), 16) / 255,
]

function draw() {
  const c = createCanvas(SIZE)
  const BG_TOP = hex('#1b212c')
  const BG_BOT = hex('#0d1017')
  const BORDER = hex('#39465a')
  const WIRE = hex('#3f5a86')
  const NODE = hex('#6ea8fe')
  const NODE_WARM = hex('#e2a95c')
  const NODE_GOOD = hex('#5fd39b')
  const M = 12 // 外边距,给 Windows 的图标阴影留一点呼吸

  // 底:圆角方 + 竖向渐变
  for (let y = 0; y < SIZE; y++) {
    const t = y / (SIZE - 1)
    const col = [
      BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t,
      BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t,
      BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t,
    ]
    for (let x = 0; x < SIZE; x++) {
      const cov = roundRectCoverage(x, y, SIZE / 2, SIZE / 2, SIZE - M * 2, SIZE - M * 2, 52)
      if (cov > 0) blend(c, x, y, col, cov)
    }
  }

  // 描边:比底色亮一档的 1px 环(画一圈略大的圆角方,再抠掉内部)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const outer = roundRectCoverage(x, y, SIZE / 2, SIZE / 2, SIZE - M * 2, SIZE - M * 2, 52)
      const inner = roundRectCoverage(x, y, SIZE / 2, SIZE / 2, SIZE - M * 2 - 3.2, SIZE - M * 2 - 3.2, 50)
      const ring = Math.max(outer - inner, 0)
      if (ring > 0) blend(c, x, y, BORDER, ring * 0.9)
    }
  }

  // 三颗节点:左上(项目)/ 右上(并行)/ 正下(整合)
  const A = { x: 78, y: 84 }
  const B = { x: 178, y: 84 }
  const C = { x: 128, y: 178 }
  const NW = 46
  const NH = 34

  // 连线先画,节点压在它上面 —— 接线点就不会从卡片里漏出来
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const w1 = segmentCoverage(x, y, A.x + 22, A.y, B.x - 22, B.y, 2.6)
      const w2 = segmentCoverage(x, y, A.x, A.y + 15, C.x - 14, C.y - 10, 2.6)
      const w3 = segmentCoverage(x, y, B.x, B.y + 15, C.x + 14, C.y - 10, 2.6)
      const w = Math.max(w1, w2, w3)
      if (w > 0) blend(c, x, y, WIRE, w)
    }
  }

  const nodes = [
    { p: A, col: NODE },
    { p: B, col: NODE_WARM },
    { p: C, col: NODE_GOOD },
  ]
  for (const { p, col } of nodes) {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        // 卡片本体(比连线亮,让"节点"明显是实体)
        const card = roundRectCoverage(x, y, p.x, p.y, NW, NH, 9)
        if (card > 0) blend(c, x, y, hex('#232b38'), card)
        // 左侧那条类型色条 —— 对应画布上每种节点左边的 3px 竖条
        const bar = roundRectCoverage(x, y, p.x - NW / 2 + 4.5, p.y, 5, NH - 8, 2.5)
        if (bar > 0) blend(c, x, y, col, bar)
        const frame = roundRectCoverage(x, y, p.x, p.y, NW, NH, 9)
        const frameIn = roundRectCoverage(x, y, p.x, p.y, NW - 2.4, NH - 2.4, 8)
        const ring = Math.max(frame - frameIn, 0)
        if (ring > 0) blend(c, x, y, col, ring * 0.55)
      }
    }
  }

  return c
}

/* ---------------- 缩放(盒式滤波) ---------------- */

function resample(c, size) {
  const out = new Float64Array(size * size * 4)
  const scale = c.n / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      const x0 = Math.floor(x * scale)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale))
      const y0 = Math.floor(y * scale)
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale))
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * c.n + sx) * 4
          const sa = c.px[i + 3]
          // 预乘 alpha 再平均,否则半透明边缘会把颜色往黑里带
          r += c.px[i] * sa
          g += c.px[i + 1] * sa
          b += c.px[i + 2] * sa
          a += sa
          n++
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        out[o] = r / a
        out[o + 1] = g / a
        out[o + 2] = b / a
      }
      out[o + 3] = a / n
    }
  }
  return out
}

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng(px, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      raw[o++] = Math.round(Math.min(Math.max(px[i], 0), 1) * 255)
      raw[o++] = Math.round(Math.min(Math.max(px[i + 1], 0), 1) * 255)
      raw[o++] = Math.round(Math.min(Math.max(px[i + 2], 0), 1) * 255)
      raw[o++] = Math.round(Math.min(Math.max(px[i + 3], 0), 1) * 255)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---------------- ICO 封装 ---------------- */

/**
 * ICO = 目录 + 若干图。Vista 起允许每一项直接塞 PNG(32bpp),
 * 这样就不必自己写 BMP 的 AND 掩码 —— Windows 10/11 完全支持。
 * 256 的宽高字段写 0,这是 ICO 格式的历史约定。
 */
function encodeIco(entries) {
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(entries.length, 4)
  const tables = []
  let offset = 6 + entries.length * 16
  for (const e of entries) {
    const t = Buffer.alloc(16)
    t[0] = e.size >= 256 ? 0 : e.size
    t[1] = e.size >= 256 ? 0 : e.size
    t[2] = 0
    t[3] = 0
    t.writeUInt16LE(1, 4)
    t.writeUInt16LE(32, 6)
    t.writeUInt32LE(e.png.length, 8)
    t.writeUInt32LE(offset, 12)
    tables.push(t)
    offset += e.png.length
  }
  return Buffer.concat([dir, ...tables, ...entries.map((e) => e.png)])
}

/* ---------------- 跑 ---------------- */

const canvas = draw()
fs.mkdirSync(OUT_DIR, { recursive: true })

const png256 = encodePng(resample(canvas, 256), 256)
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png256)

const sizes = [16, 24, 32, 48, 64, 128, 256]
const entries = sizes.map((size) => ({
  size,
  png: size === 256 ? png256 : encodePng(resample(canvas, size), size),
}))
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(entries))

console.log(`icon.png  ${png256.length} bytes`)
console.log(`icon.ico  ${fs.statSync(path.join(OUT_DIR, 'icon.ico')).size} bytes (${sizes.join('/')})`)
