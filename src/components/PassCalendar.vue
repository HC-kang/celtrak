<script setup lang="ts">
import { computed } from 'vue';
import type { PassPrediction } from '@/domain/types';
import { formatTimestamp } from '@/lib/format';

const props = defineProps<{
  passes: PassPrediction[];
  stationLookup: Record<string, string>;
  startTimeIso?: string | null;
}>();

const start = computed(() => new Date(props.startTimeIso ?? new Date().toISOString()));
const end = computed(() => new Date(start.value.getTime() + 24 * 60 * 60 * 1000));
const rows = computed(() => {
  const map = new Map<string, PassPrediction[]>();
  for (const pass of props.passes) {
    if (!map.has(pass.groundStationId)) {
      map.set(pass.groundStationId, []);
    }
    map.get(pass.groundStationId)!.push(pass);
  }
  return [...map.entries()].map(([stationId, entries]) => ({
    stationId,
    label: props.stationLookup[stationId] ?? stationId,
    passes: entries.sort((a, b) => a.aos.localeCompare(b.aos)),
  }));
});

const hours = computed(() =>
  Array.from({ length: 24 }).map((_, index) => {
    const point = new Date(start.value.getTime() + index * 60 * 60 * 1000);
    return `${String(point.getHours()).padStart(2, '0')}:00`;
  }),
);

function position(pass: PassPrediction) {
  const total = end.value.getTime() - start.value.getTime();
  const startOffset = new Date(pass.aos).getTime() - start.value.getTime();
  const endOffset = new Date(pass.los).getTime() - start.value.getTime();
  return {
    left: `${Math.max(0, (startOffset / total) * 100)}%`,
    width: `${Math.max(3, ((endOffset - startOffset) / total) * 100)}%`,
  };
}
</script>

<template>
  <div class="pass-calendar">
    <div class="pass-calendar__scale">
      <span />
      <span v-for="hour in hours" :key="hour">{{ hour }}</span>
    </div>
    <div v-for="row in rows" :key="row.stationId" class="pass-calendar__row">
      <div class="pass-calendar__label">
        <strong>{{ row.label }}</strong>
      </div>
      <div class="pass-calendar__lane">
        <article
          v-for="pass in row.passes"
          :key="`${row.stationId}-${pass.aos}`"
          class="pass-calendar__block"
          :style="position(pass)"
          :title="`${formatTimestamp(pass.aos)} → ${formatTimestamp(pass.los)}`"
        >
          <span>{{ pass.maxElevationDeg.toFixed(0) }}°</span>
        </article>
      </div>
    </div>
    <p v-if="!rows.length" class="empty-state">현재 24시간 패스가 없습니다.</p>
  </div>
</template>
