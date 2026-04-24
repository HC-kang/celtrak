interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  CACHE_TTL_SECONDS?: string;
}

type DataOrigin = 'OSINT' | 'DERIVED' | 'USER' | 'STALE';

interface CatalogEntry {
  origin: DataOrigin;
  fetchedAt: string;
  group: string;
  satcat: {
    catalogNumber: number;
    objectId: string;
    objectName: string;
    objectType: 'PAYLOAD' | 'ROCKET BODY' | 'DEBRIS' | 'UNKNOWN' | 'TBA';
    opsStatusCode: string;
    ownerCountry: string;
    launchDate?: string;
    apogeeKm?: number;
    perigeeKm?: number;
    inclinationDeg?: number;
    periodMinutes?: number;
    fetchedAt: string;
  };
  tle?: {
    format: 'TLE' | '3LE';
    line1: string;
    line2: string;
    line0?: string;
  };
}

const CELESTRAK_GROUPS = [
  { key: 'stations', label: 'Stations' },
  { key: 'weather', label: 'Weather' },
  { key: 'gps-ops', label: 'GPS' },
  { key: 'active', label: 'Active' },
] as const;
const API_CACHE_VERSION = 'v3';
const DEFAULT_CATALOG_LIMIT = 20_000;
const MAX_CATALOG_LIMIT = 25_000;
const TLE_FETCH_TIMEOUT_MS = 20_000;
const SATCAT_FETCH_TIMEOUT_MS = 20_000;

interface CelestrakSatcatRecord {
  OBJECT_NAME?: string;
  OBJECT_ID?: string;
  NORAD_CAT_ID?: number | string;
  OBJECT_TYPE?: string;
  OPS_STATUS_CODE?: string;
  OWNER?: string;
  LAUNCH_DATE?: string;
  PERIOD?: number | string;
  INCLINATION?: number | string;
  APOGEE?: number | string;
  PERIGEE?: number | string;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  const ttl = Number(env.CACHE_TTL_SECONDS ?? 900);
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = `/__api-cache/${API_CACHE_VERSION}${url.pathname}`;
  const cacheKey = new Request(cacheUrl.toString(), request);

  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const cached = await caches.default.match(cacheKey);
  if (cached) return withCacheControl(cached, 'no-cache');

  let response: Response;
  try {
    if (url.pathname === '/api/health') {
      response = json({ ok: true, service: 'celestrak-orbit-lab-pro', timestamp: new Date().toISOString() });
    } else if (url.pathname === '/api/celestrak/catalog' || url.pathname === '/api/celestrak/gp') {
      response = json(await getCatalog(url));
    } else if (url.pathname === '/api/swpc/summary') {
      response = json(await getSpaceWeatherSummary());
    } else if (url.pathname === '/api/celestrak/socrates') {
      response = json(createConjunctionFallback('SOCRATES API parser pending'));
    } else if (url.pathname === '/api/celestrak/decay') {
      response = json(createDecayFallback('Decay feed parser pending'));
    } else if (url.pathname === '/api/ground-stations') {
      response = json(createGroundStations());
    } else {
      response = json({ error: 'Not found' }, 404);
    }
  } catch (error) {
    response = json({ error: 'API upstream failed', detail: error instanceof Error ? error.message : 'unknown' }, 502);
  }

  if (response.ok) {
    ctx.waitUntil(caches.default.put(cacheKey, withCacheControl(response.clone(), `public, max-age=${ttl}, stale-while-revalidate=${ttl * 4}`)));
    response.headers.set('cache-control', 'no-cache');
  }

  return response;
}

