<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import type { CatalogEntry, GroundStation, LiveContactLink, MapFocusTarget } from '@/domain/types';
import { formatTimestamp } from '@/lib/format';
import { getSubsolarPoint } from '@/lib/solarTerminator';

const props = defineProps<{
  satellites: CatalogEntry[];
  contactLinks?: LiveContactLink[];
  focusedTarget?: MapFocusTarget | null;
  hoveredTarget?: MapFocusTarget | null;
  groundStations?: GroundStation[];
  dataSaver?: boolean;
  orbitTimeIso: string;
  orbitMode: 'live' | 'simulation';
  riskSatelliteIds?: string[];
  riskSatelliteTones?: Record<string, 'warn' | 'critical'>;
}>();

const emit = defineEmits<{
  'focus-target': [target: MapFocusTarget];
}>();

const container = ref<HTMLDivElement | null>(null);
const isInteracting = ref(false);
const autoRotate = ref(true);

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
const EARTH_RADIUS = 1.5;
const DEFAULT_CAMERA_DISTANCE = 5.45;
const INITIAL_EARTH_ROTATION = { x: -0.2, y: -0.52, z: 0.02 };
const FOCUS_TARGET_Y_RATIO = 0.08;
const ROTATION_X_LIMIT = Math.PI / 2 + Math.atan(FOCUS_TARGET_Y_RATIO) + 0.04;
const FOCUS_ROTATION_ANIMATION_MS = 680;
type GeoPoint = [number, number];
type GeoPolygon = GeoPoint[];
interface PointerSnapshot {
  x: number;
  y: number;
}

interface GlobePinchState {
  lastDistance: number;
}

interface FocusRotationTween {
  from: typeof INITIAL_EARTH_ROTATION;
  to: typeof INITIAL_EARTH_ROTATION;
  startedAt: number;
}
type SatelliteVisualTone = keyof typeof SATELLITE_STATE_COLORS;

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let earthRig: THREE.Group | null = null;
let globeLayer: THREE.Group | null = null;
let satelliteLayer: THREE.Group | null = null;
let stationLayer: THREE.Group | null = null;
let contactLayer: THREE.Group | null = null;
let nightShadeMaterial: THREE.ShaderMaterial | null = null;
let sunlight: THREE.DirectionalLight | null = null;
let resizeObserver: ResizeObserver | null = null;
let frameHandle = 0;
let timer: number | null = null;
let currentCameraDistance = DEFAULT_CAMERA_DISTANCE;
let targetCameraDistance = DEFAULT_CAMERA_DISTANCE;
let globeRotation = { ...INITIAL_EARTH_ROTATION };
let focusRotationTween: FocusRotationTween | null = null;
let pointerStart: { x: number; y: number; rotationX: number; rotationY: number } | null = null;
let pointerDownSnapshot: PointerSnapshot | null = null;
let pinchState: GlobePinchState | null = null;
const activePointers = new Map<number, PointerSnapshot>();
const raycaster = new THREE.Raycaster();
const pointerVector = new THREE.Vector2();
const sunDirectionLocal = new THREE.Vector3(0, 0, 1);

const trackableCount = computed(() => props.satellites.filter((entry) => Boolean(entry.tle)).length);
const renderLimit = computed(() => (props.dataSaver ? 16 : 44));
const renderedCountLabel = computed(() => `${Math.min(trackableCount.value, renderLimit.value)}/${trackableCount.value}`);
const enabledGroundStations = computed(() => (props.groundStations ?? []).filter((station) => station.enabled));
const activeContactSatelliteIdSet = computed(
  () => new Set((props.contactLinks ?? []).filter((link) => link.status === 'IN_CONTACT').map((link) => link.satelliteId)),
);
const riskSatelliteIdSet = computed(() => new Set(props.riskSatelliteIds ?? []));
const orbitModeLabel = computed(() => (props.orbitMode === 'simulation' ? 'SIM' : 'LIVE'));
const clockLabel = computed(() => formatTimestamp(props.orbitTimeIso));

function buildScene() {
  if (!container.value) return;
  const { width, height } = getContainerSize();

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#020409');
  scene.fog = new THREE.Fog('#020409', 7.4, 18);

  camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
  camera.position.set(0, 0.18, currentCameraDistance);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({
    antialias: !props.dataSaver,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, props.dataSaver ? 1.15 : 2));
  renderer.setSize(width, height);
  renderer.domElement.style.touchAction = 'none';
  container.value.appendChild(renderer.domElement);

  scene.add(createStarField(props.dataSaver ? 220 : 620));

  earthRig = new THREE.Group();
  globeRotation = { ...INITIAL_EARTH_ROTATION };
  applyGlobeRotation();
  scene.add(earthRig);

  globeLayer = new THREE.Group();
  satelliteLayer = new THREE.Group();
  stationLayer = new THREE.Group();
  contactLayer = new THREE.Group();
  earthRig.add(globeLayer, stationLayer, contactLayer, satelliteLayer);

  buildGlobe();
  updateGroundStations();
  updateSatellites();
  updateContactLinks();
  addRendererInteractions();

  resizeObserver = new ResizeObserver(resizeRenderer);
  resizeObserver.observe(container.value);
  animate();
}

