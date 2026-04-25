<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import PanelCard from '@/components/PanelCard.vue';
import MetricCard from '@/components/MetricCard.vue';
import OriginBadge from '@/components/OriginBadge.vue';
import PassList from '@/components/PassList.vue';
import OrbitMap2D from '@/components/OrbitMap2D.vue';
import SimulationControls from '@/components/SimulationControls.vue';
import EventTimeline from '@/components/EventTimeline.vue';
import { useAppStore } from '@/stores/app';
import { useViewport } from '@/composables/useViewport';
import { formatPercent, formatRelative, formatTimestamp, truncate } from '@/lib/format';
import { usePassPredictions } from '@/composables/usePassPredictions';
import type { FleetMemberRef } from '@/domain/types';

const OrbitGlobe3D = defineAsyncComponent(() => import('@/components/OrbitGlobe3D.vue'));
const store = useAppStore();
const viewport = useViewport();
const livePlaybackRate = ref(1);
const liveWallClockAnchor = ref(Date.now());
const liveOrbitAnchor = ref(Date.now());
const orbitClockTick = ref(Date.now());
const mapControlsOpen = ref(false);
const mapFocusMode = ref(false);
let orbitClockTimer: number | null = null;
usePassPredictions();

onMounted(() => {
  orbitClockTimer = window.setInterval(() => {
    orbitClockTick.value = Date.now();
  }, 250);
});

onUnmounted(() => {
  if (orbitClockTimer) {
    window.clearInterval(orbitClockTimer);
  }
});

const visibleFleetEntries = computed(() =>
  (store.selectedFleet?.memberRefs ?? [])
    .filter((member) => !store.isFleetMemberHidden(member))
    .map((member) => store.catalog.find((entry) => entry.satcat.catalogNumber === member.catalogNumber))
    .filter(Boolean),
);

const trackedObjects = computed(() =>
  (store.selectedFleet?.memberRefs ?? []).map((member) => {
    const key = refKey(member);
    if (member.refType === 'catalog') {
      const entry = store.catalog.find((item) => item.satcat.catalogNumber === member.catalogNumber);
      return {
        key,
        ref: member,
        name: member.displayName ?? entry?.satcat.objectName ?? `NORAD ${member.catalogNumber}`,
        detail: entry ? `NORAD ${entry.satcat.catalogNumber} · ${entry.group} · ${entry.satcat.ownerCountry}` : `NORAD ${member.catalogNumber} · catalog resolving`,
        source: 'SATCAT',
        hidden: store.isFleetMemberHidden(member),
      };
    }
    const custom = store.customTles.find((item) => item.id === member.customTleId);
    return {
      key,
      ref: member,
      name: member.displayName ?? custom?.name ?? 'Custom object',
      detail: `${custom?.format ?? 'CUSTOM'} · ${custom?.sourceLabel ?? 'user supplied elements'}`,
      source: 'USER TLE',
      hidden: store.isFleetMemberHidden(member),
    };
  }),
);

const stationLookup = computed(() =>
  Object.fromEntries(store.groundStations.map((station) => [station.id, station.name])),
);

const satelliteLookup = computed(() =>
  Object.fromEntries(
    (store.selectedFleet?.memberRefs ?? []).map((member) => {
      const key = member.refType === 'catalog' ? `catalog:${member.catalogNumber}` : `custom:${member.customTleId}`;
      const name =
        member.displayName ??
        store.catalog.find((entry) => entry.satcat.catalogNumber === member.catalogNumber)?.satcat.objectName ??
        store.customTles.find((entry) => entry.id === member.customTleId)?.name ??
        'Unknown';
      return [key, name];
    }),
  ),
);

const renderMode = computed(() => {
  if (store.preferences.dataSaver) return '2d';
  if (viewport.breakpoint.value === 'xs' || viewport.breakpoint.value === 'sm') return store.preferences.mobileRenderMode;
  if (viewport.breakpoint.value === 'md') return store.preferences.tabletRenderMode;
  return store.preferences.desktopRenderMode;
});