async function getCatalog(url: URL): Promise<CatalogEntry[]> {
  const requestedGroup = url.searchParams.get('group')?.toLowerCase();
  const limit = clampNumber(Number(url.searchParams.get('limit')), 1, MAX_CATALOG_LIMIT, DEFAULT_CATALOG_LIMIT);
  const groups = requestedGroup ? CELESTRAK_GROUPS.filter((group) => group.key === requestedGroup || group.label.toLowerCase() === requestedGroup) : CELESTRAK_GROUPS;
  const selectedGroups = groups.length ? groups : CELESTRAK_GROUPS;
  const fetchedAt = new Date().toISOString();
  const shouldEnrichSatcat = selectedGroups.some((group) => group.key === 'active');
  const satcatByCatalog = shouldEnrichSatcat ? await fetchSatcatRecords('active').catch(() => new Map<number, CelestrakSatcatRecord>()) : new Map<number, CelestrakSatcatRecord>();
  const settled = await Promise.allSettled(
    selectedGroups.map((group) => fetchTleGroup(group.key).then((tle) => parseTleCatalog(tle, group.label, fetchedAt, satcatByCatalog))),
  );
  const entries = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  if (!entries.length) {
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => (result.reason instanceof Error ? result.reason.message : 'unknown'))
      .join('; ');
    throw new Error(`CelesTrak catalog unavailable${failures ? `: ${failures}` : ''}`);
  }
  return dedupeCatalog(entries).slice(0, limit);
}

async function fetchTleGroup(group: string) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
  const response = await fetchWithTimeout(url, TLE_FETCH_TIMEOUT_MS);
  if (!response.ok) throw new Error(`CelesTrak ${group} ${response.status}`);
  return response.text();
}

async function fetchSatcatRecords(group: string) {
  const rows = await fetchJson<CelestrakSatcatRecord[]>(`https://celestrak.org/satcat/records.php?GROUP=${encodeURIComponent(group)}&FORMAT=JSON`, SATCAT_FETCH_TIMEOUT_MS);
  const records = new Map<number, CelestrakSatcatRecord>();
  for (const row of rows) {
    const catalogNumber = Number(row.NORAD_CAT_ID);
    if (Number.isFinite(catalogNumber)) {
      records.set(catalogNumber, row);
    }
  }
  return records;
}

function parseTleCatalog(text: string, group: string, fetchedAt: string, satcatByCatalog = new Map<number, CelestrakSatcatRecord>()): CatalogEntry[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const entries: CatalogEntry[] = [];

  for (let index = 0; index < lines.length; ) {
    let name = 'UNKNOWN';
    let line1 = lines[index];
    let line2 = lines[index + 1];
    if (!line1?.startsWith('1 ')) {
      name = line1;
      line1 = lines[index + 1];
      line2 = lines[index + 2];
      index += 3;
    } else {
      index += 2;
    }
    if (!line1?.startsWith('1 ') || !line2?.startsWith('2 ')) continue;

    const catalogNumber = Number(line1.slice(2, 7).trim());
    if (!Number.isFinite(catalogNumber)) continue;
    const inclinationDeg = numberOrUndefined(line2.slice(8, 16));
    const eccentricity = numberOrUndefined(`0.${line2.slice(26, 33).trim()}`) ?? 0;
    const meanMotionRevPerDay = numberOrUndefined(line2.slice(52, 63));
    const periodMinutes = meanMotionRevPerDay ? 1440 / meanMotionRevPerDay : undefined;
    const semiMajorAxisKm = meanMotionRevPerDay ? semiMajorAxisFromMeanMotion(meanMotionRevPerDay) : undefined;
    const perigeeKm = semiMajorAxisKm ? semiMajorAxisKm * (1 - eccentricity) - 6378.137 : undefined;
    const apogeeKm = semiMajorAxisKm ? semiMajorAxisKm * (1 + eccentricity) - 6378.137 : undefined;
    const satcat = satcatByCatalog.get(catalogNumber);

    entries.push({
      origin: 'OSINT',
      fetchedAt,
      group,
      satcat: {
        catalogNumber,
        objectId: cleanString(satcat?.OBJECT_ID) ?? line1.slice(9, 17).trim(),
        objectName: cleanString(satcat?.OBJECT_NAME) ?? name,
        objectType: normalizeObjectType(satcat?.OBJECT_TYPE),
        opsStatusCode: normalizeOpsStatus(satcat?.OPS_STATUS_CODE),
        ownerCountry: cleanString(satcat?.OWNER) ?? 'UNKNOWN',
        launchDate: cleanString(satcat?.LAUNCH_DATE),
        inclinationDeg: numberFromUnknown(satcat?.INCLINATION) ?? inclinationDeg,
        apogeeKm: numberFromUnknown(satcat?.APOGEE) ?? apogeeKm,
        perigeeKm: numberFromUnknown(satcat?.PERIGEE) ?? perigeeKm,
        periodMinutes: numberFromUnknown(satcat?.PERIOD) ?? periodMinutes,
        fetchedAt,
      },
      tle: {
        format: 'TLE',
        line0: name,
        line1,
        line2,
      },
    });
  }

  return entries;
}

