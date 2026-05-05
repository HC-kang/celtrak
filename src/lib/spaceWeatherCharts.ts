import type { NoaaScaleSummary, SpaceWeatherSnapshot } from '@/domain/types';

export type WeatherChartMode = 'geomagnetic' | 'radiation' | 'ionosphere';
export type WeatherMetricKey = 'kp' | 'g' | 's' | 'r';
export type WeatherTone = 'default' | 'good' | 'warn' | 'orange' | 'critical';

export interface WeatherMetricSummary {
  key: WeatherMetricKey;
  mode: WeatherChartMode;
  label: string;
  value: string;
  detail: string;
  sourceLabel: string;
  observedAt?: string;
  tone: WeatherTone;
}

export interface WeatherChartPoint {
  t: string;
  value: number;
  label: string;
  detail: string;
  sourceLabel: string;
  observed?: 'observed' | 'estimated' | 'predicted' | 'derived';
}

export interface WeatherChartSeries {
  key: string;
  name: string;
  color: string;
  axisIndex: number;
  unit: string;
  stepped?: boolean;
  points: WeatherChartPoint[];
}

export interface WeatherChartAxis {
  name: string;
  min: number;
  max: number;
  type: 'value' | 'log';
  unit: string;
  formatter: 'kp' | 'scale' | 'pfu' | 'flux';
  position?: 'left' | 'right';
}

export interface WeatherChartThreshold {
  axisIndex: number;
  value: number;
  label: string;
  tone: WeatherTone;
}

export interface WeatherSelectedReadout {
  t: string;
  rows: Array<{
    name: string;
    value: string;
    detail: string;
    sourceLabel: string;
  }>;
}

export interface WeatherChartModel {
  mode: WeatherChartMode;
  title: string;
  subtitle: string;
  emptyText: string;
  axes: WeatherChartAxis[];
  thresholds: WeatherChartThreshold[];
  series: WeatherChartSeries[];
  extent: { start: number; end: number } | null;
  currentReadout: WeatherSelectedReadout | null;
}

const COLORS = {
  kp: '#0070cc',
  g: '#6b7280',
  s: '#f5c84b',
  r: '#c81b3a',
};

export const WEATHER_RANGE_PRESETS = [
  { key: '6h', label: '6h', durationMs: 6 * 60 * 60 * 1000 },
  { key: '24h', label: '24h', durationMs: 24 * 60 * 60 * 1000 },
  { key: '3d', label: '3d', durationMs: 3 * 24 * 60 * 60 * 1000 },
  { key: 'all', label: 'All', durationMs: null },
] as const;

export type WeatherRangePresetKey = (typeof WEATHER_RANGE_PRESETS)[number]['key'];

export function buildMetricSummaries(weather: SpaceWeatherSnapshot | null, nowMs = Date.now()): WeatherMetricSummary[] {
  const kpTimeline = normalizeKpTimeline(weather);
  const kpPoint = latestPoint(kpTimeline, nowMs);
  const currentKp = weather?.kp.current ?? kpPoint?.kp ?? null;
  const gScale = weather?.scales?.current.g ?? derivedScaleSummary('G', classifyGeomagneticScale(currentKp), weather?.fetchedAt);
  const sScale = weather?.scales?.current.s ?? derivedScaleSummary('S', classifyRadiationStormScale(weather?.proton?.currentPfu ?? null), weather?.proton?.observedAt ?? weather?.fetchedAt);
  const rScale = weather?.scales?.current.r ?? derivedScaleSummary('R', classifyRadioBlackoutScale(weather?.xray.currentWm2 ?? null), weather?.fetchedAt);
  const protonValue = weather?.proton?.currentPfu;
  const xrayValue = weather?.xray.currentWm2;

  return [
    {
      key: 'kp',
      mode: 'geomagnetic',
      label: 'Kp Disturbance',
      value: currentKp === null ? '-' : formatKp(currentKp),
      detail: `지자기교란 · ${classifyKpStorm(currentKp)}`,
      sourceLabel: kpPoint?.observed === 'predicted' ? 'SWPC forecast' : 'SWPC observed',
      observedAt: kpPoint?.t ?? weather?.fetchedAt,
      tone: kpTone(currentKp),
    },
    {
      key: 'g',
      mode: 'geomagnetic',
      label: 'G Storm',
      value: gScale.label,
      detail: `지자기폭풍 · ${displayScaleText('G', gScale)}`,
      sourceLabel: sourceLabel(gScale.source),
      observedAt: gScale.observedAt ?? weather?.scales?.observedAt,
      tone: scaleTone(gScale.scale),
    },
    {
      key: 's',
      mode: 'radiation',
      label: 'S Radiation',
      value: sScale.label,
      detail: `태양복사폭풍 · ${protonValue === null || protonValue === undefined ? '-' : `${formatPfu(protonValue)} pfu`}`,
      sourceLabel: sourceLabel(sScale.source),
      observedAt: sScale.observedAt ?? weather?.proton?.observedAt,
      tone: scaleTone(sScale.scale),
    },
    {
      key: 'r',
      mode: 'ionosphere',
      label: 'R / Ionosphere',
      value: rScale.label,
      detail: `전리층교란 · X-ray ${xrayValue ? xrayClassLabel(xrayValue) : '-'}`,
      sourceLabel: sourceLabel(rScale.source),
      observedAt: rScale.observedAt ?? weather?.fetchedAt,
      tone: scaleTone(rScale.scale),
    },
  ];
}

