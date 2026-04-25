import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { CatalogEntry, GroundStation, LiveContactLink } from '@/domain/types';
import OrbitMap2D from './OrbitMap2D.vue';

const station: GroundStation = {
  id: 'gs-seoul',
  name: 'Seoul Ops',
  latDeg: 37.5665,
  lonDeg: 126.978,
  altitudeM: 38,
  elevationMaskDeg: 10,
  enabled: true,
  schemaVersion: 1,
};

const satelliteEntry: CatalogEntry = {
  origin: 'OSINT',
  group: 'Tracked',
  fetchedAt: '2026-04-25T00:00:00.000Z',
  satcat: {
    catalogNumber: 25544,
    objectId: '1998-067A',
    objectName: 'ISS (ZARYA)',
    objectType: 'PAYLOAD',
    opsStatusCode: 'ACTIVE',
    ownerCountry: 'ISS',
    fetchedAt: '2026-04-25T00:00:00.000Z',
  },
  tle: {
    format: 'TLE',
    line1: '1 25544U 98067A   24110.55260417  .00016717  00000+0  10270-3 0  9996',
    line2: '2 25544  51.6415 162.1898 0004620 250.2941 232.6818 15.50376377446559',
  },
};

const contactLink: LiveContactLink = {
  satelliteRef: { refType: 'catalog', catalogNumber: 25544, displayName: 'ISS', tags: [] },
  satelliteId: 'catalog:25544',
  satelliteName: 'ISS',
  groundStationId: 'gs-seoul',
  groundStationName: 'Seoul Ops',
  elevationDeg: 24,
  azimuthDeg: 132,
  status: 'IN_CONTACT',
  countdownSeconds: 300,
};

describe('OrbitMap2D', () => {
  it('updates the night mask when orbit time changes', async () => {
    const wrapper = mount(OrbitMap2D, {
      props: {
        satellites: [satelliteEntry],
        groundStations: [station],
        contactLinks: [],
        orbitMode: 'live',
        orbitTimeIso: '2026-04-25T00:00:00.000Z',
      },
    });

    const initialPath = wrapper.find('.orbit-map__night-mask').attributes('d');
    expect(initialPath?.length).toBeGreaterThan(1000);
    expect(wrapper.find('.orbit-map__night-mask').attributes('fill-rule')).toBeUndefined();
    await wrapper.setProps({ orbitTimeIso: '2026-04-25T06:00:00.000Z' });

    expect(wrapper.find('.orbit-map__night-mask').attributes('d')).not.toBe(initialPath);
  });

  it('emits focus events and renders active contact links', async () => {
    const wrapper = mount(OrbitMap2D, {
      props: {
        satellites: [satelliteEntry],
        groundStations: [station],
        contactLinks: [contactLink],
        focusedTarget: { type: 'satellite', id: 'catalog:25544' },
        orbitMode: 'live',
        orbitTimeIso: '2026-04-25T00:00:00.000Z',
      },
    });

    expect(wrapper.find('.orbit-map__contact-link').exists()).toBe(true);
    await wrapper.find('.orbit-map__station').trigger('click');
    expect(wrapper.emitted('focus-target')?.[0]).toEqual([{ type: 'groundStation', id: 'gs-seoul' }]);
    await wrapper.find('.orbit-map__track').trigger('click');
    expect(wrapper.emitted('focus-target')?.[1]).toEqual([{ type: 'satellite', id: 'catalog:25544' }]);
  });
});
