import type { GroundStation, GroundStationElevationMaskSource } from '@/domain/types';

const ASF_SOURCE: GroundStationElevationMaskSource = {
  confidence: 'default',
  label: 'ASF public station-mask reference; numeric mask not published',
  url: 'https://asf.alaska.edu/asf-satellite-tracking-stations/',
};

const KSAT_SOURCE: GroundStationElevationMaskSource = {
  confidence: 'default',
  label: 'KSAT public ground-network listing; operational mask not published',
  url: 'https://www.ksat.no/services/ground-network-services/',
};

const SSC_SOURCE: GroundStationElevationMaskSource = {
  confidence: 'default',
  label: 'SSC public ground-network listing; operational mask not published',
  url: 'https://sscspace.com/services/ground-network/',
};

const NASA_NSN_SOURCE: GroundStationElevationMaskSource = {
  confidence: 'default',
  label: 'NASA Near Space Network public complex listing; numeric mask not published',
  url: 'https://www.nasa.gov/technology/space-comms/near-space-network-complexes/',
};

const DSN_SOURCE: GroundStationElevationMaskSource = {
  confidence: 'inferred',
  label: 'JPL DSN 810-005 coverage guidance; 10° scalar is conservative',
  url: 'https://deepspace.jpl.nasa.gov/dsndocs/810-005/ground-station-properties/',
};

const SANSA_SOURCE: GroundStationElevationMaskSource = {
  confidence: 'default',
  label: 'SANSA public space-operations listing; operational mask not published',
  url: 'https://www.sansa.org.za/products-services/space-operations/',
};

const SAMPLE_SOURCE: GroundStationElevationMaskSource = {
  confidence: 'default',
  label: 'App sample station; replace with user operational mask',
};

export const defaultGroundStations: GroundStation[] = [
  {
    id: 'gs-nasa-asf-fairbanks',
    name: 'NASA ASF Fairbanks',
    latDeg: 64.794,
    lonDeg: -147.536,
    altitudeM: 180,
    elevationMaskDeg: 8,
    elevationMaskSource: ASF_SOURCE,
    enabled: true,
    schemaVersion: 1,
  },
  {
    id: 'gs-ksat-svalbard',
    name: 'KSAT Svalbard',
    latDeg: 78.23,
    lonDeg: 15.39,
    altitudeM: 480,
    elevationMaskDeg: 5,
    elevationMaskSource: KSAT_SOURCE,
    enabled: true,
    schemaVersion: 1,
  },
  {
    id: 'gs-ssc-kiruna',
    name: 'SSC Kiruna / Esrange',
    latDeg: 67.8833,
    lonDeg: 21.0667,
    altitudeM: 341,
    elevationMaskDeg: 5,
    elevationMaskSource: SSC_SOURCE,
    enabled: true,
    schemaVersion: 1,
  },
  {
    id: 'gs-ssc-santiago',
    name: 'SSC Santiago',
    latDeg: -33.15,
    lonDeg: -70.66,
    altitudeM: 723,
    elevationMaskDeg: 8,
    elevationMaskSource: SSC_SOURCE,
    enabled: true,
    schemaVersion: 1,
  },
  {
    id: 'gs-ksat-trollsat',
    name: 'KSAT TrollSat',
    latDeg: -72.0167,
    lonDeg: 2.5333,
    altitudeM: 1365,
    elevationMaskDeg: 5,
    elevationMaskSource: KSAT_SOURCE,
    enabled: true,
    schemaVersion: 1,
  },
  {
    id: 'gs-nasa-wallops',
    name: 'NASA Wallops',
    latDeg: 37.94,
    lonDeg: -75.47,
    altitudeM: 3,
    elevationMaskDeg: 10,
    elevationMaskSource: NASA_NSN_SOURCE,
    enabled: true,
    schemaVersion: 1,
  },
  {
    id: 'gs-nasa-white-sands',
    name: 'NASA White Sands',
    latDeg: 32.5,
    lonDeg: -106.61,
    altitudeM: 1210,
    elevationMaskDeg: 10,
    elevationMaskSource: NASA_NSN_SOURCE,
    enabled: true,
    schemaVersion: 1,
  },
  {
    id: 'gs-nasa-mcmurdo',
    name: 'NASA McMurdo',
    latDeg: -77.85,
    lonDeg: 166.67,
    altitudeM: 20,
    elevationMaskDeg: 5,
    elevationMaskSource: NASA_NSN_SOURCE,
    enabled: true,
    schemaVersion: 1,
  },
  {
    id: 'gs-dsn-goldstone',
    name: 'DSN Goldstone',
    latDeg: 35.4267,
    lonDeg: -116.89,
    altitudeM: 1000,
    elevationMaskDeg: 10,
    elevationMaskSource: DSN_SOURCE,
    enabled: true,
    schemaVersion: 1,
  },
  {
    id: 'gs-dsn-madrid',
    name: 'DSN Madrid',
    latDeg: 40.43,
    lonDeg: -4.25,
    altitudeM: 850,
    elevationMaskDeg: 10,
    elevationMaskSource: DSN_SOURCE,
    enabled: true,
    schemaVersion: 1,
  },
  {
    id: 'gs-dsn-canberra',
    name: 'DSN Canberra',
    latDeg: -35.4,
    lonDeg: 148.98,
    altitudeM: 690,
    elevationMaskDeg: 10,
    elevationMaskSource: DSN_SOURCE,
    enabled: true,
    schemaVersion: 1,
  },
  {
    id: 'gs-sansa-hartebeesthoek',
    name: 'SANSA Hartebeesthoek',
    latDeg: -25.89,
    lonDeg: 27.69,
    altitudeM: 1415,
    elevationMaskDeg: 8,
    elevationMaskSource: SANSA_SOURCE,
    enabled: true,
    schemaVersion: 1,
  },
  {
    id: 'gs-seoul',
    name: 'Seoul Ops',
    latDeg: 37.5665,
    lonDeg: 126.978,
    altitudeM: 38,
    elevationMaskDeg: 10,
    elevationMaskSource: SAMPLE_SOURCE,
    enabled: true,
    schemaVersion: 1,
  },
  {
    id: 'gs-houston',
    name: 'Houston Backup',
    latDeg: 29.7604,
    lonDeg: -95.3698,
    altitudeM: 13,
    elevationMaskDeg: 12,
    elevationMaskSource: SAMPLE_SOURCE,
    enabled: true,
    schemaVersion: 1,
  },
];
