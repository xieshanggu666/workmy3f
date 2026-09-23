#!/usr/bin/env node
// 一键启动四个独立服务（生产可用进程管理器分别拉起；此脚本便于本地演示/测试）
// 顺序不敏感：网关与采集都带下游就绪等待/重试
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

const services = [
  ['history', 'servers/history-service.js'],
  ['replay', 'servers/replay-service.js'],
  ['ingestion', 'servers/ingestion-service.js'],
  ['gateway', 'servers/gateway-service.js']
]

const children = []
for (const [name, rel] of services) {
  const child = spawn(process.execPath, [path.join(root, rel)], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env
  })
  child.on('exit', (code) => {
    if (code !== 0 && !shuttingDown) console.error(`[supervisor] ${name} exited with ${code}`)
  })
  children.push([name, child])
}

let shuttingDown = false
const shutdown = (sig) => {
  shuttingDown = true
  console.error(`[supervisor] ${sig}, stopping all services...`)
  children.forEach(([, c]) => { try { c.kill('SIGTERM') } catch { /* noop */ } })
  setTimeout(() => process.exit(0), 800).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

console.error('[supervisor] services: gateway :7100 · ingestion :7101 · history :7102 · replay :7103')
