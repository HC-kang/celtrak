<script setup lang="ts">
import type { PassPrediction } from '@/domain/types';
import { formatRelative, formatTimestamp } from '@/lib/format';

defineProps<{
  passes: PassPrediction[];
  stationLookup: Record<string, string>;
}>();

function stationLabel(stationId: string, stationLookup: Record<string, string>) {
  return stationLookup[stationId] ?? `Unknown station ${stationId.slice(0, 8)}`;
}
</script>

<template>
  <div class="pass-list">
    <article v-for="pass in passes" :key="`${pass.groundStationId}-${pass.aos}`" class="pass-list__item">
      <div>
        <strong :title="pass.groundStationId">{{ stationLabel(pass.groundStationId, stationLookup) }}</strong>
        <p>{{ formatRelative(pass.aos) }} · 최대 {{ pass.maxElevationDeg.toFixed(0) }}°</p>
      </div>
      <small>{{ formatTimestamp(pass.tca) }}</small>
    </article>
    <p v-if="!passes.length" class="empty-state">활성 패스가 아직 계산되지 않았습니다.</p>
  </div>
</template>
