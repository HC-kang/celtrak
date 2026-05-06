<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { LineChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { init, use, type ECharts } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import PanelCard from '@/components/PanelCard.vue';
import OriginBadge from '@/components/OriginBadge.vue';
import { formatTimestamp, truncate } from '@/lib/format';
import {
  WEATHER_RANGE_PRESETS,
  buildMetricSummaries,
  buildWeatherDashboardModel,
  findNearestDashboardReadout,
  formatChartValue,
  type WeatherChartAxis,
  type WeatherChartModel,
  type WeatherDashboardModel,
  type WeatherDashboardReadout,
  type WeatherPanelKey,
} from '@/lib/spaceWeatherCharts';
import { useAppStore } from '@/stores/app';

use([LineChart, GridComponent, LegendComponent, TooltipComponent, DataZoomComponent, MarkLineComponent, CanvasRenderer]);

type RangeKey = '6h' | '24h' | '3d' | 'all';

const store = useAppStore();
const overviewChartEl = ref<HTMLElement | null>(null);
const expandedChartEl = ref<HTMLElement | null>(null);
const overviewChart = shallowRef<ECharts | null>(null);
const expandedChart = shallowRef<ECharts | null>(null);
const selectedRange = ref<RangeKey>('24h');
const expandedPanelKey = ref<WeatherPanelKey>('geomagnetic');
const selectedReadout = ref<WeatherDashboardReadout | null>(null);

let resizeObserver: ResizeObserver | null = null;

const metricSummaries = computed(() => buildMetricSummaries(store.weather));
const dashboardModel = computed(() => buildWeatherDashboardModel(store.weather));
const expandedModel = computed(() => dashboardModel.value.panels.find((panel) => panel.mode === expandedPanelKey.value) ?? dashboardModel.value.panels[0]);
const activeReadout = computed(() => selectedReadout.value ?? dashboardModel.value.currentReadout);
const noticeRows = computed(() => store.weather?.notices ?? []);
const scaleSourceLabel = computed(() => {
  const current = store.weather?.scales?.current;
  const values = [current?.r.source, current?.s.source, current?.g.source].filter(Boolean);
  return values.includes('DERIVED') ? 'NOAA-derived fallback' : 'NOAA SWPC direct';
});
const kasaMismatchNotice = computed(() => {
  const current = store.weather?.scales?.current;
  const warn = store.weather?.kasa?.warn;
  if (!current || !warn) return '';
  const mismatches = [
    warn.g.current && warn.g.current !== current.g.label ? `G ${current.g.label}/${warn.g.current}` : '',
    warn.s.current && warn.s.current !== current.s.label ? `S ${current.s.label}/${warn.s.current}` : '',
    warn.r.current && warn.r.current !== current.r.label ? `R ${current.r.label}/${warn.r.current}` : '',
  ].filter(Boolean);
  return mismatches.length ? `KASA supplement differs: ${mismatches.join(' · ')}` : '';
});
const kasaProbabilityRows = computed(() => {
  const prob = store.weather?.kasa?.prob;
  if (!prob) return [];
  return [
    { key: 'r', label: 'R forecast', lower: 'R1-R2', major: 'R3+', windows: prob.r },
    { key: 's', label: 'S forecast', lower: 'S1-S2', major: 'S3+', windows: prob.s },
    { key: 'g', label: 'G forecast', lower: 'G1-G2', major: 'G3+', windows: prob.g },
  ];
});

watch(
  dashboardModel,
  async (model) => {
    selectedReadout.value = model.currentReadout;
    if (!model.panels.some((panel) => panel.mode === expandedPanelKey.value)) {
      expandedPanelKey.value = model.panels[0]?.mode ?? 'geomagnetic';
    }
    await nextTick();
    renderCharts();
    applyRange(selectedRange.value);
  },
  { immediate: false },
);

watch(expandedModel, async () => {
  await nextTick();
  renderExpandedChart();
  applyRange(selectedRange.value);
});

onMounted(async () => {
  await nextTick();
  if (overviewChartEl.value) {
    overviewChart.value = init(overviewChartEl.value, undefined, { renderer: 'canvas' });
    attachOverviewHandlers();
  }
  if (expandedChartEl.value) {
    expandedChart.value = init(expandedChartEl.value, undefined, { renderer: 'canvas' });
    attachExpandedHandlers();
  }
  renderCharts();
  applyRange(selectedRange.value);
  resizeObserver = new ResizeObserver(() => {
    overviewChart.value?.resize();
    expandedChart.value?.resize();
  });
  if (overviewChartEl.value) resizeObserver.observe(overviewChartEl.value);
  if (expandedChartEl.value) resizeObserver.observe(expandedChartEl.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  overviewChart.value?.dispose();
  expandedChart.value?.dispose();
  overviewChart.value = null;
  expandedChart.value = null;
});

function expandPanel(key: WeatherPanelKey) {
  expandedPanelKey.value = key;
}

function selectRange(key: RangeKey) {
  selectedRange.value = key;
  applyRange(key);
}

function resetChartView() {
  selectedRange.value = 'all';
  selectedReadout.value = dashboardModel.value.currentReadout;
  applyRange('all');
}

function renderCharts() {
  renderOverviewChart();
  renderExpandedChart();
}

function renderOverviewChart() {
  const instance = overviewChart.value;
  if (!instance) return;
  instance.setOption(buildDashboardOption(dashboardModel.value), { notMerge: true, lazyUpdate: false });
}

function renderExpandedChart() {
  const instance = expandedChart.value;
  const model = expandedModel.value;
  if (!instance || !model) return;
  instance.setOption(buildChartOption(model), { notMerge: true, lazyUpdate: false });
}

function attachOverviewHandlers() {
  const instance = overviewChart.value;
  if (!instance) return;
  instance.getZr().on('click', (event: { offsetX: number; offsetY: number }) => {
    const point: [number, number] = [event.offsetX, event.offsetY];
    const panelIndex = dashboardModel.value.panels.findIndex((_panel, index) => instance.containPixel({ gridIndex: index }, point));
    if (panelIndex < 0) return;
    const converted = instance.convertFromPixel({ xAxisIndex: panelIndex }, point);
    const timeValue = Array.isArray(converted) ? Number(converted[0]) : Number(converted);
    const readout = findNearestDashboardReadout(dashboardModel.value, timeValue);
    if (readout) selectedReadout.value = readout;
  });
}

function attachExpandedHandlers() {
  const instance = expandedChart.value;
  if (!instance) return;
  instance.getZr().on('click', (event: { offsetX: number; offsetY: number }) => {
    const point: [number, number] = [event.offsetX, event.offsetY];
    if (!instance.containPixel({ gridIndex: 0 }, point)) return;
    const converted = instance.convertFromPixel({ xAxisIndex: 0 }, point);
    const timeValue = Array.isArray(converted) ? Number(converted[0]) : Number(converted);
    const readout = findNearestDashboardReadout(dashboardModel.value, timeValue);
    if (readout) selectedReadout.value = readout;
  });
}

function applyRange(key: RangeKey) {
  const extent = dashboardModel.value.extent;
  if (!extent) return;
  const preset = WEATHER_RANGE_PRESETS.find((item) => item.key === key);
  const now = Date.now();
  const anchor = key === 'all' ? extent.end : Math.min(Math.max(now, extent.start), extent.end);
  const end = key === 'all' ? extent.end : anchor;
  const start = preset?.durationMs ? Math.max(extent.start, end - preset.durationMs) : extent.start;
  const payload = {
    type: 'dataZoom' as const,
    dataZoomIndex: 0,
    startValue: new Date(start).toISOString(),
    endValue: new Date(end).toISOString(),
  };
  overviewChart.value?.dispatchAction(payload);
  expandedChart.value?.dispatchAction(payload);
}

function buildDashboardOption(model: WeatherDashboardModel) {
  const panels = model.panels;
  const panelCount = Math.max(panels.length, 1);
  const topPct = 5;
  const bottomPct = 7;
  const gapPct = 3.2;
  const panelHeightPct = (100 - topPct - bottomPct - gapPct * (panelCount - 1)) / panelCount;
  const grids = panels.map((_panel, index) => ({
    left: 54,
    right: 22,
    top: `${topPct + index * (panelHeightPct + gapPct)}%`,
    height: `${panelHeightPct}%`,
    containLabel: true,
  }));
  const xAxes = panels.map((_panel, index) => ({
    type: 'time',
    gridIndex: index,
    axisLine: { lineStyle: { color: 'rgba(31, 31, 31, 0.16)' } },
    axisTick: { show: false },
    axisLabel: {
      show: index === panels.length - 1,
      color: '#667085',
      hideOverlap: true,
      formatter: formatAxisTime,
    },
    splitLine: {
      show: true,
      lineStyle: { color: 'rgba(31, 31, 31, 0.05)' },
    },
  }));
  const yAxes: Array<Record<string, unknown>> = [];
  const series: Array<Record<string, unknown>> = [];
  panels.forEach((panel, panelIndex) => {
    const yAxisOffset = yAxes.length;
    panel.axes.forEach((axis) => {
      yAxes.push({
        ...axisOption(axis),
        gridIndex: panelIndex,
        name: panel.title,
        nameGap: 12,
        nameTextStyle: {
          color: '#3f4754',
          fontSize: 11,
          fontWeight: 900,
        },
      });
    });
    panel.series.forEach((item) => {
      series.push({
        ...seriesOption(item, panel, true),
        xAxisIndex: panelIndex,
        yAxisIndex: yAxisOffset + item.axisIndex,
      });
    });
  });

  return {
    backgroundColor: 'transparent',
    color: panels.flatMap((panel) => panel.series.map((item) => item.color)),
    animation: true,
    grid: grids,
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
      label: {
        backgroundColor: '#111827',
        color: '#ffffff',
      },
    },
    legend: { show: false },
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'cross', snap: false },
      borderWidth: 1,
      borderColor: 'rgba(31, 31, 31, 0.12)',
      backgroundColor: 'rgba(255, 255, 255, 0.96)',
      textStyle: { color: '#15171a' },
      formatter: formatTooltip,
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: panels.map((_panel, index) => index),
        filterMode: 'none',
        zoomOnMouseWheel: true,
        moveOnMouseWheel: true,
        moveOnMouseMove: true,
        preventDefaultMouseMove: true,
        throttle: 40,
      },
    ],
    xAxis: xAxes,
    yAxis: yAxes,
    series,
  };
}

