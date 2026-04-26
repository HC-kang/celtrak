interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  CACHE_TTL_SECONDS?: string;
  CATALOG_CACHE_TTL_SECONDS?: string;
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

interface ConjunctionRecord {
  id: string;
  origin: DataOrigin;
  stale?: boolean;
  tca: string;
  primary: { name: string; catalogNumber?: number };
  secondary: { name: string; catalogNumber?: number };
  missDistanceKm: number;
  relVelocityKmS: number;
  pc?: number;
  source: 'celestrak-socrates' | 'self-computed';
  fetchedAt: string;
  note?: string;
}

const CELESTRAK_GROUPS = [
  { key: 'stations', label: 'Stations' },
  { key: 'weather', label: 'Weather' },
  { key: 'gps-ops', label: 'GPS' },
  { key: 'active', label: 'Active' },
] as const;
const API_CACHE_VERSION = 'v6';
const DEFAULT_CATALOG_LIMIT = 20_000;
const MAX_CATALOG_LIMIT = 25_000;
const MAX_CATALOG_NUMBER_LOOKUP = 100;
const DEFAULT_CONJUNCTION_LIMIT = 500;
const MAX_CONJUNCTION_LIMIT = 2_000;
const DEFAULT_API_CACHE_TTL_SECONDS = 900;
// CelesTrak GP/SATCAT does not provide usable expiry headers and asks clients not to refetch more than once per 2 hours.
const DEFAULT_CATALOG_CACHE_TTL_SECONDS = 9_000;
const CATALOG_ORIGIN_REFRESH_SECONDS = 7_200;
const TLE_FETCH_TIMEOUT_MS = 20_000;
const SATCAT_FETCH_TIMEOUT_MS = 20_000;
const CATNR_TLE_FETCH_TIMEOUT_MS = 8_000;
const CATNR_SATCAT_FETCH_TIMEOUT_MS = 4_000;
const CATNR_SATCAT_ENRICHMENT_GRACE_MS = 1_200;
const SOCRATES_FETCH_TIMEOUT_MS = 30_000;

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
  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(prewarmCatalogCache(env));
  },
};

async function handleApi(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  const cachePolicy = cachePolicyFor(url, env);
  const cacheKey = createApiCacheKey(url);

  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const cached = await caches.default.match(cacheKey);
  if (cached) {
    if (shouldRefreshCached(cached, cachePolicy.refreshAfterSeconds)) {
      ctx.waitUntil(refreshApiCache(url, cacheKey, cachePolicy));
    }
    return withCacheControl(cached, 'no-cache');
  }

  let response: Response;
  try {
    response = await buildApiResponse(url);
  } catch (error) {
    response = json({ error: 'API upstream failed', detail: error instanceof Error ? error.message : 'unknown' }, 502);
  }

  if (response.ok) {
    ctx.waitUntil(putApiCache(cacheKey, response.clone(), cachePolicy));
    response.headers.set('cache-control', 'no-cache');
  }

  return response;
}

async function buildApiResponse(url: URL) {
  if (url.pathname === '/api/health') {
    return json({ ok: true, service: 'celestrak-orbit-lab-pro', timestamp: new Date().toISOString() });
  }
  if (url.pathname === '/api/celestrak/catalog' || url.pathname === '/api/celestrak/gp') {
    return json(await getCatalog(url));
  }
  if (url.pathname === '/api/swpc/summary') {
    return json(await getSpaceWeatherSummary());
  }
  if (url.pathname === '/api/celestrak/socrates') {
    return json(await getConjunctions(url));
  }
  if (url.pathname === '/api/celestrak/decay') {
    return json(createDecayFallback('Decay feed parser pending'));
  }
  if (url.pathname === '/api/ground-stations') {
    return json(createGroundStations());
  }
  return json({ error: 'Not found' }, 404);
}

