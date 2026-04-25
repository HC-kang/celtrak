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
import { buildLiveContactLinks } from '@/lib/contactLinks';
import type { ContactPrecisionCandidate, ContactPrecisionResult, ContactPrecisionWorkerResult } from '@/lib/contactPrecision';
import { classifyConjunctionSeverity, conjunctionSeverityRank } from '@/lib/conjunctionRisk';
import { elevationMaskSourceLabel, withUserElevationMaskSource } from '@/lib/groundStationElevation';
import type { CatalogEntry, ConjunctionRecord, FleetMemberRef, GroundStation, LiveContactLink, MapFocusTarget } from '@/domain/types';

const OrbitGlobe3D = defineAsyncComponent(() => import('@/components/OrbitGlobe3D.vue'));
const store = useAppStore();
const viewport = useViewport();
const livePlaybackRate = ref(1);
const liveWallClockAnchor = ref(Date.now());
const liveOrbitAnchor = ref(Date.now());
const orbitClockTick = ref(Date.now());
const mapControlsOpen = ref(false);
const mapFocusMode = ref(false);
const focusedTarget = ref<MapFocusTarget | null>(null);
const trackingScopeTab = ref<'groundStations' | 'trackedObjects'>('groundStations');
const cdmScope = ref<'tracked' | 'focused' | 'all'>('tracked');
const cdmScopeRecords = ref<ConjunctionRecord[] | null>(null);
const cdmLoading = ref(false);
const cdmError = ref('');
const contactPrecisionResults = ref<Record<string, ContactPrecisionResult>>({});
const contactPrecisionPendingKeys = ref<Set<string>>(new Set());
let orbitClockTimer: number | null = null;
let contactPrecisionWorker: Worker | null = null;
let contactPrecisionRequestId = 0;
usePassPredictions(focusedTarget);

onMounted(() => {
  orbitClockTimer = window.setInterval(() => {
    orbitClockTick.value = Date.now();
  }, 250);
});

onUnmounted(() => {
  if (orbitClockTimer) {
    window.clearInterval(orbitClockTimer);
  }
  contactPrecisionWorker?.terminate();
});

const visibleFleetEntries = computed<CatalogEntry[]>(() =>
  (store.selectedFleet?.memberRefs ?? [])
    .filter((member) => !store.isFleetMemberHidden(member))
    .map((member) => store.catalog.find((entry) => entry.satcat.catalogNumber === member.catalogNumber))
    .filter((entry): entry is CatalogEntry => Boolean(entry)),
);

