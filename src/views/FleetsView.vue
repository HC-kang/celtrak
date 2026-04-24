<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { RouterLink } from 'vue-router';
import PanelCard from '@/components/PanelCard.vue';
import OriginBadge from '@/components/OriginBadge.vue';
import { useAppStore } from '@/stores/app';

const store = useAppStore();

const fleetForm = reactive({ name: '', description: '' });
const importState = reactive({ content: '', sourceLabel: '' });
const statusForm = reactive({
  memberKey: '',
  mcStatus: 'FMC' as const,
  rfStatus: 'NOMINAL' as const,
  notes: '',
});
const anomalyForm = reactive({
  memberKey: '',
  severity: 'WARN' as const,
  subsystem: '',
  description: '',
});
const importMessage = ref('');
const memberDrafts = reactive<Record<string, { displayName: string; tags: string }>>({});

const fleetMembers = computed(() =>
  (store.selectedFleet?.memberRefs ?? []).map((member) => ({
    ref: member,
    key: refKey(member),
    name:
      store.catalog.find((entry) => entry.satcat.catalogNumber === member.catalogNumber)?.satcat.objectName ??
      store.customTles.find((entry) => entry.id === member.customTleId)?.name ??
      member.displayName ??
      'Unknown',
    latestStatus:
      store.opsStatuses[member.refType === 'catalog' ? `catalog:${member.catalogNumber}` : `custom:${member.customTleId}`]?.[0] ??
      null,
  })),
);

const selectedFleetSummary = computed(() => {
  const selectedKeys = new Set((store.selectedFleet?.memberRefs ?? []).map(refKey));
  const openAnomalies = store.anomalies.filter((anomaly) => !anomaly.closedAt && selectedKeys.has(refKey(anomaly.satelliteRef))).length;
  return {
    name: store.selectedFleet?.name ?? 'No fleet selected',
    description: store.selectedFleet?.description || 'Catalog에서 객체를 추가해 Briefing과 패스 계산 대상 플릿을 구성합니다.',
    memberCount: fleetMembers.value.length,
    recordedCount: fleetMembers.value.filter((member) => member.latestStatus).length,
    openAnomalies,
    customCount: store.customTles.length,
  };
});

function ensureDraft(key: string, displayName?: string, tags?: string[]) {
  if (!memberDrafts[key]) {
    memberDrafts[key] = { displayName: displayName ?? '', tags: (tags ?? []).join(', ') };
  }
  return memberDrafts[key];
}

async function submitFleet() {
  if (!fleetForm.name.trim()) return;
  await store.createFleet(fleetForm.name.trim(), fleetForm.description.trim());
  fleetForm.name = '';
  fleetForm.description = '';
}

async function submitImport() {
  const report = await store.importCustomTles(importState.content, importState.sourceLabel || undefined);
  importMessage.value = `${report.imported}건 import, 오류 ${report.errors.length}건`;
  importState.content = '';
}

async function importFromFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  importState.content = await file.text();
  importState.sourceLabel = file.name;
}

async function submitStatus() {
  const member = fleetMembers.value.find((item) => item.key === statusForm.memberKey);
  if (!member) return;
  await store.logOperationalStatus(member.ref, statusForm.mcStatus, statusForm.rfStatus, statusForm.notes || undefined);
  statusForm.notes = '';
}

async function submitAnomaly() {
  const member = fleetMembers.value.find((item) => item.key === anomalyForm.memberKey);
  if (!member || !anomalyForm.description.trim()) return;
  await store.logAnomaly({
    satelliteRef: member.ref,
    severity: anomalyForm.severity,
    subsystem: anomalyForm.subsystem || undefined,
    description: anomalyForm.description.trim(),
  });
  anomalyForm.description = '';
  anomalyForm.subsystem = '';
}

async function saveOverride(member: (typeof fleetMembers.value)[number]) {
  const draft = ensureDraft(member.key, member.ref.displayName, member.ref.tags);
  await store.updateFleetMember(member.ref, {
    displayName: draft.displayName.trim() || undefined,
    tags: draft.tags
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  });
}

function refKey(member: { refType: 'catalog' | 'custom'; catalogNumber?: number; customTleId?: string }) {
  return member.refType === 'catalog' ? `catalog:${member.catalogNumber}` : `custom:${member.customTleId}`;
}
</script>

