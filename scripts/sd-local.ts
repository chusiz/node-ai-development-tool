/**
 * 本地生图服务命令行工具(v0.4.2):status / start / stop。
 * 用法:npm run sd:status | sd:start | sd:stop(或 node .tmp/sd-local.cjs <cmd>)
 */
import { initPaths } from '../src/main/paths'
initPaths()
import { sdStatus, sdStart, sdStop } from '../src/main/localservices'

const cmd = process.argv[2] ?? 'status'

async function main(): Promise<void> {
  if (cmd === 'status') {
    const s = await sdStatus()
    console.log(
      `running=${s.running} port=${s.port} dir=${s.dir ?? '(未找到)'} models=${s.models.join('、') || '-'}`,
    )
    console.log(`pythonPath=${s.pythonPath ?? '(未找到)'}`)
    console.log(`checkpoint=${s.checkpoint ?? '(未找到)'}`)
    console.log(`直出预设: pythonPath + checkpoint 即「本地模型直出」模式使用的运行时与模型;若整合包已删,仍可直出`)
  } else if (cmd === 'start') {
    const s = await sdStart(7860)
    console.log(
      `started=${s.started} running=${s.running} models=${s.models.join('、') || '-'}` +
        (s.error ? ` error=${s.error}` : ''),
    )
  } else if (cmd === 'stop') {
    const r = await sdStop()
    console.log(r.message)
  } else {
    console.log('usage: sd-local.cjs [status|start|stop]')
  }
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
