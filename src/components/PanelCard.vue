<script setup lang="ts">
defineProps<{
  title: string;
  subtitle?: string;
  collapsible?: boolean;
}>();
</script>

<template>
  <section class="panel-card">
    <header class="panel-card__header">
      <div>
        <p class="eyebrow">{{ subtitle }}</p>
        <h2>{{ title }}</h2>
      </div>
      <div class="panel-card__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="panel-card__body">
      <slot />
    </div>
  </section>
</template>
