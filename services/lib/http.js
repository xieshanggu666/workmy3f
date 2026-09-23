import http from 'node:http'

// 极简 JSON HTTP 工具：零依赖实现微服务的路由 / body 解析 / JSON 响应
export function send(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json)
  })
  res.end(json)
}

export const ok = (res, data) => send(res, 200, { ok: true, ...(data || {}) })
export const fail = (res, status, code, msg) => send(res, status, { ok: false, code, msg })

export async function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('invalid json body')) }
    })
    req.on('error', reject)
  })
}

// 路由匹配：routes: [['METHOD', '/path/:id', handler]]；handler(req,res,params,query,body)
export function createApp(routes) {
  const compiled = routes.map(([method, pattern, handler]) => {
    const keys = []
    const re = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => {
      keys.push(m.slice(1))
      return '([^/]+)'
    }) + '/?$')
    return { method, re, keys, handler }
  })
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const query = Object.fromEntries(url.searchParams)
    for (const r of compiled) {
      if (r.method !== req.method) continue
      const m = path.match(r.re)
      if (!m) continue
      const params = {}
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]) })
      try {
        const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {}
        await r.handler(req, res, params, query, body)
      } catch (e) {
        if (e?.message === 'invalid json body') return fail(res, 400, 'bad_json', '请求体不是合法 JSON')
        if (e?.message === 'payload too large') return fail(res, 413, 'too_large', '请求体过大')
        if (e?.status) return fail(res, e.status, e.code || 'error', e.message)
        console.error(`[${r.method}]`, e)
        if (!res.headersSent) fail(res, 500, 'internal', e?.message || '内部错误')
      }
      return
    }
    fail(res, 404, 'not_found', `${req.method} ${path} 无对应处理`)
  })
}

export function listen(server, port, name) {
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      console.error(`[${name}] listening http://127.0.0.1:${port}`)
      resolve(server)
    })
  })
}

// 服务间 HTTP 调用
export async function call(method, port, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const baseHeaders = data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: { ...baseHeaders, ...extraHeaders }
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

// 等待下游服务就绪（启动顺序解耦 / 故障恢复后自动重连）
export async function waitFor(port, path = '/healthz', tries = 60, gapMs = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await call('GET', port, path)
      if (r.status === 200) return true
    } catch { /* 下游尚未就绪 */ }
    await new Promise((r) => setTimeout(r, gapMs))
  }
  throw new Error(`下游 :${port}${path} 不可达`)
}