function dedupeCatalog(entries: CatalogEntry[]) {
  const byCatalogNumber = new Map<number, CatalogEntry>();
  for (const entry of entries) {
    if (!byCatalogNumber.has(entry.satcat.catalogNumber)) {
      byCatalogNumber.set(entry.satcat.catalogNumber, entry);
    }
  }
  return [...byCatalogNumber.values()];
}

function normalizeObjectType(value: unknown): CatalogEntry['satcat']['objectType'] {
  const type = cleanString(value)?.toUpperCase();
  if (type === 'PAY' || type === 'PAYLOAD') return 'PAYLOAD';
  if (type === 'R/B' || type === 'ROCKET BODY') return 'ROCKET BODY';
  if (type === 'DEB' || type === 'DEBRIS') return 'DEBRIS';
  if (type === 'TBA') return 'TBA';
  return 'UNKNOWN';
}

function normalizeOpsStatus(value: unknown) {
  const status = cleanString(value)?.toUpperCase();
  if (!status || status === '-') return 'UNKNOWN';
  if (status === '+') return 'ACTIVE';
  if (status === 'P') return 'PARTIAL';
  if (status === 'B') return 'BACKUP';
  if (status === 'S') return 'SPARE';
  if (status === 'X') return 'EXTENDED';
  return status;
}

async function getSpaceWeatherSummary() {
  const fetchedAt = new Date().toISOString();
  try {
    const [xrayRows, kpRows, alerts] = await Promise.all([
      fetchJson<unknown[]>('https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json'),
      fetchJson<unknown[]>('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json'),
      fetchJson<unknown[]>('https://services.swpc.noaa.gov/products/alerts.json').catch(() => []),
    ]);
    const xraySeries = normalizeXraySeries(xrayRows);
    const latestFlux = xraySeries.at(-1)?.flux ?? null;
    const kp = normalizeKp(kpRows);
    return {
      origin: 'OSINT',
      fetchedAt,
      xray: {
        currentWm2: latestFlux,
        ...classifyXray(latestFlux),
        series: xraySeries,
      },
      kp: {
        current: kp.current,
        forecast: kp.forecast,
        storm: classifyKpStorm(kp.current),
      },
      notices: normalizeAlerts(alerts),
    };
  } catch {
    return createSpaceWeatherFallback();
  }
}

function normalizeXraySeries(rows: unknown[]) {
  return rows
    .filter((row): row is { time_tag: string; flux: number; energy?: string } => typeof row === 'object' && row !== null)
    .filter((row) => !row.energy || row.energy === '0.1-0.8nm')
    .map((row) => ({ t: row.time_tag, flux: Number(row.flux) }))
    .filter((row) => row.t && Number.isFinite(row.flux))
    .slice(-36);
}

function normalizeKp(raw: unknown[]) {
  if (!Array.isArray(raw) || !raw.length) return { current: null, forecast: [] };
  const rows = normalizeKpRows(raw).sort((a, b) => a.t.localeCompare(b.t));
  const now = Date.now();
  const observed = rows.filter((row) => new Date(row.t).getTime() <= now).at(-1);
  const forecast = rows.filter((row) => new Date(row.t).getTime() >= now).slice(0, 12);
  return {
    current: observed?.kp ?? rows.at(-1)?.kp ?? null,
    forecast: forecast.length ? forecast : rows.slice(-12),
  };
}

