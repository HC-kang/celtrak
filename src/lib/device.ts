export type BreakpointName = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export function getBreakpoint(width: number): BreakpointName {
  if (width < 480) return 'xs';
  if (width < 768) return 'sm';
  if (width < 1024) return 'md';
  if (width < 1440) return 'lg';
  return 'xl';
}

export function getPreferredRenderMode(width: number) {
  if (width < 768) return '2d';
  if (width < 1024) return '2d';
  return '3d';
}
