import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import type { CatalogEntry, GroundStation, UserFleet } from '@/domain/types';
import { createPassPredictionInput } from './usePassPredictions';

describe('createPassPredictionInput', () => {
  it('normalizes reactive store data into a worker-cloneable payload', () => {
    const fleet = reactive<UserFleet>({
      id: 'fleet-1',
      name: 'Ops Fleet',
      memberRefs: [{ refType: 'catalog', catalogNumber: 25544, displayName: 'ISS', tags: ['crew'] }],
      createdAt: '2026-04-24T00:00:00.000Z',
      updatedAt: '2026-04-24T00:00:00.000Z',
      schemaVersion: 1,
    }) as UserFleet;
    const catalog = reactive<CatalogEntry[]>([
      {
        origin: 'OSINT',
        group: 'stations',
        satcat: {
          catalogNumber: 25544,
          objectId: '1998-067A',
          objectName: 'ISS (ZARYA)',
          objectType: 'PAYLOAD',
          opsStatusCode: '+',
          ownerCountry: 'ISS',
          fetchedAt: '2026-04-24T00:00:00.000Z',
        },
        tle: {
          format: 'TLE',
          line1: '1 25544U 98067A   24115.51860185  .00016717  00000+0  30049-3 0  9993',
          line2: '2 25544  51.6395 190.2563 0004563  92.9456  42.6181 15.50077730451234',
        },
      },
    ]) as CatalogEntry[];
    const stations = reactive<GroundStation[]>([
      {
        id: 'seoul',
        name: 'Seoul',
        latDeg: 37.5665,
        lonDeg: 126.978,
        altitudeM: 38,
        elevationMaskDeg: 10,
        enabled: true,
        schemaVersion: 1,
      },
    ]) as GroundStation[];

    const payload = createPassPredictionInput(fleet, catalog, [], stations, '2026-04-24T06:00:00.000Z');

    expect(payload).not.toBeNull();
    if (!payload) throw new Error('Expected pass prediction payload');
    expect(payload.satellites[0].satelliteRef.tags).toEqual(['crew']);
    expect(() => structuredClone(payload)).not.toThrow();
  });
});
