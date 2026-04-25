<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import PanelCard from '@/components/PanelCard.vue';
import OriginBadge from '@/components/OriginBadge.vue';
import PassList from '@/components/PassList.vue';
import PassCalendar from '@/components/PassCalendar.vue';
import EventTimeline from '@/components/EventTimeline.vue';
import { useAppStore } from '@/stores/app';
import { formatRelative, formatTimestamp } from '@/lib/format';
import { useViewport } from '@/composables/useViewport';
import { createUserElevationMaskSource, elevationMaskSourceLabel } from '@/lib/groundStationElevation';

const store = useAppStore();
const viewport = useViewport();
const stationForm = reactive({
  name: '',
  latDeg: '37.5665',
  lonDeg: '126.9780',
  altitudeM: '38',
  elevationMaskDeg: '10',
});
const importJson = ref('');
const exportResult = ref('');
const importMessage = ref('');
const fleetOnlyConjunctions = ref(true);
const eventView = ref<'list' | 'calendar'>(
  viewport.breakpoint.value === 'xs' || viewport.breakpoint.value === 'sm' ? 'list' : 'calendar',
);
const eventForm = reactive({
  memberKey: '',
  title: '',
  kind: 'OTHER' as const,
  startAt: '',
  endAt: '',
  notes: '',
});

const stationLookup = computed(() =>
  Object.fromEntries(store.groundStations.map((station) => [station.id, station.name])),
);

const memberLookup = computed(() =>
  Object.fromEntries(
    (store.selectedFleet?.memberRefs ?? []).map((member) => {
      const key = member.refType === 'catalog' ? `catalog:${member.catalogNumber}` : `custom:${member.customTleId}`;
      const name =
        member.displayName ??
        store.catalog.find((entry) => entry.satcat.catalogNumber === member.catalogNumber)?.satcat.objectName ??
        store.customTles.find((entry) => entry.id === member.customTleId)?.name ??
        'Unknown';
      return [key, name];
    }),
  ),
);

const visibleConjunctions = computed(() => (fleetOnlyConjunctions.value ? store.filteredConjunctions : store.conjunctions));

async function addGroundStation() {
  if (!stationForm.name.trim()) return;
  await store.upsertGroundStation({
    id: crypto.randomUUID(),
    name: stationForm.name.trim(),
    latDeg: Number(stationForm.latDeg),
    lonDeg: Number(stationForm.lonDeg),
    altitudeM: Number(stationForm.altitudeM),
    elevationMaskDeg: Number(stationForm.elevationMaskDeg),
    elevationMaskSource: createUserElevationMaskSource(),
    enabled: true,
    schemaVersion: 1,
  });
  stationForm.name = '';
}

async function useCurrentLocation() {
  if (!navigator.geolocation) return;
  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject);
  });
  stationForm.latDeg = position.coords.latitude.toFixed(4);
  stationForm.lonDeg = position.coords.longitude.toFixed(4);
  stationForm.altitudeM = Math.round(position.coords.altitude ?? 0).toString();
}

async function exportWorkspace() {
  exportResult.value = await store.exportWorkspace();
}

async function importWorkspace(mode: 'merge' | 'replace') {
  const report = await store.importWorkspace(importJson.value, mode);
  importMessage.value = `${report.imported}건 복원, ${report.rejected}건 거부`;
}

async function submitEvent() {
  if (!eventForm.title.trim() || !eventForm.startAt) return;
  const satelliteRef = eventForm.memberKey
    ? (store.selectedFleet?.memberRefs ?? []).find((member) =>
        eventForm.memberKey ===
        (member.refType === 'catalog' ? `catalog:${member.catalogNumber}` : `custom:${member.customTleId}`),
      )
    : undefined;

  await store.upsertEvent({
    id: crypto.randomUUID(),
    satelliteRef,
    startAt: new Date(eventForm.startAt).toISOString(),
    endAt: eventForm.endAt ? new Date(eventForm.endAt).toISOString() : undefined,
    kind: eventForm.kind,
    title: eventForm.title.trim(),
    notes: eventForm.notes.trim() || undefined,
    schemaVersion: 1,
  });

  eventForm.memberKey = '';
  eventForm.title = '';
  eventForm.startAt = '';
  eventForm.endAt = '';
  eventForm.notes = '';
}
</script>

