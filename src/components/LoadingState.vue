<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    message?: string;
    variant?: 'global' | 'inline';
  }>(),
  {
    message: '',
    variant: 'inline',
  },
);
</script>

<template>
  <section class="loading-state" :class="`loading-state--${variant}`" role="status" aria-live="polite" aria-atomic="true">
    <span class="loading-state__spinner" aria-hidden="true"></span>
    <div class="loading-state__content">
      <p class="eyebrow">Data Sync</p>
      <strong>{{ title }}</strong>
      <span v-if="message">{{ message }}</span>
    </div>
    <div class="loading-state__bar" aria-hidden="true">
      <span></span>
    </div>
  </section>
</template>
