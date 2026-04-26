import * as satellite from 'satellite.js';

export interface GroundTrackSatelliteInput {
  id: string;
  line1: string;
  line2: string;
}

export interface GroundTrackBuildInput {
  requestId: number;
  satellites: GroundTrackSatelliteInput[];
  cacheStartMs: number;
  cacheEndMs: number;
  errorThresholdMapUnits: number;
  seedStepMs: number;
  minStepMs: number;
  mapWidth: number;
  mapHeight: number;
  qualityKey: string;
}

export interface GroundTrackWorkerResult {
  requestId: number;
  tracks: GroundTrackEphemeris[];
}

export interface GroundTrackEphemeris {
  id: string;
  line1: string;
  line2: string;
  cacheStartMs: number;
  cacheEndMs: number;
  qualityKey: string;
  samples: GroundTrackSample[];
}

export interface GroundTrackSample {
  t: number;
  x: number;
  y: number;
  lon: number;
  lat: number;
}

export interface GroundTrackPoint {
  x: number;
  y: number;
}

export interface GroundTrackInterpolatedPoint extends GroundTrackPoint {
  lon: number;
  lat: number;
}

type SatRec = ReturnType<typeof satellite.twoline2satrec>;

const WEB_MERCATOR_MAX_LAT = 85.05112878;
const MAX_ADAPTIVE_DEPTH = 12;

export function buildGroundTrackEphemeris(input: GroundTrackBuildInput): GroundTrackWorkerResult {
  const tracks = input.satellites
    .map((entry): GroundTrackEphemeris | null => {
      const satrec = satellite.twoline2satrec(entry.line1, entry.line2);
      const samples = buildAdaptiveSamples(satrec, input);
      if (samples.length < 2) return null;
      return {
        id: entry.id,
        line1: entry.line1,
        line2: entry.line2,
        cacheStartMs: input.cacheStartMs,
        cacheEndMs: input.cacheEndMs,
        qualityKey: input.qualityKey,
        samples,
      };
    })
    .filter((track): track is GroundTrackEphemeris => Boolean(track));

  return {
    requestId: input.requestId,
    tracks,
  };
}

export function interpolateGroundTrackPoint(
  track: Pick<GroundTrackEphemeris, 'samples'>,
  timestampMs: number,
  mapWidth: number,
): GroundTrackInterpolatedPoint | null {
  const samples = track.samples;
  if (samples.length < 2) return null;
  if (timestampMs < samples[0].t || timestampMs > samples[samples.length - 1].t) return null;

  let low = 0;
  let high = samples.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const sample = samples[mid];
    if (sample.t === timestampMs) return sample;
    if (sample.t < timestampMs) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const left = samples[Math.max(high, 0)];
  const right = samples[Math.min(low, samples.length - 1)];
  if (!left || !right || left.t === right.t) return left ?? right ?? null;

  const ratio = (timestampMs - left.t) / (right.t - left.t);
  const rightX = nearestWrappedValue(right.x, left.x, mapWidth);
  const rightLon = nearestWrappedValue(right.lon, left.lon, 360);
  const x = positiveModulo(lerp(left.x, rightX, ratio), mapWidth);
  const lon = normalizeLongitude(lerp(left.lon, rightLon, ratio));
  return {
    x,
    y: lerp(left.y, right.y, ratio),
    lon,
    lat: lerp(left.lat, right.lat, ratio),
  };
}

export function buildGroundTrackSegments(
  track: Pick<GroundTrackEphemeris, 'samples'>,
  startMs: number,
  endMs: number,
  mapWidth: number,
): GroundTrackPoint[][] {
  const start = interpolateGroundTrackPoint(track, startMs, mapWidth);
  const end = interpolateGroundTrackPoint(track, endMs, mapWidth);
  if (!start || !end) return [];

  const points: GroundTrackPoint[] = [start];
  for (const sample of track.samples) {
    if (sample.t > startMs && sample.t < endMs) {
      points.push(sample);
    }
  }
  points.push(end);
  return splitGroundTrackSegments(points, mapWidth);
}

