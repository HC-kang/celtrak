import type {
  CatalogEntry,
  ConjunctionRecord,
  DashboardAlert,
  DecayPrediction,
  GroundStation,
  SpaceWeatherSnapshot,
} from '@/domain/types';
import { mockAlerts, mockCatalog, mockConjunctions, mockDecay, mockGroundStations, mockWeather } from '@/services/mockData';

export interface CatalogQuery {
  group?: string;
  limit?: number;
  catalogNumbers?: number[];
}

export interface ConjunctionQuery {
  catalogNumbers?: number[];
  limit?: number;
  order?: 'MINRANGE' | 'MAXPROB' | 'TCA' | 'RELSPEED' | 'SSC';
}

export interface OrbitLabGateway {
  getCatalog(query?: CatalogQuery): Promise<CatalogEntry[]>;
  getCatalogStrict(query?: CatalogQuery, options?: { timeoutMs?: number }): Promise<CatalogEntry[]>;
  getWeather(): Promise<SpaceWeatherSnapshot>;
  getConjunctions(query?: ConjunctionQuery): Promise<ConjunctionRecord[]>;
  getDecayPredictions(): Promise<DecayPrediction[]>;
  getGroundStations(): Promise<GroundStation[]>;
  getAlerts(): Promise<DashboardAlert[]>;
}

async function fetchJson<T>(input: string, options: { timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await fetch(input, { signal: controller.signal });
    if (!response.ok) throw new Error(`${input} returned ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`${input} timed out`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function safeFetchJson<T>(input: string): Promise<T | null> {
  try {
    return await fetchJson<T>(input);
  } catch {
    return null;
  }
}

export function createGateway(): OrbitLabGateway {
  return {
    async getCatalog(query) {
      const endpoint = createCatalogEndpoint(query);
      const remote = await safeFetchJson<CatalogEntry[]>(endpoint);
      const data = remote ?? mockCatalog;
      if (query?.catalogNumbers?.length) {
        const catalogNumbers = new Set(query.catalogNumbers);
        return data.filter((entry) => catalogNumbers.has(entry.satcat.catalogNumber));
      }
      return query?.group ? data.filter((entry) => entry.group.toLowerCase() === query.group?.toLowerCase()) : data;
    },
    async getCatalogStrict(query, options) {
      const endpoint = createCatalogEndpoint(query);
      const data = await fetchJson<CatalogEntry[]>(endpoint, options);
      if (query?.catalogNumbers?.length) {
        const catalogNumbers = new Set(query.catalogNumbers);
        return data.filter((entry) => catalogNumbers.has(entry.satcat.catalogNumber));
      }
      return query?.group ? data.filter((entry) => entry.group.toLowerCase() === query.group?.toLowerCase()) : data;
    },
    async getWeather() {
      return (await safeFetchJson<SpaceWeatherSnapshot>('/api/swpc/summary')) ?? mockWeather;
    },
    async getConjunctions(query) {
      return (await safeFetchJson<ConjunctionRecord[]>(createConjunctionEndpoint(query))) ?? mockConjunctions;
    },
    async getDecayPredictions() {
      return (await safeFetchJson<DecayPrediction[]>('/api/celestrak/decay')) ?? mockDecay;
    },
    async getGroundStations() {
      return (await safeFetchJson<GroundStation[]>('/api/ground-stations')) ?? mockGroundStations;
    },
    async getAlerts() {
      return mockAlerts;
    },
  };
}

function createConjunctionEndpoint(query?: ConjunctionQuery) {
  const params = new URLSearchParams();
  params.set('order', query?.order ?? 'MINRANGE');
  params.set('limit', String(query?.limit ?? 500));
  const catalogNumbers = uniqueCatalogNumbers(query?.catalogNumbers ?? []);
  if (catalogNumbers.length) {
    params.set('catnr', catalogNumbers.join(','));
  }
  return `/api/celestrak/socrates?${params.toString()}`;
}

function createCatalogEndpoint(query?: CatalogQuery) {
  const params = new URLSearchParams();
  const catalogNumbers = uniqueCatalogNumbers(query?.catalogNumbers ?? []);
  if (catalogNumbers.length) {
    params.set('catnr', catalogNumbers.join(','));
  } else {
    params.set('group', query?.group ?? 'active');
    params.set('limit', String(query?.limit ?? 20_000));
  }
  return `/api/celestrak/catalog?${params.toString()}`;
}

function uniqueCatalogNumbers(values: number[]) {
  return [...new Set(values.filter((value) => Number.isFinite(value)))].sort((left, right) => left - right);
}
