interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  SOCRATES_BUCKET?: R2BucketLike;
  CACHE_TTL_SECONDS?: string;
  CATALOG_CACHE_TTL_SECONDS?: string;
}

type DataOrigin = 'OSINT' | 'DERIVED' | 'USER' | 'STALE';

interface R2ObjectBodyLike {
  text(): Promise<string>;
}

interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

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
const API_CACHE_VERSION = 'v11';
const CACHEABLE_HEADER = 'x-celtrak-cacheable';
const DEFAULT_CATALOG_LIMIT = 20_000;
const MAX_CATALOG_LIMIT = 25_000;
const MAX_CATALOG_NUMBER_LOOKUP = 100;
const DEFAULT_CONJUNCTION_LIMIT = 500;
const MAX_CONJUNCTION_LIMIT = 2_000;
const MAX_SOCRATES_SEARCH_RESULTS = 1_000;
const MAX_SOCRATES_CATALOG_SEARCH_RESULTS = 100;
const DEFAULT_API_CACHE_TTL_SECONDS = 900;
// CelesTrak GP/SATCAT does not provide usable expiry headers and asks clients not to refetch more than once per 2 hours.
const DEFAULT_CATALOG_CACHE_TTL_SECONDS = 9_000;
const CATALOG_ORIGIN_REFRESH_SECONDS = 7_200;
const TLE_FETCH_TIMEOUT_MS = 20_000;
const SATCAT_FETCH_TIMEOUT_MS = 20_000;
const CATNR_TLE_FETCH_TIMEOUT_MS = 6_000;
const CATNR_SATCAT_FETCH_TIMEOUT_MS = 3_000;
const SOCRATES_FETCH_TIMEOUT_MS = 30_000;
const SOCRATES_RANGE_BYTES = 512 * 1024;
const SOCRATES_FILTERED_RANGE_BYTES = 4 * 1024 * 1024;
const SOCRATES_SNAPSHOT_ORDER = 'minRange';
const SOCRATES_SNAPSHOT_CHUNK_BYTES = 1024 * 1024;
const SOCRATES_SNAPSHOT_MAX_CHUNKS = 64;
const SOCRATES_SNAPSHOT_CHUNK_TIMEOUT_MS = 15_000;
const SOCRATES_SNAPSHOT_STALE_MS = 4 * 60 * 60 * 1000;
const CELESTRAK_ORIGINS = ['http://celestrak.org', 'https://celestrak.org'] as const;
const CELESTRAK_REQUEST_HEADERS = {
  accept: 'text/plain, text/csv, application/json, */*',
};

interface SocratesSnapshotChunk {
  key: string;
  start: number;
  end: number;
  size: number;
}

interface SocratesSnapshotRef {
  snapshotId: string;
  completedAt: string;
  chunks: SocratesSnapshotChunk[];
}

interface SocratesSnapshotManifest extends SocratesSnapshotRef {
  version: 1;
  order: string;
  source: 'celestrak-socrates-csv';
  sourceUrl: string;
  sourceLastModified?: string;
  totalBytes?: number;
  chunkSizeBytes: number;
  previous?: SocratesSnapshotRef;
}

class CatalogLookupMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogLookupMissError';
  }
}

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
    ctx.waitUntil(prewarmSocratesSnapshotAndCache(env));
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
      ctx.waitUntil(refreshApiCache(url, cacheKey, cachePolicy, env));
    }
    return withCacheControl(cached, 'no-cache');
  }

  let response: Response;
  try {
    response = await buildApiResponse(url, env);
  } catch (error) {
    response = json({ error: 'API upstream failed', detail: error instanceof Error ? error.message : 'unknown' }, 502);
  }

  if (response.ok && isCacheableApiResponse(response)) {
    ctx.waitUntil(putApiCache(cacheKey, response.clone(), cachePolicy));
  }
  if (!response.headers.has('cache-control')) {
    response.headers.set('cache-control', 'no-cache');
  }

  return response;
}

