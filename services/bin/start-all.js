#!/usr/bin/env node
/* 本地一键起三服务（开发/演示用；生产应各自独立部署，按服务伸缩） */
import { listen } from '../shared/http.js'
import { createCollector } from '../collector/index.js'
import { createArchive } from '../archive/index.js'
import { createReplay } from '../replay/index.js'

const archivePort = Number(process.env.ARCHIVE_PORT || 7102)
const collectorPort = Number(process.env.COLLECTOR_PORT || 7101)
const replayPort = Number(process.env.REPLAY_PORT || 7103)
const archiveUrl = process.env.ARCHIVE_URL || `http://127.0.0.1:${archivePort}`

const archive = createArchive()
await listen(archive.router, archivePort)
console.log(`[archive]   :${archivePort}`)

const collector = createCollector({ archiveUrl })
await listen(collector.router, collectorPort)
console.log(`[collector] :${collectorPort} -> ${archiveUrl}`)
collector.drain()

const replay = createReplay({ archiveUrl })
await listen(replay.router, replayPort)
console.log(`[replay]    :${replayPort} -> ${archiveUrl}`)

console.log('\n三服务已就绪：')
console.log(`  采集事件  POST http://127.0.0.1:${collectorPort}/v1/events`)
console.log(`  实时态势  GET  http://127.0.0.1:${replayPort}/v1/state?realm=wg:demo`)
console.log(`  健康检查  /v1/health（各服务）`)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\n收到', sig, '，退出'); process.exit(0) })
}
