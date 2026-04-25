import * as satellite from 'satellite.js';
import type { GroundStation, LiveContactStatus, TleRaw } from '@/domain/types';
import { createLookSnapshot } from '@/lib/contactLinks';

export type RefinableContactStatus = Extract<LiveContactStatus, 'IN_CONTACT' | 'BEFORE_AOS'>;

export interface ContactPrecisionCandidate {
  satelliteId: string;
  groundStationId: string;
  status: RefinableContactStatus;
  tle: TleRaw;
  station: GroundStation;
}

export interface ContactPrecisionRequest {
  requestId: number;
  timestampIso: string;
  candidates: ContactPrecisionCandidate[];
}

export interface ContactPrecisionResult {
  satelliteId: string;
  groundStationId: string;
  status: RefinableContactStatus;
  eventIso?: string;
  countdownSeconds?: number;
  countdownIsLowerBound?: boolean;
}

export interface ContactPrecisionWorkerResult {
  requestId: number;
  results: ContactPrecisionResult[];
}

const FOCUS_SCAN_STEP_MS = 15_000;
const PRECISION_MS = 1_000;
const MAX_SCAN_MS = 24 * 60 * 60 * 1000;

export function refineContactCountdowns(input: Omit<ContactPrecisionRequest, 'requestId'>): ContactPrecisionResult[] {
  const startMs = new Date(input.timestampIso).getTime();
  if (!Number.isFinite(startMs)) return [];

  return input.candidates.map((candidate) => refineContactCountdown(candidate, startMs)).filter((item): item is ContactPrecisionResult => Boolean(item));
}

function refineContactCountdown(candidate: ContactPrecisionCandidate, startMs: number): ContactPrecisionResult | null {
  const satrec = satellite.twoline2satrec(candidate.tle.line1, candidate.tle.line2);
  const startVisible = isVisible(satrec, candidate.station, startMs);
  if (startVisible === null) return null;

  const targetVisible = candidate.status === 'IN_CONTACT' ? false : true;
  if (startVisible === targetVisible) {
    return resultFor(candidate, startMs, startMs);
  }

  let lowerMs = startMs;
  let upperMs: number | null = null;

  for (let elapsedMs = FOCUS_SCAN_STEP_MS; elapsedMs <= MAX_SCAN_MS; elapsedMs += FOCUS_SCAN_STEP_MS) {
    const candidateMs = startMs + elapsedMs;
    const visible = isVisible(satrec, candidate.station, candidateMs);
    if (visible === null) continue;
    if (visible === targetVisible) {
      upperMs = candidateMs;
      break;
    }
    lowerMs = candidateMs;
  }

  if (upperMs === null) {
    if (candidate.status !== 'IN_CONTACT') return null;
    return resultFor(candidate, startMs, startMs + MAX_SCAN_MS, true);
  }

  const eventMs = refineThreshold({
    satrec,
    station: candidate.station,
    lowerMs,
    upperMs,
    targetVisible,
  });
  return resultFor(candidate, startMs, eventMs);
}

function refineThreshold({
  satrec,
  station,
  lowerMs,
  upperMs,
  targetVisible,
}: {
  satrec: satellite.SatRec;
  station: GroundStation;
  lowerMs: number;
  upperMs: number;
  targetVisible: boolean;
}) {
  let low = lowerMs;
  let high = upperMs;
  while (high - low > PRECISION_MS) {
    const midpoint = Math.floor((low + high) / 2);
    const visible = isVisible(satrec, station, midpoint);
    if (visible === null) break;
    if (visible === targetVisible) {
      high = midpoint;
    } else {
      low = midpoint;
    }
  }
  return high;
}

function resultFor(candidate: ContactPrecisionCandidate, startMs: number, eventMs: number, countdownIsLowerBound = false): ContactPrecisionResult {
  return {
    satelliteId: candidate.satelliteId,
    groundStationId: candidate.groundStationId,
    status: candidate.status,
    eventIso: new Date(eventMs).toISOString(),
    countdownSeconds: Math.max(0, Math.round((eventMs - startMs) / 1000)),
    countdownIsLowerBound,
  };
}

function isVisible(satrec: satellite.SatRec, station: GroundStation, timestampMs: number) {
  const look = createLookSnapshot(satrec, station, new Date(timestampMs));
  if (!look) return null;
  return look.elevationDeg >= station.elevationMaskDeg;
}
