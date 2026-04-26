import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import type {
  AnomalyEntry,
  CatalogEntry,
  ConjunctionRecord,
  CustomTLE,
  DashboardAlert,
  DecayPrediction,
  FleetMemberRef,
  GroundStation,
  OperationalStatus,
  PassPrediction,
  ScheduledEvent,
  SpaceWeatherSnapshot,
  UserFleet,
  UserPreferences,
} from '@/domain/types';
import { createGateway, type ConjunctionQuery } from '@/services/gateway';
import { createFleetStore } from '@/services/store/createFleetStore';
import { defaultGroundStations } from '@/services/defaultGroundStations';
import { loadPreferences, savePreferences } from '@/lib/prefs';
import { nowIso } from '@/lib/time';
import { parseImportedText } from '@/services/tleParser';
import { getPreferredRenderMode } from '@/lib/device';
import { createUserElevationMaskSource } from '@/lib/groundStationElevation';

const gateway = createGateway();
const fleetStore = createFleetStore();
type NavigatorWithConnection = Navigator & { connection?: { saveData?: boolean } };

const LEGACY_CATALOG_REWRITES = [
  {
    fromCatalogNumber: 37849,
    fromDisplayName: 'NOAA 19',
    toCatalogNumber: 33591,
    toDisplayName: 'NOAA 19',
  },
] as const;