function buildGlobe() {
  if (!scene || !globeLayer) return;

  const earthMaterial = new THREE.MeshStandardMaterial({
    color: '#6ea8da',
    emissive: '#021429',
    emissiveIntensity: 0.2,
    roughness: 0.96,
    metalness: 0.01,
  });

  new THREE.TextureLoader().load('/textures/earth-blue-marble-topo.jpg', (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = props.dataSaver ? 2 : 8;
    earthMaterial.map = texture;
    earthMaterial.color.set('#ffffff');
    earthMaterial.needsUpdate = true;
  });

  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS, props.dataSaver ? 48 : 96, props.dataSaver ? 32 : 64),
    earthMaterial,
  );
  earth.name = 'earth';
  globeLayer.add(earth);

  const cloudsTexture = new THREE.CanvasTexture(createCloudTexture(props.dataSaver ? 1024 : 2048));
  cloudsTexture.colorSpace = THREE.SRGBColorSpace;
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS + 0.018, props.dataSaver ? 40 : 86, props.dataSaver ? 26 : 54),
    new THREE.MeshLambertMaterial({
      map: cloudsTexture,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
    }),
  );
  clouds.name = 'cloudLayer';
  globeLayer.add(clouds);

  nightShadeMaterial = createNightShadeMaterial();
  const nightShade = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS + 0.032, props.dataSaver ? 48 : 96, props.dataSaver ? 32 : 64),
    nightShadeMaterial,
  );
  nightShade.name = 'nightShade';
  nightShade.renderOrder = 4;
  globeLayer.add(nightShade);

  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS + 0.18, props.dataSaver ? 48 : 96, props.dataSaver ? 32 : 64),
    new THREE.MeshBasicMaterial({
      color: '#1eaedb',
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.24,
      blending: THREE.AdditiveBlending,
    }),
  );
  atmosphere.name = 'atmosphere';
  globeLayer.add(atmosphere);

  globeLayer.add(createGraticule(EARTH_RADIUS + 0.012));
  globeLayer.add(createOrbitReferenceRings());

  const ambient = new THREE.AmbientLight('#8fb9ff', 0.72);
  sunlight = new THREE.DirectionalLight('#ffffff', 3.1);
  const rimLight = new THREE.DirectionalLight('#1eaedb', 1.65);
  rimLight.position.set(4, -1.4, -4.5);
  scene.add(ambient, sunlight, sunlight.target, rimLight);
  updateSunLighting();
}

function createNightShadeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      sunDirection: { value: sunDirectionLocal.clone() },
      nightOpacity: { value: props.dataSaver ? 0.32 : 0.42 },
    },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 sunDirection;
      uniform float nightOpacity;
      varying vec3 vNormal;
      void main() {
        float solarDot = dot(normalize(vNormal), normalize(sunDirection));
        float night = 1.0 - smoothstep(-0.075, 0.105, solarDot);
        float terminator = smoothstep(-0.18, 0.18, solarDot);
        vec3 color = mix(vec3(0.0, 0.012, 0.04), vec3(0.0, 0.04, 0.085), terminator);
        gl_FragColor = vec4(color, night * nightOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

function updateSunLighting() {
  const timestamp = new Date(props.orbitTimeIso);
  if (!Number.isFinite(timestamp.getTime())) return;
  const subsolar = getSubsolarPoint(timestamp);
  sunDirectionLocal.copy(latLonToVector(subsolar.latDeg, subsolar.lonDeg, 1).normalize());
  nightShadeMaterial?.uniforms.sunDirection.value.copy(sunDirectionLocal);
  applySunLightDirection();
}

function applySunLightDirection() {
  if (!sunlight) return;
  const worldDirection = sunDirectionLocal.clone();
  if (earthRig) {
    worldDirection.applyEuler(earthRig.rotation);
  }
  sunlight.position.copy(worldDirection.multiplyScalar(6));
  sunlight.target.position.set(0, 0, 0);
  sunlight.target.updateMatrixWorld();
}

function updateSatellites() {
  if (!satelliteLayer) return;
  clearSatelliteLayer();

  const baseTime = new Date(props.orbitTimeIso);
  const entries = props.satellites.filter((entry) => entry.tle).slice(0, renderLimit.value);

  for (const entry of entries) {
    if (!entry.tle) continue;
    const satrec = satellite.twoline2satrec(entry.tle.line1, entry.tle.line2);
    const point = getOrbitPoint(satrec, baseTime);
    if (!point) continue;

    const group = new THREE.Group();
    group.name = `satellite-${entry.satcat.catalogNumber}`;
    const focusTarget = { type: 'satellite', id: `catalog:${entry.satcat.catalogNumber}` } satisfies MapFocusTarget;
    const tone = satelliteVisualTone(focusTarget.id);
    const focused = tone === 'focused';
    const previewed = tone === 'preview';
    const color = new THREE.Color(SATELLITE_STATE_COLORS[tone]);

    const trailPoints = props.dataSaver ? [] : buildTrailPoints(satrec, baseTime);
    if (trailPoints.length > 1) {
      const trail = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(trailPoints),
        new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.58,
          depthWrite: false,
        }),
      );
      trail.raycast = () => {};
      group.add(trail);
    }

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 18, 18),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity:
          focused ? 2.6 : previewed ? 2.25 : tone === 'critical' ? 2.05 : tone === 'warn' ? 1.85 : tone === 'contact' ? 1.55 : 1.15,
        roughness: 0.28,
      }),
    );
    marker.position.copy(point.position);
    marker.userData.focusTarget = focusTarget;
    group.add(marker);

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(focused ? 0.18 : previewed ? 0.17 : tone === 'critical' || tone === 'warn' ? 0.15 : 0.12, 22, 22),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: focused ? 0.34 : previewed ? 0.3 : tone === 'critical' || tone === 'warn' ? 0.28 : 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    halo.position.copy(point.position);
    halo.raycast = () => {};
    group.add(halo);

    const picker = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 12, 12),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    picker.position.copy(point.position);
    picker.userData.focusTarget = focusTarget;
    group.add(picker);

    const label = createLabelSprite(shortSatelliteName(entry), altitudeLabel(point.altitudeKm), color);
    label.position.copy(point.position).multiplyScalar(1.08);
    label.raycast = () => {};
    group.add(label);

    satelliteLayer.add(group);
  }
}

