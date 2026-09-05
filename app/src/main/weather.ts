// Open-Meteo 免费天气（无需 API Key）：地理编码 + 实时天气，带 30 分钟缓存。
const CACHE_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 6_000;

const WMO_CODES: Record<number, string> = {
  0: '晴', 1: '基本晴', 2: '局部多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '浓毛毛雨',
  56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨',
  85: '阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹',
};

let cache: { city: string; at: number; text: string } | undefined;

interface GeoResponse {
  results?: Array<{ name: string; latitude: number; longitude: number }>;
}

interface ForecastResponse {
  current?: {
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    weather_code: number;
    wind_speed_10m: number;
  };
  daily?: {
    temperature_2m_max: number[];
    temperature_2m_min: number[];
  };
}

async function getJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`weather HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// 返回一段中文天气描述；网络失败或城市未找到时返回 undefined（调用方跳过注入即可）。
export async function fetchWeatherText(city: string): Promise<string | undefined> {
  const now = Date.now();
  if (cache && cache.city === city && now - cache.at < CACHE_MS) return cache.text;
  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
    const geo = await getJson<GeoResponse>(geoUrl);
    const location = geo.results?.[0];
    if (!location) return undefined;
    const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto&wind_speed_unit=ms`;
    const forecast = await getJson<ForecastResponse>(forecastUrl);
    const current = forecast.current;
    if (!current) return undefined;
    const description = WMO_CODES[current.weather_code] ?? '未知天气';
    let text = `${location.name}当前${description}，气温 ${Math.round(current.temperature_2m)}°C（体感 ${Math.round(current.apparent_temperature)}°C），湿度 ${Math.round(current.relative_humidity_2m)}%，风速 ${current.wind_speed_10m.toFixed(1)}m/s`;
    const max = forecast.daily?.temperature_2m_max?.[0];
    const min = forecast.daily?.temperature_2m_min?.[0];
    if (max !== undefined && min !== undefined) text += `，今天 ${Math.round(min)}~${Math.round(max)}°C`;
    cache = { city, at: now, text };
    return text;
  } catch {
    return undefined;
  }
}
