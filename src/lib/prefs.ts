import type { UserPreferences } from '@/domain/types';

const PREFS_KEY = 'orbit-lab:prefs';
const DESKTOP_2D_MIGRATION_KEY = 'orbit-lab:prefs:desktop-2d-default-migrated';

export const defaultPreferences: UserPreferences = {
  theme: 'system',
  language: 'ko',
  units: { distance: 'km', speed: 'km/s' },
  mobileRenderMode: '2d',
  tabletRenderMode: '2d',
  desktopRenderMode: '2d',
  hiddenTrackedRefs: [],
  reducedMotion: false,
  dataSaver: false,
  schemaVersion: 1,
};

export function loadPreferences() {
  if (typeof window === 'undefined') return defaultPreferences;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return defaultPreferences;
    const parsed = JSON.parse(raw) as Partial<UserPreferences>;
    const preferences = { ...defaultPreferences, ...parsed } as UserPreferences;
    if (!window.localStorage.getItem(DESKTOP_2D_MIGRATION_KEY) && parsed.desktopRenderMode === '3d') {
      preferences.desktopRenderMode = '2d';
      window.localStorage.setItem(DESKTOP_2D_MIGRATION_KEY, '1');
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(preferences));
    }
    return preferences;
  } catch {
    return defaultPreferences;
  }
}

export function savePreferences(preferences: UserPreferences) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(PREFS_KEY, JSON.stringify(preferences));
}
