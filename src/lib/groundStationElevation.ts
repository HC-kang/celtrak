import type { ElevationMaskSourceConfidence, GroundStation, GroundStationElevationMaskSource } from '@/domain/types';

const SOURCE_LABELS: Record<ElevationMaskSourceConfidence, string> = {
  verified: '검증',
  inferred: '추정',
  default: '기본',
  user: '사용자',
};

export function elevationMaskSourceLabel(source: GroundStationElevationMaskSource | undefined) {
  return SOURCE_LABELS[source?.confidence ?? 'default'];
}

export function elevationMaskSourceDetail(source: GroundStationElevationMaskSource | undefined) {
  return source?.label ?? 'App default elevation mask';
}

export function createUserElevationMaskSource(): GroundStationElevationMaskSource {
  return {
    confidence: 'user',
    label: 'User override',
    note: 'Manual elevation mask value edited in the local workspace.',
    updatedAt: new Date().toISOString(),
  };
}

export function withUserElevationMaskSource<T extends GroundStation>(station: T): T {
  return {
    ...station,
    elevationMaskSource: createUserElevationMaskSource(),
  };
}