const contactSatellites = computed(() =>
  (store.selectedFleet?.memberRefs ?? [])
    .filter((member) => member.refType === 'catalog' && !store.isFleetMemberHidden(member))
    .map((member) => {
      const entry = store.catalog.find((item) => item.satcat.catalogNumber === member.catalogNumber);
      if (!entry?.tle) return null;
      return {
        satelliteRef: cloneFleetMemberRef(member),
        name: member.displayName ?? entry.satcat.objectName,
        tle: { ...entry.tle },
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item)),
);

const contactLinks = computed(() =>
  buildLiveContactLinks({
    satellites: contactSatellites.value,
    stations: store.groundStations,
    timestampIso: displayedOrbitTimeIso.value,
    passPredictions: store.passPredictions,
    priorityTarget: focusedTarget.value,
  }),
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

const focusedSatellite = computed(() => {
  if (focusedTarget.value?.type !== 'satellite') return null;
  const catalogNumber = focusedCatalogNumber.value;
  if (!catalogNumber) return null;
  const entry = visibleFleetEntries.value.find((item) => item?.satcat.catalogNumber === catalogNumber);
  const member = (store.selectedFleet?.memberRefs ?? []).find((item) => item.refType === 'catalog' && item.catalogNumber === catalogNumber);
  return entry && member ? { entry, member } : null;
});

const focusedCatalogNumber = computed(() => {
  if (focusedTarget.value?.type !== 'satellite') return null;
  return catalogNumberFromSatelliteId(focusedTarget.value.id);
});

const focusedStation = computed(() => {
  if (focusedTarget.value?.type !== 'groundStation') return null;
  return store.groundStations.find((station) => station.id === focusedTarget.value?.id) ?? null;
});

const enabledGroundStationCount = computed(() => store.groundStations.filter((station) => station.enabled).length);
const visibleTrackedObjectCount = computed(() => trackedObjects.value.filter((item) => !item.hidden).length);
const cdmQueryCatalogNumbers = computed(() => {
  if (cdmScope.value === 'all') return [];
  if (cdmScope.value === 'focused') return focusedCatalogNumber.value ? [focusedCatalogNumber.value] : [];
  return store.selectedFleetCatalogNumbers;
});
const cdmScopeConjunctions = computed(() => {
  const records = cdmScopeRecords.value ?? store.conjunctions;
  if (cdmScope.value === 'all') return records;
  const catalogNumbers = cdmQueryCatalogNumbers.value;
  return catalogNumbers.length ? filterConjunctionsByCatalog(records, catalogNumbers) : [];
});
const riskSatelliteIds = computed(() => {
  const ids = new Set<string>();
  for (const item of cdmScopeConjunctions.value) {
    if (cdmSeverity(item) === 'info') continue;
    addCatalogRiskId(ids, item.primary.catalogNumber);
    addCatalogRiskId(ids, item.secondary.catalogNumber);
  }
  for (const item of store.filteredDecayPredictions) {
    if (item.intersectsSelectedFleet) {
      addCatalogRiskId(ids, item.catalogNumber);
    }
  }
  for (const anomaly of store.anomalies) {
    if (anomaly.closedAt || anomaly.severity === 'INFO') continue;
    ids.add(refKey(anomaly.satelliteRef));
  }
  return [...ids];
});

const focusedLinks = computed(() => {
  const target = focusedTarget.value;
  if (!target) return contactLinks.value.filter((link) => link.status === 'IN_CONTACT').slice(0, 4);
  return contactLinks.value
    .filter((link) => (target.type === 'satellite' ? link.satelliteId === target.id : link.groundStationId === target.id))
    .slice(0, 6);
});

const focusedConjunctions = computed(() => {
  const target = focusedTarget.value;
  if (target?.type !== 'satellite') return cdmScopeConjunctions.value.slice(0, 3);
  const catalogNumber = focusedCatalogNumber.value;
  if (!catalogNumber) return [];
  return filterConjunctionsByCatalog(cdmScopeConjunctions.value, [catalogNumber])
    .sort((left, right) => conjunctionSeverityRank(cdmSeverity(left)) - conjunctionSeverityRank(cdmSeverity(right)) || left.tca.localeCompare(right.tca))
    .slice(0, 4);
});

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
const focusedPrecisionCandidates = computed<ContactPrecisionCandidate[]>(() => {
  if (!focusedTarget.value) return [];
  const satellitesById = new Map(contactSatellites.value.map((satellite) => [refKey(satellite.satelliteRef), satellite]));
  const stationsById = new Map(store.groundStations.map((station) => [station.id, station]));
  return focusedLinks.value
    .filter((link) => link.status === 'IN_CONTACT' || link.status === 'BEFORE_AOS')
    .map((link): ContactPrecisionCandidate | null => {
      const sat = satellitesById.get(link.satelliteId);
      const station = stationsById.get(link.groundStationId);
      if (!sat || !station) return null;
      return {
        satelliteId: link.satelliteId,
        groundStationId: link.groundStationId,
        status: link.status,
        tle: { ...sat.tle },
        station: cloneGroundStationForWorker(station),
      };
    })
    .filter((candidate): candidate is ContactPrecisionCandidate => Boolean(candidate));
});
const focusedPrecisionRequestKey = computed(() => {
  if (!focusedPrecisionCandidates.value.length) return '';
  const timeKey = store.simulationTimeIso ? displayedOrbitTimeIso.value : 'live';
  return [timeKey, ...focusedPrecisionCandidates.value.map(precisionCandidateSignature)].join('||');
});

const warRoomStats = computed(() => [
  { label: 'Visible Tracks', value: `${visibleFleetEntries.value.length}/${trackedObjects.value.length}`, tone: 'good' },
  { label: 'Conjunctions', value: `${cdmScopeConjunctions.value.length}`, tone: cdmScopeConjunctions.value.length ? 'warn' : 'good' },
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
  { label: 'Satellite States', detail: `${riskSatelliteIds.value.length} risk · ${contactLinks.value.filter((link) => link.status === 'IN_CONTACT').length} contact`, active: visibleFleetEntries.value.length > 0 },
  { label: 'Ground Stations', detail: `${store.groundStations.filter((station) => station.enabled).length} online`, active: true },
  { label: 'Contact Links', detail: `${contactLinks.value.filter((link) => link.status === 'IN_CONTACT').length} active`, active: contactLinks.value.some((link) => link.status === 'IN_CONTACT') },
  { label: 'Conjunction Risk', detail: `${cdmScopeConjunctions.value.length} ${cdmScope.value} windows`, active: cdmScopeConjunctions.value.length > 0 },
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
    ...cdmScopeConjunctions.value.slice(0, 2).map((item) => ({
      id: `conjunction-${item.id}`,
      kicker: 'Conjunction',
      title: `${item.primary.name} × ${item.secondary.name}`,
      detail: `${item.missDistanceKm.toFixed(1)} km miss · ${item.relVelocityKmS.toFixed(1)} km/s`,
      time: formatRelative(item.tca),
      tone: cdmSeverity(item),
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

function setFocusedTarget(target: MapFocusTarget) {
  focusedTarget.value = target;
}

function clearFocusedTarget() {
  focusedTarget.value = null;
}

function formatCountdown(seconds: number | undefined, lowerBound = false, estimated = false) {
  if (seconds === undefined) return '예측 대기';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const value = [hours, minutes, remainingSeconds].map((item) => item.toString().padStart(2, '0')).join(':');
  return `${estimated ? '약 ' : ''}${lowerBound ? `${value}+` : value}`;
}

function linkStatusLabel(link: LiveContactLink) {
  const countdown = formatCountdown(countdownSecondsForLink(link), countdownLowerBoundForLink(link), countdownEstimatedForLink(link));
  const suffix = countdownSuffixForLink(link);
  if (link.status === 'IN_CONTACT') return `LOS까지 ${countdown}${suffix}`;
  if (link.status === 'BEFORE_AOS') return `AOS까지 ${countdown}${suffix}`;
  return '가시권 밖';
}

function cdmSeverity(item: ConjunctionRecord) {
  return classifyConjunctionSeverity(item);
}

function filterConjunctionsByCatalog(records: ConjunctionRecord[], catalogNumbers: number[]) {
  const catalogNumberSet = new Set(catalogNumbers);
  return records.filter(
    (item) =>
      (item.primary.catalogNumber !== undefined && catalogNumberSet.has(item.primary.catalogNumber)) ||
      (item.secondary.catalogNumber !== undefined && catalogNumberSet.has(item.secondary.catalogNumber)),
  );
}

function addCatalogRiskId(ids: Set<string>, catalogNumber: number | undefined) {
  if (catalogNumber) {
    ids.add(`catalog:${catalogNumber}`);
  }
}

function cdmSeverityLabel(item: ConjunctionRecord) {
  const severity = cdmSeverity(item);
  if (severity === 'critical') return '심각한 위협';
  if (severity === 'warn') return '근접 경고';
  return '감시';
}

function catalogNumberFromSatelliteId(id: string) {
  const match = /^catalog:(\d+)$/.exec(id);
  if (!match) return null;
  const catalogNumber = Number(match[1]);
  return Number.isFinite(catalogNumber) ? catalogNumber : null;
}

function cloneFleetMemberRef(refItem: FleetMemberRef): FleetMemberRef {
  return {
    refType: refItem.refType,
    catalogNumber: refItem.catalogNumber,
    customTleId: refItem.customTleId,
    displayName: refItem.displayName,
    tags: [...refItem.tags],
  };
}

function updateStationMask(station: GroundStation, value: string) {
  const elevationMaskDeg = Number(value);
  if (!Number.isFinite(elevationMaskDeg)) return;
  void store.upsertGroundStation(withUserElevationMaskSource({ ...station, elevationMaskDeg: Math.min(Math.max(elevationMaskDeg, 0), 90) }));
}

function toggleFocusedStation(station: GroundStation, enabled: boolean) {
  void store.toggleGroundStation(station.id, enabled);
}

function setAllGroundStations(enabled: boolean) {
  void Promise.all(
    store.groundStations
      .filter((station) => station.enabled !== enabled)
      .map((station) => store.toggleGroundStation(station.id, enabled)),
  );
}

function refKey(member: FleetMemberRef) {
  return member.refType === 'catalog' ? `catalog:${member.catalogNumber}` : `custom:${member.customTleId}`;
}

function precisionCandidateSignature(candidate: ContactPrecisionCandidate) {
  return [
    precisionCandidateKey(candidate),
    candidate.station.latDeg.toFixed(6),
    candidate.station.lonDeg.toFixed(6),
    candidate.station.altitudeM.toFixed(1),
    candidate.station.elevationMaskDeg.toFixed(3),
    candidate.tle.line1,
    candidate.tle.line2,
  ].join('|');
}

function precisionCandidateKey(candidate: Pick<ContactPrecisionCandidate, 'satelliteId' | 'groundStationId' | 'status'>) {
  return `${candidate.satelliteId}:${candidate.groundStationId}:${candidate.status}`;
}

function precisionLinkKey(link: LiveContactLink) {
  return `${link.satelliteId}:${link.groundStationId}:${link.status}`;
}

function ensureContactPrecisionWorker() {
  if (contactPrecisionWorker) return contactPrecisionWorker;
  contactPrecisionWorker = new Worker(new URL('../workers/contactPrecision.worker.ts', import.meta.url), { type: 'module' });
  contactPrecisionWorker.onmessage = (event: MessageEvent<ContactPrecisionWorkerResult>) => {
    if (event.data.requestId !== contactPrecisionRequestId) return;
    const next = { ...contactPrecisionResults.value };
    for (const result of event.data.results) {
      next[precisionCandidateKey(result)] = result;
    }
    contactPrecisionResults.value = next;
    contactPrecisionPendingKeys.value = new Set();
  };
  contactPrecisionWorker.onerror = () => {
    contactPrecisionPendingKeys.value = new Set();
  };
  return contactPrecisionWorker;
}

function refreshFocusedContactPrecision() {
  const candidates = focusedPrecisionCandidates.value;
  contactPrecisionRequestId += 1;
  if (!candidates.length) {
    contactPrecisionPendingKeys.value = new Set();
    return;
  }

  contactPrecisionPendingKeys.value = new Set(candidates.map(precisionCandidateKey));
  contactPrecisionResults.value = dropExpiredPrecisionResults(candidates);
  try {
    ensureContactPrecisionWorker().postMessage({
      requestId: contactPrecisionRequestId,
      timestampIso: displayedOrbitTimeIso.value,
      candidates,
    });
  } catch (error) {
    console.error('Contact precision worker rejected payload', error);
    contactPrecisionPendingKeys.value = new Set();
  }
}

function dropExpiredPrecisionResults(candidates: ContactPrecisionCandidate[]) {
  const nowMs = displayedOrbitTime.value.getTime();
  const next = { ...contactPrecisionResults.value };
  for (const candidate of candidates) {
    const key = precisionCandidateKey(candidate);
    const eventMs = next[key]?.eventIso ? new Date(next[key].eventIso).getTime() : Number.NaN;
    if (Number.isFinite(eventMs) && eventMs <= nowMs) {
      delete next[key];
    }
  }
  return next;
}

function contactPrecisionResultFor(link: LiveContactLink) {
  return contactPrecisionResults.value[precisionLinkKey(link)];
}

function countdownSecondsForLink(link: LiveContactLink) {
  const result = contactPrecisionResultFor(link);
  if (result?.eventIso) return countdownSecondsUntil(result.eventIso);
  return link.countdownSeconds;
}

function countdownLowerBoundForLink(link: LiveContactLink) {
  return contactPrecisionResultFor(link)?.countdownIsLowerBound ?? link.countdownIsLowerBound;
}

function countdownEstimatedForLink(link: LiveContactLink) {
  return contactPrecisionResultFor(link)?.eventIso ? false : link.countdownIsEstimated;
}

function countdownSuffixForLink(link: LiveContactLink) {
  return contactPrecisionPendingKeys.value.has(precisionLinkKey(link)) ? '(재계산 중)' : '';
}

function countdownSecondsUntil(eventIso: string) {
  const eventMs = new Date(eventIso).getTime();
  const nowMs = displayedOrbitTime.value.getTime();
  if (!Number.isFinite(eventMs) || !Number.isFinite(nowMs)) return undefined;
  return Math.max(0, Math.round((eventMs - nowMs) / 1000));
}

function cloneGroundStationForWorker(station: GroundStation): GroundStation {
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

async function refreshCdmScope() {
  const catalogNumbers = cdmQueryCatalogNumbers.value;
  if (cdmScope.value !== 'all' && !catalogNumbers.length) {
    cdmScopeRecords.value = [];
    return;
  }
  cdmLoading.value = true;
  cdmError.value = '';
  try {
    cdmScopeRecords.value = await store.fetchConjunctions({
      catalogNumbers,
      limit: cdmScope.value === 'all' ? 500 : 1000,
      order: 'MINRANGE',
    });
  } catch (error) {
    cdmError.value = error instanceof Error ? error.message : 'SOCRATES 데이터를 불러오지 못했습니다.';
    cdmScopeRecords.value = null;
  } finally {
    cdmLoading.value = false;
  }
}

watch(
  focusedPrecisionRequestKey,
  () => {
    refreshFocusedContactPrecision();
  },
  { immediate: true },
);

watch(
  () => [cdmScope.value, cdmQueryCatalogNumbers.value.join(',')] as const,
  () => {
    void refreshCdmScope();
  },
  { immediate: true },
);
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
            :contact-links="contactLinks"
            :focused-target="focusedTarget"
            :ground-stations="store.groundStations"
            :live-playback-rate="livePlaybackRate"
            :orbit-mode="orbitMode"
            :orbit-time-iso="displayedOrbitTimeIso"
            :risk-satellite-ids="riskSatelliteIds"
            :data-saver="store.preferences.dataSaver"
            @focus-target="setFocusedTarget"
          />
          <OrbitGlobe3D
            v-else
            :satellites="visibleFleetEntries"
            :contact-links="contactLinks"
            :focused-target="focusedTarget"
            :ground-stations="store.groundStations"
            :orbit-time-iso="displayedOrbitTimeIso"
            :orbit-mode="orbitMode"
            :risk-satellite-ids="riskSatelliteIds"
            :data-saver="store.preferences.dataSaver"
            @focus-target="setFocusedTarget"
          />
        </div>

        <aside class="war-room__side">
          <section class="war-room__side-card focus-inspector">
            <div class="war-room__side-header">
              <p class="eyebrow">Focus Inspector</p>
              <button v-if="focusedTarget" class="button button--ghost panel-card__action-link" type="button" @click="clearFocusedTarget()">Clear</button>
            </div>

            <template v-if="focusedSatellite">
              <div class="focus-inspector__hero">
                <strong>{{ focusedSatellite.member.displayName ?? focusedSatellite.entry.satcat.objectName }}</strong>
                <p>NORAD {{ focusedSatellite.entry.satcat.catalogNumber }} · {{ focusedSatellite.entry.group }}</p>
              </div>
              <div class="focus-inspector__actions">
                <button class="button button--ghost" type="button" @click="store.toggleFleetMemberHidden(focusedSatellite.member)">
                  {{ store.isFleetMemberHidden(focusedSatellite.member) ? '표시' : '숨기기' }}
                </button>
                <button class="button button--ghost" type="button" @click="store.removeFleetMember(focusedSatellite.member)">플릿에서 제거</button>
              </div>
            </template>

            <template v-else-if="focusedStation">
              <div class="focus-inspector__hero">
                <strong>{{ focusedStation.name }}</strong>
                <p>{{ focusedStation.latDeg.toFixed(4) }}, {{ focusedStation.lonDeg.toFixed(4) }}</p>
              </div>
              <div class="focus-inspector__station-controls">
                <label class="setting-toggle setting-toggle--compact">
                  <span>활성</span>
                  <input
                    :checked="focusedStation.enabled"
                    type="checkbox"
                    @change="toggleFocusedStation(focusedStation, ($event.target as HTMLInputElement).checked)"
                  />
                </label>
                <label>
                  <span>Elevation mask</span>
                  <input
                    class="input"
                    type="number"
                    min="0"
                    max="90"
                    step="1"
                    :value="focusedStation.elevationMaskDeg"
                    @change="updateStationMask(focusedStation, ($event.target as HTMLInputElement).value)"
                  />
                </label>
                <small class="focus-inspector__source">
                  {{ elevationMaskSourceLabel(focusedStation.elevationMaskSource) }} elevation mask
                </small>
              </div>
            </template>

            <template v-else>
              <div class="focus-inspector__hero">
                <strong>{{ contactLinks.filter((link) => link.status === 'IN_CONTACT').length }} active links</strong>
                <p>{{ store.groundStations.filter((station) => station.enabled).length }} enabled ground stations</p>
              </div>
            </template>

            <div class="focus-inspector__section">
              <span>Contact Windows</span>
              <article v-for="link in focusedLinks" :key="`${link.satelliteId}-${link.groundStationId}`" class="focus-inspector__row" :class="`focus-inspector__row--${link.status.toLowerCase().replace('_', '-')}`">
                <div>
                  <strong>{{ link.satelliteName }} → {{ link.groundStationName }}</strong>
                  <p>{{ linkStatusLabel(link) }} · el {{ link.elevationDeg.toFixed(1) }}° · az {{ link.azimuthDeg.toFixed(0) }}°</p>
                </div>
              </article>
              <p v-if="!focusedLinks.length" class="empty-state">가시권 링크가 없습니다.</p>
            </div>

            <div class="focus-inspector__section">
              <span>CDM</span>
              <article v-for="item in focusedConjunctions" :key="item.id" class="focus-inspector__row" :class="`focus-inspector__row--${cdmSeverity(item)}`">
                <div>
                  <strong>{{ cdmSeverityLabel(item) }} · {{ item.missDistanceKm.toFixed(2) }} km</strong>
                  <p>{{ item.primary.name }} × {{ item.secondary.name }} · {{ formatRelative(item.tca) }}</p>
                </div>
              </article>
              <p v-if="!focusedConjunctions.length" class="empty-state">근접경고 없음</p>
            </div>
          </section>

          <section class="war-room__side-card ground-station-control tracking-scope">
            <div class="war-room__side-header">
              <div>
                <p class="eyebrow">Tracking Scope</p>
                <strong>{{ enabledGroundStationCount }}/{{ store.groundStations.length }} stations · {{ visibleTrackedObjectCount }}/{{ trackedObjects.length }} objects</strong>
              </div>
            </div>
            <div class="tracking-scope__tabs" role="tablist" aria-label="Tracking scope controls">
              <button
                class="tracking-scope__tab"
                :class="{ 'tracking-scope__tab--active': trackingScopeTab === 'groundStations' }"
                type="button"
                role="tab"
                :aria-selected="trackingScopeTab === 'groundStations'"
                @click="trackingScopeTab = 'groundStations'"
              >
                Ground Stations
              </button>
              <button
                class="tracking-scope__tab"
                :class="{ 'tracking-scope__tab--active': trackingScopeTab === 'trackedObjects' }"
                type="button"
                role="tab"
                :aria-selected="trackingScopeTab === 'trackedObjects'"
                @click="trackingScopeTab = 'trackedObjects'"
              >
                Tracked Objects
              </button>
            </div>

            <div v-if="trackingScopeTab === 'groundStations'" class="tracking-scope__panel">
              <div class="ground-station-control__actions">
                <button class="button button--ghost panel-card__action-link" type="button" @click="setAllGroundStations(true)">모두선택</button>
                <button class="button button--ghost panel-card__action-link" type="button" @click="setAllGroundStations(false)">모두해제</button>
              </div>
              <div class="focus-inspector__station-list focus-inspector__station-list--expanded">
                <article
                  v-for="station in store.groundStations"
                  :key="station.id"
                  class="focus-inspector__station-toggle"
                  :class="{ 'focus-inspector__station-toggle--active': station.enabled }"
                >
                  <label>
                    <input
                      :checked="station.enabled"
                      type="checkbox"
                      @change="toggleFocusedStation(station, ($event.target as HTMLInputElement).checked)"
                    />
                    <span>
                      <strong>{{ station.name }}</strong>
                      <small>
                        {{ station.latDeg.toFixed(2) }}, {{ station.lonDeg.toFixed(2) }} · {{ station.elevationMaskDeg }}° mask ·
                        {{ elevationMaskSourceLabel(station.elevationMaskSource) }}
                      </small>
                    </span>
                  </label>
                  <button class="button button--ghost panel-card__action-link" type="button" @click="setFocusedTarget({ type: 'groundStation', id: station.id })">
                    보기
                  </button>
                </article>
              </div>
            </div>

            <div v-else class="tracking-scope__panel">
              <div class="ground-station-control__actions">
                <RouterLink class="button button--ghost panel-card__action-link" to="/catalog">Catalog에서 추가</RouterLink>
                <RouterLink class="button button--ghost panel-card__action-link" to="/fleets">Fleet 관리</RouterLink>
              </div>
              <div v-if="trackedObjects.length" class="tracking-scope__object-list">
                <article
                  v-for="item in trackedObjects"
                  :key="item.key"
                  class="tracking-scope__object"
                  :class="{ 'tracking-scope__object--muted': item.hidden }"
                >
                  <div>
                    <strong>{{ item.name }}</strong>
                    <p>{{ item.hidden ? `${item.detail} · briefing 표시 숨김` : item.detail }}</p>
                  </div>
                  <div class="tracking-scope__object-actions">
                    <small>{{ item.hidden ? 'HIDDEN' : item.source }}</small>
                    <button
                      v-if="item.key.startsWith('catalog:')"
                      class="button button--ghost panel-card__action-link"
                      type="button"
                      @click="setFocusedTarget({ type: 'satellite', id: item.key })"
                    >
                      보기
                    </button>
                    <button class="button button--ghost panel-card__action-link" type="button" @click="store.toggleFleetMemberHidden(item.ref)">
                      {{ item.hidden ? '표시' : '숨기기' }}
                    </button>
                    <button class="button button--ghost panel-card__action-link" type="button" @click="store.removeFleetMember(item.ref)">제거</button>
                  </div>
                </article>
              </div>
              <div v-else class="empty-state empty-state--action">
                <strong>추적 중인 객체가 없습니다.</strong>
                <p>Catalog에서 위성을 선택하면 지도와 링크 계산 대상에 포함됩니다.</p>
                <RouterLink class="button" to="/catalog">Catalog에서 추가</RouterLink>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </section>

    <div class="briefing-grid">
    <PanelCard class="briefing-grid__half" title="Live Intel Queue" subtitle="Passive signals">
      <template #actions>
        <strong class="panel-card__action-link">{{ intelQueue.length }} signals</strong>
      </template>
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
    </PanelCard>

    <PanelCard class="briefing-grid__half" title="Map Layers" subtitle="Passive layer status">
      <template #actions>
        <strong class="panel-card__action-link">{{ activeLayers.filter((layer) => layer.active).length }}/{{ activeLayers.length }}</strong>
      </template>
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
    </PanelCard>

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

    <PanelCard title="Next Conjunctions" subtitle="SOCRATES Plus screening">
      <template #actions>
        <OriginBadge v-if="cdmScopeConjunctions[0]?.fetchedAt" origin="OSINT" :timestamp="cdmScopeConjunctions[0].fetchedAt" :stale="store.offline" />
      </template>
      <div class="tracking-scope__tabs cdm-scope__tabs" role="tablist" aria-label="CDM scope">
        <button class="tracking-scope__tab" :class="{ 'tracking-scope__tab--active': cdmScope === 'all' }" type="button" @click="cdmScope = 'all'">전체</button>
        <button class="tracking-scope__tab" :class="{ 'tracking-scope__tab--active': cdmScope === 'tracked' }" type="button" @click="cdmScope = 'tracked'">Tracked</button>
        <button
          class="tracking-scope__tab"
          :class="{ 'tracking-scope__tab--active': cdmScope === 'focused' }"
          type="button"
          :disabled="!focusedCatalogNumber"
          @click="cdmScope = 'focused'"
        >
          Focused
        </button>
      </div>
      <p v-if="cdmLoading" class="supporting-text">SOCRATES Plus 결과를 불러오는 중입니다.</p>
      <p v-else-if="cdmError" class="supporting-text">{{ cdmError }}</p>
      <div class="stack-list">
        <article v-for="item in cdmScopeConjunctions.slice(0, 3)" :key="item.id" class="stack-list__item" :class="`stack-list__item--${cdmSeverity(item)}`">
          <div>
            <strong>{{ cdmSeverityLabel(item) }} · {{ item.primary.name }} × {{ item.secondary.name }}</strong>
            <p>{{ item.missDistanceKm.toFixed(1) }} km miss · {{ item.relVelocityKmS.toFixed(1) }} km/s</p>
          </div>
          <small>{{ formatRelative(item.tca) }}</small>
        </article>
        <article v-if="!cdmLoading && !cdmScopeConjunctions.length" class="stack-list__item">
          <div>
            <strong>CDM 결과 없음</strong>
            <p>{{ cdmScope === 'focused' ? '포커스한 위성의 SOCRATES 결과가 없습니다.' : '현재 scope에 표시할 conjunction이 없습니다.' }}</p>
          </div>
          <small>{{ cdmScope }}</small>
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