async function prewarmCatalogCache(env: Env) {
  const url = new URL('https://celtrak-cache.internal/api/celestrak/catalog?group=active&limit=20000');
  const cacheKey = createApiCacheKey(url);
  const cachePolicy = cachePolicyFor(url, env);
  const cached = await caches.default.match(cacheKey);
  if (cached && !shouldRefreshCached(cached, cachePolicy.refreshAfterSeconds)) return;
  await refreshApiCache(url, cacheKey, cachePolicy);
}

async function refreshApiCache(url: URL, cacheKey: Request, cachePolicy: ApiCachePolicy) {
  try {
    const response = await buildApiResponse(url);
    if (response.ok) {
      await putApiCache(cacheKey, response, cachePolicy);
    }
  } catch (error) {
    console.warn('API cache refresh failed', error);
  }
}

async function putApiCache(cacheKey: Request, response: Response, cachePolicy: ApiCachePolicy) {
  const cacheResponse = withCacheControl(
    response,
    `public, max-age=${cachePolicy.ttlSeconds}, stale-while-revalidate=${cachePolicy.ttlSeconds * 4}`,
  );
  cacheResponse.headers.set('x-cache-created-at', String(Date.now()));
  await caches.default.put(cacheKey, cacheResponse);
}

interface ApiCachePolicy {
  ttlSeconds: number;
  refreshAfterSeconds: number;
}

function cachePolicyFor(url: URL, env: Env): ApiCachePolicy {
  if (isCatalogPath(url)) {
    const ttlSeconds = secondsFromEnv(env.CATALOG_CACHE_TTL_SECONDS, DEFAULT_CATALOG_CACHE_TTL_SECONDS);
    return {
      ttlSeconds,
      refreshAfterSeconds: Math.min(CATALOG_ORIGIN_REFRESH_SECONDS, ttlSeconds),
    };
  }

  const ttlSeconds = secondsFromEnv(env.CACHE_TTL_SECONDS, DEFAULT_API_CACHE_TTL_SECONDS);
  return {
    ttlSeconds,
    refreshAfterSeconds: ttlSeconds,
  };
}

function createApiCacheKey(url: URL) {
  const cacheUrl = new URL('https://celtrak-cache.internal');
  cacheUrl.pathname = `/__api-cache/${API_CACHE_VERSION}${url.pathname}`;

  if (isCatalogPath(url)) {
    const catalogNumbers = catalogNumbersFromUrl(url);
    if (catalogNumbers.length) {
      cacheUrl.searchParams.set('catnr', catalogNumbers.join(','));
    } else {
      cacheUrl.searchParams.set('group', catalogGroupFromUrl(url) ?? 'all');
      cacheUrl.searchParams.set('limit', String(catalogLimitFromUrl(url)));
    }
  } else {
    appendSortedSearchParams(cacheUrl, url.searchParams);
  }

  return new Request(cacheUrl.toString(), { method: 'GET' });
}

function appendSortedSearchParams(target: URL, params: URLSearchParams) {
  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => entries.push([key, value]));
  entries.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
  for (const [key, value] of entries) {
    target.searchParams.append(key, value);
  }
}

function shouldRefreshCached(response: Response, refreshAfterSeconds: number) {
  if (refreshAfterSeconds <= 0) return false;
  const createdAt = Number(response.headers.get('x-cache-created-at'));
  if (!Number.isFinite(createdAt)) return true;
  return Date.now() - createdAt >= refreshAfterSeconds * 1000;
}

function isCatalogPath(url: URL) {
  return url.pathname === '/api/celestrak/catalog' || url.pathname === '/api/celestrak/gp';
}

function secondsFromEnv(value: string | undefined, fallback: number) {
  return clampNumber(Number(value), 60, 86_400, fallback);
}

function catalogGroupFromUrl(url: URL) {
  return cleanString(url.searchParams.get('group') ?? url.searchParams.get('GROUP'))?.toLowerCase();
}

function catalogLimitFromUrl(url: URL) {
  return clampNumber(Number(url.searchParams.get('limit') ?? url.searchParams.get('LIMIT')), 1, MAX_CATALOG_LIMIT, DEFAULT_CATALOG_LIMIT);
}