function buildChartOption(model: WeatherChartModel) {
  return {
    backgroundColor: 'transparent',
    color: model.series.map((series) => series.color),
    animation: true,
    grid: {
      left: 18,
      right: model.axes.length > 1 ? 48 : 18,
      top: 62,
      bottom: 34,
      containLabel: true,
    },
    legend: {
      top: 0,
      left: 0,
      itemWidth: 16,
      itemHeight: 8,
      textStyle: {
        color: '#4d5664',
        fontSize: 12,
        fontWeight: 700,
      },
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: {
        type: 'cross',
        snap: false,
        label: {
          backgroundColor: '#111827',
          color: '#ffffff',
        },
      },
      borderWidth: 1,
      borderColor: 'rgba(31, 31, 31, 0.12)',
      backgroundColor: 'rgba(255, 255, 255, 0.96)',
      textStyle: {
        color: '#15171a',
      },
      formatter: formatTooltip,
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
        zoomOnMouseWheel: true,
        moveOnMouseWheel: true,
        moveOnMouseMove: true,
        preventDefaultMouseMove: true,
        throttle: 40,
      },
    ],
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: 'rgba(31, 31, 31, 0.18)' } },
      axisTick: { show: false },
      axisLabel: {
        color: '#667085',
        hideOverlap: true,
        formatter: formatAxisTime,
      },
      splitLine: {
        show: true,
        lineStyle: { color: 'rgba(31, 31, 31, 0.06)' },
      },
    },
    yAxis: model.axes.map((axis) => axisOption(axis)),
    series: model.series.map((series) => seriesOption(series, model, false)),
  };
}

