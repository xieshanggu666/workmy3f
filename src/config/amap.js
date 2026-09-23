import AMapLoader from '@amap/amap-jsapi-loader'

// 从 Vite 环境变量读取高德 key 与安全密钥（见 .env / .env.example）
const AMAP_KEY = import.meta.env.VITE_AMAP_KEY || ''
const SECURITY_CODE = import.meta.env.VITE_AMAP_SECURITY_CODE || ''

let sharedAMap = null

if (SECURITY_CODE) {
  // 高德 v2 安全密钥（jscode）通过全局配置注入
  ;(window)._AMapSecurityConfig = { securityJsCode: SECURITY_CODE }
}

/**
 * 加载 AMap 命名空间（内部单例，多次调用只加载一次）
 * @returns {Promise<any>} window.AMap
 */
export async function loadAMap() {
  if (sharedAMap) return sharedAMap
  if (!AMAP_KEY) {
    throw new Error('缺少 VITE_AMAP_KEY，请复制 .env.example 为 .env 并填写高德 key')
  }
  sharedAMap = await AMapLoader.load({
    key: AMAP_KEY,
    version: '2.0',
    plugins: [
      'AMap.Scale',
      'AMap.ToolBar',
      'AMap.MapType',
      'AMap.HawkEye',
      'AMap.Geolocation',
      'AMap.Heatmap',
      'AMap.Driving',
      'AMap.Transfer',
      'AMap.Walking',
      'AMap.ControlBar'
    ]
  })
  return sharedAMap
}

export { AMAP_KEY }