<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import * as satellite from 'satellite.js';
import type { CatalogEntry, GroundStation, LiveContactLink, MapFocusTarget } from '@/domain/types';
import { createNightMaskPath } from '@/lib/solarTerminator';

const props = defineProps<{
  satellites: CatalogEntry[];
  contactLinks?: LiveContactLink[];
  dataSaver?: boolean;
  focusedTarget?: MapFocusTarget | null;
  hoveredTarget?: MapFocusTarget | null;
  groundStations?: GroundStation[];
  livePlaybackRate?: number;
  orbitMode: 'live' | 'simulation';
  orbitTimeIso: string;
  riskSatelliteIds?: string[];
  riskSatelliteTones?: Record<string, 'warn' | 'critical'>;
}>();

const emit = defineEmits<{
  'focus-target': [target: MapFocusTarget];
}>();

const BASE_TILE_ZOOM = 2;
const MAX_TILE_ZOOM = 7;
const TOUCH_RENDERING_BUDGET_TILE_ZOOM = BASE_TILE_ZOOM + 1;
const TOUCH_DYNAMIC_CANVAS_DPR = 1.5;
const DEFAULT_DYNAMIC_CANVAS_DPR = 2;
const TILE_SIZE = 256;
const MAP_WIDTH = TILE_SIZE * 2 ** BASE_TILE_ZOOM;
const MAP_HEIGHT = MAP_WIDTH;
const MAX_ZOOM = 8;
const TRAIL_START_MINUTES = -45;
const TRAIL_END_MINUTES = 120;
const FOCUS_ANIMATION_MS = 560;
const CANVAS_DYNAMIC_LAYER_THRESHOLD = 20;
const TOUCH_CANVAS_DYNAMIC_LAYER_MIN_TRACKS = 6;
const TOUCH_CANVAS_DYNAMIC_LAYER_MIN_MAP_WIDTH = 480;
const TOUCH_CANVAS_DYNAMIC_LAYER_MIN_VIEWPORT_WIDTH = 768;
const NIGHT_MASK_CACHE_BUCKET_MS = 60_000;
const DEFAULT_TRAIL_CACHE_BUCKET_MS = 15_000;
const TOUCH_TRAIL_CACHE_BUCKET_MS = 30_000;
const SATELLITE_LABEL_WIDTH = 126;
const SATELLITE_LABEL_HEIGHT = 32;
const SATELLITE_LABEL_RADIUS = 8;
const SATELLITE_STATE_COLORS = {
  focused: '#ffffff',
  preview: '#d7f1ff',
  critical: '#c81b3a',
  warn: '#f5c84b',
  contact: '#1eaedb',
  tracked: '#53b1ff',
} as const;
const STATION_STATE_COLORS = {
  focused: '#ffffff',
  preview: '#d7f1ff',
  activeContact: '#1eaedb',
  idle: '#94a3b8',
} as const;
type SatelliteVisualTone = keyof typeof SATELLITE_STATE_COLORS;
type SatRec = ReturnType<typeof satellite.twoline2satrec>;

const mapShell = ref<HTMLDivElement | null>(null);
const svgElement = ref<SVGSVGElement | null>(null);
const dynamicCanvas = ref<HTMLCanvasElement | null>(null);
const viewportSize = ref({ width: MAP_WIDTH, height: MAP_HEIGHT });
const windowViewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : MAP_WIDTH);
const isCoarsePointerDevice = ref(false);
const zoom = ref(1);
const center = ref({ x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 });
const dragging = ref(false);
const userMovedMap = ref(false);
const satelliteFollowSuspended = ref(false);
let resizeObserver: ResizeObserver | null = null;
let coarsePointerMediaQuery: MediaQueryList | null = null;
let dragState: DragState | null = null;
let pinchState: PinchState | null = null;
let pointerDownSnapshot: PointerDownSnapshot | null = null;
let focusAnimationFrame = 0;
let canvasDrawFrame = 0;
let touchDragCenterFrame = 0;
let pendingTouchDragCenter: MapPoint | null = null;
const activePointers = new Map<number, PointerSnapshot>();
const satrecCache = new Map<string, CachedSatrec>();
const trailSegmentCache = new Map<string, CachedTrailSegments>();

onMounted(() => {
  coarsePointerMediaQuery = window.matchMedia?.('(pointer: coarse)') ?? null;
  updatePointerProfile();
  coarsePointerMediaQuery?.addEventListener?.('change', updatePointerProfile);
  window.addEventListener('resize', updateWindowViewportWidth);
  resizeObserver = new ResizeObserver(([entry]) => {
    if (!entry) return;
    viewportSize.value = {
      width: Math.max(entry.contentRect.width, 1),
      height: Math.max(entry.contentRect.height, 1),
    };
    queueDynamicCanvasDraw();
    if (!userMovedMap.value) {
      zoom.value = coverZoom.value;
      center.value = clampCenter(center.value.x, center.value.y, zoom.value);
      queueDynamicCanvasDraw();
    }
  });
  if (mapShell.value) {
    resizeObserver.observe(mapShell.value);
  }
  requestAnimationFrame(() => centerMapOnTarget(props.focusedTarget));
});

onUnmounted(() => {
  cancelFocusAnimation();
  cancelDynamicCanvasDraw();
  cancelTouchDragCenterUpdate();
  resizeObserver?.disconnect();
  coarsePointerMediaQuery?.removeEventListener?.('change', updatePointerProfile);
  window.removeEventListener('resize', updateWindowViewportWidth);
  satrecCache.clear();
  trailSegmentCache.clear();
});

