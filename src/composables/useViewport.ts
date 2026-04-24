import { computed, onMounted, onUnmounted, ref } from 'vue';
import { getBreakpoint } from '@/lib/device';

export function useViewport() {
  const width = ref(typeof window !== 'undefined' ? window.innerWidth : 1440);
  const height = ref(typeof window !== 'undefined' ? window.innerHeight : 900);

  const onResize = () => {
    width.value = window.innerWidth;
    height.value = window.innerHeight;
  };

  onMounted(() => {
    window.addEventListener('resize', onResize);
  });

  onUnmounted(() => {
    window.removeEventListener('resize', onResize);
  });

  return {
    width,
    height,
    breakpoint: computed(() => getBreakpoint(width.value)),
  };
}
