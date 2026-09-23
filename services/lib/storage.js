import fs from 'node:fs'
import path from 'node:path'

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file))
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2)
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, file)
}

// 仅追加 JSONL 日志：崩溃恢复时顺序重放；带 fsync 的持久化追加。
// 行格式：JSON.stringify(event) + '\n'
export class JsonlLog {
  constructor(file) {
    this.file = file
    ensureDir(path.dirname(file))
    this.fd = fs.openSync(file, 'a')
  }

  append(obj) {
    const line = JSON.stringify(obj) + '\n'
    fs.writeSync(this.fd, line)
    try { fs.fsyncSync(this.fd) } catch { /* 某些环境不支持 fsync */ }
    return obj
  }

  readAll() {
    const text = fs.readFileSync(this.file, 'utf8')
    const out = []
    text.split('\n').forEach((line, idx) => {
      if (!line.trim()) return
      try { out.push(JSON.parse(line)) }
      catch (e) {
        // 崩溃可能留下半行：截断到最后一个完整换行，后续追加从干净位置继续
        const clean = text.split('\n').slice(0, idx).filter(Boolean).join('\n') + '\n'
        fs.writeFileSync(this.file, clean)
        throw new Error('truncated-tail-recovered')
      }
    })
    return out
  }

  // 故障恢复：重放全部行，尾部半行自动截断
  recover() {
    for (;;) {
      try { return this.readAll() } catch (e) {
        if (e.message === 'truncated-tail-recovered') continue
        throw e
      }
    }
  }

  close() { try { fs.closeSync(this.fd) } catch { /* noop */ } }
}

// 简易串行互斥：同一份资源（分支日志 / 投影）的写操作按调用顺序排队
export function mutex() {
  let tail = Promise.resolve()
  return (fn) => {
    const run = tail.then(() => fn())
    tail = run.catch(() => {})
    return run
  }
}
