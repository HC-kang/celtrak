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
import type { FleetStore } from '@/services/store/fleetStore';

interface ExportShape {
  fleets: UserFleet[];
  customTles: CustomTLE[];
  opsStatuses: OperationalStatus[];
  anomalies: AnomalyEntry[];
  groundStations: GroundStation[];
  events: ScheduledEvent[];
  schemaVersion: number;
}

export class InMemoryFleetStore implements FleetStore {
  private fleets = new Map<string, UserFleet>();
  private customTles = new Map<string, CustomTLE>();
  private opsStatuses = new Map<string, OperationalStatus>();
  private anomalies = new Map<string, AnomalyEntry>();
  private groundStations = new Map<string, GroundStation>();
  private events = new Map<string, ScheduledEvent>();

  async listFleets() {
    return [...this.fleets.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getFleet(id: string) {
    return this.fleets.get(id) ?? null;
  }

  async upsertFleet(fleet: UserFleet) {
    this.fleets.set(fleet.id, fleet);
  }

  async deleteFleet(id: string) {
    this.fleets.delete(id);
  }

  async listCustomTLEs() {
    return [...this.customTles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async upsertCustomTLE(tle: CustomTLE) {
    this.customTles.set(tle.id, tle);
  }

  async deleteCustomTLE(id: string) {
    this.customTles.delete(id);
  }

  async listOpsStatus(ref: FleetMemberRef, limit: number) {
    return [...this.opsStatuses.values()]
      .filter((status) => matchesRef(status.satelliteRef, ref))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      .slice(0, limit);
  }

  async appendOpsStatus(status: OperationalStatus) {
    this.opsStatuses.set(status.id, status);
  }

  async listAnomalies(filter: AnomalyFilter) {
    return [...this.anomalies.values()]
      .filter((anomaly) => !filter.satelliteRef || matchesRef(anomaly.satelliteRef, filter.satelliteRef))
      .filter((anomaly) => !filter.openOnly || !anomaly.closedAt)
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }

  async upsertAnomaly(anomaly: AnomalyEntry) {
    this.anomalies.set(anomaly.id, anomaly);
  }

  async listGroundStations() {
    return [...this.groundStations.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async upsertGroundStation(station: GroundStation) {
    this.groundStations.set(station.id, station);
  }

  async listEvents(from: string, to: string) {
    return [...this.events.values()].filter((event) => event.startAt >= from && event.startAt <= to);
  }

  async upsertEvent(event: ScheduledEvent) {
    this.events.set(event.id, event);
  }

  async deleteEvent(id: string) {
    this.events.delete(id);
  }

  async export() {
    const payload: ExportShape = {
      fleets: await this.listFleets(),
      customTles: await this.listCustomTLEs(),
      opsStatuses: [...this.opsStatuses.values()],
      anomalies: [...this.anomalies.values()],
      groundStations: await this.listGroundStations(),
      events: [...this.events.values()],
      schemaVersion: 1,
    };
    return JSON.stringify(payload, null, 2);
  }

  async import(json: string, mode: 'merge' | 'replace') {
    const payload = JSON.parse(json) as Partial<ExportShape>;
    if (mode === 'replace') {
      this.fleets.clear();
      this.customTles.clear();
      this.opsStatuses.clear();
      this.anomalies.clear();
      this.groundStations.clear();
      this.events.clear();
    }

    let imported = 0;
    const errors: string[] = [];
    for (const fleet of payload.fleets ?? []) {
      this.fleets.set(fleet.id, fleet);
      imported += 1;
    }
    for (const tle of payload.customTles ?? []) {
      this.customTles.set(tle.id, tle);
      imported += 1;
    }
    for (const status of payload.opsStatuses ?? []) {
      this.opsStatuses.set(status.id, status);
      imported += 1;
    }
    for (const anomaly of payload.anomalies ?? []) {
      this.anomalies.set(anomaly.id, anomaly);
      imported += 1;
    }
    for (const station of payload.groundStations ?? []) {
      this.groundStations.set(station.id, station);
      imported += 1;
    }
    for (const event of payload.events ?? []) {
      this.events.set(event.id, event);
      imported += 1;
    }

    return { imported, rejected: errors.length, errors };
  }

  async getSchemaVersion() {
    return 1;
  }

  async migrate() {}
}

function matchesRef(left: FleetMemberRef, right: FleetMemberRef) {
  if (left.refType !== right.refType) return false;
  if (left.refType === 'catalog') return left.catalogNumber === right.catalogNumber;
  return left.customTleId === right.customTleId;
}
