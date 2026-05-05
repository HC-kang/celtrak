<script setup lang="ts">
defineProps<{
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'good' | 'warn' | 'orange' | 'critical';
}>();
</script>

<template>
  <article class="metric-card" :class="`metric-card--${tone ?? 'default'}`">
    <p>{{ label }}</p>
    <strong>{{ value }}</strong>
    <small>{{ hint }}</small>
  </article>
</template>