export function buildWeatherChartModel(weather: SpaceWeatherSnapshot | null, mode: WeatherChartMode, nowMs = Date.now()): WeatherChartModel {
  if (mode === 'radiation') return buildRadiationModel(weather, nowMs);
  if (mode === 'ionosphere') return buildIonosphereModel(weather, nowMs);
  return buildGeomagneticModel(weather, nowMs);
}

export function findNearestReadout(model: WeatherChartModel, targetTimeMs: number): WeatherSelectedReadout | null {
  const allPoints = model.series.flatMap((series) => series.points.map((point) => ({ point, series })));
  if (!allPoints.length || !Number.isFinite(targetTimeMs)) return model.currentReadout;
  const nearest = allPoints.reduce((best, item) => {
    const distance = Math.abs(new Date(item.point.t).getTime() - targetTimeMs);
    return distance < best.distance ? { ...item, distance } : best;
  }, { ...allPoints[0], distance: Number.POSITIVE_INFINITY });
  const selectedTimeMs = new Date(nearest.point.t).getTime();
  return readoutForTime(model, selectedTimeMs);
}

export function classifyRadioBlackoutScale(flux: number | null | undefined) {
  if (!flux || flux < 1e-5) return 0;
  if (flux >= 2e-3) return 5;
  if (flux >= 1e-3) return 4;
  if (flux >= 1e-4) return 3;
  if (flux >= 5e-5) return 2;
  return 1;
}

export function classifyRadiationStormScale(protonPfu: number | null | undefined) {
  if (protonPfu === null || protonPfu === undefined || protonPfu < 10) return 0;
  if (protonPfu >= 100_000) return 5;
  if (protonPfu >= 10_000) return 4;
  if (protonPfu >= 1_000) return 3;
  if (protonPfu >= 100) return 2;
  return 1;
}

export function classifyGeomagneticScale(kp: number | null | undefined) {
  if (kp === null || kp === undefined || kp < 5) return 0;
  if (kp >= 9) return 5;
  if (kp >= 8) return 4;
  if (kp >= 7) return 3;
  if (kp >= 6) return 2;
  return 1;
}

export function xrayClassLabel(flux: number) {
  const classes = [
    { label: 'X', base: 1e-4 },
    { label: 'M', base: 1e-5 },
    { label: 'C', base: 1e-6 },
    { label: 'B', base: 1e-7 },
    { label: 'A', base: 1e-8 },
  ] as const;
  const match = classes.find((item) => flux >= item.base) ?? classes.at(-1)!;
  return `${match.label}${Number((flux / match.base).toFixed(1))}`;
}

export function formatChartValue(value: number, formatter: WeatherChartAxis['formatter']) {
  if (formatter === 'kp') return formatKp(value);
  if (formatter === 'scale') return value.toFixed(0);
  if (formatter === 'pfu') return `${formatPfu(value)} pfu`;
  if (value >= 1e-3) return value.toExponential(1);
  return value.toExponential(2);
}

