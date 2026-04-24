import { predictPasses, type PassPredictionInput } from '@/lib/passPrediction';

self.onmessage = (event: MessageEvent<PassPredictionInput>) => {
  const result = predictPasses(event.data);
  self.postMessage(result);
};
