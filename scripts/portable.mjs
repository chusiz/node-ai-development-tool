/**
 * 把 electron-builder 产出的 `win-unpacked/` 加工成**绿色版**,并打成一个 zip。
 *
 * 为什么需要这一步(而不是"直接把 win-unpacked 拷过去"):
 *
 *   ① 应用的数据根有四种来源(见 src/main/paths.ts 的 resolveRoot)。
 *      只有 exe 旁边存在 `portable.flag` 时才会用"程序自己的文件夹"当数据根。
 *      NSIS 安装版**不能**带这个文件 —— 它可能被装到 Program Files,
 *      那里默认不可写,数据会写不进去。所以这个标记只能在绿色版里出现。
 *
 *   ② 打包机上的 win-unpacked 是中间产物,下次 `npm run dist` 就被清了。
 *      所以必须复制成另一个名字再压包,压完的 zip 才是可以拿走的交付物。
 *
 * 用法:`npm run dist:portable`
 *
 * 可选:`node scripts/portable.mjs <输出目录>` —— 覆盖默认的 `dist/`。
 * electron-builder 的输出目录可以用 `--config.directories.output=` 改,
 * 这边必须能跟着改,否则"换了输出目录就找不到 win-unpacked"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 默认与 package.json 的 build.directories.output 保持一致,改一处要改两处是有意的:
 *  这里是"脚本侧的唯一默认值",显式写出来比在运行时去读 package.json 更好排查 */
const RELEASE = path.resolve(ROOT, process.argv[2] ?? 'dist')
const SRC = path.join(RELEASE, 'win-unpacked')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
/** zip 内的顶层目录名。带版本号:用户手里可能同时有多个版本,不靠文件夹名区分就会互相覆盖 */
const INNER_DIR = `node-ai-development-tool-${version}-portable`
const ZIP = path.join(RELEASE, `${INNER_DIR}.zip`)

