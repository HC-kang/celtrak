import type {
  CatalogEntry,
  ConjunctionRecord,
  DashboardAlert,
  DecayPrediction,
  GroundStation,
  SpaceWeatherSnapshot,
} from '@/domain/types';
import { defaultGroundStations } from '@/services/defaultGroundStations';

const fetchedAt = new Date().toISOString();

export const mockCatalog: CatalogEntry[] = [
  createCatalogEntry({
    catalogNumber: 25544,
    objectId: '1998-067A',
    objectName: 'ISS (ZARYA)',
    group: 'Stations',
    opsStatusCode: 'ACTIVE',
    ownerCountry: 'MULT',
    objectType: 'PAYLOAD',
    launchDate: '1998-11-20',
    line1: '1 25544U 98067A   24110.55260417  .00016717  00000+0  10270-3 0  9996',
    line2: '2 25544  51.6415 162.1898 0004620 250.2941 232.6818 15.50376377446559',
    apogeeKm: 425.7,
    perigeeKm: 418.4,
    inclinationDeg: 51.6,
    periodMinutes: 92.9,
  }),
  createCatalogEntry({
    catalogNumber: 20580,
    objectId: '1990-037B',
    objectName: 'HST',
    group: 'Active',
    opsStatusCode: 'ACTIVE',
    ownerCountry: 'US',
    objectType: 'PAYLOAD',
    launchDate: '1990-04-24',
    line1: '1 20580U 90037B   24111.15258102  .00000959  00000+0  51790-4 0  9994',
    line2: '2 20580  28.4698 269.7140 0002895 132.4264 323.3986 15.25869986766365',
    apogeeKm: 540.4,
    perigeeKm: 535.6,
    inclinationDeg: 28.5,
    periodMinutes: 94.3,
  }),
  createCatalogEntry({
    catalogNumber: 29155,
    objectId: '2006-018A',
    objectName: 'GOES 13',
    group: 'Weather',
    opsStatusCode: 'STANDBY',
    ownerCountry: 'US',
    objectType: 'PAYLOAD',
    launchDate: '2006-05-24',
    line1: '1 29155U 06018A   24110.82797945 -.00000056  00000+0  00000+0 0  9995',
    line2: '2 29155   0.2675  97.5318 0001407  38.5842 117.5362  1.00272756 65518',
    apogeeKm: 35798,
    perigeeKm: 35779,
    inclinationDeg: 0.3,
    periodMinutes: 1436,
  }),
  createCatalogEntry({
    catalogNumber: 33591,
    objectId: '2009-005A',
    objectName: 'NOAA 19',
    group: 'Weather',
    opsStatusCode: 'ACTIVE',
    ownerCountry: 'US',
    objectType: 'PAYLOAD',
    launchDate: '2009-02-06',
    line1: '1 33591U 09005A   24111.17242769  .00000130  00000+0  93553-4 0  9994',
    line2: '2 33591  99.1713 171.9748 0013460  81.6199 278.6427 14.12414659642463',
    apogeeKm: 870,
    perigeeKm: 853,
    inclinationDeg: 99.2,
    periodMinutes: 101.9,
  }),
  createCatalogEntry({
    catalogNumber: 24876,
    objectId: '1997-035A',
    objectName: 'GPS BIIR-2 (PRN 13)',
    group: 'GPS',
    opsStatusCode: 'ACTIVE',
    ownerCountry: 'US',
    objectType: 'PAYLOAD',
    launchDate: '1997-07-23',
    line1: '1 24876U 97035A   24110.84053245 -.00000039  00000+0  00000+0 0  9994',
    line2: '2 24876  54.7570 244.5788 0126279  42.2145 318.8692  2.00568951195942',
    apogeeKm: 20401,
    perigeeKm: 19724,
    inclinationDeg: 54.8,
    periodMinutes: 718,
  }),
];

