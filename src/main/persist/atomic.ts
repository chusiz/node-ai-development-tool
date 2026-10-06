import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Windows 上 rename 覆盖已存在文件时,若目标正被 Defender 实时扫描或
 * 文件索引器短暂占用,会抛 EPERM / EBUSY。这不是理论问题,是常见现象。
 */
const RENAME_RETRY_MS = [50, 150, 400]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 原子写 JSON:先写同目录的临时文件,再 rename 覆盖。
 *
 * 中途断电时原文件保持完好 —— 要么是旧内容,要么是新内容,不会是半截。
 * (rename 在同一卷内是原子的。)
 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })

  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  const body = JSON.stringify(data)

  const fh = await fsp.open(tmp, 'w')
  try {
    await fh.writeFile(body, 'utf8')
    // 尽力而为的持久化。⚠️ 未实测:Windows 上 FILE_FLUSH_DATA 是否真能绕过
    // SSD 写缓存没有保证,所以不承诺"断电零丢失",只保证"不会写出半截 JSON"。
    await fh.sync().catch(() => {})
  } finally {
    await fh.close()
  }

  let lastErr: unknown
  for (let attempt = 0; attempt <= RENAME_RETRY_MS.length; attempt++) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException).code
      // 只有"被别人占用"值得重试;ENOENT 之类重试多少次都一样
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      if (attempt < RENAME_RETRY_MS.length) await sleep(RENAME_RETRY_MS[attempt])
    }
  }

  await fsp.rm(tmp, { force: true }).catch(() => {})
  throw lastErr
}

/**
 * 同步原子写 JSON(与 writeJsonAtomic 同语义,阻塞版)。
 *
 * ⚠️ 为什么需要同步版:secrets 的 `setKey` 在**返回之前**就要保证"落盘完成"——
 * 调用方(设置页 / fullflow)拿到 `statusFor` 时,写入必须已经生效,否则
 * "刚保存的 Key 立即读不到"就会变成一类幽灵 bug(写得慢、读得快,
 * 行为取决于磁盘时序,极难复现)。同步版只在保存 Key 这类小文件路径用,
 * 每次调用毫秒级,不构成性能问题。
 */
export function writeJsonAtomicSync(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })

  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  const body = JSON.stringify(data)

  fs.writeFileSync(tmp, body, 'utf8')
  let lastErr: unknown
  for (let attempt = 0; attempt <= RENAME_RETRY_MS.length; attempt++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      if (attempt < RENAME_RETRY_MS.length) {
        const t0 = Date.now()
        while (Date.now() - t0 < RENAME_RETRY_MS[attempt]!) {
          /* 忙等(同步版没有 setTimeout 可用) */
        }
      }
    }
  }
  try {
    fs.rmSync(tmp, { force: true })
  } catch {
    /* 忽略 */
  }
  throw lastErr
}

/**
 * 同步读 JSON,永不抛。启动早期(设置、锁文件)用。
 * 需要校验的调用方自己做 schema 解析 —— 这里只管"读不出来就给默认值"。
 */
export function readJsonSafeSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export async function readJsonSafe<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
}

/*
 * 每个文件的追加队列。
 *
 * 没有它的话,同一节点的多条 append 会并发进入 fs.appendFile,
 * 交错的字节会粘成一行坏 JSON。分区保证「同文件按调用顺序落盘」,
 * 不同文件之间仍然并行。
 */
const appendQueues = new Map<string, Promise<void>>()

export function appendLines(file: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return Promise.resolve()

  const body = lines.join('\n') + '\n'
  const prev = appendQueues.get(file) ?? Promise.resolve()

  const next = prev
    .catch(() => {
      /* 前一次失败不能毒死后续写入 */
    })
    .then(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.appendFile(file, body, 'utf8')
    })

  appendQueues.set(file, next)
  // 队尾跑完就清理,否则 Map 会随 nodeId 数量无界增长
  void next.finally(() => {
    if (appendQueues.get(file) === next) appendQueues.delete(file)
  })

  return next
}

/** 等所有排队中的追加写完。轮次边界 / 退出前调用 */
export async function flushAppends(): Promise<void> {
  await Promise.allSettled([...appendQueues.values()])
}

export interface JsonlTail<T> {
  recs: T[]
  /** 末尾存在无法解析的行(通常是崩溃时的半行) */
  torn: boolean
  total: number
}

/**
 * 读 JSONL,只返回最后 limit 条。
 *
 * 崩溃安全的关键:写到一半的行 parse 必然失败,直接丢弃即可 ——
 * 不需要事务,不需要索引。这是选 JSONL 而不是 sqlite 的主要理由。
 */
export async function readJsonlTail<T>(file: string, limit = 0): Promise<JsonlTail<T>> {
  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { recs: [], torn: false, total: 0 }
    throw err
  }

  const lines = raw.split('\n')
  // 正常情况文件以 \n 结尾,split 会多出一个空串
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const recs: T[] = []
  let torn = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      recs.push(JSON.parse(line) as T)
    } catch {
      torn = true
      // 末行坏 = 崩溃时写到一半,正常。
      // 中间行坏 = 文件被外部破坏,同样跳过,但要留下痕迹。
      if (i !== lines.length - 1) {
        console.warn(`[persist] ${path.basename(file)} 第 ${i + 1} 行损坏(非末行),已跳过`)
      }
    }
  }

  const total = recs.length
  return { recs: limit > 0 ? recs.slice(-limit) : recs, torn, total }
}

/** 按序号列出日志分段(log.000.jsonl, log.001.jsonl, …) */
export function listLogSegments(dir: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => /^log\.\d{3}\.jsonl$/.test(n))
    .sort()
    .map((n) => path.join(dir, n))
}

/**
 * 清理崩溃残留的临时文件。
 * 启动时扫一遍 —— 不清理的话它们会一直堆积(每次崩溃留一个)。
 */
export async function removeStaleTmp(dir: string): Promise<number> {
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return 0
  }

  let n = 0
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue
    try {
      await fsp.rm(path.join(dir, name), { force: true })
      n++
    } catch {
      /* 还被占用就下次再说 */
    }
  }
  return n
}
