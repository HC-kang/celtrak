import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('includes satellite label rectangles in map hit testing', async () => {
    const wrapper = mount(OrbitMap2D, {
      props: {
        satellites: [satelliteEntry],
        groundStations: [station],
        contactLinks: [],
        orbitMode: 'live',
        orbitTimeIso: '2026-04-25T00:00:00.000Z',
      },
    });
    const svg = wrapper.find('svg').element as SVGSVGElement & {
      setPointerCapture: (pointerId: number) => void;
      hasPointerCapture: (pointerId: number) => boolean;
      releasePointerCapture: (pointerId: number) => void;
    };
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1024, height: 1024, right: 1024, bottom: 1024, x: 0, y: 0, toJSON: () => ({}) });
    svg.setPointerCapture = vi.fn();
    svg.hasPointerCapture = vi.fn(() => true);
    svg.releasePointerCapture = vi.fn();

    const transform = wrapper.find('.orbit-map__satellite-label').attributes('transform') ?? '';
    const [, labelX, labelY] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(transform) ?? [];
    expect(labelX).toBeTruthy();

    await wrapper.find('svg').trigger('pointerdown', {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: Number(labelX) + 20,
      clientY: Number(labelY) + 16,
    });
    await wrapper.find('svg').trigger('pointerup', {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: Number(labelX) + 20,
      clientY: Number(labelY) + 16,
    });

    expect(wrapper.emitted('focus-target')?.[0]).toEqual([{ type: 'satellite', id: 'catalog:25544' }]);
  });

  it('centers focused ground stations and keeps horizontal panning unbounded', async () => {
    vi.useFakeTimers();
    const wrapper = mount(OrbitMap2D, {
      props: {
        satellites: [satelliteEntry],
        groundStations: [station],
        contactLinks: [],
        orbitMode: 'live',
        orbitTimeIso: '2026-04-25T00:00:00.000Z',
      },
    });
    const svg = wrapper.find('svg').element as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1024, height: 1024, right: 1024, bottom: 1024, x: 0, y: 0, toJSON: () => ({}) });

    await wrapper.setProps({ focusedTarget: { type: 'groundStation', id: station.id } });

    const stationPoint = projectMapPoint(station.lonDeg, station.latDeg);
    const immediateViewBox = parseViewBox(wrapper.find('svg').attributes('viewBox') ?? '');
    expect(immediateViewBox.x + immediateViewBox.width / 2).not.toBeCloseTo(stationPoint.x, 1);

    await vi.advanceTimersByTimeAsync(700);
    await nextTick();

    const focusedViewBox = parseViewBox(wrapper.find('svg').attributes('viewBox') ?? '');
    expect(focusedViewBox.x + focusedViewBox.width / 2).toBeCloseTo(stationPoint.x, 1);
    expect(focusedViewBox.y + focusedViewBox.height / 2).toBeCloseTo(stationPoint.y, 1);

    await wrapper.find('svg').trigger('wheel', {
      shiftKey: true,
      deltaY: 9000,
      deltaX: 0,
      clientX: 512,
      clientY: 512,
    });

    const pannedViewBox = parseViewBox(wrapper.find('svg').attributes('viewBox') ?? '');
    expect(pannedViewBox.x).toBeGreaterThan(1024);
    expect(wrapper.findAll('.orbit-map__world-copy').length).toBeGreaterThan(1);
  });
});

function parseViewBox(value: string) {
  const [x, y, width, height] = value.split(/\s+/).map(Number);
  return { x, y, width, height };
}

function projectMapPoint(lon: number, lat: number) {
  const mapSize = 256 * 2 ** 2;
  const clampedLat = Math.min(Math.max(lat, -85.05112878), 85.05112878);
  const sinLat = Math.sin((clampedLat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * mapSize,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * mapSize,
  };
}