const isMobileViewport = computed(() => viewport.breakpoint.value === 'xs' || viewport.breakpoint.value === 'sm');
const mapPanelClasses = computed(() => ({
  'war-room__map-panel--controls-open': isMobileViewport.value && mapControlsOpen.value,
  'war-room__map-panel--focus': isMobileViewport.value && mapFocusMode.value,
}));
const showsMapControls = computed(() => !isMobileViewport.value || mapControlsOpen.value);

watch(isMobileViewport, (mobile) => {
  if (!mobile) {
    mapControlsOpen.value = false;
    mapFocusMode.value = false;
  }
});

const orbitMode = computed(() => (store.simulationTimeIso ? 'simulation' : 'live'));
const displayedOrbitTime = computed(() => {
  if (store.simulationTimeIso) return new Date(store.simulationTimeIso);
  const elapsedMs = orbitClockTick.value - liveWallClockAnchor.value;
  return new Date(liveOrbitAnchor.value + elapsedMs * livePlaybackRate.value);
});
const displayedOrbitTimeIso = computed(() => displayedOrbitTime.value.toISOString());

const warRoomStats = computed(() => [
  { label: 'Visible Tracks', value: `${visibleFleetEntries.value.length}/${trackedObjects.value.length}`, tone: 'good' },
  { label: 'Conjunctions', value: `${store.filteredConjunctions.length}`, tone: store.filteredConjunctions.length ? 'warn' : 'good' },
  { label: 'Kp Index', value: `${store.weather?.kp.current ?? '—'}`, tone: (store.weather?.kp.current ?? 0) >= 4 ? 'warn' : 'good' },
  { label: 'Open Anomalies', value: `${store.anomalies.length}`, tone: store.anomalies.length ? 'critical' : 'good' },
]);

const readinessCoverage = computed(() => {
  if (!store.fleetHealth.totalMembers) return null;
  return (store.fleetHealth.recordedMembers / store.fleetHealth.totalMembers) * 100;
});

const activeLayers = computed(() => [
  { label: 'OSM Base Map', detail: 'live raster tiles', active: true },
  { label: 'Fleet Tracks', detail: `${visibleFleetEntries.value.length}/${trackedObjects.value.length} visible`, active: visibleFleetEntries.value.length > 0 },
  { label: 'Ground Stations', detail: `${store.groundStations.filter((station) => station.enabled).length} online`, active: true },
  { label: 'Conjunction Risk', detail: `${store.filteredConjunctions.length} windows`, active: store.filteredConjunctions.length > 0 },
  { label: 'Space Weather', detail: store.weather?.kp.storm ?? (store.loading ? '불러오는 중' : '데이터 없음'), active: Boolean(store.weather) },
  { label: 'Decay Watch', detail: `${store.filteredDecayPredictions.length} entries`, active: store.filteredDecayPredictions.length > 0 },
]);

const intelQueue = computed(() =>
  [
    ...store.alerts.map((alert) => ({
      id: `alert-${alert.id}`,
      kicker: formatKicker(alert.kind),
      title: alert.title,
      detail: alert.detail,
      time: 'Live',
      tone: alert.tone,
    })),
    ...store.filteredConjunctions.slice(0, 2).map((item) => ({
      id: `conjunction-${item.id}`,
      kicker: 'Conjunction',
      title: `${item.primary.name} × ${item.secondary.name}`,
      detail: `${item.missDistanceKm.toFixed(1)} km miss · ${item.relVelocityKmS.toFixed(1)} km/s`,
      time: formatRelative(item.tca),
      tone: item.missDistanceKm < 15 ? 'critical' : 'warn',
    })),
    ...store.filteredDecayPredictions.slice(0, 1).map((item) => ({
      id: `decay-${item.catalogNumber}`,
      kicker: 'Decay',
      title: item.name,
      detail: `${item.confidence} confidence · ${item.intersectsSelectedFleet ? 'selected fleet' : 'catalog only'}`,
      time: formatRelative(item.predictedDecayAt),
      tone: item.intersectsSelectedFleet ? 'warn' : 'info',
    })),
    ...store.upcomingEvents.slice(0, 2).map((event) => ({
      id: `event-${event.id}`,
      kicker: event.kind,
      title: event.title,
      detail: event.notes ? truncate(event.notes, 86) : 'Scheduled user operation',
      time: formatRelative(event.startAt),
      tone: 'info',
    })),
  ].slice(0, 7),
);

