import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { usePwaInstallPrompt } from '@/composables/usePwaInstallPrompt';

const Harness = defineComponent({
  setup() {
    return usePwaInstallPrompt();
  },
  template: '<button v-if="canInstall" type="button" @click="install">Install app</button>',
});

describe('usePwaInstallPrompt', () => {
  it('keeps the CTA hidden until the browser exposes an install prompt', async () => {
    const wrapper = mount(Harness);

    expect(wrapper.find('button').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows the CTA only after beforeinstallprompt and consumes the prompt from a click', async () => {
    const wrapper = mount(Harness);
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = createBeforeInstallPromptEvent(prompt, 'accepted');

    window.dispatchEvent(event);
    await wrapper.vm.$nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(wrapper.find('button').exists()).toBe(true);

    await wrapper.find('button').trigger('click');
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(wrapper.find('button').exists()).toBe(false);
    wrapper.unmount();
  });

  it('does not show the CTA when running in standalone display mode', async () => {
    const restoreMatchMedia = stubStandaloneDisplayMode(true);
    const wrapper = mount(Harness);
    const prompt = vi.fn().mockResolvedValue(undefined);

    window.dispatchEvent(createBeforeInstallPromptEvent(prompt, 'accepted'));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('button').exists()).toBe(false);
    expect(prompt).not.toHaveBeenCalled();

    wrapper.unmount();
    restoreMatchMedia();
  });
});

function createBeforeInstallPromptEvent(prompt: () => Promise<void>, outcome: 'accepted' | 'dismissed') {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  Object.defineProperty(event, 'prompt', { value: prompt });
  Object.defineProperty(event, 'userChoice', { value: Promise.resolve({ outcome }) });
  return event;
}

function stubStandaloneDisplayMode(matches: boolean) {
  const original = window.matchMedia;
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  return () => {
    window.matchMedia = original;
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}
