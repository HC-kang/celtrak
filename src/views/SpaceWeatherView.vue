<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import PanelCard from '@/components/PanelCard.vue';
import OriginBadge from '@/components/OriginBadge.vue';
import { useAppStore } from '@/stores/app';
import type { SpaceWeatherSnapshot } from '@/domain/types';
import { formatTimestamp, truncate } from '@/lib/format';

const store = useAppStore();

type MetricTone = 'default' | 'good' | 'warn' | 'orange' | 'critical';
type WeatherMetricKey = 'kp' | 'g' | 's' | 'r';
type KpTimelinePoint = NonNullable<SpaceWeatherSnapshot['kp']['series']>[number];

interface TrendPoint {
  t: string;
  value: number;
  label: string;
  detail: string;
  tone: MetricTone;
  status?: KpTimelinePoint['observed'] | 'derived';
}

interface TrendMetric {
  key: WeatherMetricKey;
  label: string;
  shortLabel: string;
  subtitle: string;
  sourceLabel: string;
  domain: [number, number];
  thresholds: Array<{ value: number; label: string; tone: MetricTone }>;
  points: TrendPoint[];
  current: TrendPoint | null;
  tone: MetricTone;
}

const CHART = {
  width: 1000,
  height: 320,
  left: 54,
  right: 966,
  top: 28,
  bottom: 276,
};

const selectedMetricKey = ref<WeatherMetricKey>('kp');
const selectedIndex = ref(0);

const trendMetrics = computed<TrendMetric[]>(() => {
  const weather = store.weather;
  return [buildKpMetric(weather), buildGMetric(weather), buildSMetric(weather), buildRMetric(weather)];
});

const activeMetric = computed(() => trendMetrics.value.find((metric) => metric.key === selectedMetricKey.value) ?? trendMetrics.value[0]);
const activePoints = computed(() => activeMetric.value.points);
const safeSelectedIndex = computed(() => clamp(Math.round(selectedIndex.value), 0, Math.max(activePoints.value.length - 1, 0)));
const selectedPoint = computed(() => activePoints.value[safeSelectedIndex.value] ?? null);
const chartPath = computed(() => linePath(activePoints.value, activeMetric.value.domain));
const chartAreaPath = computed(() => areaPath(activePoints.value, activeMetric.value.domain));
const selectedPointX = computed(() => pointX(safeSelectedIndex.value, activePoints.value.length));
const selectedPointY = computed(() => selectedPoint.value ? pointY(selectedPoint.value.value, activeMetric.value.domain) : CHART.bottom);
const thresholdLines = computed(() =>
  activeMetric.value.thresholds.map((threshold) => ({
    ...threshold,
    y: pointY(threshold.value, activeMetric.value.domain),
  })),
);
const axisStartLabel = computed(() => activePoints.value[0] ? formatTimestamp(activePoints.value[0].t) : '—');
const axisEndLabel = computed(() => activePoints.value.at(-1) ? formatTimestamp(activePoints.value.at(-1)?.t) : '—');
const scaleSourceLabel = computed(() => {
  const current = store.weather?.scales?.current;
  const values = [current?.r.source, current?.s.source, current?.g.source].filter(Boolean);
  return values.includes('DERIVED') ? 'Derived from SWPC feeds' : 'NOAA SWPC scales';
});
const noticeRows = computed(() => store.weather?.notices ?? []);

watch(
  [selectedMetricKey, () => activeMetric.value.points.length, () => activeMetric.value.points.at(-1)?.t],
  () => {
    selectedIndex.value = latestPointIndex(activeMetric.value.points);
  },
  { immediate: true },
);

function selectMetric(key: WeatherMetricKey) {
  selectedMetricKey.value = key;
}

function handleScrub(event: Event) {
  selectedIndex.value = Number((event.target as HTMLInputElement).value);
}

function handleChartPointer(event: PointerEvent) {
  if (activePoints.value.length <= 1) return;
  const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
  const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * CHART.width;
  const ratio = clamp((x - CHART.left) / Math.max(CHART.right - CHART.left, 1), 0, 1);
  selectedIndex.value = Math.round(ratio * (activePoints.value.length - 1));
}