function buildGeomagneticModel(weather: SpaceWeatherSnapshot | null, nowMs: number): WeatherChartModel {
  const kpRows = normalizeKpTimeline(weather);
  const kpPoints = kpRows.map((row) => ({
    t: row.t,
    value: row.kp,
    label: `Kp ${formatKp(row.kp)}`,
    detail: `${classifyKpStorm(row.kp)} · ${statusLabel(row.observed)}`,
    sourceLabel: row.observed === 'predicted' ? 'SWPC forecast' : 'SWPC observed',
    observed: row.observed,
  }));
  const gPoints = kpRows.map((row) => {
    const scale = parseScaleLabel(row.noaaScale, 'G') ?? classifyGeomagneticScale(row.kp);
    return {
      t: row.t,
      value: scale,
      label: `G${scale}`,
      detail: `${scaleText('G', scale)} · from Kp ${formatKp(row.kp)}`,
      sourceLabel: row.noaaScale ? 'NOAA SWPC scale' : 'Kp-derived',
      observed: (row.noaaScale ? row.observed : 'derived') as WeatherChartPoint['observed'],
    };
  });

  const model = createModel({
    mode: 'geomagnetic',
    title: 'Geomagnetic',
    subtitle: 'Kp disturbance and NOAA G-scale trend',
    emptyText: 'Kp/G 시계열 데이터가 없습니다.',
    axes: [
      { name: 'Kp', min: 0, max: 9, type: 'value', unit: 'Kp', formatter: 'kp', position: 'left' },
      { name: 'G', min: 0, max: 5, type: 'value', unit: 'G', formatter: 'scale', position: 'right' },
    ],
    thresholds: [
      { axisIndex: 0, value: 5, label: 'G1', tone: 'warn' },
      { axisIndex: 0, value: 6, label: 'G2', tone: 'warn' },
      { axisIndex: 0, value: 7, label: 'G3', tone: 'warn' },
      { axisIndex: 0, value: 8, label: 'G4', tone: 'orange' },
      { axisIndex: 0, value: 9, label: 'G5', tone: 'critical' },
    ],
    series: [
      { key: 'kp', name: 'Kp index', color: COLORS.kp, axisIndex: 0, unit: 'Kp', points: kpPoints },
      { key: 'g', name: 'G scale', color: COLORS.g, axisIndex: 1, unit: 'G', stepped: true, points: gPoints },
    ],
  }, nowMs);
  return model;
}

function buildRadiationModel(weather: SpaceWeatherSnapshot | null, nowMs: number): WeatherChartModel {
  const rows = normalizeProtonTimeline(weather);
  return createModel({
    mode: 'radiation',
    title: 'Radiation',
    subtitle: 'GOES >=10 MeV proton flux against NOAA S-scale thresholds',
    emptyText: 'GOES proton flux 시계열 데이터가 없습니다.',
    axes: [{ name: 'Proton flux', min: 0.01, max: 100_000, type: 'log', unit: 'pfu', formatter: 'pfu' }],
    thresholds: [
      { axisIndex: 0, value: 10, label: 'S1', tone: 'warn' },
      { axisIndex: 0, value: 100, label: 'S2', tone: 'warn' },
      { axisIndex: 0, value: 1_000, label: 'S3', tone: 'warn' },
      { axisIndex: 0, value: 10_000, label: 'S4', tone: 'orange' },
      { axisIndex: 0, value: 100_000, label: 'S5', tone: 'critical' },
    ],
    series: [
      {
        key: 'proton',
        name: '>=10 MeV proton',
        color: COLORS.s,
        axisIndex: 0,
        unit: 'pfu',
        points: rows.map((row) => {
          const safeFlux = Math.max(row.flux, 0.01);
          const scale = classifyRadiationStormScale(row.flux);
          return {
            t: row.t,
            value: safeFlux,
            label: `${formatPfu(row.flux)} pfu`,
            detail: `S${scale} · ${scaleText('S', scale)} · GOES >=10 MeV`,
            sourceLabel: 'NOAA GOES primary',
            observed: 'observed',
          };
        }),
      },
    ],
  }, nowMs);
}

