#!/usr/bin/env node
/**
 * 合成"出图脚本" —— imagegen local-command 的 e2e 替身。
 *
 * 它做的事:把 N 张 1×1 PNG 写进 `CANVAS_OUT_DIR`,证明「落盘 → 产物扫描 → 判定」
 * 这条链路真的通了。**不启动任何 LLM、不耗 token、不联网**。
 *
 * ## 为什么读环境变量而不是命令行参数
 *
 * local-command provider 的 S1 约束是"画面描述绝不进命令行"(防命令注入)。它把
 * 画面描述写进临时文件、并用环境变量 `CANVAS_*` 传参。所以这个脚本**也只读
 * `CANVAS_OUT_DIR` / `CANVAS_N` / `CANVAS_SEED`** —— 与真实出图脚本的接口一致,
 * 顺带证明"命令行为里确实不需要出现画面描述"。
 *
 * ## 命令行开关(e2e 用来构造各种边界)
 *
 *   --count K   只写 K 张(默认取 CANVAS_N,再默认 1);用来测"0<产出<n → 成功+警告"
 *   --none      **一张都不写**,正常退出(exit 0);用来测"命令成功但没出图 → 失败"
 *   --sleep MS  写完后挂起 MS 毫秒;用来测"取消能杀掉在跑的出图进程"
 *   --fail      非零退出;用来测"命令失败 → 人话报错"
 */
const fs = require('node:fs')
const path = require('node:path')

/** 1×1 透明 PNG(最小合法 PNG,任何解码器都认得) */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAwAB/9pM3xoAAAAASUVORK5CYII=',
  'base64',
)

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const hasFlag = (name) => process.argv.includes(name)

const outDir = process.env.CANVAS_OUT_DIR
const seed = process.env.CANVAS_SEED || ''
// 张数:命令行 --count 优先,其次环境变量 CANVAS_N,最后 1;夹到 1..8
const rawN = argValue('--count') ?? process.env.CANVAS_N ?? '1'
const n = Math.max(1, Math.min(8, Math.trunc(Number(rawN) || 1)))

if (!outDir) {
  console.error('[mkimage] 没有 CANVAS_OUT_DIR —— 出图脚本需要知道往哪儿写')
  process.exit(2)
}

if (hasFlag('--fail')) {
  console.error('[mkimage] 合成失败:--fail')
  process.exit(3)
}

fs.mkdirSync(outDir, { recursive: true })

if (hasFlag('--none')) {
  // 故意一张都不写:退出码 0,但 outDir 里没有本次新产出(边界:命令成功却没出图)
  console.log('[mkimage] --none:不写任何文件,正常退出')
} else {
  const stamp = Date.now()
  for (let i = 1; i <= n; i++) {
    const name = `img-${stamp}-${String(i).padStart(3, '0')}${seed ? '-' + seed : ''}.png`
    fs.writeFileSync(path.join(outDir, name), PNG_1x1)
  }
  console.log(`[mkimage] 已写入 ${n} 张 1x1 PNG 到 ${outDir}`)
}

const sleepMs = Number(argValue('--sleep') || '0')
if (sleepMs > 0) {
  // 挂起,等 e2e 发取消信号(证明 killProcessTree 真的能杀掉出图子进程)
  setTimeout(() => process.exit(0), sleepMs)
}