async function buildApiResponse(url: URL, env: Env) {
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
    const records = await getConjunctions(url, env);
    return json(records, 200, hasSyntheticConjunctionFallback(records) ? { [CACHEABLE_HEADER]: 'false', 'cache-control': 'no-store' } : undefined);
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
  await refreshApiCache(url, cacheKey, cachePolicy, env);
}

async function prewarmSocratesSnapshotAndCache(env: Env) {
  try {
    await refreshSocratesSnapshot(env, SOCRATES_SNAPSHOT_ORDER);
  } catch (error) {
    console.warn('SOCRATES snapshot refresh failed', error);
  }

  const url = new URL('https://celtrak-cache.internal/api/celestrak/socrates?order=MINRANGE&limit=500');
  const cacheKey = createApiCacheKey(url);
  const cachePolicy = cachePolicyFor(url, env);
  await refreshApiCache(url, cacheKey, cachePolicy, env);
}

async function refreshApiCache(url: URL, cacheKey: Request, cachePolicy: ApiCachePolicy, env: Env) {
  try {
    const response = await buildApiResponse(url, env);
    if (response.ok && isCacheableApiResponse(response)) {
      await putApiCache(cacheKey, response, cachePolicy);
    }
  } catch (error) {
    console.warn('API cache refresh failed', error);
  }
}

function isCacheableApiResponse(response: Response) {
  return response.headers.get(CACHEABLE_HEADER) !== 'false';
}

function hasSyntheticConjunctionFallback(records: ConjunctionRecord[]) {
  return records.some((item) => item.id.startsWith('fallback-'));
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
  const hasCompletedLookup = lookupResults.some((result) => result.status === 'fulfilled');
  if (!entries.length) {
    if (hasCompletedLookup) return [];
    const failures = lookupResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => (result.reason instanceof Error ? result.reason.message : 'unknown'))
      .join('; ');
    throw new Error(`CelesTrak catalog lookup unavailable${failures ? `: ${failures}` : ''}`);
  }
  return dedupeCatalog(entries);
}

async function lookupCatalogNumber(catalogNumber: number, fetchedAt: string): Promise<CatalogEntry[]> {
  const tleResult = await settlePromise(fetchTleByCatalogNumber(catalogNumber, CATNR_TLE_FETCH_TIMEOUT_MS));
  let tleMiss = tleResult.status === 'rejected' && isCatalogLookupMissError(tleResult.reason);

  if (tleResult.status === 'fulfilled') {
    const parsed = parseTleCatalog(tleResult.value, 'Tracked', fetchedAt);
    if (parsed.length) return parsed;
    tleMiss = true;
  }

  const satcatResult = await settlePromise(fetchSatcatRecord(catalogNumber, CATNR_SATCAT_FETCH_TIMEOUT_MS));
  const satcatOnly = satcatResult.status === 'fulfilled' ? catalogEntryFromSatcat(satcatResult.value, fetchedAt) : null;
  if (satcatOnly) return [satcatOnly];
  const satcatMiss = satcatResult.status === 'rejected' && isCatalogLookupMissError(satcatResult.reason);
  if (tleMiss && satcatMiss) return [];

  const tleError = tleResult.status === 'rejected' && tleResult.reason instanceof Error ? tleResult.reason.message : 'no TLE rows';
  const satcatError = satcatResult.status === 'rejected' && satcatResult.reason instanceof Error ? satcatResult.reason.message : 'no SATCAT row';
  throw new Error(`CATNR=${catalogNumber}: ${tleError}; ${satcatError}`);
}

function isCatalogLookupMissError(error: unknown) {
  return error instanceof CatalogLookupMissError;
}

function settlePromise<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
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
  const { text } = await fetchCelestrakText(`/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`, TLE_FETCH_TIMEOUT_MS);
  return text;
}