function buildIonosphereModel(weather: SpaceWeatherSnapshot | null, nowMs: number): WeatherChartModel {
  const rows = normalizeXrayTimeline(weather);
  return createModel({
    mode: 'ionosphere',
    title: 'Ionosphere',
    subtitle: 'GOES X-ray flux against NOAA R-scale thresholds',
    emptyText: 'GOES X-ray 시계열 데이터가 없습니다.',
    axes: [{ name: 'X-ray flux', min: 1e-8, max: 2e-3, type: 'log', unit: 'W/m2', formatter: 'flux' }],
    thresholds: [
      { axisIndex: 0, value: 1e-5, label: 'R1 M1', tone: 'warn' },
      { axisIndex: 0, value: 5e-5, label: 'R2 M5', tone: 'warn' },
      { axisIndex: 0, value: 1e-4, label: 'R3 X1', tone: 'warn' },
      { axisIndex: 0, value: 1e-3, label: 'R4 X10', tone: 'orange' },
      { axisIndex: 0, value: 2e-3, label: 'R5 X20', tone: 'critical' },
    ],
    series: [
      {
        key: 'xray',
        name: 'X-ray 0.1-0.8nm',
        color: COLORS.r,
        axisIndex: 0,
        unit: 'W/m2',
        points: rows.map((row) => {
          const safeFlux = Math.max(row.flux, 1e-8);
          const scale = classifyRadioBlackoutScale(row.flux);
          return {
            t: row.t,
            value: safeFlux,
            label: xrayClassLabel(row.flux),
            detail: `R${scale} · ${scaleText('R', scale)} · ${row.flux.toExponential(2)} W/m2`,
            sourceLabel: 'NOAA GOES primary',
            observed: 'observed',
          };
        }),
      },
    ],
  }, nowMs);
}

function createModel(input: Omit<WeatherChartModel, 'extent' | 'currentReadout'>, nowMs: number): WeatherChartModel {
  const timestamps = input.series.flatMap((series) => series.points.map((point) => new Date(point.t).getTime())).filter(Number.isFinite);
  const extent = timestamps.length ? { start: Math.min(...timestamps), end: Math.max(...timestamps) } : null;
  const model = { ...input, extent, currentReadout: null };
  return { ...model, currentReadout: readoutForTime(model, nowMs) };
}

