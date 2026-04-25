<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import PanelCard from '@/components/PanelCard.vue';
import OriginBadge from '@/components/OriginBadge.vue';
import { useAppStore } from '@/stores/app';
import { formatTimestamp } from '@/lib/format';
import {
  createUserElevationMaskSource,
  elevationMaskSourceDetail,
  elevationMaskSourceLabel,
  withUserElevationMaskSource,
} from '@/lib/groundStationElevation';
import type { CatalogEntry, GroundStation } from '@/domain/types';
import type {
  VisibleSatelliteCandidate,
  VisibleSatelliteResult,
  VisibleSatellitesWorkerResult,
} from '@/lib/visibleSatellites';

const store = useAppStore();
const selectedStationId = ref(store.preferences.defaultGroundStationId ?? store.groundStations[0]?.id ?? '');
const visibleResults = ref<VisibleSatelliteResult[]>([]);
const visibleLoading = ref(false);
const visibleError = ref('');
const visibleComputedAt = ref('');
let worker: Worker | null = null;
let activeRequestId = 0;

const stationForm = reactive({
  name: '',
  latDeg: '37.5665',
  lonDeg: '126.9780',
  altitudeM: '38',
  elevationMaskDeg: '10',
});

const selectedStation = computed(() => store.groundStations.find((station) => station.id === selectedStationId.value) ?? null);
const enabledStationCount = computed(() => store.groundStations.filter((station) => station.enabled).length);
const visibleCatalogCount = computed(() => store.catalog.filter((entry) => entry.tle).length);
const trackedCatalogNumbers = computed(
  () =>
    new Set(
      (store.selectedFleet?.memberRefs ?? [])
        .filter((member) => member.refType === 'catalog' && member.catalogNumber)
        .map((member) => member.catalogNumber as number),
    ),
);

watch(
  () => store.groundStations.map((station) => station.id).join(','),
  () => {
    if (!selectedStationId.value || !store.groundStations.some((station) => station.id === selectedStationId.value)) {
      selectedStationId.value = store.preferences.defaultGroundStationId ?? store.groundStations[0]?.id ?? '';
    }
  },
  { immediate: true },
);

watch(selectedStationId, () => {
  visibleResults.value = [];
  visibleError.value = '';
  visibleComputedAt.value = '';
});

onBeforeUnmount(() => {
  worker?.terminate();
});

async function addGroundStation() {
  if (!stationForm.name.trim()) return;
  await store.upsertGroundStation({
    id: crypto.randomUUID(),
    name: stationForm.name.trim(),
    latDeg: Number(stationForm.latDeg),
    lonDeg: Number(stationForm.lonDeg),
    altitudeM: Number(stationForm.altitudeM),
    elevationMaskDeg: clampElevation(Number(stationForm.elevationMaskDeg)),
    elevationMaskSource: createUserElevationMaskSource(),
    enabled: true,
    schemaVersion: 1,
  });
  stationForm.name = '';
}

async function useCurrentLocation() {
  if (!navigator.geolocation) return;
  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject);
  });
  stationForm.latDeg = position.coords.latitude.toFixed(4);
  stationForm.lonDeg = position.coords.longitude.toFixed(4);
  stationForm.altitudeM = Math.round(position.coords.altitude ?? 0).toString();
}

function setAllGroundStations(enabled: boolean) {
  void Promise.all(
    store.groundStations
      .filter((station) => station.enabled !== enabled)
      .map((station) => store.toggleGroundStation(station.id, enabled)),
  );
}

function updateStationMask(station: GroundStation, value: string) {
  const elevationMaskDeg = clampElevation(Number(value));
  void store.upsertGroundStation(withUserElevationMaskSource({ ...station, elevationMaskDeg }));
}

