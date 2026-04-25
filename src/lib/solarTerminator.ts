export interface SubsolarPoint {
  latDeg: number;
  lonDeg: number;
}

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MERCATOR_MAX_LAT = 85.05112878;

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
  const outerWorld = rectPath(0, 0, width, height);
  const dayPolygons = [-360, 0, 360].map((shift) => createDaylightPolygonPath(subsolar, width, height, samples, shift));
  return [outerWorld, ...dayPolygons].join(' ');
}

export function isNight(lonDeg: number, latDeg: number, subsolar: SubsolarPoint) {
  const lat = latDeg * DEG_TO_RAD;
  const declination = subsolar.latDeg * DEG_TO_RAD;
  const hourAngle = normalize180(lonDeg - subsolar.lonDeg) * DEG_TO_RAD;
  const solarAltitude =
    Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  return solarAltitude < 0;
}

function createDaylightPolygonPath(subsolar: SubsolarPoint, width: number, height: number, samples: number, lonShift: number) {
  const leftBoundary: MapPoint[] = [];
  const rightBoundary: MapPoint[] = [];
  const declination = subsolar.latDeg * DEG_TO_RAD;
  const tanDeclination = Math.tan(declination);

  for (let index = 0; index <= samples; index += 1) {
    const lat = -MERCATOR_MAX_LAT + (index / samples) * MERCATOR_MAX_LAT * 2;
    const halfDaylight = daylightHalfAngleDeg(lat, tanDeclination);
    const leftLon = subsolar.lonDeg - halfDaylight + lonShift;
    const rightLon = subsolar.lonDeg + halfDaylight + lonShift;
    leftBoundary.push(lonLatToPoint(leftLon, lat, width, height));
    rightBoundary.push(lonLatToPoint(rightLon, lat, width, height));
  }

  const rightBoundaryReversed = [...rightBoundary].reverse();
  return `${smoothOpenPath(leftBoundary)} L ${formatPoint(rightBoundaryReversed[0])} ${smoothOpenPath(rightBoundaryReversed).replace(/^M [^C]+? /, '')} Z`;
}

function daylightHalfAngleDeg(latDeg: number, tanDeclination: number) {
  const tanLat = Math.tan(latDeg * DEG_TO_RAD);
  const horizonArgument = -tanLat * tanDeclination;
  if (horizonArgument <= -1) return 180;
  if (horizonArgument >= 1) return 0;
  return Math.acos(horizonArgument) * RAD_TO_DEG;
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

function formatPoint(point: MapPoint) {
  return `${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
}
