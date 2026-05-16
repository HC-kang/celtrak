<script setup lang="ts">
import { computed } from 'vue';
import type { PassPrediction } from '@/domain/types';
import { formatTimestamp } from '@/lib/format';

interface CalendarPass extends PassPrediction {
  laneIndex: number;
}

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
  return [...map.entries()].map(([stationId, entries]) => {
    const passes = assignPassLanes(entries.sort((a, b) => a.aos.localeCompare(b.aos)));
    return {
      stationId,
      label: stationLabel(stationId),
      laneCount: Math.max(...passes.map((pass) => pass.laneIndex + 1), 1),
      passes,
    };
  });
});

const hours = computed(() =>
  Array.from({ length: 24 }).map((_, index) => {
    const point = new Date(start.value.getTime() + index * 60 * 60 * 1000);
    return `${String(point.getHours()).padStart(2, '0')}:00`;
  }),
);

function position(pass: CalendarPass) {
  const total = end.value.getTime() - start.value.getTime();
  const startOffset = new Date(pass.aos).getTime() - start.value.getTime();
  const endOffset = new Date(pass.los).getTime() - start.value.getTime();
  return {
    left: `${Math.max(0, (startOffset / total) * 100)}%`,
    width: `${Math.max(3, ((endOffset - startOffset) / total) * 100)}%`,
    top: `${8 + pass.laneIndex * 38}px`,
  };
}

function assignPassLanes(entries: PassPrediction[]): CalendarPass[] {
  const laneEnds: number[] = [];
  return entries.map((pass) => {
    const aos = new Date(pass.aos).getTime();
    const los = new Date(pass.los).getTime();
    const laneIndex = laneEnds.findIndex((endTime) => aos >= endTime + 5 * 60 * 1000);
    const targetLane = laneIndex === -1 ? laneEnds.length : laneIndex;
    laneEnds[targetLane] = los;
    return { ...pass, laneIndex: targetLane };
  });
}

function stationLabel(stationId: string) {
  const label = props.stationLookup[stationId];
  if (label) return label;
  return `Unknown station ${stationId.slice(0, 8)}`;
}
</script>

<template>
  <div class="pass-calendar">
    <div v-if="rows.length" class="pass-calendar__viewport">
      <div class="pass-calendar__grid">
        <div class="pass-calendar__scale">
          <span />
          <span v-for="hour in hours" :key="hour">{{ hour }}</span>
        </div>
        <div v-for="row in rows" :key="row.stationId" class="pass-calendar__row">
          <div class="pass-calendar__label" :title="row.stationId">
            <strong>{{ row.label }}</strong>
          </div>
          <div class="pass-calendar__lane" :style="{ '--lane-count': row.laneCount }">
            <article
              v-for="pass in row.passes"
              :key="`${row.stationId}-${pass.aos}-${pass.los}`"
              class="pass-calendar__block"
              :style="position(pass)"
              :title="`${formatTimestamp(pass.aos)} -> ${formatTimestamp(pass.los)}`"
            >
              <span>{{ pass.maxElevationDeg.toFixed(0) }}°</span>
            </article>
          </div>
        </div>
      </div>
    </div>
    <p v-if="!rows.length" class="empty-state">현재 24시간 패스가 없습니다.</p>
  </div>
</template>