export const useAppStore = defineStore('app', () => {
  const catalog = ref<CatalogEntry[]>([]);
  const fleets = ref<UserFleet[]>([]);
  const customTles = ref<CustomTLE[]>([]);
  const groundStations = ref<GroundStation[]>([]);
  const anomalies = ref<AnomalyEntry[]>([]);
  const events = ref<ScheduledEvent[]>([]);
  const opsStatuses = ref<Record<string, OperationalStatus[]>>({});
  const passPredictions = ref<PassPrediction[]>([]);
  const alerts = ref<DashboardAlert[]>([]);
  const conjunctions = ref<ConjunctionRecord[]>([]);
  const weather = ref<SpaceWeatherSnapshot | null>(null);
  const decayPredictions = ref<DecayPrediction[]>([]);
  const preferences = ref<UserPreferences>(loadPreferences());
  const loading = ref(false);
  const loadingMessage = ref('데이터 동기화 준비 중');
  const catalogIndexLoading = ref(false);
  const catalogIndexLoaded = ref(false);
  const offline = ref(typeof navigator !== 'undefined' ? !navigator.onLine : false);
  const updateAvailable = ref(false);
  const updateCallback = ref<(() => Promise<void>) | null>(null);
  const simulationTimeIso = ref<string | null>(null);
  const lastSyncedAt = ref<string | null>(null);

  const selectedFleetId = ref<string | null>(null);

  const selectedFleet = computed(() => fleets.value.find((fleet) => fleet.id === selectedFleetId.value) ?? fleets.value[0] ?? null);
  const selectedFleetRefs = computed(() => selectedFleet.value?.memberRefs ?? []);
  const selectedFleetCatalogNumbers = computed(() =>
    selectedFleetRefs.value
      .filter((member) => member.refType === 'catalog' && member.catalogNumber)
      .map((member) => member.catalogNumber as number),
  );
  const defaultGroundStation = computed(
    () => groundStations.value.find((station) => station.id === preferences.value.defaultGroundStationId) ?? groundStations.value[0] ?? null,
  );
  const upcomingEvents = computed(() =>
    [...events.value]
      .filter((event) => event.startAt >= nowIso())
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
      .slice(0, 8),
  );
  const filteredConjunctions = computed(() =>
    conjunctions.value.filter((item) => {
      if (!selectedFleetCatalogNumbers.value.length) return true;
      return (
        (item.primary.catalogNumber && selectedFleetCatalogNumbers.value.includes(item.primary.catalogNumber)) ||
        (item.secondary.catalogNumber && selectedFleetCatalogNumbers.value.includes(item.secondary.catalogNumber))
      );
    }),
  );
  const filteredDecayPredictions = computed(() =>
    decayPredictions.value.map((item) => ({
      ...item,
      intersectsSelectedFleet: selectedFleetCatalogNumbers.value.includes(item.catalogNumber),
    })),
  );
  const fleetHealth = computed(() => {
    const statuses = Object.values(opsStatuses.value).flat();
    const latestByRef = new Map<string, OperationalStatus>();
    for (const status of statuses) {
      const key = stringifyRef(status.satelliteRef);
      if (!latestByRef.has(key) || latestByRef.get(key)!.recordedAt < status.recordedAt) {
        latestByRef.set(key, status);
      }
    }

    const values = [...latestByRef.values()];
    const total = values.length;
    const count = (mcStatus: OperationalStatus['mcStatus']) => values.filter((item) => item.mcStatus === mcStatus).length;
    const latestRecordedAt = values
      .map((item) => item.recordedAt)
      .sort()
      .at(-1);
    return {
      totalMembers: selectedFleetRefs.value.length,
      recordedMembers: values.length,
      unrecordedMembers: Math.max(selectedFleetRefs.value.length - values.length, 0),
      latestRecordedAt,
      fmcCount: count('FMC'),
      pmcCount: count('PMC'),
      nmcCount: count('NMC'),
      unknownCount: count('UNKNOWN'),
      fmcRate: total ? (count('FMC') / total) * 100 : null,
      pmcRate: total ? (count('PMC') / total) * 100 : null,
      nmcRate: total ? (count('NMC') / total) * 100 : null,
    };
  });

  watch(selectedFleetId, async () => {
    await hydrateSelectedFleetCatalog();
    await hydrateOpsStatuses();
  });

  async function bootstrap() {
    loading.value = true;
    loadingMessage.value = '로컬 워크스페이스와 플릿 데이터를 준비하는 중';
    try {
      const remoteSignals = Promise.all([
        gateway.getWeather(),
        gateway.getConjunctions(),
        gateway.getDecayPredictions(),
        gateway.getAlerts(),
      ]);

      fleets.value = await fleetStore.listFleets();
      customTles.value = await fleetStore.listCustomTLEs();
      groundStations.value = await fleetStore.listGroundStations();
      anomalies.value = await fleetStore.listAnomalies({});
      events.value = await fleetStore.listEvents(nowIso(), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());

      const defaults = enrichDefaultGroundStationSources(await gateway.getGroundStations());
      const existingStationIds = new Set(groundStations.value.map((station) => station.id));
      const missingDefaults = defaults.filter((station) => !existingStationIds.has(station.id));
      if (missingDefaults.length) {
        for (const station of missingDefaults) {
          await fleetStore.upsertGroundStation(station);
        }
        groundStations.value = await fleetStore.listGroundStations();
      }
      const defaultsById = new Map(defaults.map((station) => [station.id, station]));
      const stationsNeedingMaskSource = groundStations.value
        .map((station) => {
          const defaultStation = defaultsById.get(station.id);
          if (station.elevationMaskSource?.confidence === 'user') return null;
          if (!defaultStation?.elevationMaskSource) {
            return station.elevationMaskSource ? null : { ...station, elevationMaskSource: createUserElevationMaskSource() };
          }
          const elevationMaskSource =
            station.elevationMaskDeg === defaultStation.elevationMaskDeg
              ? defaultStation.elevationMaskSource
              : createUserElevationMaskSource();
          if (sameElevationMaskSource(station.elevationMaskSource, elevationMaskSource)) return null;
          return { ...station, elevationMaskSource };
        })
        .filter((station): station is GroundStation => Boolean(station));
      if (stationsNeedingMaskSource.length) {
        for (const station of stationsNeedingMaskSource) {
          await fleetStore.upsertGroundStation(station);
        }
        groundStations.value = await fleetStore.listGroundStations();
      }

      if (!fleets.value.length) {
        const seedFleet = createSeedFleet();
        await fleetStore.upsertFleet(seedFleet);
        fleets.value = await fleetStore.listFleets();
      }

      if (!events.value.length) {
        for (const event of createSeedEvents()) {
          await fleetStore.upsertEvent(event);
        }
        events.value = await fleetStore.listEvents(nowIso(), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
      }

      await repairLegacyCatalogRefs();

      selectedFleetId.value = preferredFleetId(fleets.value, preferences.value.selectedFleetId);
      if (selectedFleetId.value && preferences.value.selectedFleetId !== selectedFleetId.value) {
        updatePreferences({ selectedFleetId: selectedFleetId.value });
      }
      loadingMessage.value = '선택 플릿 궤도 데이터를 불러오는 중';
      await hydrateSelectedFleetCatalog();
      const [weatherData, conjunctionData, decayData, alertsData] = await remoteSignals;
      weather.value = weatherData;
      conjunctions.value = conjunctionData;
      decayPredictions.value = decayData;
      alerts.value = alertsData;

      loadingMessage.value = '선택 플릿 상태와 지상국 설정을 적용하는 중';
      await hydrateOpsStatuses();
      if (!preferences.value.defaultGroundStationId && groundStations.value[0]) {
        updatePreferences({ defaultGroundStationId: groundStations.value[0].id });
      }
      lastSyncedAt.value = nowIso();
    } finally {
      loading.value = false;
      loadingMessage.value = '동기화 완료';
    }
  }

  async function hydrateOpsStatuses() {
    const next: Record<string, OperationalStatus[]> = {};
    const refs = selectedFleet.value?.memberRefs ?? [];
    for (const refItem of refs) {
      next[stringifyRef(refItem)] = await fleetStore.listOpsStatus(refItem, 30);
    }
    opsStatuses.value = next;
  }

  async function hydrateSelectedFleetCatalog() {
    const catalogNumbers = selectedFleetCatalogNumbers.value.filter(
      (catalogNumber) => !catalog.value.some((entry) => entry.satcat.catalogNumber === catalogNumber),
    );
    if (!catalogNumbers.length) return;
    const entries = await gateway.getCatalog({ catalogNumbers });
    mergeCatalogEntries(entries);
  }

  async function loadCatalogIndex() {
    if (catalogIndexLoaded.value || catalogIndexLoading.value) return;
    catalogIndexLoading.value = true;
    try {
      const entries = await gateway.getCatalog({ group: 'active', limit: 20_000 });
      mergeCatalogEntries(entries);
      catalogIndexLoaded.value = true;
    } finally {
      catalogIndexLoading.value = false;
    }
  }

  async function fetchConjunctions(query?: ConjunctionQuery) {
    return gateway.getConjunctions(query);
  }

  async function repairLegacyCatalogRefs() {
    const repairedFleetIds = new Set<string>();
    for (const fleet of fleets.value) {
      const rewrite = rewriteLegacyFleetMemberRefs(fleet.memberRefs);
      if (!rewrite.changed) continue;
      repairedFleetIds.add(fleet.id);
      await fleetStore.upsertFleet({
        ...fleet,
        memberRefs: rewrite.memberRefs,
        updatedAt: nowIso(),
      });
    }
    if (repairedFleetIds.size) {
      fleets.value = await fleetStore.listFleets();
      const hiddenTrackedRefs = rewriteLegacyHiddenTrackedRefs(preferences.value.hiddenTrackedRefs ?? [], repairedFleetIds);
      if (hiddenTrackedRefs.changed) {
        updatePreferences({ hiddenTrackedRefs: hiddenTrackedRefs.values });
      }
    }

    let eventsChanged = false;
    for (const event of events.value) {
      const rewrittenSatelliteRef = event.satelliteRef ? rewriteLegacyFleetMemberRef(event.satelliteRef) : event.satelliteRef;
      if (rewrittenSatelliteRef === event.satelliteRef) continue;
      await fleetStore.upsertEvent({ ...event, satelliteRef: rewrittenSatelliteRef });
      eventsChanged = true;
    }
    if (eventsChanged) {
      events.value = await fleetStore.listEvents(nowIso(), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
    }
  }

  function mergeCatalogEntries(entries: CatalogEntry[]) {
    if (!entries.length) return;
    const byCatalogNumber = new Map(catalog.value.map((entry) => [entry.satcat.catalogNumber, entry]));
    for (const entry of entries) {
      byCatalogNumber.set(entry.satcat.catalogNumber, entry);
    }
    catalog.value = [...byCatalogNumber.values()];
  }

  async function addCatalogToFleet(entry: CatalogEntry, fleetId = selectedFleet.value?.id) {
    const fleet = fleets.value.find((item) => item.id === fleetId);
    if (!fleet) return null;
    const exists = fleet.memberRefs.some(
      (member) => member.refType === 'catalog' && member.catalogNumber === entry.satcat.catalogNumber,
    );
    if (exists) return entry;
    const nextFleet: UserFleet = {
      ...fleet,
      memberRefs: [
        ...fleet.memberRefs,
        { refType: 'catalog', catalogNumber: entry.satcat.catalogNumber, displayName: entry.satcat.objectName, tags: [] },
      ],
      updatedAt: nowIso(),
    };
    await fleetStore.upsertFleet(nextFleet);
    fleets.value = await fleetStore.listFleets();
    mergeCatalogEntries([entry]);
    await hydrateOpsStatuses();
    return entry;
  }

  async function addCatalogNumberToFleet(catalogNumber: number, fleetId = selectedFleet.value?.id) {
    const existing = catalog.value.find((entry) => entry.satcat.catalogNumber === catalogNumber);
    if (existing) {
      return addCatalogToFleet(existing, fleetId);
    }
    const [entry] = await gateway.getCatalogStrict({ catalogNumbers: [catalogNumber] }, { timeoutMs: 15_000 });
    if (!entry) throw new Error(`CelesTrak에서 NORAD ${catalogNumber}의 TLE/SATCAT을 찾지 못했습니다.`);
    return addCatalogToFleet(entry, fleetId);
  }

  async function createFleet(name: string, description?: string) {
    const fleet: UserFleet = {
      id: crypto.randomUUID(),
      name,
      description,
      memberRefs: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      schemaVersion: 1,
    };
    await fleetStore.upsertFleet(fleet);
    fleets.value = await fleetStore.listFleets();
    selectedFleetId.value = fleet.id;
    updatePreferences({ selectedFleetId: fleet.id });
  }

  async function deleteFleet(id: string) {
    await fleetStore.deleteFleet(id);
    fleets.value = await fleetStore.listFleets();
    selectedFleetId.value = preferredFleetId(fleets.value, selectedFleetId.value === id ? undefined : selectedFleetId.value);
    updatePreferences({ selectedFleetId: selectedFleetId.value ?? undefined });
    await hydrateSelectedFleetCatalog();
    await hydrateOpsStatuses();
  }

  async function selectFleet(id: string) {
    selectedFleetId.value = id;
    updatePreferences({ selectedFleetId: id });
    await hydrateSelectedFleetCatalog();
    await hydrateOpsStatuses();
  }

  async function importCustomTles(rawText: string, sourceLabel?: string) {
    const { entries, errors } = parseImportedText(rawText, sourceLabel);
    for (const entry of entries) {
      await fleetStore.upsertCustomTLE(entry);
    }
    customTles.value = await fleetStore.listCustomTLEs();
    return { imported: entries.length, errors };
  }

  async function logOperationalStatus(refItem: FleetMemberRef, status: OperationalStatus['mcStatus'], rfStatus: OperationalStatus['rfStatus'], notes?: string) {
    const entry: OperationalStatus = {
      id: crypto.randomUUID(),
      satelliteRef: refItem,
      recordedAt: nowIso(),
      mcStatus: status,
      rfStatus,
      notes,
      schemaVersion: 1,
    };
    await fleetStore.appendOpsStatus(entry);
    await hydrateOpsStatuses();
  }

  async function upsertGroundStation(station: GroundStation) {
    await fleetStore.upsertGroundStation(station);
    groundStations.value = await fleetStore.listGroundStations();
    if (!preferences.value.defaultGroundStationId) {
      updatePreferences({ defaultGroundStationId: station.id });
    }
  }

  async function toggleGroundStation(id: string, enabled: boolean) {
    const station = groundStations.value.find((item) => item.id === id);
    if (!station) return;
    await upsertGroundStation({ ...station, enabled });
  }

  function setDefaultGroundStation(id: string) {
    updatePreferences({ defaultGroundStationId: id });
  }

  async function logAnomaly(input: Pick<AnomalyEntry, 'satelliteRef' | 'severity' | 'subsystem' | 'description'>) {
    const entry: AnomalyEntry = {
      id: crypto.randomUUID(),
      satelliteRef: input.satelliteRef,
      severity: input.severity,
      subsystem: input.subsystem,
      description: input.description,
      openedAt: nowIso(),
      schemaVersion: 1,
    };
    await fleetStore.upsertAnomaly(entry);
    anomalies.value = await fleetStore.listAnomalies({});
  }

  async function closeAnomaly(id: string) {
    const anomaly = anomalies.value.find((item) => item.id === id);
    if (!anomaly || anomaly.closedAt) return;
    await fleetStore.upsertAnomaly({ ...anomaly, closedAt: nowIso() });
    anomalies.value = await fleetStore.listAnomalies({});
  }

  async function upsertEvent(event: ScheduledEvent) {
    await fleetStore.upsertEvent(event);
    events.value = await fleetStore.listEvents(nowIso(), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
  }

  async function deleteEvent(id: string) {
    await fleetStore.deleteEvent(id);
    events.value = await fleetStore.listEvents(nowIso(), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
  }

  async function updateFleetMember(refItem: FleetMemberRef, patch: Partial<Pick<FleetMemberRef, 'displayName' | 'tags'>>) {
    const fleet = selectedFleet.value;
    if (!fleet) return;
    const memberRefs = fleet.memberRefs.map((member) => {
      if (!matchesRef(member, refItem)) return member;
      return {
        ...member,
        displayName: patch.displayName ?? member.displayName,
        tags: patch.tags ?? member.tags,
      };
    });
    await fleetStore.upsertFleet({ ...fleet, memberRefs, updatedAt: nowIso() });
    fleets.value = await fleetStore.listFleets();
  }

  async function removeFleetMember(refItem: FleetMemberRef) {
    const fleet = selectedFleet.value;
    if (!fleet) return;
    const memberRefs = fleet.memberRefs.filter((member) => !matchesRef(member, refItem));
    await fleetStore.upsertFleet({ ...fleet, memberRefs, updatedAt: nowIso() });
    fleets.value = await fleetStore.listFleets();
    setFleetMemberHidden(refItem, false, fleet.id);
    await hydrateOpsStatuses();
  }

  async function addCustomTleToFleet(customTleId: string, fleetId = selectedFleet.value?.id) {
    const fleet = fleets.value.find((item) => item.id === fleetId);
    const custom = customTles.value.find((item) => item.id === customTleId);
    if (!fleet || !custom) return;
    const exists = fleet.memberRefs.some((member) => member.refType === 'custom' && member.customTleId === customTleId);
    if (exists) return;
    await fleetStore.upsertFleet({
      ...fleet,
      memberRefs: [...fleet.memberRefs, { refType: 'custom', customTleId, displayName: custom.name, tags: ['custom'] }],
      updatedAt: nowIso(),
    });
    fleets.value = await fleetStore.listFleets();
    await hydrateOpsStatuses();
  }

  async function exportWorkspace() {
    return await fleetStore.export();
  }

  async function importWorkspace(rawJson: string, mode: 'merge' | 'replace') {
    const report = await fleetStore.import(rawJson, mode);
    fleets.value = await fleetStore.listFleets();
    customTles.value = await fleetStore.listCustomTLEs();
    groundStations.value = await fleetStore.listGroundStations();
    anomalies.value = await fleetStore.listAnomalies({});
    events.value = await fleetStore.listEvents(nowIso(), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
    await hydrateSelectedFleetCatalog();
    await hydrateOpsStatuses();
    return report;
  }

  function updatePreferences(patch: Partial<UserPreferences>) {
    preferences.value = { ...preferences.value, ...patch };
    savePreferences(preferences.value);
  }

  function hiddenKeyFor(refItem: FleetMemberRef, fleetId = selectedFleet.value?.id) {
    return `${fleetId ?? 'no-fleet'}:${stringifyRef(refItem)}`;
  }

  function isFleetMemberHidden(refItem: FleetMemberRef, fleetId = selectedFleet.value?.id) {
    return (preferences.value.hiddenTrackedRefs ?? []).includes(hiddenKeyFor(refItem, fleetId));
  }

  function setFleetMemberHidden(refItem: FleetMemberRef, hidden: boolean, fleetId = selectedFleet.value?.id) {
    const key = hiddenKeyFor(refItem, fleetId);
    const hiddenRefs = new Set(preferences.value.hiddenTrackedRefs ?? []);
    if (hidden) {
      hiddenRefs.add(key);
    } else {
      hiddenRefs.delete(key);
    }
    updatePreferences({ hiddenTrackedRefs: [...hiddenRefs] });
  }

  function toggleFleetMemberHidden(refItem: FleetMemberRef) {
    setFleetMemberHidden(refItem, !isFleetMemberHidden(refItem));
  }

  function applyAutomaticPreferences(width: number) {
    const saveData = (navigator as NavigatorWithConnection).connection?.saveData ?? false;
    if (saveData && !preferences.value.dataSaver) {
      updatePreferences({ dataSaver: true });
    }
    const preferred = getPreferredRenderMode(width);
    if (width < 768 && preferences.value.mobileRenderMode !== preferred) {
      updatePreferences({ mobileRenderMode: preferred });
    }
  }

  function setOfflineState(value: boolean) {
    offline.value = value;
  }

  function setPassPredictions(next: PassPrediction[]) {
    passPredictions.value = next;
  }

  function setSimulationTime(value: string | null) {
    simulationTimeIso.value = value;
  }

  function shiftSimulationHours(hours: number) {
    const base = simulationTimeIso.value ? new Date(simulationTimeIso.value) : new Date();
    base.setTime(base.getTime() + hours * 60 * 60 * 1000);
    simulationTimeIso.value = base.toISOString();
  }

  function resetSimulationTime() {
    simulationTimeIso.value = null;
  }

  function setUpdateHandler(callback: (() => Promise<void>) | null) {
    updateCallback.value = callback;
    updateAvailable.value = Boolean(callback);
  }

  async function applyUpdate() {
    if (!updateCallback.value) return;
    await updateCallback.value();
    updateAvailable.value = false;
    updateCallback.value = null;
  }

  function latestStatusFor(refItem: FleetMemberRef) {
    return opsStatuses.value[stringifyRef(refItem)]?.[0] ?? null;
  }

  function hasDivergence(refItem: FleetMemberRef) {
    const latest = latestStatusFor(refItem);
    if (!latest || refItem.refType !== 'catalog') return false;
    const osint = catalog.value.find((entry) => entry.satcat.catalogNumber === refItem.catalogNumber);
    if (!osint) return false;
    return osint.satcat.opsStatusCode === 'ACTIVE' && (latest.mcStatus === 'NMC' || latest.rfStatus === 'LOSS');
  }

  return {
    alerts,
    anomalies,
    applyUpdate,
    bootstrap,
    catalog,
    catalogIndexLoaded,
    catalogIndexLoading,
    conjunctions,
    createFleet,
    customTles,
    decayPredictions,
    defaultGroundStation,
    deleteEvent,
    deleteFleet,
    events,
    exportWorkspace,
    fetchConjunctions,
    filteredConjunctions,
    filteredDecayPredictions,
    fleetHealth,
    fleets,
    groundStations,
    hasDivergence,
    importCustomTles,
    importWorkspace,
    isFleetMemberHidden,
    lastSyncedAt,
    loading,
    loadingMessage,
    closeAnomaly,
    addCustomTleToFleet,
    latestStatusFor,
    loadCatalogIndex,
    logAnomaly,
    logOperationalStatus,
    offline,
    opsStatuses,
    passPredictions,
    preferences,
    resetSimulationTime,
    selectedFleet,
    selectedFleetCatalogNumbers,
    selectedFleetId,
    selectedFleetRefs,
    selectFleet,
    setOfflineState,
    setPassPredictions,
    setDefaultGroundStation,
    setSimulationTime,
    setUpdateHandler,
    shiftSimulationHours,
    simulationTimeIso,
    toggleGroundStation,
    toggleFleetMemberHidden,
    upcomingEvents,
    upsertGroundStation,
    upsertEvent,
    updateAvailable,
    updateFleetMember,
    updatePreferences,
    weather,
    addCatalogToFleet,
    addCatalogNumberToFleet,
    applyAutomaticPreferences,
    removeFleetMember,
  };
});

function createSeedFleet(): UserFleet {
  return {
    id: crypto.randomUUID(),
    name: 'Primary Ops',
    description: '초기 운영 플릿',
    memberRefs: [
      { refType: 'catalog', catalogNumber: 25544, displayName: 'ISS', tags: ['crew'] },
      { refType: 'catalog', catalogNumber: 33591, displayName: 'NOAA 19', tags: ['weather'] },
      { refType: 'catalog', catalogNumber: 24876, displayName: 'GPS BIIR-2', tags: ['nav'] },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    schemaVersion: 1,
  };
}

function stringifyRef(refItem: FleetMemberRef) {
  return refItem.refType === 'catalog' ? `catalog:${refItem.catalogNumber}` : `custom:${refItem.customTleId}`;
}

function rewriteLegacyFleetMemberRefs(memberRefs: FleetMemberRef[]) {
  let changed = false;
  const next: FleetMemberRef[] = [];
  const seen = new Map<string, FleetMemberRef>();

  for (const member of memberRefs) {
    const rewritten = rewriteLegacyFleetMemberRef(member);
    changed ||= rewritten !== member;
    const key = stringifyRef(rewritten);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, rewritten);
      next.push(rewritten);
      continue;
    }

    const merged = mergeFleetMemberRefs(existing, rewritten);
    seen.set(key, merged);
    next[next.findIndex((item) => stringifyRef(item) === key)] = merged;
    changed = true;
  }

  return { memberRefs: next, changed };
}

function rewriteLegacyFleetMemberRef(member: FleetMemberRef): FleetMemberRef {
  const rewrite = legacyCatalogRewriteFor(member);
  if (!rewrite) return member;
  return {
    ...member,
    catalogNumber: rewrite.toCatalogNumber,
    displayName: rewrite.toDisplayName,
    tags: [...member.tags],
  };
}

function legacyCatalogRewriteFor(member: FleetMemberRef) {
  if (member.refType !== 'catalog') return null;
  return (
    LEGACY_CATALOG_REWRITES.find(
      (rewrite) =>
        member.catalogNumber === rewrite.fromCatalogNumber &&
        normalizeDisplayName(member.displayName) === normalizeDisplayName(rewrite.fromDisplayName),
    ) ?? null
  );
}

function mergeFleetMemberRefs(left: FleetMemberRef, right: FleetMemberRef): FleetMemberRef {
  return {
    ...left,
    displayName: left.displayName ?? right.displayName,
    tags: [...new Set([...left.tags, ...right.tags])],
  };
}

function rewriteLegacyHiddenTrackedRefs(hiddenRefs: string[], repairedFleetIds: Set<string>) {
  let changed = false;
  const values = hiddenRefs.map((key) => {
    const match = /^(.*):catalog:(\d+)$/.exec(key);
    if (!match || !repairedFleetIds.has(match[1])) return key;
    const catalogNumber = Number(match[2]);
    const rewrite = LEGACY_CATALOG_REWRITES.find((item) => item.fromCatalogNumber === catalogNumber);
    if (!rewrite) return key;
    changed = true;
    return `${match[1]}:catalog:${rewrite.toCatalogNumber}`;
  });
  return { values: [...new Set(values)], changed };
}

function normalizeDisplayName(value?: string) {
  return (value ?? '').trim().toUpperCase();
}

function matchesRef(left: FleetMemberRef, right: FleetMemberRef) {
  if (left.refType !== right.refType) return false;
  if (left.refType === 'catalog') return left.catalogNumber === right.catalogNumber;
  return left.customTleId === right.customTleId;
}

function preferredFleetId(fleets: UserFleet[], candidate?: string | null) {
  if (candidate && fleets.some((fleet) => fleet.id === candidate)) return candidate;
  return fleets[0]?.id ?? null;
}

function enrichDefaultGroundStationSources(stations: GroundStation[]) {
  const localDefaults = new Map(defaultGroundStations.map((station) => [station.id, station]));
  const remoteIds = new Set(stations.map((station) => station.id));
  return [
    ...stations.map((station) => {
      const localDefault = localDefaults.get(station.id);
      return {
        ...(localDefault ?? {}),
        ...station,
        elevationMaskSource: station.elevationMaskSource ?? localDefault?.elevationMaskSource,
      };
    }),
    ...defaultGroundStations.filter((station) => !remoteIds.has(station.id)),
  ];
}

function sameElevationMaskSource(left: GroundStation['elevationMaskSource'], right: GroundStation['elevationMaskSource']) {
  if (!left || !right) return left === right;
  return (
    left.confidence === right.confidence &&
    left.label === right.label &&
    left.url === right.url &&
    left.note === right.note
  );
}

function createSeedEvents(): ScheduledEvent[] {
  const base = Date.now();
  return [
    {
      id: crypto.randomUUID(),
      satelliteRef: { refType: 'catalog', catalogNumber: 25544, displayName: 'ISS', tags: ['crew'] },
      startAt: new Date(base + 6 * 60 * 60 * 1000).toISOString(),
      endAt: new Date(base + 7 * 60 * 60 * 1000).toISOString(),
      kind: 'MAINTENANCE',
      title: 'Crew comm window',
      notes: 'High priority voice and telemetry pass planning.',
      schemaVersion: 1,
    },
    {
      id: crypto.randomUUID(),
      satelliteRef: { refType: 'catalog', catalogNumber: 33591, displayName: 'NOAA 19', tags: ['weather'] },
      startAt: new Date(base + 16 * 60 * 60 * 1000).toISOString(),
      endAt: new Date(base + 18 * 60 * 60 * 1000).toISOString(),
      kind: 'SW_UPDATE',
      title: 'Payload timing parameter review',
      notes: 'User-defined maintenance timeline.',
      schemaVersion: 1,
    },
  ];
}