<template>
  <div class="page-stack fleets-layout">
    <section class="fleet-command">
      <div class="fleet-command__copy">
        <p class="eyebrow">Fleet Operations</p>
        <h2>{{ selectedFleetSummary.name }}</h2>
        <p>{{ selectedFleetSummary.description }}</p>
        <div class="fleet-command__actions">
          <RouterLink class="button" to="/catalog">Catalog에서 추가</RouterLink>
          <RouterLink class="button button--ghost" to="/briefing">Briefing 확인</RouterLink>
        </div>
      </div>
      <div class="fleet-command__stats" aria-label="Selected fleet summary">
        <article>
          <span>Tracked</span>
          <strong>{{ selectedFleetSummary.memberCount }}</strong>
        </article>
        <article>
          <span>Status Logged</span>
          <strong>{{ selectedFleetSummary.recordedCount }}/{{ selectedFleetSummary.memberCount }}</strong>
        </article>
        <article>
          <span>Open Anomalies</span>
          <strong>{{ selectedFleetSummary.openAnomalies }}</strong>
        </article>
        <article>
          <span>Custom Sets</span>
          <strong>{{ selectedFleetSummary.customCount }}</strong>
        </article>
      </div>
    </section>

    <PanelCard class="fleet-directory-panel" title="Fleet Directory" subtitle="Fleet workspaces">
      <div class="fleet-directory">
        <button
          v-for="fleet in store.fleets"
          :key="fleet.id"
          class="fleet-chip"
          :class="{ 'fleet-chip--active': store.selectedFleetId === fleet.id }"
          @click="store.selectFleet(fleet.id)"
        >
          {{ fleet.name }}
        </button>
      </div>
      <div class="form-grid fleet-directory-form">
        <input v-model="fleetForm.name" class="input" type="text" placeholder="새 플릿 이름" />
        <input v-model="fleetForm.description" class="input" type="text" placeholder="설명" />
        <button class="button" @click="submitFleet()">플릿 생성</button>
        <button v-if="store.selectedFleet" class="button button--ghost" @click="store.deleteFleet(store.selectedFleet.id)">선택 플릿 삭제</button>
      </div>
    </PanelCard>

    <PanelCard class="fleet-status-panel" title="Operational Status Log" subtitle="USER readiness entry">
      <div class="form-grid fleet-status-form">
        <select v-model="statusForm.memberKey" class="input">
          <option value="">위성 선택</option>
          <option v-for="member in fleetMembers" :key="member.key" :value="member.key">{{ member.name }}</option>
        </select>
        <select v-model="statusForm.mcStatus" class="input">
          <option>FMC</option>
          <option>PMC</option>
          <option>NMC</option>
          <option>UNKNOWN</option>
        </select>
        <select v-model="statusForm.rfStatus" class="input">
          <option>NOMINAL</option>
          <option>DEGRADED</option>
          <option>LOSS</option>
          <option>UNKNOWN</option>
        </select>
        <input v-model="statusForm.notes" class="input fleet-status-form__notes" type="text" placeholder="노트" />
        <button class="button" @click="submitStatus()">상태 기록</button>
      </div>
    </PanelCard>

    <PanelCard class="fleet-members-panel" title="Fleet Members" subtitle="Selected fleet roster">
      <template #actions>
        <OriginBadge origin="USER" :timestamp="store.selectedFleet?.updatedAt" />
      </template>
      <div v-if="fleetMembers.length" class="fleet-member-list">
        <article v-for="member in fleetMembers" :key="member.key" class="fleet-member-card">
          <div class="fleet-member-card__header">
            <div>
              <span class="fleet-member-card__type">{{ member.ref.refType === 'catalog' ? 'SATCAT' : 'CUSTOM' }}</span>
              <strong>{{ member.name }}</strong>
              <p>{{ member.latestStatus?.mcStatus ?? 'UNKNOWN' }} · {{ member.latestStatus?.rfStatus ?? 'UNKNOWN' }}</p>
            </div>
            <small class="fleet-member-card__timestamp">
              {{ member.latestStatus?.recordedAt ? new Date(member.latestStatus.recordedAt).toLocaleString('ko-KR') : '기록 없음' }}
            </small>
          </div>
          <p v-if="store.hasDivergence(member.ref)" class="status-warn">OSINT active 상태와 USER degraded 입력이 충돌합니다.</p>
          <div class="fleet-member-card__editor">
            <label>
              <span>Display name</span>
              <input
                v-model="ensureDraft(member.key, member.ref.displayName, member.ref.tags).displayName"
                class="input"
                type="text"
                placeholder="Display name override"
              />
            </label>
            <label>
              <span>Tags</span>
              <input
                v-model="ensureDraft(member.key, member.ref.displayName, member.ref.tags).tags"
                class="input"
                type="text"
                placeholder="comma,separated,tags"
              />
            </label>
            <div class="fleet-member-card__actions">
              <button class="button button--ghost" @click="saveOverride(member)">별칭 저장</button>
              <button class="button button--ghost" @click="store.removeFleetMember(member.ref)">멤버 제거</button>
            </div>
          </div>
        </article>
      </div>
      <div v-else class="empty-state empty-state--action">
        <strong>선택 플릿에 멤버가 없습니다.</strong>
        <p>Catalog에서 위성을 추가하면 Briefing 지도와 패스 계산 대상에 포함됩니다.</p>
        <RouterLink class="button" to="/catalog">Catalog에서 추가</RouterLink>
      </div>
    </PanelCard>

    <PanelCard class="fleet-import-panel" title="Custom Orbit Import" subtitle="User-supplied TLE / OMM">
      <div class="form-grid fleet-import-form">
        <input v-model="importState.sourceLabel" class="input" type="text" placeholder="출처 라벨 (선택)" />
        <input class="input" type="file" accept=".txt,.tle,.xml,.json" @change="importFromFile" />
        <textarea v-model="importState.content" class="textarea fleet-import-form__content" rows="10" placeholder="TLE/3LE/OMM JSON/XML 붙여넣기" />
        <button class="button" @click="submitImport()">가져오기</button>
        <p class="supporting-text">{{ importMessage || `${store.customTles.length}건 저장됨` }}</p>
      </div>
      <div class="table-like fleet-log-list">
        <article v-for="entry in store.customTles" :key="entry.id" class="table-like__row">
          <div>
            <strong>{{ entry.name }}</strong>
            <p>{{ entry.format }} · {{ entry.sourceLabel || 'USER' }}</p>
          </div>
          <div class="inline-actions">
            <small>{{ new Date(entry.addedAt).toLocaleString('ko-KR') }}</small>
            <button class="button button--ghost" @click="store.addCustomTleToFleet(entry.id)">플릿 추가</button>
          </div>
        </article>
      </div>
    </PanelCard>

    <PanelCard class="fleet-anomaly-panel" title="Anomaly Log" subtitle="USER issue tracking">
      <div class="form-grid fleet-anomaly-form">
        <select v-model="anomalyForm.memberKey" class="input">
          <option value="">위성 선택</option>
          <option v-for="member in fleetMembers" :key="member.key" :value="member.key">{{ member.name }}</option>
        </select>
        <select v-model="anomalyForm.severity" class="input">
          <option>INFO</option>
          <option>WARN</option>
          <option>CRITICAL</option>
        </select>
        <input v-model="anomalyForm.subsystem" class="input" type="text" placeholder="Subsystem" />
        <textarea v-model="anomalyForm.description" class="textarea fleet-anomaly-form__description" rows="4" placeholder="이상 현상 설명" />
        <button class="button" @click="submitAnomaly()">이상 기록</button>
      </div>
      <div class="table-like fleet-log-list">
        <article v-for="anomaly in store.anomalies" :key="anomaly.id" class="table-like__row">
          <div>
            <strong>{{ anomaly.severity }} · {{ anomaly.subsystem || 'GENERAL' }}</strong>
            <p>{{ anomaly.description }}</p>
          </div>
          <div class="inline-actions">
            <small>{{ new Date(anomaly.openedAt).toLocaleString('ko-KR') }}</small>
            <button v-if="!anomaly.closedAt" class="button button--ghost" @click="store.closeAnomaly(anomaly.id)">종료</button>
          </div>
        </article>
      </div>
    </PanelCard>
  </div>
</template>