function buildKpMetric(weather: SpaceWeatherSnapshot | null): TrendMetric {
  const points = normalizeKpTimeline(weather).map((item) => ({
    t: item.t,
    value: item.kp,
    label: formatKp(item.kp),
    detail: `지자기교란 · ${classifyKpStorm(item.kp)} · ${statusLabel(item.observed)}`,
    tone: kpTone(item.kp),
    status: item.observed,
  }));
  const current = currentPoint(points);
  return {
    key: 'kp',
    label: 'Kp Disturbance',
    shortLabel: 'Kp',
    subtitle: 'Planetary K-index',
    sourceLabel: 'SWPC observed / forecast',
    domain: [0, 9],
    thresholds: [
      { value: 5, label: 'G1', tone: 'warn' },
      { value: 7, label: 'G3', tone: 'warn' },
      { value: 8, label: 'G4', tone: 'orange' },
      { value: 9, label: 'G5', tone: 'critical' },
    ],
    points,
    current,
    tone: current?.tone ?? 'default',
  };
}

function buildGMetric(weather: SpaceWeatherSnapshot | null): TrendMetric {
  const kpPoints = normalizeKpTimeline(weather);
  const points = kpPoints.length
    ? kpPoints.map((item) => {
        const scale = parseScaleLabel(item.noaaScale, 'G') ?? classifyGeomagneticScale(item.kp);
        return {
          t: item.t,
          value: scale,
          label: `G${scale}`,
          detail: `지자기폭풍 · ${scaleText('G', scale)} · Kp ${formatKp(item.kp)}`,
          tone: scaleNumberTone(scale),
          status: item.observed,
        };
      })
    : scaleTimeline(weather, 'g', 'G').map(scalePoint);
  const current = currentPoint(points);
  return {
    key: 'g',
    label: 'G Storm',
    shortLabel: 'G',
    subtitle: 'Geomagnetic scale',
    sourceLabel: 'NOAA scale / Kp derived',
    domain: [0, 5],
    thresholds: [
      { value: 1, label: 'G1', tone: 'warn' },
      { value: 3, label: 'G3', tone: 'warn' },
      { value: 4, label: 'G4', tone: 'orange' },
      { value: 5, label: 'G5', tone: 'critical' },
    ],
    points,
    current,
    tone: current?.tone ?? 'default',
  };
}

function buildSMetric(weather: SpaceWeatherSnapshot | null): TrendMetric {
  const proton = weather?.proton;
  const rows = proton?.series?.length
    ? proton.series
    : proton?.currentPfu !== null && proton?.currentPfu !== undefined
      ? [{ t: proton.observedAt ?? weather?.fetchedAt ?? new Date().toISOString(), flux: proton.currentPfu }]
      : [];
  const points = rows
    .map((row) => {
      const flux = Math.max(row.flux, 0.001);
      const scale = classifyRadiationStormScale(row.flux);
      return {
        t: row.t,
        value: Math.log10(flux),
        label: `S${scale}`,
        detail: `태양복사폭풍 · ${formatPfu(row.flux)} pfu · ${proton?.energy ?? '>=10 MeV'}`,
        tone: scaleNumberTone(scale),
        status: 'derived' as const,
      };
    })
    .filter((point) => point.t && Number.isFinite(point.value))
    .sort((left, right) => left.t.localeCompare(right.t));
  const current = currentPoint(points);
  return {
    key: 's',
    label: 'S Radiation',
    shortLabel: 'S',
    subtitle: 'GOES proton flux',
    sourceLabel: 'GOES >=10 MeV',
    domain: [-3, 5],
    thresholds: [
      { value: 1, label: 'S1', tone: 'warn' },
      { value: 3, label: 'S3', tone: 'warn' },
      { value: 4, label: 'S4', tone: 'orange' },
      { value: 5, label: 'S5', tone: 'critical' },
    ],
    points,
    current,
    tone: current?.tone ?? 'default',
  };
}

function buildRMetric(weather: SpaceWeatherSnapshot | null): TrendMetric {
  const rows = weather?.xray.series?.length
    ? weather.xray.series
    : weather?.xray.currentWm2
      ? [{ t: weather.fetchedAt, flux: weather.xray.currentWm2 }]
      : [];
  const points = rows
    .map((row) => {
      const flux = Math.max(row.flux, 1e-9);
      const scale = classifyRadioBlackoutScale(row.flux);
      return {
        t: row.t,
        value: Math.log10(flux),
        label: `R${scale}`,
        detail: `전리층교란 · X-ray ${xrayClassLabel(row.flux)} · ${row.flux.toExponential(2)} W/m²`,
        tone: scaleNumberTone(scale),
        status: 'derived' as const,
      };
    })
    .filter((point) => point.t && Number.isFinite(point.value))
    .sort((left, right) => left.t.localeCompare(right.t));
  const current = currentPoint(points);
  return {
    key: 'r',
    label: 'R / Ionosphere',
    shortLabel: 'R',
    subtitle: 'GOES X-ray flux',
    sourceLabel: 'GOES 0.1-0.8nm',
    domain: [-8, -3],
    thresholds: [
      { value: -5, label: 'R1', tone: 'warn' },
      { value: -4, label: 'R3', tone: 'warn' },
      { value: -3.3, label: 'R4', tone: 'orange' },
      { value: -3, label: 'R5', tone: 'critical' },
    ],
    points,
    current,
    tone: current?.tone ?? 'default',
  };
}

