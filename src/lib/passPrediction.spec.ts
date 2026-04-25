import { describe, expect, it } from 'vitest';
import { predictPasses, predictPriorityPasses } from '@/lib/passPrediction';

describe('predictPasses', () => {
  it('uses the provided simulation start time', () => {
    const startTimeIso = '2026-04-23T00:00:00.000Z';
    const passes = predictPasses({
      startTimeIso,
      hours: 24,
      stations: [
        {
          id: 'gs-seoul',
          name: 'Seoul Ops',
          latDeg: 37.5665,
          lonDeg: 126.978,
          altitudeM: 38,
          elevationMaskDeg: 10,
          enabled: true,
          schemaVersion: 1,
        },
      ],
      satellites: [
        {
          satelliteRef: { refType: 'catalog', catalogNumber: 25544, tags: [] },
          name: 'ISS',
          tle: {
            format: 'TLE',
            line1: '1 25544U 98067A   24110.55260417  .00016717  00000+0  10270-3 0  9996',
            line2: '2 25544  51.6415 162.1898 0004620 250.2941 232.6818 15.50376377446559',
          },
        },
      ],
    });

    expect(passes.length).toBeGreaterThan(0);
    expect(new Date(passes[0].aos).getTime()).toBeGreaterThanOrEqual(new Date(startTimeIso).getTime());
  });

  it('keeps pass windows across all enabled station pairs', () => {
    const stations = Array.from({ length: 8 }, (_, index) => ({
      id: `gs-${index + 1}`,
      name: `Station ${index + 1}`,
      latDeg: 37.5665,
      lonDeg: 126.978,
      altitudeM: 38,
      elevationMaskDeg: 10,
      enabled: true,
      schemaVersion: 1 as const,
    }));

    const passes = predictPasses({
      startTimeIso: '2026-04-23T00:00:00.000Z',
      hours: 24,
      stations,
      satellites: [
        {
          satelliteRef: { refType: 'catalog', catalogNumber: 25544, tags: [] },
          name: 'ISS',
          tle: {
            format: 'TLE',
            line1: '1 25544U 98067A   24110.55260417  .00016717  00000+0  10270-3 0  9996',
            line2: '2 25544  51.6415 162.1898 0004620 250.2941 232.6818 15.50376377446559',
          },
        },
      ],
    });

    expect(new Set(passes.map((pass) => pass.groundStationId)).size).toBe(stations.length);
  });

  it('can compute a focused ground station subset first', () => {
    const passes = predictPriorityPasses({
      startTimeIso: '2026-04-23T00:00:00.000Z',
      hours: 24,
      priorityTarget: { type: 'groundStation', id: 'gs-seoul' },
      stations: [
        {
          id: 'gs-seoul',
          name: 'Seoul Ops',
          latDeg: 37.5665,
          lonDeg: 126.978,
          altitudeM: 38,
          elevationMaskDeg: 10,
          enabled: true,
          schemaVersion: 1,
        },
        {
          id: 'gs-houston',
          name: 'Houston Backup',
          latDeg: 29.7604,
          lonDeg: -95.3698,
          altitudeM: 13,
          elevationMaskDeg: 10,
          enabled: true,
          schemaVersion: 1,
        },
      ],
      satellites: [
        {
          satelliteRef: { refType: 'catalog', catalogNumber: 25544, tags: [] },
          name: 'ISS',
          tle: {
            format: 'TLE',
            line1: '1 25544U 98067A   24110.55260417  .00016717  00000+0  10270-3 0  9996',
            line2: '2 25544  51.6415 162.1898 0004620 250.2941 232.6818 15.50376377446559',
          },
        },
      ],
    });

    expect(passes.length).toBeGreaterThan(0);
    expect(new Set(passes.map((pass) => pass.groundStationId))).toEqual(new Set(['gs-seoul']));
  });

  it('keeps an open pass when visibility lasts through the prediction horizon', () => {
    const passes = predictPasses({
      startTimeIso: '2026-04-23T00:00:00.000Z',
      hours: 2,
      stations: [
        {
          id: 'gs-all-sky',
          name: 'All Sky',
          latDeg: 0,
          lonDeg: 0,
          altitudeM: 0,
          elevationMaskDeg: -90,
          enabled: true,
          schemaVersion: 1,
        },
      ],
      satellites: [
        {
          satelliteRef: { refType: 'catalog', catalogNumber: 25544, tags: [] },
          name: 'ISS',
          tle: {
            format: 'TLE',
            line1: '1 25544U 98067A   24110.55260417  .00016717  00000+0  10270-3 0  9996',
            line2: '2 25544  51.6415 162.1898 0004620 250.2941 232.6818 15.50376377446559',
          },
        },
      ],
    });

    expect(passes[0]?.losIsPredictionHorizon).toBe(true);
  });
});
