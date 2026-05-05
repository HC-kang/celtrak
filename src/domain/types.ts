export type CatalogNumber = number;

export type DataOrigin = 'OSINT' | 'DERIVED' | 'USER' | 'STALE';

export interface TimestampedOrigin {
  origin: DataOrigin;
  fetchedAt?: string;
  recordedAt?: string;
  stale?: boolean;
}

export interface SatCatRecord {
  catalogNumber: CatalogNumber;
  objectId: string;
  objectName: string;
  objectType: 'PAYLOAD' | 'ROCKET BODY' | 'DEBRIS' | 'UNKNOWN' | 'TBA';
  opsStatusCode: string;
  ownerCountry: string;
  launchDate?: string;
  launchSite?: string;
  decayDate?: string;
  periodMinutes?: number;
  inclinationDeg?: number;
  apogeeKm?: number;
  perigeeKm?: number;
  rcsSizeClass?: 'SMALL' | 'MEDIUM' | 'LARGE';
  fetchedAt: string;
}

export type TleRaw = {
  format: 'TLE' | '3LE';
  line1: string;
  line2: string;
  line0?: string;
};

export type OmmRaw = {
  format: 'OMM-XML' | 'OMM-JSON';
  payload: string;
};

export interface OrbitalElementSet {
  catalogNumber: CatalogNumber;
  epoch: string;
  meanMotionRevPerDay: number;
  eccentricity: number;
  inclinationDeg: number;
  raanDeg: number;
  argOfPericenterDeg: number;
  meanAnomalyDeg: number;
  bstar: number;
  semiMajorAxisKm: number;
  apogeeKm: number;
  perigeeKm: number;
  periodMinutes: number;
  raw: TleRaw | OmmRaw;
  source: 'celestrak-gp' | 'celestrak-sup-gp' | 'user-tle' | 'user-omm';
  fetchedAt: string;
}

export interface CatalogEntry extends TimestampedOrigin {
  satcat: SatCatRecord;
  orbital?: OrbitalElementSet;
  group: string;
  tle?: TleRaw;
}