function updateGroundStations() {
  if (!stationLayer) return;
  clearStationLayer();

  const activeStationIds = new Set(
    (props.contactLinks ?? []).filter((link) => link.status === 'IN_CONTACT').map((link) => link.groundStationId),
  );
  const stations = enabledGroundStations.value.slice(0, props.dataSaver ? 12 : 28);
  for (const [index, station] of stations.entries()) {
    const group = new THREE.Group();
    const focusTarget = { type: 'groundStation', id: station.id } satisfies MapFocusTarget;
    const focused = targetMatches(props.focusedTarget, focusTarget);
    const previewed = !focused && targetMatches(props.hoveredTarget, focusTarget);
    const hasActiveContact = activeStationIds.has(station.id);
    const color = new THREE.Color(
      focused
        ? STATION_STATE_COLORS.focused
        : previewed
          ? STATION_STATE_COLORS.preview
          : hasActiveContact
            ? STATION_STATE_COLORS.activeContact
            : STATION_STATE_COLORS.idle,
    );
    const surface = latLonToVector(station.latDeg, station.lonDeg, EARTH_RADIUS + 0.035);
    const normal = surface.clone().normalize();

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.025, 12, 12),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: focused ? 1 : previewed ? 0.98 : hasActiveContact ? 0.95 : 0.72,
      }),
    );
    marker.position.copy(surface);
    marker.userData.focusTarget = focusTarget;
    group.add(marker);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.068, 0.0035, 6, 64),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: focused ? 0.62 : previewed ? 0.56 : hasActiveContact ? 0.48 : 0.26,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    ring.position.copy(surface);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    ring.raycast = () => {};
    group.add(ring);

    const beam = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([surface.clone().multiplyScalar(0.998), surface.clone().multiplyScalar(1.105)]),
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: hasActiveContact || focused || previewed ? 0.44 : 0.2,
        depthWrite: false,
      }),
    );
    beam.raycast = () => {};
    group.add(beam);

    const picker = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 10, 10),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    picker.position.copy(surface);
    picker.userData.focusTarget = focusTarget;
    group.add(picker);

    if (index < (props.dataSaver ? 4 : 10)) {
      const label = createLabelSprite(station.name, `${station.elevationMaskDeg} deg mask`, color);
      label.position.copy(surface).multiplyScalar(1.14);
      label.scale.set(0.64, 0.18, 1);
      label.raycast = () => {};
      group.add(label);
    }

    stationLayer.add(group);
  }
}

function updateContactLinks() {
  if (!contactLayer) return;
  clearContactLayer();

  const baseTime = new Date(props.orbitTimeIso);
  const entries = new Map(props.satellites.filter((entry) => entry.tle).map((entry) => [`catalog:${entry.satcat.catalogNumber}`, entry]));
  const stations = new Map(enabledGroundStations.value.map((station) => [station.id, station]));
  const activeLinks = (props.contactLinks ?? []).filter((link) => link.status === 'IN_CONTACT');
  const links = props.dataSaver ? activeLinks.slice(0, 48) : activeLinks;

  for (const link of links) {
    const entry = entries.get(link.satelliteId);
    const station = stations.get(link.groundStationId);
    if (!entry?.tle || !station) continue;
    const satrec = satellite.twoline2satrec(entry.tle.line1, entry.tle.line2);
    const orbitPoint = getOrbitPoint(satrec, baseTime);
    if (!orbitPoint) continue;
    const stationPoint = latLonToVector(station.latDeg, station.lonDeg, EARTH_RADIUS + 0.045);
    const focused =
      targetMatches(props.focusedTarget, { type: 'satellite', id: link.satelliteId }) ||
      targetMatches(props.focusedTarget, { type: 'groundStation', id: link.groundStationId });
    const previewed =
      !focused &&
      (targetMatches(props.hoveredTarget, { type: 'satellite', id: link.satelliteId }) ||
        targetMatches(props.hoveredTarget, { type: 'groundStation', id: link.groundStationId }));
    const color = new THREE.Color(focused ? '#ffffff' : previewed ? '#d7f1ff' : '#1eaedb');
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([stationPoint, orbitPoint.position]),
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: focused ? 0.86 : previewed ? 0.74 : 0.42,
        depthWrite: false,
      }),
    );
    contactLayer.add(line);
  }
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

function getOrbitPoint(satrec: satellite.SatRec, timestamp: Date) {
  const propagated = satellite.propagate(satrec, timestamp);
  if (!propagated.position || propagated.position === true) return null;
  const gmst = satellite.gstime(timestamp);
  const geo = satellite.eciToGeodetic(propagated.position, gmst);
  const altitudeKm = Number.isFinite(geo.height) ? geo.height : 550;
  const radius = radiusForAltitude(altitudeKm);
  return {
    altitudeKm,
    position: latLonToVector(radiansToDegrees(geo.latitude), radiansToDegrees(geo.longitude), radius),
  };
}

function buildTrailPoints(satrec: satellite.SatRec, baseTime: Date) {
  const points: THREE.Vector3[] = [];
  const stepMinutes = props.dataSaver ? 10 : 4;

  for (let index = -22; index <= 26; index += 1) {
    const timestamp = new Date(baseTime.getTime() + index * stepMinutes * 60 * 1000);
    const point = getOrbitPoint(satrec, timestamp);
    if (point) {
      points.push(point.position);
    }
  }

  if (points.length < 3) return points;
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.38);
  return curve.getPoints(Math.min(points.length * 4, props.dataSaver ? 80 : 180));
}

function radiusForAltitude(altitudeKm: number) {
  const safeAltitude = Math.max(0, Number.isFinite(altitudeKm) ? altitudeKm : 550);
  const scaledAltitude = Math.log1p(safeAltitude / 280) / Math.log1p(42_000 / 280);
  return EARTH_RADIUS + 0.08 + THREE.MathUtils.clamp(scaledAltitude * 1.12, 0.08, 1.18);
}