<template>
  <div class="page-stack">
    <PanelCard title="Ground Stations" subtitle="F-MUST-04">
      <div class="form-grid">
        <input v-model="stationForm.name" class="input" type="text" placeholder="지상국 이름" />
        <input v-model="stationForm.latDeg" class="input" type="number" step="0.0001" placeholder="위도" />
        <input v-model="stationForm.lonDeg" class="input" type="number" step="0.0001" placeholder="경도" />
        <input v-model="stationForm.altitudeM" class="input" type="number" step="1" placeholder="고도(m)" />
        <input v-model="stationForm.elevationMaskDeg" class="input" type="number" step="1" placeholder="마스크 각도" />
        <button class="button" @click="addGroundStation()">추가</button>
        <button class="button button--ghost" @click="useCurrentLocation()">현재 위치 불러오기</button>
      </div>
      <div class="table-like">
        <article v-for="station in store.groundStations" :key="station.id" class="table-like__row">
          <div>
            <strong>{{ station.name }}</strong>
            <p>{{ station.latDeg }}, {{ station.lonDeg }} · mask {{ station.elevationMaskDeg }}° · {{ elevationMaskSourceLabel(station.elevationMaskSource) }}</p>
          </div>
          <div class="inline-actions">
            <label class="setting-toggle setting-toggle--compact">
              <span>기본</span>
              <input
                :checked="store.preferences.defaultGroundStationId === station.id"
                type="radio"
                name="default-ground-station"
                @change="store.setDefaultGroundStation(station.id)"
              />
            </label>
            <label class="setting-toggle setting-toggle--compact">
              <span>활성</span>
              <input :checked="station.enabled" type="checkbox" @change="store.toggleGroundStation(station.id, ($event.target as HTMLInputElement).checked)" />
            </label>
          </div>
        </article>
      </div>
    </PanelCard>

    <PanelCard title="Conjunction Dashboard" subtitle="F-MUST-10">
      <template #actions>
        <OriginBadge origin="OSINT" :timestamp="store.conjunctions[0]?.fetchedAt" :stale="store.offline" />
      </template>
      <div class="toolbar">
        <label class="setting-toggle setting-toggle--compact">
          <span>선택 플릿만</span>
          <input v-model="fleetOnlyConjunctions" type="checkbox" />
        </label>
      </div>
      <p v-if="store.alerts.find((item) => item.kind === 'degraded')" class="supporting-text">
        {{ store.alerts.find((item) => item.kind === 'degraded')?.detail }}
      </p>
      <div class="stack-list">
        <article v-for="item in visibleConjunctions" :key="item.id" class="stack-list__item">
          <div>
            <strong>{{ item.primary.name }} × {{ item.secondary.name }}</strong>
            <p>{{ item.missDistanceKm.toFixed(1) }} km miss · {{ item.pc ? `Pc ${item.pc}` : 'Pc n/a' }}</p>
          </div>
          <small>{{ formatRelative(item.tca) }}</small>
        </article>
      </div>
    </PanelCard>

    <PanelCard title="Decay Predictions" subtitle="F-MUST-12">
      <div class="stack-list">
        <article
          v-for="item in store.filteredDecayPredictions"
          :key="item.catalogNumber"
          class="stack-list__item"
          :class="{ 'stack-list__item--accent': item.intersectsSelectedFleet }"
        >
          <div>
            <strong>{{ item.name }}</strong>
            <p>{{ item.confidence }} confidence · {{ item.intersectsSelectedFleet ? 'selected fleet' : 'catalog only' }}</p>
          </div>
          <small>{{ formatTimestamp(item.predictedDecayAt) }}</small>
        </article>
      </div>
    </PanelCard>

    <PanelCard title="Pass Visibility Calendar" subtitle="F-MUST-11">
      <div class="toolbar">
        <button
          class="button button--ghost"
          :class="{ 'button--selected': eventView === 'list' }"
          type="button"
          :aria-pressed="eventView === 'list'"
          @click="eventView = 'list'"
        >
          리스트
        </button>
        <button
          class="button button--ghost"
          :class="{ 'button--selected': eventView === 'calendar' }"
          type="button"
          :aria-pressed="eventView === 'calendar'"
          @click="eventView = 'calendar'"
        >
          캘린더
        </button>
      </div>
      <PassList v-if="eventView === 'list'" :passes="store.passPredictions" :station-lookup="stationLookup" />
      <PassCalendar
        v-else
        :passes="store.passPredictions"
        :station-lookup="stationLookup"
        :start-time-iso="store.simulationTimeIso"
      />
    </PanelCard>

    <PanelCard title="Scheduled Events" subtitle="User Timeline">
      <div class="form-grid">
        <select v-model="eventForm.memberKey" class="input">
          <option value="">플릿 전체</option>
          <option v-for="(label, key) in memberLookup" :key="key" :value="key">{{ label }}</option>
        </select>
        <input v-model="eventForm.title" class="input" type="text" placeholder="이벤트 제목" />
        <select v-model="eventForm.kind" class="input">
          <option>MANEUVER</option>
          <option>MAINTENANCE</option>
          <option>SW_UPDATE</option>
          <option>HANDOVER</option>
          <option>OTHER</option>
        </select>
        <input v-model="eventForm.startAt" class="input" type="datetime-local" />
        <input v-model="eventForm.endAt" class="input" type="datetime-local" />
        <textarea v-model="eventForm.notes" class="textarea" rows="4" placeholder="노트" />
        <button class="button" @click="submitEvent()">이벤트 저장</button>
      </div>
      <EventTimeline :events="store.upcomingEvents" :satellite-lookup="memberLookup" @remove="store.deleteEvent" />
    </PanelCard>

    <PanelCard title="Settings" subtitle="Runtime & Data Saver">
      <div class="settings-grid">
        <label class="setting-toggle">
          <span>Data Saver</span>
          <input :checked="store.preferences.dataSaver" type="checkbox" @change="store.updatePreferences({ dataSaver: ($event.target as HTMLInputElement).checked })" />
        </label>
        <label class="setting-toggle">
          <span>Reduced Motion</span>
          <input :checked="store.preferences.reducedMotion" type="checkbox" @change="store.updatePreferences({ reducedMotion: ($event.target as HTMLInputElement).checked })" />
        </label>
        <label class="setting-toggle">
          <span>Desktop 3D Default</span>
          <input :checked="store.preferences.desktopRenderMode === '3d'" type="checkbox" @change="store.updatePreferences({ desktopRenderMode: ($event.target as HTMLInputElement).checked ? '3d' : '2d' })" />
        </label>
      </div>
      <div class="stack-list">
        <article v-if="store.updateAvailable" class="stack-list__item stack-list__item--accent">
          <div>
            <strong>새 버전 사용 가능</strong>
            <p>서비스 워커가 새 앱 셸을 받았습니다.</p>
          </div>
          <button class="button" @click="store.applyUpdate()">업데이트 적용</button>
        </article>
      </div>
    </PanelCard>

    <PanelCard title="Backup & Restore" subtitle="Export / Import JSON">
      <div class="form-grid">
        <button class="button" @click="exportWorkspace()">현재 워크스페이스 export</button>
        <textarea v-model="exportResult" class="textarea" rows="8" placeholder="내보내기 결과" />
        <textarea v-model="importJson" class="textarea" rows="8" placeholder="가져올 JSON" />
        <div class="toolbar">
          <button class="button" @click="importWorkspace('merge')">Merge import</button>
          <button class="button button--ghost" @click="importWorkspace('replace')">Replace import</button>
        </div>
        <p class="supporting-text">{{ importMessage }}</p>
      </div>
    </PanelCard>
  </div>
</template>