async function fetchTleByCatalogNumber(catalogNumber: number, timeoutMs = TLE_FETCH_TIMEOUT_MS) {
  const { text } = await fetchCelestrakText(`/NORAD/elements/gp.php?CATNR=${encodeURIComponent(catalogNumber)}&FORMAT=tle`, timeoutMs);
  if (!text.trim() || /No GP data found/i.test(text)) {
    throw new CatalogLookupMissError(`CelesTrak CATNR=${catalogNumber} no TLE rows`);
  }
  return text;
}

async function fetchSatcatRecords(group: string) {
  const { text, url } = await fetchCelestrakText(`/satcat/records.php?GROUP=${encodeURIComponent(group)}&FORMAT=JSON`, SATCAT_FETCH_TIMEOUT_MS);
  const rows = parseJsonResponse<CelestrakSatcatRecord[]>(url, text);
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
  const { text, url } = await fetchCelestrakText(`/satcat/records.php?CATNR=${encodeURIComponent(catalogNumber)}&FORMAT=JSON`, timeoutMs);
  if (!text.trim() || /No SATCAT records found/i.test(text)) {
    throw new CatalogLookupMissError(`CelesTrak SATCAT CATNR=${catalogNumber} empty`);
  }
  const rows = parseJsonResponse<CelestrakSatcatRecord[]>(url, text);
  const record = rows[0];
  if (!record) throw new CatalogLookupMissError(`CelesTrak SATCAT CATNR=${catalogNumber} empty`);
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

async function getConjunctions(url: URL, env: Env): Promise<ConjunctionRecord[]> {
  const limit = conjunctionLimitFromUrl(url);
  const catalogNumberValues = catalogNumbersFromUrl(url);
  const catalogNumbers = new Set(catalogNumberValues);
  const order = socratesOrderFromUrl(url);

  const snapshotRecords = await getSocratesSnapshotResults(env, order, limit, catalogNumbers).catch((error) => {
    console.warn('SOCRATES snapshot read failed', error);
    return null;
  });
  if (snapshotRecords) return snapshotRecords;

  try {
    return await getSocratesSearchResults(order, limit, catalogNumberValues);
  } catch (searchError) {
    try {
      const { response, text } = await fetchSocratesCsv(order, limit, catalogNumbers.size > 0);
      const lastModified = response.headers.get('last-modified');
      const fetchedAt = lastModified ? new Date(lastModified).toISOString() : new Date().toISOString();
      return parseSocratesCsv(trimPartialCsv(text, response), {
        catalogNumbers,
        fetchedAt,
        limit,
      });
    } catch (csvError) {
      const searchDetail = searchError instanceof Error ? searchError.message : 'SOCRATES search unavailable';
      const csvDetail = csvError instanceof Error ? csvError.message : 'SOCRATES CSV unavailable';
      return createConjunctionFallback(`${searchDetail}; ${csvDetail}`);
    }
  }
}

async function getSocratesSnapshotResults(env: Env, order: string, limit: number, catalogNumbers: Set<number>) {
  const bucket = env.SOCRATES_BUCKET;
  if (!bucket || order !== SOCRATES_SNAPSHOT_ORDER) return null;

  const manifest = await getSocratesSnapshotManifest(bucket, order);
  if (!manifest) return null;

  return readSocratesSnapshotRecords(bucket, manifest, {
    catalogNumbers,
    fetchedAt: manifest.sourceLastModified ?? manifest.completedAt,
    limit,
  });
}

async function getSocratesSnapshotManifest(bucket: R2BucketLike, order: string) {
  const object = await bucket.get(socratesSnapshotManifestKey(order));
  if (!object) return null;

  const parsed = parseSocratesSnapshotManifest(await object.text());
  if (!parsed || parsed.order !== order || !parsed.chunks.length) return null;
  return parsed;
}

async function readSocratesSnapshotRecords(
  bucket: R2BucketLike,
  manifest: SocratesSnapshotManifest,
  options: { catalogNumbers: Set<number>; fetchedAt: string; limit: number },
) {
  const records: ConjunctionRecord[] = [];
  let lineBuffer = '';
  let indexes: Record<string, number> | null = null;
  const isStale = Date.now() - new Date(manifest.completedAt).getTime() > SOCRATES_SNAPSHOT_STALE_MS;
  const note = isStale ? `SOCRATES snapshot is older than expected; Celtrak snapshot refreshed at ${manifest.completedAt}.` : undefined;

  for (const chunk of [...manifest.chunks].sort((left, right) => left.start - right.start)) {
    const object = await bucket.get(chunk.key);
    if (!object) throw new Error(`SOCRATES snapshot chunk missing: ${chunk.key}`);

    lineBuffer += await object.text();
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const record = parseSocratesCsvLineForSnapshot(line, indexes, {
        catalogNumbers: options.catalogNumbers,
        fetchedAt: options.fetchedAt,
        stale: isStale,
        note,
      });
      if (record === 'header') {
        indexes = csvHeaderIndexes(line);
        continue;
      }
      if (record) records.push(record);
      if (records.length >= options.limit) return records;
    }
  }

  if (lineBuffer.trim()) {
    const record = parseSocratesCsvLineForSnapshot(lineBuffer, indexes, {
      catalogNumbers: options.catalogNumbers,
      fetchedAt: options.fetchedAt,
      stale: isStale,
      note,
    });
    if (record === 'header') {
      indexes = csvHeaderIndexes(lineBuffer);
    } else if (record) {
      records.push(record);
    }
  }

  if (!indexes) throw new Error('SOCRATES snapshot has no CSV header');
  return records.slice(0, options.limit);
}