async function scanVisibleSatellites() {
  const station = selectedStation.value;
  if (!station) return;
  visibleLoading.value = true;
  visibleError.value = '';
  try {
    await store.loadCatalogIndex();
    const satellites = store.catalog.map(toVisibleCandidate).filter((item): item is VisibleSatelliteCandidate => Boolean(item));
    if (!satellites.length) {
      visibleResults.value = [];
      visibleError.value = 'TLE가 있는 catalog 항목이 없습니다.';
      return;
    }
    const requestId = activeRequestId + 1;
    activeRequestId = requestId;
    getWorker().postMessage({
      requestId,
      station: cloneStation(station),
      satellites,
      timestampIso: new Date().toISOString(),
      limit: 500,
    });
  } catch (error) {
    visibleError.value = error instanceof Error ? error.message : '관측 가능 위성을 계산하지 못했습니다.';
    visibleLoading.value = false;
  }
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/visibleSatellites.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<VisibleSatellitesWorkerResult>) => {
    if (event.data.requestId !== activeRequestId) return;
    visibleResults.value = event.data.visible;
    visibleComputedAt.value = new Date().toISOString();
    visibleLoading.value = false;
  };
  worker.onerror = () => {
    visibleError.value = '관측 가능 위성 계산 워커가 중단되었습니다.';
    visibleLoading.value = false;
  };
  return worker;
}

function toVisibleCandidate(entry: CatalogEntry): VisibleSatelliteCandidate | null {
  if (!entry.tle) return null;
  return {
    catalogNumber: entry.satcat.catalogNumber,
    name: entry.satcat.objectName,
    group: entry.group,
    ownerCountry: entry.satcat.ownerCountry,
    tle: { ...entry.tle },
  };
}

function cloneStation(station: GroundStation): GroundStation {
  return {
    id: station.id,
    name: station.name,
    latDeg: station.latDeg,
    lonDeg: station.lonDeg,
    altitudeM: station.altitudeM,
    elevationMaskDeg: station.elevationMaskDeg,
    elevationMaskSource: station.elevationMaskSource ? { ...station.elevationMaskSource } : undefined,
    enabled: station.enabled,
    schemaVersion: station.schemaVersion,
  };
}

function catalogEntryFor(catalogNumber: number) {
  return store.catalog.find((entry) => entry.satcat.catalogNumber === catalogNumber);
}

function trackVisibleSatellite(item: VisibleSatelliteResult) {
  const entry = catalogEntryFor(item.catalogNumber);
  if (entry) {
    void store.addCatalogToFleet(entry);
  }
}

function clampElevation(value: number) {
  if (!Number.isFinite(value)) return 10;
  return Math.min(Math.max(value, 0), 90);
}
</script>

