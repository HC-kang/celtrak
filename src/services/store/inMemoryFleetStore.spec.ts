import { describe, expect, it } from 'vitest';
import { InMemoryFleetStore } from '@/services/store/inMemoryFleetStore';

describe('InMemoryFleetStore', () => {
  it('stores fleets and exports workspace data', async () => {
    const store = new InMemoryFleetStore();

    await store.upsertFleet({
      id: 'fleet-1',
      name: 'Alpha',
      description: 'Test fleet',
      memberRefs: [{ refType: 'catalog', catalogNumber: 25544, tags: ['crew'] }],
      createdAt: '2026-04-23T00:00:00.000Z',
      updatedAt: '2026-04-23T00:00:00.000Z',
      schemaVersion: 1,
    });

    const fleets = await store.listFleets();
    const exported = JSON.parse(await store.export());

    expect(fleets).toHaveLength(1);
    expect(exported.fleets[0].name).toBe('Alpha');
    expect(exported.schemaVersion).toBe(1);
  });

  it('filters ops status by member reference', async () => {
    const store = new InMemoryFleetStore();

    await store.appendOpsStatus({
      id: 'status-1',
      satelliteRef: { refType: 'catalog', catalogNumber: 25544, tags: [] },
      recordedAt: '2026-04-23T00:00:00.000Z',
      mcStatus: 'FMC',
      rfStatus: 'NOMINAL',
      schemaVersion: 1,
    });
    await store.appendOpsStatus({
      id: 'status-2',
      satelliteRef: { refType: 'catalog', catalogNumber: 33591, tags: [] },
      recordedAt: '2026-04-23T01:00:00.000Z',
      mcStatus: 'PMC',
      rfStatus: 'DEGRADED',
      schemaVersion: 1,
    });

    const statuses = await store.listOpsStatus({ refType: 'catalog', catalogNumber: 25544, tags: [] }, 30);

    expect(statuses).toHaveLength(1);
    expect(statuses[0].mcStatus).toBe('FMC');
  });

  it('stores and deletes scheduled events', async () => {
    const store = new InMemoryFleetStore();

    await store.upsertEvent({
      id: 'event-1',
      title: 'Maintenance',
      kind: 'MAINTENANCE',
      startAt: '2026-04-23T10:00:00.000Z',
      endAt: '2026-04-23T11:00:00.000Z',
      schemaVersion: 1,
    });

    let events = await store.listEvents('2026-04-23T00:00:00.000Z', '2026-04-24T00:00:00.000Z');
    expect(events).toHaveLength(1);

    await store.deleteEvent('event-1');
    events = await store.listEvents('2026-04-23T00:00:00.000Z', '2026-04-24T00:00:00.000Z');
    expect(events).toHaveLength(0);
  });
});
