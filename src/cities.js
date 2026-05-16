/**
 * City/Airport code mapping and lookup utilities
 */

// Major city codes for China Eastern Airlines
// airportCodes: the actual airport IATA codes in this city (used in API depCode/arrCode)
const CITY_MAP = {
  // Tier 1
  SHA: { name: '上海', airports: ['PVG-浦东', 'SHA-虹桥'], airportCodes: ['SHA', 'PVG'], code: 'SHA' },
  BJS: { name: '北京', airports: ['PEK-首都', 'PKX-大兴'], airportCodes: ['PEK', 'PKX'], code: 'BJS' },
  CAN: { name: '广州', airports: ['CAN-白云'], airportCodes: ['CAN'], code: 'CAN' },
  CTU: { name: '成都', airports: ['CTU-天府', 'TFU-双流'], airportCodes: ['CTU', 'TFU'], code: 'CTU' },
  SZX: { name: '深圳', airports: ['SZX-宝安'], airportCodes: ['SZX'], code: 'SZX' },

  // Tier 2
  CKG: { name: '重庆', airports: ['CKG-江北'], airportCodes: ['CKG'], code: 'CKG' },
  KMG: { name: '昆明', airports: ['KMG-长水'], airportCodes: ['KMG'], code: 'KMG' },
  XIY: { name: '西安', airports: ['XIY-咸阳'], airportCodes: ['XIY'], code: 'XIY' },
  WUH: { name: '武汉', airports: ['WUH-天河'], airportCodes: ['WUH'], code: 'WUH' },
  HGH: { name: '杭州', airports: ['HGH-萧山'], airportCodes: ['HGH'], code: 'HGH' },
  NKG: { name: '南京', airports: ['NKG-禄口'], airportCodes: ['NKG'], code: 'NKG' },
  TAO: { name: '青岛', airports: ['TAO-胶东'], airportCodes: ['TAO'], code: 'TAO' },
  DLC: { name: '大连', airports: ['DLC-周水子'], airportCodes: ['DLC'], code: 'DLC' },
  CSX: { name: '长沙', airports: ['CSX-黄花'], airportCodes: ['CSX'], code: 'CSX' },
  SYX: { name: '三亚', airports: ['SYX-凤凰'], airportCodes: ['SYX'], code: 'SYX' },
  HAK: { name: '海口', airports: ['HAK-美兰'], airportCodes: ['HAK'], code: 'HAK' },
  XMN: { name: '厦门', airports: ['XMN-高崎'], airportCodes: ['XMN'], code: 'XMN' },
  TSN: { name: '天津', airports: ['TSN-滨海'], airportCodes: ['TSN'], code: 'TSN' },
  HRB: { name: '哈尔滨', airports: ['HRB-太平'], airportCodes: ['HRB'], code: 'HRB' },
  SHE: { name: '沈阳', airports: ['SHE-桃仙'], airportCodes: ['SHE'], code: 'SHE' },
  CGO: { name: '郑州', airports: ['CGO-新郑'], airportCodes: ['CGO'], code: 'CGO' },
  FOC: { name: '福州', airports: ['FOC-长乐'], airportCodes: ['FOC'], code: 'FOC' },
  NNG: { name: '南宁', airports: ['NNG-吴圩'], airportCodes: ['NNG'], code: 'NNG' },
  KWL: { name: '桂林', airports: ['KWL-两江'], airportCodes: ['KWL'], code: 'KWL' },

  // Other popular
  LXA: { name: '拉萨', airports: ['LXA-贡嘎'], airportCodes: ['LXA'], code: 'LXA' },
  URC: { name: '乌鲁木齐', airports: ['URC-地窝堡'], airportCodes: ['URC'], code: 'URC' },
  HLH: { name: '呼和浩特', airports: ['HLH-白塔'], airportCodes: ['HLH'], code: 'HLH' },

  // International
  ICN: { name: '首尔', airports: ['ICN-仁川'], airportCodes: ['ICN'], code: 'ICN' },
  NRT: { name: '东京', airports: ['NRT-成田'], airportCodes: ['NRT'], code: 'NRT' },
  KIX: { name: '大阪', airports: ['KIX-关西'], airportCodes: ['KIX'], code: 'KIX' },
  BKK: { name: '曼谷', airports: ['BKK-素万那普'], airportCodes: ['BKK'], code: 'BKK' },
  SIN: { name: '新加坡', airports: ['SIN-樟宜'], airportCodes: ['SIN'], code: 'SIN' },
  HKG: { name: '香港', airports: ['HKG-赤鱲角'], airportCodes: ['HKG'], code: 'HKG' },
  TPE: { name: '台北', airports: ['TPE-桃园'], airportCodes: ['TPE'], code: 'TPE' },
};

// Build reverse lookup: Chinese name → code
const ALIAS_MAP = {};
for (const [code, info] of Object.entries(CITY_MAP)) {
  ALIAS_MAP[code.toLowerCase()] = code;
  ALIAS_MAP[info.name] = code;
}

// Common IATA airport code aliases → city code
const IATA_ALIASES = {
  PVG: 'SHA', // 浦东 → 上海
  PEK: 'BJS', // 首都 → 北京
  PKX: 'BJS', // 大兴 → 北京
  TFU: 'CTU', // 双流 → 成都
};

// Pinyin aliases → city code
const PINYIN_ALIASES = {
  shanghai: 'SHA',
  beijing: 'BJS',
  guangzhou: 'CAN',
  chengdu: 'CTU',
  shenzhen: 'SZX',
  chongqing: 'CKG',
  kunming: 'KMG',
  xian: 'XIY',
  wuhan: 'WUH',
  hangzhou: 'HGH',
  nanjing: 'NKG',
  qingdao: 'TAO',
  dalian: 'DLC',
  changsha: 'CSX',
  sanya: 'SYX',
  haikou: 'HAK',
  xiamen: 'XMN',
  tianjin: 'TSN',
  harbin: 'HRB',
  shenyang: 'SHE',
  zhengzhou: 'CGO',
  fuzhou: 'FOC',
  nanning: 'NNG',
  guilin: 'KWL',
  lhasa: 'LXA',
  urumqi: 'URC',
};

/**
 * Resolve a city input to a city code
 * Supports: IATA code, Chinese city name, pinyin
 */
function resolveCity(input) {
  if (!input) return null;
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();

  // Direct code match
  if (CITY_MAP[upper]) return upper;

  // IATA airport code alias
  if (IATA_ALIASES[upper]) return IATA_ALIASES[upper];

  // Pinyin alias
  if (PINYIN_ALIASES[trimmed.toLowerCase()]) return PINYIN_ALIASES[trimmed.toLowerCase()];

  // Chinese name match
  if (ALIAS_MAP[trimmed]) return ALIAS_MAP[trimmed];

  // Lowercase code match
  if (ALIAS_MAP[trimmed.toLowerCase()]) return ALIAS_MAP[trimmed.toLowerCase()];

  return null;
}

/**
 * Get the airport codes for a city (used in API depCode/arrCode)
 */
function getAirportCodes(cityCode) {
  const city = CITY_MAP[cityCode];
  return city ? city.airportCodes : [];
}

/**
 * Get city display name
 */
function getCityName(code) {
  const city = CITY_MAP[code];
  return city ? `${city.name}(${code})` : code;
}

/**
 * List all supported cities
 */
function listCities() {
  return Object.entries(CITY_MAP).map(([code, info]) => ({
    code,
    name: info.name,
    airports: info.airports,
  }));
}

module.exports = { CITY_MAP, resolveCity, getAirportCodes, getCityName, listCities };