function normalizeKpRows(raw: unknown[]) {
  if (typeof raw[0] === 'object' && raw[0] !== null && !Array.isArray(raw[0])) {
    return raw
      .map((item) => item as Record<string, unknown>)
      .map((row) => ({ t: String(row.time_tag ?? row.time ?? ''), kp: Number(row.kp) }))
      .filter((row) => row.t && Number.isFinite(row.kp));
  }

  if (raw.length < 2) return [];
  const [header, ...rows] = raw;
  if (!Array.isArray(header)) return [];
  const timeIndex = header.findIndex((item) => String(item).toLowerCase().includes('time'));
  const kpIndex = header.findIndex((item) => String(item).toLowerCase() === 'kp');
  return rows
    .filter(Array.isArray)
    .map((row) => ({ t: String(row[timeIndex >= 0 ? timeIndex : 0]), kp: Number(row[kpIndex >= 0 ? kpIndex : 1]) }))
    .filter((row) => row.t && Number.isFinite(row.kp));
}

function normalizeAlerts(raw: unknown[]) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (Array.isArray(item)) {
        return { issuedAt: String(item[0] ?? new Date().toISOString()), type: String(item[1] ?? 'NOTICE'), text: String(item.at(-1) ?? '') };
      }
      if (typeof item === 'object' && item !== null) {
        const record = item as Record<string, unknown>;
        return {
          issuedAt: String(record.issue_datetime ?? record.issue_time ?? record.time_tag ?? new Date().toISOString()),
          type: String(record.product_id ?? record.message_type ?? 'NOTICE'),
          text: String(record.message ?? record.summary ?? record.text ?? ''),
        };
      }
      return null;
    })
    .filter((item): item is { issuedAt: string; type: string; text: string } => Boolean(item?.text))
    .slice(0, 5);
}

function classifyXray(flux: number | null) {
  if (!flux || flux <= 0) return { flareClass: undefined, classMagnitude: undefined };
  const classes = [
    { label: 'X', base: 1e-4 },
    { label: 'M', base: 1e-5 },
    { label: 'C', base: 1e-6 },
    { label: 'B', base: 1e-7 },
    { label: 'A', base: 1e-8 },
  ] as const;
  const match = classes.find((item) => flux >= item.base) ?? classes.at(-1)!;
  return { flareClass: match.label, classMagnitude: Number((flux / match.base).toFixed(1)) };
}

function classifyKpStorm(kp: number | null) {
  if (kp === null) return 'QUIET';
  if (kp >= 8) return 'SEVERE';
  if (kp >= 7) return 'STRONG';
  if (kp >= 6) return 'MODERATE';
  if (kp >= 5) return 'MINOR';
  if (kp >= 4) return 'UNSETTLED';
  return 'QUIET';
}

function createConjunctionFallback(note: string) {
  const fetchedAt = new Date().toISOString();
  return [
    {
      id: 'fallback-25544-20580',
      origin: 'STALE',
      stale: true,
      tca: new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString(),
      primary: { name: 'ISS (ZARYA)', catalogNumber: 25544 },
      secondary: { name: 'HST', catalogNumber: 20580 },
      missDistanceKm: 12.4,
      relVelocityKmS: 8.7,
      pc: 1.2e-5,
      source: 'celestrak-socrates',
      fetchedAt,
      note,
    },
  ];
}

function createDecayFallback(note: string) {
  return [
    {
      origin: 'STALE',
      stale: true,
      catalogNumber: 29155,
      name: 'GOES 13',
      predictedDecayAt: new Date(Date.now() + 22 * 24 * 60 * 60 * 1000).toISOString(),
      confidence: 'LOW',
      source: 'celestrak-decay',
      fetchedAt: new Date().toISOString(),
      note,
    },
  ];
}

