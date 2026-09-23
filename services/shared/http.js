/* 零依赖 HTTP 小工具：路由、JSON 解析、统一错误、SSE 推送 */

import http from 'node:http'
import { DomainError } from './util.js'

export function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(payload)
}

export function readJson(req, { limit = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new DomainError('payload_too_large', '请求体过大', 413)); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new DomainError('bad_json', '请求体不是合法 JSON', 400)) }
    })
    req.on('error', reject)
  })
}

// 极简路由：routes = [{ method, pattern:'/x/:id', handler }]
export function createRouter(routes) {
  const compiled = routes.map((r) => ({
    method: (r.method || 'GET').toUpperCase(),
    regex: new RegExp('^' + r.pattern.replace(/:([A-Za-z_]+)/g, '(?<$1>[^/]+)') + '$'),
    handler: r.handler
  }))
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    for (const r of compiled) {
      if (r.method !== req.method) continue
      const m = r.regex.exec(path)
      if (!m) continue
      req.params = { ...m.groups }
      req.query = Object.fromEntries(url.searchParams.entries())
      try {
        await r.handler(req, res)
      } catch (err) {
        if (err instanceof DomainError) {
          send(res, err.status, { error: err.code, message: err.message, details: err.details })
        } else {
          send(res, 500, { error: 'internal', message: err?.message || 'internal error' })
        }
      }
      return true
    }
    send(res, 404, { error: 'not_found', message: `No route: ${req.method} ${path}` })
    return false
  }
}

export async function listen(app, port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => { app(req, res) })
    server.listen(port, () => resolve(server))
  })
}

/* Server-Sent Events：回放订阅（断线续演时 Last-Event-ID 之后补推） */
export function sseInit(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, must-revalidate',
    connection: 'keep-alive',
    'access-control-allow-origin': '*'
  })
  res.write(':ok\n\n')
}
export function sseSend(res, { event, id, data }) {
  if (event) res.write(`event: ${event}\n`)
  if (id != null) res.write(`id: ${id}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}
export function sseHeartbeat(res) { res.write(': ping\n\n') }