<template>
  <div class="page-stack station-ops">
    <PanelCard title="Ground Station Control" subtitle="Visibility masks and selected sites">
      <template #actions>
        <button class="button button--ghost panel-card__action-link" type="button" @click="setAllGroundStations(true)">모두선택</button>
        <button class="button button--ghost panel-card__action-link" type="button" @click="setAllGroundStations(false)">모두해제</button>
      </template>

      <div class="station-ops__summary">
        <article>
          <span>Enabled</span>
          <strong>{{ enabledStationCount }}/{{ store.groundStations.length }}</strong>
        </article>
        <article>
          <span>Default</span>
          <strong>{{ store.defaultGroundStation?.name ?? '—' }}</strong>
        </article>
        <article>
          <span>Catalog TLE</span>
          <strong>{{ visibleCatalogCount.toLocaleString() }}</strong>
        </article>
      </div>

      <div class="station-ops__list">
        <article
          v-for="station in store.groundStations"
          :key="station.id"
          class="station-ops__row"
          :class="{ 'station-ops__row--selected': station.id === selectedStationId }"
        >
          <label class="station-ops__select">
            <input v-model="selectedStationId" :value="station.id" type="radio" name="selected-ground-station" />
            <span>
              <strong>{{ station.name }}</strong>
              <small>{{ station.latDeg.toFixed(4) }}, {{ station.lonDeg.toFixed(4) }} · {{ station.altitudeM.toLocaleString() }} m</small>
            </span>
          </label>
          <div class="station-ops__row-controls">
            <label class="setting-toggle setting-toggle--compact">
              <span>기본</span>
              <input
                :checked="store.preferences.defaultGroundStationId === station.id"
                type="radio"
                name="default-ground-station"
                @change="store.setDefaultGroundStation(station.id)"
              />
            </label>
            <label class="setting-toggle setting-toggle--compact">
              <span>활성</span>
              <input
                :checked="station.enabled"
                type="checkbox"
                @change="store.toggleGroundStation(station.id, ($event.target as HTMLInputElement).checked)"
              />
            </label>
            <a
              v-if="station.elevationMaskSource?.url"
              class="station-ops__source-badge"
              :href="station.elevationMaskSource.url"
              target="_blank"
              rel="noreferrer"
              :title="elevationMaskSourceDetail(station.elevationMaskSource)"
            >
              {{ elevationMaskSourceLabel(station.elevationMaskSource) }}
            </a>
            <span v-else class="station-ops__source-badge" :title="elevationMaskSourceDetail(station.elevationMaskSource)">
              {{ elevationMaskSourceLabel(station.elevationMaskSource) }}
            </span>
            <label class="station-ops__mask">
              <span>Elevation</span>
              <input
                class="input"
                type="number"
                min="0"
                max="90"
                step="1"
                :value="station.elevationMaskDeg"
                @change="updateStationMask(station, ($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>
        </article>
      </div>
    </PanelCard>

    <PanelCard title="Visible Satellites" subtitle="Current station look-angle scan">
      <template #actions>
        <strong v-if="visibleResults.length" class="panel-card__action-link">{{ visibleResults.length.toLocaleString() }} visible</strong>
        <OriginBadge v-if="visibleComputedAt" origin="DERIVED" :timestamp="visibleComputedAt" />
      </template>
      <div class="station-ops__scanner">
        <div>
          <label class="field-label" for="visible-station">Station</label>
          <select id="visible-station" v-model="selectedStationId" class="input">
            <option v-for="station in store.groundStations" :key="station.id" :value="station.id">
              {{ station.name }} · {{ station.elevationMaskDeg }}° · {{ elevationMaskSourceLabel(station.elevationMaskSource) }}
            </option>
          </select>
        </div>
        <button class="button" type="button" :disabled="visibleLoading || !selectedStation" @click="scanVisibleSatellites()">
          {{ visibleLoading ? '계산 중' : '관측 가능 위성 가져오기' }}
        </button>
        <RouterLink class="button button--ghost" to="/briefing">Briefing 보기</RouterLink>
      </div>
      <p class="supporting-text">
        현재 시간 {{ formatTimestamp(new Date().toISOString()) }} 기준으로 catalog TLE 전체를 훑고,
        선택 지상국의 elevation mask 이상인 위성을 elevation 높은 순으로 보여줍니다.
      </p>
      <p v-if="store.catalogIndexLoading" class="supporting-text">전체 active catalog를 불러오는 중입니다.</p>
      <p v-if="visibleError" class="supporting-text">{{ visibleError }}</p>

      <div class="table-like station-ops__visible-table">
        <article v-if="!visibleLoading && !visibleResults.length" class="table-like__row table-like__row--muted">
          <div>
            <strong>결과 없음</strong>
            <p>지상국을 선택한 뒤 현재 관측 가능한 위성을 계산하세요.</p>
          </div>
        </article>
        <article v-for="item in visibleResults" :key="item.catalogNumber" class="table-like__row">
          <div>
            <strong>{{ item.name }}</strong>
            <p>
              NORAD {{ item.catalogNumber }} · {{ item.group }} · el {{ item.elevationDeg.toFixed(1) }}° ·
              az {{ item.azimuthDeg.toFixed(0) }}°
            </p>
          </div>
          <div class="inline-actions">
            <span class="station-ops__owner">{{ item.ownerCountry }}</span>
            <button
              class="button button--ghost"
              type="button"
              :disabled="trackedCatalogNumbers.has(item.catalogNumber)"
              @click="trackVisibleSatellite(item)"
            >
              {{ trackedCatalogNumbers.has(item.catalogNumber) ? 'Tracking' : 'Track' }}
            </button>
          </div>
        </article>
      </div>
    </PanelCard>

    <PanelCard title="Add Ground Station" subtitle="User-defined station override">
      <div class="form-grid">
        <input v-model="stationForm.name" class="input" type="text" placeholder="지상국 이름" />
        <input v-model="stationForm.latDeg" class="input" type="number" step="0.0001" placeholder="위도" />
        <input v-model="stationForm.lonDeg" class="input" type="number" step="0.0001" placeholder="경도" />
        <input v-model="stationForm.altitudeM" class="input" type="number" step="1" placeholder="고도(m)" />
        <input v-model="stationForm.elevationMaskDeg" class="input" type="number" step="1" placeholder="마스크 각도" />
        <button class="button" type="button" @click="addGroundStation()">추가</button>
        <button class="button button--ghost" type="button" @click="useCurrentLocation()">현재 위치 불러오기</button>
      </div>
    </PanelCard>
  </div>
</template>
