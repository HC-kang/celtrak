import { describe, expect, it } from 'vitest';
import { parseImportedText, parseTleLines } from '@/services/tleParser';

describe('tleParser', () => {
  it('parses 3LE input', () => {
    const parsed = parseImportedText(`ISS (ZARYA)
1 25544U 98067A   24110.55260417  .00016717  00000+0  10270-3 0  9996
2 25544  51.6415 162.1898 0004620 250.2941 232.6818 15.50376377446559`);

    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.parsed?.catalogNumber).toBe(25544);
  });

  it('parses omm json input', () => {
    const parsed = parseImportedText(
      JSON.stringify({
        OBJECT_NAME: 'JSON SAT',
        NORAD_CAT_ID: 43210,
        EPOCH: '2026-04-23T00:00:00Z',
        MEAN_MOTION: 15.5,
        ECCENTRICITY: 0.0002,
        INCLINATION: 53.1,
        RA_OF_ASC_NODE: 123.3,
        ARG_OF_PERICENTER: 45.2,
        MEAN_ANOMALY: 67.8,
        BSTAR: 0,
      }),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.entries[0]?.format).toBe('OMM-JSON');
    expect(parsed.entries[0]?.parsed?.periodMinutes).toBeGreaterThan(90);
  });

  it('builds orbital values from TLE lines', () => {
    const result = parseTleLines(
      'ISS',
      '1 25544U 98067A   24110.55260417  .00016717  00000+0  10270-3 0  9996',
      '2 25544  51.6415 162.1898 0004620 250.2941 232.6818 15.50376377446559',
    );

    expect(result.periodMinutes).toBeGreaterThan(90);
    expect(result.apogeeKm).toBeGreaterThan(400);
    expect(result.perigeeKm).toBeGreaterThan(400);
  });
});