function parseSocratesCsvLineForSnapshot(
  line: string,
  indexes: Record<string, number> | null,
  options: { catalogNumbers: Set<number>; fetchedAt: string; stale?: boolean; note?: string },
) {
  const normalizedLine = line.replace(/^\uFEFF/, '').trim();
  if (!normalizedLine) return null;
  if (!indexes) return 'header' as const;
  return createSocratesCsvRecord(parseCsvLine(normalizedLine), indexes, options);
}

async function refreshSocratesSnapshot(env: Env, order: string) {
  const bucket = env.SOCRATES_BUCKET;
  if (!bucket || order !== SOCRATES_SNAPSHOT_ORDER) return false;

  const previousManifest = await getSocratesSnapshotManifest(bucket, order).catch(() => null);
  const snapshotId = new Date().toISOString().replace(/[^0-9A-Za-z]/g, '');
  const prefix = socratesSnapshotPrefix(order, snapshotId);
  const chunks: SocratesSnapshotChunk[] = [];
  let nextStart = 0;
  let totalBytes: number | undefined;
  let sourceLastModified: string | undefined;
  let sourceUrl = '';

  for (let chunkIndex = 0; chunkIndex < SOCRATES_SNAPSHOT_MAX_CHUNKS; chunkIndex += 1) {
    const end = nextStart + SOCRATES_SNAPSHOT_CHUNK_BYTES - 1;
    const { response, arrayBuffer, url } = await fetchCelestrakBytes(socratesCsvPath(order), SOCRATES_SNAPSHOT_CHUNK_TIMEOUT_MS, {
      range: `bytes=${nextStart}-${end}`,
    });
    if (!response.ok) throw new Error(`${url} ${response.status}`);

    const range = parseContentRange(response.headers.get('content-range'));
    const start = range?.start ?? nextStart;
    const chunkEnd = range?.end ?? nextStart + arrayBuffer.byteLength - 1;
    if (range && start !== nextStart) {
      throw new Error(`SOCRATES range mismatch: expected ${nextStart}, received ${start}`);
    }

    sourceUrl = url;
    totalBytes = range?.total ?? arrayBuffer.byteLength;
    sourceLastModified = normalizeHttpDate(response.headers.get('last-modified')) ?? sourceLastModified;

    const key = `${prefix}/part-${String(chunkIndex).padStart(4, '0')}.csv`;
    await bucket.put(key, arrayBuffer, {
      httpMetadata: { contentType: 'text/csv; charset=utf-8' },
      customMetadata: {
        order,
        snapshotId,
        start: String(start),
        end: String(chunkEnd),
      },
    });
    chunks.push({ key, start, end: chunkEnd, size: arrayBuffer.byteLength });

    if (response.status !== 206 || chunkEnd + 1 >= totalBytes) break;
    nextStart = chunkEnd + 1;
  }

  if (!chunks.length) throw new Error('SOCRATES snapshot produced no chunks');
  const completedAt = new Date().toISOString();
  const manifest: SocratesSnapshotManifest = {
    version: 1,
    order,
    source: 'celestrak-socrates-csv',
    sourceUrl,
    sourceLastModified,
    snapshotId,
    completedAt,
    totalBytes,
    chunkSizeBytes: SOCRATES_SNAPSHOT_CHUNK_BYTES,
    chunks,
    previous: previousManifest ? socratesSnapshotRef(previousManifest) : undefined,
  };

  await bucket.put(socratesSnapshotManifestKey(order), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: {
      order,
      snapshotId,
      completedAt,
    },
  });

  if (previousManifest?.previous) {
    await deleteSocratesSnapshot(bucket, previousManifest.previous).catch((error) => {
      console.warn('SOCRATES old snapshot cleanup failed', error);
    });
  }

  return true;
}

