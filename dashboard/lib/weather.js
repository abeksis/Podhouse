'use strict';

// The forecast on the Overview.
//
// Open-Meteo: free, no key, no account. The box asks for the forecast of one
// place and caches it; the page never talks to anyone but the box (its CSP
// allows only 'self'). What leaves the box is the place's coordinates — the
// same thing any weather app sends — and HB_WEATHER=off stops even that.
//
// The place is the one typed into the tile (prefs.json), else HB_WEATHER_PLACE,
// else the city in the box's timezone ("Asia/Jerusalem" -> "Jerusalem"). A box on UTC has no city to
// guess, and says so rather than showing somebody else's weather.

const fs = require('node:fs');
const path = require('node:path');

const FORECAST_TTL = 20 * 60 * 1000;
const HOST_ROOT = process.env.HOMEBOX_HOST_ROOT || (fs.existsSync('/host/root') ? '/host/root' : '/');

let geo = null; // { query, name, country, latitude, longitude }
let cache = null; // { at, data }

/** The box's timezone: the container's TZ, else the host's own /etc/localtime. */
function timezone() {
  const tz = process.env.TZ;
  if (tz && tz !== 'UTC' && tz !== 'Etc/UTC') return tz;
  try {
    const link = fs.readlinkSync(path.join(HOST_ROOT, 'etc/localtime'));
    const m = /zoneinfo\/(.+)$/.exec(link);
    if (m) return m[1];
  } catch { /* not a link, or not mounted: no guess */ }
  return null;
}

/** "Asia/Jerusalem" -> "Jerusalem", "America/New_York" -> "New York". */
function placeFromZone(tz) {
  if (!tz || !tz.includes('/')) return null;
  return tz.split('/').pop().replace(/_/g, ' ');
}

/**
 * What to ask the forecast for: a place picked from the suggestions (an
 * object with its own coordinates — no second lookup, no guessing between
 * two towns of the same name), else a name to look up.
 */
function place(chosen) {
  if (chosen && typeof chosen === 'object' && Number.isFinite(chosen.lat) && Number.isFinite(chosen.lon)) return chosen;
  return (typeof chosen === 'string' ? chosen.trim() : '') || (process.env.HB_WEATHER_PLACE || '').trim() || placeFromZone(timezone());
}

/** The geocoder matches names in the language it is asked in, so ask in the script typed. */
function languageOf(text) {
  return /[֐-׿]/.test(text) ? 'he' : /[؀-ۿ]/.test(text) ? 'ar'
    : /[Ѐ-ӿ]/.test(text) ? 'ru' : 'en';
}

/**
 * Places for the tile's suggestion list, as the name is typed.
 *
 * The geocoder only knows a place by the spelling it holds — "beer sheva"
 * finds nothing, "Beersheba" does — but it matches from the start of a name,
 * so a list that follows the typing finds it by "beers". Places in the box's
 * own timezone come first; the rest keep the geocoder's order.
 */
async function search(query) {
  const q = String(query || '').trim();
  if (q.length < 2 || q.length > 80) return [];
  const ask = async (name) => {
    const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=10&language=${languageOf(name)}&format=json&name=${encodeURIComponent(name)}`);
    return data && Array.isArray(data.results) ? data.results : [];
  };
  // Nothing for the name as typed: try the ways people spell a transliterated
  // name — the words run together, v for b (Hebrew ב is both), and finally
  // just its start, which the geocoder matches as a prefix. "beer sheva"
  // finds Beersheba by the last of these.
  let results = await ask(q);
  const joined = q.toLowerCase().replace(/[\s'’-]+/g, '');
  for (const alt of [joined, joined.replace(/v/g, 'b'), joined.slice(0, Math.max(4, Math.min(6, joined.length - 2)))]) {
    if (results.length || alt.length < 3 || alt === q.toLowerCase()) continue;
    results = await ask(alt);
  }
  const home = timezone();
  const rows = results.map((r, i) => ({
    name: r.name, region: r.admin1 || '', country: r.country || r.country_code || '',
    lat: r.latitude, lon: r.longitude, local: Boolean(home && r.timezone === home), i,
  }));
  rows.sort((a, b) => (b.local - a.local) || (a.i - b.i));
  return rows.slice(0, 8).map(({ local, i, ...r }) => r);
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`weather service answered ${res.status}`);
  return res.json();
}

async function locate(query) {
  if (geo && geo.query === query) return geo;
  const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=${languageOf(query)}&format=json&name=${encodeURIComponent(query)}`);
  const hit = data && Array.isArray(data.results) && data.results[0];
  if (!hit) throw new Error(`no place called "${query}"`);
  geo = { query, name: hit.name, country: hit.country_code || '', latitude: hit.latitude, longitude: hit.longitude };
  return geo;
}

