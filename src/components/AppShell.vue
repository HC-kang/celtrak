<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import LoadingState from '@/components/LoadingState.vue';
import { usePwaInstallPrompt } from '@/composables/usePwaInstallPrompt';
import { useViewport } from '@/composables/useViewport';
import { useAppStore } from '@/stores/app';
import { formatTimestamp } from '@/lib/format';

const route = useRoute();
const viewport = useViewport();
const store = useAppStore();
const pwaInstall = usePwaInstallPrompt();

const SIDEBAR_COLLAPSED_KEY = 'celtrak:sidebar-collapsed';

const drawerOpen = ref(false);
const sidebarCollapsed = ref(false);
const bottomTabsHidden = ref(false);
const lastScrollY = ref(0);
let scrollFrame: number | null = null;

const navItems = [
  { label: 'Briefing', shortLabel: 'Brief', marker: 'B', path: '/briefing' },
  { label: 'Catalog', shortLabel: 'Catalog', marker: 'C', path: '/catalog' },
  { label: 'Fleets', shortLabel: 'Fleets', marker: 'F', path: '/fleets' },
  { label: 'Ground Stations', shortLabel: 'Ground', marker: 'G', path: '/stations' },
  { label: 'Space Weather', shortLabel: 'Weather', marker: 'W', path: '/weather' },
];

const isMobileTabs = computed(() => viewport.breakpoint.value === 'xs' || viewport.breakpoint.value === 'sm');
const usesSidebar = computed(() => viewport.breakpoint.value === 'lg' || viewport.breakpoint.value === 'xl');
const shellClass = computed(() => [
  `app-shell--${viewport.breakpoint.value}`,
  { 'app-shell--sidebar-collapsed': usesSidebar.value && sidebarCollapsed.value },
]);
const isInitialLoading = computed(() => store.loading && !store.lastSyncedAt);
const canInstallPwa = computed(() => pwaInstall.canInstall.value);
const isInstallingPwa = computed(() => pwaInstall.isInstalling.value);
const hasTopbarActions = computed(() => canInstallPwa.value || store.loading || store.updateAvailable || store.offline);

onMounted(() => {
  sidebarCollapsed.value = readSavedSidebarState();
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

watch(sidebarCollapsed, (collapsed) => {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? 'true' : 'false');
  } catch {
    // The sidebar remains functional even when localStorage is unavailable.
  }
});

function readSavedSidebarState() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
}

function installPwa() {
  void pwaInstall.install();
}

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
    <aside v-if="usesSidebar" class="app-shell__sidebar" :class="{ 'app-shell__sidebar--collapsed': sidebarCollapsed }">
      <button
        type="button"
        class="sidebar-toggle"
        :aria-label="sidebarCollapsed ? '사이드바 펼치기' : '사이드바 접기'"
        :aria-expanded="!sidebarCollapsed"
        @click="toggleSidebar"
      >
        <span aria-hidden="true">{{ sidebarCollapsed ? '›' : '‹' }}</span>
      </button>
      <div class="brand">
        <p>Orbit Lab</p>
        <strong>CelesTrak Pro</strong>
      </div>
      <nav class="nav-list">
        <RouterLink
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="nav-link"
          :aria-label="item.label"
          :data-label="item.label"
          :title="sidebarCollapsed ? item.label : undefined"
        >
          <span class="nav-link__marker" aria-hidden="true">{{ item.marker }}</span>
          <span class="nav-link__text">{{ item.label }}</span>
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
        <div class="topbar__title">
          <p class="eyebrow">{{ route.name }}</p>
          <h1>CelesTrak Orbit Lab Pro</h1>
        </div>
        <div v-if="hasTopbarActions" class="topbar__actions">
          <button
            v-if="canInstallPwa"
            type="button"
            class="topbar__install-button"
            :disabled="isInstallingPwa"
            aria-label="Celtrak을 앱으로 설치"
            @click="installPwa"
          >
            <span class="topbar__install-dot" aria-hidden="true"></span>
            <span>{{ isInstallingPwa ? 'Installing' : 'Install app' }}</span>
          </button>
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
