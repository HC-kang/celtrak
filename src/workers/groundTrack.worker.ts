import {
  buildGroundTrackEphemeris,
  type GroundTrackBuildInput,
  type GroundTrackWorkerResult,
} from '@/lib/orbitGroundTrack';

self.onmessage = (event: MessageEvent<GroundTrackBuildInput>) => {
  const result = buildGroundTrackEphemeris(event.data);
  self.postMessage(result satisfies GroundTrackWorkerResult);
};
