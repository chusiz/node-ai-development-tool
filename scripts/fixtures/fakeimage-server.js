#!/usr/bin/env node
/**
 * 本地假 HTTP 出图服务 —— imagegen http provider 的 e2e 替身。
 *
 * 覆盖两种响应形态(与真实图像服务对齐):
 *   - 默认:OpenAI 兼容的 `{"data":[{"b64_json":"<base64 png>"}]}`(内联 base64);
 *   - `?mode=url`:`{"data":[{"url":"http://127.0.0.1:<port>/img.png"}]}`(图片链接,
 *     由 provider 自行下载落盘)。
 *
 * ## 额外提供 `GET /__last` —— S1 断言的关键
 *
 * provider 把请求体发过来后,服务端把**原始请求体**与**请求头**记下来;e2e 通过
 * `GET /__last` 取回。于是可以直接断言:「注入串经画面描述进到请求体,但请求体
 * 仍是合法 JSON、prompt 字段值与原串逐字相等」—— 证明 JSON 转义没被拼出结构。
 *
 * 端口用 0(系统分配),把实际端口打到 stdout 的 `READY <port>`,由 e2e 读走。
 */
const http = require('node:http')

/** 1×1 透明 PNG(同 mkimage.js) */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAwAB/9pM3xoAAAAASUVORK5CYII=',
  'base64',
)
const PNG_B64 = PNG_1x1.toString('base64')

let lastRawBody = ''
let lastHeaders = {}
let lastUrl = ''

const server = http.createServer((req, res) => {
  // ① 取回"上一次收到的请求"(给 S1 断言用)
  if (req.url === '/__last') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ raw: lastRawBody, headers: lastHeaders, url: lastUrl }))
    return
  }
  // ② url 模式里被引用的图片本体
  if (req.url === '/img.png') {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG_1x1)
    return
  }

  let body = ''
  req.on('data', (c) => {
    body += c
  })
  req.on('end', () => {
    lastRawBody = body
    lastHeaders = req.headers
    lastUrl = req.url
    const mode = new URL(req.url, 'http://127.0.0.1').searchParams.get('mode')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (mode === 'url') {
      const port = server.address().port
      res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${port}/img.png` }] }))
    } else {
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }))
    }
  })
})

server.listen(0, '127.0.0.1', () => {
  // e2e 读这一行拿到实际端口
  console.log(`READY ${server.address().port}`)
})
