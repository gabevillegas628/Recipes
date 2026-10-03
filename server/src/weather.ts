import { z } from 'zod';
import { prisma } from './db.js';

/**
 * Today's weather, just what matters when packing in the morning: the high and
 * low, and whether rain (or snow) is likely while people are out. From
 * Open-Meteo, which needs no key. The place is set once in Settings.
 */

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_MS = 30 * 60_000;
/** Chance of rain worth an umbrella. */
const LIKELY = 40;
/** The part of the day that counts: 6am up to 10pm. */
const DAY_START = 6;
const DAY_END = 22;
// WMO weather codes for snow.
const SNOW = new Set([71, 73, 75, 77, 85, 86]);

export class WeatherError extends Error {}

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

const geocodeResult = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        admin1: z.string().optional(),
        country: z.string().optional(),
        country_code: z.string().optional(),
      }),
    )
    .optional(),
});

/** Places matching a city name or zip code, best first. */
export async function findPlaces(query: string): Promise<Place[]> {
  const url = `${GEOCODE_URL}?${new URLSearchParams({ name: query, count: '6', language: 'en', format: 'json' })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) throw new WeatherError('Couldn’t look up places right now.');
  const { results = [] } = geocodeResult.parse(await res.json());
  return results.map((r) => ({
    // US places read better with the state than the country.
    name: [r.name, r.admin1, r.country_code === 'US' ? null : r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

export async function getWeatherPlace(): Promise<Place | null> {
  const h = await prisma.household.findUnique({ where: { id: 'default' } });
  return h?.weatherPlace && h.weatherLat != null && h.weatherLon != null
    ? { name: h.weatherPlace, lat: h.weatherLat, lon: h.weatherLon }
    : null;
}

export async function setWeatherPlace(place: Place | null) {
  const data = { weatherPlace: place?.name ?? null, weatherLat: place?.lat ?? null, weatherLon: place?.lon ?? null };
  await prisma.household.upsert({ where: { id: 'default' }, create: { id: 'default', ...data }, update: data });
}

const forecastResult = z.object({
  current: z.object({ time: z.string() }),
  daily: z.object({ temperature_2m_max: z.array(z.number()), temperature_2m_min: z.array(z.number()) }),
  hourly: z.object({
    time: z.array(z.string()),
    precipitation_probability: z.array(z.number().nullable()),
    weather_code: z.array(z.number().nullable()),
  }),
});

export interface Weather {
  place: string;
  high: number;
  low: number;
  /** Set only when rain or snow is likely during the rest of the day. */
  wet: { kind: 'rain' | 'snow'; chance: number; when: string } | null;
}

const cache = new Map<string, { at: number; weather: Weather }>();

export async function getWeather(place: Place): Promise<Weather> {
  const key = `${place.lat},${place.lon}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.weather, place: place.name };

  const params = new URLSearchParams({
    latitude: String(place.lat),
    longitude: String(place.lon),
    current: 'temperature_2m',
    daily: 'temperature_2m_max,temperature_2m_min',
    hourly: 'precipitation_probability,weather_code',
    temperature_unit: 'fahrenheit',
    timezone: 'auto',
    forecast_days: '1',
  });
  const res = await fetch(`${FORECAST_URL}?${params}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) throw new WeatherError('Couldn’t get the forecast right now.');
  const data = forecastResult.parse(await res.json());

  const weather: Weather = {
    place: place.name,
    high: Math.round(data.daily.temperature_2m_max[0]),
    low: Math.round(data.daily.temperature_2m_min[0]),
    wet: wetSpell(data.hourly, Number(data.current.time.slice(11, 13))),
  };
  cache.set(key, { at: Date.now(), weather });
  return weather;
}

/** When rain or snow is likely between now (or 6am) and 10pm, local time. Exported for testing. */
export function wetSpell(hourly: z.infer<typeof forecastResult>['hourly'], nowHour: number): Weather['wet'] {
  const start = Math.max(nowHour, DAY_START);
  const hours = hourly.time
    .map((t, i) => ({ hour: Number(t.slice(11, 13)), chance: hourly.precipitation_probability[i] ?? 0, code: hourly.weather_code[i] }))
    .filter((h) => h.hour >= start && h.hour < DAY_END);
  const wet = hours.filter((h) => h.chance >= LIKELY);
  if (wet.length === 0) return null;

  const from = wet[0].hour;
  const until = wet[wet.length - 1].hour + 1;
  const all = from === start && until === DAY_END;
  const when = all ? (start < 12 ? 'all day' : 'the rest of the day')
    : from === start ? `until ${clock(until)}`
    : until === DAY_END ? `after ${clock(from)}`
    : `${clock(from)}–${clock(until)}`;
  return {
    kind: wet.some((h) => h.code != null && SNOW.has(h.code)) ? 'snow' : 'rain',
    chance: Math.max(...wet.map((h) => h.chance)),
    when,
  };
}

/** 15 -> "3pm", 0 -> "12am". */
function clock(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 || hour === 24 ? 'am' : 'pm'}`;
}