function normalizeKpTimeline(weather: SpaceWeatherSnapshot | null): KpTimelinePoint[] {
  if (!weather) return [];
  const series = weather.kp.series?.length
    ? weather.kp.series
    : [
        ...(weather.kp.current !== null ? [{ t: weather.fetchedAt, kp: weather.kp.current, observed: 'observed' as const, noaaScale: null }] : []),
        ...(weather.kp.forecast ?? []).map((item) => ({ ...item, observed: 'predicted' as const, noaaScale: null })),
      ];
  return series
    .filter((item) => item.t && Number.isFinite(item.kp))
    .sort((left, right) => left.t.localeCompare(right.t));
}

function scaleTimeline(weather: SpaceWeatherSnapshot | null, key: 'r' | 's' | 'g', prefix: 'R' | 'S' | 'G') {
  const points: Array<{ t: string; scale: number; prefix: 'R' | 'S' | 'G' }> = [];
  const previous = weather?.scales?.previous?.[key];
  const current = weather?.scales?.current?.[key];
  if (previous?.observedAt && previous.scale !== null) points.push({ t: previous.observedAt, scale: previous.scale, prefix });
  if (current?.observedAt && current.scale !== null) points.push({ t: current.observedAt, scale: current.scale, prefix });
  for (const item of weather?.scales?.forecast ?? []) {
    const scale = item[key];
    if (item.t && scale?.scale !== null && scale?.scale !== undefined) points.push({ t: item.t, scale: scale.scale, prefix });
  }
  return points.sort((left, right) => left.t.localeCompare(right.t));
}

function scalePoint(item: { t: string; scale: number; prefix: 'R' | 'S' | 'G' }): TrendPoint {
  return {
    t: item.t,
    value: item.scale,
    label: `${item.prefix}${item.scale}`,
    detail: `${scaleDomainLabel(item.prefix)} · ${scaleText(item.prefix, item.scale)}`,
    tone: scaleNumberTone(item.scale),
    status: 'derived',
  };
}

