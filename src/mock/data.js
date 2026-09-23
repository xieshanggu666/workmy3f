// 灾情事件类型定义与严重等级配置
export const EVENT_TYPES = {
  flood: { label: '洪涝', icon: '🌊', color: '#2f9cf5' },
  quake: { label: '地震', icon: '⚠️', color: '#f56c2f' },
  fire: { label: '火灾', icon: '🔥', color: '#ef5350' },
  landslide: { label: '山体滑坡', icon: '⛰️', color: '#9c6b2f' },
  typhoon: { label: '台风', icon: '🌀', color: '#8e44ad' }
}

export const SEVERITY = [
  { value: 'red', label: 'Ⅰ级·特大', color: '#ef5350' },
  { value: 'orange', label: 'Ⅱ级·重大', color: '#ff9800' },
  { value: 'yellow', label: 'Ⅲ级·较大', color: '#ffc107' },
  { value: 'blue', label: 'Ⅳ级·一般', color: '#4caf50' }
]

// 事件生命周期状态机
export const EVENT_STATUS = [
  { value: 'reported', label: '已上报', color: '#9e9e9e' },
  { value: 'assessing', label: '研判中', color: '#ff9800' },
  { value: 'dispatching', label: '处置中', color: '#2f9cf5' },
  { value: 'controlled', label: '已控制', color: '#8e44ad' },
  { value: 'closed', label: '已结案', color: '#4caf50' }
]

// 资源类型
export const RESOURCE_TYPES = {
  personnel: { label: '救援人员', unit: '人', icon: '👷' },
  medical: { label: '医疗物资', unit: '件', icon: '💊' },
  food: { label: '应急食品', unit: '份', icon: '🥫' },
  water: { label: '饮用水', unit: '箱', icon: '💧' },
  vehicle: { label: '救援车辆', unit: '辆', icon: '🚒' },
  tent: { label: '帐篷', unit: '顶', icon: '⛺' }
}

// 转移批次状态机：待接运 → 接运中 → 已安置 → 已转出（办结）
export const TRANSFER_STATUS = [
  { value: 'pending', label: '待接运', color: '#9e9e9e' },
  { value: 'transporting', label: '接运中', color: '#2f9cf5' },
  { value: 'settled', label: '已安置', color: '#8e44ad' },
  { value: 'closed', label: '已转出', color: '#4caf50' }
]

// 道路抢修工单状态机：待接单 → 抢修中 → 待验收 → 已办结（验收通过解除封闭）
// 抢修中可延期（保留阻断）；抢修中/待验收可转失败/撤单（保留阻断，按实际消耗归还资源）
export const REPAIR_STATUS = [
  { value: 'dispatched', label: '待接单', color: '#ff9800' },
  { value: 'accepted', label: '抢修中', color: '#2f9cf5' },
  { value: 'done', label: '待验收', color: '#ab47bc' },
  { value: 'cleared', label: '已办结', color: '#4caf50' },
  { value: 'failed', label: '抢修失败', color: '#ef5350' },
  { value: 'cancelled', label: '已撤单', color: '#78909c' }
]

// 抢修可领用的物资目录（队伍人员与车辆单列分配）
export const REPAIR_MATERIAL_TYPES = ['medical', 'food', 'water', 'tent']

// 登记环节
export const REGISTER_STAGES = [
  { value: 'pickup', label: '接运登记', icon: '🚌', hint: '现场登车，核录人员信息' },
  { value: 'checkin', label: '入住登记', icon: '🏕️', hint: '抵达安置点，分配床位' },
  { value: 'checkout', label: '转出登记', icon: '🚪', hint: '返乡/投亲/转院，释放床位' }
]

