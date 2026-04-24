import { IndexedDBFleetStore } from '@/services/store/indexedDbFleetStore';
import { InMemoryFleetStore } from '@/services/store/inMemoryFleetStore';
import type { FleetStore } from '@/services/store/fleetStore';

export function createFleetStore(): FleetStore {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return new InMemoryFleetStore();
  }
  return new IndexedDBFleetStore();
}
