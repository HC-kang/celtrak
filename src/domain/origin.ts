import type { DataOrigin } from '@/domain/types';

export interface OriginBadgeMeta {
  label: DataOrigin;
  icon: string;
  className: string;
}

export function getOriginBadge(origin: DataOrigin): OriginBadgeMeta {
  switch (origin) {
    case 'OSINT':
      return { label: origin, icon: '◎', className: 'origin-osint' };
    case 'DERIVED':
      return { label: origin, icon: '◌', className: 'origin-derived' };
    case 'USER':
      return { label: origin, icon: '◆', className: 'origin-user' };
    case 'STALE':
    default:
      return { label: 'STALE', icon: '◔', className: 'origin-stale' };
  }
}