// 安置点（床位容量）
export const SHELTERS = [
  { id: 'sh-1', name: '江油一中临时安置点', lng: 104.7705, lat: 31.778, capacity: 1200 },
  { id: 'sh-2', name: '绵阳会展中心安置点', lng: 104.7333, lat: 31.455, capacity: 2000 },
  { id: 'sh-3', name: '青川体育馆安置点', lng: 105.241, lat: 32.575, capacity: 600 },
  { id: 'sh-4', name: '广元奥体中心安置点', lng: 105.85, lat: 32.42, capacity: 900 },
  { id: 'sh-5', name: '成都高新应急避难所', lng: 104.06, lat: 30.58, capacity: 1500 }
]

// 安置点人均每日物资需求系数（按在住人日折算物资需求）
export const SUPPLY_PER_CAPITA = {
  food: 0.6,    // 份/人·日（两餐+加餐折算）
  water: 0.2,   // 箱/人·日
  tent: 0.25,   // 顶/人（约 4 人一顶）
  medical: 0.05 // 件/人·日
}

// 耐用品目录：按在住峰值一次性配备、配备后留在安置点周转，不按日消耗；
// 其余类型为消耗品，按「实际入住时段折算的人日 × 人均系数」逐日消耗、跨日结转
export const SUPPLY_DURABLES = ['tent']

// 城市坐标（作为 mock 场景锚点，实际为演示用经纬度）
export const CITIES = {
  chengdu: { name: '成都', lng: 104.0657, lat: 30.6594 },
  mianyang: { name: '绵阳', lng: 104.742, lat: 31.4641 },
  dazhou: { name: '达州', lng: 107.4078, lat: 31.2094 },
  leshan: { name: '乐山', lng: 103.7656, lat: 29.5521 },
  yibin: { name: '宜宾', lng: 104.633, lat: 28.7696 },
  luzhou: { name: '泸州', lng: 105.4433, lat: 28.8891 },
  nanchong: { name: '南充', lng: 106.0829, lat: 30.7953 },
  guangyuan: { name: '广元', lng: 105.8362, lat: 32.4358 }
}