function linePath(points: TrendPoint[], domain: [number, number]) {
  if (!points.length) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${pointX(index, points.length).toFixed(1)} ${pointY(point.value, domain).toFixed(1)}`)
    .join(' ');
}

function areaPath(points: TrendPoint[], domain: [number, number]) {
  if (!points.length) return '';
  const firstX = pointX(0, points.length);
  const lastX = pointX(points.length - 1, points.length);
  return `M ${firstX.toFixed(1)} ${CHART.bottom} ${linePath(points, domain).replace(/^M/, 'L')} L ${lastX.toFixed(1)} ${CHART.bottom} Z`;
}

function miniPath(metric: TrendMetric) {
  if (!metric.points.length) return '';
  return metric.points
    .map((point, index) => {
      const x = metric.points.length === 1 ? 50 : (index / (metric.points.length - 1)) * 100;
      const y = 34 - normalizedValue(point.value, metric.domain) * 28;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

function miniAreaPath(metric: TrendMetric) {
  const path = miniPath(metric);
  if (!path) return '';
  return `M 0 36 ${path.replace(/^M/, 'L')} L 100 36 Z`;
}

function pointX(index: number, count: number) {
  if (count <= 1) return (CHART.left + CHART.right) / 2;
  return CHART.left + (index / (count - 1)) * (CHART.right - CHART.left);
}

function pointY(value: number, domain: [number, number]) {
  return CHART.bottom - normalizedValue(value, domain) * (CHART.bottom - CHART.top);
}

function normalizedValue(value: number, domain: [number, number]) {
  const [min, max] = domain;
  return clamp((value - min) / Math.max(max - min, 1e-9), 0, 1);
}

function currentPoint(points: TrendPoint[]) {
  return points[latestPointIndex(points)] ?? null;
}

function latestPointIndex(points: TrendPoint[]) {
  if (!points.length) return 0;
  const now = Date.now();
  const observedIndex = points.findLastIndex((point) => new Date(point.t).getTime() <= now);
  return observedIndex >= 0 ? observedIndex : points.length - 1;
}

function parseScaleLabel(label: string | null | undefined, prefix: 'G' | 'S' | 'R') {
  const match = typeof label === 'string' ? label.match(new RegExp(`^${prefix}(\\d)$`, 'i')) : null;
  return match ? Number(match[1]) : null;
}

function classifyRadioBlackoutScale(flux: number | null | undefined) {
  if (!flux || flux < 1e-5) return 0;
  if (flux >= 2e-3) return 5;
  if (flux >= 1e-3) return 4;
  if (flux >= 1e-4) return 3;
  if (flux >= 5e-5) return 2;
  return 1;
}

function classifyRadiationStormScale(protonPfu: number | null | undefined) {
  if (protonPfu === null || protonPfu === undefined || protonPfu < 10) return 0;
  if (protonPfu >= 100_000) return 5;
  if (protonPfu >= 10_000) return 4;
  if (protonPfu >= 1_000) return 3;
  if (protonPfu >= 100) return 2;
  return 1;
}

function classifyGeomagneticScale(kp: number | null | undefined) {
  if (kp === null || kp === undefined || kp < 5) return 0;
  if (kp >= 9) return 5;
  if (kp >= 8) return 4;
  if (kp >= 7) return 3;
  if (kp >= 6) return 2;
  return 1;
}

function classifyKpStorm(kp: number) {
  if (kp >= 8) return 'SEVERE';
  if (kp >= 7) return 'STRONG';
  if (kp >= 6) return 'MODERATE';
  if (kp >= 5) return 'MINOR';
  if (kp >= 4) return 'UNSETTLED';
  return 'QUIET';
}

function xrayClassLabel(flux: number) {
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

function formatKp(kp: number) {
  return kp.toFixed(Number.isInteger(kp) ? 0 : 1);
}

function formatPfu(value: number) {
  if (value >= 1000) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function scaleNumberTone(value: number): MetricTone {
  if (value >= 5) return 'critical';
  if (value >= 4) return 'orange';
  if (value >= 3) return 'warn';
  return 'good';
}

function kpTone(kp: number | null): MetricTone {
  if (kp === null) return 'default';
  if (kp >= 9) return 'critical';
  if (kp >= 8) return 'orange';
  if (kp >= 7) return 'warn';
  return 'good';
}

function scaleText(kind: 'R' | 'S' | 'G', scale: number) {
  const labels = ['quiet', 'minor', 'moderate', 'strong', 'severe', 'extreme'];
  if (scale === 0) return quietScaleText(kind);
  return labels[Math.min(Math.max(Math.round(scale), 0), labels.length - 1)];
}

function scaleDomainLabel(kind: 'R' | 'S' | 'G') {
  if (kind === 'G') return '지자기폭풍';
  if (kind === 'S') return '태양복사폭풍';
  return '전리층교란';
}

function quietScaleText(kind: 'R' | 'S' | 'G') {
  if (kind === 'G') return 'no storm';
  if (kind === 'S') return 'no radiation storm';
  return 'no radio blackout';
}

function statusLabel(status: KpTimelinePoint['observed'] | 'derived' | undefined) {
  if (status === 'predicted') return 'forecast';
  if (status === 'estimated') return 'estimated';
  if (status === 'derived') return 'derived';
  return 'observed';
}

function normalizeNoticeText(text: string) {
  return truncate(text.replace(/\s+/g, ' ').trim(), 210);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
</script>

<template>
  <div class="page-stack">
    <PanelCard title="NOAA Space Weather Timeline" subtitle="Kp / G / S / R">
      <template #actions>
        <span class="source-chip source-chip--info panel-card__action-link">{{ scaleSourceLabel }}</span>
        <OriginBadge :origin="store.weather?.origin ?? 'OSINT'" :timestamp="store.weather?.fetchedAt" :stale="store.weather?.stale" />
      </template>

      <div class="space-weather-timeline">
        <div class="weather-trend-grid" role="tablist" aria-label="Space weather metrics">
          <button
            v-for="metric in trendMetrics"
            :key="metric.key"
            type="button"
            class="weather-trend-card"
            :class="[
              `weather-tone--${metric.tone}`,
              { 'weather-trend-card--active': selectedMetricKey === metric.key },
            ]"
            role="tab"
            :aria-selected="selectedMetricKey === metric.key"
            @click="selectMetric(metric.key)"
          >
            <span class="weather-trend-card__header">
              <span>
                <small>{{ metric.subtitle }}</small>
                <span>{{ metric.label }}</span>
              </span>
              <b>{{ metric.current?.label ?? '—' }}</b>
            </span>
            <svg class="weather-trend-card__spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
              <path class="weather-trend-card__spark-area" :d="miniAreaPath(metric)" />
              <path class="weather-trend-card__spark-line" :d="miniPath(metric)" />
            </svg>
            <span class="weather-trend-card__footer">
              <span>{{ metric.current?.detail ?? '데이터 없음' }}</span>
              <small>{{ metric.sourceLabel }}</small>
            </span>
          </button>
        </div>

        <section class="weather-chart" :class="`weather-tone--${activeMetric.tone}`">
          <header class="weather-chart__header">
            <div>
              <p>{{ activeMetric.shortLabel }} Timeline</p>
              <h2>{{ activeMetric.label }}</h2>
            </div>
            <div class="weather-chart__readout">
              <span>
                <small>Selected</small>
                <strong>{{ selectedPoint?.label ?? '—' }}</strong>
              </span>
              <span>
                <small>Time</small>
                <strong>{{ selectedPoint ? formatTimestamp(selectedPoint.t) : '—' }}</strong>
              </span>
              <span>
                <small>Value</small>
                <strong>{{ selectedPoint?.detail ?? '데이터 없음' }}</strong>
              </span>
            </div>
          </header>

          <svg
            class="weather-chart__plot"
            :viewBox="`0 0 ${CHART.width} ${CHART.height}`"
            preserveAspectRatio="none"
            role="img"
            :aria-label="`${activeMetric.label} timeline chart`"
            @pointerdown="handleChartPointer"
            @pointermove="handleChartPointer"
          >
            <defs>
              <linearGradient id="weatherTrendFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stop-color="currentColor" stop-opacity="0.24" />
                <stop offset="100%" stop-color="currentColor" stop-opacity="0.02" />
              </linearGradient>
            </defs>
            <rect class="weather-chart__backdrop" :x="CHART.left" :y="CHART.top" :width="CHART.right - CHART.left" :height="CHART.bottom - CHART.top" />
            <line
              v-for="line in thresholdLines"
              :key="line.label"
              class="weather-chart__threshold"
              :class="`weather-chart__threshold--${line.tone}`"
              :x1="CHART.left"
              :x2="CHART.right"
              :y1="line.y"
              :y2="line.y"
            />
            <text
              v-for="line in thresholdLines"
              :key="`${line.label}-label`"
              class="weather-chart__threshold-label"
              :x="CHART.right - 6"
              :y="line.y - 6"
              text-anchor="end"
            >
              {{ line.label }}
            </text>
            <path class="weather-chart__area" :d="chartAreaPath" />
            <path class="weather-chart__line" :d="chartPath" />
            <g v-if="selectedPoint" class="weather-chart__cursor">
              <line :x1="selectedPointX" :x2="selectedPointX" :y1="CHART.top" :y2="CHART.bottom" />
              <circle :cx="selectedPointX" :cy="selectedPointY" r="8" />
            </g>
          </svg>

          <input
            v-if="activePoints.length > 1"
            class="weather-timeline-scrubber"
            type="range"
            min="0"
            :max="Math.max(activePoints.length - 1, 0)"
            step="1"
            :value="safeSelectedIndex"
            :aria-label="`${activeMetric.label} selected time`"
            @input="handleScrub"
          />
          <footer class="weather-chart__axis">
            <span>{{ axisStartLabel }}</span>
            <span>{{ axisEndLabel }}</span>
          </footer>
        </section>
      </div>
    </PanelCard>

    <PanelCard title="Alerts & Notices" subtitle="NOAA feed">
      <div class="stack-list">
        <article v-if="!noticeRows.length" class="stack-list__item">
          <div>
            <strong>Quiet feed</strong>
            <p>현재 특기사항이 없습니다.</p>
          </div>
          <small>{{ formatTimestamp(store.weather?.fetchedAt) }}</small>
        </article>
        <article v-for="notice in noticeRows" :key="`${notice.type}-${notice.issuedAt}`" class="stack-list__item">
          <div>
            <strong>{{ notice.type }}</strong>
            <p>{{ normalizeNoticeText(notice.text) }}</p>
          </div>
          <small>{{ formatTimestamp(notice.issuedAt) }}</small>
        </article>
      </div>
    </PanelCard>
  </div>
</template>
