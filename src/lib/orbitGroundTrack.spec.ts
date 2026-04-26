import { describe, expect, it } from 'vitest';
import * as satellite from 'satellite.js';
import {
  buildGroundTrackEphemeris,
  interpolateGroundTrackPoint,
  nearestWrappedValue,
  projectGroundTrackSample,
  splitGroundTrackSegments,
  type GroundTrackBuildInput,
} from './orbitGroundTrack';

const issTle = {
  id: 'catalog:25544',
  line1: '1 25544U 98067A   24110.55260417  .00016717  00000+0  10270-3 0  9996',
  line2: '2 25544  51.6415 162.1898 0004620 250.2941 232.6818 15.50376377446559',
};

const baseInput: GroundTrackBuildInput = {
  requestId: 1,
  satellites: [issTle],
  cacheStartMs: Date.parse('2026-04-25T00:00:00.000Z') - 45 * 60 * 1000,
  cacheEndMs: Date.parse('2026-04-25T00:00:00.000Z') + 120 * 60 * 1000,
  errorThresholdMapUnits: 0.9,
  seedStepMs: 10 * 60 * 1000,
  minStepMs: 30 * 1000,
  mapWidth: 1024,
  mapHeight: 1024,
  qualityKey: 'test',
};

describe('orbitGroundTrack', () => {
  it('keeps interpolated positions close to direct SGP4 projection', () => {
    const result = buildGroundTrackEphemeris(baseInput);
    const track = result.tracks[0];
    expect(track.samples.length).toBeGreaterThan(40);

    const timestampMs = Date.parse('2026-04-25T00:37:15.000Z');
    const interpolated = interpolateGroundTrackPoint(track, timestampMs, baseInput.mapWidth);
    const direct = projectGroundTrackSample(
      satellite.twoline2satrec(issTle.line1, issTle.line2),
      timestampMs,
      baseInput.mapWidth,
      baseInput.mapHeight,
    );

    expect(interpolated).toBeTruthy();
    expect(direct).toBeTruthy();
    const interpolatedX = nearestWrappedValue(interpolated!.x, direct!.x, baseInput.mapWidth);
    expect(Math.hypot(interpolatedX - direct!.x, interpolated!.y - direct!.y)).toBeLessThan(1.6);
  });

  it('adds more samples when the projected error budget is stricter', () => {
    const coarse = buildGroundTrackEphemeris({ ...baseInput, errorThresholdMapUnits: 4 });
    const fine = buildGroundTrackEphemeris({ ...baseInput, errorThresholdMapUnits: 0.5 });

    expect(fine.tracks[0].samples.length).toBeGreaterThan(coarse.tracks[0].samples.length);
  });

  it('splits track segments at the dateline instead of drawing across the map', () => {
    const segments = splitGroundTrackSegments(
      [
        { x: 990, y: 400 },
        { x: 1018, y: 405 },
        { x: 8, y: 410 },
        { x: 22, y: 415 },
      ],
      1024,
    );

    expect(segments).toHaveLength(2);
    expect(segments[0]).toHaveLength(2);
    expect(segments[1]).toHaveLength(2);
  });
});
