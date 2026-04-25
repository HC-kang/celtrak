import * as satellite from 'satellite.js';
import type { FleetMemberRef, GroundStation, LiveContactLink, PassPrediction, TleRaw } from '@/domain/types';

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
}): LiveContactLink[] {
  const timestampMs = new Date(input.timestampIso).getTime();
  if (!Number.isFinite(timestampMs)) return [];

  const enabledStations = input.stations.filter((station) => station.enabled);
  const links: LiveContactLink[] = [];

  for (const sat of input.satellites) {
    const satrec = satellite.twoline2satrec(sat.tle.line1, sat.tle.line2);
    const satelliteId = satelliteIdForRef(sat.satelliteRef);
    for (const station of enabledStations) {
      const look = createLookSnapshot(satrec, station, new Date(timestampMs));
      if (!look) continue;

      const pairPasses = input.passPredictions
        .filter((pass) => pass.groundStationId === station.id && sameRef(pass.satelliteRef, sat.satelliteRef))
        .sort((left, right) => left.aos.localeCompare(right.aos));
      const activePass = pairPasses.find((pass) => new Date(pass.aos).getTime() <= timestampMs && timestampMs <= new Date(pass.los).getTime());
      const nextPass = pairPasses.find((pass) => new Date(pass.aos).getTime() > timestampMs);
      const visible = look.elevationDeg >= station.elevationMaskDeg;

      if (visible) {
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
          countdownSeconds: activePass ? secondsBetween(timestampMs, activePass.los) : undefined,
        });
        continue;
      }

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
        status: 'AFTER_LOS',
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