// WMO weather codes, as the forecast returns them, to a word and a symbol.
const CODES = [
  [[0], 'Clear', '☀️'], [[1], 'Mostly clear', '🌤️'], [[2], 'Partly cloudy', '⛅'], [[3], 'Cloudy', '☁️'],
  [[45, 48], 'Fog', '🌫️'], [[51, 53, 55, 56, 57], 'Drizzle', '🌦️'], [[61, 63, 65, 66, 67], 'Rain', '🌧️'],
  [[71, 73, 75, 77], 'Snow', '🌨️'], [[80, 81, 82], 'Showers', '🌦️'], [[85, 86], 'Snow showers', '🌨️'],
  [[95, 96, 99], 'Thunderstorm', '⛈️'],
];
function describe(code) {
  const hit = CODES.find(([codes]) => codes.includes(Number(code)));
  return hit ? { label: hit[1], icon: hit[2] } : { label: 'Unknown', icon: '·' };
}

async function forecast({ place: chosen, units = 'c' } = {}) {
  const fahrenheit = units === 'f';
  if (/^(off|false|0|no)$/i.test(process.env.HB_WEATHER || '')) return { enabled: false };
  const where = place(chosen);
  if (!where) return { enabled: true, place: null, error: 'No city set yet' };
  // One cache key for both shapes: a picked place by its coordinates, a name by itself.
  const query = `${typeof where === 'object' ? `${where.lat},${where.lon}` : where}|${fahrenheit ? 'f' : 'c'}`;
  if (cache && cache.query === query && Date.now() - cache.at < FORECAST_TTL) return cache.data;
  try {
    const loc = typeof where === 'object'
      ? { name: where.name, country: where.country || '', latitude: where.lat, longitude: where.lon }
      : await locate(where);
    const q = new URLSearchParams({
      latitude: loc.latitude, longitude: loc.longitude, timezone: 'auto', forecast_days: '4',
      temperature_unit: fahrenheit ? 'fahrenheit' : 'celsius', wind_speed_unit: fahrenheit ? 'mph' : 'kmh',
      current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    });
    const raw = await getJson(`https://api.open-meteo.com/v1/forecast?${q}`);
    const c = raw.current || {};
    const d = raw.daily || {};
    const data = {
      enabled: true,
      place: loc.name,
      country: loc.country,
      now: {
        temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature),
        wind: Math.round(c.wind_speed_10m), humidity: Math.round(c.relative_humidity_2m),
        ...describe(c.weather_code),
      },
      days: (d.time || []).map((date, i) => ({
        date, max: Math.round(d.temperature_2m_max[i]), min: Math.round(d.temperature_2m_min[i]),
        rain: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
        ...describe(d.weather_code[i]),
      })),
      units: fahrenheit ? 'f' : 'c',
      at: new Date().toISOString(),
    };
    cache = { query, at: Date.now(), data };
    return data;
  } catch (err) {
    // A stale forecast beats none; say it is stale rather than hide it.
    if (cache && cache.query === query) return { ...cache.data, stale: true };
    return { enabled: true, place: typeof where === 'object' ? where.name : where, error: err.message };
  }
}

module.exports = { forecast, search, placeFromZone, describe };
