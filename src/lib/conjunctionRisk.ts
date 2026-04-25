import type { ConjunctionRecord } from '@/domain/types';

export type ConjunctionSeverity = 'critical' | 'warn' | 'info';

export function classifyConjunctionSeverity(item: Pick<ConjunctionRecord, 'missDistanceKm'>): ConjunctionSeverity {
  if (item.missDistanceKm < 1) return 'critical';
  if (item.missDistanceKm < 5) return 'warn';
  return 'info';
}

export function conjunctionSeverityRank(value: ConjunctionSeverity) {
  return value === 'critical' ? 0 : value === 'warn' ? 1 : 2;
}