function seriesOption(series: WeatherChartModel['series'][number], model: WeatherChartModel, compact: boolean) {
  return {
    name: series.name,
    type: 'line',
    yAxisIndex: series.axisIndex,
    step: series.stepped ? 'end' : false,
    showSymbol: false,
    symbol: 'circle',
    symbolSize: compact ? 5 : 7,
    smooth: false,
    sampling: series.stepped ? undefined : 'lttb',
    connectNulls: false,
    data: series.points.map((point) => ({
      value: [point.t, point.value],
      label: point.label,
      detail: point.detail,
      sourceLabel: point.sourceLabel,
    })),
    lineStyle: {
      width: compact ? (series.stepped ? 2 : 2.4) : (series.stepped ? 2.5 : 3),
      type: series.dashed ? 'dashed' : 'solid',
    },
    areaStyle: compact || series.stepped || series.dashed ? undefined : { opacity: 0.08 },
    emphasis: {
      focus: 'series',
    },
    markLine: {
      silent: true,
      symbol: 'none',
      label: {
        color: '#4d5664',
        fontWeight: 800,
        formatter: '{b}',
      },
      data: model.thresholds
        .filter((threshold) => threshold.axisIndex === series.axisIndex)
        .map((threshold) => ({
          name: threshold.label,
          yAxis: threshold.value,
          lineStyle: {
            color: thresholdColor(threshold.tone),
            width: compact ? 1 : 1.2,
            type: 'dashed',
          },
        })),
    },
  };
}