export const mockWeather: SpaceWeatherSnapshot = {
  origin: 'OSINT',
  fetchedAt,
  xray: {
    currentWm2: 3.4e-6,
    flareClass: 'C',
    classMagnitude: 3.4,
    series: Array.from({ length: 12 }).map((_, index) => ({
      t: new Date(Date.now() - (11 - index) * 2 * 60 * 60 * 1000).toISOString(),
      flux: 2e-6 + Math.sin(index / 2) * 8e-7 + index * 3e-8,
    })),
  },
  kp: {
    current: 4,
    forecast: [
      { t: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), kp: 4 },
      { t: new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString(), kp: 5 },
      { t: new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString(), kp: 3 },
    ],
    storm: 'UNSETTLED',
  },
  proton: {
    currentPfu: 0.24,
    energy: '>=10 MeV',
    observedAt: fetchedAt,
  },
  scales: {
    observedAt: fetchedAt,
    current: {
      r: { scale: 0, label: 'R0', text: 'none', observedAt: fetchedAt, source: 'NOAA_SWPC' },
      s: { scale: 0, label: 'S0', text: 'none', observedAt: fetchedAt, source: 'NOAA_SWPC' },
      g: { scale: 0, label: 'G0', text: 'none', observedAt: fetchedAt, source: 'NOAA_SWPC' },
    },
    forecast: [
      {
        t: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        r: { scale: null, label: 'R—', minorProbabilityPct: 30, majorProbabilityPct: 5, source: 'NOAA_SWPC' },
        s: { scale: null, label: 'S—', probabilityPct: 5, source: 'NOAA_SWPC' },
        g: { scale: 1, label: 'G1', text: 'minor', source: 'NOAA_SWPC' },
      },
    ],
  },
  notices: [
    {
      issuedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      type: 'ALERT',
      text: 'Minor geomagnetic enhancement expected through the next UTC day.',
    },
  ],
};

export const mockConjunctions: ConjunctionRecord[] = [
  {
    id: '25544-20580',
    origin: 'OSINT',
    tca: new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString(),
    primary: { name: 'ISS (ZARYA)', catalogNumber: 25544 },
    secondary: { name: 'HST', catalogNumber: 20580 },
    missDistanceKm: 12.4,
    relVelocityKmS: 8.7,
    pc: 1.2e-5,
    source: 'celestrak-socrates',
    fetchedAt,
  },
  {
    id: '33591-24876',
    origin: 'OSINT',
    tca: new Date(Date.now() + 35 * 60 * 60 * 1000).toISOString(),
    primary: { name: 'NOAA 19', catalogNumber: 33591 },
    secondary: { name: 'GPS BIIR-2', catalogNumber: 24876 },
    missDistanceKm: 28.5,
    relVelocityKmS: 10.3,
    source: 'celestrak-socrates',
    fetchedAt,
  },
];

export const mockDecay: DecayPrediction[] = [
  {
    origin: 'OSINT',
    catalogNumber: 29155,
    name: 'GOES 13',
    predictedDecayAt: new Date(Date.now() + 22 * 24 * 60 * 60 * 1000).toISOString(),
    confidence: 'LOW',
    source: 'celestrak-decay',
    fetchedAt,
  },
];

export const mockGroundStations: GroundStation[] = defaultGroundStations;

export const mockAlerts: DashboardAlert[] = [
  {
    id: 'alert-weather',
    kind: 'weather',
    title: '우주 기상 주의',
    detail: 'NOAA Kp 4.0, 통신 링크 감쇠 가능성이 있습니다.',
    tone: 'warn',
  },
  {
    id: 'alert-socrates',
    kind: 'degraded',
    title: 'SOCRATES 최신화 지연',
    detail: '근접 접근 리스트가 3시간 전 스냅샷일 수 있습니다.',
    tone: 'info',
  },
];

function createCatalogEntry(input: {
  catalogNumber: number;
  objectId: string;
  objectName: string;
  group: string;
  opsStatusCode: string;
  ownerCountry: string;
  objectType: 'PAYLOAD' | 'ROCKET BODY' | 'DEBRIS' | 'UNKNOWN' | 'TBA';
  launchDate: string;
  line1: string;
  line2: string;
  apogeeKm: number;
  perigeeKm: number;
  inclinationDeg: number;
  periodMinutes: number;
}): CatalogEntry {
  return {
    origin: 'OSINT',
    fetchedAt,
    group: input.group,
    satcat: {
      catalogNumber: input.catalogNumber,
      objectId: input.objectId,
      objectName: input.objectName,
      objectType: input.objectType,
      opsStatusCode: input.opsStatusCode,
      ownerCountry: input.ownerCountry,
      launchDate: input.launchDate,
      apogeeKm: input.apogeeKm,
      perigeeKm: input.perigeeKm,
      inclinationDeg: input.inclinationDeg,
      periodMinutes: input.periodMinutes,
      fetchedAt,
    },
    tle: {
      format: 'TLE',
      line1: input.line1,
      line2: input.line2,
      line0: input.objectName,
    },
  };
}