function socratesSnapshotManifestKey(order: string) {
  return `socrates/${order}/latest.json`;
}

function socratesSnapshotPrefix(order: string, snapshotId: string) {
  return `socrates/${order}/snapshots/${snapshotId}`;
}

function socratesSnapshotRef(manifest: SocratesSnapshotManifest): SocratesSnapshotRef {
  return {
    snapshotId: manifest.snapshotId,
    completedAt: manifest.completedAt,
    chunks: manifest.chunks,
  };
}

async function deleteSocratesSnapshot(bucket: R2BucketLike, snapshot: SocratesSnapshotRef) {
  const keys = snapshot.chunks.map((chunk) => chunk.key);
  if (keys.length) await bucket.delete(keys);
}

function parseSocratesSnapshotManifest(text: string): SocratesSnapshotManifest | null {
  try {
    const value = JSON.parse(text) as Partial<SocratesSnapshotManifest>;
    if (value.version !== 1 || !value.order || !value.snapshotId || !value.completedAt || !Array.isArray(value.chunks)) {
      return null;
    }
    const chunks = value.chunks.filter(isSocratesSnapshotChunk).sort((left, right) => left.start - right.start);
    if (!chunks.length) return null;
    return {
      version: 1,
      order: value.order,
      source: 'celestrak-socrates-csv',
      sourceUrl: value.sourceUrl ?? '',
      sourceLastModified: value.sourceLastModified,
      snapshotId: value.snapshotId,
      completedAt: value.completedAt,
      totalBytes: value.totalBytes,
      chunkSizeBytes: value.chunkSizeBytes ?? SOCRATES_SNAPSHOT_CHUNK_BYTES,
      chunks,
      previous: isSocratesSnapshotRef(value.previous) ? value.previous : undefined,
    };
  } catch {
    return null;
  }
}

function isSocratesSnapshotRef(value: unknown): value is SocratesSnapshotRef {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SocratesSnapshotRef>;
  return Boolean(record.snapshotId && record.completedAt && Array.isArray(record.chunks) && record.chunks.every(isSocratesSnapshotChunk));
}

function isSocratesSnapshotChunk(value: unknown): value is SocratesSnapshotChunk {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SocratesSnapshotChunk>;
  return (
    typeof record.key === 'string' &&
    Number.isFinite(record.start) &&
    Number.isFinite(record.end) &&
    Number.isFinite(record.size)
  );
}

