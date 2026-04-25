import * as satellite from 'satellite.js';
import type { FleetMemberRef, GroundStation, PassPrediction, TleRaw } from '@/domain/types';

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
}

export function predictPasses({ satellites, stations, hours, startTimeIso }: PassPredictionInput): PassPrediction[] {
  const results: PassPrediction[] = [];
  const start = startTimeIso ? new Date(startTimeIso) : new Date();
  const end = new Date(start.getTime() + hours * 60 * 60 * 1000);
  const stepMinutes = 3;

  for (const sat of satellites) {
    const satrec = satellite.twoline2satrec(sat.tle.line1, sat.tle.line2);
    for (const station of stations.filter((item) => item.enabled)) {
      const observerGd = {
        longitude: satellite.degreesToRadians(station.lonDeg),
        latitude: satellite.degreesToRadians(station.latDeg),
        height: station.altitudeM / 1000,
      };
      let currentTime = new Date(start);
      let inPass = false;
      let passStart: ReturnType<typeof createLookSnapshot> | null = null;
      let peak: ReturnType<typeof createLookSnapshot> | null = null;

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
        } else if (inPass && passStart && peak) {
          const lastVisible = createLookSnapshot(satrec, observerGd, currentTime) ?? peak;
          results.push({
            origin: 'DERIVED',
            satelliteRef: sat.satelliteRef,
            groundStationId: station.id,
            aos: passStart.timestamp.toISOString(),
            tca: peak.timestamp.toISOString(),
            los: lastVisible.timestamp.toISOString(),
            maxElevationDeg: peak.elevationDeg,
            aosAzimuthDeg: passStart.azimuthDeg,
            losAzimuthDeg: lastVisible.azimuthDeg,
            illuminationAtTca: 'SUNLIT',
            computedAt: new Date().toISOString(),
          });
          inPass = false;
          passStart = null;
          peak = null;
        }

        currentTime = new Date(currentTime.getTime() + stepMinutes * 60 * 1000);
      }
    }
  }

  const maxResults = Math.min(Math.max(satellites.length * stations.length * 8, 48), 800);
  return results.sort((a, b) => a.aos.localeCompare(b.aos)).slice(0, maxResults);
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
