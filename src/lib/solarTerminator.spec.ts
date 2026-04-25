import { describe, expect, it } from 'vitest';
import { createNightMaskPath, getSubsolarPoint } from './solarTerminator';

describe('solarTerminator', () => {
  it('creates a stable night mask for the same timestamp', () => {
    const timestamp = new Date('2026-04-25T12:00:00.000Z');
    expect(createNightMaskPath(timestamp, 1024, 1024)).toBe(createNightMaskPath(timestamp, 1024, 1024));
  });

  it('draws the night mask with smooth terminator curves', () => {
    const path = createNightMaskPath(new Date('2026-04-25T12:00:00.000Z'), 1024, 1024);
    expect(path).toContain(' C ');
  });

  it('moves the subsolar longitude as time advances', () => {
    const start = getSubsolarPoint(new Date('2026-04-25T00:00:00.000Z'));
    const later = getSubsolarPoint(new Date('2026-04-25T06:00:00.000Z'));
    expect(Math.abs(start.lonDeg - later.lonDeg)).toBeGreaterThan(60);
  });

  it('keeps declination within seasonal ranges', () => {
    expect(Math.abs(getSubsolarPoint(new Date('2026-03-20T10:00:00.000Z')).latDeg)).toBeLessThan(2);
    expect(getSubsolarPoint(new Date('2026-06-21T10:00:00.000Z')).latDeg).toBeGreaterThan(22);
    expect(getSubsolarPoint(new Date('2026-12-21T10:00:00.000Z')).latDeg).toBeLessThan(-22);
  });
});