async function getSocratesSearchResults(order: string, limit: number, catalogNumbers: number[]) {
  const max = catalogNumbers.length
    ? Math.min(limit, MAX_SOCRATES_CATALOG_SEARCH_RESULTS)
    : Math.min(limit, MAX_SOCRATES_SEARCH_RESULTS);
  if (!catalogNumbers.length) {
    const { text } = await fetchCelestrakText(socratesSearchPath(order, max));
    return parseSocratesHtml(text, {
      fetchedAt: socratesFetchedAtFromHtml(text) ?? new Date().toISOString(),
      limit,
      order,
    });
  }

  const settled = await Promise.allSettled(
    catalogNumbers.map(async (catalogNumber) => {
      const { text } = await fetchCelestrakText(socratesSearchPath(order, max, catalogNumber));
      return parseSocratesHtml(text, {
        fetchedAt: socratesFetchedAtFromHtml(text) ?? new Date().toISOString(),
        limit: max,
        order,
      });
    }),
  );
  const records = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  if (!records.length) {
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => (result.reason instanceof Error ? result.reason.message : 'unknown'))
      .join('; ');
    throw new Error(`SOCRATES search unavailable${failures ? `: ${failures}` : ''}`);
  }

  return sortSocratesRecords(dedupeConjunctionRecords(records), order).slice(0, limit);
}

function socratesSearchPath(order: string, max: number, catalogNumber?: number) {
  const params = new URLSearchParams();
  if (catalogNumber) {
    params.set('CATNR', `${catalogNumber},`);
  } else {
    params.set('NAME', ',');
  }
  params.set('ORDER', socratesQueryOrder(order));
  params.set('MAX', String(max));
  return `/SOCRATES/table-socrates.php?${params.toString()}`;
}

function socratesQueryOrder(order: string) {
  if (order === 'maxProb') return 'MAXPROB';
  if (order === 'tca') return 'TCA';
  if (order === 'relSpeed') return 'RELSPEED';
  if (order === 'ssc') return 'SSC';
  return 'MINRANGE';
}