export function splitGroundTrackSegments(points: GroundTrackPoint[], mapWidth: number) {
  const segments: GroundTrackPoint[][] = [];
  let current: GroundTrackPoint[] = [];
  for (const point of points) {
    const previous = current[current.length - 1];
    if (previous && Math.abs(previous.x - point.x) > mapWidth * 0.45) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

export function projectGroundTrackSample(
  satrec: SatRec,
  timestampMs: number,
  mapWidth: number,
  mapHeight: number,
): GroundTrackSample | null {
  const timestamp = new Date(timestampMs);
  const propagated = satellite.propagate(satrec, timestamp);
  if (!propagated.position || propagated.position === true) return null;
  const gmst = satellite.gstime(timestamp);
  const geo = satellite.eciToGeodetic(propagated.position, gmst);
  const lon = radiansToDegrees(geo.longitude);
  const lat = radiansToDegrees(geo.latitude);
  const point = projectLonLat(lon, lat, mapWidth, mapHeight);
  return {
    t: timestampMs,
    lon,
    lat,
    x: point.x,
    y: point.y,
  };
}

export function projectLonLat(lon: number, lat: number, mapWidth: number, mapHeight: number): GroundTrackPoint {
  const sinLat = Math.sin((clamp(lat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT) * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * mapWidth,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * mapHeight,
  };
}

export function nearestWrappedValue(value: number, anchor: number, period: number) {
  return value + Math.round((anchor - value) / period) * period;
}

function buildAdaptiveSamples(satrec: SatRec, input: GroundTrackBuildInput) {
  const samples: GroundTrackSample[] = [];
  const first = projectGroundTrackSample(satrec, input.cacheStartMs, input.mapWidth, input.mapHeight);
  if (!first) return samples;
  samples.push(first);

  let left = first;
  for (let timestampMs = input.cacheStartMs + input.seedStepMs; timestampMs <= input.cacheEndMs; timestampMs += input.seedStepMs) {
    const rightTimestamp = Math.min(timestampMs, input.cacheEndMs);
    const right = projectGroundTrackSample(satrec, rightTimestamp, input.mapWidth, input.mapHeight);
    if (!right) continue;
    appendAdaptiveInterval(satrec, left, right, samples, input, 0);
    left = right;
  }

  if (left.t < input.cacheEndMs) {
    const right = projectGroundTrackSample(satrec, input.cacheEndMs, input.mapWidth, input.mapHeight);
    if (right) appendAdaptiveInterval(satrec, left, right, samples, input, 0);
  }

  return dedupeSamples(samples);
}

function appendAdaptiveInterval(
  satrec: SatRec,
  left: GroundTrackSample,
  right: GroundTrackSample,
  output: GroundTrackSample[],
  input: GroundTrackBuildInput,
  depth: number,
) {
  const durationMs = right.t - left.t;
  if (durationMs <= input.minStepMs || depth >= MAX_ADAPTIVE_DEPTH) {
    output.push(right);
    return;
  }

  const midTimestamp = left.t + durationMs / 2;
  const mid = projectGroundTrackSample(satrec, midTimestamp, input.mapWidth, input.mapHeight);
  if (!mid) {
    output.push(right);
    return;
  }

  if (projectedMidpointError(left, mid, right, input.mapWidth) <= input.errorThresholdMapUnits) {
    output.push(right);
    return;
  }

  appendAdaptiveInterval(satrec, left, mid, output, input, depth + 1);
  appendAdaptiveInterval(satrec, mid, right, output, input, depth + 1);
}

function projectedMidpointError(
  left: GroundTrackSample,
  mid: GroundTrackSample,
  right: GroundTrackSample,
  mapWidth: number,
) {
  const rightX = nearestWrappedValue(right.x, left.x, mapWidth);
  const expectedX = (left.x + rightX) / 2;
  const expectedY = (left.y + right.y) / 2;
  const midX = nearestWrappedValue(mid.x, expectedX, mapWidth);
  return Math.hypot(midX - expectedX, mid.y - expectedY);
}

function dedupeSamples(samples: GroundTrackSample[]) {
  const result: GroundTrackSample[] = [];
  for (const sample of samples) {
    if (result[result.length - 1]?.t !== sample.t) {
      result.push(sample);
    }
  }
  return result;
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function normalizeLongitude(lon: number) {
  const normalized = positiveModulo(lon + 180, 360) - 180;
  return normalized === -180 ? 180 : normalized;
}

function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function lerp(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}
