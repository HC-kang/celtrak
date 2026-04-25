import { beforeEach, describe, expect, it } from 'vitest';
import { defaultPreferences, loadPreferences, savePreferences } from './prefs';

describe('preferences', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('persists the selected fleet id with UI preferences', () => {
    savePreferences({ ...defaultPreferences, selectedFleetId: 'fleet-visible-ops' });

    expect(loadPreferences().selectedFleetId).toBe('fleet-visible-ops');
  });
});