function die(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

if (!fs.existsSync(SRC)) {
  die(`找不到 ${SRC}\n  先跑 "npm run dist"(它会构建并让 electron-builder 产出 win-unpacked)。`)
}

const exe = path.join(SRC, pkg.build?.productName ? `${pkg.build.productName}.exe` : '')
if (!fs.existsSync(exe)) die(`找不到 ${exe} —— win-unpacked 结构不对,检查 build.productName 是否改过。`)

/* ---------- ① 数据根标记 ---------- */

/*
 * 空文件即可。内容写什么都不读 —— 判定条件是 existsSync(见 paths.ts),
 * 留成空文件是为了让人一眼看出"这就是个开关,没有隐藏配置"。
 */
fs.writeFileSync(path.join(SRC, 'portable.flag'), '', 'utf8')
console.log('✓ 已写入 portable.flag(数据将保存在程序目录内的 data\\ 下)')

/* ---------- ② 使用说明 ---------- */

/*
 * UTF-8 **带 BOM**。Windows 记事本对无 BOM 的 UTF-8 在部分版本上会按 GBK 解,
 * 中文直接变乱码 —— 而这份说明就是给"拿到包的人"看的第一个文件,不能乱。
 */
const README = `Node AI Development Tool ${version} · 使用说明
================================================

这是什么
  Node AI Development Tool 是一个节点式 AI 工作台:把「项目 / 串行功能 / 并行功能 / 整合 / 输出打包」
  摆成一张图,按连线顺序跑。它本身只是**图形外壳**,真正干活的是本机安装的
  Claude Code CLI —— 所以它不会被打进这个包里,需要自己装一份(见下)。

选哪种用法
  · 安装版:运行 node-ai-development-tool-${version}-setup.exe。
      装到当前用户目录,自动建桌面/开始菜单快捷方式,可自选安装位置。
      数据默认在 %APPDATA%\\node-ai-development-tool,卸载时不会被删除。
  · 绿色版(本压缩包):把整个文件夹解压到任意位置(桌面、D 盘、U 盘都行),
      双击「node-ai-development-tool.exe」即可,不用安装。
      数据就在同目录的 data\\ 里 —— **拷走整个文件夹,画布和历史一起走**。

前置依赖(必须,否则节点全都跑不起来)
  1) Node.js            https://nodejs.org   装 LTS 版即可
  2) Claude Code CLI    命令行执行:  npm i -g @anthropic-ai/claude-code
     装好后用 \`claude --version\` 能打印版本号就说明好了。

  本应用启动时会自动探测 claude。如果探测不到,顶栏会显示「未检测到 claude」,
  同时画布上方出现一条黄色引导条 —— 点「去设置」,把 claude.exe 的完整路径
  填进「可执行文件路径」并保存,立刻生效(不需要重启)。

  常见的 claude.exe 位置:
    %APPDATA%\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe

数据放在哪
  绿色版:   <本文件夹>\\data\\
  安装版:   %APPDATA%\\node-ai-development-tool\\data\\

  里面是画布(graph.json)、每个节点的会话历史与日志、技能库、设置。
  想换位置:设一个环境变量 CHUSIZ_HOME 指到目标目录再启动(只认绝对路径)。

注意事项
  · **不要**在这个文件夹里做清理。绿色版的数据就在 data\\ 下,删了等于清空所有历史。
  · 重新执行 npm run dist 会整体重建 ${path.basename(RELEASE)}\\win-unpacked ——
    如果你在开发机上是直接跑 win-unpacked 里的 exe,请先把 data\\ 备份出去,
    或者把整个文件夹复制一份再长期使用。
  · 应用依赖本机的 claude CLI,它需要能联网访问模型服务,并且账号有可用额度。
`

fs.writeFileSync(path.join(SRC, '使用说明.txt'), '\ufeff' + README, 'utf8')
console.log('✓ 已写入 使用说明.txt')

/* ---------- ③ 打 zip ---------- */

/*
 * 用 Windows 自带的 bsdtar(System32\tar.exe)。
 *
 * 不用 Git Bash 里那个 GNU tar:`-a` 在 GNU tar 上只会按扩展名挑 gz/bz2/xz,
 * **不认 .zip**,会得到一个名字叫 .zip 的 tar 包 —— 那种包资源管理器打不开。
 * 也不用 PowerShell 的 Compress-Archive:它对 100MB 量级要压好几分钟,
 * 而 bsdtar 走 libarchive,快一个数量级,且是系统自带、零依赖。
 *
 * ⚠️ Windows 版 bsdtar 编译时关掉了 `-s`(路径改写),所以不能靠它把 zip 内的
 * 顶层目录改名。改成**先把目录改名、打完再改回来** —— 效果一样,
 * 而且 zip 里就是 `node-ai-development-tool-<版本>-portable\`,解压出来不会是一个叫
 * win-unpacked 的临时名字。
 */
const TAR = 'C:\\Windows\\System32\\tar.exe'
if (!fs.existsSync(TAR)) die(`找不到 ${TAR}(Windows 10 1803+ 自带)。可改用 PowerShell 的 Compress-Archive 手动打包。`)

fs.rmSync(ZIP, { force: true })

const STAGE = path.join(RELEASE, INNER_DIR)
// 上次崩在中途可能留下同名目录,先清掉(tar 不允许目标已存在)
fs.rmSync(STAGE, { recursive: true, force: true })

let res
try {
  fs.renameSync(SRC, STAGE)
  res = spawnSync(TAR, ['-a', '-c', '-f', ZIP, INNER_DIR], { cwd: RELEASE, stdio: 'inherit' })
} finally {
  // 无论打包成败都要改回去 —— 否则用户 next 次跑 dist 会以为 win-unpacked 不见了
  if (!fs.existsSync(SRC) && fs.existsSync(STAGE)) fs.renameSync(STAGE, SRC)
}
if (!res || res.status !== 0) die(`tar 打包失败(exit ${res ? res.status : 'n/a'})`)

/* ---------- ④ 自检 ---------- */

const zipSize = fs.statSync(ZIP).size
// zip 头必须是 PK\x03\x04 —— 只比体积是不够的,一个 tar 包也能有 90MB
const head = fs.readFileSync(ZIP).subarray(0, 4)
const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
if (!isZip) die('产出物不是合法的 zip(魔数不对)。')

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

/*
 * 自己解析 zip 的中央目录来列条目,而不是再 spawn 一次 tar -tf。
 *
 * 两个原因:① 我们只需要**名字**,不需要解压,读中央目录是纯本地 IO,几十毫秒;
 * ② 实测在本机环境下 `spawnSync(tar, ['-tf', zip], {encoding})` 会因为管道
 * 被拦而报 EBUSY(用 stdio:'inherit' 才能跑通,但那样就拿不到输出做断言了)。
 * 与其依赖一个会变的 shell 行为,不如自己读 —— 顺带还能顺便校验 EOCD 完整性。
 */
const names = listZipEntries(ZIP)
const hasFlag = names.includes(`${INNER_DIR}/portable.flag`)
const hasExe = names.includes(`${INNER_DIR}/${path.basename(exe)}`)
const hasReadme = names.includes(`${INNER_DIR}/使用说明.txt`)

console.log('')
console.log('绿色版打包完成')
console.log(`  压缩包   ${ZIP}   (${mb(zipSize)})
  解出后   ${INNER_DIR}\\  —— 双击里面的「${path.basename(exe)}」直接运行`)
console.log(
  `  自检     zip 结构 ✓ · portable.flag ${hasFlag ? '✓' : '✗'} · 主程序 ${hasExe ? '✓' : '✗'} · 使用说明 ${hasReadme ? '✓' : '✗'}`,
)
console.log(`  条目数   ${names.length}`)

if (!hasFlag || !hasExe || !hasReadme) die('自检未通过:zip 内缺少必要文件。')

/**
 * 读出 zip 里所有条目的名字。
 *
 * 只做只读解析:找 EOCD(End Of Central Directory)拿到中央目录偏移,
 * 然后逐个读 46 字节的定长头 + 变长文件名。不涉及解压,也不需要 ZIP64
 * —— 我们产出的是 130MB 的普通 zip,远够不到 4GB / 65535 项的上限。
 */
function listZipEntries(file) {
  const buf = fs.readFileSync(file)
  // EOCD 签名后面可能有最长 64KB 的注释,所以从尾部往前找
  const EOCD = 0x06054b50
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) die('找不到 zip 的中央目录记录(EOCD),文件可能不完整。')

  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out = []
  const CDH = 0x02014b50
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CDH) die(`第 ${i + 1} 个中央目录条目签名不对,zip 已损坏。`)
    const flags = buf.readUInt16LE(off + 8)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const raw = buf.subarray(off + 46, off + 46 + nameLen)
    out.push(decodeName(raw, flags))
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/**
 * 解出条目名。
 *
 * ZIP 规范里,通用标志位第 11 位(general purpose bit 11)置位才表示文件名是
 * UTF-8;否则按"本地代码页"解。Windows 版 bsdtar **不置这个位**,把中文名按
 * 系统 ANSI 代码页(简中是 GBK)写进去 —— 直接当 UTF-8 读会得到一串 U+FFFD,
 * 于是"使用说明.txt 在不在包里"这个断言会假失败。
 * 所以这里按标志位选解码器,GBK 走 TextDecoder(Node 22 自带 full-icu)。
 */
function decodeName(raw, flags) {
  if (flags & 0x800) return raw.toString('utf8')
  try {
    return new TextDecoder('gbk', { fatal: false }).decode(raw)
  } catch {
    return raw.toString('utf8')
  }
}
