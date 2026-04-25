import { describe, expect, it } from 'vitest';
import { findVisibleSatellites } from './visibleSatellites';

describe('findVisibleSatellites', () => {
  it('returns satellites above the station elevation mask sorted by elevation', () => {
    const visible = findVisibleSatellites({
      timestampIso: '2026-04-23T00:00:00.000Z',
      station: {
        id: 'gs-all-sky',
        name: 'All Sky',
        latDeg: 0,
        lonDeg: 0,
        altitudeM: 0,
        elevationMaskDeg: -90,
        enabled: true,
        schemaVersion: 1,
      },
      satellites: [
        {
          catalogNumber: 25544,
          name: 'ISS',
          group: 'stations',
          ownerCountry: 'US',
          tle: {
            format: 'TLE',
            line1: '1 25544U 98067A   24110.55260417  .00016717  00000+0  10270-3 0  9996',
            line2: '2 25544  51.6415 162.1898 0004620 250.2941 232.6818 15.50376377446559',
          },
        },
      ],
    });

    expect(visible).toHaveLength(1);
    expect(visible[0].catalogNumber).toBe(25544);
    expect(visible[0].elevationDeg).toBeGreaterThanOrEqual(-90);
  });
});
