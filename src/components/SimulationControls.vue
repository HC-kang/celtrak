<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  livePlaybackRate: number;
  orbitTimeIso: string;
  simulationTimeIso: string | null;
}>();

const emit = defineEmits<{
  'set-orbit-time': [value: string | null];
  'set-playback-rate': [value: number];
  shift: [hours: number];
  'reset-live': [];
}>();

const shiftControls = [-12, -6, -3, -1, -0.5, 0.5, 1, 3, 6, 12];
const minPlaybackRate = 1;
const maxPlaybackRate = 300;

const inputValue = ref('');
const isEditingTime = ref(false);

watch(
  () => [props.simulationTimeIso, props.orbitTimeIso] as const,
  () => {
    if (!isEditingTime.value) {
      syncInputValue();
    }
  },
  { immediate: true },
);

const isLive = computed(() => !props.simulationTimeIso);
const orbitTimestamp = computed(() => formatTimestampWithSeconds(props.orbitTimeIso));
const isRewinding = computed(() => props.livePlaybackRate < 0);
const playbackSpeed = computed(() => clampPlaybackSpeed(props.livePlaybackRate));
const speedProgress = computed(
  () => `${((playbackSpeed.value - minPlaybackRate) / (maxPlaybackRate - minPlaybackRate)) * 100}%`,
);

function submitInput() {
  if (!inputValue.value) {
    isEditingTime.value = false;
    emit('reset-live');
    return;
  }
  isEditingTime.value = false;
  emit('set-orbit-time', new Date(inputValue.value).toISOString());
}

function resetLive() {
  isEditingTime.value = false;
  emit('reset-live');
}

function releaseInput() {
  window.setTimeout(() => {
    isEditingTime.value = false;
    syncInputValue();
  }, 120);
}

function syncInputValue() {
  inputValue.value = toDateTimeLocal(props.orbitTimeIso);
}

function formatShiftLabel(hours: number) {
  const sign = hours > 0 ? '+' : '-';
  const absoluteHours = Math.abs(hours);
  if (absoluteHours < 1) return `${sign}${absoluteHours * 60}m`;
  return `${sign}${absoluteHours}h`;
}

function toDateTimeLocal(iso: string) {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTimestampWithSeconds(iso: string) {
  const date = new Date(iso);
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function setPlaybackRateFromInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const nextRate = clampPlaybackSpeed(input.value);
  emit('set-playback-rate', isRewinding.value ? -nextRate : nextRate);
}

function togglePlaybackDirection() {
  emit('set-playback-rate', isRewinding.value ? playbackSpeed.value : -playbackSpeed.value);
}

function clampPlaybackSpeed(value: unknown) {
  const numericValue = Math.round(Math.abs(Number(value)));
  if (!Number.isFinite(numericValue)) return minPlaybackRate;
  return Math.min(Math.max(numericValue, minPlaybackRate), maxPlaybackRate);
}
</script>

<template>
  <div class="simulation-controls">
    <div class="simulation-controls__summary">
      <strong>{{ isLive ? 'Live orbit' : 'Simulation orbit' }}</strong>
      <small>{{ orbitTimestamp }} · {{ isRewinding ? '-' : '' }}{{ playbackSpeed }}x</small>
    </div>
    <div class="simulation-controls__row">
      <span class="simulation-controls__label">Orbit time</span>
      <div class="simulation-controls__picker">
        <input
          v-model="inputValue"
          class="input"
          type="datetime-local"
          step="60"
          @focus="isEditingTime = true"
          @input="isEditingTime = true"
          @blur="releaseInput()"
        />
        <button class="button" type="button" @click.prevent="submitInput()">적용</button>
        <button class="button button--ghost" :class="{ 'button--selected': isLive }" type="button" @click.prevent="resetLive()">Live</button>
      </div>
    </div>
    <div class="simulation-controls__row">
      <span class="simulation-controls__label">Time jump</span>
      <div class="simulation-controls__buttons">
        <button v-for="hours in shiftControls" :key="hours" class="button button--ghost" type="button" @click.prevent="emit('shift', hours)">
          {{ formatShiftLabel(hours) }}
        </button>
      </div>
    </div>
    <div class="simulation-controls__row">
      <span class="simulation-controls__label">Speed</span>
      <div class="simulation-controls__speed" aria-label="Playback speed">
        <button
          class="simulation-controls__rewind"
          :class="{ 'simulation-controls__rewind--active': isRewinding }"
          type="button"
          :aria-pressed="isRewinding"
          aria-label="재생 방향"
          :title="isRewinding ? '되감기' : '정방향'"
          @click.prevent="togglePlaybackDirection"
        >
          <span class="simulation-controls__rewind-icon" aria-hidden="true"></span>
        </button>
        <input
          class="simulation-controls__speed-slider"
          type="range"
          :min="minPlaybackRate"
          :max="maxPlaybackRate"
          step="1"
          :value="playbackSpeed"
          :style="{ '--speed-progress': speedProgress }"
          aria-label="Playback speed"
          @input="setPlaybackRateFromInput"
        />
        <output class="simulation-controls__speed-output">{{ isRewinding ? '-' : '' }}{{ playbackSpeed }}x</output>
        <div class="simulation-controls__speed-scale" aria-hidden="true">
          <span>{{ minPlaybackRate }}x</span>
          <span>{{ maxPlaybackRate }}x</span>
        </div>
      </div>
    </div>
  </div>
</template>