function latLonToVector(lat: number, lon: number, radius = EARTH_RADIUS) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -(radius * Math.sin(phi) * Math.cos(theta)),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function createEarthTexture(size: number) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size / 2;
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  const landPolygons = getSimplifiedLandPolygons();

  const oceanGradient = context.createLinearGradient(0, 0, 0, canvas.height);
  oceanGradient.addColorStop(0, '#04264a');
  oceanGradient.addColorStop(0.48, '#03162f');
  oceanGradient.addColorStop(1, '#041026');
  context.fillStyle = oceanGradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.strokeStyle = 'rgba(83, 177, 255, 0.08)';
  context.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 15) {
    const x = ((lon + 180) / 360) * canvas.width;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, canvas.height);
    context.stroke();
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const y = ((90 - lat) / 180) * canvas.height;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();
  }

  context.shadowColor = 'rgba(30, 174, 219, 0.42)';
  context.shadowBlur = size * 0.0055;
  context.fillStyle = '#0f3d5a';
  context.strokeStyle = 'rgba(100, 195, 255, 0.5)';
  context.lineWidth = Math.max(1.2, size * 0.00135);
  for (const land of landPolygons) {
    drawGeoPolygon(context, canvas.width, canvas.height, land);
  }

  context.shadowBlur = 0;
  context.globalCompositeOperation = 'screen';
  context.strokeStyle = 'rgba(83, 177, 255, 0.28)';
  context.lineWidth = Math.max(0.8, size * 0.0007);
  for (const land of landPolygons) {
    drawGeoPolygon(context, canvas.width, canvas.height, land, false);
  }
  context.globalCompositeOperation = 'source-over';

  drawTerrainTexture(context, canvas.width, canvas.height, landPolygons, props.dataSaver ? 520 : 1850);
  drawCityLights(context, canvas.width, canvas.height, props.dataSaver ? 5 : 10);

  context.shadowBlur = 0;
  context.globalAlpha = 1;

  return canvas;
}

function createCloudTexture(size: number) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size / 2;
  const context = canvas.getContext('2d');
  if (!context) return canvas;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.filter = `blur(${Math.max(6, size * 0.008)}px)`;
  context.fillStyle = 'rgba(255, 255, 255, 0.72)';
  for (let index = 0; index < (props.dataSaver ? 34 : 86); index += 1) {
    const x = Math.random() * canvas.width;
    const y = Math.random() * canvas.height;
    const radiusX = size * (0.012 + Math.random() * 0.04);
    const radiusY = size * (0.004 + Math.random() * 0.016);
    context.beginPath();
    context.ellipse(x, y, radiusX, radiusY, Math.random() * Math.PI, 0, Math.PI * 2);
    context.fill();
  }
  context.filter = 'none';

  return canvas;
}

function createGraticule(radius: number) {
  const positions: number[] = [];
  const pushSegment = (start: THREE.Vector3, end: THREE.Vector3) => {
    positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
  };

  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = -180; lon < 180; lon += 5) {
      pushSegment(latLonToVector(lat, lon, radius), latLonToVector(lat, lon + 5, radius));
    }
  }

  for (let lon = -180; lon < 180; lon += 30) {
    for (let lat = -85; lat < 85; lat += 5) {
      pushSegment(latLonToVector(lat, lon, radius), latLonToVector(lat + 5, lon, radius));
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      color: '#53b1ff',
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
    }),
  );
}

function createOrbitReferenceRings() {
  const group = new THREE.Group();
  const inclinations = [0, 42, -52, 76];

  for (const [index, inclination] of inclinations.entries()) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(EARTH_RADIUS + 0.35 + index * 0.08, 0.0035, 6, 220),
      new THREE.MeshBasicMaterial({
        color: '#53b1ff',
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
      }),
    );
    ring.rotation.x = Math.PI / 2 + THREE.MathUtils.degToRad(inclination);
    ring.rotation.z = THREE.MathUtils.degToRad(index * 34);
    group.add(ring);
  }

  return group;
}

function createStarField(count: number) {
  const positions: number[] = [];
  const colors: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const radius = 9 + Math.random() * 12;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions.push(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
    );

    const color = new THREE.Color('#ffffff').lerp(new THREE.Color('#53b1ff'), Math.random() * 0.35);
    color.multiplyScalar(0.62 + Math.random() * 0.5);
    colors.push(color.r, color.g, color.b);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: props.dataSaver ? 0.026 : 0.018,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
      vertexColors: true,
    }),
  );
}

function createLabelSprite(title: string, subtitle: string, color: THREE.Color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 144;
  const context = canvas.getContext('2d');
  if (context) {
    drawRoundRect(context, 18, 24, 420, 76, 22);
    context.fillStyle = 'rgba(0, 0, 0, 0.68)';
    context.fill();
    context.strokeStyle = color.getStyle();
    context.lineWidth = 3;
    context.stroke();

    context.fillStyle = '#ffffff';
    context.font = '700 28px Arial';
    context.fillText(title, 40, 58, 360);
    context.fillStyle = 'rgba(255, 255, 255, 0.66)';
    context.font = '500 20px Arial';
    context.fillText(subtitle, 40, 86, 360);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
    }),
  );
  sprite.scale.set(0.78, 0.22, 1);
  return sprite;
}

function drawRoundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function drawGeoPolygon(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  coordinates: GeoPolygon,
  fill = true,
) {
  const points = coordinates.map(([lon, lat]) => geoToTexturePoint(lon, lat, width, height));
  if (points.length < 3) return;

  context.beginPath();
  const first = points[0];
  const last = points[points.length - 1];
  context.moveTo((first.x + last.x) / 2, (first.y + last.y) / 2);

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    context.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
  }

  context.closePath();
  if (fill) {
    context.fill();
  }
  context.stroke();
}

