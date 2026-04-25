import { onBeforeUnmount, watch } from 'vue';
import type { CatalogEntry, CustomTLE, FleetMemberRef, GroundStation, TleRaw, UserFleet } from '@/domain/types';
import { useAppStore } from '@/stores/app';
import type { PassPredictionInput, PredictableSatellite } from '@/lib/passPrediction';

export function usePassPredictions() {
  const store = useAppStore();
  const worker = new Worker(new URL('../workers/passPrediction.worker.ts', import.meta.url), { type: 'module' });

  worker.onmessage = (event) => {
    store.setPassPredictions(event.data);
  };

  function refresh() {
    const payload = createPassPredictionInput(
      store.selectedFleet,
      store.catalog,
      store.customTles,
      store.groundStations,
      store.simulationTimeIso,
      store.preferences.hiddenTrackedRefs ?? [],
    );
    if (!payload) return;

    try {
      worker.postMessage(payload);
    } catch (error) {
      console.error('Pass prediction worker rejected payload', error);
      store.setPassPredictions([]);
    }
  }

  watch(
    () => [store.selectedFleet, store.catalog, store.customTles, store.groundStations, store.simulationTimeIso, store.preferences.hiddenTrackedRefs] as const,
    () => refresh(),
    { deep: true, immediate: true },
  );

  onBeforeUnmount(() => worker.terminate());

  return { refresh };
}

export function createPassPredictionInput(
  selectedFleet: UserFleet | null,
  catalog: CatalogEntry[],
  customTles: CustomTLE[],
  groundStations: GroundStation[],
  simulationTimeIso: string | null,
  hiddenTrackedRefs: string[] = [],
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
