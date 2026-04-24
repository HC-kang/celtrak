import { openDB } from 'idb';
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
import { InMemoryFleetStore } from '@/services/store/inMemoryFleetStore';

const DB_NAME = 'orbit-lab';
const DB_VERSION = 2;
const DB_OPERATION_TIMEOUT_MS = 1500;

export class IndexedDBFleetStore implements FleetStore {
  private readonly fallback = new InMemoryFleetStore();
  private useFallback = false;

  private dbPromise = openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const stores = [
        'fleets',
        'customTles',
        'opsStatuses',
        'anomalies',
        'groundStations',
        'events',
      ];
      for (const storeName of stores) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'id' });
        }
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta');
      }
    },
  });

  async listFleets() {
    return this.run(
      'listFleets',
      async () => {
        const db = await this.dbPromise;
        const result = await db.getAll('fleets');
        return result.sort((a: UserFleet, b: UserFleet) => a.name.localeCompare(b.name));
      },
      () => this.fallback.listFleets(),
    );
  }

  async getFleet(id: string) {
    return this.run(
      'getFleet',
      async () => {
        const db = await this.dbPromise;
        return (await db.get('fleets', id)) ?? null;
      },
      () => this.fallback.getFleet(id),
    );
  }

  async upsertFleet(fleet: UserFleet) {
    await this.run(
      'upsertFleet',
      async () => {
        const db = await this.dbPromise;
        await db.put('fleets', fleet);
      },
      () => this.fallback.upsertFleet(fleet),
    );
  }

  async deleteFleet(id: string) {
    await this.run(
      'deleteFleet',
      async () => {
        const db = await this.dbPromise;
        await db.delete('fleets', id);
      },
      () => this.fallback.deleteFleet(id),
    );
  }

  async listCustomTLEs() {
    return this.run(
      'listCustomTLEs',
      async () => {
        const db = await this.dbPromise;
        return await db.getAll('customTles');
      },
      () => this.fallback.listCustomTLEs(),
    );
  }

  async upsertCustomTLE(tle: CustomTLE) {
    await this.run(
      'upsertCustomTLE',
      async () => {
        const db = await this.dbPromise;
        await db.put('customTles', tle);
      },
      () => this.fallback.upsertCustomTLE(tle),
    );
  }

  async deleteCustomTLE(id: string) {
    await this.run(
      'deleteCustomTLE',
      async () => {
        const db = await this.dbPromise;
        await db.delete('customTles', id);
      },
      () => this.fallback.deleteCustomTLE(id),
    );
  }

  async listOpsStatus(ref: FleetMemberRef, limit: number) {
    return this.run(
      'listOpsStatus',
      async () => {
        const db = await this.dbPromise;
        const statuses = (await db.getAll('opsStatuses')) as OperationalStatus[];
        return statuses
          .filter((status) => matchesRef(status.satelliteRef, ref))
          .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
          .slice(0, limit);
      },
      () => this.fallback.listOpsStatus(ref, limit),
    );
  }

  async appendOpsStatus(status: OperationalStatus) {
    await this.run(
      'appendOpsStatus',
      async () => {
        const db = await this.dbPromise;
        await db.put('opsStatuses', status);
      },
      () => this.fallback.appendOpsStatus(status),
    );
  }

  async listAnomalies(filter: AnomalyFilter) {
    return this.run(
      'listAnomalies',
      async () => {
        const db = await this.dbPromise;
        const anomalies = (await db.getAll('anomalies')) as AnomalyEntry[];
        return anomalies
          .filter((anomaly) => !filter.satelliteRef || matchesRef(anomaly.satelliteRef, filter.satelliteRef))
          .filter((anomaly) => !filter.openOnly || !anomaly.closedAt)
          .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
      },
      () => this.fallback.listAnomalies(filter),
    );
  }

  async upsertAnomaly(anomaly: AnomalyEntry) {
    await this.run(
      'upsertAnomaly',
      async () => {
        const db = await this.dbPromise;
        await db.put('anomalies', anomaly);
      },
      () => this.fallback.upsertAnomaly(anomaly),
    );
  }

  async listGroundStations() {
    return this.run(
      'listGroundStations',
      async () => {
        const db = await this.dbPromise;
        const stations = (await db.getAll('groundStations')) as GroundStation[];
        return stations.sort((a, b) => a.name.localeCompare(b.name));
      },
      () => this.fallback.listGroundStations(),
    );
  }

  async upsertGroundStation(station: GroundStation) {
    await this.run(
      'upsertGroundStation',
      async () => {
        const db = await this.dbPromise;
        await db.put('groundStations', station);
      },
      () => this.fallback.upsertGroundStation(station),
    );
  }

  async listEvents(from: string, to: string) {
    return this.run(
      'listEvents',
      async () => {
        const db = await this.dbPromise;
        const events = (await db.getAll('events')) as ScheduledEvent[];
        return events.filter((event) => event.startAt >= from && event.startAt <= to);
      },
      () => this.fallback.listEvents(from, to),
    );
  }

  async upsertEvent(event: ScheduledEvent) {
    await this.run(
      'upsertEvent',
      async () => {
        const db = await this.dbPromise;
        await db.put('events', event);
      },
      () => this.fallback.upsertEvent(event),
    );
  }

  async deleteEvent(id: string) {
    await this.run(
      'deleteEvent',
      async () => {
        const db = await this.dbPromise;
        await db.delete('events', id);
      },
      () => this.fallback.deleteEvent(id),
    );
  }

  async export() {
    return this.run(
      'export',
      async () => {
        const memoryStore = new InMemoryFleetStore();
        const db = await this.dbPromise;
        const [fleets, customTles, groundStations] = await Promise.all([
          db.getAll('fleets') as Promise<UserFleet[]>,
          db.getAll('customTles') as Promise<CustomTLE[]>,
          db.getAll('groundStations') as Promise<GroundStation[]>,
        ]);
        for (const fleet of fleets) await memoryStore.upsertFleet(fleet);
        for (const tle of customTles) await memoryStore.upsertCustomTLE(tle);
        for (const station of groundStations) await memoryStore.upsertGroundStation(station);
        for (const status of (await db.getAll('opsStatuses')) as OperationalStatus[]) {
          await memoryStore.appendOpsStatus(status);
        }
        for (const anomaly of (await db.getAll('anomalies')) as AnomalyEntry[]) {
          await memoryStore.upsertAnomaly(anomaly);
        }
        for (const event of (await db.getAll('events')) as ScheduledEvent[]) {
          await memoryStore.upsertEvent(event);
        }
        return memoryStore.export();
      },
      () => this.fallback.export(),
    );
  }

  async import(json: string, mode: 'merge' | 'replace'): Promise<ImportReport> {
    return this.run(
      'import',
      async () => {
        const memoryStore = new InMemoryFleetStore();
        const result = await memoryStore.import(json, mode);
        const payload = JSON.parse(await memoryStore.export()) as {
          fleets: UserFleet[];
          customTles: CustomTLE[];
          opsStatuses: OperationalStatus[];
          anomalies: AnomalyEntry[];
          groundStations: GroundStation[];
          events: ScheduledEvent[];
        };

        const db = await this.dbPromise;
        if (mode === 'replace') {
          await Promise.all([
            db.clear('fleets'),
            db.clear('customTles'),
            db.clear('opsStatuses'),
            db.clear('anomalies'),
            db.clear('groundStations'),
            db.clear('events'),
          ]);
        }

        for (const fleet of payload.fleets) await db.put('fleets', fleet);
        for (const tle of payload.customTles) await db.put('customTles', tle);
        for (const status of payload.opsStatuses) await db.put('opsStatuses', status);
        for (const anomaly of payload.anomalies) await db.put('anomalies', anomaly);
        for (const station of payload.groundStations) await db.put('groundStations', station);
        for (const event of payload.events) await db.put('events', event);

        return result;
      },
      () => this.fallback.import(json, mode),
    );
  }

  async getSchemaVersion() {
    return this.useFallback ? this.fallback.getSchemaVersion() : DB_VERSION;
  }

  async migrate() {}

  private async run<T>(label: string, primary: () => Promise<T>, fallback: () => Promise<T>) {
    if (this.useFallback) {
      return fallback();
    }

    try {
      return await withTimeout(primary(), DB_OPERATION_TIMEOUT_MS);
    } catch (error) {
      this.useFallback = true;
      console.warn(`IndexedDB unavailable during ${label}; using in-memory fleet store.`, error);
      return fallback();
    }
  }
}

function matchesRef(left: FleetMemberRef, right: FleetMemberRef) {
  if (left.refType !== right.refType) return false;
  if (left.refType === 'catalog') return left.catalogNumber === right.catalogNumber;
  return left.customTleId === right.customTleId;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`IndexedDB operation exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}
