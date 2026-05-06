import { describe, expect, it } from 'vitest';
import { normalizeKasaKindex, normalizeKasaProb, normalizeKasaSupplement, normalizeKasaWarn } from './spaceWeatherKasa';

describe('KASA space weather normalizers', () => {
  it('normalizes warning levels with epoch update time', () => {
    const warn = normalizeKasaWarn({
      Warn: {
        R: { v0: 'R0', v1: 'R0', v2: 'R1' },
        S: { v0: 'S0', v1: 'S0', v2: 'S0' },
        G: { v0: 'G0', v1: 'G0', v2: 'G2' },
      },
      LastUpdate: '1778028240000',
      Error: false,
      ErrorCode: 'NOERR',
    });

    expect(warn?.lastUpdate).toBe('2026-05-06T00:44:00.000Z');
    expect(warn?.r.previous48).toBe('R1');
    expect(warn?.g.previous48).toBe('G2');
  });

  it('normalizes probability windows for R/S/G forecast buckets', () => {
    const prob = normalizeKasaProb({
      Error: false,
      ErrorCode: 'NOERR',
      prob: {
        date: '2026-05-05 10:52:14',
        R1D1: '30',
        R1D2: '30',
        R1D3: '30',
        R3D1: '1',
        R3D2: '1',
        R3D3: '1',
        S1D1: '1',
        S1D2: '1',
        S1D3: '1',
        S3D1: '1',
        S3D2: '1',
        S3D3: '1',
        G1MD1: '30',
        G1MD2: '10',
        G1MD3: '30',
        G2MD1: '1',
        G2MD2: '1',
        G2MD3: '1',
      },
    });

    expect(prob?.issuedAt).toBe('2026-05-05T01:52:14.000Z');
    expect(prob?.g.map((item) => item.minorPct)).toEqual([30, 10, 30]);
    expect(prob?.r[0]).toMatchObject({ startHour: 0, endHour: 24, minorPct: 30, majorPct: 1 });
  });

  it('normalizes KASA Kp/Kk recent series without overwriting SWPC Kp', () => {
    const kindex = normalizeKasaKindex({
      Error: false,
      ErrorCode: 'NOERR',
      Kindex: {
        Time: '2026-05-06 00:00:00',
        CurrentP: 1.0,
        CurrentK: 0.0,
        Max24P: 5.0,
        Max24K: 3.0,
        Recent: [
          { Time: '2026-05-06 00:00:00', Kp: 1.0, Kk: 0.0 },
          { Time: '2026-05-05 21:00:00', Kp: 1.67, Kk: 2.0 },
        ],
      },
    });

    expect(kindex?.observedAt).toBe('2026-05-06T00:00:00.000Z');
    expect(kindex?.currentKp).toBe(1);
    expect(kindex?.currentKk).toBe(0);
    expect(kindex?.series.map((item) => item.t)).toEqual(['2026-05-05T21:00:00.000Z', '2026-05-06T00:00:00.000Z']);
  });

  it('marks only the KASA supplement stale when KASA sources are missing', () => {
    const supplement = normalizeKasaSupplement({ fetchedAt: '2026-05-06T00:45:00.000Z' });
    expect(supplement.stale).toBe(true);
    expect(supplement.warn).toBeUndefined();
    expect(supplement.prob).toBeUndefined();
    expect(supplement.kindex).toBeUndefined();
  });
});