function socratesFetchedAtFromHtml(html: string) {
  const match = /Data current as of\s+(\d{4})\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+UTC/.exec(html);
  if (!match) return undefined;
  const [, year, month, day, time] = match;
  const monthIndex = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(month);
  if (monthIndex < 0) return undefined;
  const [hour, minute, second] = time.split(':').map(Number);
  const date = new Date(Date.UTC(Number(year), monthIndex, Number(day), hour, minute, second));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function parseSocratesHtml(html: string, options: { fetchedAt: string; limit: number; order: string }): ConjunctionRecord[] {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
  const records: ConjunctionRecord[] = [];

  for (let index = 0; index < rows.length - 1; index += 1) {
    if (!rows[index].includes('openWindowData')) continue;

    const primaryCells = htmlTableCells(rows[index]);
    const secondaryCells = htmlTableCells(rows[index + 1]);
    if (primaryCells.length < 7 || secondaryCells.length < 6) continue;

    const primaryCatalog = numberFromCsv(primaryCells[1]);
    const secondaryCatalog = numberFromCsv(secondaryCells[1]);
    const tca = normalizeSocratesTimestamp(primaryCells[4]);
    const missDistanceKm = numberFromCsv(primaryCells[5]);
    const relVelocityKmS = numberFromCsv(primaryCells[6]);
    if (!tca || missDistanceKm === undefined || relVelocityKmS === undefined) continue;

    records.push({
      id: `socrates-${primaryCatalog ?? 'unknown'}-${secondaryCatalog ?? 'unknown'}-${tca.replace(/\W/g, '')}`,
      origin: 'OSINT',
      tca,
      primary: {
        name: cleanSocratesObjectName(primaryCells[2]) ?? `NORAD ${primaryCatalog ?? 'unknown'}`,
        catalogNumber: primaryCatalog,
      },
      secondary: {
        name: cleanSocratesObjectName(secondaryCells[2]) ?? `NORAD ${secondaryCatalog ?? 'unknown'}`,
        catalogNumber: secondaryCatalog,
      },
      missDistanceKm,
      relVelocityKmS,
      pc: numberFromCsv(secondaryCells[4]),
      source: 'celestrak-socrates',
      fetchedAt: options.fetchedAt,
    });

    if (records.length >= options.limit) break;
  }

  return sortSocratesRecords(dedupeConjunctionRecords(records), options.order).slice(0, options.limit);
}

function htmlTableCells(row: string) {
  return [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => htmlText(match[1]));
}

function htmlText(value: string) {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeConjunctionRecords(records: ConjunctionRecord[]) {
  const byId = new Map<string, ConjunctionRecord>();
  for (const record of records) {
    byId.set(record.id, record);
  }
  return [...byId.values()];
}

function sortSocratesRecords(records: ConjunctionRecord[], order: string) {
  return [...records].sort((left, right) => {
    if (order === 'maxProb') return (right.pc ?? -Infinity) - (left.pc ?? -Infinity) || left.tca.localeCompare(right.tca);
    if (order === 'tca') return left.tca.localeCompare(right.tca);
    if (order === 'relSpeed') return right.relVelocityKmS - left.relVelocityKmS || left.tca.localeCompare(right.tca);
    if (order === 'ssc') {
      return (
        (left.primary.catalogNumber ?? Number.MAX_SAFE_INTEGER) - (right.primary.catalogNumber ?? Number.MAX_SAFE_INTEGER) ||
        (left.secondary.catalogNumber ?? Number.MAX_SAFE_INTEGER) - (right.secondary.catalogNumber ?? Number.MAX_SAFE_INTEGER) ||
        left.tca.localeCompare(right.tca)
      );
    }
    return left.missDistanceKm - right.missDistanceKm || left.tca.localeCompare(right.tca);
  });
}

async function fetchSocratesCsv(order: string, limit: number, hasCatalogFilter: boolean) {
  if (hasCatalogFilter) {
    return fetchSocratesCsvFullScan(order);
  }
  const rangeBytes = Math.max(SOCRATES_RANGE_BYTES, limit * 512);
  return fetchCelestrakText(socratesCsvPath(order), SOCRATES_FETCH_TIMEOUT_MS, {
    range: `bytes=0-${rangeBytes - 1}`,
  });
}

async function fetchSocratesCsvFullScan(order: string) {
  const chunks: string[] = [];
  let nextStart = 0;
  let responseForMetadata: Response | null = null;

  for (let chunkIndex = 0; chunkIndex < 64; chunkIndex += 1) {
    const end = nextStart + SOCRATES_FILTERED_RANGE_BYTES - 1;
    const { response, text } = await fetchCelestrakText(socratesCsvPath(order), SOCRATES_FETCH_TIMEOUT_MS, {
      range: `bytes=${nextStart}-${end}`,
    });
    const lastModified = response.headers.get('last-modified');
    if (lastModified || !responseForMetadata) responseForMetadata = response;
    chunks.push(trimPartialCsv(text, response));
    if (response.status !== 206) break;

    const range = parseContentRange(response.headers.get('content-range'));
    if (!range) break;
    if (range.end + 1 >= range.total) break;
    nextStart = range.end + 1;
  }

  return {
    response: responseForMetadata ?? new Response(),
    text: mergeCsvChunks(chunks),
  };
}

function parseContentRange(value: string | null) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value ?? '');
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3]),
  };
}

function mergeCsvChunks(chunks: string[]) {
  return chunks
    .map((chunk, index) => {
      if (index === 0) return chunk;
      const firstNewline = chunk.indexOf('\n');
      return firstNewline >= 0 ? chunk.slice(firstNewline + 1) : '';
    })
    .join('\n');
}

function trimPartialCsv(text: string, response: Response) {
  if (response.status !== 206) return text;
  const lastNewline = text.lastIndexOf('\n');
  return lastNewline > 0 ? text.slice(0, lastNewline) : text;
}

function socratesCsvPath(order: string) {
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
  return `/SOCRATES/${file}`;
}

