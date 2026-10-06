/**
 * 实测「关 GPU」到底省了多少内存。
 *
 * 设计原则:**量,而不是承诺**。各 Chromium 开关在不同 Electron/Chromium 版本下的
 * 实际收益会变,写死在文档里的数字迟早是错的。这个脚本跑两次真实进程
 * (disableGpu=true / false),把 app.getAppMetrics() 的读数摆在一起。
 *
 * 用法: npm run probe
 *   (前置:npm run build 已跑过;脚本里也会自动 build)
 *
 * ⚠️ 两次运行之间会临时改写 data/settings.json,结束时**原样还原**
 *    (原本不存在就删掉,回到默认值)。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
// 纯 Node 下 require('electron') 返回的是可执行文件路径字符串,不是模块
const electronExe = require('electron')

const ROOT = path.resolve(import.meta.dirname, '..')
const SETTINGS = path.join(ROOT, 'data', 'settings.json')
/*
 * 体检里的「节点模型选择」会**真的造一个节点再删掉**（只有画布为空时才造）。
 * 期间画布会自动存盘,所以这里连默认画布一起备份/还原 ——
 * 一个探针留下用户数据的变化,比不测还糟。
 */
const CANVAS_GRAPH = path.join(ROOT, 'data', 'canvases', 'default', 'graph.json')

function runProbe(label, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(electronExe, ['.'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    })

    let out = ''
    p.stdout.on('data', (d) => {
      out += d
    })
    p.stderr.on('data', (d) => process.stderr.write(`  [${label} stderr] ${d}`))

    p.on('error', reject)
    p.on('close', () => {
      /*
       * 布局体检的行必须**原样透出来**。
       * 只挑 PROBE 那一行的话,LAYOUT FAIL 会被静默吞掉 —— 一条不会喊的检查
       * 等于没有检查(上一版就是这么被埋掉的)。
       */
      const lay = /LAYOUT (OK|FAIL) (.*)/.exec(out)
      if (lay) console.log(`  [${label}] 布局体检 ${lay[1]} — ${lay[2]}`)

      const insp = /INSPECTOR (OK|FAIL) (.*)/.exec(out)
      if (insp) console.log(`  [${label}] 右栏体检 ${insp[1]} — ${insp[2]}`)
      const inspText = /INSPECTOR-TEXT (.*)/.exec(out)
      if (inspText) console.log(`  [${label}] 右栏内容   「${inspText[1]}」`)

      const st = /SETTINGS (OK|FAIL) (.*)/.exec(out)
      if (st) console.log(`  [${label}] 设置页体检 ${st[1]} — ${st[2]}`)
      const stText = /SETTINGS-TEXT (.*)/.exec(out)
      if (stText) console.log(`  [${label}] 设置页内容 「${stText[1]}」`)

      const na = /NODEAGENT (OK|FAIL) (.*)/.exec(out)
      if (na) console.log(`  [${label}] 模型选择体检 ${na[1]} — ${na[2]}`)
      // 探针自己核对"造出来的节点有没有真的从磁盘上删掉"
      const disk = /NODEAGENT-DISK (.*)/.exec(out)
      if (disk) console.log(`  [${label}] 残留检查     ${disk[1]}`)

      const ec = /EDGECUT (OK|FAIL) (.*)/.exec(out)
      if (ec) console.log(`  [${label}] 连线切断体检 ${ec[1]} — ${ec[2]}`)

      const mp = /MERGEPANEL (OK|FAIL) (.*)/.exec(out)
      if (mp) console.log(`  [${label}] 整合节点体检 ${mp[1]} — ${mp[2]}`)

      const ui = /UISKIN (OK|FAIL) (.*)/.exec(out)
      if (ui) console.log(`  [${label}] 界面重画体检 ${ui[1]} — ${ui[2]}`)
      for (const m of out.matchAll(/UISKIN-SHOT (.*)/g)) {
        console.log(`  [${label}] 界面截图     ${m[1]}`)
      }

      // 渲染进程报错要透出来,不然"界面上啥都没有"根本看不出病因
      for (const line of out.split(/\r?\n/)) {
        if (line.startsWith('RENDERER-ERR') || line.startsWith('RENDERER-GONE')) {
          console.log(`  [${label}] ${line}`)
        }
      }

      const m = /PROBE (\{.*\})/.exec(out)
      if (!m) {
        console.error(`  [${label}] 没有拿到 PROBE 输出。原始 stdout:\n${out}`)
        resolve(null)
        return
      }
      resolve(JSON.parse(m[1]))
    })
  })
}

function table(a, b) {
  const rows = []
  const byType = (r) => {
    const m = new Map()
    for (const e of r?.metrics ?? []) m.set(e.type, (m.get(e.type) ?? 0) + e.workingSetMb)
    return m
  }
  const A = byType(a)
  const B = byType(b)
  const types = [...new Set([...A.keys(), ...B.keys()])].sort()

  console.log('\n  进程类型         关 GPU      开 GPU      差值')
  console.log('  ' + '-'.repeat(48))
  for (const t of types) {
    const x = A.get(t) ?? 0
    const y = B.get(t) ?? 0
    const d = y - x
    console.log(
      `  ${t.padEnd(16)}${String(x + 'MB').padStart(9)}${String(y + 'MB').padStart(11)}${String((d > 0 ? '+' : '') + d + 'MB').padStart(11)}`,
    )
  }
  console.log('  ' + '-'.repeat(48))
  const ta = a?.totalMb ?? 0
  const tb = b?.totalMb ?? 0
  console.log(
    `  ${'合计'.padEnd(16)}${String(ta + 'MB').padStart(9)}${String(tb + 'MB').padStart(11)}${String((tb - ta > 0 ? '+' : '') + (tb - ta) + 'MB').padStart(11)}`,
  )
  console.log('\n  (正差值 = 开 GPU 更费内存。这是实测值,不是承诺值。)')
}

const backup = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : null
const canvasBackup = fs.existsSync(CANVAS_GRAPH) ? fs.readFileSync(CANVAS_GRAPH, 'utf8') : null

try {
  console.log('▶ 第一次:默认设置(关 GPU)…')
  fs.rmSync(SETTINGS, { force: true })
  const gpuOff = await runProbe('gpu-off', { HAOWAN_PROBE: '1' })

  console.log('▶ 第二次:disableGpu = false(开 GPU)…')
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
  fs.writeFileSync(
    SETTINGS,
    JSON.stringify({ version: 1, memory: { disableGpu: false } }, null, 2),
    'utf8',
  )
  const gpuOn = await runProbe('gpu-on', { HAOWAN_PROBE: '1' })

  if (gpuOff && gpuOn) {
    console.log(`\n关 GPU 模式:${JSON.stringify({ disableGpu: gpuOff.disableGpu })}`)
    table(gpuOff, gpuOn)
  } else {
    process.exitCode = 1
    console.error('\n有一侧没测到,无法对比。')
  }
} finally {
  // 还原用户的设置文件 —— 测完不留痕
  if (backup === null) fs.rmSync(SETTINGS, { force: true })
  else fs.writeFileSync(SETTINGS, backup, 'utf8')
  // 画布同理:体检造过节点(并已删除),这里按原样写回,确保没有被顺手改动
  if (canvasBackup !== null) fs.writeFileSync(CANVAS_GRAPH, canvasBackup, 'utf8')
  console.log('(settings.json 与默认画布已还原)')
}
