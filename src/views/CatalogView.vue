<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import CatalogCard from '@/components/CatalogCard.vue';
import LoadingState from '@/components/LoadingState.vue';
import PanelCard from '@/components/PanelCard.vue';
import OriginBadge from '@/components/OriginBadge.vue';
import { useAppStore } from '@/stores/app';
import { formatNumber } from '@/lib/format';
import { useViewport } from '@/composables/useViewport';
import type { CatalogEntry } from '@/domain/types';

const store = useAppStore();
const viewport = useViewport();
const search = ref('');
const group = ref('all');
const orbitBand = ref('all');
const status = ref('all');
const owner = ref('all');
const visibleLimit = ref(200);

const groups = computed(() => ['all', ...new Set(store.catalog.map((entry) => entry.group))]);
const isMobileViewport = computed(() => viewport.breakpoint.value === 'xs' || viewport.breakpoint.value === 'sm');
const pageSize = computed(() => (isMobileViewport.value ? 60 : 200));
const owners = computed(() => ['all', ...uniqueSorted(store.catalog.map((entry) => entry.satcat.ownerCountry))]);
const statuses = computed(() => ['all', ...uniqueSorted(store.catalog.map((entry) => entry.satcat.opsStatusCode))]);

const filtered = computed(() =>
  store.catalog.filter((entry) => {
    const query = search.value.trim().toLowerCase();
    const matchesQuery =
      !query ||
      entry.satcat.objectName.toLowerCase().includes(query) ||
      entry.satcat.objectId.toLowerCase().includes(query) ||
      entry.satcat.catalogNumber.toString().includes(query) ||
      entry.satcat.ownerCountry.toLowerCase().includes(query);
    const matchesGroup = group.value === 'all' || entry.group === group.value;
    const matchesOwner = owner.value === 'all' || entry.satcat.ownerCountry === owner.value;
    const matchesStatus = status.value === 'all' || entry.satcat.opsStatusCode === status.value;
    const matchesOrbit =
      orbitBand.value === 'all' ||
      classifyOrbit(entry.satcat.apogeeKm ?? 0) === orbitBand.value;
    return matchesQuery && matchesGroup && matchesOwner && matchesStatus && matchesOrbit;
  }),
);

const visibleEntries = computed(() => filtered.value.slice(0, visibleLimit.value));
const hasMore = computed(() => visibleEntries.value.length < filtered.value.length);
const selectedFleetName = computed(() => store.selectedFleet?.name ?? 'No fleet selected');
const catalogLoading = computed(() => store.loading && !store.catalog.length);

watch(pageSize, (size) => {
  visibleLimit.value = size;
}, { immediate: true });

watch([search, group, orbitBand, status, owner], () => {
  visibleLimit.value = pageSize.value;
});

function classifyOrbit(apogeeKm: number) {
  if (apogeeKm < 2000) return 'LEO';
  if (apogeeKm < 30000) return 'MEO';
  return 'GEO';
}

function showMore() {
  visibleLimit.value += pageSize.value;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function isTracked(entry: { satcat: { catalogNumber: number } }) {
  return store.selectedFleetCatalogNumbers.includes(entry.satcat.catalogNumber);
}

async function toggleTracking(entry: CatalogEntry) {
  if (isTracked(entry)) {
    await store.removeFleetMember({
      refType: 'catalog',
      catalogNumber: entry.satcat.catalogNumber,
      displayName: entry.satcat.objectName,
      tags: [],
    });
    return;
  }
  await store.addCatalogToFleet(entry);
}
</script>

<template>
  <div class="page-stack">
    <PanelCard title="Catalog Browser" subtitle="F-MUST-01">
      <template #actions>
        <OriginBadge origin="OSINT" :timestamp="store.catalog[0]?.fetchedAt" />
        <RouterLink class="button button--ghost panel-card__action-link" to="/briefing">Briefing 보기</RouterLink>
      </template>
      <div class="toolbar">
        <input v-model="search" class="input" type="search" placeholder="이름 · INTDES · NORAD 검색" />
        <select v-model="group" class="input">
          <option v-for="item in groups" :key="item" :value="item">{{ item }}</option>
        </select>
        <select v-model="orbitBand" class="input">
          <option value="all">All orbits</option>
          <option value="LEO">LEO</option>
          <option value="MEO">MEO</option>
          <option value="GEO">GEO</option>
        </select>
        <select v-model="status" class="input">
          <option value="all">All status</option>
          <option v-for="item in statuses.filter((item) => item !== 'all')" :key="item" :value="item">{{ item }}</option>
        </select>
        <select v-model="owner" class="input">
          <option v-for="item in owners" :key="item" :value="item">{{ item }}</option>
        </select>
      </div>
      <p v-if="catalogLoading" class="supporting-text">
        CelesTrak active catalog를 불러오는 중입니다. 네트워크 상태에 따라 몇 초 정도 걸릴 수 있습니다.
      </p>
      <p v-else class="supporting-text">
        {{ formatNumber(store.catalog.length) }} indexed · {{ formatNumber(filtered.length) }} matched ·
        {{ formatNumber(visibleEntries.length) }} visible. 현재 선택 플릿: {{ selectedFleetName }}.
      </p>
    </PanelCard>

    <LoadingState
      v-if="catalogLoading"
      title="Catalog 데이터 불러오는 중"
      :message="store.loadingMessage"
      variant="inline"
    />

    <template v-else>
      <div v-if="isMobileViewport" class="catalog-grid">
        <CatalogCard
          v-for="entry in visibleEntries"
          :key="entry.satcat.catalogNumber"
          :entry="entry"
          :tracked="isTracked(entry)"
          @toggle="toggleTracking"
        />
      </div>

      <PanelCard v-else title="Catalog Table" subtitle="Adaptive Table">
        <div class="catalog-table">
          <header class="catalog-table__row catalog-table__row--header">
            <span>Name</span>
            <span>NORAD</span>
            <span>Group</span>
            <span>Apogee</span>
            <span>Period</span>
            <span />
          </header>
          <article v-for="entry in visibleEntries" :key="entry.satcat.catalogNumber" class="catalog-table__row">
            <strong>{{ entry.satcat.objectName }}</strong>
            <span>{{ entry.satcat.catalogNumber }}</span>
            <span>{{ entry.group }}</span>
            <span>{{ formatNumber(entry.satcat.apogeeKm) }} km</span>
            <span>{{ formatNumber(entry.satcat.periodMinutes) }} min</span>
            <button
              class="button button--ghost"
              :class="{ 'button--selected': isTracked(entry) }"
              @click="toggleTracking(entry)"
            >
              {{ isTracked(entry) ? 'Tracking' : 'Track' }}
            </button>
          </article>
        </div>
      </PanelCard>
    </template>

    <div v-if="!catalogLoading && hasMore" class="load-more-row">
      <button class="button button--ghost" type="button" @click="showMore">
        더 보기 · {{ formatNumber(filtered.length - visibleEntries.length) }} remaining
      </button>
    </div>
  </div>
</template>
