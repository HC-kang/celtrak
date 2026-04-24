<script setup lang="ts">
import { computed } from 'vue';
import { getOriginBadge } from '@/domain/origin';
import { formatTimestamp } from '@/lib/format';
import type { DataOrigin } from '@/domain/types';

const props = defineProps<{
  origin: DataOrigin;
  timestamp?: string;
  stale?: boolean;
}>();

const meta = computed(() => getOriginBadge(props.stale ? 'STALE' : props.origin));
</script>

<template>
  <div class="origin-badge" :class="[meta.className, timestamp ? 'origin-badge--with-time' : 'origin-badge--compact']">
    <span class="origin-badge__mark" aria-hidden="true">{{ meta.icon }}</span>
    <span class="origin-badge__label">{{ meta.label }}</span>
    <time v-if="timestamp" class="origin-badge__time" :datetime="timestamp">{{ formatTimestamp(timestamp) }}</time>
  </div>
</template>
