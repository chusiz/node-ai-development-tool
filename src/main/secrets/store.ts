import fs from 'node:fs'
import { safeStorage } from 'electron'
import { SECRETS_FILE } from '../paths'
import { writeJsonAtomicSync } from '../persist/atomic'
import { envKeyName, maskKey, type SecretStatus } from '../../shared/secrets'

/**
 * API Key 的加密存储。
 *
 * ## 落盘格式
 *
 * ```json
 * { "version": 1, "enc": "safeStorage", "keys": { "deepseek": "<base64 密文>" } }
 * ```
 *
 * `enc` 这个字段不是装饰 —— 它记录**这一份文件是怎么写出来的**,读取时据此
 * 决定要不要解密。用户把 `enc: safeStorage` 的文件拷到另一台机器上,
 * 系统凭据换了,密文解不开,这时 `enc` 能让我们给出"换个机器要重填 Key"
 * 这句人话,而不是一个 base64 解码失败的栈。
 *
 * ## 为什么明文永不外流
 *
 * 见 shared/secrets.ts 顶部的说明。这里只补一条**本文件特有**的理由:
 * 主进程是唯一持有明文 Key 的地方,所以任何要打日志/发 IPC 的地方都得过
 * `statusFor()` —— 它只吐脱敏串。反过来说,只要没人把 `keyFor()` 的结果
 * 直接塞给 IPC,泄露就不可能发生。
 */

/** `enc` 的取值。plain 是**降级**路径,见下面 encryptionAvailable 的说明 */
type EncMode = 'safeStorage' | 'plain'

interface SecretsFile {
  version: 1
  enc: EncMode
  /** providerId → (base64 密文 | 明文) */
  keys: Record<string, string>
}

const EMPTY: SecretsFile = { version: 1, enc: 'safeStorage', keys: {} }

/**
 * `electron` 在**纯 node** 宿主里导出的是二进制路径字符串,解构出来的
 * `safeStorage` 会是 undefined。e2e 就跑在纯 node 里 ——
 * 不判这一下,模块顶层就会炸(与 paths.ts 判 `app` 是同一个坑)。
 */
const ss =
  typeof safeStorage === 'object' &&
  safeStorage !== null &&
  typeof (safeStorage as { isEncryptionAvailable?: unknown }).isEncryptionAvailable === 'function'
    ? safeStorage
    : null

/**
 * 本机能不能用系统凭据加密。
 *
 * Windows 走 DPAPI,macOS 走钥匙串,一般都是 true。
 * Linux 上取决于有没有 keyring —— 没有的话 safeStorage 会明确返回 false。
 */
export function encryptionAvailable(): boolean {
  if (!ss) return false
  try {
    return ss.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * 读整份文件。**永不抛** —— 与 settings 一样的理由:它可能在 app ready
 * 之前被读到,抛出去等于应用起不来。坏文件一律降级成空表(也就是"没配过 Key"),
 * 用户重填一次即可,而不是整个应用打不开。
 */
function read(): SecretsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) as Partial<SecretsFile>
    const keys: Record<string, string> = {}
    const src = raw.keys
    if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src)) {
        if (typeof v === 'string' && v) keys[k] = v
      }
    }
    return {
      version: 1,
      enc: raw.enc === 'plain' ? 'plain' : 'safeStorage',
      keys,
    }
  } catch {
    return { ...EMPTY }
  }
}

function write(next: SecretsFile): void {
  // ⚠️ 必须**同步**原子写:setKey 返回 statusFor 之前,落盘必须已经生效。
  // 异步版会让"刚保存的 Key 立即读不到"(写慢读快,取决于磁盘时序)。
  writeJsonAtomicSync(SECRETS_FILE, next)
  try {
    fs.chmodSync(SECRETS_FILE, 0o600)
  } catch {
    /* Windows 上基本是空操作,失败无所谓 */
  }
}

/** 解密一条。解不开(换机器 / 换用户 / 文件被改)返回 null,由调用方当"没有 Key"处理 */
function decrypt(enc: EncMode, blob: string): string | null {
  if (enc === 'plain') return blob
  if (!ss) return null
  try {
    return ss.decryptString(Buffer.from(blob, 'base64'))
  } catch {
    return null
  }
}

