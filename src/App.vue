<script setup lang="ts">
import { onMounted } from 'vue';
import AppShell from '@/components/AppShell.vue';
import { useAppStore } from '@/stores/app';
import { useViewport } from '@/composables/useViewport';

const store = useAppStore();
const viewport = useViewport();

onMounted(async () => {
  await store.bootstrap();
  store.applyAutomaticPreferences(viewport.width.value);

  window.addEventListener('online', () => store.setOfflineState(false));
  window.addEventListener('offline', () => store.setOfflineState(true));

  window.addEventListener('orbit-lab:update-available', ((event: CustomEvent<{ apply: () => Promise<void> }>) => {
    store.setUpdateHandler(event.detail.apply);
  }) as EventListener);
});
</script>

<template>
  <AppShell>
    <RouterView />
  </AppShell>
</template>
