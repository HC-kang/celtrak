<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
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
const router = useRouter();
const livePlaybackRate = ref(1);
const resumePlaybackRate = ref(1);
const liveWallClockAnchor = ref(Date.now());
const liveOrbitAnchor = ref(Date.now());
const orbitClockTick = ref(Date.now());
const mapControlsOpen = ref(false);
const mapFocusMode = ref(false);
const mapPanelRef = ref<HTMLElement | null>(null);
const focusedTarget = ref<MapFocusTarget | null>(null);
const hoveredTarget = ref<MapFocusTarget | null>(null);
const focusBackStack = ref<MapFocusTarget[]>([]);
const focusForwardStack = ref<MapFocusTarget[]>([]);
const isPriorityWatchExpanded = ref(false);
const trackingScopeTab = ref<'groundStations' | 'trackedObjects'>('groundStations');
const cdmScope = ref<'tracked' | 'focused' | 'all'>('tracked');
const cdmScopeRecords = ref<ConjunctionRecord[] | null>(null);
const cdmLoading = ref(false);
const cdmError = ref('');
const contactPrecisionResults = ref<Record<string, ContactPrecisionResult>>({});
const contactPrecisionPendingKeys = ref<Set<string>>(new Set());
const addingConjunctionCatalogNumbers = ref<Set<number>>(new Set());
const cdmFeedbackToasts = ref<CdmFeedbackToast[]>([]);
const evidenceDrawer = ref<EvidenceDrawer | null>(null);
const cdmFeedbackDismissTimers = new Map<string, number>();
let orbitClockTimer: number | null = null;
let contactPrecisionWorker: Worker | null = null;
let contactPrecisionRequestId = 0;
const focusHistoryLimit = 8;
usePassPredictions(focusedTarget);

interface CdmFeedbackToast {
  id: string;
  catalogNumber: number;
  name: string;
  state: 'pending' | 'success' | 'error';
  message: string;
  detail?: string;
  retryable?: boolean;
}

type Tone = 'good' | 'warn' | 'critical' | 'info';
type FreshnessState = 'fresh' | 'aging' | 'stale' | 'missing';

interface FreshnessMeta {
  state: FreshnessState;
  label: string;
  detail: string;
  tone: Tone;
  epochIso?: string;
}

interface TrackedObjectSummary {
  key: string;
  ref: FleetMemberRef;
  name: string;
  detail: string;
  source: string;
  sourceDetail: string;
  trustTier: string;
  trustTone: Tone;
  freshness: FreshnessMeta;
  hidden: boolean;
  entry?: CatalogEntry;
  satnogsUrl?: string;
  nextContactLabel: string;
  nextContactTone: Tone;
  riskLabel: string;
  latestStatusLabel: string;
  anomalyCount: number;
}

interface EvidenceRow {
  label: string;
  value: string;
}

interface EvidenceLink {
  label: string;
  href: string;
}

interface EvidenceDrawer {
  title: string;
  subtitle: string;
  sourceDetail: string;
  trustTier: string;
  tone: Tone;
  rows: EvidenceRow[];
  rawLines?: string[];
  links?: EvidenceLink[];
  note?: string;
}

interface ActionSignal {
  id: string;
  kicker: string;
  title: string;
  detail: string;
  time: string;
  tone: Tone;
  sourceDetail: string;
  trustTier: string;
  actionLabel: string;
  action: () => void;
}

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
  for (const timer of cdmFeedbackDismissTimers.values()) {
    window.clearTimeout(timer);
  }
});