function catalogNumbersFromUrl(url: URL) {
  const values = ['catnr', 'CATNR', 'catalogNumber', 'catalogNumbers'].flatMap((key) => url.searchParams.getAll(key));
  const numbers = values
    .flatMap((value) => value.split(','))
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  return [...new Set(numbers)].sort((left, right) => left - right);
}

function conjunctionLimitFromUrl(url: URL) {
  return clampNumber(
    Number(url.searchParams.get('limit') ?? url.searchParams.get('LIMIT')),
    1,
    MAX_CONJUNCTION_LIMIT,
    DEFAULT_CONJUNCTION_LIMIT,
  );
}

function socratesOrderFromUrl(url: URL) {
  const order = cleanString(url.searchParams.get('order') ?? url.searchParams.get('ORDER'))?.toUpperCase();
  if (order === 'MAXPROB') return 'maxProb';
  if (order === 'TCA') return 'tca';
  if (order === 'RELSPEED') return 'relSpeed';
  if (order === 'SSC') return 'ssc';
  return 'minRange';
}

async function getCatalog(url: URL): Promise<CatalogEntry[]> {
  const catalogNumbers = catalogNumbersFromUrl(url);
  if (catalogNumbers.length) {
    return getCatalogByCatalogNumbers(catalogNumbers.slice(0, MAX_CATALOG_NUMBER_LOOKUP));
  }

  const requestedGroup = catalogGroupFromUrl(url);
  const limit = catalogLimitFromUrl(url);
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

async function getCatalogByCatalogNumbers(catalogNumbers: number[]): Promise<CatalogEntry[]> {
  const fetchedAt = new Date().toISOString();
  const lookupResults = await Promise.allSettled(
    catalogNumbers.map((catalogNumber) => lookupCatalogNumber(catalogNumber, fetchedAt)),
  );

  const entries = lookupResults.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  if (!entries.length) {
    const failures = lookupResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => (result.reason instanceof Error ? result.reason.message : 'unknown'))
      .join('; ');
    throw new Error(`CelesTrak catalog lookup unavailable${failures ? `: ${failures}` : ''}`);
  }
  return dedupeCatalog(entries);
}

async function lookupCatalogNumber(catalogNumber: number, fetchedAt: string): Promise<CatalogEntry[]> {
  const satcatLookup = settlePromise(fetchSatcatRecord(catalogNumber, CATNR_SATCAT_FETCH_TIMEOUT_MS));
  const tleResult = await settlePromise(fetchTleByCatalogNumber(catalogNumber, CATNR_TLE_FETCH_TIMEOUT_MS));
  const earlySatcatResult = await settleWithin(satcatLookup, CATNR_SATCAT_ENRICHMENT_GRACE_MS);

  if (tleResult.status === 'fulfilled') {
    const satcatByCatalog = new Map<number, CelestrakSatcatRecord>();
    const satcat = earlySatcatResult?.status === 'fulfilled' ? earlySatcatResult.value : undefined;
    if (satcat) {
      const satcatCatalogNumber = Number(satcat.NORAD_CAT_ID);
      if (Number.isFinite(satcatCatalogNumber)) {
        satcatByCatalog.set(satcatCatalogNumber, satcat);
      }
    }
    const parsed = parseTleCatalog(tleResult.value, 'Tracked', fetchedAt, satcatByCatalog);
    if (parsed.length) return parsed;
  }

  const satcatResult = earlySatcatResult ?? await satcatLookup;
  const satcatOnly = satcatResult.status === 'fulfilled' ? catalogEntryFromSatcat(satcatResult.value, fetchedAt) : null;
  if (satcatOnly) return [satcatOnly];

  const tleError = tleResult.status === 'rejected' && tleResult.reason instanceof Error ? tleResult.reason.message : 'no TLE rows';
  const satcatError = satcatResult.status === 'rejected' && satcatResult.reason instanceof Error ? satcatResult.reason.message : 'no SATCAT row';
  throw new Error(`CATNR=${catalogNumber}: ${tleError}; ${satcatError}`);
}

