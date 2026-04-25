import * as satellite from 'satellite.js';
import type { GroundStation, TleRaw } from '@/domain/types';
import { createLookSnapshot } from '@/lib/contactLinks';

export interface VisibleSatelliteCandidate {
  catalogNumber: number;
  name: string;
  group: string;
  ownerCountry: string;
  tle: TleRaw;
}

export interface VisibleSatelliteResult {
  catalogNumber: number;
  name: string;
  group: string;
  ownerCountry: string;
  elevationDeg: number;
  azimuthDeg: number;
}

export interface VisibleSatellitesInput {
  station: GroundStation;
  satellites: VisibleSatelliteCandidate[];
  timestampIso: string;
  limit?: number;
}

export interface VisibleSatellitesWorkerInput extends VisibleSatellitesInput {
  requestId?: number;
}

export interface VisibleSatellitesWorkerResult {
  requestId?: number;
  visible: VisibleSatelliteResult[];
}

export function findVisibleSatellites(input: VisibleSatellitesInput): VisibleSatelliteResult[] {
  const timestamp = new Date(input.timestampIso);
  if (!Number.isFinite(timestamp.getTime())) return [];

  const visible: VisibleSatelliteResult[] = [];
  for (const item of input.satellites) {
    const satrec = satellite.twoline2satrec(item.tle.line1, item.tle.line2);
    const look = createLookSnapshot(satrec, input.station, timestamp);
    if (!look || look.elevationDeg < input.station.elevationMaskDeg) continue;
    visible.push({
      catalogNumber: item.catalogNumber,
      name: item.name,
      group: item.group,
      ownerCountry: item.ownerCountry,
      elevationDeg: look.elevationDeg,
      azimuthDeg: look.azimuthDeg,
    });
  }

  return visible.sort((left, right) => right.elevationDeg - left.elevationDeg).slice(0, input.limit ?? 500);
}