const visibleFleetEntries = computed<CatalogEntry[]>(() =>
  (store.selectedFleet?.memberRefs ?? [])
    .filter((member) => member.refType === 'catalog' && !store.isFleetMemberHidden(member))
    .map((member) => {
      const entry = store.catalog.find((entry) => entry.satcat.catalogNumber === member.catalogNumber);
      return entry ? catalogEntryWithDisplayName(entry, member) : null;
    })
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

const trackedObjects = computed<TrackedObjectSummary[]>(() =>
  (store.selectedFleet?.memberRefs ?? []).map((member) => {
    const key = refKey(member);
    if (member.refType === 'catalog') {
      const entry = store.catalog.find((item) => item.satcat.catalogNumber === member.catalogNumber);
      const freshness = catalogFreshness(entry);
      const hidden = store.isFleetMemberHidden(member);
      return {
        key,
        ref: member,
        name: member.displayName ?? entry?.satcat.objectName ?? `NORAD ${member.catalogNumber}`,
        detail: entry ? `NORAD ${entry.satcat.catalogNumber} · ${entry.group} · ${entry.satcat.ownerCountry}` : `NORAD ${member.catalogNumber} · catalog resolving`,
        sourceDetail: entry?.tle ? 'CelesTrak GP TLE' : 'CelesTrak SATCAT only',
        trustTier: trustTierForCatalog(freshness),
        trustTone: trustToneForFreshness(freshness),
        freshness,
        source: 'SATCAT',
        hidden,
        entry,
        satnogsUrl: member.catalogNumber ? satnogsSatelliteUrl(member.catalogNumber) : undefined,
        nextContactLabel: contactSummaryForObject(key),
        nextContactTone: contactToneForObject(key),
        riskLabel: riskLabelForObject(key),
        latestStatusLabel: latestStatusLabelForRef(member),
        anomalyCount: openAnomalyCountForRef(member),
      };
    }
    const custom = store.customTles.find((item) => item.id === member.customTleId);
    const freshness = customTleFreshness(custom?.parsed?.epoch ?? custom?.addedAt);
    return {
      key,
      ref: member,
      name: member.displayName ?? custom?.name ?? 'Custom object',
      detail: `${custom?.format ?? 'CUSTOM'} · ${custom?.sourceLabel ?? 'user supplied elements'}`,
      sourceDetail: 'User-supplied TLE',
      trustTier: 'User supplied',
      trustTone: 'info',
      freshness,
      source: 'USER TLE',
      hidden: store.isFleetMemberHidden(member),
      nextContactLabel: contactSummaryForObject(key),
      nextContactTone: contactToneForObject(key),
      riskLabel: riskLabelForObject(key),
      latestStatusLabel: latestStatusLabelForRef(member),
      anomalyCount: openAnomalyCountForRef(member),
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

const focusedObjectSummary = computed(() => {
  if (focusedTarget.value?.type !== 'satellite') return null;
  return trackedObjects.value.find((item) => item.key === focusedTarget.value?.id) ?? null;
});

const focusedCatalogNumber = computed(() => {
  if (focusedTarget.value?.type !== 'satellite') return null;
  return catalogNumberFromSatelliteId(focusedTarget.value.id);
});

const focusedStation = computed(() => {
  if (focusedTarget.value?.type !== 'groundStation') return null;
  return store.groundStations.find((station) => station.id === focusedTarget.value?.id) ?? null;
});
const previousFocusTarget = computed(() => lastFocusTarget(focusBackStack.value));
const nextFocusTarget = computed(() => lastFocusTarget(focusForwardStack.value));
const focusHistoryItems = computed(() =>
  focusBackStack.value
    .slice()
    .reverse()
    .slice(0, 3)
    .map((target) => ({
      key: focusTargetKey(target),
      target,
      label: focusTargetLabel(target),
    })),
);

const enabledGroundStationCount = computed(() => store.groundStations.filter((station) => station.enabled).length);
const visibleTrackedObjectCount = computed(() => trackedObjects.value.filter((item) => !item.hidden).length);
const hiddenTrackedObjectCount = computed(() => trackedObjects.value.length - visibleTrackedObjectCount.value);
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
const staleCdmRecords = computed(() => cdmScopeConjunctions.value.filter(isStaleConjunction));
const riskSatelliteTones = computed<Record<string, 'warn' | 'critical'>>(() => {
  const tones: Record<string, 'warn' | 'critical'> = {};
  for (const item of cdmScopeConjunctions.value) {
    if (isStaleConjunction(item) || cdmHasPassed(item)) continue;
    const severity = cdmSeverity(item);
    if (severity === 'info') continue;
    addCatalogRiskTone(tones, item.primary.catalogNumber, severity);
    addCatalogRiskTone(tones, item.secondary.catalogNumber, severity);
  }
  for (const item of store.filteredDecayPredictions) {
    if (item.intersectsSelectedFleet) {
      addCatalogRiskTone(tones, item.catalogNumber, 'warn');
    }
  }
  for (const anomaly of store.anomalies) {
    if (anomaly.closedAt || anomaly.severity === 'INFO') continue;
    addRiskTone(tones, refKey(anomaly.satelliteRef), anomaly.severity === 'CRITICAL' ? 'critical' : 'warn');
  }
  return tones;
});
const riskSatelliteIds = computed(() => Object.keys(riskSatelliteTones.value));

const focusedLinks = computed(() => {
  const target = focusedTarget.value;
  if (!target) return contactLinks.value.filter((link) => link.status === 'IN_CONTACT').slice(0, 4);
  return contactLinks.value
    .filter((link) => (target.type === 'satellite' ? link.satelliteId === target.id : link.groundStationId === target.id))
    .slice(0, 6);
});

const focusedConjunctions = computed(() => {
  const target = focusedTarget.value;
  if (target?.type !== 'satellite') return sortedConjunctionsForDisplay(cdmScopeConjunctions.value).slice(0, 3);
  const catalogNumber = focusedCatalogNumber.value;
  if (!catalogNumber) return [];
  return sortedConjunctionsForDisplay(filterConjunctionsByCatalog(cdmScopeConjunctions.value, [catalogNumber])).slice(0, 4);
});

const staleTrackedObjects = computed(() =>
  trackedObjects.value.filter((item) => item.freshness.state === 'stale' || item.freshness.state === 'missing'),
);

const trustOverview = computed(() => [
  {
    label: 'Catalog GP',
    sourceDetail: 'CelesTrak GP / SATCAT',
    trustTier: staleTrackedObjects.value.length ? 'Stale public source' : 'Public source',
    tone: staleTrackedObjects.value.length ? 'warn' : 'good',
    detail: staleTrackedObjects.value.length
      ? `${staleTrackedObjects.value.length} tracked objects need attention`
      : `${trackedObjects.value.length} tracked objects resolved`,
  },
  {
    label: 'Screening',
    sourceDetail: 'CelesTrak SOCRATES',
    trustTier: staleCdmRecords.value.length ? 'Stale public source' : 'Public screening',
    tone: staleCdmRecords.value.length ? 'warn' : cdmScopeConjunctions.value.length ? 'warn' : 'info',
    detail: cdmOverviewDetail(),
  },
  {
    label: 'Space Weather',
    sourceDetail: 'NOAA SWPC',
    trustTier: store.offline ? 'Stale public source' : 'Public source',
    tone: (store.weather?.kp.current ?? 0) >= 4 ? 'warn' : 'good',
    detail: store.weather?.fetchedAt ? `Updated ${formatTimestamp(store.weather.fetchedAt)}` : 'Awaiting SWPC summary',
  },
  {
    label: 'User Layer',
    sourceDetail: 'Local workspace',
    trustTier: 'User supplied',
    tone: store.anomalies.length ? 'warn' : 'info',
    detail: `${store.fleetHealth.recordedMembers}/${store.fleetHealth.totalMembers} readiness records`,
  },
]);

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

const displayedOrbitTime = computed(() => {
  const elapsedMs = orbitClockTick.value - liveWallClockAnchor.value;
  return new Date(liveOrbitAnchor.value + elapsedMs * livePlaybackRate.value);
});
const orbitMode = computed(() => (store.simulationTimeIso ? 'simulation' : 'live'));
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
  const timeKey = store.simulationTimeIso ?? 'live';
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
  { label: 'Public Screening', detail: cdmLayerDetail(), active: cdmScopeConjunctions.value.length > 0 },
  { label: 'Space Weather', detail: store.weather?.kp.storm ?? (store.loading ? '불러오는 중' : '데이터 없음'), active: Boolean(store.weather) },
  { label: 'Decay Watch', detail: `${store.filteredDecayPredictions.length} entries`, active: store.filteredDecayPredictions.length > 0 },
]);

const todayWatch = computed<ActionSignal[]>(() => {
  const items: ActionSignal[] = [];
  const activeLinks = contactLinks.value.filter((link) => link.status === 'IN_CONTACT').slice(0, 2);
  for (const link of activeLinks) {
    items.push({
      id: `watch-contact-${link.satelliteId}-${link.groundStationId}`,
      kicker: 'Now',
      title: `${link.satelliteName} contact active`,
      detail: `${link.groundStationName} · el ${link.elevationDeg.toFixed(1)}° · ${linkStatusLabel(link)}`,
      time: 'Live',
      tone: 'good',
      sourceDetail: 'Derived from TLE',
      trustTier: 'Derived estimate',
      actionLabel: 'Focus on map',
      action: () => focusTargetOnMap(satelliteFocusTarget(link.satelliteId)),
    });
  }

  const nextLinks = contactLinks.value
    .filter((link) => link.status === 'BEFORE_AOS')
    .sort((left, right) => (left.countdownSeconds ?? Number.POSITIVE_INFINITY) - (right.countdownSeconds ?? Number.POSITIVE_INFINITY))
    .slice(0, Math.max(0, 3 - items.length));
  for (const link of nextLinks) {
    items.push({
      id: `watch-aos-${link.satelliteId}-${link.groundStationId}`,
      kicker: 'Next',
      title: `${link.satelliteName} next AOS`,
      detail: `${link.groundStationName} · ${linkStatusLabel(link)}`,
      time: countdownSecondsForLink(link) !== undefined ? formatCountdown(countdownSecondsForLink(link)) : 'Pending',
      tone: 'info',
      sourceDetail: 'Derived from TLE',
      trustTier: 'Derived estimate',
      actionLabel: 'Show contacts',
      action: () => focusTargetOnMap(satelliteFocusTarget(link.satelliteId)),
    });
  }

  for (const item of staleTrackedObjects.value.slice(0, 2)) {
    items.push({
      id: `watch-freshness-${item.key}`,
      kicker: item.freshness.state === 'missing' ? 'Missing data' : 'Freshness',
      title: item.name,
      detail: item.freshness.detail,
      time: item.freshness.label,
      tone: item.freshness.tone,
      sourceDetail: item.sourceDetail,
      trustTier: item.trustTier,
      actionLabel: 'Evidence',
      action: () => openEvidence(buildCatalogEvidence(item)),
    });
  }

  const staleCdm = staleCdmRecords.value[0];
  if (staleCdm) {
    items.push({
      id: `watch-screening-stale-${staleCdm.id}`,
      kicker: 'Source stale',
      title: 'SOCRATES screening fallback',
      detail: cdmFallbackDetail(staleCdm),
      time: staleCdm.fetchedAt ? formatTimestamp(staleCdm.fetchedAt) : 'Fallback',
      tone: 'warn',
      sourceDetail: 'CelesTrak SOCRATES screening',
      trustTier: 'Stale public source',
      actionLabel: 'View evidence',
      action: () => openEvidence(buildConjunctionEvidence(staleCdm)),
    });
  }

  for (const item of upcomingConjunctionSignals(2)) {
    const severity = cdmSeverity(item);
    items.push({
      id: `watch-screening-${item.id}`,
      kicker: 'Screening',
      title: `${item.primary.name} x ${item.secondary.name}`,
      detail: `${item.missDistanceKm.toFixed(1)} km miss · public SOCRATES signal`,
      time: formatOrbitRelative(item.tca),
      tone: severity,
      sourceDetail: 'CelesTrak SOCRATES screening',
      trustTier: 'Public screening',
      actionLabel: 'Review signal',
      action: () => openEvidence(buildConjunctionEvidence(item)),
    });
  }

  const kp = store.weather?.kp.current ?? null;
  const flareClass = store.weather?.xray.flareClass;
  if ((kp !== null && kp >= 4) || flareClass === 'M' || flareClass === 'X') {
    items.push({
      id: 'watch-space-weather',
      kicker: 'Environment',
      title: `Space weather ${store.weather?.kp.storm ?? 'signal'}`,
      detail: `Kp ${kp ?? '—'} · X-ray ${flareClass ?? '—'}${store.weather?.xray.classMagnitude ?? ''}`,
      time: store.weather?.fetchedAt ? formatTimestamp(store.weather.fetchedAt) : 'Awaiting',
      tone: kp !== null && kp >= 5 ? 'critical' : 'warn',
      sourceDetail: 'NOAA SWPC',
      trustTier: store.offline ? 'Stale public source' : 'Public source',
      actionLabel: 'Evidence',
      action: () => openEvidence(buildWeatherEvidence()),
    });
  }

  const openAnomaly = store.anomalies.find((item) => !item.closedAt && item.severity !== 'INFO');
  if (openAnomaly) {
    items.push({
      id: `watch-anomaly-${openAnomaly.id}`,
      kicker: 'User issue',
      title: `${openAnomaly.severity} · ${openAnomaly.subsystem || 'GENERAL'}`,
      detail: truncate(openAnomaly.description, 96),
      time: formatRelative(openAnomaly.openedAt),
      tone: openAnomaly.severity === 'CRITICAL' ? 'critical' : 'warn',
      sourceDetail: 'User-entered',
      trustTier: 'User supplied',
      actionLabel: 'Add note',
      action: goToFleetNotes,
    });
  }

  const upcomingEvent = store.upcomingEvents[0];
  if (upcomingEvent) {
    items.push({
      id: `watch-event-${upcomingEvent.id}`,
      kicker: 'Schedule',
      title: upcomingEvent.title,
      detail: upcomingEvent.notes ? truncate(upcomingEvent.notes, 96) : `Scheduled ${upcomingEvent.kind.toLowerCase()} event`,
      time: formatRelative(upcomingEvent.startAt),
      tone: 'info',
      sourceDetail: 'User-entered',
      trustTier: 'User supplied',
      actionLabel: 'Open schedule',
      action: goToStations,
    });
  }

  return items.slice(0, 8);
});

const intelQueue = computed<ActionSignal[]>(() =>
  [
    ...store.alerts.map((alert) => ({
      id: `alert-${alert.id}`,
      kicker: formatKicker(alert.kind),
      title: alert.title,
      detail: alert.detail,
      time: 'Live',
      tone: alert.tone as Tone,
      sourceDetail: alert.kind === 'weather' ? 'NOAA SWPC' : 'Local workspace',
      trustTier: alert.kind === 'weather' ? 'Public source' : 'Public signal',
      actionLabel: alert.kind === 'weather' ? 'Evidence' : 'Review',
      action: alert.kind === 'weather' ? () => openEvidence(buildWeatherEvidence()) : goToFleetNotes,
    })),
    ...staleCdmRecords.value.slice(0, 1).map((item) => ({
      id: `cdm-stale-${item.id}`,
      kicker: 'Source stale',
      title: 'SOCRATES screening fallback',
      detail: cdmFallbackDetail(item),
      time: item.fetchedAt ? formatTimestamp(item.fetchedAt) : 'Fallback',
      tone: 'warn' as Tone,
      sourceDetail: 'CelesTrak SOCRATES screening',
      trustTier: 'Stale public source',
      actionLabel: 'View evidence',
      action: () => openEvidence(buildConjunctionEvidence(item)),
    })),
    ...upcomingConjunctionSignals(2).map((item) => ({
      id: `conjunction-${item.id}`,
      kicker: 'Screening',
      title: `${item.primary.name} × ${item.secondary.name}`,
      detail: `${item.missDistanceKm.toFixed(1)} km miss · public SOCRATES signal`,
      time: formatOrbitRelative(item.tca),
      tone: cdmSeverity(item),
      sourceDetail: 'CelesTrak SOCRATES screening',
      trustTier: 'Public screening',
      actionLabel: 'Evidence',
      action: () => openEvidence(buildConjunctionEvidence(item)),
    })),
    ...store.filteredDecayPredictions.slice(0, 1).map((item) => ({
      id: `decay-${item.catalogNumber}`,
      kicker: 'Decay',
      title: item.name,
      detail: `${item.confidence} confidence · ${item.intersectsSelectedFleet ? 'selected fleet' : 'catalog only'}`,
      time: formatRelative(item.predictedDecayAt),
      tone: item.intersectsSelectedFleet ? 'warn' : 'info',
      sourceDetail: 'CelesTrak decay feed',
      trustTier: store.offline ? 'Stale public source' : 'Public source',
      actionLabel: 'Evidence',
      action: () => openEvidence(buildDecayEvidence(item)),
    })),
    ...store.upcomingEvents.slice(0, 2).map((event) => ({
      id: `event-${event.id}`,
      kicker: event.kind,
      title: event.title,
      detail: event.notes ? truncate(event.notes, 86) : 'Scheduled user operation',
      time: formatRelative(event.startAt),
      tone: 'info',
      sourceDetail: 'User-entered',
      trustTier: 'User supplied',
      actionLabel: 'Open schedule',
      action: goToStations,
    })),
  ].slice(0, 7),
);

function formatKicker(value: string) {
  return value
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function goToFleetNotes() {
  void router.push('/fleets');
}

function goToStations() {
  void router.push('/stations');
}

function openEvidence(drawer: EvidenceDrawer) {
  evidenceDrawer.value = drawer;
}

function closeEvidence() {
  evidenceDrawer.value = null;
}

function catalogFreshness(entry: CatalogEntry | undefined): FreshnessMeta {
  if (!entry?.tle) {
    return {
      state: 'missing',
      label: 'Missing TLE',
      detail: 'No TLE is available for map, pass, or contact derivation.',
      tone: 'critical',
    };
  }
  const epochIso = tleEpochIso(entry);
  if (!epochIso) {
    return {
      state: 'missing',
      label: 'Epoch unknown',
      detail: 'The TLE epoch could not be parsed from the public source.',
      tone: 'warn',
    };
  }
  return freshnessFromEpoch(epochIso, 'TLE epoch');
}

function customTleFreshness(epochIso?: string): FreshnessMeta {
  if (!epochIso) {
    return {
      state: 'aging',
      label: 'User TLE',
      detail: 'User-supplied element set; epoch is not available in the current workspace summary.',
      tone: 'info',
    };
  }
  return freshnessFromEpoch(epochIso, 'User TLE epoch');
}

function freshnessFromEpoch(epochIso: string, label: string): FreshnessMeta {
  const epochMs = new Date(epochIso).getTime();
  const ageDays = Number.isFinite(epochMs) ? Math.max(0, (Date.now() - epochMs) / 86_400_000) : Number.NaN;
  if (!Number.isFinite(ageDays)) {
    return {
      state: 'missing',
      label: 'Epoch unknown',
      detail: `${label} could not be parsed.`,
      tone: 'warn',
      epochIso,
    };
  }
  if (ageDays <= 3) {
    return {
      state: 'fresh',
      label: 'Fresh',
      detail: `${label} ${formatAge(ageDays)} old`,
      tone: 'good',
      epochIso,
    };
  }
  if (ageDays <= 14) {
    return {
      state: 'aging',
      label: 'Aging',
      detail: `${label} ${formatAge(ageDays)} old`,
      tone: 'warn',
      epochIso,
    };
  }
  return {
    state: 'stale',
    label: 'Stale',
    detail: `${label} ${formatAge(ageDays)} old`,
    tone: 'critical',
    epochIso,
  };
}

function formatAge(ageDays: number) {
  if (ageDays < 1) return `${Math.max(1, Math.round(ageDays * 24))}h`;
  if (ageDays < 365) return `${ageDays < 10 ? ageDays.toFixed(1) : Math.round(ageDays)}d`;
  return `${(ageDays / 365).toFixed(1)}y`;
}

function tleEpochIso(entry: CatalogEntry | undefined) {
  if (entry?.orbital?.epoch) return entry.orbital.epoch;
  const line1 = entry?.tle?.line1;
  if (!line1 || line1.length < 32) return null;
  const rawEpoch = line1.slice(18, 32).trim();
  const yearPart = Number(rawEpoch.slice(0, 2));
  const dayPart = Number(rawEpoch.slice(2));
  if (!Number.isFinite(yearPart) || !Number.isFinite(dayPart)) return null;
  const year = yearPart < 57 ? 2000 + yearPart : 1900 + yearPart;
  const timestamp = Date.UTC(year, 0, 1) + (dayPart - 1) * 86_400_000;
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function trustTierForCatalog(freshness: FreshnessMeta) {
  if (freshness.state === 'missing') return 'Source incomplete';
  if (freshness.state === 'stale' || store.offline) return 'Stale public source';
  return 'Public source';
}

function trustToneForFreshness(freshness: FreshnessMeta): Tone {
  if (freshness.state === 'fresh') return store.offline ? 'warn' : 'good';
  if (freshness.state === 'aging') return 'warn';
  return freshness.tone;
}

function contactSummaryForObject(id: string) {
  const active = contactLinks.value.find((link) => link.satelliteId === id && link.status === 'IN_CONTACT');
  if (active) return `Active contact · ${active.groundStationName}`;
  const next = contactLinks.value
    .filter((link) => link.satelliteId === id && link.status === 'BEFORE_AOS')
    .sort((left, right) => (left.countdownSeconds ?? Number.POSITIVE_INFINITY) - (right.countdownSeconds ?? Number.POSITIVE_INFINITY))[0];
  if (next) return `Next AOS · ${next.groundStationName} · ${formatCountdown(countdownSecondsForLink(next))}`;
  return 'No contact window in current horizon';
}

function contactToneForObject(id: string): Tone {
  if (contactLinks.value.some((link) => link.satelliteId === id && link.status === 'IN_CONTACT')) return 'good';
  if (contactLinks.value.some((link) => link.satelliteId === id && link.status === 'BEFORE_AOS')) return 'info';
  return 'warn';
}

function riskLabelForObject(id: string) {
  const riskTone = riskSatelliteTones.value[id];
  if (riskTone === 'critical') return 'High-priority screening';
  if (riskTone === 'warn') return 'Screening signal';
  return 'No current public risk signal';
}

function latestStatusLabelForRef(refItem: FleetMemberRef) {
  const latest = store.opsStatuses[refKey(refItem)]?.[0];
  if (!latest) return 'No user status';
  return `${latest.mcStatus} · ${latest.rfStatus}`;
}

function openAnomalyCountForRef(refItem: FleetMemberRef) {
  return store.anomalies.filter((item) => !item.closedAt && sameFleetRef(item.satelliteRef, refItem)).length;
}

function sameFleetRef(left: FleetMemberRef, right: FleetMemberRef) {
  if (left.refType !== right.refType) return false;
  return left.refType === 'catalog' ? left.catalogNumber === right.catalogNumber : left.customTleId === right.customTleId;
}

function sourceClass(tone: Tone | FreshnessState) {
  return `source-chip--${tone}`;
}

function satnogsSatelliteUrl(catalogNumber: number) {
  return `https://db.satnogs.org/satellite/${catalogNumber}/`;
}

function buildCatalogEvidence(item: TrackedObjectSummary): EvidenceDrawer {
  const catalogNumber = item.ref.catalogNumber ?? item.entry?.satcat.catalogNumber;
  return {
    title: item.name,
    subtitle: item.entry ? `NORAD ${item.entry.satcat.catalogNumber} · ${item.entry.group}` : item.detail,
    sourceDetail: item.sourceDetail,
    trustTier: item.trustTier,
    tone: item.trustTone,
    rows: [
      { label: 'Freshness', value: `${item.freshness.label} · ${item.freshness.detail}` },
      { label: 'Origin', value: item.entry?.origin ?? item.source },
      { label: 'Fetched at', value: formatTimestamp(item.entry?.fetchedAt ?? item.entry?.satcat.fetchedAt) },
      { label: 'TLE epoch', value: item.freshness.epochIso ? formatTimestamp(item.freshness.epochIso) : 'Not available' },
      { label: 'SATCAT status', value: item.entry?.satcat.opsStatusCode ?? 'Not resolved' },
      { label: 'Object type', value: item.entry?.satcat.objectType ?? 'Unknown' },
      { label: 'Owner', value: item.entry?.satcat.ownerCountry ?? 'Unknown' },
      { label: 'Contact context', value: item.nextContactLabel },
      { label: 'User status', value: item.latestStatusLabel },
      { label: 'Open anomalies', value: String(item.anomalyCount) },
    ],
    rawLines: item.entry?.tle ? [item.entry.tle.line0 ?? item.name, item.entry.tle.line1, item.entry.tle.line2] : undefined,
    links: catalogNumber
      ? [
          { label: 'CelesTrak GP', href: `https://celestrak.org/NORAD/elements/gp.php?CATNR=${catalogNumber}&FORMAT=tle` },
          { label: 'CelesTrak SATCAT', href: `https://celestrak.org/satcat/records.php?CATNR=${catalogNumber}&FORMAT=JSON` },
          { label: 'SatNOGS public reference', href: satnogsSatelliteUrl(catalogNumber) },
        ]
      : undefined,
    note: 'This is a public-source operating picture. Celtrak does not independently validate the orbit or operator status.',
  };
}

function buildConjunctionEvidence(item: ConjunctionRecord): EvidenceDrawer {
  return {
    title: `${item.primary.name} x ${item.secondary.name}`,
    subtitle: isStaleConjunction(item) ? 'Stale public screening fallback' : 'Public conjunction screening signal',
    sourceDetail: isStaleConjunction(item) ? 'CelesTrak SOCRATES fallback' : 'CelesTrak SOCRATES screening',
    trustTier: isStaleConjunction(item) || store.offline ? 'Stale public source' : 'Public screening',
    tone: cdmEvidenceTone(item),
    rows: [
      { label: 'Celtrak interpretation', value: cdmSeverityLabel(item) },
      { label: 'Primary', value: objectRefLabel(item.primary) },
      { label: 'Secondary', value: objectRefLabel(item.secondary) },
      { label: 'TCA', value: formatTimestamp(item.tca) },
      { label: 'Relative to orbit clock', value: formatOrbitRelative(item.tca) },
      { label: 'Miss distance', value: `${item.missDistanceKm.toFixed(2)} km` },
      { label: 'Relative velocity', value: `${item.relVelocityKmS.toFixed(2)} km/s` },
      { label: 'Pc', value: item.pc !== undefined ? item.pc.toExponential(2) : 'Not published' },
      { label: 'Fetched at', value: formatTimestamp(item.fetchedAt) },
      { label: 'Source', value: item.source },
      ...(item.note ? [{ label: 'Fallback note', value: item.note }] : []),
    ],
    links: [{ label: 'CelesTrak SOCRATES', href: 'https://celestrak.org/SOCRATES/' }],
    note: isStaleConjunction(item)
      ? 'This row is a stale fallback because Celtrak could not fetch the live CelesTrak SOCRATES file. Do not treat it as a current screening result.'
      : 'SOCRATES is treated as a public screening signal. Operator-confirmed collision-avoidance data is not available, so this is not a maneuver recommendation.',
  };
}

function buildWeatherEvidence(): EvidenceDrawer {
  return {
    title: 'Space Weather',
    subtitle: 'NOAA SWPC public environment signal',
    sourceDetail: 'NOAA SWPC',
    trustTier: store.offline ? 'Stale public source' : 'Public source',
    tone: (store.weather?.kp.current ?? 0) >= 4 ? 'warn' : 'info',
    rows: [
      { label: 'Kp', value: `${store.weather?.kp.current ?? '—'}` },
      { label: 'Storm tier', value: store.weather?.kp.storm ?? '—' },
      { label: 'X-ray class', value: `${store.weather?.xray.flareClass ?? '—'}${store.weather?.xray.classMagnitude ?? ''}` },
      { label: 'Current flux', value: store.weather?.xray.currentWm2 ? `${store.weather.xray.currentWm2.toExponential(2)} W/m²` : '—' },
      { label: 'Fetched at', value: formatTimestamp(store.weather?.fetchedAt) },
    ],
    links: [
      { label: 'NOAA SWPC JSON', href: 'https://services.swpc.noaa.gov/json/' },
      { label: 'SWPC alerts', href: 'https://services.swpc.noaa.gov/products/alerts.json' },
    ],
    note: 'Space weather values are public environmental signals. They do not confirm a specific spacecraft anomaly.',
  };
}

function buildDecayEvidence(item: { catalogNumber: number; name: string; predictedDecayAt: string; confidence: string; fetchedAt: string; source: string; intersectsSelectedFleet?: boolean }): EvidenceDrawer {
  return {
    title: item.name,
    subtitle: 'Public decay forecast',
    sourceDetail: 'CelesTrak decay feed',
    trustTier: store.offline ? 'Stale public source' : 'Public source',
    tone: item.intersectsSelectedFleet ? 'warn' : 'info',
    rows: [
      { label: 'NORAD', value: String(item.catalogNumber) },
      { label: 'Predicted decay', value: formatTimestamp(item.predictedDecayAt) },
      { label: 'Confidence', value: item.confidence },
      { label: 'Source', value: item.source },
      { label: 'Fetched at', value: formatTimestamp(item.fetchedAt) },
    ],
    links: [{ label: 'CelesTrak decay', href: 'https://celestrak.org/NORAD/elements/decay/' }],
    note: 'Decay forecasts are OSINT signals and should be read as public monitoring context.',
  };
}

function buildPassEvidence(link: LiveContactLink): EvidenceDrawer {
  return {
    title: `${link.satelliteName} -> ${link.groundStationName}`,
    subtitle: 'Derived contact window',
    sourceDetail: 'Derived from TLE',
    trustTier: 'Derived estimate',
    tone: link.status === 'IN_CONTACT' ? 'good' : 'info',
    rows: [
      { label: 'Status', value: link.status },
      { label: 'Elevation', value: `${link.elevationDeg.toFixed(2)}°` },
      { label: 'Azimuth', value: `${link.azimuthDeg.toFixed(1)}°` },
      { label: 'AOS', value: link.aos ? formatTimestamp(link.aos) : 'Not resolved' },
      { label: 'TCA', value: link.tca ? formatTimestamp(link.tca) : 'Not resolved' },
      { label: 'LOS', value: link.los ? formatTimestamp(link.los) : 'Not resolved' },
      { label: 'Countdown', value: linkStatusLabel(link) },
      { label: 'Basis', value: 'SGP4 look-angle calculation using public/user TLE and local station mask' },
    ],
    note: 'Contact windows are derived estimates. They are not ground-station telemetry or confirmed RF contact.',
  };
}

function objectRefLabel(item: ConjunctionRecord['primary']) {
  return item.catalogNumber ? `${item.name} · NORAD ${item.catalogNumber}` : item.name;
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
  const nextTimeIso = new Date(baseMs + hours * 60 * 60 * 1000).toISOString();
  store.setSimulationTime(nextTimeIso);
  anchorOrbitPlayback(nextTimeIso);
}

function setOrbitTime(value: string | null) {
  if (!value) {
    resetLiveOrbit();
    return;
  }
  store.setSimulationTime(value);
  anchorOrbitPlayback(value);
}

function resetLiveOrbit() {
  const wallNow = Date.now();
  livePlaybackRate.value = 1;
  resumePlaybackRate.value = 1;
  liveWallClockAnchor.value = wallNow;
  liveOrbitAnchor.value = wallNow;
  orbitClockTick.value = wallNow;
  store.resetSimulationTime();
}

function anchorOrbitPlayback(orbitTimeIso: string) {
  const nextTimeMs = new Date(orbitTimeIso).getTime();
  const wallNow = Date.now();
  liveWallClockAnchor.value = wallNow;
  liveOrbitAnchor.value = Number.isFinite(nextTimeMs) ? nextTimeMs : wallNow;
  orbitClockTick.value = wallNow;
}

function setPlaybackRate(rate: number) {
  const normalizedRate = normalizePlaybackRate(rate);
  if (livePlaybackRate.value === 0 && normalizedRate !== 0) {
    resumePlaybackRate.value = normalizedRate;
    return;
  }
  applyPlaybackRate(normalizedRate);
}

function togglePlaybackPause() {
  applyPlaybackRate(livePlaybackRate.value === 0 ? resumePlaybackRate.value : 0);
}

function applyPlaybackRate(rate: number) {
  const currentDisplayedMs = displayedOrbitTime.value.getTime();
  const wallNow = Date.now();
  livePlaybackRate.value = rate;
  if (rate !== 0) {
    resumePlaybackRate.value = rate;
  }
  liveWallClockAnchor.value = wallNow;
  liveOrbitAnchor.value = Number.isFinite(currentDisplayedMs) ? currentDisplayedMs : wallNow;
  orbitClockTick.value = wallNow;
}

function normalizePlaybackRate(rate: number) {
  if (rate === 0) return 0;
  const direction = rate < 0 ? -1 : 1;
  const magnitude = Math.min(Math.max(Math.round(Math.abs(rate)), 1), 300);
  return direction * magnitude;
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
  commitFocusedTarget(target);
}

function focusTargetOnMap(target: MapFocusTarget) {
  commitFocusedTarget(target);
  scrollMapPanelIntoView();
}

function commitFocusedTarget(target: MapFocusTarget) {
  const nextTarget = cloneFocusTarget(target);
  if (focusTargetMatches(focusedTarget.value, nextTarget)) return;
  if (focusedTarget.value) {
    pushFocusHistory(focusBackStack, focusedTarget.value);
  }
  focusBackStack.value = removeFocusTargetFromStack(focusBackStack.value, nextTarget);
  focusForwardStack.value = [];
  focusedTarget.value = nextTarget;
}

function restorePreviousFocusTarget() {
  const previous = previousFocusTarget.value;
  if (!previous) return;
  focusBackStack.value = focusBackStack.value.slice(0, -1);
  if (focusedTarget.value) {
    pushFocusHistory(focusForwardStack, focusedTarget.value);
  }
  focusedTarget.value = cloneFocusTarget(previous);
  scrollMapPanelIntoView();
}

function restoreNextFocusTarget() {
  const next = nextFocusTarget.value;
  if (!next) return;
  focusForwardStack.value = focusForwardStack.value.slice(0, -1);
  if (focusedTarget.value) {
    pushFocusHistory(focusBackStack, focusedTarget.value);
  }
  focusedTarget.value = cloneFocusTarget(next);
  scrollMapPanelIntoView();
}

function scrollMapPanelIntoView() {
  window.requestAnimationFrame(() => {
    mapPanelRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function clearFocusedTarget() {
  if (focusedTarget.value) {
    pushFocusHistory(focusBackStack, focusedTarget.value);
  }
  focusForwardStack.value = [];
  focusedTarget.value = null;
}

function pushFocusHistory(stack: typeof focusBackStack, target: MapFocusTarget) {
  const cleanStack = stack.value.filter((item) => !focusTargetMatches(item, target));
  cleanStack.push(cloneFocusTarget(target));
  stack.value = cleanStack.slice(-focusHistoryLimit);
}

function removeFocusTargetFromStack(stack: MapFocusTarget[], target: MapFocusTarget) {
  return stack.filter((item) => !focusTargetMatches(item, target));
}

function lastFocusTarget(stack: MapFocusTarget[]) {
  return stack.length ? stack[stack.length - 1] : null;
}

function cloneFocusTarget(target: MapFocusTarget): MapFocusTarget {
  return { type: target.type, id: target.id };
}

function focusTargetKey(target: MapFocusTarget) {
  return `${target.type}:${target.id}`;
}

function focusTargetLabel(target: MapFocusTarget | null | undefined) {
  if (!target) return '';
  if (target.type === 'groundStation') return stationLookup.value[target.id] ?? target.id;
  const catalogNumber = catalogNumberFromSatelliteId(target.id);
  return satelliteLookup.value[target.id] ?? (catalogNumber ? `NORAD ${catalogNumber}` : target.id);
}

function satelliteFocusTarget(id: string): MapFocusTarget {
  return { type: 'satellite', id };
}

function groundStationFocusTarget(id: string): MapFocusTarget {
  return { type: 'groundStation', id };
}

function conjunctionObjectTarget(item: ConjunctionRecord['primary']) {
  return item.catalogNumber ? satelliteFocusTarget(`catalog:${item.catalogNumber}`) : null;
}

function isUnresolvedConjunctionObject(item: ConjunctionRecord['primary']) {
  return Boolean(item.catalogNumber && item.name.trim().toUpperCase() === 'UNKNOWN');
}

function isConjunctionObjectTracked(item: ConjunctionRecord['primary']) {
  return Boolean(item.catalogNumber && store.selectedFleetCatalogNumbers.includes(item.catalogNumber));
}

function isAddingConjunctionObject(item: ConjunctionRecord['primary']) {
  return Boolean(item.catalogNumber && addingConjunctionCatalogNumbers.value.has(item.catalogNumber));
}

function conjunctionChipClasses(item: ConjunctionRecord['primary']) {
  const target = conjunctionObjectTarget(item);
  const tracked = isConjunctionObjectTracked(item);
  return {
    'focus-inspector__chip--active': tracked && focusTargetMatches(focusedTarget.value, target),
    'focus-inspector__chip--preview':
      tracked && focusTargetMatches(hoveredTarget.value, target) && !focusTargetMatches(focusedTarget.value, target),
    'focus-inspector__chip--addable': Boolean(target && !tracked && !isUnresolvedConjunctionObject(item)),
    'focus-inspector__chip--unavailable': Boolean(target && !tracked && isUnresolvedConjunctionObject(item)),
    'focus-inspector__chip--loading': isAddingConjunctionObject(item),
  };
}

function conjunctionChipLabel(item: ConjunctionRecord['primary']) {
  if (!item.catalogNumber) return item.name;
  if (isUnresolvedConjunctionObject(item)) return `${item.name} 추적 추가 불가`;
  return isConjunctionObjectTracked(item) ? item.name : `${item.name} 추적 추가`;
}

async function activateConjunctionObject(item: ConjunctionRecord['primary']) {
  const target = conjunctionObjectTarget(item);
  if (!target || !item.catalogNumber) return;
  if (isConjunctionObjectTracked(item)) {
    focusTargetOnMap(target);
    return;
  }
  if (isUnresolvedConjunctionObject(item)) {
    showCdmFeedback({
      catalogNumber: item.catalogNumber,
      name: item.name,
      state: 'error',
      message: `${item.name} 추적 추가를 할 수 없습니다.`,
      detail: `SOCRATES CDM에는 위험 객체로 보고됐지만 CelesTrak catalog/TLE 식별자가 공개되지 않아 지도 추적에 추가할 수 없습니다.`,
      retryable: false,
    });
    return;
  }

  showCdmFeedback({
    catalogNumber: item.catalogNumber,
    name: item.name,
    state: 'pending',
    message: `${item.name} 추적 추가를 요청했습니다.`,
    detail: `NORAD ${item.catalogNumber} catalog/TLE 조회 중`,
  });
  addingConjunctionCatalogNumbers.value = new Set([...addingConjunctionCatalogNumbers.value, item.catalogNumber]);
  let addedEntry: CatalogEntry | null = null;
  try {
    const added = await store.addCatalogNumberToFleet(item.catalogNumber);
    if (!added) throw new Error('선택된 플릿을 찾을 수 없습니다.');
    addedEntry = added;
  } catch (error) {
    showCdmFeedback({
      catalogNumber: item.catalogNumber,
      name: item.name,
      state: 'error',
      message: `${item.name} 추적 추가에 실패했습니다.`,
      detail: cdmAddErrorDetail(error, item.catalogNumber),
    });
    return;
  } finally {
    const next = new Set(addingConjunctionCatalogNumbers.value);
    next.delete(item.catalogNumber);
    addingConjunctionCatalogNumbers.value = next;
  }
  if (!addedEntry) return;
  focusTargetOnMap(target);
  showCdmFeedback({
    catalogNumber: item.catalogNumber,
    name: item.name,
    state: 'success',
    message: `${addedEntry.satcat.objectName} 추적을 추가했습니다.`,
    detail: `NORAD ${addedEntry.satcat.catalogNumber} · ${addedEntry.tle ? 'TLE 포함' : 'SATCAT만 수신'}`,
  });
}

async function retryCdmFeedback(toast: CdmFeedbackToast) {
  await activateConjunctionObject({ name: toast.name, catalogNumber: toast.catalogNumber });
}

function cdmFeedbackStateLabel(state: CdmFeedbackToast['state']) {
  if (state === 'success') return '성공';
  if (state === 'error') return '실패';
  return '요청';
}

function cdmAddErrorDetail(error: unknown, catalogNumber: number) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('TLE/SATCAT을 찾지 못했습니다')) return message;
  if (message.includes('catalog snapshot unavailable')) {
    return `내부 catalog snapshot이 아직 준비되지 않아 NORAD ${catalogNumber} 조회를 완료하지 못했습니다. 잠시 후 재시도하세요.`;
  }
  if (message.includes('timed out')) {
    return `Catalog 조회 응답 지연으로 NORAD ${catalogNumber} 조회가 중단됐습니다. 잠시 후 재시도하세요.`;
  }
  if (message.includes('returned 502') || message.includes('API upstream failed')) {
    return `공개 catalog 데이터 조회가 실패했습니다. 잠시 후 재시도하세요.`;
  }
  return message || 'catalog/TLE 조회 중 알 수 없는 오류가 발생했습니다.';
}

function showCdmFeedback(input: Omit<CdmFeedbackToast, 'id'>) {
  const toast: CdmFeedbackToast = {
    ...input,
    id: cdmFeedbackToastId(input.catalogNumber),
  };
  const existingTimer = cdmFeedbackDismissTimers.get(toast.id);
  if (existingTimer) {
    window.clearTimeout(existingTimer);
    cdmFeedbackDismissTimers.delete(toast.id);
  }
  const index = cdmFeedbackToasts.value.findIndex((item) => item.id === toast.id);
  if (index >= 0) {
    cdmFeedbackToasts.value = cdmFeedbackToasts.value.map((item) => (item.id === toast.id ? toast : item));
  } else {
    cdmFeedbackToasts.value = [toast, ...cdmFeedbackToasts.value].slice(0, 3);
  }
  if (toast.state !== 'pending') {
    const timer = window.setTimeout(() => dismissCdmFeedback(toast.id), toast.state === 'success' ? 7000 : 12_000);
    cdmFeedbackDismissTimers.set(toast.id, timer);
  }
}

function dismissCdmFeedback(id: string) {
  const timer = cdmFeedbackDismissTimers.get(id);
  if (timer) {
    window.clearTimeout(timer);
    cdmFeedbackDismissTimers.delete(id);
  }
  cdmFeedbackToasts.value = cdmFeedbackToasts.value.filter((toast) => toast.id !== id);
}

function cdmFeedbackToastId(catalogNumber: number) {
  return `cdm-add-${catalogNumber}`;
}

function setHoveredTarget(target: MapFocusTarget | null) {
  hoveredTarget.value = target;
}

function clearHoveredTarget(target: MapFocusTarget | null) {
  if (!target || focusTargetMatches(hoveredTarget.value, target)) {
    hoveredTarget.value = null;
  }
}

function focusTargetMatches(left: MapFocusTarget | null | undefined, right: MapFocusTarget | null | undefined) {
  return Boolean(left && right && left.type === right.type && left.id === right.id);
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

function formatOrbitRelative(value?: string) {
  if (!value) return '알 수 없음';
  const targetMs = new Date(value).getTime();
  const baseMs = displayedOrbitTime.value.getTime();
  if (!Number.isFinite(targetMs) || !Number.isFinite(baseMs)) return '알 수 없음';
  const deltaMs = targetMs - baseMs;
  const suffix = deltaMs >= 0 ? '후' : '전';
  const absMinutes = Math.max(0, Math.round(Math.abs(deltaMs) / 60000));
  if (absMinutes < 1) return `1분 미만 ${suffix}`;
  if (absMinutes < 60) return `${absMinutes}분 ${suffix}`;
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  return minutes ? `${hours}시간 ${minutes}분 ${suffix}` : `${hours}시간 ${suffix}`;
}

function cdmSeverity(item: ConjunctionRecord) {
  return classifyConjunctionSeverity(item);
}

function isStaleConjunction(item: ConjunctionRecord) {
  return Boolean(item.stale || item.origin === 'STALE');
}

function cdmOverviewDetail() {
  if (staleCdmRecords.value.length) return `${staleCdmRecords.value.length} stale fallback · ${cdmFallbackDetail(staleCdmRecords.value[0])}`;
  return `${cdmScopeConjunctions.value.length} public screening signals`;
}

function cdmLayerDetail() {
  if (staleCdmRecords.value.length) return `${staleCdmRecords.value.length} stale fallback`;
  return `${cdmScopeConjunctions.value.length} ${cdmScope.value} signals`;
}

function cdmFallbackDetail(item: ConjunctionRecord) {
  return item.note ? `Upstream unavailable: ${item.note}` : 'Live SOCRATES file unavailable';
}

function cdmHasPassed(item: ConjunctionRecord) {
  const tcaMs = new Date(item.tca).getTime();
  const baseMs = displayedOrbitTime.value.getTime();
  return Number.isFinite(tcaMs) && Number.isFinite(baseMs) && tcaMs < baseMs;
}

function cdmDisplayTone(item: ConjunctionRecord) {
  if (isStaleConjunction(item)) return 'warn';
  return cdmHasPassed(item) ? 'passed' : cdmSeverity(item);
}

function cdmEvidenceTone(item: ConjunctionRecord): Tone {
  if (isStaleConjunction(item)) return 'warn';
  return cdmHasPassed(item) ? 'info' : cdmSeverity(item);
}

function cdmSourceChipLabel(item: ConjunctionRecord) {
  if (isStaleConjunction(item)) return 'Stale fallback';
  return cdmHasPassed(item) ? 'Past public signal' : 'Public screening';
}

function cdmSourceChipClass(item: ConjunctionRecord) {
  if (isStaleConjunction(item)) return 'source-chip--stale';
  return cdmHasPassed(item) ? 'source-chip--neutral' : 'source-chip--warn';
}

function sortedConjunctionsForDisplay(records: ConjunctionRecord[]) {
  return [...records].sort((left, right) => {
    const leftStale = isStaleConjunction(left);
    const rightStale = isStaleConjunction(right);
    if (leftStale !== rightStale) return leftStale ? 1 : -1;
    const leftPassed = cdmHasPassed(left);
    const rightPassed = cdmHasPassed(right);
    if (leftPassed !== rightPassed) return leftPassed ? 1 : -1;
    if (!leftPassed) {
      return (
        new Date(left.tca).getTime() - new Date(right.tca).getTime() ||
        conjunctionSeverityRank(cdmSeverity(left)) - conjunctionSeverityRank(cdmSeverity(right))
      );
    }
    return new Date(right.tca).getTime() - new Date(left.tca).getTime();
  });
}

function upcomingConjunctionSignals(limit: number) {
  const nowMs = displayedOrbitTime.value.getTime();
  return cdmScopeConjunctions.value
    .filter((item) => {
      if (isStaleConjunction(item)) return false;
      const tcaMs = new Date(item.tca).getTime();
      return Number.isFinite(tcaMs) && tcaMs >= nowMs;
    })
    .sort((left, right) => {
      const leftMs = new Date(left.tca).getTime();
      const rightMs = new Date(right.tca).getTime();
      return leftMs - rightMs || conjunctionSeverityRank(cdmSeverity(left)) - conjunctionSeverityRank(cdmSeverity(right));
    })
    .slice(0, limit);
}

function filterConjunctionsByCatalog(records: ConjunctionRecord[], catalogNumbers: number[]) {
  const catalogNumberSet = new Set(catalogNumbers);
  return records.filter(
    (item) =>
      (item.primary.catalogNumber !== undefined && catalogNumberSet.has(item.primary.catalogNumber)) ||
      (item.secondary.catalogNumber !== undefined && catalogNumberSet.has(item.secondary.catalogNumber)),
  );
}

function addCatalogRiskTone(tones: Record<string, 'warn' | 'critical'>, catalogNumber: number | undefined, tone: 'warn' | 'critical') {
  if (catalogNumber) {
    addRiskTone(tones, `catalog:${catalogNumber}`, tone);
  }
}

function addRiskTone(tones: Record<string, 'warn' | 'critical'>, id: string, tone: 'warn' | 'critical') {
  if (tones[id] === 'critical') return;
  tones[id] = tone;
}

function cdmSeverityLabel(item: ConjunctionRecord) {
  if (isStaleConjunction(item)) return 'Stale screening fallback';
  if (cdmHasPassed(item)) return 'Passed screening record';
  const severity = cdmSeverity(item);
  if (severity === 'critical') return 'High-priority screening';
  if (severity === 'warn') return 'Screening signal';
  return 'Monitor signal';
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

function catalogEntryWithDisplayName(entry: CatalogEntry, member: FleetMemberRef): CatalogEntry {
  const displayName = member.displayName?.trim();
  if (!displayName || displayName === entry.satcat.objectName) return entry;
  return {
    ...entry,
    satcat: {
      ...entry.satcat,
      objectName: displayName,
    },
    tle: entry.tle ? { ...entry.tle, line0: displayName } : entry.tle,
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

function setAllTrackedObjectsVisible(visible: boolean) {
  const hidden = !visible;
  const refs = trackedObjects.value.filter((item) => item.hidden !== hidden).map((item) => item.ref);
  if (!refs.length) return;
  store.setFleetMembersHidden(refs, hidden);
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
    <Teleport to="body">
      <div v-if="cdmFeedbackToasts.length" class="app-toast-region" role="status" aria-live="polite" aria-atomic="false">
        <article
          v-for="toast in cdmFeedbackToasts"
          :key="toast.id"
          class="app-toast"
          :class="`app-toast--${toast.state}`"
        >
          <span class="app-toast__status">{{ cdmFeedbackStateLabel(toast.state) }}</span>
          <div class="app-toast__copy">
            <strong>{{ toast.message }}</strong>
            <p v-if="toast.detail">{{ toast.detail }}</p>
          </div>
          <button
            v-if="toast.state === 'error' && toast.retryable !== false"
            class="app-toast__action"
            type="button"
            @click="retryCdmFeedback(toast)"
          >
            재시도
          </button>
          <button
            class="app-toast__close"
            type="button"
            aria-label="알림 닫기"
            @click="dismissCdmFeedback(toast.id)"
          >
            <span aria-hidden="true">×</span>
          </button>
        </article>
      </div>
      <div v-if="evidenceDrawer" class="evidence-backdrop" role="presentation" @click.self="closeEvidence">
        <aside class="evidence-drawer" role="dialog" aria-modal="true" :aria-label="`${evidenceDrawer.title} evidence`">
          <header class="evidence-drawer__header">
            <div>
              <p class="eyebrow">{{ evidenceDrawer.sourceDetail }}</p>
              <h2>{{ evidenceDrawer.title }}</h2>
              <p>{{ evidenceDrawer.subtitle }}</p>
            </div>
            <button class="evidence-drawer__close" type="button" aria-label="Evidence 닫기" @click="closeEvidence">
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <div class="evidence-drawer__trust">
            <span class="source-chip" :class="sourceClass(evidenceDrawer.tone)">{{ evidenceDrawer.trustTier }}</span>
            <span class="source-chip source-chip--neutral">{{ evidenceDrawer.sourceDetail }}</span>
          </div>
          <dl class="evidence-drawer__rows">
            <div v-for="row in evidenceDrawer.rows" :key="row.label">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </div>
          </dl>
          <div v-if="evidenceDrawer.rawLines?.length" class="evidence-drawer__raw" aria-label="Raw public source">
            <code v-for="line in evidenceDrawer.rawLines" :key="line">{{ line }}</code>
          </div>
          <div v-if="evidenceDrawer.links?.length" class="evidence-drawer__links">
            <a
              v-for="link in evidenceDrawer.links"
              :key="link.href"
              class="button button--ghost panel-card__action-link"
              :href="link.href"
              target="_blank"
              rel="noreferrer"
            >
              {{ link.label }}
            </a>
          </div>
          <p v-if="evidenceDrawer.note" class="evidence-drawer__note">{{ evidenceDrawer.note }}</p>
        </aside>
      </div>
    </Teleport>

    <section class="war-room">
      <div class="war-room__header">
        <div>
          <p class="eyebrow">War Room / Orbit Intelligence</p>
          <h2>Selected Fleet Live Operating Picture</h2>
          <p>공개 우주상황 데이터를 selected fleet 기준으로 읽고 판단할 수 있는 OSINT briefing으로 정리합니다.</p>
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

      <section class="trust-strip" aria-label="Data trust overview">
        <article v-for="item in trustOverview" :key="item.label" class="trust-strip__item" :class="`trust-strip__item--${item.tone}`">
          <span>{{ item.label }}</span>
          <strong>{{ item.trustTier }}</strong>
          <p>{{ item.sourceDetail }} · {{ item.detail }}</p>
        </article>
      </section>

      <section class="today-watch" aria-label="Priority Watch">
        <div class="today-watch__header">
          <div>
            <p class="eyebrow">Priority Watch</p>
            <strong>Now / Next / Monitor</strong>
          </div>
          <div class="today-watch__header-actions">
            <span>{{ todayWatch.length }} prioritized signals</span>
            <button
              class="button button--ghost today-watch__toggle"
              type="button"
              :aria-expanded="isPriorityWatchExpanded"
              @click="isPriorityWatchExpanded = !isPriorityWatchExpanded"
            >
              {{ isPriorityWatchExpanded ? 'Collapse' : 'Expand' }}
            </button>
          </div>
        </div>
        <div v-if="isPriorityWatchExpanded && todayWatch.length" class="today-watch__grid">
          <article v-for="item in todayWatch" :key="item.id" class="today-watch__item" :class="`today-watch__item--${item.tone}`">
            <div>
              <span>{{ item.kicker }}</span>
              <strong>{{ item.title }}</strong>
              <p>{{ item.detail }}</p>
              <div class="source-row">
                <span class="source-chip" :class="sourceClass(item.tone)">{{ item.trustTier }}</span>
                <span class="source-chip source-chip--neutral">{{ item.sourceDetail }}</span>
              </div>
            </div>
            <div class="today-watch__actions">
              <small>{{ item.time }}</small>
              <button class="button button--ghost panel-card__action-link action-button" type="button" @click="item.action()">{{ item.actionLabel }}</button>
            </div>
          </article>
        </div>
        <div v-else-if="isPriorityWatchExpanded" class="today-watch__empty">
          <strong>No priority signals</strong>
          <p>선택 플릿의 공개 신호가 안정적입니다. Catalog에서 관심 객체를 추가하면 briefing이 더 구체화됩니다.</p>
        </div>
      </section>

      <div class="war-room__main">
        <div ref="mapPanelRef" class="war-room__map-panel" :class="mapPanelClasses">
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
              :resume-playback-rate="resumePlaybackRate"
              :simulation-time-iso="store.simulationTimeIso"
              @set-playback-rate="setPlaybackRate"
              @set-orbit-time="setOrbitTime"
              @shift="shiftOrbitHours"
              @reset-live="resetLiveOrbit"
              @toggle-playback-pause="togglePlaybackPause"
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
            :hovered-target="hoveredTarget"
            :ground-stations="store.groundStations"
            :live-playback-rate="livePlaybackRate"
            :orbit-mode="orbitMode"
            :orbit-time-iso="displayedOrbitTimeIso"
            :risk-satellite-ids="riskSatelliteIds"
            :risk-satellite-tones="riskSatelliteTones"
            :data-saver="store.preferences.dataSaver"
            @focus-target="setFocusedTarget"
          />
          <OrbitGlobe3D
            v-else
            :satellites="visibleFleetEntries"
            :contact-links="contactLinks"
            :focused-target="focusedTarget"
            :hovered-target="hoveredTarget"
            :ground-stations="store.groundStations"
            :live-playback-rate="livePlaybackRate"
            :orbit-time-iso="displayedOrbitTimeIso"
            :orbit-mode="orbitMode"
            :risk-satellite-ids="riskSatelliteIds"
            :risk-satellite-tones="riskSatelliteTones"
            :data-saver="store.preferences.dataSaver"
            @focus-target="setFocusedTarget"
          />
        </div>

        <aside class="war-room__side">
          <section class="war-room__side-card focus-inspector">
            <div class="war-room__side-header">
              <p class="eyebrow">Focus Inspector</p>
              <div class="focus-inspector__header-actions">
                <button
                  v-if="previousFocusTarget"
                  class="button button--ghost panel-card__action-link focus-inspector__history-button"
                  type="button"
                  :title="`Previous focus: ${focusTargetLabel(previousFocusTarget)}`"
                  @click="restorePreviousFocusTarget()"
                >
                  <span aria-hidden="true">←</span>
                  <span>{{ focusTargetLabel(previousFocusTarget) }}</span>
                </button>
                <button
                  v-if="nextFocusTarget"
                  class="button button--ghost panel-card__action-link focus-inspector__step-button"
                  type="button"
                  :aria-label="`Next focus: ${focusTargetLabel(nextFocusTarget)}`"
                  :title="`Next focus: ${focusTargetLabel(nextFocusTarget)}`"
                  @click="restoreNextFocusTarget()"
                >
                  <span aria-hidden="true">→</span>
                </button>
                <button v-if="focusedTarget" class="button button--ghost panel-card__action-link" type="button" @click="clearFocusedTarget()">Clear</button>
              </div>
            </div>

            <template v-if="focusedSatellite">
              <div class="focus-inspector__hero">
                <strong>{{ focusedSatellite.member.displayName ?? focusedSatellite.entry.satcat.objectName }}</strong>
                <p>NORAD {{ focusedSatellite.entry.satcat.catalogNumber }} · {{ focusedSatellite.entry.group }}</p>
                <div v-if="focusedObjectSummary" class="source-row">
                  <span class="source-chip" :class="sourceClass(focusedObjectSummary.freshness.tone)">{{ focusedObjectSummary.freshness.label }}</span>
                  <span class="source-chip" :class="sourceClass(focusedObjectSummary.trustTone)">{{ focusedObjectSummary.trustTier }}</span>
                </div>
              </div>
              <div class="focus-inspector__actions">
                <button v-if="focusedObjectSummary" class="button button--ghost" type="button" @click="openEvidence(buildCatalogEvidence(focusedObjectSummary))">Evidence</button>
                <a
                  v-if="focusedObjectSummary?.satnogsUrl"
                  class="button button--ghost"
                  :href="focusedObjectSummary.satnogsUrl"
                  target="_blank"
                  rel="noreferrer"
                >
                  SatNOGS
                </a>
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

            <div v-if="focusHistoryItems.length" class="focus-inspector__history" aria-label="Recent focus history">
              <span>Recent focus</span>
              <div class="focus-inspector__history-list">
                <button
                  v-for="item in focusHistoryItems"
                  :key="item.key"
                  class="focus-inspector__chip focus-inspector__chip--history"
                  type="button"
                  :title="`Focus on ${item.label}`"
                  @click="focusTargetOnMap(item.target)"
                >
                  {{ item.label }}
                </button>
              </div>
            </div>

            <div class="focus-inspector__section">
              <span>Contact Windows</span>
              <article v-for="link in focusedLinks" :key="`${link.satelliteId}-${link.groundStationId}`" class="focus-inspector__row" :class="`focus-inspector__row--${link.status.toLowerCase().replace('_', '-')}`">
                <div>
                  <div class="focus-inspector__entity-line">
                    <button
                      class="focus-inspector__chip focus-inspector__chip--satellite"
                      :class="{
                        'focus-inspector__chip--active': focusTargetMatches(focusedTarget, satelliteFocusTarget(link.satelliteId)),
                        'focus-inspector__chip--preview': focusTargetMatches(hoveredTarget, satelliteFocusTarget(link.satelliteId)) && !focusTargetMatches(focusedTarget, satelliteFocusTarget(link.satelliteId)),
                      }"
                      type="button"
                      :aria-pressed="focusTargetMatches(focusedTarget, satelliteFocusTarget(link.satelliteId))"
                      @click="focusTargetOnMap(satelliteFocusTarget(link.satelliteId))"
                      @mouseenter="setHoveredTarget(satelliteFocusTarget(link.satelliteId))"
                      @mouseleave="clearHoveredTarget(satelliteFocusTarget(link.satelliteId))"
                      @focus="setHoveredTarget(satelliteFocusTarget(link.satelliteId))"
                      @blur="clearHoveredTarget(satelliteFocusTarget(link.satelliteId))"
                    >
                      {{ link.satelliteName }}
                    </button>
                    <span aria-hidden="true">→</span>
                    <button
                      class="focus-inspector__chip focus-inspector__chip--ground-station"
                      :class="{
                        'focus-inspector__chip--active': focusTargetMatches(focusedTarget, groundStationFocusTarget(link.groundStationId)),
                        'focus-inspector__chip--preview': focusTargetMatches(hoveredTarget, groundStationFocusTarget(link.groundStationId)) && !focusTargetMatches(focusedTarget, groundStationFocusTarget(link.groundStationId)),
                      }"
                      type="button"
                      :aria-pressed="focusTargetMatches(focusedTarget, groundStationFocusTarget(link.groundStationId))"
                      @click="focusTargetOnMap(groundStationFocusTarget(link.groundStationId))"
                      @mouseenter="setHoveredTarget(groundStationFocusTarget(link.groundStationId))"
                      @mouseleave="clearHoveredTarget(groundStationFocusTarget(link.groundStationId))"
                      @focus="setHoveredTarget(groundStationFocusTarget(link.groundStationId))"
                      @blur="clearHoveredTarget(groundStationFocusTarget(link.groundStationId))"
                    >
                      {{ link.groundStationName }}
                    </button>
                  </div>
                  <p>{{ linkStatusLabel(link) }} · el {{ link.elevationDeg.toFixed(1) }}° · az {{ link.azimuthDeg.toFixed(0) }}°</p>
                  <div class="source-row source-row--compact">
                    <span class="source-chip source-chip--info">Derived estimate</span>
                    <button class="source-link" type="button" @click="openEvidence(buildPassEvidence(link))">View evidence</button>
                  </div>
                </div>
              </article>
              <p v-if="!focusedLinks.length" class="empty-state">가시권 링크가 없습니다.</p>
            </div>

            <div class="focus-inspector__section">
              <span>SOCRATES Screening</span>
              <article v-for="item in focusedConjunctions" :key="item.id" class="focus-inspector__row" :class="`focus-inspector__row--${cdmDisplayTone(item)}`">
                <div>
                  <strong>{{ cdmSeverityLabel(item) }} · {{ item.missDistanceKm.toFixed(2) }} km</strong>
                  <div class="focus-inspector__entity-line focus-inspector__entity-line--subtle">
                    <button
                      v-if="conjunctionObjectTarget(item.primary)"
                      class="focus-inspector__chip focus-inspector__chip--satellite"
                      :class="conjunctionChipClasses(item.primary)"
                      type="button"
                      :aria-label="conjunctionChipLabel(item.primary)"
                      :aria-pressed="isConjunctionObjectTracked(item.primary) && focusTargetMatches(focusedTarget, conjunctionObjectTarget(item.primary))"
                      :disabled="isAddingConjunctionObject(item.primary)"
                      @click="activateConjunctionObject(item.primary)"
                      @mouseenter="setHoveredTarget(conjunctionObjectTarget(item.primary))"
                      @mouseleave="clearHoveredTarget(conjunctionObjectTarget(item.primary))"
                      @focus="setHoveredTarget(conjunctionObjectTarget(item.primary))"
                      @blur="clearHoveredTarget(conjunctionObjectTarget(item.primary))"
                    >
                      {{ item.primary.name }}
                    </button>
                    <span v-else class="focus-inspector__chip focus-inspector__chip--static">{{ item.primary.name }}</span>
                    <span aria-hidden="true">×</span>
                    <button
                      v-if="conjunctionObjectTarget(item.secondary)"
                      class="focus-inspector__chip focus-inspector__chip--satellite"
                      :class="conjunctionChipClasses(item.secondary)"
                      type="button"
                      :aria-label="conjunctionChipLabel(item.secondary)"
                      :aria-pressed="isConjunctionObjectTracked(item.secondary) && focusTargetMatches(focusedTarget, conjunctionObjectTarget(item.secondary))"
                      :disabled="isAddingConjunctionObject(item.secondary)"
                      @click="activateConjunctionObject(item.secondary)"
                      @mouseenter="setHoveredTarget(conjunctionObjectTarget(item.secondary))"
                      @mouseleave="clearHoveredTarget(conjunctionObjectTarget(item.secondary))"
                      @focus="setHoveredTarget(conjunctionObjectTarget(item.secondary))"
                      @blur="clearHoveredTarget(conjunctionObjectTarget(item.secondary))"
                    >
                      {{ item.secondary.name }}
                    </button>
                    <span v-else class="focus-inspector__chip focus-inspector__chip--static">{{ item.secondary.name }}</span>
                  </div>
                  <p>{{ formatOrbitRelative(item.tca) }}</p>
                  <div class="source-row source-row--compact">
                    <span class="source-chip" :class="cdmSourceChipClass(item)">{{ cdmSourceChipLabel(item) }}</span>
                    <button class="source-link" type="button" @click="openEvidence(buildConjunctionEvidence(item))">View evidence</button>
                  </div>
                </div>
              </article>
              <p v-if="!focusedConjunctions.length" class="empty-state">표시할 public screening signal이 없습니다.</p>
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
                  <button class="button button--ghost panel-card__action-link" type="button" @click="focusTargetOnMap({ type: 'groundStation', id: station.id })">
                    보기
                  </button>
                </article>
              </div>
            </div>

            <div v-else class="tracking-scope__panel">
              <div class="tracking-scope__toolbar" aria-label="Tracked object actions">
                <div class="tracking-scope__toolbar-row tracking-scope__toolbar-row--primary">
                  <button
                    class="button button--ghost panel-card__action-link tracking-scope__tool-button"
                    type="button"
                    :disabled="hiddenTrackedObjectCount === 0"
                    @click="setAllTrackedObjectsVisible(true)"
                  >
                    <span>모두 보이기</span>
                    <small>{{ hiddenTrackedObjectCount }}</small>
                  </button>
                  <button
                    class="button button--ghost panel-card__action-link tracking-scope__tool-button"
                    type="button"
                    :disabled="visibleTrackedObjectCount === 0"
                    @click="setAllTrackedObjectsVisible(false)"
                  >
                    <span>모두 숨기기</span>
                    <small>{{ visibleTrackedObjectCount }}</small>
                  </button>
                </div>
                <div class="tracking-scope__toolbar-row">
                  <RouterLink class="button button--ghost panel-card__action-link tracking-scope__tool-button" to="/catalog">Catalog 추가</RouterLink>
                  <RouterLink class="button button--ghost panel-card__action-link tracking-scope__tool-button" to="/fleets">Fleet 관리</RouterLink>
                </div>
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
                    <div class="tracking-scope__object-meta">
                      <span :class="sourceClass(item.freshness.tone)">{{ item.freshness.label }}</span>
                      <span :class="sourceClass(item.nextContactTone)">{{ item.nextContactLabel }}</span>
                      <span :class="sourceClass(item.riskLabel.includes('No current') ? 'info' : 'warn')">{{ item.riskLabel }}</span>
                      <span :class="sourceClass(item.anomalyCount ? 'warn' : 'info')">{{ item.latestStatusLabel }}{{ item.anomalyCount ? ` · ${item.anomalyCount} open` : '' }}</span>
                    </div>
                  </div>
                  <div class="tracking-scope__object-actions">
                    <small>{{ item.hidden ? 'HIDDEN' : item.sourceDetail }}</small>
                    <button
                      v-if="item.key.startsWith('catalog:')"
                      class="button button--ghost panel-card__action-link"
                      type="button"
                      @click="focusTargetOnMap({ type: 'satellite', id: item.key })"
                    >
                      보기
                    </button>
                    <button class="button button--ghost panel-card__action-link" type="button" @click="openEvidence(buildCatalogEvidence(item))">Evidence</button>
                    <a
                      v-if="item.satnogsUrl"
                      class="button button--ghost panel-card__action-link"
                      :href="item.satnogsUrl"
                      target="_blank"
                      rel="noreferrer"
                    >
                      SatNOGS
                    </a>
                    <button class="button button--ghost panel-card__action-link" type="button" @click="goToFleetNotes">Note</button>
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
    <PanelCard class="briefing-grid__half" title="Signal Queue" subtitle="Actionable OSINT">
      <template #actions>
        <strong class="panel-card__action-link">{{ intelQueue.length }} signals</strong>
      </template>
      <div class="war-room__feed">
        <article v-for="item in intelQueue" :key="item.id" class="war-room__feed-item" :class="`war-room__feed-item--${item.tone}`">
          <div>
            <span>{{ item.kicker }}</span>
            <strong>{{ item.title }}</strong>
            <p>{{ item.detail }}</p>
            <div class="source-row source-row--light">
              <span class="source-chip" :class="sourceClass(item.tone)">{{ item.trustTier }}</span>
              <span class="source-chip source-chip--neutral">{{ item.sourceDetail }}</span>
            </div>
          </div>
          <div class="war-room__feed-actions">
            <small>{{ item.time }}</small>
            <button class="button button--ghost panel-card__action-link action-button" type="button" @click="item.action()">{{ item.actionLabel }}</button>
          </div>
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
        <span class="source-chip source-chip--info panel-card__action-link">User supplied</span>
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
        <button class="button button--ghost panel-card__action-link" type="button" @click="openEvidence(buildWeatherEvidence())">Evidence</button>
        <span class="source-chip source-chip--info panel-card__action-link">NOAA SWPC</span>
        <OriginBadge v-if="store.weather?.fetchedAt" origin="OSINT" :timestamp="store.weather.fetchedAt" />
      </template>
      <div class="metric-grid">
        <MetricCard label="X-ray" :value="`${store.weather?.xray.flareClass ?? '—'}${store.weather?.xray.classMagnitude ?? ''}`" hint="GOES 1-day" />
        <MetricCard label="Kp" :value="`${store.weather?.kp.current ?? '—'}`" hint="3일 예보 반영" tone="warn" />
      </div>
      <p class="supporting-text">{{ truncate(store.weather?.notices?.[0]?.text ?? '현재 특기사항이 없습니다.', 96) }}</p>
    </PanelCard>

    <PanelCard title="Public Conjunction Signals" subtitle="CelesTrak SOCRATES screening">
      <template #actions>
        <span class="source-chip source-chip--warn panel-card__action-link">Public screening</span>
        <OriginBadge v-if="cdmScopeConjunctions[0]?.fetchedAt" origin="OSINT" :timestamp="cdmScopeConjunctions[0].fetchedAt" :stale="store.offline || staleCdmRecords.length > 0" />
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
        <article v-for="item in sortedConjunctionsForDisplay(cdmScopeConjunctions).slice(0, 3)" :key="item.id" class="stack-list__item" :class="`stack-list__item--${cdmDisplayTone(item)}`">
          <div>
            <strong>{{ cdmSeverityLabel(item) }} · {{ item.primary.name }} × {{ item.secondary.name }}</strong>
            <p>{{ item.missDistanceKm.toFixed(1) }} km miss · {{ item.relVelocityKmS.toFixed(1) }} km/s · public screening only</p>
          </div>
          <div class="stack-list__actions">
            <small>{{ formatOrbitRelative(item.tca) }}</small>
            <button class="button button--ghost panel-card__action-link action-button" type="button" @click="openEvidence(buildConjunctionEvidence(item))">Evidence</button>
          </div>
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
        <span class="source-chip source-chip--info panel-card__action-link">Derived from TLE</span>
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
