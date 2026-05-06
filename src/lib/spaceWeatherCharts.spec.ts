import { describe, expect, it } from 'vitest';
import type { SpaceWeatherSnapshot } from '@/domain/types';
import {
  buildMetricSummaries,
  buildWeatherChartModel,
  classifyGeomagneticScale,
  classifyRadiationStormScale,
  classifyRadioBlackoutScale,
  findNearestReadout,
} from './spaceWeatherCharts';

const baseWeather: SpaceWeatherSnapshot = {
  origin: 'OSINT',
  fetchedAt: '2026-05-05T16:09:00.000Z',
  xray: {
    currentWm2: 9.5e-7,
    series: [
      { t: '2026-05-05T15:59:00Z', flux: 8e-7 },
      { t: '2026-05-05T16:00:00Z', flux: 9.5e-7 },
    ],
  },
  kp: {
    current: 6,
    storm: 'MODERATE',
    series: [
      { t: '2026-05-05T12:00:00Z', kp: 2.33, observed: 'observed', noaaScale: null },
      { t: '2026-05-05T15:00:00Z', kp: 6, observed: 'estimated', noaaScale: 'G2' },
    ],
    forecast: [],
  },
  proton: {
    currentPfu: 0.213,
    energy: '>=10 MeV',
    observedAt: '2026-05-05T16:00:00Z',
    series: [
      { t: '2026-05-05T15:55:00Z', flux: 0.175 },
      { t: '2026-05-05T16:00:00Z', flux: 0.213 },
    ],
  },
  scales: {
    observedAt: '2026-05-05T16:09:00.000Z',
    current: {
      r: { scale: 0, label: 'R0', text: 'none', observedAt: '2026-05-05T16:09:00.000Z', source: 'NOAA_SWPC' },
      s: { scale: 0, label: 'S0', text: 'none', observedAt: '2026-05-05T16:09:00.000Z', source: 'NOAA_SWPC' },
      g: { scale: 0, label: 'G0', text: 'none', observedAt: '2026-05-05T16:09:00.000Z', source: 'NOAA_SWPC' },
    },
    previous: {
      t: '2026-05-04T16:09:00.000Z',
      g: { scale: 2, label: 'G2', text: 'moderate', observedAt: '2026-05-04T16:09:00.000Z', source: 'NOAA_SWPC' },
    },
  },
};

describe('space weather chart transforms', () => {
  it('classifies NOAA scale thresholds at documented boundaries', () => {
    expect(classifyGeomagneticScale(4.99)).toBe(0);
    expect(classifyGeomagneticScale(5)).toBe(1);
    expect(classifyGeomagneticScale(6)).toBe(2);
    expect(classifyGeomagneticScale(9)).toBe(5);

    expect(classifyRadiationStormScale(9.99)).toBe(0);
    expect(classifyRadiationStormScale(10)).toBe(1);
    expect(classifyRadiationStormScale(100)).toBe(2);
    expect(classifyRadiationStormScale(100_000)).toBe(5);

    expect(classifyRadioBlackoutScale(9.99e-6)).toBe(0);
    expect(classifyRadioBlackoutScale(1e-5)).toBe(1);
    expect(classifyRadioBlackoutScale(5e-5)).toBe(2);
    expect(classifyRadioBlackoutScale(2e-3)).toBe(5);
  });

  it('keeps NOAA direct current G/S/R values ahead of derived values', () => {
    const summaries = buildMetricSummaries(baseWeather, new Date('2026-05-05T16:09:00Z').getTime());
    expect(summaries.find((item) => item.key === 'g')?.value).toBe('G0');
    expect(summaries.find((item) => item.key === 's')?.value).toBe('S0');
    expect(summaries.find((item) => item.key === 'r')?.value).toBe('R0');
    expect(summaries.find((item) => item.key === 'g')?.sourceLabel).toBe('NOAA SWPC');
  });

  it('builds radiation model with S-scale proton thresholds', () => {
    const model = buildWeatherChartModel(baseWeather, 'radiation', new Date('2026-05-05T16:00:00Z').getTime());
    expect(model.axes[0].type).toBe('log');
    expect(model.thresholds.map((item) => item.label)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
    expect(model.thresholds[0].value).toBe(10);
  });

  it('returns the nearest selected-time readout across visible series', () => {
    const model = buildWeatherChartModel(baseWeather, 'geomagnetic', new Date('2026-05-05T16:00:00Z').getTime());
    const readout = findNearestReadout(model, new Date('2026-05-05T14:50:00Z').getTime());
    expect(readout?.t).toBe('2026-05-05T15:00:00.000Z');
    expect(readout?.rows.map((row) => row.name)).toEqual(['Kp index', 'G scale']);
  });

  it('keeps the current readout anchored to observed data before forecast points', () => {
    const weather: SpaceWeatherSnapshot = {
      ...baseWeather,
      kp: {
        ...baseWeather.kp,
        series: [
          ...baseWeather.kp.series,
          { t: '2026-05-05T18:00:00Z', kp: 8, observed: 'predicted', noaaScale: null },
        ],
      },
    };
    const model = buildWeatherChartModel(weather, 'geomagnetic', new Date('2026-05-05T16:50:00Z').getTime());
    expect(model.currentReadout?.t).toBe('2026-05-05T15:00:00.000Z');
    expect(model.currentReadout?.rows[0]?.value).toBe('Kp 6');
  });
});
