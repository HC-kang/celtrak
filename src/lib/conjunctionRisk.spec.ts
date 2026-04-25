import { describe, expect, it } from 'vitest';
import { classifyConjunctionSeverity } from './conjunctionRisk';

describe('classifyConjunctionSeverity', () => {
  it('marks sub-kilometer CDM as critical', () => {
    expect(classifyConjunctionSeverity({ missDistanceKm: 0.35 })).toBe('critical');
  });

  it('separates warning and informational CDM distances', () => {
    expect(classifyConjunctionSeverity({ missDistanceKm: 1 })).toBe('warn');
    expect(classifyConjunctionSeverity({ missDistanceKm: 5 })).toBe('info');
  });
});