function createGroundStations() {
  return [
    { id: 'gs-nasa-asf-fairbanks', name: 'NASA ASF Fairbanks', latDeg: 64.794, lonDeg: -147.536, altitudeM: 180, elevationMaskDeg: 8, enabled: true, schemaVersion: 1 },
    { id: 'gs-ksat-svalbard', name: 'KSAT Svalbard', latDeg: 78.23, lonDeg: 15.39, altitudeM: 480, elevationMaskDeg: 5, enabled: true, schemaVersion: 1 },
    { id: 'gs-ssc-kiruna', name: 'SSC Kiruna / Esrange', latDeg: 67.8833, lonDeg: 21.0667, altitudeM: 341, elevationMaskDeg: 5, enabled: true, schemaVersion: 1 },
    { id: 'gs-ssc-santiago', name: 'SSC Santiago', latDeg: -33.15, lonDeg: -70.66, altitudeM: 723, elevationMaskDeg: 8, enabled: true, schemaVersion: 1 },
    { id: 'gs-ksat-trollsat', name: 'KSAT TrollSat', latDeg: -72.0167, lonDeg: 2.5333, altitudeM: 1365, elevationMaskDeg: 5, enabled: true, schemaVersion: 1 },
    { id: 'gs-nasa-wallops', name: 'NASA Wallops', latDeg: 37.94, lonDeg: -75.47, altitudeM: 3, elevationMaskDeg: 10, enabled: true, schemaVersion: 1 },
    { id: 'gs-nasa-white-sands', name: 'NASA White Sands', latDeg: 32.5, lonDeg: -106.61, altitudeM: 1210, elevationMaskDeg: 10, enabled: true, schemaVersion: 1 },
    { id: 'gs-nasa-mcmurdo', name: 'NASA McMurdo', latDeg: -77.85, lonDeg: 166.67, altitudeM: 20, elevationMaskDeg: 5, enabled: true, schemaVersion: 1 },
    { id: 'gs-dsn-goldstone', name: 'DSN Goldstone', latDeg: 35.4267, lonDeg: -116.89, altitudeM: 1000, elevationMaskDeg: 10, enabled: true, schemaVersion: 1 },
    { id: 'gs-dsn-madrid', name: 'DSN Madrid', latDeg: 40.43, lonDeg: -4.25, altitudeM: 850, elevationMaskDeg: 10, enabled: true, schemaVersion: 1 },
    { id: 'gs-dsn-canberra', name: 'DSN Canberra', latDeg: -35.4, lonDeg: 148.98, altitudeM: 690, elevationMaskDeg: 10, enabled: true, schemaVersion: 1 },
    { id: 'gs-sansa-hartebeesthoek', name: 'SANSA Hartebeesthoek', latDeg: -25.89, lonDeg: 27.69, altitudeM: 1415, elevationMaskDeg: 8, enabled: true, schemaVersion: 1 },
    { id: 'gs-seoul', name: 'Seoul Ops', latDeg: 37.5665, lonDeg: 126.978, altitudeM: 38, elevationMaskDeg: 10, enabled: true, schemaVersion: 1 },
    { id: 'gs-houston', name: 'Houston Backup', latDeg: 29.7604, lonDeg: -95.3698, altitudeM: 13, elevationMaskDeg: 12, enabled: true, schemaVersion: 1 },
  ];
}

function createSpaceWeatherFallback() {
  const fetchedAt = new Date().toISOString();
  return {
    origin: 'STALE',
    stale: true,
    fetchedAt,
    xray: { currentWm2: null, series: [] },
    kp: { current: null, forecast: [], storm: 'QUIET' },
    notices: [{ issuedAt: fetchedAt, type: 'FALLBACK', text: 'SWPC upstream unavailable; showing stale-safe fallback.' }],
  };
}

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const response = await fetchWithTimeout(url, timeoutMs);
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'celestrak-orbit-lab-pro/0.1' },
    });
  } finally {
    clearTimeout(timer);
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function withCacheControl(response: Response, value: string) {
  const next = new Response(response.body, response);
  next.headers.set('cache-control', value);
  return next;
}

function numberOrUndefined(value: string) {
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : undefined;
}

function numberFromUnknown(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function cleanString(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

function clampNumber(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function semiMajorAxisFromMeanMotion(meanMotionRevPerDay: number) {
  const mu = 398600.4418;
  const meanMotionRadPerSecond = (meanMotionRevPerDay * 2 * Math.PI) / 86400;
  return Math.cbrt(mu / (meanMotionRadPerSecond * meanMotionRadPerSecond));
}