function encrypt(plain: string): { enc: EncMode; blob: string } {
  if (encryptionAvailable() && ss) {
    return { enc: 'safeStorage', blob: ss.encryptString(plain).toString('base64') }
  }
  /*
   * 降级:本机没有系统凭据服务(Linux 无 keyring 是唯一现实场景)。
   *
   * 这里**选择明文存而不是拒绝保存**,理由是拒绝保存等于"这台机器上完全
   * 用不了 API 直连" —— 而用户装这个应用是为了干活。代价用两件事控住:
   *   ① 文件里写明 enc:'plain',UI 据此显示醒目的明文警告(见 ProviderSection);
   *   ② 不静默 —— 用户看得见风险,由他自己决定要不要在这台机器上填 Key。
   * 相比之下"静默明文"和"直接不给用"都更糟:前者骗人,后者废掉半边功能。
   */
  return { enc: 'plain', blob: plain }
}

/** 找一把 Key。返回空串表示没有 */
function lookup(providerId: string): { key: string; source: 'store' | 'env' | 'none' } {
  const f = read()
  const blob = f.keys[providerId]
  if (blob) {
    const key = decrypt(f.enc, blob)
    if (key) return { key, source: 'store' }
    // 有记录但解不开(典型的换机器场景)—— 不当作 env 兜底之外的东西,
    // 继续往下看环境变量,最后如实报 none
  }

  const env = process.env[envKeyName(providerId)]
  if (env && env.trim()) return { key: env.trim(), source: 'env' }

  return { key: '', source: 'none' }
}

/**
 * 取明文 Key。**只在主进程内部调用**(发请求前拿它拼鉴权头)。
 * 任何要回渲染进程的地方都必须用 `statusFor()`。
 */
export function keyFor(providerId: string): string {
  return lookup(providerId).key
}

/** 脱敏状态。这是唯一允许跨 IPC 出去的形态 */
export function statusFor(providerId: string): SecretStatus {
  const { key, source } = lookup(providerId)
  if (!key) return { providerId, hasKey: false, masked: null, source: 'none' }
  return { providerId, hasKey: true, masked: maskKey(key), source }
}

export function statusForAll(providerIds: readonly string[]): SecretStatus[] {
  return providerIds.map(statusFor)
}

/**
 * 写入一把 Key。空串等价于清除 —— 用户在输入框里清空是合法操作,
 * 不该被当成"存了一把空 Key"。
 */
export function setKey(providerId: string, key: string): SecretStatus {
  const trimmed = (key ?? '').trim()
  if (!trimmed) return clearKey(providerId)

  const f = read()
  const { enc, blob } = encrypt(trimmed)
  /*
   * ⚠️ 整份文件只有一个 enc。
   *
   * 逐条记 enc 也能做,但那样读的时候要按条判断,而现实中"这台机器能不能加密"
   * 是个全局属性,不会一条能一条不能。保持单一字段,读路径就是一条直线。
   * 万一从 safeStorage 降到 plain(装了 keyring),把那台机器上旧的密文条目
   * 一并丢掉并让用户重填,比留一堆解不开的垃圾条目干净。
   */
  if (enc !== f.enc) {
    for (const k of Object.keys(f.keys)) {
      if (decrypt(f.enc, f.keys[k]!) === null) delete f.keys[k]
    }
  }
  f.enc = enc
  f.keys[providerId] = blob
  write(f)
  return statusFor(providerId)
}

export function clearKey(providerId: string): SecretStatus {
  const f = read()
  if (f.keys[providerId] !== undefined) {
    delete f.keys[providerId]
    write(f)
  }
  // 注意:环境变量里的同名 Key **不会**被清掉 —— 那不是我们存的东西,
  // 清不掉也不该假装清掉了。statusFor 会如实报 source: 'env'。
  return statusFor(providerId)
}

/**
 * 存储的位置与加密方式,供设置页显示。
 *
 * `encrypted: false` 时 UI 必须把明文风险说出来 —— 这是上面降级路径的另一半。
 */
export function storeInfo(): { file: string; encrypted: boolean; count: number } {
  const f = read()
  return {
    file: SECRETS_FILE,
    encrypted: f.enc === 'safeStorage' && encryptionAvailable(),
    count: Object.keys(f.keys).length,
  }
}