// 预置灾情场景数据
export const SCENARIOS = [
  {
    id: 's1',
    name: '典型洪涝场景',
    desc: '涵盖重度受灾区、救援点与资源库分布',
    events: [
      {
        id: 'ev-001',
        type: 'flood',
        title: '江油市防洪干堤水位超警',
        severity: 'red',
        status: 'dispatching',
        location: { name: '江油市', lng: 104.7456, lat: 31.7777 },
        affectedPolygon: [
          [104.70, 31.86], [104.88, 31.82], [104.92, 31.70],
          [104.76, 31.62], [104.60, 31.70], [104.64, 31.82]
        ],
        heatRadius: 3000,
        desc: '特大暴雨致城区内涝，多处道路中断，转移群众约 1.2 万人。',
        reportedAt: '07:42',
        affected: 12000,
        evacuate: 4000,
        demand: { personnel: 200, water: 3000, food: 5000, medical: 800, vehicle: 40, tent: 1500 }
      },
      {
        id: 'ev-002',
        type: 'fire',
        title: '高新区仓储物流园火情',
        severity: 'orange',
        status: 'assessing',
        location: { name: '高新区', lng: 104.0661, lat: 30.5727 },
        affectedPolygon: [
          [104.02, 30.62], [104.12, 30.61], [104.13, 30.52],
          [104.0, 30.53]
        ],
        heatRadius: 1500,
        desc: '物流园厂房起火，火势蔓延，已疏散周边 2 个居民区。',
        reportedAt: '08:15',
        affected: 850,
        evacuate: 500,
        demand: { personnel: 120, water: 1500, medical: 300, food: 1500, vehicle: 25, tent: 600 }
      },
      {
        id: 'ev-003',
        type: 'quake',
        title: '龙门山断裂带 4.8 级余震',
        severity: 'yellow',
        status: 'reported',
        location: { name: '北川', lng: 104.468, lat: 31.6156 },
        affectedPolygon: [
          [104.38, 31.68], [104.56, 31.66], [104.56, 31.55],
          [104.38, 31.57]
        ],
        heatRadius: 1200,
        desc: '山区道路落石，少量民房受损，暂未接报人员伤亡。',
        reportedAt: '09:03',
        affected: 320,
        evacuate: 150,
        demand: { personnel: 50, water: 500, food: 800, medical: 150, vehicle: 10, tent: 300 }
      }
    ]
  },
  {
    id: 's2',
    name: '汛期多点并发场景',
    desc: '多起洪涝与地质灾害并发，考察资源统筹',
    events: [
      {
        id: 'ev-101',
        type: 'flood',
        title: '涪江流域平武段超警戒水位',
        severity: 'red',
        status: 'dispatching',
        location: { name: '平武县', lng: 104.528, lat: 32.407 },
        affectedPolygon: [
          [104.46, 32.48], [104.66, 32.44], [104.70, 32.30],
          [104.50, 32.26], [104.40, 32.36]
        ],
        heatRadius: 2600,
        desc: '干流沿线告急，低洼村庄被困群众约 6000 人。',
        reportedAt: '11:20',
        affected: 6000,
        evacuate: 2500,
        demand: { personnel: 160, water: 2400, food: 3500, medical: 600, vehicle: 32, tent: 1200 }
      },
      {
        id: 'ev-102',
        type: 'landslide',
        title: '青川山区山体滑坡阻断国道',
        severity: 'orange',
        status: 'controlled',
        location: { name: '青川县', lng: 105.2375, lat: 32.581 },
        affectedPolygon: [
          [105.18, 32.64], [105.34, 32.62], [105.36, 32.52],
          [105.20, 32.50]
        ],
        heatRadius: 1000,
        desc: '滑坡体阻断国道 G543 一段，抢通作业已接近完成。',
        reportedAt: 'Yesterday',
        affected: 520,
        evacuate: 200,
        demand: { personnel: 70, water: 400, medical: 120, food: 600, vehicle: 14, tent: 200 }
      },
      {
        id: 'ev-103',
        type: 'typhoon',
        title: '台风外围云系带来局部强风暴雨',
        severity: 'blue',
        status: 'reported',
        location: { name: '广元市', lng: 105.8362, lat: 32.4358 },
        affectedPolygon: [
          [105.76, 32.50], [105.94, 32.47], [105.95, 32.36],
          [105.78, 32.34]
        ],
        heatRadius: 1800,
        desc: '预警发布中，局部断电，已在城市低洼点部署抽排车。',
        reportedAt: '13:05',
        affected: 1800,
        evacuate: 600,
        demand: { personnel: 40, water: 300, food: 500, medical: 100, vehicle: 12, tent: 0 }
      }
    ]
  }
]

// 资源库（救援点 / 物资库）
export const RESOURCE_BASES = [
  { id: 'rb-1', name: '川西应急救援基地', type: 'composite', lng: 104.0657, lat: 30.6594, stock: { personnel: 800, medical: 12000, food: 25000, water: 18000, vehicle: 200, tent: 6000 } },
  { id: 'rb-2', name: '绵阳物资储备库', type: 'warehouse', lng: 104.742, lat: 31.4641, stock: { personnel: 0, medical: 5000, food: 12000, water: 9000, vehicle: 40, tent: 3000 } },
  { id: 'rb-3', name: '南充医疗应急中心', type: 'medical', lng: 106.0829, lat: 30.7953, stock: { personnel: 300, medical: 8000, food: 0, water: 0, vehicle: 25, tent: 0 } },
  { id: 'rb-4', name: '达州消防特勤站', type: 'fire', lng: 107.4078, lat: 31.2094, stock: { personnel: 150, medical: 1000, food: 2000, water: 1500, vehicle: 60, tent: 500 } },
  { id: 'rb-5', name: '宜宾一线指挥部物资点', type: 'forward', lng: 104.633, lat: 28.7696, stock: { personnel: 400, medical: 4000, food: 8000, water: 7000, vehicle: 80, tent: 2500 } }
]