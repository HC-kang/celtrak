import * as satellite from 'satellite.js';
import type { FleetMemberRef, GroundStation, LiveContactLink, MapFocusTarget, PassPrediction, TleRaw } from '@/domain/types';

export interface ContactSatellite {
  satelliteRef: FleetMemberRef;
  name: string;
  tle: TleRaw;
}

export interface LookSnapshot {
  azimuthDeg: number;
  elevationDeg: number;
}

export function buildLiveContactLinks(input: {
  satellites: ContactSatellite[];
  stations: GroundStation[];
  timestampIso: string;
  passPredictions: PassPrediction[];
  priorityTarget?: MapFocusTarget | null;
}): LiveContactLink[] {
  const timestampMs = new Date(input.timestampIso).getTime();
  if (!Number.isFinite(timestampMs)) return [];

  const enabledStations = input.stations.filter((station) => station.enabled);
  const passMap = indexPassPredictions(input.passPredictions);
  const links: LiveContactLink[] = [];
  let fallbackEstimates = 0;

  for (const sat of input.satellites) {
    const satrec = satellite.twoline2satrec(sat.tle.line1, sat.tle.line2);
    const satelliteId = satelliteIdForRef(sat.satelliteRef);
    for (const station of enabledStations) {
      const look = createLookSnapshot(satrec, station, new Date(timestampMs));
      if (!look) continue;

      const pairPasses = passMap.get(`${satelliteId}:${station.id}`) ?? [];
      const activePass = pairPasses.find((pass) => new Date(pass.aos).getTime() <= timestampMs && timestampMs <= new Date(pass.los).getTime());
      const nextPass = pairPasses.find((pass) => new Date(pass.aos).getTime() > timestampMs);
      const visible = look.elevationDeg >= station.elevationMaskDeg;
      const priorityLink = matchesPriority(input.priorityTarget, satelliteId, station.id);
      const canUseFallback = priorityLink || fallbackEstimates < 4;

      if (visible) {
        const fallbackCountdown = activePass
          ? undefined
          : canUseFallback
            ? estimateThresholdCountdown({
                satrec,
                station,
                timestampMs,
                satelliteId,
                mode: 'LOS',
              })
            : undefined;
        if (!activePass && fallbackCountdown) fallbackEstimates += 1;
        links.push({
          satelliteRef: cloneRef(sat.satelliteRef),
          satelliteId,
          satelliteName: sat.name,
          groundStationId: station.id,
          groundStationName: station.name,
          elevationDeg: look.elevationDeg,
          azimuthDeg: look.azimuthDeg,
          status: 'IN_CONTACT',
          aos: activePass?.aos,
          tca: activePass?.tca,
          los: activePass?.los,
          countdownSeconds: activePass ? secondsBetween(timestampMs, activePass.los) : fallbackCountdown?.seconds,
          countdownIsLowerBound: activePass?.losIsPredictionHorizon || fallbackCountdown?.isLowerBound || undefined,
        });
        continue;
      }

      const fallbackCountdown = !nextPass && canUseFallback
        ? estimateThresholdCountdown({
            satrec,
            station,
            timestampMs,
            satelliteId,
            mode: 'AOS',
          })
        : undefined;
      if (!nextPass && fallbackCountdown) fallbackEstimates += 1;
      if (nextPass) {
        links.push({
          satelliteRef: cloneRef(sat.satelliteRef),
          satelliteId,
          satelliteName: sat.name,
          groundStationId: station.id,
          groundStationName: station.name,
          elevationDeg: look.elevationDeg,
          azimuthDeg: look.azimuthDeg,
          status: 'BEFORE_AOS',
          aos: nextPass.aos,
          tca: nextPass.tca,
          los: nextPass.los,
          countdownSeconds: secondsBetween(timestampMs, nextPass.aos),
        });
        continue;
      }

      links.push({
        satelliteRef: cloneRef(sat.satelliteRef),
        satelliteId,
        satelliteName: sat.name,
        groundStationId: station.id,
        groundStationName: station.name,
        elevationDeg: look.elevationDeg,
        azimuthDeg: look.azimuthDeg,
        status: fallbackCountdown ? 'BEFORE_AOS' : 'AFTER_LOS',
        countdownSeconds: fallbackCountdown?.seconds,
        countdownIsLowerBound: fallbackCountdown?.isLowerBound || undefined,
      });
    }
  }

  return links.sort(compareLinks);
}

