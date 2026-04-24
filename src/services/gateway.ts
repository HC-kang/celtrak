import type {
  CatalogEntry,
  ConjunctionRecord,
  DashboardAlert,
  DecayPrediction,
  GroundStation,
  SpaceWeatherSnapshot,
} from '@/domain/types';
import { mockAlerts, mockCatalog, mockConjunctions, mockDecay, mockGroundStations, mockWeather } from '@/services/mockData';

export interface OrbitLabGateway {
  getCatalog(group?: string): Promise<CatalogEntry[]>;
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
    async getCatalog(group) {
      const endpoint = group ? `/api/celestrak/catalog?group=${encodeURIComponent(group)}&limit=20000` : '/api/celestrak/catalog?limit=20000';
      const remote = await safeFetchJson<CatalogEntry[]>(endpoint);
      const data = remote ?? mockCatalog;
      return group ? data.filter((entry) => entry.group.toLowerCase() === group.toLowerCase()) : data;
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
