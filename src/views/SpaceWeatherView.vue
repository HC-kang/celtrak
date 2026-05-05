<script setup lang="ts">
import { computed } from 'vue';
import PanelCard from '@/components/PanelCard.vue';
import MetricCard from '@/components/MetricCard.vue';
import OriginBadge from '@/components/OriginBadge.vue';
import { useAppStore } from '@/stores/app';
import { formatTimestamp } from '@/lib/format';

const store = useAppStore();

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
</script>

<template>
  <div class="page-stack">
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
        <MetricCard label="Current Kp" :value="`${store.weather?.kp.current ?? '—'}`" tone="warn" />
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
