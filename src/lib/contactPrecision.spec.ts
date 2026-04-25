import { describe, expect, it } from 'vitest';
import type { GroundStation } from '@/domain/types';
import { predictPasses } from './passPrediction';
import { refineContactCountdowns } from './contactPrecision';

const station: GroundStation = {
  id: 'gs-seoul',
  name: 'Seoul Ops',
  latDeg: 37.5665,
  lonDeg: 126.978,
  altitudeM: 38,
  elevationMaskDeg: 10,
  enabled: true,
  schemaVersion: 1,
};

const satellite = {
  satelliteRef: { refType: 'catalog' as const, catalogNumber: 25544, displayName: 'ISS', tags: [] },
  name: 'ISS',
  tle: {
    format: 'TLE' as const,
    line1: '1 25544U 98067A   24110.55260417  .00016717  00000+0  10270-3 0  9996',
    line2: '2 25544  51.6415 162.1898 0004620 250.2941 232.6818 15.50376377446559',
  },
};

describe('refineContactCountdowns', () => {
  it('refines a focused LOS countdown from the current contact state', () => {
    const pass = firstPass();
    const results = refineContactCountdowns({
      timestampIso: pass.tca,
      candidates: [
        {
          satelliteId: 'catalog:25544',
          groundStationId: station.id,
          status: 'IN_CONTACT',
          tle: satellite.tle,
          station,
        },
      ],
    });

    expect(results[0]?.eventIso).toBeTruthy();
    expect(results[0]?.countdownSeconds).toBeGreaterThan(0);
    expect(new Date(results[0]!.eventIso!).getTime()).toBeGreaterThan(new Date(pass.tca).getTime());
  });

  it('refines a focused AOS countdown before contact', () => {
    const pass = firstPass();
    const timestampIso = new Date(new Date(pass.aos).getTime() - 10 * 60 * 1000).toISOString();
    const results = refineContactCountdowns({
      timestampIso,
      candidates: [
        {
          satelliteId: 'catalog:25544',
          groundStationId: station.id,
          status: 'BEFORE_AOS',
          tle: satellite.tle,
          station,
        },
      ],
    });

    expect(results[0]?.eventIso).toBeTruthy();
    expect(results[0]?.countdownSeconds).toBeGreaterThan(0);
    expect(Math.abs(new Date(results[0]!.eventIso!).getTime() - new Date(pass.aos).getTime())).toBeLessThan(3 * 60 * 1000);
  });
});

function firstPass() {
  const passes = predictPasses({
    startTimeIso: '2026-04-23T00:00:00.000Z',
    hours: 24,
    stations: [station],
    satellites: [satellite],
  });
  const pass = passes[0];
  if (!pass) throw new Error('Expected a pass for contact precision test');
  return pass;
}
