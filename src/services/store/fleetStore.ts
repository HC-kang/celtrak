import type {
  AnomalyEntry,
  AnomalyFilter,
  CustomTLE,
  FleetMemberRef,
  GroundStation,
  ImportReport,
  OperationalStatus,
  ScheduledEvent,
  UserFleet,
} from '@/domain/types';

export interface FleetStore {
  listFleets(): Promise<UserFleet[]>;
  getFleet(id: string): Promise<UserFleet | null>;
  upsertFleet(fleet: UserFleet): Promise<void>;
  deleteFleet(id: string): Promise<void>;
  listCustomTLEs(): Promise<CustomTLE[]>;
  upsertCustomTLE(tle: CustomTLE): Promise<void>;
  deleteCustomTLE(id: string): Promise<void>;
  listOpsStatus(ref: FleetMemberRef, limit: number): Promise<OperationalStatus[]>;
  appendOpsStatus(status: OperationalStatus): Promise<void>;
  listAnomalies(filter: AnomalyFilter): Promise<AnomalyEntry[]>;
  upsertAnomaly(anomaly: AnomalyEntry): Promise<void>;
  listGroundStations(): Promise<GroundStation[]>;
  upsertGroundStation(station: GroundStation): Promise<void>;
  listEvents(from: string, to: string): Promise<ScheduledEvent[]>;
  upsertEvent(event: ScheduledEvent): Promise<void>;
  deleteEvent(id: string): Promise<void>;
  export(): Promise<string>;
  import(json: string, mode: 'merge' | 'replace'): Promise<ImportReport>;
  getSchemaVersion(): Promise<number>;
  migrate(fromVersion: number): Promise<void>;
}
