import {
  findVisibleSatellites,
  type VisibleSatellitesWorkerInput,
  type VisibleSatellitesWorkerResult,
} from '@/lib/visibleSatellites';

self.onmessage = (event: MessageEvent<VisibleSatellitesWorkerInput>) => {
  const visible = findVisibleSatellites(event.data);
  self.postMessage({ visible, requestId: event.data.requestId } satisfies VisibleSatellitesWorkerResult);
};
