<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import * as satellite from 'satellite.js';
import type { CatalogEntry, GroundStation, LiveContactLink, MapFocusTarget } from '@/domain/types';
import { createNightMaskPath } from '@/lib/solarTerminator';

const props = defineProps<{
  satellites: CatalogEntry[];
  contactLinks?: LiveContactLink[];
  dataSaver?: boolean;
  focusedTarget?: MapFocusTarget | null;
  groundStations?: GroundStation[];
  livePlaybackRate?: number;
  orbitMode: 'live' | 'simulation';
  orbitTimeIso: string;
}>();

const emit = defineEmits<{
  'focus-target': [target: MapFocusTarget];
}>();

const BASE_TILE_ZOOM = 2;
const MAX_TILE_ZOOM = 7;
const TILE_SIZE = 256;
const MAP_WIDTH = TILE_SIZE * 2 ** BASE_TILE_ZOOM;
const MAP_HEIGHT = MAP_WIDTH;
const MAX_ZOOM = 8;
const TRAIL_START_MINUTES = -45;
const TRAIL_END_MINUTES = 120;
const TRACK_COLORS = ['#0070cc', '#1eaedb', '#53b1ff', '#ffffff', '#d53b00', '#1883fd'];
type SatRec = ReturnType<typeof satellite.twoline2satrec>;

const mapShell = ref<HTMLDivElement | null>(null);
const svgElement = ref<SVGSVGElement | null>(null);
const viewportSize = ref({ width: MAP_WIDTH, height: MAP_HEIGHT });
const zoom = ref(1);
const center = ref({ x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 });
const dragging = ref(false);
const userMovedMap = ref(false);
let resizeObserver: ResizeObserver | null = null;
let dragState: DragState | null = null;
let pinchState: PinchState | null = null;
let pointerDownSnapshot: PointerDownSnapshot | null = null;
const activePointers = new Map<number, PointerSnapshot>();

