<script setup lang="ts">
import { computed } from 'vue';
import PanelCard from '@/components/PanelCard.vue';
import MetricCard from '@/components/MetricCard.vue';
import OriginBadge from '@/components/OriginBadge.vue';
import { useAppStore } from '@/stores/app';
import type { NoaaScaleSummary } from '@/domain/types';
import { formatTimestamp } from '@/lib/format';

const store = useAppStore();

type MetricTone = 'default' | 'good' | 'warn' | 'orange' | 'critical';

const xrayPoints = computed(() => {
  const series = store.weather?.xray.series ?? [];
  if (!series.length) return '';
  const values = series.map((item) => item.flux);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return series
    .map((item, index) => {
      const x = (index / Math.max(series.length - 1, 1)) * 100;
      const y = max === min ? 50 : 90 - ((item.flux - min) / (max - min)) * 70;
      return `${x},${y}`;
    })
    .join(' ');
});

const scaleCards = computed(() => {
  const current = store.weather?.scales?.current;
  const kp = store.weather?.kp.current ?? null;
  const r = current?.r;
  const s = current?.s;
  const g = current?.g;
  return [
    {
      label: 'Kp Disturbance',
      value: kp === null ? '—' : kp.toFixed(Number.isInteger(kp) ? 0 : 1),
      hint: `지자기교란 · ${store.weather?.kp.storm ?? '—'}`,
      tone: kpTone(kp),
    },
    {
      label: 'G Storm',
      value: scaleValue('G', g),
      hint: `지자기폭풍 · ${scaleText(g)}`,
      tone: scaleTone(g),
    },
    {
      label: 'S Radiation',
      value: scaleValue('S', s),
      hint: `태양복사폭풍 · ${protonFluxLabel()}`,
      tone: scaleTone(s),
    },
    {
      label: 'R / Ionosphere',
      value: scaleValue('R', r),
      hint: `전리층교란 · ${xrayClassLabel()}`,
      tone: scaleTone(r),
    },
  ] satisfies Array<{ label: string; value: string; hint: string; tone: MetricTone }>;
});

const scaleForecastRows = computed(() => store.weather?.scales?.forecast ?? []);
const scaleSourceLabel = computed(() => {
  const current = store.weather?.scales?.current;
  const values = [current?.r.source, current?.s.source, current?.g.source].filter(Boolean);
  return values.includes('DERIVED') ? 'Derived from SWPC feeds' : 'NOAA SWPC scales';
});

function scaleValue(kind: 'R' | 'S' | 'G', scale?: NoaaScaleSummary) {
  return scale?.label ?? `${kind}—`;
}

function scaleText(scale?: NoaaScaleSummary) {
  return scale?.text ?? '—';
}

function scaleTone(scale?: NoaaScaleSummary): MetricTone {
  const value = scale?.scale ?? 0;
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

function xrayClassLabel() {
  const xray = store.weather?.xray;
  if (!xray?.flareClass) return 'X-ray —';
  return `X-ray ${xray.flareClass}${xray.classMagnitude ?? ''}`;
}

function protonFluxLabel() {
  const proton = store.weather?.proton;
  if (proton?.currentPfu === null || proton?.currentPfu === undefined) return 'proton —';
  return `${proton.currentPfu.toFixed(proton.currentPfu >= 10 ? 1 : 2)} pfu`;
}

function scaleForecastText(item: { r?: NoaaScaleSummary; s?: NoaaScaleSummary; g?: NoaaScaleSummary }) {
  const rMinor = item.r?.minorProbabilityPct;
  const rMajor = item.r?.majorProbabilityPct;
  const sProb = item.s?.probabilityPct;
  const rText = rMinor !== null && rMinor !== undefined ? `R minor ${rMinor}%${rMajor ? ` / major ${rMajor}%` : ''}` : scaleValue('R', item.r);
  const sText = sProb !== null && sProb !== undefined ? `S ${sProb}%` : scaleValue('S', item.s);
  return `${rText} · ${sText} · ${scaleValue('G', item.g)}`;
}
</script>

<template>
  <div class="page-stack">
    <PanelCard title="NOAA Scale Overview" subtitle="Kp / G / S / R">
      <template #actions>
        <span class="source-chip source-chip--info panel-card__action-link">{{ scaleSourceLabel }}</span>
        <OriginBadge :origin="store.weather?.origin ?? 'OSINT'" :timestamp="store.weather?.fetchedAt" :stale="store.weather?.stale" />
      </template>
      <div class="space-weather-scale-grid">
        <MetricCard
          v-for="card in scaleCards"
          :key="card.label"
          :label="card.label"
          :value="card.value"
          :hint="card.hint"
          :tone="card.tone"
        />
      </div>
      <div v-if="scaleForecastRows.length" class="space-weather-forecast">
        <article v-for="item in scaleForecastRows" :key="item.t" class="stack-list__item stack-list__item--info">
          <div>
            <strong>{{ scaleForecastText(item) }}</strong>
            <p>{{ formatTimestamp(item.t) }}</p>
          </div>
          <small>NOAA scales forecast</small>
        </article>
      </div>
    </PanelCard>

    <PanelCard title="Solar X-ray" subtitle="F-MUST-09">
      <template #actions>
        <OriginBadge :origin="store.weather?.origin ?? 'OSINT'" :timestamp="store.weather?.fetchedAt" />
      </template>
      <div class="metric-grid">
        <MetricCard label="Flare Class" :value="`${store.weather?.xray.flareClass ?? '—'}${store.weather?.xray.classMagnitude ?? ''}`" />
        <MetricCard label="Current Flux" :value="`${store.weather?.xray.currentWm2?.toExponential(2) ?? '—'} W/m²`" />
      </div>
      <svg class="chart" viewBox="0 0 100 100" preserveAspectRatio="none">
        <rect width="100" height="100" rx="8" />
        <polyline :points="xrayPoints" />
      </svg>
    </PanelCard>

    <PanelCard title="Geomagnetic Kp" subtitle="Forecast">
      <div class="metric-grid">
        <MetricCard label="Current Kp" :value="`${store.weather?.kp.current ?? '—'}`" :tone="kpTone(store.weather?.kp.current ?? null)" />
        <MetricCard label="Storm Tier" :value="store.weather?.kp.storm ?? '—'" />
      </div>
      <div class="stack-list">
        <article v-for="item in store.weather?.kp.forecast ?? []" :key="item.t" class="stack-list__item">
          <div>
            <strong>{{ item.kp.toFixed(1) }}</strong>
            <p>{{ formatTimestamp(item.t) }}</p>
          </div>
          <small>Kp forecast</small>
        </article>
      </div>
    </PanelCard>

    <PanelCard title="Alerts & Notices" subtitle="NOAA feed">
      <div class="stack-list">
        <article v-for="notice in store.weather?.notices ?? []" :key="notice.issuedAt" class="stack-list__item">
          <div>
            <strong>{{ notice.type }}</strong>
            <p>{{ notice.text }}</p>
          </div>
          <small>{{ formatTimestamp(notice.issuedAt) }}</small>
        </article>
      </div>
    </PanelCard>
  </div>
</template>
