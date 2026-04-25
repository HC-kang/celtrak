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

export interface OrbitLabGateway {
  getCatalog(query?: CatalogQuery): Promise<CatalogEntry[]>;
  getWeather(): Promise<SpaceWeatherSnapshot>;
  getConjunctions(): Promise<ConjunctionRecord[]>;
  getDecayPredictions(): Promise<DecayPrediction[]>;
  getGroundStations(): Promise<GroundStation[]>;
  getAlerts(): Promise<DashboardAlert[]>;
}

async function safeFetchJson<T>(input: string): Promise<T | null> {
  try {
    const response = await fetch(input);
    if (!response.ok) return null;
    return (await response.json()) as T;
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
    async getWeather() {
      return (await safeFetchJson<SpaceWeatherSnapshot>('/api/swpc/summary')) ?? mockWeather;
    },
    async getConjunctions() {
      return (await safeFetchJson<ConjunctionRecord[]>('/api/celestrak/socrates')) ?? mockConjunctions;
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