function parseSocratesCsv(
  text: string,
  options: { catalogNumbers: Set<number>; fetchedAt: string; limit: number },
): ConjunctionRecord[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const [headerLine, ...rows] = lines;
  const indexes = csvHeaderIndexes(headerLine ?? '');
  const records: ConjunctionRecord[] = [];

  for (const row of rows) {
    const record = createSocratesCsvRecord(parseCsvLine(row), indexes, {
      catalogNumbers: options.catalogNumbers,
      fetchedAt: options.fetchedAt,
    });
    if (!record) continue;

    records.push(record);

    if (records.length >= options.limit) break;
  }

  return records;
}

function csvHeaderIndexes(headerLine: string) {
  return Object.fromEntries(parseCsvLine(headerLine).map((header, index) => [header.replace(/^\uFEFF/, ''), index]));
}

function createSocratesCsvRecord(
  cells: string[],
  indexes: Record<string, number>,
  options: { catalogNumbers: Set<number>; fetchedAt: string; stale?: boolean; note?: string },
): ConjunctionRecord | null {
  const catalogNumber1 = numberFromCsv(cells[indexes.NORAD_CAT_ID_1]);
  const catalogNumber2 = numberFromCsv(cells[indexes.NORAD_CAT_ID_2]);
  if (
    options.catalogNumbers.size &&
    (!catalogNumber1 || !options.catalogNumbers.has(catalogNumber1)) &&
    (!catalogNumber2 || !options.catalogNumbers.has(catalogNumber2))
  ) {
    return null;
  }

  const tca = normalizeSocratesTimestamp(cells[indexes.TCA]);
  const missDistanceKm = numberFromCsv(cells[indexes.TCA_RANGE]);
  const relVelocityKmS = numberFromCsv(cells[indexes.TCA_RELATIVE_SPEED]);
  if (!tca || missDistanceKm === undefined || relVelocityKmS === undefined) return null;

  return {
    id: `socrates-${catalogNumber1 ?? 'unknown'}-${catalogNumber2 ?? 'unknown'}-${tca.replace(/\W/g, '')}`,
    origin: options.stale ? 'STALE' : 'OSINT',
    stale: options.stale || undefined,
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
    note: options.note,
  };
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
  const { response, text } = await fetchTextWithTimeout(url, timeoutMs);
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return parseJsonResponse<T>(url, text);
}

async function fetchCelestrakText(path: string, timeoutMs = 12_000, headers: Record<string, string> = {}) {
  const errors: string[] = [];
  for (const origin of CELESTRAK_ORIGINS) {
    const url = `${origin}${path}`;
    try {
      const result = await fetchTextWithTimeout(url, timeoutMs, { ...CELESTRAK_REQUEST_HEADERS, ...headers });
      if (result.response.ok) {
        return { ...result, url };
      }
      errors.push(`${url} ${result.response.status}`);
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  throw new Error(errors.join('; '));
}

async function fetchCelestrakBytes(path: string, timeoutMs = 12_000, headers: Record<string, string> = {}) {
  const errors: string[] = [];
  for (const origin of CELESTRAK_ORIGINS) {
    const url = `${origin}${path}`;
    try {
      const result = await fetchArrayBufferWithTimeout(url, timeoutMs, { ...CELESTRAK_REQUEST_HEADERS, ...headers });
      if (result.response.ok) {
        return { ...result, url };
      }
      errors.push(`${url} ${result.response.status}`);
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  throw new Error(errors.join('; '));
}

function parseJsonResponse<T>(url: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const detail = text.trim().slice(0, 120) || 'empty response';
    throw new Error(`${url} invalid JSON: ${detail}`, { cause: error });
  }
}

async function fetchTextWithTimeout(url: string, timeoutMs: number, headers?: HeadersInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${url} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchArrayBufferWithTimeout(url: string, timeoutMs: number, headers?: HeadersInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const arrayBuffer = await response.arrayBuffer();
    return { response, arrayBuffer };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${url} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function json(data: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
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

function normalizeHttpDate(value: string | null) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
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
