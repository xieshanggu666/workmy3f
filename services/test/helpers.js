// 四服务真实 HTTP 集成测试：启动独立端口/独立数据目录的完整进程组，
// 覆盖 多人并行、断线续演、事件乱序、分支并发写入、故障恢复（进程重启）、
// 因果重建（库存/床位/运输）、旧快照迁移、真实调度隔离。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

export const TPORTS = { gateway: 8100, ingestion: 8101, history: 8102, replay: 8103 }
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-svc-'))

let children = []

function env() {
  return {
    ...process.env,
    PORT_GATEWAY: TPORTS.gateway, PORT_INGESTION: TPORTS.ingestion,
    PORT_HISTORY: TPORTS.history, PORT_REPLAY: TPORTS.replay,
    SERVICES_DATA_DIR: DATA,
    LIVE_WRITE_TOKEN: 'test-live-token',
    CHECKPOINT_INTERVAL_MS: '60000',
    DISORDER_SLACK_MS: '120',
    LONG_POLL_MS: '1500'
  }
}

export function startAll() {
  // 清掉任何残留监听，避免旧代码进程占端口导致诡异的"改了不生效"
  Object.values(TPORTS).forEach((p) => killPort(p))
  const names = [
    ['history', 'history-service.js'],
    ['replay', 'replay-service.js'],
    ['ingestion', 'ingestion-service.js'],
    ['gateway', 'gateway-service.js']
  ]
  children = names.map(([n, f]) => {
    const c = spawn(process.execPath, [path.join(root, 'servers', f)], {
      stdio: ['ignore', 'pipe', 'pipe'], env: env()
    })
    c.stdout.on('data', (d) => process.env.VERBOSE && process.stderr.write(`[${n}] ${d}`))
    c.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(`[${n}!] ${d}`))
    return [n, c]
  })
}

export function stopAll() {
  children.forEach(([, c]) => { try { c.kill('SIGKILL') } catch { /* noop */ } })
  children = []
  // 兜底：按测试端口清掉任何残留的同名服务进程（防止跨轮次孤儿占端口）
  Object.values(TPORTS).forEach((p) => killPort(p))
}

// 通过 /proc 找出监听指定端口的进程并杀掉（无 lsof/fuser 环境可用）
export function killPort(port) {
  let found = []
  try {
    const inodes = new Set()
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      const text = fs.readFileSync(f, 'utf8')
      text.split('\n').slice(1).forEach((line) => {
        const c = line.trim().split(/\s+/)
        if (c.length < 10 || c[9] === '0') return
        const localPort = parseInt(c[1].split(':')[1], 16)
        if (localPort === port) inodes.add(c[9])
      })
    }
    if (!inodes.size) return
    for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
      const fdDir = `/proc/${pid}/fd`
      let links
      try { links = fs.readdirSync(fdDir) } catch { continue }
      for (const fd of links) {
        let target
        try { target = fs.readlinkSync(`${fdDir}/${fd}`) } catch { continue }
        const m = target.match(/^socket:\[(\d+)]$/)
        if (m && inodes.has(m[1])) { found.push(Number(pid)); break }
      }
    }
  } catch { /* /proc 不可用时退化为仅杀已登记子进程 */ }
  [...new Set(found)].forEach((pid) => { try { process.kill(pid, 'SIGKILL') } catch { /* noop */ } })
}

export function stopService(name) {
  const port = TPORTS[name]
  if (port) killPort(port)
  children = children.filter(([n, c]) => {
    if (n === name) { try { c.kill('SIGKILL') } catch { /* noop */ } return false }
    return true
  })
}

export function startService(name) {
  const files = {
    history: 'history-service.js', replay: 'replay-service.js',
    ingestion: 'ingestion-service.js', gateway: 'gateway-service.js'
  }
  const c = spawn(process.execPath, [path.join(root, 'servers', files[name])], {
    stdio: ['ignore', 'pipe', 'pipe'], env: env()
  })
  c.stdout.on('data', () => {})
  c.stderr.on('data', () => {})
  children.push([name, c])
  return c
}

export async function restartService(name, waitMs = 400) {
  stopService(name)
  await sleep(waitMs)
  startService(name)
  await waitHealthy(TPORTS[name])
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

export function call(method, port, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } : headers
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed
        try { parsed = text ? JSON.parse(text) : {} } catch { parsed = {} }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

export async function waitHealthy(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await call('GET', port, '/healthz')
      if (r.status === 200) return
    } catch { /* wait */ }
    await sleep(100)
  }
  throw new Error(`service on ${port} not healthy`)
}

export async function waitAll() {
  await Promise.all([TPORTS.history, TPORTS.replay, TPORTS.ingestion, TPORTS.gateway].map((p) => waitHealthy(p)))
}

export function cleanupData() {
  try { fs.rmSync(DATA, { recursive: true, force: true }) } catch { /* noop */ }
}

export const GW = (p) => call('GET', TPORTS.gateway, p)
export const POST = (p, body, headers) => call('POST', TPORTS.gateway, p, body, headers)
export const HIST = (method, p, body) => call(method, TPORTS.history, p, body)
export const ING = (method, p, body) => call(method, TPORTS.ingestion, p, body)
export const REP = (p) => call('GET', TPORTS.replay, p)
