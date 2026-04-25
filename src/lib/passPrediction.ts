import * as satellite from 'satellite.js';
import type { FleetMemberRef, GroundStation, MapFocusTarget, PassPrediction, TleRaw } from '@/domain/types';

export interface PredictableSatellite {
  satelliteRef: FleetMemberRef;
  name: string;
  tle: TleRaw;
}

export interface PassPredictionInput {
  satellites: PredictableSatellite[];
  stations: GroundStation[];
  hours: number;
  startTimeIso?: string;
  priorityTarget?: MapFocusTarget | null;
  requestId?: number;
}

export interface PassPredictionWorkerResult {
  predictions: PassPrediction[];
  partial?: boolean;
  requestId?: number;
}

export function predictPasses({ satellites, stations, hours, startTimeIso }: PassPredictionInput): PassPrediction[] {
  return limitPassPredictions(
    predictPassesForPairs({
      satellites,
      stations: stations.filter((item) => item.enabled),
      hours,
      startTimeIso,
    }),
    satellites.length,
    stations.length,
  );
}

export function predictPriorityPasses(input: PassPredictionInput): PassPrediction[] {
  if (!input.priorityTarget) return [];
  const enabledStations = input.stations.filter((item) => item.enabled);
  const satellites =
    input.priorityTarget.type === 'satellite'
      ? input.satellites.filter((satelliteItem) => satelliteIdForRef(satelliteItem.satelliteRef) === input.priorityTarget?.id)
      : input.satellites;
  const stations =
    input.priorityTarget.type === 'groundStation'
      ? enabledStations.filter((station) => station.id === input.priorityTarget?.id)
      : enabledStations;

  if (!satellites.length || !stations.length) return [];
  return predictPassesForPairs({
    satellites,
    stations,
    hours: input.hours,
    startTimeIso: input.startTimeIso,
    stepMinutes: 1,
  }).sort(comparePasses);
}

function predictPassesForPairs({
  satellites,
  stations,
  hours,
  startTimeIso,
  stepMinutes = 3,
}: {
  satellites: PredictableSatellite[];
  stations: GroundStation[];
  hours: number;
  startTimeIso?: string;
  stepMinutes?: number;
}): PassPrediction[] {
  const results: PassPrediction[] = [];
  const start = startTimeIso ? new Date(startTimeIso) : new Date();
  const end = new Date(start.getTime() + hours * 60 * 60 * 1000);

  for (const sat of satellites) {
    const satrec = satellite.twoline2satrec(sat.tle.line1, sat.tle.line2);
    for (const station of stations) {
      const observerGd = {
        longitude: satellite.degreesToRadians(station.lonDeg),
        latitude: satellite.degreesToRadians(station.latDeg),
        height: station.altitudeM / 1000,
      };
      let currentTime = new Date(start);
      let inPass = false;
      let passStart: ReturnType<typeof createLookSnapshot> | null = null;
      let peak: ReturnType<typeof createLookSnapshot> | null = null;
      let lastVisible: ReturnType<typeof createLookSnapshot> | null = null;

      while (currentTime <= end) {
        const snapshot = createLookSnapshot(satrec, observerGd, currentTime);
        if (snapshot && snapshot.elevationDeg >= station.elevationMaskDeg) {
          if (!inPass) {
            inPass = true;
            passStart = snapshot;
            peak = snapshot;
          } else if ((peak?.elevationDeg ?? 0) < snapshot.elevationDeg) {
            peak = snapshot;
          }
          lastVisible = snapshot;
        } else if (inPass && passStart && peak) {
          const passEnd = lastVisible ?? peak;
          results.push({
            origin: 'DERIVED',
            satelliteRef: sat.satelliteRef,
            groundStationId: station.id,
            elevationMaskDeg: station.elevationMaskDeg,
            aos: passStart.timestamp.toISOString(),
            tca: peak.timestamp.toISOString(),
            los: passEnd.timestamp.toISOString(),
            maxElevationDeg: peak.elevationDeg,
            aosAzimuthDeg: passStart.azimuthDeg,
            losAzimuthDeg: passEnd.azimuthDeg,
            illuminationAtTca: 'SUNLIT',
            computedAt: new Date().toISOString(),
          });
          inPass = false;
          passStart = null;
          peak = null;
          lastVisible = null;
        }

        currentTime = new Date(currentTime.getTime() + stepMinutes * 60 * 1000);
      }

      if (inPass && passStart && peak) {
        const passEnd = lastVisible ?? peak;
        results.push({
          origin: 'DERIVED',
          satelliteRef: sat.satelliteRef,
          groundStationId: station.id,
          elevationMaskDeg: station.elevationMaskDeg,
          aos: passStart.timestamp.toISOString(),
          tca: peak.timestamp.toISOString(),
          los: passEnd.timestamp.toISOString(),
          losIsPredictionHorizon: true,
          maxElevationDeg: peak.elevationDeg,
          aosAzimuthDeg: passStart.azimuthDeg,
          losAzimuthDeg: passEnd.azimuthDeg,
          illuminationAtTca: 'SUNLIT',
          computedAt: new Date().toISOString(),
        });
      }
    }
  }

  return results;
}

function limitPassPredictions(results: PassPrediction[], satelliteCount: number, stationCount: number) {
  const sorted = [...results].sort(comparePasses);
  const firstPerPair = new Map<string, PassPrediction>();
  for (const pass of sorted) {
    const key = pairKey(pass);
    if (!firstPerPair.has(key)) {
      firstPerPair.set(key, pass);
    }
  }

  const maxResults = Math.min(Math.max(satelliteCount * stationCount * 8, 96), 1600);
  return dedupePasses([...firstPerPair.values(), ...sorted]).slice(0, maxResults);
}

function dedupePasses(passes: PassPrediction[]) {
  const seen = new Set<string>();
  const result: PassPrediction[] = [];
  for (const pass of passes) {
    const key = `${pairKey(pass)}:${pass.aos}:${pass.los}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(pass);
  }
  return result;
}

function pairKey(pass: PassPrediction) {
  return `${satelliteIdForRef(pass.satelliteRef)}:${pass.groundStationId}`;
}

function satelliteIdForRef(refItem: FleetMemberRef) {
  return refItem.refType === 'catalog' ? `catalog:${refItem.catalogNumber}` : `custom:${refItem.customTleId}`;
}

function comparePasses(left: PassPrediction, right: PassPrediction) {
  return left.aos.localeCompare(right.aos);
}

function createLookSnapshot(
  satrec: satellite.SatRec,
  observerGd: { longitude: number; latitude: number; height: number },
  timestamp: Date,
) {
  const propagated = satellite.propagate(satrec, timestamp);
  if (!propagated.position || propagated.position === true) return null;
  const gmst = satellite.gstime(timestamp);
  const positionEcf = satellite.eciToEcf(propagated.position, gmst);
  const look = satellite.ecfToLookAngles(observerGd, positionEcf);
  return {
    timestamp,
    azimuthDeg: radiansToDegrees(look.azimuth),
    elevationDeg: radiansToDegrees(look.elevation),
  };
}

function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI;
}