function geoToTexturePoint(lon: number, lat: number, width: number, height: number) {
  return {
    x: ((lon + 180) / 360) * width,
    y: ((90 - lat) / 180) * height,
  };
}

function drawTerrainTexture(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  landPolygons: GeoPolygon[],
  count: number,
) {
  const random = createSeededRandom(41);
  context.save();
  context.globalCompositeOperation = 'screen';
  for (let index = 0; index < count; index += 1) {
    const lon = -180 + random() * 360;
    const lat = -62 + random() * 142;
    if (!isLandPoint(lon, lat, landPolygons)) continue;
    const { x, y } = geoToTexturePoint(lon, lat, width, height);
    const radius = Math.max(0.7, width * (0.00032 + random() * 0.00062));
    context.globalAlpha = 0.05 + random() * 0.12;
    context.fillStyle = random() > 0.66 ? '#7edcff' : '#1eaedb';
    context.beginPath();
    context.ellipse(x, y, radius * (1.6 + random() * 2), radius, random() * Math.PI, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawCityLights(context: CanvasRenderingContext2D, width: number, height: number, density: number) {
  const clusters: Array<[number, number, number]> = [
    [-74, 40.7, 1.2],
    [-118.2, 34, 0.85],
    [-99.1, 19.4, 0.75],
    [-46.6, -23.5, 0.8],
    [-58.4, -34.6, 0.58],
    [-0.1, 51.5, 0.95],
    [2.35, 48.85, 1],
    [13.4, 52.5, 0.7],
    [37.6, 55.75, 0.78],
    [31.2, 30, 0.85],
    [77.2, 28.6, 1],
    [72.8, 19.1, 0.86],
    [116.4, 39.9, 1.05],
    [121.5, 31.2, 1],
    [126.98, 37.56, 0.72],
    [139.7, 35.7, 0.95],
    [103.8, 1.35, 0.72],
    [151.2, -33.9, 0.62],
    [28.0, -26.2, 0.55],
  ];

  const random = createSeededRandom(91);
  context.save();
  context.globalCompositeOperation = 'screen';
  for (const [lon, lat, weight] of clusters) {
    const points = Math.max(3, Math.round(density * weight));
    for (let index = 0; index < points; index += 1) {
      const jitterLon = lon + (random() - 0.5) * 7.8;
      const jitterLat = lat + (random() - 0.5) * 4.2;
      const { x, y } = geoToTexturePoint(jitterLon, jitterLat, width, height);
      const radius = Math.max(1, width * (0.00052 + random() * 0.00062));
      const glow = context.createRadialGradient(x, y, 0, x, y, radius * 4);
      glow.addColorStop(0, 'rgba(181, 241, 255, 0.74)');
      glow.addColorStop(0.28, 'rgba(30, 174, 219, 0.32)');
      glow.addColorStop(1, 'rgba(0, 112, 204, 0)');
      context.fillStyle = glow;
      context.beginPath();
      context.arc(x, y, radius * 4, 0, Math.PI * 2);
      context.fill();
    }
  }
  context.restore();
}

function isLandPoint(lon: number, lat: number, landPolygons: GeoPolygon[]) {
  return landPolygons.some((polygon) => pointInPolygon(lon, lat, polygon));
}

function pointInPolygon(lon: number, lat: number, polygon: GeoPolygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [xi, yi] = polygon[index];
    const [xj, yj] = polygon[previous];
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function createSeededRandom(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function getSimplifiedLandPolygons(): GeoPolygon[] {
  return [
    [
      [-168, 71],
      [-154, 72],
      [-138, 69],
      [-125, 61],
      [-113, 58],
      [-95, 58],
      [-79, 52],
      [-62, 51],
      [-52, 44],
      [-66, 32],
      [-80, 25],
      [-81, 18],
      [-88, 17],
      [-94, 22],
      [-107, 23],
      [-118, 31],
      [-124, 40],
      [-133, 49],
      [-151, 57],
      [-165, 62],
    ],
    [
      [-82, 12],
      [-71, 11],
      [-61, 7],
      [-50, 1],
      [-38, -12],
      [-35, -24],
      [-45, -39],
      [-57, -52],
      [-68, -55],
      [-74, -43],
      [-77, -30],
      [-74, -14],
      [-78, -3],
    ],
    [
      [-18, 35],
      [-6, 36],
      [10, 34],
      [24, 31],
      [35, 21],
      [43, 10],
      [51, -1],
      [46, -14],
      [39, -24],
      [28, -33],
      [16, -35],
      [6, -27],
      [-4, -16],
      [-11, -3],
      [-17, 12],
    ],
    [
      [-11, 58],
      [3, 61],
      [20, 66],
      [40, 69],
      [60, 66],
      [80, 63],
      [104, 61],
      [128, 56],
      [150, 49],
      [166, 39],
      [158, 29],
      [140, 22],
      [124, 14],
      [107, 8],
      [96, 14],
      [83, 22],
      [70, 24],
      [58, 18],
      [45, 24],
      [31, 36],
      [18, 44],
      [7, 47],
      [-2, 51],
    ],
    [
      [64, 25],
      [77, 31],
      [89, 25],
      [92, 13],
      [84, 7],
      [76, 8],
      [70, 16],
    ],
    [
      [96, 8],
      [108, 7],
      [120, 1],
      [124, -8],
      [116, -9],
      [105, -4],
    ],
    [
      [110, -10],
      [124, -15],
      [140, -18],
      [154, -27],
      [151, -39],
      [137, -44],
      [122, -37],
      [113, -27],
    ],
    [
      [-54, 78],
      [-33, 80],
      [-17, 73],
      [-24, 64],
      [-40, 60],
      [-58, 62],
      [-64, 70],
    ],
    [
      [-10, 50],
      [2, 57],
      [10, 53],
      [5, 44],
      [-5, 43],
    ],
    [
      [42, 12],
      [51, 13],
      [56, 25],
      [47, 30],
      [40, 24],
    ],
    [
      [46, -13],
      [50, -18],
      [49, -25],
      [44, -25],
      [43, -18],
    ],
    [
      [130, 34],
      [142, 45],
      [146, 38],
      [137, 31],
    ],
    [
      [165, -34],
      [179, -42],
      [174, -47],
      [166, -46],
    ],
    [
      [-7, 36],
      [16, 38],
      [28, 41],
      [28, 46],
      [15, 48],
      [4, 44],
      [-6, 42],
    ],
    [
      [-180, -72],
      [-120, -68],
      [-62, -70],
      [0, -67],
      [64, -69],
      [124, -66],
      [180, -72],
      [180, -88],
      [-180, -88],
    ],
  ];
}

function addRendererInteractions() {
  if (!renderer) return;
  renderer.domElement.addEventListener('pointerdown', handlePointerDown);
  renderer.domElement.addEventListener('wheel', handleWheel, { passive: false });
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('pointercancel', handlePointerUp);
}

function removeRendererInteractions() {
  if (renderer) {
    renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
    renderer.domElement.removeEventListener('wheel', handleWheel);
  }
  window.removeEventListener('pointermove', handlePointerMove);
  window.removeEventListener('pointerup', handlePointerUp);
  window.removeEventListener('pointercancel', handlePointerUp);
}

function handlePointerDown(event: PointerEvent) {
  if (!earthRig || !renderer) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault();
  cancelGlobeFocusAnimation();
  pointerDownSnapshot = { x: event.clientX, y: event.clientY };
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  renderer.domElement.setPointerCapture(event.pointerId);

  if (activePointers.size >= 2) {
    beginPinch();
    return;
  }

  beginRotation(event.clientX, event.clientY);
}

function beginRotation(clientX: number, clientY: number) {
  if (!earthRig) return;
  pointerStart = {
    x: clientX,
    y: clientY,
    rotationX: globeRotation.x,
    rotationY: globeRotation.y,
  };
  isInteracting.value = true;
}

function handlePointerMove(event: PointerEvent) {
  if (activePointers.has(event.pointerId)) {
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }

  if (pinchState && activePointers.size >= 2) {
    event.preventDefault();
    updatePinch();
    return;
  }

  if (!pointerStart || !earthRig) return;
  const deltaX = (event.clientX - pointerStart.x) / 180;
  const deltaY = (event.clientY - pointerStart.y) / 180;
  setGlobeRotation({
    x: pointerStart.rotationX + deltaY,
    y: pointerStart.rotationY + deltaX,
  });
}

function handlePointerUp(event: PointerEvent) {
  const shouldFocus = pointerDownSnapshot && pointerDistance(pointerDownSnapshot, { x: event.clientX, y: event.clientY }) < 6 && activePointers.size <= 1;
  if (renderer?.domElement.hasPointerCapture(event.pointerId)) {
    renderer.domElement.releasePointerCapture(event.pointerId);
  }
  activePointers.delete(event.pointerId);
  pinchState = null;

  if (activePointers.size === 1) {
    const [remainingPointerId, pointer] = Array.from(activePointers.entries())[0];
    void remainingPointerId;
    beginRotation(pointer.x, pointer.y);
    pointerDownSnapshot = null;
    return;
  }

  if (shouldFocus) {
    focusObjectAt(event.clientX, event.clientY);
  }
  pointerDownSnapshot = null;
  pointerStart = null;
  isInteracting.value = false;
}

function handleWheel(event: WheelEvent) {
  event.preventDefault();
  targetCameraDistance = THREE.MathUtils.clamp(targetCameraDistance + event.deltaY * 0.004, 3.45, 8.2);
}

function toggleAutoRotate() {
  cancelGlobeFocusAnimation();
  autoRotate.value = !autoRotate.value;
}

function beginPinch() {
  const [first, second] = Array.from(activePointers.values());
  if (!first || !second) return;
  pointerStart = null;
  isInteracting.value = true;
  pinchState = {
    lastDistance: pointerDistance(first, second),
  };
}

function updatePinch() {
  const [first, second] = Array.from(activePointers.values());
  if (!first || !second || !pinchState) return;
  const nextDistance = pointerDistance(first, second);
  if (nextDistance < 8 || pinchState.lastDistance < 8) return;

  const ratio = nextDistance / pinchState.lastDistance;
  targetCameraDistance = THREE.MathUtils.clamp(targetCameraDistance / ratio, 3.45, 8.2);
  pinchState = {
    lastDistance: nextDistance,
  };
}

function pointerDistance(first: PointerSnapshot, second: PointerSnapshot) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function focusObjectAt(clientX: number, clientY: number) {
  if (!renderer || !camera || !earthRig) return;
  const bounds = renderer.domElement.getBoundingClientRect();
  pointerVector.x = ((clientX - bounds.left) / bounds.width) * 2 - 1;
  pointerVector.y = -(((clientY - bounds.top) / bounds.height) * 2 - 1);
  raycaster.setFromCamera(pointerVector, camera);
  const intersections = raycaster.intersectObjects([satelliteLayer, stationLayer].filter(Boolean) as THREE.Object3D[], true);
  const target = intersections.map((item) => findFocusTarget(item.object)).find(Boolean);
  if (target) {
    emit('focus-target', target);
  }
}

function focusGlobeOnTarget(target: MapFocusTarget | null | undefined) {
  if (!target || !earthRig) return;
  const targetVector = target.type === 'satellite' ? findSatelliteVector(target.id) : findStationVector(target.id);
  if (!targetVector) return;

  animateGlobeRotationTo(rotationForFocusTarget(targetVector));
  autoRotate.value = false;
  isInteracting.value = false;
  pointerStart = null;
  targetCameraDistance = Math.min(targetCameraDistance, 4.85);
}

function followFocusedSatellite() {
  if (props.focusedTarget?.type !== 'satellite' || isInteracting.value) return;
  const targetVector = findSatelliteVector(props.focusedTarget.id);
  if (!targetVector) return;
  cancelGlobeFocusAnimation();
  setGlobeRotation(rotationForFocusTarget(targetVector));
  autoRotate.value = false;
  targetCameraDistance = Math.min(targetCameraDistance, 4.85);
}

function rotationForFocusTarget(targetVector: THREE.Vector3) {
  const z = INITIAL_EARTH_ROTATION.z;
  const zRotated = targetVector.clone().normalize().applyEuler(new THREE.Euler(0, 0, z, 'XYZ'));
  const rawY = Math.atan2(-zRotated.x, zRotated.z);
  const y = nearestEquivalentAngle(rawY, globeRotation.y);
  const afterY = zRotated.clone().applyEuler(new THREE.Euler(0, y, 0, 'XYZ'));
  const x = Math.atan2(afterY.y, afterY.z) - Math.atan(FOCUS_TARGET_Y_RATIO);
  return { x, y, z };
}

function nearestEquivalentAngle(angle: number, anchor: number) {
  return angle + Math.round((anchor - angle) / (Math.PI * 2)) * Math.PI * 2;
}

function setGlobeRotation(next: Partial<typeof INITIAL_EARTH_ROTATION>) {
  globeRotation = {
    x: next.x === undefined ? globeRotation.x : THREE.MathUtils.clamp(next.x, -ROTATION_X_LIMIT, ROTATION_X_LIMIT),
    y: next.y ?? globeRotation.y,
    z: next.z ?? globeRotation.z,
  };
  applyGlobeRotation();
}

function applyGlobeRotation() {
  earthRig?.rotation.set(globeRotation.x, globeRotation.y, globeRotation.z);
  applySunLightDirection();
}

function animateGlobeRotationTo(targetRotation: typeof INITIAL_EARTH_ROTATION) {
  cancelGlobeFocusAnimation();
  if (prefersReducedMotion()) {
    setGlobeRotation(targetRotation);
    return;
  }
  focusRotationTween = {
    from: { ...globeRotation },
    to: {
      x: THREE.MathUtils.clamp(targetRotation.x, -ROTATION_X_LIMIT, ROTATION_X_LIMIT),
      y: targetRotation.y,
      z: targetRotation.z,
    },
    startedAt: performance.now(),
  };
}

function updateGlobeFocusAnimation(timestamp: number) {
  if (!focusRotationTween) return;
  const progress = THREE.MathUtils.clamp((timestamp - focusRotationTween.startedAt) / FOCUS_ROTATION_ANIMATION_MS, 0, 1);
  const eased = easeOutCubic(progress);
  setGlobeRotation({
    x: THREE.MathUtils.lerp(focusRotationTween.from.x, focusRotationTween.to.x, eased),
    y: THREE.MathUtils.lerp(focusRotationTween.from.y, focusRotationTween.to.y, eased),
    z: THREE.MathUtils.lerp(focusRotationTween.from.z, focusRotationTween.to.z, eased),
  });

  if (progress >= 1) {
    setGlobeRotation(focusRotationTween.to);
    focusRotationTween = null;
  }
}

function cancelGlobeFocusAnimation() {
  focusRotationTween = null;
}

function findSatelliteVector(id: string) {
  const catalogNumber = Number(id.replace('catalog:', ''));
  if (!Number.isFinite(catalogNumber)) return null;
  const entry = props.satellites.find((item) => item.satcat.catalogNumber === catalogNumber);
  if (!entry?.tle) return null;
  const satrec = satellite.twoline2satrec(entry.tle.line1, entry.tle.line2);
  return getOrbitPoint(satrec, new Date(props.orbitTimeIso))?.position ?? null;
}

function findStationVector(id: string) {
  const station = (props.groundStations ?? []).find((item) => item.id === id);
  return station ? latLonToVector(station.latDeg, station.lonDeg, EARTH_RADIUS + 0.035) : null;
}

function findFocusTarget(object: THREE.Object3D | null): MapFocusTarget | null {
  let current: THREE.Object3D | null = object;
  while (current) {
    const target = current.userData.focusTarget as MapFocusTarget | undefined;
    if (target) return target;
    current = current.parent;
  }
  return null;
}

function animate(timestamp = performance.now()) {
  if (!renderer || !scene || !camera) return;
  frameHandle = requestAnimationFrame(animate);
  updateGlobeFocusAnimation(timestamp);

  if (earthRig && autoRotate.value && !isInteracting.value) {
    setGlobeRotation({ y: globeRotation.y + (props.dataSaver ? 0.00055 : 0.0009) });
  }

  const clouds = globeLayer?.getObjectByName('cloudLayer');
  if (clouds) {
    clouds.rotation.y += props.dataSaver ? 0.0002 : 0.00034;
  }

  currentCameraDistance = THREE.MathUtils.lerp(currentCameraDistance, targetCameraDistance, 0.08);
  camera.position.z = currentCameraDistance;
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
}

function resizeRenderer() {
  if (!renderer || !camera) return;
  const { width, height } = getContainerSize();
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}

function getContainerSize() {
  const width = Math.max(container.value?.clientWidth ?? 1, 1);
  const height = Math.max(container.value?.clientHeight ?? 1, 1);
  return { width, height };
}

function clearSatelliteLayer() {
  if (!satelliteLayer) return;
  for (const child of [...satelliteLayer.children]) {
    satelliteLayer.remove(child);
    disposeObject(child);
  }
}

function clearStationLayer() {
  if (!stationLayer) return;
  for (const child of [...stationLayer.children]) {
    stationLayer.remove(child);
    disposeObject(child);
  }
}

function clearContactLayer() {
  if (!contactLayer) return;
  for (const child of [...contactLayer.children]) {
    contactLayer.remove(child);
    disposeObject(child);
  }
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const maybeMesh = child as THREE.Mesh;
    maybeMesh.geometry?.dispose();
    const material = (child as unknown as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(material)) {
      material.forEach(disposeMaterial);
    } else if (material) {
      disposeMaterial(material);
    }
  });
}

function disposeMaterial(material: THREE.Material) {
  const textureMaterial = material as THREE.Material & {
    map?: THREE.Texture | null;
    alphaMap?: THREE.Texture | null;
    emissiveMap?: THREE.Texture | null;
  };
  textureMaterial.map?.dispose();
  textureMaterial.alphaMap?.dispose();
  textureMaterial.emissiveMap?.dispose();
  material.dispose();
}

function syncTimer() {
  if (timer) {
    window.clearInterval(timer);
    timer = null;
  }
  if (props.orbitMode === 'simulation') return;
  timer = window.setInterval(() => {
    updateSatellites();
    updateContactLinks();
    followFocusedSatellite();
  }, props.dataSaver ? 4200 : 1200);
}

function shortSatelliteName(entry: CatalogEntry) {
  const name = entry.satcat.objectName || `SAT ${entry.satcat.catalogNumber}`;
  return name.length > 18 ? `${name.slice(0, 17)}...` : name;
}

function altitudeLabel(altitudeKm: number) {
  return `${Math.round(altitudeKm).toLocaleString()} km scaled altitude`;
}

function targetMatches(left: MapFocusTarget | null | undefined, right: MapFocusTarget | undefined) {
  return Boolean(left && right && left.type === right.type && left.id === right.id);
}

function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI;
}

function easeOutCubic(value: number) {
  return 1 - (1 - value) ** 3;
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

onMounted(() => {
  buildScene();
  syncTimer();
  requestAnimationFrame(() => focusGlobeOnTarget(props.focusedTarget));
});

watch(
  () => props.satellites,
  () => {
    updateSatellites();
    updateContactLinks();
  },
  { deep: true },
);

watch(
  () => props.groundStations,
  () => {
    updateGroundStations();
    updateContactLinks();
  },
  { deep: true },
);

watch(
  () => props.orbitTimeIso,
  () => {
    updateSunLighting();
    if (props.orbitMode === 'simulation' || props.focusedTarget?.type === 'satellite') {
      updateSatellites();
      updateContactLinks();
    }
    followFocusedSatellite();
  },
);

watch(
  () => props.contactLinks,
  () => {
    updateGroundStations();
    updateSatellites();
    updateContactLinks();
  },
  { deep: true },
);

watch(
  () => props.riskSatelliteIds,
  () => updateSatellites(),
  { deep: true },
);

watch(
  () => props.riskSatelliteTones,
  () => updateSatellites(),
  { deep: true },
);

watch(
  () => props.focusedTarget,
  (target) => {
    updateSatellites();
    updateGroundStations();
    updateContactLinks();
    focusGlobeOnTarget(target);
  },
  { deep: true },
);

watch(
  () => props.hoveredTarget,
  () => {
    updateSatellites();
    updateGroundStations();
    updateContactLinks();
  },
  { deep: true },
);

watch(
  () => [props.orbitMode, props.dataSaver] as const,
  () => {
    updateGroundStations();
    updateSatellites();
    updateContactLinks();
    syncTimer();
  },
);

onBeforeUnmount(() => {
  cancelAnimationFrame(frameHandle);
  if (timer) {
    window.clearInterval(timer);
  }
  resizeObserver?.disconnect();
  removeRendererInteractions();
  if (scene) {
    disposeObject(scene);
    scene.clear();
  }
  if (renderer?.domElement && container.value?.contains(renderer.domElement)) {
    container.value.removeChild(renderer.domElement);
  }
  renderer?.dispose();
});
</script>

<template>
  <div
    ref="container"
    class="orbit-map orbit-map--3d"
    :class="{ 'orbit-map--interacting': isInteracting }"
    aria-label="3D orbit globe"
  >
    <div class="orbit-map__hud orbit-map__hud--top orbit-map__hud--3d">
      <div>
        <strong>3D Orbit Globe</strong>
        <small class="orbit-map__hud-note">SGP4 tracks with scaled altitude bands</small>
      </div>
      <div class="orbit-map__top-actions orbit-map__top-actions--3d">
        <button
          class="orbit-map__rotate-toggle"
          type="button"
          :aria-pressed="!autoRotate"
          @click="toggleAutoRotate"
        >
          {{ autoRotate ? '회전 정지' : '회전 재개' }}
        </button>
        <div class="orbit-map__clock">
          <span>{{ orbitModeLabel }}</span>
          <small>{{ clockLabel }}</small>
        </div>
      </div>
    </div>

    <div class="orbit-map__interaction-hint orbit-map__interaction-hint--3d">
      Drag rotate · Wheel/Pinch zoom · Smooth orbit trails
    </div>

    <div class="orbit-map__hud orbit-map__hud--bottom orbit-map__hud--3d-bottom">
      <div>
        <span>Tracked</span>
        <strong>{{ renderedCountLabel }}</strong>
      </div>
      <div>
        <span>Ground Sites</span>
        <strong>{{ enabledGroundStations.length }}</strong>
      </div>
      <div>
        <span>Propagation</span>
        <strong>SGP4</strong>
      </div>
      <div>
        <span>Surface</span>
        <strong>Blue Marble</strong>
      </div>
    </div>
  </div>
</template>