const livePlaybackRate = computed(() => props.livePlaybackRate ?? 1);
const playbackRateLabel = computed(() => (livePlaybackRate.value === 0 ? 'paused' : `${livePlaybackRate.value}x`));
const displayedTime = computed(() => new Date(props.orbitTimeIso));
const displayedTimestamp = computed(() => formatTimestampWithSeconds(displayedTime.value));
const nightMaskTimestamp = computed(() => Math.floor(displayedTime.value.getTime() / NIGHT_MASK_CACHE_BUCKET_MS) * NIGHT_MASK_CACHE_BUCKET_MS);
const nightMaskPath = computed(() => createNightMaskPath(new Date(nightMaskTimestamp.value), MAP_WIDTH, MAP_HEIGHT));
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
const visibleWorlds = computed(() => {
  const view = currentView.value;
  const start = Math.floor(view.x / MAP_WIDTH) - 1;
  const end = Math.floor((view.x + view.width) / MAP_WIDTH) + 1;
  const worlds: WorldCopy[] = [];
  for (let index = start; index <= end; index += 1) {
    worlds.push({ id: index, offset: index * MAP_WIDTH });
  }
  return worlds.sort(
    (left, right) =>
      Math.abs(left.offset + MAP_WIDTH / 2 - center.value.x) - Math.abs(right.offset + MAP_WIDTH / 2 - center.value.x),
  );
});
const mapViewBox = computed(() => {
  const view = currentView.value;
  return `${view.x.toFixed(2)} ${view.y.toFixed(2)} ${view.width.toFixed(2)} ${view.height.toFixed(2)}`;
});
const zoomPercent = computed(() => `${zoom.value.toFixed(1)}x`);
const labelMapScale = computed(() => clamp(currentView.value.width / viewportSize.value.width, 0.18, 1));
const prefersTouchCanvasLayer = computed(
  () =>
    isCoarsePointerDevice.value &&
    (windowViewportWidth.value >= TOUCH_CANVAS_DYNAMIC_LAYER_MIN_VIEWPORT_WIDTH ||
      viewportSize.value.width >= TOUCH_CANVAS_DYNAMIC_LAYER_MIN_MAP_WIDTH) &&
    props.satellites.length >= TOUCH_CANVAS_DYNAMIC_LAYER_MIN_TRACKS,
);
const usesCanvasDynamicLayer = computed(
  () => props.satellites.length > CANVAS_DYNAMIC_LAYER_THRESHOLD || prefersTouchCanvasLayer.value,
);
const usesTouchRenderingBudget = computed(() => isCoarsePointerDevice.value);
const maxOsmTileZoom = computed(() => {
  if (props.dataSaver) return BASE_TILE_ZOOM;
  if (usesTouchRenderingBudget.value) return Math.min(MAX_TILE_ZOOM, TOUCH_RENDERING_BUDGET_TILE_ZOOM);
  return MAX_TILE_ZOOM;
});
const trailCacheBucketMs = computed(() => (prefersTouchCanvasLayer.value ? TOUCH_TRAIL_CACHE_BUCKET_MS : DEFAULT_TRAIL_CACHE_BUCKET_MS));
const trailBaseTimestamp = computed(() => Math.floor(displayedTime.value.getTime() / trailCacheBucketMs.value) * trailCacheBucketMs.value);
const riskSatelliteIdSet = computed(() => new Set(props.riskSatelliteIds ?? []));
const activeContactSatelliteIdSet = computed(
  () => new Set((props.contactLinks ?? []).filter((link) => link.status === 'IN_CONTACT').map((link) => link.satelliteId)),
);
const activeContactStationIdSet = computed(
  () => new Set((props.contactLinks ?? []).filter((link) => link.status === 'IN_CONTACT').map((link) => link.groundStationId)),
);
const stationPoints = computed(() =>
  (props.groundStations ?? []).filter((station) => station.enabled).map((station, index) => ({
    id: station.id,
    ...toMapPoint(station.lonDeg, station.latDeg),
    activeContact: activeContactStationIdSet.value.has(station.id),
    name: station.name,
    elevationMaskDeg: station.elevationMaskDeg,
    labelAnchor: index % 2 === 0 ? 'start' : 'end',
  })),
);
const trailStepMinutes = computed(() => {
  if (props.dataSaver) return 10;
  if (props.satellites.length > 80) return 12;
  if (usesCanvasDynamicLayer.value) return 6;
  return 2;
});
const renderEngineLabel = computed(() => {
  if (props.dataSaver) return 'OSM Saver';
  return usesCanvasDynamicLayer.value ? 'Canvas 2D' : 'OSM 2D';
});