export interface UserFleet {
  id: string;
  name: string;
  description?: string;
  memberRefs: FleetMemberRef[];
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

export interface FleetMemberRef {
  refType: 'catalog' | 'custom';
  catalogNumber?: CatalogNumber;
  customTleId?: string;
  displayName?: string;
  tags: string[];
}

export interface CustomTLE {
  id: string;
  name: string;
  format: 'TLE' | '3LE' | 'OMM-XML' | 'OMM-JSON';
  raw: string;
  parsed?: OrbitalElementSet;
  parseErrors?: string[];
  sourceLabel?: string;
  addedAt: string;
  schemaVersion: 1;
}

export interface OperationalStatus {
  id: string;
  satelliteRef: FleetMemberRef;
  recordedAt: string;
  mcStatus: 'FMC' | 'PMC' | 'NMC' | 'UNKNOWN';
  rfStatus: 'NOMINAL' | 'DEGRADED' | 'LOSS' | 'UNKNOWN';
  notes?: string;
  schemaVersion: 1;
}

export interface AnomalyEntry {
  id: string;
  satelliteRef: FleetMemberRef;
  openedAt: string;
  closedAt?: string;
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  subsystem?: string;
  description: string;
  schemaVersion: 1;
}

export interface ScheduledEvent {
  id: string;
  satelliteRef?: FleetMemberRef;
  startAt: string;
  endAt?: string;
  kind: 'MANEUVER' | 'MAINTENANCE' | 'SW_UPDATE' | 'HANDOVER' | 'OTHER';
  title: string;
  notes?: string;
  schemaVersion: 1;
}

export interface GroundStation {
  id: string;
  name: string;
  latDeg: number;
  lonDeg: number;
  altitudeM: number;
  elevationMaskDeg: number;
  elevationMaskSource?: GroundStationElevationMaskSource;
  enabled: boolean;
  schemaVersion: 1;
}

export type ElevationMaskSourceConfidence = 'verified' | 'inferred' | 'default' | 'user';

export interface GroundStationElevationMaskSource {
  confidence: ElevationMaskSourceConfidence;
  label: string;
  url?: string;
  note?: string;
  updatedAt?: string;
}

export interface UserPreferences {
  theme: 'light' | 'dark' | 'system';
  language: 'ko' | 'en';
  defaultGroundStationId?: string;
  selectedFleetId?: string;
  units: { distance: 'km' | 'mi'; speed: 'km/s' | 'km/h' };
  mobileRenderMode: '2d' | '3d';
  tabletRenderMode: '2d' | '3d';
  desktopRenderMode: '2d' | '3d';
  hiddenTrackedRefs?: string[];
  reducedMotion: boolean;
  dataSaver: boolean;
  schemaVersion: 1;
}

export interface ConjunctionRecord extends TimestampedOrigin {
  id: string;
  tca: string;
  primary: ObjectRef;
  secondary: ObjectRef;
  missDistanceKm: number;
  relVelocityKmS: number;
  pc?: number;
  source: 'celestrak-socrates' | 'self-computed';
  fetchedAt: string;
  note?: string;
}

export interface ObjectRef {
  name: string;
  catalogNumber?: CatalogNumber;
}

export interface SpaceWeatherSnapshot extends TimestampedOrigin {
  fetchedAt: string;
  xray: {
    currentWm2: number | null;
    flareClass?: 'A' | 'B' | 'C' | 'M' | 'X';
    classMagnitude?: number;
    series?: Array<{ t: string; flux: number }>;
  };
  kp: {
    current: number | null;
    forecast?: Array<{ t: string; kp: number }>;
    storm: 'QUIET' | 'UNSETTLED' | 'MINOR' | 'MODERATE' | 'STRONG' | 'SEVERE' | 'EXTREME';
  };
  proton?: {
    currentPfu: number | null;
    energy: string;
    observedAt?: string;
  };
  scales?: {
    observedAt?: string;
    current: {
      r: NoaaScaleSummary;
      s: NoaaScaleSummary;
      g: NoaaScaleSummary;
    };
    forecast?: Array<{
      t: string;
      r?: NoaaScaleSummary;
      s?: NoaaScaleSummary;
      g?: NoaaScaleSummary;
    }>;
    previous?: {
      t: string;
      r?: NoaaScaleSummary;
      s?: NoaaScaleSummary;
      g?: NoaaScaleSummary;
    };
  };
  notices?: Array<{ issuedAt: string; type: string; text: string }>;
}

export interface NoaaScaleSummary {
  scale: number | null;
  label: string;
  text?: string;
  observedAt?: string;
  minorProbabilityPct?: number | null;
  majorProbabilityPct?: number | null;
  probabilityPct?: number | null;
  source: 'NOAA_SWPC' | 'DERIVED';
}

export interface DecayPrediction extends TimestampedOrigin {
  catalogNumber: CatalogNumber;
  name: string;
  predictedDecayAt: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  source: 'celestrak-decay';
  fetchedAt: string;
}

export interface PassPrediction extends TimestampedOrigin {
  satelliteRef: FleetMemberRef;
  groundStationId: string;
  elevationMaskDeg: number;
  aos: string;
  tca: string;
  los: string;
  losIsPredictionHorizon?: boolean;
  maxElevationDeg: number;
  aosAzimuthDeg: number;
  losAzimuthDeg: number;
  illuminationAtTca: 'SUNLIT' | 'ECLIPSED' | 'PENUMBRA';
  computedAt: string;
}

export type MapFocusTarget =
  | { type: 'satellite'; id: string }
  | { type: 'groundStation'; id: string };

export type LiveContactStatus = 'IN_CONTACT' | 'BEFORE_AOS' | 'AFTER_LOS';

export interface LiveContactLink {
  satelliteRef: FleetMemberRef;
  satelliteId: string;
  satelliteName: string;
  groundStationId: string;
  groundStationName: string;
  elevationDeg: number;
  azimuthDeg: number;
  status: LiveContactStatus;
  aos?: string;
  tca?: string;
  los?: string;
  countdownSeconds?: number;
  countdownIsEstimated?: boolean;
  countdownIsLowerBound?: boolean;
}

export interface ImportReport {
  imported: number;
  rejected: number;
  errors: string[];
}

export interface AnomalyFilter {
  openOnly?: boolean;
  satelliteRef?: FleetMemberRef;
}

export interface DashboardAlert {
  id: string;
  kind: 'offline' | 'degraded' | 'weather' | 'user';
  title: string;
  detail: string;
  tone: 'info' | 'warn' | 'critical';
}