function formatKicker(value: string) {
  return value
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function setRenderMode(mode: '2d' | '3d') {
  if (mode === '3d' && store.preferences.dataSaver) {
    return;
  }
  if (isMobileViewport.value) {
    store.updatePreferences({ mobileRenderMode: mode });
    return;
  }
  if (viewport.breakpoint.value === 'md') {
    store.updatePreferences({ tabletRenderMode: mode });
    return;
  }
  store.updatePreferences({ desktopRenderMode: mode });
}

function shiftOrbitHours(hours: number) {
  const baseMs = displayedOrbitTime.value.getTime();
  store.setSimulationTime(new Date(baseMs + hours * 60 * 60 * 1000).toISOString());
}

function setOrbitTime(value: string | null) {
  store.setSimulationTime(value);
  if (!value) {
    resetLiveOrbit();
  }
}

function resetLiveOrbit() {
  const wallNow = Date.now();
  liveWallClockAnchor.value = wallNow;
  liveOrbitAnchor.value = wallNow;
  orbitClockTick.value = wallNow;
  store.resetSimulationTime();
}

function setLivePlaybackRate(rate: number) {
  const currentDisplayedMs = displayedOrbitTime.value.getTime();
  const wallNow = Date.now();
  livePlaybackRate.value = rate;
  liveWallClockAnchor.value = wallNow;
  liveOrbitAnchor.value = Number.isFinite(currentDisplayedMs) ? currentDisplayedMs : wallNow;
  orbitClockTick.value = wallNow;
}

function toggleMapControls() {
  mapControlsOpen.value = !mapControlsOpen.value;
}

function toggleMapFocusMode() {
  mapFocusMode.value = !mapFocusMode.value;
  if (mapFocusMode.value) {
    mapControlsOpen.value = false;
  }
}

function refKey(member: FleetMemberRef) {
  return member.refType === 'catalog' ? `catalog:${member.catalogNumber}` : `custom:${member.customTleId}`;
}
</script>

<template>
  <div class="briefing-page" :class="{ 'briefing-page--map-focus': isMobileViewport && mapFocusMode }">
    <section class="war-room">
      <div class="war-room__header">
        <div>
          <p class="eyebrow">War Room / Orbit Intelligence</p>
          <h2>Selected Fleet Live Operating Picture</h2>
          <p>궤도, 지상국, 근접 접근, 우주 기상 신호를 하나의 작전 화면으로 통합합니다.</p>
        </div>
        <div class="war-room__status">
          <span :class="{ 'war-room__status-dot--warn': store.offline }" class="war-room__status-dot"></span>
          <strong>{{ store.offline ? 'Offline Cache' : 'Live Feed' }}</strong>
          <small>{{ store.lastSyncedAt ? formatTimestamp(store.lastSyncedAt) : 'syncing' }}</small>
        </div>
      </div>

      <div class="war-room__stats">
        <article v-for="stat in warRoomStats" :key="stat.label" class="war-room__stat" :class="`war-room__stat--${stat.tone}`">
          <span>{{ stat.label }}</span>
          <strong>{{ stat.value }}</strong>
        </article>
      </div>

      <div class="war-room__main">
        <div class="war-room__map-panel" :class="mapPanelClasses">
          <div class="map-mobile-bar" aria-label="Mobile map controls">
            <div class="map-mobile-bar__summary">
              <strong>{{ renderMode === '2d' ? '2D Map' : '3D Globe' }}</strong>
              <small>{{ visibleFleetEntries.length }} tracks · {{ mapFocusMode ? 'focus' : 'inline' }}</small>
            </div>
            <div class="map-mobile-bar__actions">
              <button class="button button--ghost map-mobile-bar__button" type="button" :aria-expanded="mapControlsOpen" @click="toggleMapControls">
                {{ mapControlsOpen ? '접기' : '컨트롤' }}
              </button>
              <button class="button map-mobile-bar__button" type="button" :aria-pressed="mapFocusMode" @click="toggleMapFocusMode">
                {{ mapFocusMode ? '축소' : '전체화면' }}
              </button>
            </div>
          </div>
          <div v-if="isMobileViewport" class="view-switcher view-switcher--mobile" aria-label="Orbit view mode">
            <span class="view-switcher__label">Map view</span>
            <div class="view-switcher__segments" role="group">
              <button
                class="view-switcher__button"
                :class="{ 'view-switcher__button--active': renderMode === '2d' }"
                type="button"
                :aria-pressed="renderMode === '2d'"
                @click="setRenderMode('2d')"
              >
                2D Track
              </button>
              <button
                class="view-switcher__button"
                :class="{ 'view-switcher__button--active': renderMode === '3d' }"
                type="button"
                :aria-pressed="renderMode === '3d'"
                :disabled="store.preferences.dataSaver"
                @click="setRenderMode('3d')"
              >
                3D Globe
              </button>
            </div>
            <small>{{ renderMode === '2d' ? 'OSM ground track' : 'WebGL orbit globe' }}</small>
          </div>
          <div v-show="showsMapControls" class="war-room__toolbar">
            <SimulationControls
              :live-playback-rate="livePlaybackRate"
              :orbit-time-iso="displayedOrbitTimeIso"
              :simulation-time-iso="store.simulationTimeIso"
              @set-playback-rate="setLivePlaybackRate"
              @set-orbit-time="setOrbitTime"
              @shift="shiftOrbitHours"
              @reset-live="resetLiveOrbit"
            />
            <div v-if="!isMobileViewport" class="view-switcher view-switcher--desktop" aria-label="Orbit view mode">
              <span class="view-switcher__label">Map view</span>
              <div class="view-switcher__segments" role="group">
                <button
                  class="view-switcher__button"
                  :class="{ 'view-switcher__button--active': renderMode === '2d' }"
                  type="button"
                  :aria-pressed="renderMode === '2d'"
                  @click="setRenderMode('2d')"
                >
                  2D Track
                </button>
                <button
                  class="view-switcher__button"
                  :class="{ 'view-switcher__button--active': renderMode === '3d' }"
                  type="button"
                  :aria-pressed="renderMode === '3d'"
                  :disabled="store.preferences.dataSaver"
                  @click="setRenderMode('3d')"
                >
                  3D Globe
                </button>
              </div>
              <small>{{ renderMode === '2d' ? 'OSM ground track' : 'WebGL orbit globe' }}</small>
            </div>
          </div>
          <OrbitMap2D
            v-if="renderMode === '2d'"
            :satellites="visibleFleetEntries"
            :ground-stations="store.groundStations"
            :live-playback-rate="livePlaybackRate"
            :orbit-mode="orbitMode"
            :orbit-time-iso="displayedOrbitTimeIso"
            :data-saver="store.preferences.dataSaver"
          />
          <OrbitGlobe3D
            v-else
            :satellites="visibleFleetEntries"
            :ground-stations="store.groundStations"
            :orbit-time-iso="displayedOrbitTimeIso"
            :orbit-mode="orbitMode"
            :data-saver="store.preferences.dataSaver"
          />
        </div>

        <aside class="war-room__side">
          <section class="war-room__side-card">
            <div class="war-room__side-header">
              <p class="eyebrow">Live Intel Queue</p>
              <strong>{{ intelQueue.length }} signals</strong>
            </div>
            <div class="war-room__feed">
              <article v-for="item in intelQueue" :key="item.id" class="war-room__feed-item" :class="`war-room__feed-item--${item.tone}`">
                <div>
                  <span>{{ item.kicker }}</span>
                  <strong>{{ item.title }}</strong>
                  <p>{{ item.detail }}</p>
                </div>
                <small>{{ item.time }}</small>
              </article>
            </div>
          </section>

          <section class="war-room__side-card">
            <div class="war-room__side-header">
              <p class="eyebrow">Map Layers</p>
              <strong>{{ activeLayers.filter((layer) => layer.active).length }}/{{ activeLayers.length }}</strong>
            </div>
            <div class="war-room__layers" aria-label="Current map layer status">
              <article
                v-for="layer in activeLayers"
                :key="layer.label"
                class="war-room__layer"
                :class="{ 'war-room__layer--active': layer.active }"
              >
                <span></span>
                <strong>{{ layer.label }}</strong>
                <small>{{ layer.detail }}</small>
              </article>
            </div>
          </section>
        </aside>
      </div>
    </section>

    <div class="briefing-grid">
    <PanelCard title="Operator Readiness" subtitle="USER-entered mission status">
      <template #actions>
        <OriginBadge v-if="store.fleetHealth.latestRecordedAt" origin="USER" :timestamp="store.fleetHealth.latestRecordedAt" />
      </template>
      <div class="metric-grid">
        <MetricCard
          label="Recorded"
          :value="`${store.fleetHealth.recordedMembers}/${store.fleetHealth.totalMembers}`"
          :hint="readinessCoverage === null ? '선택 플릿 없음' : `상태 기록률 ${formatPercent(readinessCoverage, 0)}`"
          :tone="store.fleetHealth.recordedMembers ? 'good' : 'warn'"
        />
        <MetricCard
          label="FMC"
          :value="formatPercent(store.fleetHealth.fmcRate, 0)"
          :hint="store.fleetHealth.recordedMembers ? `Full mission capable · ${store.fleetHealth.fmcCount} objects` : '상태 입력 필요'"
          tone="good"
        />
        <MetricCard
          label="PMC"
          :value="formatPercent(store.fleetHealth.pmcRate, 0)"
          :hint="store.fleetHealth.recordedMembers ? `Partial mission capable · ${store.fleetHealth.pmcCount} objects` : '상태 입력 필요'"
          tone="warn"
        />
        <MetricCard
          label="NMC"
          :value="formatPercent(store.fleetHealth.nmcRate, 0)"
          :hint="store.fleetHealth.recordedMembers ? `Non-mission capable · ${store.fleetHealth.nmcCount} objects` : '상태 입력 필요'"
          tone="critical"
        />
      </div>
      <p class="supporting-text">
        FMC/PMC/NMC는 공개 SATCAT·TLE에서 추론하지 않습니다. 플릿 화면에서 입력한 최신 운영자 상태만 집계하며,
        미입력 멤버 {{ store.fleetHealth.unrecordedMembers }}개는 준비태세 비율에서 제외됩니다.
      </p>
    </PanelCard>

    <PanelCard title="Space Weather" subtitle="OSINT environmental risk">
      <template #actions>
        <OriginBadge v-if="store.weather?.fetchedAt" origin="OSINT" :timestamp="store.weather.fetchedAt" />
      </template>
      <div class="metric-grid">
        <MetricCard label="X-ray" :value="`${store.weather?.xray.flareClass ?? '—'}${store.weather?.xray.classMagnitude ?? ''}`" hint="GOES 1-day" />
        <MetricCard label="Kp" :value="`${store.weather?.kp.current ?? '—'}`" hint="3일 예보 반영" tone="warn" />
      </div>
      <p class="supporting-text">{{ truncate(store.weather?.notices?.[0]?.text ?? '현재 특기사항이 없습니다.', 96) }}</p>
    </PanelCard>

    <PanelCard title="Next Conjunctions" subtitle="SOCRATES screening">
      <template #actions>
        <OriginBadge v-if="store.filteredConjunctions[0]?.fetchedAt" origin="OSINT" :timestamp="store.filteredConjunctions[0].fetchedAt" :stale="store.offline" />
      </template>
      <div class="stack-list">
        <article v-for="item in store.filteredConjunctions.slice(0, 3)" :key="item.id" class="stack-list__item">
          <div>
            <strong>{{ item.primary.name }} × {{ item.secondary.name }}</strong>
            <p>{{ item.missDistanceKm.toFixed(1) }} km miss · {{ item.relVelocityKmS.toFixed(1) }} km/s</p>
          </div>
          <small>{{ formatRelative(item.tca) }}</small>
        </article>
      </div>
    </PanelCard>

    <PanelCard title="Upcoming Passes" subtitle="Derived contact windows">
      <template #actions>
        <OriginBadge v-if="store.passPredictions[0]?.computedAt" origin="DERIVED" :timestamp="store.passPredictions[0].computedAt" />
      </template>
      <PassList :passes="store.passPredictions.slice(0, 5)" :station-lookup="stationLookup" />
    </PanelCard>

    <PanelCard title="Open Anomalies" subtitle="USER issue log">
      <div class="stack-list">
        <article v-for="anomaly in store.anomalies.slice(0, 5)" :key="anomaly.id" class="stack-list__item">
          <div>
            <strong>{{ anomaly.severity }} · {{ anomaly.subsystem || 'GENERAL' }}</strong>
            <p>{{ truncate(anomaly.description, 84) }}</p>
          </div>
          <small>{{ formatRelative(anomaly.openedAt) }}</small>
        </article>
        <article v-if="!store.anomalies.length" class="stack-list__item">
          <div>
            <strong>No critical anomaly</strong>
            <p>운영 이슈는 Fleets 화면에서 기록할 수 있습니다.</p>
          </div>
          <small>0 open</small>
        </article>
      </div>
    </PanelCard>

    <PanelCard title="Tracked Objects" subtitle="Selected fleet">
      <template #actions>
        <RouterLink class="button button--ghost panel-card__action-link" to="/catalog">Catalog에서 추가</RouterLink>
        <RouterLink class="button button--ghost panel-card__action-link" to="/fleets">Fleet 관리</RouterLink>
      </template>
      <div v-if="trackedObjects.length" class="table-like">
        <article v-for="item in trackedObjects" :key="item.key" class="table-like__row" :class="{ 'table-like__row--muted': item.hidden }">
          <div>
            <strong>{{ item.name }}</strong>
            <p>{{ item.hidden ? `${item.detail} · briefing 표시 숨김` : item.detail }}</p>
          </div>
          <div class="inline-actions">
            <small>{{ item.hidden ? 'HIDDEN' : item.source }}</small>
            <button class="button button--ghost" type="button" @click="store.toggleFleetMemberHidden(item.ref)">
              {{ item.hidden ? '표시' : '숨기기' }}
            </button>
            <button class="button button--ghost" type="button" @click="store.removeFleetMember(item.ref)">플릿에서 제거</button>
          </div>
        </article>
      </div>
      <div v-else class="empty-state empty-state--action">
        <strong>추적 중인 객체가 없습니다.</strong>
        <p>Catalog에서 위성을 선택하면 Briefing 지도, 패스, 위험 신호 계산 대상에 포함됩니다.</p>
        <RouterLink class="button" to="/catalog">Catalog에서 추가</RouterLink>
      </div>
    </PanelCard>

    <PanelCard title="Decay Watch" subtitle="OSINT decay forecast">
      <div class="stack-list">
        <article
          v-for="item in store.filteredDecayPredictions"
          :key="item.catalogNumber"
          class="stack-list__item"
          :class="{ 'stack-list__item--accent': item.intersectsSelectedFleet }"
        >
          <div>
            <strong>{{ item.name }}</strong>
            <p>{{ item.confidence }} confidence · {{ item.intersectsSelectedFleet ? 'selected fleet' : 'catalog only' }}</p>
          </div>
          <small>{{ formatTimestamp(item.predictedDecayAt) }}</small>
        </article>
      </div>
    </PanelCard>

    <PanelCard title="Upcoming Events" subtitle="USER schedule">
      <template #actions>
        <OriginBadge v-if="store.upcomingEvents[0]?.startAt" origin="USER" :timestamp="store.upcomingEvents[0].startAt" />
      </template>
      <EventTimeline :events="store.upcomingEvents" :satellite-lookup="satelliteLookup" @remove="store.deleteEvent" />
    </PanelCard>
    </div>
  </div>
</template>
