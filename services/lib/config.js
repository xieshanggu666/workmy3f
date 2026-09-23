// 服务端口与目录统一配置（可用环境变量覆盖，便于多实例并行）
export const PORTS = {
  gateway: Number(process.env.PORT_GATEWAY || 7100),
  ingestion: Number(process.env.PORT_INGESTION || 7101),
  history: Number(process.env.PORT_HISTORY || 7102),
  replay: Number(process.env.PORT_REPLAY || 7103)
}

export const HOST = process.env.SERVICES_HOST || '127.0.0.1'

// 真实调度（生产）流的保留 ID：任何推演会话都不得写入
export const LIVE_SIM_ID = 'live'
// 直连 API 写真实流所需的带外令牌（推演网关永不签发）；未配置时真实流只读
export const LIVE_WRITE_TOKEN = process.env.LIVE_WRITE_TOKEN || ''

export const DATA_DIR = process.env.SERVICES_DATA_DIR || '.data/services'

// 事件乱序容忍窗口（ms）：窗口内迟到事件按因果键重排；窗口外强制放行
export const DISORDER_SLACK_MS = Number(process.env.DISORDER_SLACK_MS || 500)

// 历史长轮询挂起上限
export const LONG_POLL_MS = Number(process.env.LONG_POLL_MS || 20000)