onMounted(() => {
  resizeObserver = new ResizeObserver(([entry]) => {
    if (!entry) return;
    viewportSize.value = {
      width: Math.max(entry.contentRect.width, 1),
      height: Math.max(entry.contentRect.height, 1),
    };
    if (!userMovedMap.value) {
      zoom.value = coverZoom.value;
      center.value = clampCenter(center.value.x, center.value.y, zoom.value);
    }
  });
  if (mapShell.value) {
    resizeObserver.observe(mapShell.value);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
});

const stationPoints = computed(() =>
  (props.groundStations ?? []).filter((station) => station.enabled).map((station, index) => ({
    id: station.id,
    ...toMapPoint(station.lonDeg, station.latDeg),
    name: station.name,
    elevationMaskDeg: station.elevationMaskDeg,
    labelAnchor: index % 2 === 0 ? 'start' : 'end',
  })),
);

const livePlaybackRate = computed(() => props.livePlaybackRate ?? 1);
const displayedTime = computed(() => new Date(props.orbitTimeIso));
const displayedTimestamp = computed(() => formatTimestampWithSeconds(displayedTime.value));
const nightMaskPath = computed(() => createNightMaskPath(displayedTime.value, MAP_WIDTH, MAP_HEIGHT));
const viewportAspect = computed(() => viewportSize.value.width / viewportSize.value.height);
const coverZoom = computed(() => Math.max(1, MAP_WIDTH / (MAP_HEIGHT * viewportAspect.value)));
const currentView = computed(() => {
  const width = MAP_WIDTH / zoom.value;
  const height = width / viewportAspect.value;
  const clamped = clampCenter(center.value.x, center.value.y, zoom.value);
  return {
    x: clamped.x - width / 2,
    y: clamped.y - height / 2,
    width,
    height,
  };
});
const mapViewBox = computed(() => {
  const view = currentView.value;
  return `${view.x.toFixed(2)} ${view.y.toFixed(2)} ${view.width.toFixed(2)} ${view.height.toFixed(2)}`;
});
const zoomPercent = computed(() => `${zoom.value.toFixed(1)}x`);

const plotted = computed(() =>
  props.satellites
    .map((entry, index) => {
      if (!entry.tle) return null;
      const satrec = satellite.twoline2satrec(entry.tle.line1, entry.tle.line2);
      const point = projectSatrec(satrec, displayedTime.value);
      if (!point) return null;
      const mapPoint = toMapPoint(point.lon, point.lat);
      const trail = props.dataSaver ? [] : buildTrail(satrec, displayedTime.value);
      const labelBounds = satelliteLabelBounds(mapPoint);
      return {
        id: `catalog:${entry.satcat.catalogNumber}`,
        entry,
        color: TRACK_COLORS[index % TRACK_COLORS.length],
        label: entry.satcat.objectName.replace(/\s*\(.+?\)\s*/g, '').slice(0, 18),
        point: mapPoint,
        labelBounds,
        geo: point,
        trailSegments: splitTrail(trail),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item)),
);

const activeContactSegments = computed(() =>
  (props.contactLinks ?? [])
    .filter((link) => link.status === 'IN_CONTACT')
    .map((link) => {
      const satellitePoint = plotted.value.find((item) => item.id === link.satelliteId);
      const stationPoint = stationPoints.value.find((station) => station.id === link.groundStationId);
      if (!satellitePoint || !stationPoint) return null;
      return {
        id: `${link.satelliteId}-${link.groundStationId}`,
        link,
        satellite: satellitePoint,
        station: stationPoint,
        focused: targetMatches(props.focusedTarget, { type: 'satellite', id: link.satelliteId }) || targetMatches(props.focusedTarget, { type: 'groundStation', id: link.groundStationId }),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item)),
);

const orbitStats = computed(() => {
  const tracked = plotted.value.length;
  const stations = stationPoints.value.length;
  const avgAltitude =
    props.satellites.reduce((sum, entry) => sum + ((entry.satcat.apogeeKm ?? 0) + (entry.satcat.perigeeKm ?? 0)) / 2, 0) /
    Math.max(props.satellites.length, 1);
  return {
    tracked,
    stations,
    avgAltitude: Math.round(avgAltitude).toLocaleString(),
    mode: props.orbitMode === 'simulation' ? 'SIM' : 'LIVE',
    clockLabel: props.orbitMode === 'simulation' ? 'SGP4 simulation' : `SGP4 live · ${livePlaybackRate.value}x`,
  };
});

const longitudeLines = computed(() => Array.from({ length: 11 }, (_, index) => (index * MAP_WIDTH) / 10));
const latitudeLines = computed(() => [-60, -30, 0, 30, 60].map((lat) => toMapPoint(0, lat).y));
const osmTiles = computed(() => {
  const tileZoom = clamp(BASE_TILE_ZOOM + Math.floor(Math.log2(Math.max(zoom.value, 1))), BASE_TILE_ZOOM, MAX_TILE_ZOOM);
  const zoomScale = 2 ** (tileZoom - BASE_TILE_ZOOM);
  const tileSize = TILE_SIZE / zoomScale;
  const maxTileIndex = 2 ** tileZoom - 1;
  const view = currentView.value;
  const startX = Math.max(0, Math.floor(view.x / tileSize) - 1);
  const endX = Math.min(maxTileIndex, Math.ceil((view.x + view.width) / tileSize) + 1);
  const startY = Math.max(0, Math.floor(view.y / tileSize) - 1);
  const endY = Math.min(maxTileIndex, Math.ceil((view.y + view.height) / tileSize) + 1);
  const tiles: OsmTile[] = [];

  for (let x = startX; x <= endX; x += 1) {
    for (let y = startY; y <= endY; y += 1) {
      tiles.push({
        id: `${tileZoom}-${x}-${y}`,
        href: `https://tile.openstreetmap.org/${tileZoom}/${x}/${y}.png`,
        x: x * tileSize,
        y: y * tileSize,
        size: tileSize,
      });
    }
  }

  return tiles;
});

function projectSatrec(satrec: SatRec, timestamp: Date) {
  const propagated = satellite.propagate(satrec, timestamp);
  if (!propagated.position || propagated.position === true) return null;
  const gmst = satellite.gstime(timestamp);
  const geo = satellite.eciToGeodetic(propagated.position, gmst);
  return {
    lon: radiansToDegrees(geo.longitude),
    lat: radiansToDegrees(geo.latitude),
  };
}

function buildTrail(satrec: SatRec, base: Date) {
  const points: MapPoint[] = [];
  const stepMinutes = props.dataSaver ? 6 : 2;
  for (let offset = TRAIL_START_MINUTES; offset <= TRAIL_END_MINUTES; offset += stepMinutes) {
    const projected = projectSatrec(satrec, new Date(base.getTime() + offset * 60 * 1000));
    if (!projected) continue;
    points.push(toMapPoint(projected.lon, projected.lat));
  }
  return points;
}

function toMapPoint(lon: number, lat: number) {
  const sinLat = Math.sin((clamp(lat, -85.05112878, 85.05112878) * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * MAP_WIDTH,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * MAP_HEIGHT,
  };
}

function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI;
}

function zoomIn() {
  setZoom(zoom.value * 1.28);
}

function zoomOut() {
  setZoom(zoom.value / 1.28);
}

function resetMapView() {
  userMovedMap.value = false;
  zoom.value = coverZoom.value;
  center.value = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  userMovedMap.value = true;
  if (event.shiftKey || event.altKey) {
    const view = currentView.value;
    const horizontalDelta = event.shiftKey ? event.deltaY + event.deltaX : event.deltaX;
    const verticalDelta = event.altKey ? event.deltaY : 0;
    panBy((horizontalDelta / viewportSize.value.width) * view.width, (verticalDelta / viewportSize.value.height) * view.height);
    return;
  }

  const anchor = eventToMapPoint(event);
  const direction = event.deltaY > 0 ? 0.88 : 1.14;
  setZoom(zoom.value * direction, anchor);
}

function onPointerDown(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault();
  userMovedMap.value = true;
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  pointerDownSnapshot =
    activePointers.size === 1
      ? {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        }
      : null;
  svgElement.value?.setPointerCapture(event.pointerId);

  if (activePointers.size >= 2) {
    pointerDownSnapshot = null;
    beginPinch();
    return;
  }

  beginDrag(event.pointerId, event.clientX, event.clientY);
}

function onPointerMove(event: PointerEvent) {
  if (activePointers.has(event.pointerId)) {
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }

  if (pinchState && activePointers.size >= 2) {
    updatePinch();
    return;
  }

  if (!dragState || dragState.pointerId !== event.pointerId) return;
  const dx = ((event.clientX - dragState.startClientX) / viewportSize.value.width) * dragState.viewWidth;
  const dy = ((event.clientY - dragState.startClientY) / viewportSize.value.height) * dragState.viewHeight;
  center.value = clampCenter(dragState.startCenterX - dx, dragState.startCenterY - dy, zoom.value);
}

function onPointerUp(event: PointerEvent) {
  const shouldFocus =
    event.type !== 'pointerleave' &&
    pointerDownSnapshot?.pointerId === event.pointerId &&
    pointerDistance(pointerDownSnapshot, { x: event.clientX, y: event.clientY }) < 7 &&
    activePointers.size <= 1;
  if (svgElement.value?.hasPointerCapture(event.pointerId)) {
    svgElement.value?.releasePointerCapture(event.pointerId);
  }
  activePointers.delete(event.pointerId);
  pinchState = null;

  if (activePointers.size === 1) {
    const [pointerId, pointer] = Array.from(activePointers.entries())[0];
    beginDrag(pointerId, pointer.x, pointer.y);
    pointerDownSnapshot = null;
    return;
  }

  if (shouldFocus) {
    focusNearestMapTarget(event.clientX, event.clientY);
  }
  pointerDownSnapshot = null;
  dragging.value = false;
  dragState = null;
}

function setZoom(nextZoom: number, anchor?: MapPoint) {
  const clampedZoom = clamp(nextZoom, 1, MAX_ZOOM);
  if (!anchor) {
    zoom.value = clampedZoom;
    center.value = clampCenter(center.value.x, center.value.y, clampedZoom);
    return;
  }

  const view = currentView.value;
  const ratioX = (anchor.x - view.x) / view.width;
  const ratioY = (anchor.y - view.y) / view.height;
  const nextWidth = MAP_WIDTH / clampedZoom;
  const nextHeight = nextWidth / viewportAspect.value;
  const nextX = anchor.x - ratioX * nextWidth;
  const nextY = anchor.y - ratioY * nextHeight;
  zoom.value = clampedZoom;
  center.value = clampCenter(nextX + nextWidth / 2, nextY + nextHeight / 2, clampedZoom);
}

function panBy(deltaX: number, deltaY: number) {
  center.value = clampCenter(center.value.x + deltaX, center.value.y + deltaY, zoom.value);
}

function beginDrag(pointerId: number, clientX: number, clientY: number) {
  dragging.value = true;
  const view = currentView.value;
  dragState = {
    pointerId,
    startClientX: clientX,
    startClientY: clientY,
    startCenterX: center.value.x,
    startCenterY: center.value.y,
    viewWidth: view.width,
    viewHeight: view.height,
  };
}

function beginPinch() {
  const [first, second] = Array.from(activePointers.values());
  if (!first || !second) return;
  dragging.value = false;
  dragState = null;
  pinchState = {
    lastDistance: pointerDistance(first, second),
    lastMidpoint: pointerMidpoint(first, second),
  };
}

function updatePinch() {
  const [first, second] = Array.from(activePointers.values());
  if (!first || !second || !pinchState) return;

  const nextDistance = pointerDistance(first, second);
  if (nextDistance < 8 || pinchState.lastDistance < 8) return;

  const nextMidpoint = pointerMidpoint(first, second);
  const anchor = clientToMapPoint(nextMidpoint.x, nextMidpoint.y);
  setZoom(zoom.value * (nextDistance / pinchState.lastDistance), anchor);

  const view = currentView.value;
  const deltaX = ((nextMidpoint.x - pinchState.lastMidpoint.x) / viewportSize.value.width) * view.width;
  const deltaY = ((nextMidpoint.y - pinchState.lastMidpoint.y) / viewportSize.value.height) * view.height;
  center.value = clampCenter(center.value.x - deltaX, center.value.y - deltaY, zoom.value);

  pinchState = {
    lastDistance: nextDistance,
    lastMidpoint: nextMidpoint,
  };
}

function eventToMapPoint(event: MouseEvent) {
  return clientToMapPoint(event.clientX, event.clientY);
}

function clientToMapPoint(clientX: number, clientY: number) {
  const bounds = svgElement.value?.getBoundingClientRect();
  const view = currentView.value;
  if (!bounds || !bounds.width || !bounds.height) return { x: center.value.x, y: center.value.y };
  const ratioX = clamp((clientX - bounds.left) / bounds.width, 0, 1);
  const ratioY = clamp((clientY - bounds.top) / bounds.height, 0, 1);
  return {
    x: view.x + ratioX * view.width,
    y: view.y + ratioY * view.height,
  };
}

function pointerDistance(first: PointerSnapshot, second: PointerSnapshot) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function pointerMidpoint(first: PointerSnapshot, second: PointerSnapshot) {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function clampCenter(x: number, y: number, targetZoom: number) {
  const width = MAP_WIDTH / targetZoom;
  const height = width / viewportAspect.value;
  return {
    x: clampAxis(x, width, MAP_WIDTH),
    y: clampAxis(y, height, MAP_HEIGHT),
  };
}

function clampAxis(value: number, viewSize: number, mapSize: number) {
  if (viewSize >= mapSize) return mapSize / 2;
  return clamp(value, viewSize / 2, mapSize - viewSize / 2);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function splitTrail(points: MapPoint[]) {
  const segments: MapPoint[][] = [];
  let current: MapPoint[] = [];
  for (const point of points) {
    const previous = current[current.length - 1];
    if (previous && Math.abs(previous.x - point.x) > MAP_WIDTH * 0.45) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

function formatLongitudeLabel(x: number) {
  const lon = (x / MAP_WIDTH) * 360 - 180;
  if (Math.abs(lon) < 1) return '0°';
  return `${Math.abs(Math.round(lon))}°${lon > 0 ? 'E' : 'W'}`;
}

function formatSmoothPath(points: MapPoint[]) {
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

function formatPoint(point: MapPoint) {
  return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
}

function formatCoordinate(value: number, axis: 'lat' | 'lon') {
  const direction = axis === 'lat' ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
  return `${Math.abs(value).toFixed(1)}°${direction}`;
}

function satelliteLabelBounds(point: MapPoint): MapBounds {
  return {
    x: Math.min(point.x + 18, MAP_WIDTH - 155),
    y: Math.max(point.y - 28, 38),
    width: 138,
    height: 38,
  };
}

function stationLabelBounds(station: { x: number; y: number; name: string; labelAnchor: string }): MapBounds {
  const width = clamp(station.name.length * 7.2 + 16, 76, 210);
  return {
    x: station.labelAnchor === 'start' ? station.x + 12 : station.x - 12 - width,
    y: station.y - 29,
    width,
    height: 22,
  };
}

function focusSatellite(item: { id: string }) {
  emit('focus-target', { type: 'satellite', id: item.id });
}

function focusGroundStation(station: { id: string }) {
  emit('focus-target', { type: 'groundStation', id: station.id });
}

function focusNearestMapTarget(clientX: number, clientY: number) {
  const point = clientToMapPoint(clientX, clientY);
  const hitRadius = Math.max((currentView.value.width / viewportSize.value.width) * 32, 14);
  const satelliteLabelHit = plotted.value.find((item) => boundsContains(item.labelBounds, point));
  if (satelliteLabelHit) {
    emit('focus-target', { type: 'satellite', id: satelliteLabelHit.id });
    return;
  }

  const stationLabelHit = stationPoints.value.find((station) => boundsContains(stationLabelBounds(station), point));
  if (stationLabelHit) {
    emit('focus-target', { type: 'groundStation', id: stationLabelHit.id });
    return;
  }

  const satelliteHit = nearestByDistance(
    plotted.value.map((item) => ({ target: { type: 'satellite', id: item.id } satisfies MapFocusTarget, point: item.point })),
    point,
  );
  if (satelliteHit && satelliteHit.distance <= hitRadius) {
    emit('focus-target', satelliteHit.target);
    return;
  }

  const stationHit = nearestByDistance(
    stationPoints.value.map((station) => ({ target: { type: 'groundStation', id: station.id } satisfies MapFocusTarget, point: station })),
    point,
  );
  if (stationHit && stationHit.distance <= hitRadius) {
    emit('focus-target', stationHit.target);
  }
}

function nearestByDistance(items: Array<{ target: MapFocusTarget; point: MapPoint }>, point: MapPoint) {
  let nearest: { target: MapFocusTarget; distance: number } | null = null;
  for (const item of items) {
    const distance = Math.hypot(item.point.x - point.x, item.point.y - point.y);
    if (!nearest || distance < nearest.distance) {
      nearest = { target: item.target, distance };
    }
  }
  return nearest;
}

function boundsContains(bounds: MapBounds, point: MapPoint) {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

function targetMatches(left: MapFocusTarget | null | undefined, right: MapFocusTarget) {
  return Boolean(left && left.type === right.type && left.id === right.id);
}

function linkLabel(link: LiveContactLink) {
  return `${link.elevationDeg.toFixed(0)}° / ${link.azimuthDeg.toFixed(0)}°`;
}

function formatTimestampWithSeconds(date: Date) {
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

interface MapPoint {
  x: number;
  y: number;
}

interface MapBounds extends MapPoint {
  width: number;
  height: number;
}

interface OsmTile {
  id: string;
  href: string;
  x: number;
  y: number;
  size: number;
}

interface DragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startCenterX: number;
  startCenterY: number;
  viewWidth: number;
  viewHeight: number;
}

interface PointerSnapshot {
  x: number;
  y: number;
}

interface PointerDownSnapshot extends PointerSnapshot {
  pointerId: number;
}

interface PinchState {
  lastDistance: number;
  lastMidpoint: PointerSnapshot;
}
</script>

<template>
  <div ref="mapShell" class="orbit-map orbit-map--2d" :class="{ 'orbit-map--dragging': dragging }" aria-label="2D orbit map">
    <div class="orbit-map__hud orbit-map__hud--top">
      <div>
        <p class="eyebrow">Ground Track</p>
        <strong>Selected Fleet Orbit Network</strong>
      </div>
      <div class="orbit-map__top-actions">
        <div class="orbit-map__nav" aria-label="Map navigation controls">
          <button type="button" @click="zoomOut()">−</button>
          <span>{{ zoomPercent }}</span>
          <button type="button" @click="zoomIn()">+</button>
          <button type="button" @click="resetMapView()">Reset</button>
        </div>
        <div class="orbit-map__clock">
          <span>{{ orbitStats.mode }}</span>
          <small>{{ displayedTimestamp }}</small>
          <small>{{ orbitStats.clockLabel }}</small>
        </div>
      </div>
    </div>

    <svg
      ref="svgElement"
      :viewBox="mapViewBox"
      preserveAspectRatio="none"
      role="img"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerUp"
    >
      <defs>
        <linearGradient id="orbitTerminator" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stop-color="rgba(2, 6, 23, 0.04)" />
          <stop offset="50%" stop-color="rgba(2, 6, 23, 0.66)" />
          <stop offset="100%" stop-color="rgba(2, 6, 23, 0.12)" />
        </linearGradient>
        <filter id="orbitGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <pattern id="orbitScanline" width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M 0 7 H 8" stroke="rgba(226, 232, 240, 0.035)" stroke-width="1" />
        </pattern>
        <marker id="trackArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L0,6 L7,3 z" fill="#ffffff" opacity="0.78" />
        </marker>
        <linearGradient id="stationBeam" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#ffffff" />
          <stop offset="100%" stop-color="#1eaedb" />
        </linearGradient>
      </defs>

      <rect :width="MAP_WIDTH" :height="MAP_HEIGHT" fill="#111111" />
      <g class="orbit-map__tiles">
        <image
          v-for="tile in osmTiles"
          :key="tile.id"
          class="orbit-map__tile"
          :href="tile.href"
          :x="tile.x"
          :y="tile.y"
          :width="tile.size + 0.25"
          :height="tile.size + 0.25"
          preserveAspectRatio="none"
        />
      </g>
      <rect :width="MAP_WIDTH" :height="MAP_HEIGHT" fill="rgba(0, 0, 0, 0.44)" />
      <rect :width="MAP_WIDTH" :height="MAP_HEIGHT" fill="url(#orbitScanline)" opacity="0.75" />

      <g class="orbit-map__grid">
        <g v-for="x in longitudeLines" :key="`lon-${x}`">
          <path :d="`M ${x} 0 V ${MAP_HEIGHT}`" />
          <text :x="x + 5" y="18">{{ formatLongitudeLabel(x) }}</text>
        </g>
        <path v-for="y in latitudeLines" :key="`lat-${y}`" :d="`M 0 ${y} H ${MAP_WIDTH}`" />
      </g>

      <path class="orbit-map__night-mask" :d="nightMaskPath" />

      <g class="orbit-map__contact-links">
        <g
          v-for="segment in activeContactSegments"
          :key="segment.id"
          class="orbit-map__contact-link"
          :class="{ 'orbit-map__contact-link--focused': segment.focused }"
        >
          <path
            :d="`M ${segment.station.x.toFixed(1)} ${segment.station.y.toFixed(1)} L ${segment.satellite.point.x.toFixed(1)} ${segment.satellite.point.y.toFixed(1)}`"
          />
          <text
            :x="(segment.station.x + segment.satellite.point.x) / 2"
            :y="(segment.station.y + segment.satellite.point.y) / 2 - 8"
          >
            {{ linkLabel(segment.link) }}
          </text>
        </g>
      </g>

      <g class="orbit-map__stations">
        <g
          v-for="station in stationPoints"
          :key="station.id"
          class="orbit-map__station"
          :class="{ 'orbit-map__station--focused': targetMatches(props.focusedTarget, { type: 'groundStation', id: station.id }) }"
          role="button"
          tabindex="0"
          @click.stop="focusGroundStation(station)"
          @keyup.enter.stop="focusGroundStation(station)"
        >
          <circle :cx="station.x" :cy="station.y" r="26" class="orbit-map__station-range" />
          <circle :cx="station.x" :cy="station.y" r="7" />
          <text
            :x="station.labelAnchor === 'start' ? station.x + 14 : station.x - 14"
            :y="station.y - 13"
            :text-anchor="station.labelAnchor"
          >
            {{ station.name }}
          </text>
        </g>
      </g>

      <g
        v-for="item in plotted"
        :key="item.entry.satcat.catalogNumber"
        class="orbit-map__track"
        :class="{ 'orbit-map__track--focused': targetMatches(props.focusedTarget, { type: 'satellite', id: item.id }) }"
        role="button"
        tabindex="0"
        @click.stop="focusSatellite(item)"
        @keyup.enter.stop="focusSatellite(item)"
      >
        <path
          v-for="(segment, segmentIndex) in item.trailSegments"
          :key="`${item.entry.satcat.catalogNumber}-${segmentIndex}`"
          :d="formatSmoothPath(segment)"
          class="orbit-map__trail"
          :stroke="item.color"
          marker-end="url(#trackArrow)"
        />
        <circle :cx="item.point.x" :cy="item.point.y" r="19" class="orbit-map__satellite-ping" :stroke="item.color" />
        <circle :cx="item.point.x" :cy="item.point.y" r="6.5" class="orbit-map__satellite-core" :fill="item.color" />
        <g class="orbit-map__satellite-label" :transform="`translate(${item.labelBounds.x} ${item.labelBounds.y})`">
          <rect width="138" height="38" rx="12" />
          <text x="12" y="16">{{ item.label }}</text>
          <text x="12" y="30">{{ formatCoordinate(item.geo.lat, 'lat') }} · {{ formatCoordinate(item.geo.lon, 'lon') }}</text>
        </g>
      </g>
    </svg>

    <div class="orbit-map__interaction-hint">Wheel/Pinch zoom · Drag pan · Shift+wheel pan</div>
    <a
      class="orbit-map__attribution"
      href="https://www.openstreetmap.org/copyright"
      rel="noreferrer"
      target="_blank"
    >
      © OpenStreetMap contributors
    </a>

    <div class="orbit-map__hud orbit-map__hud--bottom">
      <div>
        <span>Tracked</span>
        <strong>{{ orbitStats.tracked }}</strong>
      </div>
      <div>
        <span>Ground Stations</span>
        <strong>{{ orbitStats.stations }}</strong>
      </div>
      <div>
        <span>Avg Altitude</span>
        <strong>{{ orbitStats.avgAltitude }} km</strong>
      </div>
      <div>
        <span>Render</span>
        <strong>{{ props.dataSaver ? 'OSM Saver' : 'OSM 2D' }}</strong>
      </div>
    </div>
  </div>
</template>
