export interface SubsolarPoint {
  latDeg: number;
  lonDeg: number;
}

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MERCATOR_MAX_LAT = 85.05112878;
const WORLD_LON_MIN = -180;
const WORLD_LON_MAX = 180;
const INTERVAL_EPSILON = 0.0001;

export function getSubsolarPoint(timestamp: Date): SubsolarPoint {
  const julianDate = timestamp.getTime() / 86_400_000 + 2_440_587.5;
  const daysSinceJ2000 = julianDate - 2_451_545.0;
  const meanLongitude = normalize360(280.459 + 0.98564736 * daysSinceJ2000);
  const meanAnomaly = normalize360(357.529 + 0.98560028 * daysSinceJ2000) * DEG_TO_RAD;
  const eclipticLongitude =
    normalize360(meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG_TO_RAD;
  const obliquity = (23.439 - 0.00000036 * daysSinceJ2000) * DEG_TO_RAD;

  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const gmst = greenwichMeanSiderealTime(julianDate) * DEG_TO_RAD;

  return {
    latDeg: declination * RAD_TO_DEG,
    lonDeg: normalize180((rightAscension - gmst) * RAD_TO_DEG),
  };
}

export function createNightMaskPath(timestamp: Date, width: number, height: number, rows = 72, columns = 144) {
  const subsolar = getSubsolarPoint(timestamp);
  const samples = Math.max(rows * 4, columns * 2, 360);
  const declination = subsolar.latDeg * DEG_TO_RAD;
  const tanDeclination = Math.tan(declination);
  const records: NightIntervalRecord[] = [];

  for (let index = 0; index <= samples; index += 1) {
    const lat = -MERCATOR_MAX_LAT + (index / samples) * MERCATOR_MAX_LAT * 2;
    for (const interval of nightIntervalsAtLatitude(subsolar.lonDeg, lat, tanDeclination)) {
      records.push({ index, latDeg: lat, startLon: interval.start, endLon: interval.end });
    }
  }

  return [
    ...buildFullNightPaths(records, width, height, MERCATOR_MAX_LAT / samples),
    ...buildLeftNightPaths(records, width, height),
    ...buildRightNightPaths(records, width, height),
    ...buildMiddleNightPaths(records, width, height),
  ].join(' ');
}

export function isNight(lonDeg: number, latDeg: number, subsolar: SubsolarPoint) {
  const lat = latDeg * DEG_TO_RAD;
  const declination = subsolar.latDeg * DEG_TO_RAD;
  const hourAngle = normalize180(lonDeg - subsolar.lonDeg) * DEG_TO_RAD;
  const solarAltitude =
    Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  return solarAltitude < 0;
}

function daylightHalfAngleDeg(latDeg: number, tanDeclination: number) {
  const tanLat = Math.tan(latDeg * DEG_TO_RAD);
  const horizonArgument = -tanLat * tanDeclination;
  if (horizonArgument <= -1) return 180;
  if (horizonArgument >= 1) return 0;
  return Math.acos(horizonArgument) * RAD_TO_DEG;
}

function nightIntervalsAtLatitude(subsolarLonDeg: number, latDeg: number, tanDeclination: number): GeoInterval[] {
  const halfDaylight = daylightHalfAngleDeg(latDeg, tanDeclination);
  if (halfDaylight >= 180 - INTERVAL_EPSILON) return [];
  if (halfDaylight <= INTERVAL_EPSILON) return [{ start: WORLD_LON_MIN, end: WORLD_LON_MAX }];

  const dayIntervals = mergeIntervals(
    [-360, 0, 360]
      .map((shift) => ({
        start: subsolarLonDeg - halfDaylight + shift,
        end: subsolarLonDeg + halfDaylight + shift,
      }))
      .map((interval) => ({
        start: Math.max(interval.start, WORLD_LON_MIN),
        end: Math.min(interval.end, WORLD_LON_MAX),
      }))
      .filter((interval) => interval.end - interval.start > INTERVAL_EPSILON),
  );

  const nightIntervals: GeoInterval[] = [];
  let cursor = WORLD_LON_MIN;
  for (const interval of dayIntervals) {
    if (interval.start - cursor > INTERVAL_EPSILON) {
      nightIntervals.push({ start: cursor, end: interval.start });
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (WORLD_LON_MAX - cursor > INTERVAL_EPSILON) {
    nightIntervals.push({ start: cursor, end: WORLD_LON_MAX });
  }
  return nightIntervals;
}

function mergeIntervals(intervals: GeoInterval[]) {
  const sorted = [...intervals].sort((left, right) => left.start - right.start);
  const merged: GeoInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.start - previous.end > INTERVAL_EPSILON) {
      merged.push({ ...interval });
      continue;
    }
    previous.end = Math.max(previous.end, interval.end);
  }
  return merged;
}

function buildFullNightPaths(records: NightIntervalRecord[], width: number, height: number, halfLatStep: number) {
  return splitConsecutive(
    records.filter((record) => touchesLeftEdge(record) && touchesRightEdge(record)),
  ).map((segment) => {
    const first = segment[0];
    const last = segment[segment.length - 1];
    const bottomLat = clamp(first.latDeg - halfLatStep, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT);
    const topLat = clamp(last.latDeg + halfLatStep, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT);
    return rectPath(0, lonLatToY(topLat, height), width, lonLatToY(bottomLat, height));
  });
}

function buildLeftNightPaths(records: NightIntervalRecord[], width: number, height: number) {
  return splitConsecutive(
    records.filter((record) => touchesLeftEdge(record) && !touchesRightEdge(record)),
  ).map((segment) => {
    const innerBoundary = segment.map((record) => lonLatToPoint(record.endLon, record.latDeg, width, height));
    const first = segment[0];
    const last = segment[segment.length - 1];
    return `${smoothOpenPath(innerBoundary)} L ${formatPoint(lonLatToPoint(WORLD_LON_MIN, last.latDeg, width, height))} L ${formatPoint(lonLatToPoint(WORLD_LON_MIN, first.latDeg, width, height))} Z`;
  });
}

function buildRightNightPaths(records: NightIntervalRecord[], width: number, height: number) {
  return splitConsecutive(
    records.filter((record) => touchesRightEdge(record) && !touchesLeftEdge(record)),
  ).map((segment) => {
    const innerBoundary = segment.map((record) => lonLatToPoint(record.startLon, record.latDeg, width, height));
    const first = segment[0];
    const last = segment[segment.length - 1];
    return `${smoothOpenPath(innerBoundary)} L ${formatPoint(lonLatToPoint(WORLD_LON_MAX, last.latDeg, width, height))} L ${formatPoint(lonLatToPoint(WORLD_LON_MAX, first.latDeg, width, height))} Z`;
  });
}

function buildMiddleNightPaths(records: NightIntervalRecord[], width: number, height: number) {
  return splitConsecutive(
    records.filter((record) => !touchesLeftEdge(record) && !touchesRightEdge(record)),
  ).map((segment) => {
    const leftBoundary = segment.map((record) => lonLatToPoint(record.startLon, record.latDeg, width, height));
    const rightBoundary = segment
      .map((record) => lonLatToPoint(record.endLon, record.latDeg, width, height))
      .reverse();
    return `${smoothOpenPath(leftBoundary)} L ${formatPoint(rightBoundary[0])} ${removeInitialMove(smoothOpenPath(rightBoundary))} Z`;
  });
}

function splitConsecutive(records: NightIntervalRecord[]) {
  const segments: NightIntervalRecord[][] = [];
  for (const record of records) {
    const current = segments.at(-1);
    const previous = current?.at(-1);
    if (!current || !previous || record.index !== previous.index + 1) {
      segments.push([record]);
      continue;
    }
    current.push(record);
  }
  return segments;
}

function touchesLeftEdge(record: NightIntervalRecord) {
  return record.startLon <= WORLD_LON_MIN + INTERVAL_EPSILON;
}

function touchesRightEdge(record: NightIntervalRecord) {
  return record.endLon >= WORLD_LON_MAX - INTERVAL_EPSILON;
}

function smoothOpenPath(points: MapPoint[]) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${formatPoint(points[0])}`;
  if (points.length === 2) return `M ${formatPoint(points[0])} L ${formatPoint(points[1])}`;

  const commands = [`M ${formatPoint(points[0])}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(index - 1, 0)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(index + 2, points.length - 1)];
    const c1 = {
      x: p1.x + (p2.x - p0.x) / 6,
      y: p1.y + (p2.y - p0.y) / 6,
    };
    const c2 = {
      x: p2.x - (p3.x - p1.x) / 6,
      y: p2.y - (p3.y - p1.y) / 6,
    };
    commands.push(`C ${formatPoint(c1)} ${formatPoint(c2)} ${formatPoint(p2)}`);
  }
  return commands.join(' ');
}

