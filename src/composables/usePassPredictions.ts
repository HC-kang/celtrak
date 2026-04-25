import { onBeforeUnmount, type Ref, watch } from 'vue';
import type { CatalogEntry, CustomTLE, FleetMemberRef, GroundStation, MapFocusTarget, PassPrediction, TleRaw, UserFleet } from '@/domain/types';
import { useAppStore } from '@/stores/app';
import type { PassPredictionInput, PassPredictionWorkerResult, PredictableSatellite } from '@/lib/passPrediction';

export function usePassPredictions(priorityTarget?: Ref<MapFocusTarget | null>) {
  const store = useAppStore();
  let worker: Worker | null = null;
  let activeRequestId = 0;

  function createWorker() {
    worker?.terminate();
    worker = new Worker(new URL('../workers/passPrediction.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<PassPredictionWorkerResult>) => {
      if (event.data.requestId !== activeRequestId) return;
      store.setPassPredictions(
        event.data.partial ? mergePassPredictions(event.data.predictions, store.passPredictions) : event.data.predictions,
      );
    };
  }

  function refresh() {
    const payload = createPassPredictionInput(
      store.selectedFleet,
      store.catalog,
      store.customTles,
      store.groundStations,
      store.simulationTimeIso,
      store.preferences.hiddenTrackedRefs ?? [],
      priorityTarget?.value ?? null,
    );
    if (!payload) {
      activeRequestId += 1;
      worker?.terminate();
      worker = null;
      store.setPassPredictions([]);
      return;
    }
    payload.requestId = activeRequestId + 1;
    activeRequestId = payload.requestId;
    createWorker();

    try {
      worker?.postMessage(payload);
    } catch (error) {
      console.error('Pass prediction worker rejected payload', error);
      store.setPassPredictions([]);
    }
  }

  watch(
    () =>
      [
        store.selectedFleet,
        store.catalog,
        store.customTles,
        store.groundStations,
        store.simulationTimeIso,
        store.preferences.hiddenTrackedRefs,
        priorityTarget?.value?.type,
        priorityTarget?.value?.id,
      ] as const,
    () => refresh(),
    { deep: true, immediate: true },
  );

  onBeforeUnmount(() => worker?.terminate());

  return { refresh };
}

export function createPassPredictionInput(
  selectedFleet: UserFleet | null,
  catalog: CatalogEntry[],
  customTles: CustomTLE[],
  groundStations: GroundStation[],
  simulationTimeIso: string | null,
  hiddenTrackedRefs: string[] = [],
  priorityTarget: MapFocusTarget | null = null,
): PassPredictionInput | null {
  if (!selectedFleet || !groundStations.length) return null;

  const hiddenRefs = new Set(hiddenTrackedRefs);
  const satellites = selectedFleet.memberRefs
    .filter((refItem) => !hiddenRefs.has(scopedRefKey(selectedFleet.id, refItem)))
    .map((refItem): PredictableSatellite | null => {
      const tle = resolveTle(refItem, catalog, customTles);
      if (!tle) return null;
      return {
        satelliteRef: cloneFleetMemberRef(refItem),
        name:
          catalog.find((entry) => entry.satcat.catalogNumber === refItem.catalogNumber)?.satcat.objectName ??
          refItem.displayName ??
          'Custom',
        tle: cloneTle(tle),
      };
    })
    .filter((satellite): satellite is PredictableSatellite => Boolean(satellite));

  return {
    satellites,
    stations: groundStations.filter((station) => station.enabled).map(cloneGroundStation),
    hours: 24,
    startTimeIso: simulationTimeIso ?? undefined,
    priorityTarget: priorityTarget ? cloneFocusTarget(priorityTarget) : null,
  };
}

function scopedRefKey(fleetId: string, refItem: FleetMemberRef) {
  return `${fleetId}:${refItem.refType === 'catalog' ? `catalog:${refItem.catalogNumber}` : `custom:${refItem.customTleId}`}`;
}

function resolveTle(refItem: FleetMemberRef, catalog: CatalogEntry[], customTles: CustomTLE[]): TleRaw | null {
  if (refItem.refType === 'catalog') {
    return catalog.find((entry) => entry.satcat.catalogNumber === refItem.catalogNumber)?.tle ?? null;
  }
  const custom = customTles.find((entry) => entry.id === refItem.customTleId);
  if (!custom?.parsed?.raw || !('line1' in custom.parsed.raw)) return null;
  return custom.parsed.raw;
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

function cloneTle(tle: TleRaw): TleRaw {
  return {
    format: tle.format,
    line1: tle.line1,
    line2: tle.line2,
    line0: tle.line0,
  };
}

function cloneGroundStation(station: GroundStation): GroundStation {
  return {
    id: station.id,
    name: station.name,
    latDeg: station.latDeg,
    lonDeg: station.lonDeg,
    altitudeM: station.altitudeM,
    elevationMaskDeg: station.elevationMaskDeg,
    enabled: station.enabled,
    schemaVersion: station.schemaVersion,
  };
}

function cloneFocusTarget(target: MapFocusTarget): MapFocusTarget {
  return { type: target.type, id: target.id };
}

function mergePassPredictions(priority: PassPrediction[], existing: PassPrediction[]) {
  const merged = new Map<string, PassPrediction>();
  for (const pass of [...existing, ...priority]) {
    merged.set(passPredictionKey(pass), pass);
  }
  return [...merged.values()].sort((left, right) => left.aos.localeCompare(right.aos));
}

function passPredictionKey(pass: PassPrediction) {
  const satelliteId = pass.satelliteRef.refType === 'catalog' ? `catalog:${pass.satelliteRef.catalogNumber}` : `custom:${pass.satelliteRef.customTleId}`;
  return `${satelliteId}:${pass.groundStationId}:${pass.aos}:${pass.los}`;
}
