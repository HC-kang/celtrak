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
  buildWeatherChartModel,
  findNearestReadout,
  formatChartValue,
  type WeatherChartAxis,
  type WeatherChartMode,
  type WeatherChartModel,
  type WeatherSelectedReadout,
} from '@/lib/spaceWeatherCharts';
import { useAppStore } from '@/stores/app';

use([LineChart, GridComponent, LegendComponent, TooltipComponent, DataZoomComponent, MarkLineComponent, CanvasRenderer]);

const store = useAppStore();
const chartEl = ref<HTMLElement | null>(null);
const chart = shallowRef<ECharts | null>(null);
const selectedMode = ref<WeatherChartMode>('geomagnetic');
const selectedRange = ref<'6h' | '24h' | '3d' | 'all'>('24h');
const selectedReadout = ref<WeatherSelectedReadout | null>(null);

let resizeObserver: ResizeObserver | null = null;

const metricSummaries = computed(() => buildMetricSummaries(store.weather));
const chartModel = computed(() => buildWeatherChartModel(store.weather, selectedMode.value));
const activeReadout = computed(() => selectedReadout.value ?? chartModel.value.currentReadout);
const noticeRows = computed(() => store.weather?.notices ?? []);
const scaleSourceLabel = computed(() => {
  const current = store.weather?.scales?.current;
  const values = [current?.r.source, current?.s.source, current?.g.source].filter(Boolean);
  return values.includes('DERIVED') ? 'NOAA-derived fallback' : 'NOAA SWPC direct';
});

watch(
  chartModel,
  async (model) => {
    selectedReadout.value = model.currentReadout;
    await nextTick();
    renderChart();
    applyRange(selectedRange.value);
  },
  { immediate: false },
);

onMounted(async () => {
  await nextTick();
  if (!chartEl.value) return;
  chart.value = init(chartEl.value, undefined, { renderer: 'canvas' });
  attachChartHandlers();
  renderChart();
  applyRange(selectedRange.value);
  resizeObserver = new ResizeObserver(() => chart.value?.resize());
  resizeObserver.observe(chartEl.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  chart.value?.dispose();
  chart.value = null;
});

function selectMetric(mode: WeatherChartMode) {
  selectedMode.value = mode;
}

function selectRange(key: '6h' | '24h' | '3d' | 'all') {
  selectedRange.value = key;
  applyRange(key);
}

function resetChartView() {
  selectedRange.value = 'all';
  selectedReadout.value = chartModel.value.currentReadout;
  applyRange('all');
}

function renderChart() {
  const instance = chart.value;
  if (!instance) return;
  const model = chartModel.value;
  instance.setOption(buildChartOption(model), { notMerge: true, lazyUpdate: false });
}

function attachChartHandlers() {
  const instance = chart.value;
  if (!instance) return;
  instance.getZr().on('click', (event: { offsetX: number; offsetY: number }) => {
    const point: [number, number] = [event.offsetX, event.offsetY];
    if (!instance.containPixel({ gridIndex: 0 }, point)) return;
    const converted = instance.convertFromPixel({ xAxisIndex: 0 }, point);
    const timeValue = Array.isArray(converted) ? Number(converted[0]) : Number(converted);
    const readout = findNearestReadout(chartModel.value, timeValue);
    if (readout) selectedReadout.value = readout;
  });
}

function applyRange(key: '6h' | '24h' | '3d' | 'all') {
  const instance = chart.value;
  const extent = chartModel.value.extent;
  if (!instance || !extent) return;
  const preset = WEATHER_RANGE_PRESETS.find((item) => item.key === key);
  const now = Date.now();
  const anchor = key === 'all' ? extent.end : Math.min(Math.max(now, extent.start), extent.end);
  const end = key === 'all' ? extent.end : anchor;
  const start = preset?.durationMs ? Math.max(extent.start, end - preset.durationMs) : extent.start;
  instance.dispatchAction({
    type: 'dataZoom',
    dataZoomIndex: 0,
    startValue: new Date(start).toISOString(),
    endValue: new Date(end).toISOString(),
  });
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
    series: model.series.map((series) => ({
      name: series.name,
      type: 'line',
      yAxisIndex: series.axisIndex,
      step: series.stepped ? 'end' : false,
      showSymbol: false,
      symbol: 'circle',
      symbolSize: 7,
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
        width: series.stepped ? 2.5 : 3,
      },
      areaStyle: series.stepped ? undefined : { opacity: 0.08 },
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
              width: 1.2,
              type: 'dashed',
            },
          })),
      },
    })),
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
</script>

<template>
  <div class="page-stack">
    <PanelCard title="NOAA Space Weather Explorer" subtitle="Kp / G / S / R">
      <template #actions>
        <span class="source-chip source-chip--info panel-card__action-link">{{ scaleSourceLabel }}</span>
        <OriginBadge :origin="store.weather?.origin ?? 'OSINT'" :timestamp="store.weather?.fetchedAt" :stale="store.weather?.stale" />
      </template>

      <div class="weather-explorer">
        <div class="weather-metric-strip" aria-label="Space weather metrics">
          <button
            v-for="metric in metricSummaries"
            :key="metric.key"
            type="button"
            class="weather-metric-pill"
            :class="[`weather-tone--${metric.tone}`, { 'weather-metric-pill--active': selectedMode === metric.mode }]"
            :aria-pressed="selectedMode === metric.mode"
            @click="selectMetric(metric.mode)"
          >
            <span>
              <small>{{ metric.label }}</small>
              <strong>{{ metric.value }}</strong>
            </span>
            <span>
              <em>{{ metric.detail }}</em>
              <small>{{ metric.sourceLabel }} · {{ formatTimestamp(metric.observedAt) }}</small>
            </span>
          </button>
        </div>

        <section class="weather-chart-panel">
          <header class="weather-chart-panel__header">
            <div>
              <p>{{ chartModel.subtitle }}</p>
              <h2>{{ chartModel.title }}</h2>
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

          <div class="weather-echart-shell">
            <div ref="chartEl" class="weather-echart" :aria-label="`${chartModel.title} dynamic time-series chart`" />
            <p v-if="!chartModel.extent" class="weather-echart-empty">{{ chartModel.emptyText }}</p>
          </div>

          <footer class="weather-readout" aria-live="polite">
            <div>
              <small>Selected time</small>
              <strong>{{ activeReadout ? formatTimestamp(activeReadout.t) : '데이터 없음' }}</strong>
            </div>
            <div v-for="row in activeReadout?.rows ?? []" :key="row.name">
              <small>{{ row.name }} · {{ row.sourceLabel }}</small>
              <strong>{{ row.value }}</strong>
              <span>{{ row.detail }}</span>
            </div>
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