export function createLookSnapshot(satrec: satellite.SatRec, station: GroundStation, timestamp: Date): LookSnapshot | null {
  const propagated = satellite.propagate(satrec, timestamp);
  if (!propagated.position || propagated.position === true) return null;
  const observerGd = {
    longitude: satellite.degreesToRadians(station.lonDeg),
    latitude: satellite.degreesToRadians(station.latDeg),
    height: station.altitudeM / 1000,
  };
  const gmst = satellite.gstime(timestamp);
  const positionEcf = satellite.eciToEcf(propagated.position, gmst);
  const look = satellite.ecfToLookAngles(observerGd, positionEcf);
  return {
    azimuthDeg: radiansToDegrees(look.azimuth),
    elevationDeg: radiansToDegrees(look.elevation),
  };
}

export function satelliteIdForRef(refItem: FleetMemberRef) {
  return refItem.refType === 'catalog' ? `catalog:${refItem.catalogNumber}` : `custom:${refItem.customTleId}`;
}

export function sameRef(left: FleetMemberRef, right: FleetMemberRef) {
  if (left.refType !== right.refType) return false;
  if (left.refType === 'catalog') return left.catalogNumber === right.catalogNumber;
  return left.customTleId === right.customTleId;
}

function compareLinks(left: LiveContactLink, right: LiveContactLink) {
  const statusRank = { IN_CONTACT: 0, BEFORE_AOS: 1, AFTER_LOS: 2 };
  const rankDelta = statusRank[left.status] - statusRank[right.status];
  if (rankDelta) return rankDelta;
  return (left.countdownSeconds ?? Number.POSITIVE_INFINITY) - (right.countdownSeconds ?? Number.POSITIVE_INFINITY);
}

function indexPassPredictions(passPredictions: PassPrediction[]) {
  const map = new Map<string, PassPrediction[]>();
  for (const pass of passPredictions) {
    const key = `${satelliteIdForRef(pass.satelliteRef)}:${pass.groundStationId}`;
    const passes = map.get(key);
    if (passes) {
      passes.push(pass);
    } else {
      map.set(key, [pass]);
    }
  }
  for (const passes of map.values()) {
    passes.sort((left, right) => left.aos.localeCompare(right.aos));
  }
  return map;
}

function matchesPriority(target: MapFocusTarget | null | undefined, satelliteId: string, stationId: string) {
  if (!target) return false;
  return target.type === 'satellite' ? target.id === satelliteId : target.id === stationId;
}

function estimateThresholdCountdown({
  satrec,
  station,
  timestampMs,
  satelliteId,
  mode,
}: {
  satrec: satellite.SatRec;
  station: GroundStation;
  timestampMs: number;
  satelliteId: string;
  mode: 'LOS' | 'AOS';
}) {
  const cacheKey = `${mode}:${satelliteId}:${station.id}:${station.elevationMaskDeg}:${Math.floor(timestampMs / 60_000)}`;
  const cached = thresholdEstimateCache.get(cacheKey);
  if (cached) return cached;

  const maxMinutes = 24 * 60;
  const stepMs = mode === 'LOS' ? 60_000 : 120_000;
  const startedVisible = mode === 'LOS';
  let result: ThresholdEstimate | null = null;

  for (let elapsedMs = stepMs; elapsedMs <= maxMinutes * 60_000; elapsedMs += stepMs) {
    const look = createLookSnapshot(satrec, station, new Date(timestampMs + elapsedMs));
    if (!look) continue;
    const visible = look.elevationDeg >= station.elevationMaskDeg;
    if (startedVisible ? !visible : visible) {
      result = { seconds: Math.max(0, Math.round(elapsedMs / 1000)) };
      break;
    }
  }

  if (!result && mode === 'LOS') {
    result = { seconds: maxMinutes * 60, isLowerBound: true };
  }

  if (result) {
    thresholdEstimateCache.set(cacheKey, result);
    if (thresholdEstimateCache.size > THRESHOLD_ESTIMATE_CACHE_MAX) {
      thresholdEstimateCache.clear();
    }
  }
  return result;
}

function secondsBetween(fromMs: number, toIso: string) {
  const toMs = new Date(toIso).getTime();
  if (!Number.isFinite(toMs)) return undefined;
  return Math.max(0, Math.round((toMs - fromMs) / 1000));
}

function cloneRef(refItem: FleetMemberRef): FleetMemberRef {
  return {
    refType: refItem.refType,
    catalogNumber: refItem.catalogNumber,
    customTleId: refItem.customTleId,
    displayName: refItem.displayName,
    tags: [...refItem.tags],
  };
}

function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI;
}

interface ThresholdEstimate {
  seconds: number;
  isLowerBound?: boolean;
}

const THRESHOLD_ESTIMATE_CACHE_MAX = 900;
const thresholdEstimateCache = new Map<string, ThresholdEstimate>();
