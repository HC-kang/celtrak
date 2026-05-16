<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    message: string;
    detail?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'default' | 'danger';
  }>(),
  {
    confirmLabel: '확인',
    cancelLabel: '취소',
    tone: 'default',
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [];
  cancel: [];
}>();

const cancelButton = ref<HTMLButtonElement | null>(null);
const previouslyFocused = ref<HTMLElement | null>(null);
const titleId = `confirm-dialog-title-${Math.random().toString(36).slice(2)}`;
const messageId = `confirm-dialog-message-${Math.random().toString(36).slice(2)}`;
const panelClass = computed(() => ({
  'confirm-dialog__panel--danger': props.tone === 'danger',
}));

watch(
  () => props.modelValue,
  async (isOpen) => {
    if (isOpen) {
      previouslyFocused.value = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
      await nextTick();
      cancelButton.value?.focus();
    } else {
      previouslyFocused.value?.focus?.();
      previouslyFocused.value = null;
    }
  },
);

function close() {
  emit('update:modelValue', false);
  emit('cancel');
}

function confirm() {
  emit('confirm');
  emit('update:modelValue', false);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="confirm-dialog-fade">
      <div v-if="modelValue" class="confirm-dialog" @keydown.esc.stop.prevent="close()">
        <button class="confirm-dialog__backdrop" type="button" aria-label="닫기" @click="close()" />
        <section
          class="confirm-dialog__panel"
          :class="panelClass"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          :aria-describedby="messageId"
        >
          <div class="confirm-dialog__header">
            <p class="eyebrow">{{ tone === 'danger' ? 'Destructive action' : 'Confirm action' }}</p>
            <h2 :id="titleId">{{ title }}</h2>
          </div>
          <p :id="messageId" class="confirm-dialog__message">{{ message }}</p>
          <p v-if="detail" class="confirm-dialog__detail">{{ detail }}</p>
          <div class="confirm-dialog__actions">
            <button ref="cancelButton" class="button button--ghost" type="button" @click="close()">
              {{ cancelLabel }}
            </button>
            <button class="button" :class="{ 'button--danger': tone === 'danger' }" type="button" @click="confirm()">
              {{ confirmLabel }}
            </button>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
