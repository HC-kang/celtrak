import type { DataOrigin } from '@/domain/types';

export interface OriginBadgeMeta {
  label: DataOrigin;
  icon: string;
  className: string;
  tooltip: string;
}

export function getOriginBadge(origin: DataOrigin): OriginBadgeMeta {
  switch (origin) {
    case 'OSINT':
      return { label: origin, icon: '◎', className: 'origin-osint', tooltip: 'Public-source OSINT data routed through Celtrak cache and freshness checks.' };
    case 'DERIVED':
      return { label: origin, icon: '◌', className: 'origin-derived', tooltip: 'Computed by Celtrak from orbital elements; not an operator booking or official notice.' };
    case 'USER':
      return { label: origin, icon: '◆', className: 'origin-user', tooltip: 'User-entered or local workspace data; not externally verified by Celtrak.' };
    case 'STALE':
    default:
      return { label: 'STALE', icon: '◔', className: 'origin-stale', tooltip: 'Source data is older than expected or served from fallback cache.' };
  }
}