function settlePromise<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
}

function settleWithin<T>(promise: Promise<PromiseSettledResult<T>>, timeoutMs: number): Promise<PromiseSettledResult<T> | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      setTimeout(() => resolve(undefined), timeoutMs);
    }),
  ]);
}

function catalogEntryFromSatcat(record: CelestrakSatcatRecord, fetchedAt: string): CatalogEntry | null {
  const catalogNumber = Number(record.NORAD_CAT_ID);
  if (!Number.isFinite(catalogNumber)) return null;
  return {
    origin: 'OSINT',
    fetchedAt,
    group: 'SATCAT',
    satcat: {
      catalogNumber,
      objectId: cleanString(record.OBJECT_ID) ?? '',
      objectName: cleanString(record.OBJECT_NAME) ?? `NORAD ${catalogNumber}`,
      objectType: normalizeObjectType(record.OBJECT_TYPE),
      opsStatusCode: normalizeOpsStatus(record.OPS_STATUS_CODE),
      ownerCountry: cleanString(record.OWNER) ?? 'UNKNOWN',
      launchDate: cleanString(record.LAUNCH_DATE),
      inclinationDeg: numberFromUnknown(record.INCLINATION),
      apogeeKm: numberFromUnknown(record.APOGEE),
      perigeeKm: numberFromUnknown(record.PERIGEE),
      periodMinutes: numberFromUnknown(record.PERIOD),
      fetchedAt,
    },
  };
}

async function fetchTleGroup(group: string) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
  const response = await fetchWithTimeout(url, TLE_FETCH_TIMEOUT_MS);
  if (!response.ok) throw new Error(`CelesTrak ${group} ${response.status}`);
  return response.text();
}

async function fetchTleByCatalogNumber(catalogNumber: number, timeoutMs = TLE_FETCH_TIMEOUT_MS) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${encodeURIComponent(catalogNumber)}&FORMAT=tle`;
  const response = await fetchWithTimeout(url, timeoutMs);
  if (!response.ok) throw new Error(`CelesTrak CATNR=${catalogNumber} ${response.status}`);
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

async function fetchSatcatRecord(catalogNumber: number, timeoutMs = SATCAT_FETCH_TIMEOUT_MS) {
  const rows = await fetchJson<CelestrakSatcatRecord[]>(
    `https://celestrak.org/satcat/records.php?CATNR=${encodeURIComponent(catalogNumber)}&FORMAT=JSON`,
    timeoutMs,
  );
  const record = rows[0];
  if (!record) throw new Error(`CelesTrak SATCAT CATNR=${catalogNumber} empty`);
  return record;
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

async function getConjunctions(url: URL): Promise<ConjunctionRecord[]> {
  const limit = conjunctionLimitFromUrl(url);
  const catalogNumbers = new Set(catalogNumbersFromUrl(url));
  const order = socratesOrderFromUrl(url);
  try {
    const response = await fetchWithTimeout(socratesCsvUrl(order), SOCRATES_FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`SOCRATES ${order} ${response.status}`);
    const lastModified = response.headers.get('last-modified');
    const fetchedAt = lastModified ? new Date(lastModified).toISOString() : new Date().toISOString();
    return parseSocratesCsv(await response.text(), {
      catalogNumbers,
      fetchedAt,
      limit,
    });
  } catch (error) {
    return createConjunctionFallback(error instanceof Error ? error.message : 'SOCRATES CSV unavailable');
  }
}

function socratesCsvUrl(order: string) {
  const file =
    order === 'maxProb'
      ? 'sort-maxProb.csv'
      : order === 'tca'
        ? 'sort-tca.csv'
        : order === 'relSpeed'
          ? 'sort-relSpeed.csv'
          : order === 'ssc'
            ? 'sort-ssc.csv'
            : 'sort-minRange.csv';
  return `https://celestrak.org/SOCRATES/${file}`;
}

