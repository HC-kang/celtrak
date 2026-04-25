import { refineContactCountdowns, type ContactPrecisionRequest, type ContactPrecisionWorkerResult } from '@/lib/contactPrecision';

self.onmessage = (event: MessageEvent<ContactPrecisionRequest>) => {
  self.postMessage({
    requestId: event.data.requestId,
    results: refineContactCountdowns({
      timestampIso: event.data.timestampIso,
      candidates: event.data.candidates,
    }),
  } satisfies ContactPrecisionWorkerResult);
};