function axisOption(axis: WeatherChartAxis) {
  return {
    type: axis.type,
    name: axis.name,
    min: axis.min,
    max: axis.max,
    position: axis.position ?? 'left',
    nameTextStyle: {
      color: '#667085',
      fontWeight: 800,
    },
    axisLabel: {
      color: '#667085',
      formatter: (value: number) => formatChartValue(value, axis.formatter),
    },
    splitLine: {
      lineStyle: { color: 'rgba(31, 31, 31, 0.08)' },
    },
  };
}

function formatTooltip(params: unknown) {
  const rows = Array.isArray(params) ? params : [params];
  const first = rows[0] as { value?: [string, number] } | undefined;
  const time = first?.value?.[0] ? formatTimestamp(first.value[0]) : '-';
  const lines = rows
    .map((row) => row as { marker?: string; seriesName?: string; data?: { label?: string; detail?: string; sourceLabel?: string } })
    .map((row) => {
      const label = row.data?.label ?? '-';
      const detail = row.data?.detail ?? '';
      const source = row.data?.sourceLabel ? `<span class="weather-tooltip__source">${row.data.sourceLabel}</span>` : '';
      return `<div class="weather-tooltip__row">${row.marker ?? ''}<strong>${row.seriesName ?? ''}</strong><span>${label}</span></div><small>${detail} ${source}</small>`;
    })
    .join('');
  return `<div class="weather-tooltip"><b>${time}</b>${lines}</div>`;
}

