import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';

type InstallOutcome = 'accepted' | 'dismissed';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: string[];
  readonly userChoice: Promise<{ outcome: InstallOutcome; platform?: string }>;
  prompt(): Promise<void>;
}

type StandaloneNavigator = Navigator & { standalone?: boolean };

export function usePwaInstallPrompt() {
  const deferredPrompt = shallowRef<BeforeInstallPromptEvent | null>(null);
  const isInstalled = ref(isRunningAsInstalledApp());
  const isInstalling = ref(false);
  let displayModeQuery: MediaQueryList | null = null;

  const canInstall = computed(() => Boolean(deferredPrompt.value) && !isInstalled.value && !isInstalling.value);

  function handleBeforeInstallPrompt(event: Event) {
    if (isRunningAsInstalledApp()) {
      isInstalled.value = true;
      deferredPrompt.value = null;
      return;
    }

    event.preventDefault();
    deferredPrompt.value = event as BeforeInstallPromptEvent;
  }

  async function install() {
    const promptEvent = deferredPrompt.value;
    if (!promptEvent || isInstalled.value || isInstalling.value) return;

    isInstalling.value = true;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice.outcome === 'accepted') {
        isInstalled.value = true;
      }
    } finally {
      deferredPrompt.value = null;
      isInstalling.value = false;
    }
  }

  function handleAppInstalled() {
    isInstalled.value = true;
    deferredPrompt.value = null;
  }

  function handleDisplayModeChange() {
    if (isRunningAsInstalledApp()) {
      handleAppInstalled();
    }
  }

  onMounted(() => {
    isInstalled.value = isRunningAsInstalledApp();
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    if ('matchMedia' in window) {
      displayModeQuery = window.matchMedia('(display-mode: standalone)');
      addMediaQueryListener(displayModeQuery, handleDisplayModeChange);
    }
  });

  onBeforeUnmount(() => {
    window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.removeEventListener('appinstalled', handleAppInstalled);
    if (displayModeQuery) {
      removeMediaQueryListener(displayModeQuery, handleDisplayModeChange);
    }
  });

  return {
    canInstall,
    install,
    isInstalled: computed(() => isInstalled.value),
    isInstalling: computed(() => isInstalling.value),
  };
}

function isRunningAsInstalledApp() {
  const standaloneNavigator = navigator as StandaloneNavigator;
  return Boolean(
    standaloneNavigator.standalone ||
      window.matchMedia?.('(display-mode: standalone)').matches ||
      window.matchMedia?.('(display-mode: fullscreen)').matches ||
      document.referrer.startsWith('android-app://'),
  );
}

function addMediaQueryListener(query: MediaQueryList, listener: () => void) {
  if ('addEventListener' in query) {
    query.addEventListener('change', listener);
  } else {
    query.addListener(listener);
  }
}

function removeMediaQueryListener(query: MediaQueryList, listener: () => void) {
  if ('removeEventListener' in query) {
    query.removeEventListener('change', listener);
  } else {
    query.removeListener(listener);
  }
}
