<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import LoadingState from '@/components/LoadingState.vue';
import { useViewport } from '@/composables/useViewport';
import { useAppStore } from '@/stores/app';
import { formatTimestamp } from '@/lib/format';

const route = useRoute();
const viewport = useViewport();
const store = useAppStore();

const drawerOpen = ref(false);
const bottomTabsHidden = ref(false);
const lastScrollY = ref(0);
let scrollFrame: number | null = null;

const navItems = [
  { label: 'Briefing', shortLabel: 'Brief', path: '/briefing' },
  { label: 'Catalog', shortLabel: 'Catalog', path: '/catalog' },
  { label: 'Fleets', shortLabel: 'Fleets', path: '/fleets' },
  { label: 'Ground Stations', shortLabel: 'Ground', path: '/stations' },
  { label: 'Space Weather', shortLabel: 'Weather', path: '/weather' },
];

const isMobileTabs = computed(() => viewport.breakpoint.value === 'xs' || viewport.breakpoint.value === 'sm');
const usesSidebar = computed(() => viewport.breakpoint.value === 'lg' || viewport.breakpoint.value === 'xl');
const shellClass = computed(() => `app-shell--${viewport.breakpoint.value}`);
const isInitialLoading = computed(() => store.loading && !store.lastSyncedAt);

onMounted(() => {
  lastScrollY.value = currentScrollY();
  window.addEventListener('scroll', handleScroll, { passive: true });
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', handleScroll);
  if (scrollFrame !== null) {
    window.cancelAnimationFrame(scrollFrame);
  }
});

watch(
  () => [isMobileTabs.value, route.fullPath] as const,
  () => {
    drawerOpen.value = false;
    bottomTabsHidden.value = false;
    lastScrollY.value = currentScrollY();
  },
);

watch(drawerOpen, (open) => {
  if (open) {
    bottomTabsHidden.value = false;
  }
});

function currentScrollY() {
  return window.scrollY || document.documentElement.scrollTop || 0;
}

function handleScroll() {
  if (scrollFrame !== null) return;
  scrollFrame = window.requestAnimationFrame(() => {
    scrollFrame = null;
    updateBottomTabsVisibility();
  });
}

function updateBottomTabsVisibility() {
  if (!isMobileTabs.value) {
    bottomTabsHidden.value = false;
    lastScrollY.value = currentScrollY();
    return;
  }

  const nextScrollY = currentScrollY();
  const delta = nextScrollY - lastScrollY.value;
  if (Math.abs(delta) < 6) return;

  bottomTabsHidden.value = delta > 0 && nextScrollY > 96 && !drawerOpen.value;
  lastScrollY.value = nextScrollY;
}
</script>

<template>
  <div class="app-shell" :class="shellClass">
    <aside v-if="usesSidebar" class="app-shell__sidebar">
      <div class="brand">
        <p>Orbit Lab</p>
        <strong>CelesTrak Pro</strong>
      </div>
      <nav class="nav-list">
        <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-link">
          {{ item.label }}
        </RouterLink>
      </nav>
      <div class="sidebar-footnote">
        <span>{{ store.offline ? '오프라인' : '온라인' }}</span>
        <span>{{ store.preferences.dataSaver ? 'Data Saver On' : 'Normal' }}</span>
      </div>
    </aside>

    <div class="app-shell__content">
      <header class="topbar">
        <button v-if="!usesSidebar" class="icon-button" aria-label="메뉴" @click="drawerOpen = !drawerOpen">
          ☰
        </button>
        <div>
          <p class="eyebrow">{{ route.name }}</p>
          <h1>CelesTrak Orbit Lab Pro</h1>
        </div>
        <div v-if="store.loading || store.updateAvailable || store.offline" class="topbar__actions">
          <span v-if="store.loading" class="topbar__chip topbar__chip--loading" role="status" aria-live="polite">
            <span class="loading-dot" aria-hidden="true"></span>
            <span class="topbar__chip-text">{{ store.loadingMessage }}</span>
          </span>
          <button v-if="store.updateAvailable" class="button" @click="store.applyUpdate()">업데이트 적용</button>
          <span v-if="store.offline" class="topbar__chip topbar__chip--warn">
            오프라인 · {{ formatTimestamp(store.lastSyncedAt ?? undefined) }}
          </span>
        </div>
      </header>

      <nav v-if="drawerOpen && !usesSidebar" class="drawer" @click="drawerOpen = false">
        <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="drawer__link">
          {{ item.label }}
        </RouterLink>
      </nav>

      <main class="page-shell" :aria-busy="store.loading">
        <LoadingState
          v-if="isInitialLoading"
          title="데이터 불러오는 중"
          :message="store.loadingMessage"
          variant="global"
        />
        <slot v-else />
      </main>
    </div>

    <nav v-if="isMobileTabs" class="bottom-tabs" :class="{ 'bottom-tabs--hidden': bottomTabsHidden }" aria-label="Primary mobile navigation">
      <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="bottom-tabs__link">
        <span class="bottom-tabs__indicator" aria-hidden="true"></span>
        <span class="bottom-tabs__text">{{ item.shortLabel }}</span>
      </RouterLink>
    </nav>
  </div>
</template>