function formatAxisTime(value: number) {
  if (!Number.isFinite(value)) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function thresholdColor(tone: string) {
  if (tone === 'critical') return '#c81b3a';
  if (tone === 'orange') return '#f97316';
  if (tone === 'warn') return '#d9a400';
  return '#667085';
}

function normalizeNoticeText(text: string) {
  return truncate(text.replace(/\s+/g, ' ').trim(), 210);
}

function metricKasaLine(key: string) {
  const kasa = store.weather?.kasa;
  if (!kasa) return '';
  if (key === 'kp') {
    const kindex = kasa.kindex;
    if (!kindex) return '';
    return `KASA Kp ${formatNullableNumber(kindex.currentKp)} · Kk ${formatNullableNumber(kindex.currentKk)}`;
  }
  const warn = kasa.warn;
  if (!warn || (key !== 'g' && key !== 's' && key !== 'r')) return '';
  const value = warn[key];
  return `KASA ${value.current ?? '-'} · 48h ${value.previous48 ?? '-'}`;
}

function metricProbabilityLine(key: string) {
  const prob = store.weather?.kasa?.prob;
  if (!prob || (key !== 'g' && key !== 's' && key !== 'r')) return '';
  const first = prob[key][0];
  if (!first) return '';
  const prefix = key.toUpperCase();
  const lower = key === 'g' ? 'G1-G2' : `${prefix}1-${prefix}2`;
  const major = key === 'g' ? 'G3+' : `${prefix}3+`;
  return `0-24h ${lower} ${formatProbability(first.minorPct)} · ${major} ${formatProbability(first.majorPct)}`;
}

function formatProbability(value: number | null | undefined) {
  return value === null || value === undefined ? '-' : `${value}%`;
}

function formatNullableNumber(value: number | null | undefined) {
  return value === null || value === undefined ? '-' : value.toFixed(value % 1 === 0 ? 0 : 2);
}
</script>

<template>
  <div class="page-stack">
    <PanelCard title="Space Weather Explorer" subtitle="NOAA canonical · KASA supplement">
      <template #actions>
        <span v-if="kasaMismatchNotice" class="source-chip source-chip--warn panel-card__action-link">{{ kasaMismatchNotice }}</span>
        <span class="source-chip source-chip--info panel-card__action-link">{{ scaleSourceLabel }}</span>
        <OriginBadge :origin="store.weather?.origin ?? 'OSINT'" :timestamp="store.weather?.fetchedAt" :stale="store.weather?.stale" />
      </template>

      <div class="weather-explorer">
        <div class="weather-metric-strip" aria-label="Space weather metrics">
          <article
            v-for="metric in metricSummaries"
            :key="metric.key"
            class="weather-metric-pill weather-metric-pill--summary"
            :class="[`weather-tone--${metric.tone}`]"
          >
            <span>
              <small>{{ metric.label }}</small>
              <strong>{{ metric.value }}</strong>
            </span>
            <span>
              <em>{{ metric.detail }}</em>
              <small>{{ metric.sourceLabel }} · {{ formatTimestamp(metric.observedAt) }}</small>
              <small v-if="metricKasaLine(metric.key)" class="weather-metric-pill__supplement">{{ metricKasaLine(metric.key) }}</small>
              <small v-if="metricProbabilityLine(metric.key)" class="weather-metric-pill__supplement">{{ metricProbabilityLine(metric.key) }}</small>
            </span>
          </article>
        </div>

        <div v-if="kasaProbabilityRows.length" class="weather-kasa-strip" aria-label="KASA forecast probabilities">
          <article v-for="row in kasaProbabilityRows" :key="row.key">
            <small>{{ row.label }}</small>
            <strong>{{ row.lower }}</strong>
            <span v-for="window in row.windows" :key="`${row.key}-${window.startHour}`">
              {{ window.startHour }}-{{ window.endHour }}h {{ formatProbability(window.minorPct) }} / {{ row.major }} {{ formatProbability(window.majorPct) }}
            </span>
          </article>
        </div>

        <section class="weather-chart-panel">
          <header class="weather-chart-panel__header">
            <div>
              <p>Linked overview</p>
              <h2>Space Weather Timelines</h2>
            </div>
            <div class="weather-range-controls" aria-label="Chart range controls">
              <button
                v-for="preset in WEATHER_RANGE_PRESETS"
                :key="preset.key"
                type="button"
                class="weather-range-button"
                :class="{ 'weather-range-button--active': selectedRange === preset.key }"
                @click="selectRange(preset.key)"
              >
                {{ preset.label }}
              </button>
              <button type="button" class="weather-range-button weather-range-button--reset" @click="resetChartView">
                Reset
              </button>
            </div>
          </header>

          <div class="weather-panel-toolbar" aria-label="Weather panel expand controls">
            <button
              v-for="panel in dashboardModel.panels"
              :key="panel.mode"
              type="button"
              class="weather-panel-button"
              :class="{ 'weather-panel-button--active': expandedPanelKey === panel.mode }"
              @click="expandPanel(panel.mode)"
            >
              <span>
                <small>{{ panel.subtitle }}</small>
                <strong>{{ panel.title }}</strong>
              </span>
              <em>Expand</em>
            </button>
          </div>

          <div class="weather-echart-shell weather-echart-shell--overview">
            <div ref="overviewChartEl" class="weather-echart weather-echart--overview" aria-label="Linked space weather small multiple charts" />
            <p v-if="!dashboardModel.extent" class="weather-echart-empty">우주기상 시계열 데이터가 없습니다.</p>
          </div>

          <footer class="weather-readout weather-readout--dashboard" aria-live="polite">
            <div>
              <small>Selected time</small>
              <strong>{{ activeReadout ? formatTimestamp(activeReadout.t) : '데이터 없음' }}</strong>
            </div>
            <div v-for="row in activeReadout?.rows ?? []" :key="`${row.panelKey}-${row.name}`">
              <small>{{ row.panelTitle }} · {{ row.name }} · {{ row.sourceLabel }}</small>
              <strong>{{ row.value }}</strong>
              <span>{{ row.detail }}</span>
            </div>
          </footer>
        </section>

        <section v-if="expandedModel" class="weather-chart-panel weather-chart-panel--expanded">
          <header class="weather-chart-panel__header">
            <div>
              <p>{{ expandedModel.subtitle }}</p>
              <h2>{{ expandedModel.title }}</h2>
            </div>
            <span class="source-chip source-chip--info panel-card__action-link">Expanded analysis</span>
          </header>
          <div class="weather-echart-shell weather-echart-shell--expanded">
            <div ref="expandedChartEl" class="weather-echart weather-echart--expanded" :aria-label="`${expandedModel.title} expanded chart`" />
            <p v-if="!expandedModel.extent" class="weather-echart-empty">{{ expandedModel.emptyText }}</p>
          </div>
        </section>
      </div>
    </PanelCard>

    <PanelCard title="Alerts & Notices" subtitle="NOAA / KASA feed">
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
