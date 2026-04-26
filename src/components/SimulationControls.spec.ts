import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import SimulationControls from './SimulationControls.vue';

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper.findAll('button').find((item) => item.text() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

describe('SimulationControls', () => {
  it('emits explicit live orbit control actions', async () => {
    const wrapper = mount(SimulationControls, {
      props: {
        livePlaybackRate: 1,
        orbitTimeIso: '2026-04-24T05:00:00.000Z',
        simulationTimeIso: null,
      },
    });

    await buttonByText(wrapper, '-12h').trigger('click');
    await buttonByText(wrapper, '-30m').trigger('click');
    await buttonByText(wrapper, '+1h').trigger('click');
    await buttonByText(wrapper, '+3h').trigger('click');
    await wrapper.find('input[type="range"]').setValue('20');
    await wrapper.find('input[type="range"]').setValue('300');
    await buttonByText(wrapper, 'Live').trigger('click');

    expect(wrapper.emitted('shift')).toEqual([[-12], [-0.5], [1], [3]]);
    expect(wrapper.emitted('set-playback-rate')).toEqual([[20], [300]]);
    expect(wrapper.emitted('reset-live')).toEqual([[]]);
  });

  it('keeps the live orbit time visible in the datetime input', () => {
    const wrapper = mount(SimulationControls, {
      props: {
        livePlaybackRate: 1,
        orbitTimeIso: '2026-04-24T05:07:00.000Z',
        simulationTimeIso: null,
      },
    });

    const input = wrapper.find('input').element as HTMLInputElement;

    expect(input.value).not.toBe('');
  });

  it('shows simulation mode when a simulation time is active', () => {
    const wrapper = mount(SimulationControls, {
      props: {
        livePlaybackRate: 1,
        orbitTimeIso: '2026-04-24T05:00:00.000Z',
        simulationTimeIso: '2026-04-24T06:00:00.000Z',
      },
    });

    expect(wrapper.text()).toContain('Simulation orbit');
    expect(wrapper.text()).toContain('Speed');
    expect((wrapper.find('input[type="range"]').element as HTMLInputElement).disabled).toBe(false);
  });

  it('connects kebab-case event listeners through a parent component', async () => {
    const Harness = defineComponent({
      components: { SimulationControls },
      setup() {
        const simulationTimeIso = ref('2026-04-24T06:00:00.000Z');
        const livePlaybackRate = ref(1);
        return {
          simulationTimeIso,
          livePlaybackRate,
          resetLive: () => {
            simulationTimeIso.value = null;
          },
          setPlaybackRate: (rate: number) => {
            livePlaybackRate.value = rate;
          },
        };
      },
      template: `
        <SimulationControls
          :live-playback-rate="livePlaybackRate"
          orbit-time-iso="2026-04-24T05:00:00.000Z"
          :simulation-time-iso="simulationTimeIso"
          @reset-live="resetLive"
          @set-playback-rate="setPlaybackRate"
        />
      `,
    });

    const wrapper = mount(Harness);

    expect(wrapper.text()).toContain('Simulation orbit');
    await buttonByText(wrapper, 'Live').trigger('click');
    expect(wrapper.text()).toContain('Live orbit');

    await wrapper.find('input[type="range"]').setValue('300');
    expect(wrapper.text()).toContain('300x');
  });

  it('toggles playback direction without changing speed magnitude', async () => {
    const wrapper = mount(SimulationControls, {
      props: {
        livePlaybackRate: 20,
        orbitTimeIso: '2026-04-24T05:00:00.000Z',
        simulationTimeIso: null,
      },
    });

    await wrapper.get('button[aria-label="재생 방향"]').trigger('click');
    await wrapper.setProps({ livePlaybackRate: -20 });
    await wrapper.find('input[type="range"]').setValue('30');
    await wrapper.get('button[aria-label="재생 방향"]').trigger('click');

    expect(wrapper.emitted('set-playback-rate')).toEqual([[-20], [-30], [20]]);
  });
});