function parseSocratesCsv(
  text: string,
  options: { catalogNumbers: Set<number>; fetchedAt: string; limit: number },
): ConjunctionRecord[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const [headerLine, ...rows] = lines;
  const headers = parseCsvLine(headerLine ?? '');
  const indexes = Object.fromEntries(headers.map((header, index) => [header, index]));
  const records: ConjunctionRecord[] = [];

  for (const row of rows) {
    const cells = parseCsvLine(row);
    const catalogNumber1 = numberFromCsv(cells[indexes.NORAD_CAT_ID_1]);
    const catalogNumber2 = numberFromCsv(cells[indexes.NORAD_CAT_ID_2]);
    if (
      options.catalogNumbers.size &&
      (!catalogNumber1 || !options.catalogNumbers.has(catalogNumber1)) &&
      (!catalogNumber2 || !options.catalogNumbers.has(catalogNumber2))
    ) {
      continue;
    }

    const tca = normalizeSocratesTimestamp(cells[indexes.TCA]);
    const missDistanceKm = numberFromCsv(cells[indexes.TCA_RANGE]);
    const relVelocityKmS = numberFromCsv(cells[indexes.TCA_RELATIVE_SPEED]);
    if (!tca || missDistanceKm === undefined || relVelocityKmS === undefined) continue;

    records.push({
      id: `socrates-${catalogNumber1 ?? 'unknown'}-${catalogNumber2 ?? 'unknown'}-${tca.replace(/\W/g, '')}`,
      origin: 'OSINT',
      tca,
      primary: {
        name: cleanSocratesObjectName(cells[indexes.OBJECT_NAME_1]) ?? `NORAD ${catalogNumber1 ?? 'unknown'}`,
        catalogNumber: catalogNumber1,
      },
      secondary: {
        name: cleanSocratesObjectName(cells[indexes.OBJECT_NAME_2]) ?? `NORAD ${catalogNumber2 ?? 'unknown'}`,
        catalogNumber: catalogNumber2,
      },
      missDistanceKm,
      relVelocityKmS,
      pc: numberFromCsv(cells[indexes.MAX_PROB]),
      source: 'celestrak-socrates',
      fetchedAt: options.fetchedAt,
    });

    if (records.length >= options.limit) break;
  }

  return records;
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];
    if (character === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === ',' && !quoted) {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += character;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

function normalizeSocratesTimestamp(value: string | undefined) {
  const text = cleanString(value);
  if (!text) return undefined;
  const date = new Date(`${text.replace(' ', 'T')}Z`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function cleanSocratesObjectName(value: string | undefined) {
  return cleanString(value)?.replace(/\s+\[[^\]]+\]$/, '');
}

function numberFromCsv(value: string | undefined) {
  const text = cleanString(value);
  if (!text) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
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
  const asfSource = {
    confidence: 'default',
    label: 'ASF public station-mask reference; numeric mask not published',
    url: 'https://asf.alaska.edu/asf-satellite-tracking-stations/',
  };
  const ksatSource = {
    confidence: 'default',
    label: 'KSAT public ground-network listing; operational mask not published',
    url: 'https://www.ksat.no/services/ground-network-services/',
  };
  const sscSource = {
    confidence: 'default',
    label: 'SSC public ground-network listing; operational mask not published',
    url: 'https://sscspace.com/services/ground-network/',
  };
  const nasaNsnSource = {
    confidence: 'default',
    label: 'NASA Near Space Network public complex listing; numeric mask not published',
    url: 'https://www.nasa.gov/technology/space-comms/near-space-network-complexes/',
  };
  const dsnSource = {
    confidence: 'inferred',
    label: 'JPL DSN 810-005 coverage guidance; 10° scalar is conservative',
    url: 'https://deepspace.jpl.nasa.gov/dsndocs/810-005/ground-station-properties/',
  };
  const sansaSource = {
    confidence: 'default',
    label: 'SANSA public space-operations listing; operational mask not published',
    url: 'https://www.sansa.org.za/products-services/space-operations/',
  };
  const sampleSource = {
    confidence: 'default',
    label: 'App sample station; replace with user operational mask',
  };
  return [
    { id: 'gs-nasa-asf-fairbanks', name: 'NASA ASF Fairbanks', latDeg: 64.794, lonDeg: -147.536, altitudeM: 180, elevationMaskDeg: 8, elevationMaskSource: asfSource, enabled: true, schemaVersion: 1 },
    { id: 'gs-ksat-svalbard', name: 'KSAT Svalbard', latDeg: 78.23, lonDeg: 15.39, altitudeM: 480, elevationMaskDeg: 5, elevationMaskSource: ksatSource, enabled: true, schemaVersion: 1 },
    { id: 'gs-ssc-kiruna', name: 'SSC Kiruna / Esrange', latDeg: 67.8833, lonDeg: 21.0667, altitudeM: 341, elevationMaskDeg: 5, elevationMaskSource: sscSource, enabled: true, schemaVersion: 1 },
    { id: 'gs-ssc-santiago', name: 'SSC Santiago', latDeg: -33.15, lonDeg: -70.66, altitudeM: 723, elevationMaskDeg: 8, elevationMaskSource: sscSource, enabled: true, schemaVersion: 1 },
    { id: 'gs-ksat-trollsat', name: 'KSAT TrollSat', latDeg: -72.0167, lonDeg: 2.5333, altitudeM: 1365, elevationMaskDeg: 5, elevationMaskSource: ksatSource, enabled: true, schemaVersion: 1 },
    { id: 'gs-nasa-wallops', name: 'NASA Wallops', latDeg: 37.94, lonDeg: -75.47, altitudeM: 3, elevationMaskDeg: 10, elevationMaskSource: nasaNsnSource, enabled: true, schemaVersion: 1 },
    { id: 'gs-nasa-white-sands', name: 'NASA White Sands', latDeg: 32.5, lonDeg: -106.61, altitudeM: 1210, elevationMaskDeg: 10, elevationMaskSource: nasaNsnSource, enabled: true, schemaVersion: 1 },
    { id: 'gs-nasa-mcmurdo', name: 'NASA McMurdo', latDeg: -77.85, lonDeg: 166.67, altitudeM: 20, elevationMaskDeg: 5, elevationMaskSource: nasaNsnSource, enabled: true, schemaVersion: 1 },
    { id: 'gs-dsn-goldstone', name: 'DSN Goldstone', latDeg: 35.4267, lonDeg: -116.89, altitudeM: 1000, elevationMaskDeg: 10, elevationMaskSource: dsnSource, enabled: true, schemaVersion: 1 },
    { id: 'gs-dsn-madrid', name: 'DSN Madrid', latDeg: 40.43, lonDeg: -4.25, altitudeM: 850, elevationMaskDeg: 10, elevationMaskSource: dsnSource, enabled: true, schemaVersion: 1 },
    { id: 'gs-dsn-canberra', name: 'DSN Canberra', latDeg: -35.4, lonDeg: 148.98, altitudeM: 690, elevationMaskDeg: 10, elevationMaskSource: dsnSource, enabled: true, schemaVersion: 1 },
    { id: 'gs-sansa-hartebeesthoek', name: 'SANSA Hartebeesthoek', latDeg: -25.89, lonDeg: 27.69, altitudeM: 1415, elevationMaskDeg: 8, elevationMaskSource: sansaSource, enabled: true, schemaVersion: 1 },
    { id: 'gs-seoul', name: 'Seoul Ops', latDeg: 37.5665, lonDeg: 126.978, altitudeM: 38, elevationMaskDeg: 10, elevationMaskSource: sampleSource, enabled: true, schemaVersion: 1 },
    { id: 'gs-houston', name: 'Houston Backup', latDeg: 29.7604, lonDeg: -95.3698, altitudeM: 13, elevationMaskDeg: 12, elevationMaskSource: sampleSource, enabled: true, schemaVersion: 1 },
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