function removeInitialMove(path: string) {
  return path.replace(/^M -?\d+(?:\.\d+)? -?\d+(?:\.\d+)?\s*/, '');
}

function rectPath(x1: number, y1: number, x2: number, y2: number) {
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} H ${x2.toFixed(2)} V ${y2.toFixed(2)} H ${x1.toFixed(2)} Z`;
}

function lonLatToPoint(lonDeg: number, latDeg: number, width: number, height: number): MapPoint {
  return {
    x: lonLatToX(lonDeg, width),
    y: lonLatToY(latDeg, height),
  };
}

function lonLatToX(lonDeg: number, width: number) {
  return ((lonDeg + 180) / 360) * width;
}

function lonLatToY(latDeg: number, height: number) {
  const lat = clamp(latDeg, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT);
  const sinLat = Math.sin(lat * DEG_TO_RAD);
  return (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * height;
}

function greenwichMeanSiderealTime(julianDate: number) {
  const centuries = (julianDate - 2_451_545.0) / 36_525;
  return normalize360(
    280.46061837 +
      360.98564736629 * (julianDate - 2_451_545.0) +
      0.000387933 * centuries * centuries -
      (centuries * centuries * centuries) / 38_710_000,
  );
}

function normalize360(value: number) {
  return ((value % 360) + 360) % 360;
}

function normalize180(value: number) {
  const normalized = normalize360(value);
  return normalized > 180 ? normalized - 360 : normalized;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

interface MapPoint {
  x: number;
  y: number;
}

interface GeoInterval {
  start: number;
  end: number;
}

interface NightIntervalRecord {
  index: number;
  latDeg: number;
  startLon: number;
  endLon: number;
}

function formatPoint(point: MapPoint) {
  return `${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
}
