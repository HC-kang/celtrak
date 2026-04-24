<script setup lang="ts">
import type { ScheduledEvent } from '@/domain/types';
import { formatRelative, formatTimestamp, truncate } from '@/lib/format';

defineProps<{
  events: ScheduledEvent[];
  satelliteLookup?: Record<string, string>;
}>();

const emit = defineEmits<{
  remove: [id: string];
}>();

function eventKey(event: ScheduledEvent) {
  if (!event.satelliteRef) return 'fleet';
  return event.satelliteRef.refType === 'catalog'
    ? `catalog:${event.satelliteRef.catalogNumber}`
    : `custom:${event.satelliteRef.customTleId}`;
}
</script>

<template>
  <div class="event-timeline">
    <article v-for="event in events" :key="event.id" class="event-timeline__item">
      <div>
        <strong>{{ event.title }}</strong>
        <p>{{ event.kind }} · {{ satelliteLookup?.[eventKey(event)] ?? 'Fleet-wide' }}</p>
        <p class="supporting-text">{{ truncate(event.notes ?? '', 96) }}</p>
      </div>
      <div class="event-timeline__meta">
        <small>{{ formatTimestamp(event.startAt) }}</small>
        <small>{{ formatRelative(event.startAt) }}</small>
        <button class="button button--ghost" @click="emit('remove', event.id)">삭제</button>
      </div>
    </article>
    <p v-if="!events.length" class="empty-state">예정된 사용자 이벤트가 없습니다.</p>
  </div>
</template>