function readoutForTime(model: Omit<WeatherChartModel, 'currentReadout'>, targetTimeMs: number): WeatherSelectedReadout | null {
  const rows = model.series
    .map((series) => {
      const point = nearestPoint(series.points, targetTimeMs);
      return point
        ? {
            name: series.name,
            value: point.label,
            detail: point.detail,
            sourceLabel: point.sourceLabel,
            t: point.t,
          }
        : null;
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  if (!rows.length) return null;
  const anchor = rows.reduce((best, row) => {
    const distance = Math.abs(new Date(row.t).getTime() - targetTimeMs);
    return distance < best.distance ? { t: row.t, distance } : best;
  }, { t: rows[0].t, distance: Number.POSITIVE_INFINITY });
  return {
    t: anchor.t,
    rows: rows.map(({ t: _t, ...row }) => row),
  };
}

function nearestPoint(points: WeatherChartPoint[], targetTimeMs: number) {
  if (!points.length) return null;
  return points.reduce((best, point) => {
    const distance = Math.abs(new Date(point.t).getTime() - targetTimeMs);
    const bestDistance = Math.abs(new Date(best.t).getTime() - targetTimeMs);
    return distance < bestDistance ? point : best;
  }, points[0]);
}

function normalizeKpTimeline(weather: SpaceWeatherSnapshot | null) {
  if (!weather) return [];
  const rows = weather.kp.series?.length
    ? weather.kp.series
    : [
        ...(weather.kp.current !== null ? [{ t: weather.fetchedAt, kp: weather.kp.current, observed: 'observed' as const, noaaScale: null }] : []),
        ...(weather.kp.forecast ?? []).map((item) => ({ ...item, observed: 'predicted' as const, noaaScale: null })),
      ];
  return rows
    .map((row) => ({ ...row, t: normalizeTimestamp(row.t) }))
    .filter((row) => row.t && Number.isFinite(row.kp))
    .sort((left, right) => left.t.localeCompare(right.t));
}

function normalizeProtonTimeline(weather: SpaceWeatherSnapshot | null) {
  const proton = weather?.proton;
  const rows = proton?.series?.length
    ? proton.series
    : proton?.currentPfu !== null && proton?.currentPfu !== undefined
      ? [{ t: proton.observedAt ?? weather?.fetchedAt ?? new Date().toISOString(), flux: proton.currentPfu }]
      : [];
  return rows
    .map((row) => ({ t: normalizeTimestamp(row.t), flux: Number(row.flux) }))
    .filter((row) => row.t && Number.isFinite(row.flux))
    .sort((left, right) => left.t.localeCompare(right.t));
}

function normalizeXrayTimeline(weather: SpaceWeatherSnapshot | null) {
  const rows = weather?.xray.series?.length
    ? weather.xray.series
    : weather?.xray.currentWm2
      ? [{ t: weather.fetchedAt, flux: weather.xray.currentWm2 }]
      : [];
  return rows
    .map((row) => ({ t: normalizeTimestamp(row.t), flux: Number(row.flux) }))
    .filter((row) => row.t && Number.isFinite(row.flux) && row.flux > 0)
    .sort((left, right) => left.t.localeCompare(right.t));
}

function normalizeTimestamp(value: unknown) {
  if (!value) return '';
  const compact = String(value).trim().replace(' ', 'T');
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(compact) ? compact : `${compact}Z`;
  const parsed = new Date(withZone);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}

function latestPoint<T extends { t: string }>(points: T[], nowMs: number) {
  const observed = points.filter((point) => new Date(point.t).getTime() <= nowMs).at(-1);
  return observed ?? points.at(-1) ?? null;
}

function parseScaleLabel(label: string | null | undefined, prefix: 'G' | 'S' | 'R') {
  const match = typeof label === 'string' ? label.match(new RegExp(`^${prefix}(\\d)$`, 'i')) : null;
  return match ? Number(match[1]) : null;
}

function derivedScaleSummary(kind: 'R' | 'S' | 'G', scale: number, observedAt?: string): NoaaScaleSummary {
  return {
    scale,
    label: `${kind}${scale}`,
    text: scaleText(kind, scale),
    observedAt,
    source: 'DERIVED',
  };
}

function displayScaleText(kind: 'R' | 'S' | 'G', scale: NoaaScaleSummary) {
  if (scale.scale === 0 || scale.text === 'none') return scaleText(kind, 0);
  return scale.text ?? (scale.scale === null ? 'not available' : scaleText(kind, scale.scale));
}

function scaleText(kind: 'R' | 'S' | 'G', scale: number) {
  const labels = ['none', 'minor', 'moderate', 'strong', 'severe', 'extreme'];
  if (scale === 0) {
    if (kind === 'G') return 'no storm';
    if (kind === 'S') return 'no radiation storm';
    return 'no radio blackout';
  }
  return labels[Math.min(Math.max(Math.round(scale), 0), labels.length - 1)];
}

function sourceLabel(source: NoaaScaleSummary['source']) {
  return source === 'NOAA_SWPC' ? 'NOAA SWPC' : 'derived';
}

function statusLabel(status: WeatherChartPoint['observed'] | undefined) {
  if (status === 'predicted') return 'forecast';
  if (status === 'estimated') return 'estimated';
  if (status === 'derived') return 'derived';
  return 'observed';
}

function classifyKpStorm(kp: number | null) {
  if (kp === null) return 'QUIET';
  if (kp >= 8) return 'SEVERE';
  if (kp >= 7) return 'STRONG';
  if (kp >= 6) return 'MODERATE';
  if (kp >= 5) return 'MINOR';
  if (kp >= 4) return 'UNSETTLED';
  return 'QUIET';
}

function kpTone(kp: number | null): WeatherTone {
  if (kp === null) return 'default';
  if (kp >= 9) return 'critical';
  if (kp >= 8) return 'orange';
  if (kp >= 7) return 'warn';
  return 'good';
}

function scaleTone(scale: number | null): WeatherTone {
  if (scale === null) return 'default';
  if (scale >= 5) return 'critical';
  if (scale >= 4) return 'orange';
  if (scale >= 3) return 'warn';
  return 'good';
}

function formatKp(kp: number) {
  return kp.toFixed(Number.isInteger(kp) ? 0 : 1);
}

function formatPfu(value: number) {
  if (value >= 1000) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
