<script setup lang="ts">
import type { CatalogEntry } from '@/domain/types';
import OriginBadge from '@/components/OriginBadge.vue';
import { formatNumber } from '@/lib/format';

defineProps<{
  entry: CatalogEntry;
  tracked?: boolean;
}>();

const emit = defineEmits<{
  toggle: [entry: CatalogEntry];
}>();
</script>

<template>
  <article class="catalog-card">
    <div class="catalog-card__header">
      <div>
        <h3>{{ entry.satcat.objectName }}</h3>
        <p>NORAD {{ entry.satcat.catalogNumber }} · {{ entry.satcat.objectId }}</p>
      </div>
      <OriginBadge :origin="entry.origin" :timestamp="entry.fetchedAt" :stale="entry.stale" />
    </div>
    <div class="catalog-card__facts">
      <span>{{ entry.group }}</span>
      <span>{{ entry.satcat.ownerCountry }}</span>
      <span>{{ formatNumber(entry.satcat.apogeeKm) }} km apo</span>
      <span>{{ formatNumber(entry.satcat.periodMinutes) }} min</span>
    </div>
    <button class="button button--ghost" :class="{ 'button--selected': tracked }" @click="emit('toggle', entry)">
      {{ tracked ? 'Tracking in Briefing' : 'Track in Briefing' }}
    </button>
  </article>
</template>