const plotted = computed(() =>
  props.satellites
    .map((entry) => {
      if (!entry.tle) return null;
      const satrec = getSatrec(entry);
      const point = projectSatrec(satrec, displayedTime.value);
      if (!point) return null;
      const mapPoint = toMapPoint(point.lon, point.lat);
      const labelBounds = satelliteLabelBounds(mapPoint, labelMapScale.value);
      const id = `catalog:${entry.satcat.catalogNumber}`;
      const tone = satelliteVisualTone(id);
      return {
        id,
        entry,
        color: SATELLITE_STATE_COLORS[tone],
        label: entry.satcat.objectName.replace(/\s*\(.+?\)\s*/g, '').slice(0, 18),
        point: mapPoint,
        labelBounds,
        geo: point,
        tone,
        trailSegments: getTrailSegments(entry, satrec),
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
        previewed:
          targetMatches(props.hoveredTarget, { type: 'satellite', id: link.satelliteId }) ||
          targetMatches(props.hoveredTarget, { type: 'groundStation', id: link.groundStationId }),
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
    clockLabel: props.orbitMode === 'simulation' ? `SGP4 simulation · ${playbackRateLabel.value}` : `SGP4 live · ${playbackRateLabel.value}`,
  };
});

const longitudeLines = computed(() => Array.from({ length: 11 }, (_, index) => (index * MAP_WIDTH) / 10));
const latitudeLines = computed(() => [-60, -30, 0, 30, 60].map((lat) => toMapPoint(0, lat).y));
const osmTiles = computed(() => {
  const tileZoom = clamp(BASE_TILE_ZOOM + Math.floor(Math.log2(Math.max(zoom.value, 1))), BASE_TILE_ZOOM, maxOsmTileZoom.value);
  const zoomScale = 2 ** (tileZoom - BASE_TILE_ZOOM);
  const tileSize = TILE_SIZE / zoomScale;
  const tilesPerAxis = 2 ** tileZoom;
  const maxTileIndex = 2 ** tileZoom - 1;
  const view = currentView.value;
  const startX = Math.floor(view.x / tileSize) - 1;
  const endX = Math.ceil((view.x + view.width) / tileSize) + 1;
  const startY = Math.max(0, Math.floor(view.y / tileSize) - 1);
  const endY = Math.min(maxTileIndex, Math.ceil((view.y + view.height) / tileSize) + 1);
  const tiles: OsmTile[] = [];

  for (let x = startX; x <= endX; x += 1) {
    for (let y = startY; y <= endY; y += 1) {
      const wrappedX = positiveModulo(x, tilesPerAxis);
      tiles.push({
        id: `${tileZoom}-${x}-${y}`,
        href: `https://tile.openstreetmap.org/${tileZoom}/${wrappedX}/${y}.png`,
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

function getSatrec(entry: CatalogEntry) {
  const cacheKey = satelliteCacheKey(entry);
  const cached = satrecCache.get(cacheKey);
  if (cached && cached.line1 === entry.tle?.line1 && cached.line2 === entry.tle?.line2) {
    return cached.satrec;
  }
  const satrec = satellite.twoline2satrec(entry.tle!.line1, entry.tle!.line2);
  satrecCache.set(cacheKey, {
    line1: entry.tle!.line1,
    line2: entry.tle!.line2,
    satrec,
  });
  return satrec;
}

function getTrailSegments(entry: CatalogEntry, satrec: SatRec) {
  if (props.dataSaver || !entry.tle) return [];
  const cacheKey = satelliteCacheKey(entry);
  const cached = trailSegmentCache.get(cacheKey);
  const stepMinutes = trailStepMinutes.value;
  const baseTimestamp = trailBaseTimestamp.value;
  if (
    cached &&
    cached.line1 === entry.tle.line1 &&
    cached.line2 === entry.tle.line2 &&
    cached.stepMinutes === stepMinutes &&
    cached.baseTimestamp === baseTimestamp
  ) {
    return cached.segments;
  }
  const segments = splitTrail(buildTrail(satrec, new Date(baseTimestamp), stepMinutes));
  trailSegmentCache.set(cacheKey, {
    line1: entry.tle.line1,
    line2: entry.tle.line2,
    stepMinutes,
    baseTimestamp,
    segments,
  });
  return segments;
}

function buildTrail(satrec: SatRec, base: Date, stepMinutes = trailStepMinutes.value) {
  const points: MapPoint[] = [];
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

function updatePointerProfile() {
  isCoarsePointerDevice.value = Boolean(coarsePointerMediaQuery?.matches || navigator.maxTouchPoints > 0);
}

function updateWindowViewportWidth() {
  windowViewportWidth.value = window.innerWidth;
}

function satelliteCacheKey(entry: CatalogEntry) {
  return `catalog:${entry.satcat.catalogNumber}`;
}

function pruneOrbitCaches() {
  const activeKeys = new Set(props.satellites.map(satelliteCacheKey));
  for (const key of satrecCache.keys()) {
    if (!activeKeys.has(key)) satrecCache.delete(key);
  }
  for (const key of trailSegmentCache.keys()) {
    if (!activeKeys.has(key)) trailSegmentCache.delete(key);
  }
}

function zoomIn() {
  cancelFocusAnimation();
  suspendFocusedSatelliteFollow();
  setZoom(zoom.value * 1.28);
}

function zoomOut() {
  cancelFocusAnimation();
  suspendFocusedSatelliteFollow();
  setZoom(zoom.value / 1.28);
}

function resetMapView() {
  cancelFocusAnimation();
  cancelTouchDragCenterUpdate();
  suspendFocusedSatelliteFollow();
  userMovedMap.value = false;
  zoom.value = coverZoom.value;
  center.value = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
  queueDynamicCanvasDraw();
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  cancelFocusAnimation();
  suspendFocusedSatelliteFollow();
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
  cancelFocusAnimation();
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
    suspendFocusedSatelliteFollow();
    updatePinch();
    return;
  }

  if (!dragState || dragState.pointerId !== event.pointerId) return;
  suspendFocusedSatelliteFollow();
  const dx = ((event.clientX - dragState.startClientX) / viewportSize.value.width) * dragState.viewWidth;
  const dy = ((event.clientY - dragState.startClientY) / viewportSize.value.height) * dragState.viewHeight;
  applyTouchBudgetedCenter(clampCenter(dragState.startCenterX - dx, dragState.startCenterY - dy, zoom.value));
}

function onPointerUp(event: PointerEvent) {
  flushTouchDragCenterUpdate();
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
  cancelTouchDragCenterUpdate();
  const clampedZoom = clamp(nextZoom, 1, MAX_ZOOM);
  if (!anchor) {
    zoom.value = clampedZoom;
    center.value = clampCenter(center.value.x, center.value.y, clampedZoom);
    queueDynamicCanvasDraw();
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
  queueDynamicCanvasDraw();
}

function panBy(deltaX: number, deltaY: number) {
  cancelTouchDragCenterUpdate();
  center.value = clampCenter(center.value.x + deltaX, center.value.y + deltaY, zoom.value);
  queueDynamicCanvasDraw();
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
  suspendFocusedSatelliteFollow();
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
  cancelTouchDragCenterUpdate();
  center.value = clampCenter(center.value.x - deltaX, center.value.y - deltaY, zoom.value);
  queueDynamicCanvasDraw();

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
  const height = MAP_WIDTH / targetZoom / viewportAspect.value;
  return {
    x,
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
  const lon = (wrapMapX(x) / MAP_WIDTH) * 360 - 180;
  if (Math.abs(lon) < 1) return '0°';
  return `${Math.abs(Math.round(lon))}°${lon > 0 ? 'E' : 'W'}`;
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function wrapMapX(x: number) {
  return positiveModulo(x, MAP_WIDTH);
}

function nearestWrappedX(baseX: number, anchorX: number) {
  return baseX + Math.round((anchorX - baseX) / MAP_WIDTH) * MAP_WIDTH;
}

function withWorldOffset<T extends MapPoint>(point: T, worldOffset: number): T {
  return { ...point, x: point.x + worldOffset };
}

function formatTrackPath(points: MapPoint[]) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${formatPoint(points[0])}`;
  const commands = [`M ${formatPoint(points[0])}`];
  for (const point of points.slice(1)) {
    commands.push(`L ${formatPoint(point)}`);
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

function satelliteLabelBounds(point: MapPoint, scale = labelMapScale.value): MapBounds {
  const worldLeft = Math.floor(point.x / MAP_WIDTH) * MAP_WIDTH;
  const width = SATELLITE_LABEL_WIDTH * scale;
  const height = SATELLITE_LABEL_HEIGHT * scale;
  const offsetX = 18 * scale;
  const offsetY = 28 * scale;
  return {
    x: Math.min(point.x + offsetX, worldLeft + MAP_WIDTH - width - 18 * scale),
    y: Math.max(point.y - offsetY, 38 * scale),
    width,
    height,
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
  const satelliteLabelHit = plotted.value.find((item) => {
    const shiftedPoint = { ...item.point, x: nearestWrappedX(item.point.x, point.x) };
    return boundsContains(satelliteLabelBounds(shiftedPoint, labelMapScale.value), point);
  });
  if (satelliteLabelHit) {
    emit('focus-target', { type: 'satellite', id: satelliteLabelHit.id });
    return;
  }

  const stationLabelHit = stationPoints.value.find((station) => {
    const shiftedStation = { ...station, x: nearestWrappedX(station.x, point.x) };
    return boundsContains(stationLabelBounds(shiftedStation), point);
  });
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
    const distance = Math.hypot(nearestWrappedX(item.point.x, point.x) - point.x, item.point.y - point.y);
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

function satelliteVisualTone(id: string): SatelliteVisualTone {
  if (targetMatches(props.focusedTarget, { type: 'satellite', id })) return 'focused';
  if (targetMatches(props.hoveredTarget, { type: 'satellite', id })) return 'preview';
  const riskTone = props.riskSatelliteTones?.[id] ?? (riskSatelliteIdSet.value.has(id) ? 'critical' : undefined);
  if (riskTone === 'critical') return 'critical';
  if (riskTone === 'warn') return 'warn';
  if (activeContactSatelliteIdSet.value.has(id)) return 'contact';
  return 'tracked';
}

function linkLabel(link: LiveContactLink) {
  return `${link.elevationDeg.toFixed(0)}° / ${link.azimuthDeg.toFixed(0)}°`;
}

function contactEndpoints(segment: ContactSegmentLike, worldOffset: number) {
  const station = withWorldOffset(segment.station, worldOffset);
  return {
    station,
    satellite: {
      ...segment.satellite.point,
      x: nearestWrappedX(segment.satellite.point.x, station.x),
    },
  };
}

function contactPath(segment: ContactSegmentLike, worldOffset: number) {
  const endpoints = contactEndpoints(segment, worldOffset);
  return `M ${endpoints.station.x.toFixed(1)} ${endpoints.station.y.toFixed(1)} L ${endpoints.satellite.x.toFixed(1)} ${endpoints.satellite.y.toFixed(1)}`;
}

function contactLabelPoint(segment: ContactSegmentLike, worldOffset: number) {
  const endpoints = contactEndpoints(segment, worldOffset);
  return {
    x: (endpoints.station.x + endpoints.satellite.x) / 2,
    y: (endpoints.station.y + endpoints.satellite.y) / 2 - 8,
  };
}

function centerMapOnTarget(
  target: MapFocusTarget | null | undefined,
  options: { animate?: boolean; enforceFocusZoom?: boolean; markUserMoved?: boolean } = {},
) {
  if (!target) return;
  const point = target.type === 'satellite' ? findSatellitePoint(target.id) : findGroundStationPoint(target.id);
  if (!point) return;

  const targetZoom =
    options.enforceFocusZoom === false ? zoom.value : Math.max(zoom.value, Math.min(MAX_ZOOM, Math.max(coverZoom.value, 1.85)));
  const targetX = nearestWrappedX(point.x, center.value.x);
  const targetCenter = clampCenter(targetX, point.y, targetZoom);
  if (options.animate === false) {
    cancelFocusAnimation();
    zoom.value = targetZoom;
    center.value = targetCenter;
    queueDynamicCanvasDraw();
  } else {
    animateMapFocus(targetCenter, targetZoom);
  }
  userMovedMap.value = options.markUserMoved ?? true;
}

function followFocusedSatellite() {
  if (props.focusedTarget?.type !== 'satellite') return;
  if (satelliteFollowSuspended.value) return;
  if (dragging.value || pinchState) return;
  centerMapOnTarget(props.focusedTarget, {
    animate: false,
    enforceFocusZoom: false,
    markUserMoved: userMovedMap.value,
  });
}

function suspendFocusedSatelliteFollow() {
  if (props.focusedTarget?.type === 'satellite') {
    satelliteFollowSuspended.value = true;
  }
}

function queueDynamicCanvasDraw() {
  if (!usesCanvasDynamicLayer.value) return;
  if (canvasDrawFrame) return;
  canvasDrawFrame = requestAnimationFrame(() => {
    canvasDrawFrame = 0;
    drawDynamicCanvasLayer();
  });
}

function cancelDynamicCanvasDraw() {
  if (!canvasDrawFrame) return;
  cancelAnimationFrame(canvasDrawFrame);
  canvasDrawFrame = 0;
}

function applyTouchBudgetedCenter(nextCenter: MapPoint) {
  if (!usesTouchRenderingBudget.value) {
    center.value = nextCenter;
    queueDynamicCanvasDraw();
    return;
  }

  pendingTouchDragCenter = nextCenter;
  if (touchDragCenterFrame) return;
  touchDragCenterFrame = requestAnimationFrame(() => {
    touchDragCenterFrame = 0;
    flushTouchDragCenterUpdate();
  });
}

function flushTouchDragCenterUpdate() {
  if (touchDragCenterFrame) {
    cancelAnimationFrame(touchDragCenterFrame);
    touchDragCenterFrame = 0;
  }
  if (!pendingTouchDragCenter) return;
  center.value = pendingTouchDragCenter;
  pendingTouchDragCenter = null;
  queueDynamicCanvasDraw();
}

function cancelTouchDragCenterUpdate() {
  if (touchDragCenterFrame) {
    cancelAnimationFrame(touchDragCenterFrame);
    touchDragCenterFrame = 0;
  }
  pendingTouchDragCenter = null;
}

function drawDynamicCanvasLayer() {
  const canvas = dynamicCanvas.value;
  if (!usesCanvasDynamicLayer.value || !canvas) return;
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(Math.round(bounds.width || viewportSize.value.width), 1);
  const height = Math.max(Math.round(bounds.height || viewportSize.value.height), 1);
  const dprLimit = props.dataSaver ? 1.25 : usesTouchRenderingBudget.value ? TOUCH_DYNAMIC_CANVAS_DPR : DEFAULT_DYNAMIC_CANVAS_DPR;
  const dpr = Math.min(window.devicePixelRatio || 1, dprLimit);
  const pixelWidth = Math.max(Math.round(width * dpr), 1);
  const pixelHeight = Math.max(Math.round(height * dpr), 1);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext('2d');
  if (!context) return;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  const metrics = { view: currentView.value, width, height };

  drawCanvasTrails(context, metrics);
  drawCanvasContacts(context, metrics);
  drawCanvasStations(context, metrics);
  drawCanvasSatellites(context, metrics);
}

function drawCanvasTrails(context: CanvasRenderingContext2D, metrics: CanvasMetrics) {
  context.save();
  context.lineWidth = plotted.value.length > 80 ? 1.4 : 2.1;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.setLineDash(plotted.value.length > 48 ? [1, 11] : [1, 9]);
  context.globalAlpha = plotted.value.length > 80 ? 0.42 : 0.62;
  for (const world of visibleWorlds.value) {
    for (const item of plotted.value) {
      context.strokeStyle = item.color;
      for (const segment of item.trailSegments) {
        strokeCanvasTrackPath(context, segment, world.offset, metrics);
      }
    }
  }
  context.restore();
}

function drawCanvasContacts(context: CanvasRenderingContext2D, metrics: CanvasMetrics) {
  context.save();
  context.lineCap = 'round';
  context.font = '700 10px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const world of visibleWorlds.value) {
    for (const segment of activeContactSegments.value) {
      const endpoints = contactEndpoints(segment, world.offset);
      if (!lineIntersectsView(endpoints.station, endpoints.satellite, metrics)) continue;
      const start = mapToCanvasPoint(endpoints.station, metrics);
      const end = mapToCanvasPoint(endpoints.satellite, metrics);
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.strokeStyle = segment.focused ? '#ffffff' : 'rgba(30, 174, 219, 0.76)';
      if (segment.previewed && !segment.focused) {
        context.strokeStyle = 'rgba(215, 241, 255, 0.9)';
      }
      context.lineWidth = segment.focused ? 3.2 : segment.previewed ? 3 : 2;
      context.setLineDash(segment.focused ? [] : segment.previewed ? [2, 6] : [8, 8]);
      context.shadowColor = segment.previewed && !segment.focused ? 'rgba(215, 241, 255, 0.5)' : 'rgba(30, 174, 219, 0.44)';
      context.shadowBlur = segment.focused || segment.previewed ? 10 : 8;
      context.stroke();

      const labelPoint = contactLabelPoint(segment, world.offset);
      const label = mapToCanvasPoint(labelPoint, metrics);
      context.shadowBlur = 0;
      context.fillStyle = 'rgba(0, 0, 0, 0.72)';
      context.fillRect(label.x - 30, label.y - 10, 60, 18);
      context.fillStyle = '#ffffff';
      context.fillText(linkLabel(segment.link), label.x, label.y);
    }
  }
  context.restore();
}

function drawCanvasStations(context: CanvasRenderingContext2D, metrics: CanvasMetrics) {
  context.save();
  context.font = '700 11px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  context.textBaseline = 'middle';
  for (const world of visibleWorlds.value) {
    for (const station of stationPoints.value) {
      const point = { ...station, x: station.x + world.offset };
      if (!pointInExpandedView(point, metrics, 36)) continue;
      const screen = mapToCanvasPoint(point, metrics);
      const focused = targetMatches(props.focusedTarget, { type: 'groundStation', id: station.id });
      const previewed = !focused && targetMatches(props.hoveredTarget, { type: 'groundStation', id: station.id });
      const color = focused
        ? STATION_STATE_COLORS.focused
        : previewed
          ? STATION_STATE_COLORS.preview
          : station.activeContact
            ? STATION_STATE_COLORS.activeContact
            : STATION_STATE_COLORS.idle;
      context.beginPath();
      context.arc(screen.x, screen.y, 24, 0, Math.PI * 2);
      context.strokeStyle = focused
        ? 'rgba(255, 255, 255, 0.7)'
        : previewed
          ? 'rgba(215, 241, 255, 0.7)'
          : station.activeContact
            ? 'rgba(30, 174, 219, 0.34)'
            : 'rgba(148, 163, 184, 0.34)';
      context.lineWidth = focused ? 2.2 : previewed ? 2.1 : 1.4;
      context.setLineDash(previewed ? [2, 5] : []);
      context.stroke();
      context.setLineDash([]);
      context.beginPath();
      context.arc(screen.x, screen.y, focused ? 8 : previewed ? 7.4 : 6, 0, Math.PI * 2);
      context.fillStyle = color;
      context.shadowColor = previewed
        ? 'rgba(215, 241, 255, 0.7)'
        : station.activeContact
          ? 'rgba(30, 174, 219, 0.7)'
          : 'rgba(148, 163, 184, 0.46)';
      context.shadowBlur = focused || previewed ? 12 : 9;
      context.fill();
      context.shadowBlur = 0;
      context.textAlign = station.labelAnchor === 'start' ? 'left' : 'right';
      context.fillStyle = 'rgba(255, 255, 255, 0.88)';
      context.strokeStyle = 'rgba(0, 0, 0, 0.84)';
      context.lineWidth = 3;
      const labelX = screen.x + (station.labelAnchor === 'start' ? 14 : -14);
      const labelY = screen.y - 13;
      context.strokeText(station.name, labelX, labelY);
      context.fillText(station.name, labelX, labelY);
    }
  }
  context.restore();
}

function drawCanvasSatellites(context: CanvasRenderingContext2D, metrics: CanvasMetrics) {
  const shouldLabelAll = plotted.value.length <= 44;
  context.save();
  for (const world of visibleWorlds.value) {
    plotted.value.forEach((item, index) => {
      const point = { ...item.point, x: item.point.x + world.offset };
      if (!pointInExpandedView(point, metrics, 42)) return;
      const focused = targetMatches(props.focusedTarget, { type: 'satellite', id: item.id });
      const previewed = !focused && targetMatches(props.hoveredTarget, { type: 'satellite', id: item.id });
      const screen = mapToCanvasPoint(point, metrics);
      context.beginPath();
      context.arc(screen.x, screen.y, focused ? 21 : previewed ? 20 : 16, 0, Math.PI * 2);
      context.strokeStyle = item.color;
      context.lineWidth = focused ? 3.2 : previewed ? 3 : 1.7;
      context.globalAlpha = focused ? 0.72 : previewed ? 0.68 : 0.38;
      context.setLineDash(previewed ? [2, 5] : []);
      context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;
      context.beginPath();
      context.arc(screen.x, screen.y, focused ? 7.8 : previewed ? 7.2 : 5.8, 0, Math.PI * 2);
      context.fillStyle = item.color;
      context.shadowColor = item.color;
      context.shadowBlur = focused || previewed ? 13 : 8;
      context.fill();
      context.shadowBlur = 0;

      if (focused || previewed || shouldLabelAll || index < 12) {
        drawCanvasSatelliteLabel(context, item, world.offset, metrics, focused, previewed);
      }
    });
  }
  context.restore();
}

function drawCanvasSatelliteLabel(
  context: CanvasRenderingContext2D,
  item: (typeof plotted.value)[number],
  worldOffset: number,
  metrics: CanvasMetrics,
  focused: boolean,
  previewed = false,
) {
  const bounds = {
    ...item.labelBounds,
    x: item.labelBounds.x + worldOffset,
  };
  if (!rectIntersectsView(bounds, metrics)) return;
  const topLeft = mapToCanvasPoint(bounds, metrics);
  const width = (bounds.width / metrics.view.width) * metrics.width;
  const height = (bounds.height / metrics.view.height) * metrics.height;
  context.save();
  context.fillStyle = focused ? 'rgba(0, 0, 0, 0.84)' : previewed ? 'rgba(0, 18, 32, 0.82)' : 'rgba(0, 0, 0, 0.68)';
  context.strokeStyle = focused ? '#ffffff' : previewed ? '#d7f1ff' : 'rgba(255, 255, 255, 0.18)';
  context.lineWidth = focused || previewed ? 2 : 1;
  drawRoundedRect(context, topLeft.x, topLeft.y, width, height, Math.min(12, height / 2));
  context.fill();
  context.stroke();
  context.font = '700 10.5px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillStyle = '#f8fafc';
  context.fillText(item.label, topLeft.x + 10, topLeft.y + 13);
  context.font = '500 8.5px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  context.fillStyle = 'rgba(203, 213, 225, 0.86)';
  context.fillText(`${formatCoordinate(item.geo.lat, 'lat')} · ${formatCoordinate(item.geo.lon, 'lon')}`, topLeft.x + 10, topLeft.y + 24);
  context.restore();
}

function strokeCanvasTrackPath(context: CanvasRenderingContext2D, points: MapPoint[], worldOffset: number, metrics: CanvasMetrics) {
  const shifted = points.map((point) => ({ x: point.x + worldOffset, y: point.y }));
  if (!polylineIntersectsView(shifted, metrics)) return;
  if (!shifted.length) return;
  const first = mapToCanvasPoint(shifted[0], metrics);
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (const point of shifted.slice(1)) {
    const next = mapToCanvasPoint(point, metrics);
    context.lineTo(next.x, next.y);
  }
  context.stroke();
}

function drawRoundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
}

function mapToCanvasPoint(point: MapPoint, metrics: CanvasMetrics) {
  return {
    x: ((point.x - metrics.view.x) / metrics.view.width) * metrics.width,
    y: ((point.y - metrics.view.y) / metrics.view.height) * metrics.height,
  };
}

function pointInExpandedView(point: MapPoint, metrics: CanvasMetrics, paddingPx: number) {
  const paddingX = (paddingPx / metrics.width) * metrics.view.width;
  const paddingY = (paddingPx / metrics.height) * metrics.view.height;
  return (
    point.x >= metrics.view.x - paddingX &&
    point.x <= metrics.view.x + metrics.view.width + paddingX &&
    point.y >= metrics.view.y - paddingY &&
    point.y <= metrics.view.y + metrics.view.height + paddingY
  );
}

function rectIntersectsView(rect: MapBounds, metrics: CanvasMetrics) {
  return (
    rect.x + rect.width >= metrics.view.x &&
    rect.x <= metrics.view.x + metrics.view.width &&
    rect.y + rect.height >= metrics.view.y &&
    rect.y <= metrics.view.y + metrics.view.height
  );
}

function polylineIntersectsView(points: MapPoint[], metrics: CanvasMetrics) {
  return points.some((point) => pointInExpandedView(point, metrics, 24));
}

function lineIntersectsView(start: MapPoint, end: MapPoint, metrics: CanvasMetrics) {
  return pointInExpandedView(start, metrics, 24) || pointInExpandedView(end, metrics, 24);
}

function animateMapFocus(targetCenter: MapPoint, targetZoom: number) {
  cancelFocusAnimation();
  if (prefersReducedMotion()) {
    zoom.value = targetZoom;
    center.value = targetCenter;
    queueDynamicCanvasDraw();
    return;
  }

  const startTime = performance.now();
  const startCenter = { ...center.value };
  const startZoom = zoom.value;

  const step = (timestamp: number) => {
    const progress = clamp((timestamp - startTime) / FOCUS_ANIMATION_MS, 0, 1);
    const eased = easeOutCubic(progress);
    zoom.value = lerp(startZoom, targetZoom, eased);
    center.value = clampCenter(lerp(startCenter.x, targetCenter.x, eased), lerp(startCenter.y, targetCenter.y, eased), zoom.value);
    queueDynamicCanvasDraw();

    if (progress < 1) {
      focusAnimationFrame = requestAnimationFrame(step);
      return;
    }
    focusAnimationFrame = 0;
    zoom.value = targetZoom;
    center.value = targetCenter;
    queueDynamicCanvasDraw();
  };

  focusAnimationFrame = requestAnimationFrame(step);
}

function cancelFocusAnimation() {
  if (!focusAnimationFrame) return;
  cancelAnimationFrame(focusAnimationFrame);
  focusAnimationFrame = 0;
}

function easeOutCubic(value: number) {
  return 1 - (1 - value) ** 3;
}

function lerp(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function findSatellitePoint(id: string) {
  return plotted.value.find((item) => item.id === id)?.point ?? null;
}

function findGroundStationPoint(id: string) {
  const visibleStation = stationPoints.value.find((station) => station.id === id);
  if (visibleStation) return visibleStation;
  const station = (props.groundStations ?? []).find((item) => item.id === id);
  return station ? toMapPoint(station.lonDeg, station.latDeg) : null;
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

interface CanvasMetrics {
  view: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
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

interface WorldCopy {
  id: number;
  offset: number;
}

interface ContactSegmentLike {
  station: MapPoint;
  satellite: {
    point: MapPoint;
  };
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

interface CachedSatrec {
  line1: string;
  line2: string;
  satrec: SatRec;
}

interface CachedTrailSegments {
  line1: string;
  line2: string;
  stepMinutes: number;
  baseTimestamp: number;
  segments: MapPoint[][];
}

watch(
  () => props.satellites.map((entry) => satelliteCacheKey(entry)).join('|'),
  pruneOrbitCaches,
);

watch(
  () => [
    plotted.value,
    stationPoints.value,
    activeContactSegments.value,
    currentView.value,
    visibleWorlds.value,
    props.focusedTarget,
    props.hoveredTarget,
    usesCanvasDynamicLayer.value,
  ],
  () => queueDynamicCanvasDraw(),
  { flush: 'post' },
);

watch(
  () => props.focusedTarget,
  (target) => {
    satelliteFollowSuspended.value = false;
    centerMapOnTarget(target);
  },
  { deep: true },
);

watch(
  () => props.orbitTimeIso,
  () => followFocusedSatellite(),
  { flush: 'post' },
);
</script>

<template>
  <div
    ref="mapShell"
    class="orbit-map orbit-map--2d"
    :class="{ 'orbit-map--dragging': dragging, 'orbit-map--touch-budget': usesTouchRenderingBudget }"
    aria-label="2D orbit map"
  >
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

      <g class="orbit-map__world-backgrounds">
        <rect
          v-for="world in visibleWorlds"
          :key="`world-bg-${world.id}`"
          :x="world.offset"
          y="0"
          :width="MAP_WIDTH"
          :height="MAP_HEIGHT"
          fill="#111111"
        />
      </g>
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

      <g
        v-for="world in visibleWorlds"
        :key="`world-overlay-${world.id}`"
        class="orbit-map__world-copy"
        :transform="`translate(${world.offset} 0)`"
      >
        <rect :width="MAP_WIDTH" :height="MAP_HEIGHT" fill="rgba(0, 0, 0, 0.44)" />
        <rect :width="MAP_WIDTH" :height="MAP_HEIGHT" fill="url(#orbitScanline)" opacity="0.75" />

        <g class="orbit-map__grid">
          <g v-for="x in longitudeLines" :key="`lon-${world.id}-${x}`">
            <path :d="`M ${x} 0 V ${MAP_HEIGHT}`" />
            <text :x="x + 5" y="18">{{ formatLongitudeLabel(x) }}</text>
          </g>
          <path v-for="y in latitudeLines" :key="`lat-${world.id}-${y}`" :d="`M 0 ${y} H ${MAP_WIDTH}`" />
        </g>

        <path class="orbit-map__night-mask" :d="nightMaskPath" />
      </g>

      <g v-if="!usesCanvasDynamicLayer" class="orbit-map__contact-links">
        <g
          v-for="world in visibleWorlds"
          :key="`contact-world-${world.id}`"
        >
          <g
            v-for="segment in activeContactSegments"
            :key="`${world.id}-${segment.id}`"
            class="orbit-map__contact-link"
            :class="{ 'orbit-map__contact-link--focused': segment.focused, 'orbit-map__contact-link--preview': segment.previewed && !segment.focused }"
          >
            <path :d="contactPath(segment, world.offset)" />
            <text
              :x="contactLabelPoint(segment, world.offset).x"
              :y="contactLabelPoint(segment, world.offset).y"
            >
              {{ linkLabel(segment.link) }}
            </text>
          </g>
        </g>
      </g>

      <g v-if="!usesCanvasDynamicLayer" class="orbit-map__stations">
        <g
          v-for="world in visibleWorlds"
          :key="`station-world-${world.id}`"
          :transform="`translate(${world.offset} 0)`"
        >
          <g
            v-for="station in stationPoints"
            :key="`${world.id}-${station.id}`"
            class="orbit-map__station"
            :class="{
              'orbit-map__station--focused': targetMatches(props.focusedTarget, { type: 'groundStation', id: station.id }),
              'orbit-map__station--preview': !targetMatches(props.focusedTarget, { type: 'groundStation', id: station.id }) && targetMatches(props.hoveredTarget, { type: 'groundStation', id: station.id }),
              'orbit-map__station--active-contact': station.activeContact,
            }"
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
      </g>

      <g
        v-if="!usesCanvasDynamicLayer"
        v-for="world in visibleWorlds"
        :key="`track-world-${world.id}`"
        :transform="`translate(${world.offset} 0)`"
      >
        <g
          v-for="item in plotted"
          :key="`${world.id}-${item.entry.satcat.catalogNumber}`"
          class="orbit-map__track"
          :class="{
            'orbit-map__track--focused': item.tone === 'focused',
            'orbit-map__track--preview': item.tone === 'preview',
            'orbit-map__track--critical': item.tone === 'critical',
            'orbit-map__track--warn': item.tone === 'warn',
            'orbit-map__track--contact': item.tone === 'contact',
          }"
          role="button"
          tabindex="0"
          @click.stop="focusSatellite(item)"
          @keyup.enter.stop="focusSatellite(item)"
        >
          <path
            v-for="(segment, segmentIndex) in item.trailSegments"
            :key="`${item.entry.satcat.catalogNumber}-${segmentIndex}`"
            :d="formatTrackPath(segment)"
            class="orbit-map__trail"
            :stroke="item.color"
            marker-end="url(#trackArrow)"
          />
          <circle :cx="item.point.x" :cy="item.point.y" r="19" class="orbit-map__satellite-ping" :stroke="item.color" />
          <circle :cx="item.point.x" :cy="item.point.y" r="6.5" class="orbit-map__satellite-core" :fill="item.color" />
          <g class="orbit-map__satellite-label" :transform="`translate(${item.labelBounds.x} ${item.labelBounds.y}) scale(${labelMapScale})`">
            <rect :width="SATELLITE_LABEL_WIDTH" :height="SATELLITE_LABEL_HEIGHT" :rx="SATELLITE_LABEL_RADIUS" />
            <text x="10" y="13">{{ item.label }}</text>
            <text x="10" y="24">{{ formatCoordinate(item.geo.lat, 'lat') }} · {{ formatCoordinate(item.geo.lon, 'lon') }}</text>
          </g>
        </g>
      </g>
    </svg>
    <canvas
      v-if="usesCanvasDynamicLayer"
      ref="dynamicCanvas"
      class="orbit-map__dynamic-canvas"
      aria-hidden="true"
    ></canvas>

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
        <strong>{{ renderEngineLabel }}</strong>
      </div>
    </div>
  </div>
</template>
