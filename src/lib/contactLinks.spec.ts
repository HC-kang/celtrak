import { describe, expect, it } from 'vitest';
import type { GroundStation } from '@/domain/types';
import { predictPasses } from './passPrediction';
import { buildLiveContactLinks } from './contactLinks';

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

describe('buildLiveContactLinks', () => {
  it('marks a satellite in contact when elevation is above the station mask', () => {
    const passes = predictPasses({
      startTimeIso: '2026-04-23T00:00:00.000Z',
      hours: 24,
      stations: [station],
      satellites: [satellite],
    });
    const pass = passes[0];
    if (!pass) throw new Error('Expected a pass for contact test');
    const inPassTimestampIso = new Date((new Date(pass.aos).getTime() + new Date(pass.los).getTime()) / 2).toISOString();

    const links = buildLiveContactLinks({
      satellites: [satellite],
      stations: [station],
      timestampIso: inPassTimestampIso,
      passPredictions: passes,
    });

    expect(links[0]?.status).toBe('IN_CONTACT');
    expect(links[0]?.elevationDeg).toBeGreaterThanOrEqual(station.elevationMaskDeg);
    expect(links[0]?.countdownSeconds).toBeGreaterThanOrEqual(0);
  });

  it('uses the next pass as an AOS countdown before contact', () => {
    const passes = predictPasses({
      startTimeIso: '2026-04-23T00:00:00.000Z',
      hours: 24,
      stations: [station],
      satellites: [satellite],
    });
    const pass = passes[0];
    if (!pass) throw new Error('Expected a pass for contact test');

    const timestampIso = new Date(new Date(pass.aos).getTime() - 10 * 60 * 1000).toISOString();
    const links = buildLiveContactLinks({
      satellites: [satellite],
      stations: [station],
      timestampIso,
      passPredictions: passes,
    });

    expect(links[0]?.status).toBe('BEFORE_AOS');
    expect(links[0]?.countdownSeconds).toBe(600);
  });

  it('estimates the focused LOS countdown while pass predictions are still pending', () => {
    const passes = predictPasses({
      startTimeIso: '2026-04-23T00:00:00.000Z',
      hours: 24,
      stations: [station],
      satellites: [satellite],
    });
    const pass = passes[0];
    if (!pass) throw new Error('Expected a pass for contact test');

    const links = buildLiveContactLinks({
      satellites: [satellite],
      stations: [station],
      timestampIso: pass.tca,
      passPredictions: [],
      priorityTarget: { type: 'groundStation', id: station.id },
    });

    expect(links[0]?.status).toBe('IN_CONTACT');
    expect(links[0]?.countdownSeconds).toBeGreaterThan(0);
  });
});
