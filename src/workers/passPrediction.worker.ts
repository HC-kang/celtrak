import { predictPasses, predictPriorityPasses, type PassPredictionInput, type PassPredictionWorkerResult } from '@/lib/passPrediction';

self.onmessage = (event: MessageEvent<PassPredictionInput>) => {
  const priorityResult = predictPriorityPasses(event.data);
  if (priorityResult.length) {
    self.postMessage({ predictions: priorityResult, partial: true, requestId: event.data.requestId } satisfies PassPredictionWorkerResult);
  }

  const result = predictPasses(event.data);
  self.postMessage({ predictions: result, requestId: event.data.requestId } satisfies PassPredictionWorkerResult);
};
