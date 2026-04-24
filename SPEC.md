# CelesTrak Orbit Lab Pro — Production Specification v0.2

| 항목 | 값 |
|---|---|
| 버전 | 0.2 |
| 상태 | 리뷰 대기 |
| 선행 결정 | 1-C(사용자 입력 수용형) / 2-B(브라우저 영구 저장) / 3-ALL(SWPC·SOCRATES·Decay·Pass) |
| 추가 요구 (v0.2) | PC·태블릿·모바일 웹 전 기기 지원, 오프라인 동작 |
| 기존 자산 | `blue-rabbit.kr/utils/celestrak` GP 프록시·3D 뷰어, Cloudflare Workers |
| 스택 | TypeScript, Cloudflare Workers(edge), satellite.js(SGP4), IndexedDB(저장), Service Worker(오프라인) |

---

## 0. 이 스펙이 명시적으로 거부하는 것 (Non-Goals)

레퍼런스 목업(이미지 1·2)에 있더라도 공개 데이터로 검증 불가능한 지표는 **원형 구현을 거부**하고 사용자 입력 또는 파생 proxy로 재정의합니다.

| 목업 요소 | 거부 사유 | 대체 구현 |
|---|---|---|
| Mission Capable (위성 단위) | 운영자 내부 판정, 공개 소스 없음 | 사용자 입력 `mcStatus` (FMC/PMC/NMC/UNKNOWN) |
| Constellation Health 94% | 정의 자체가 내부 규약, 임의 수식은 허위 | 사용자 플릿의 `mcStatus` 집계. 계산식 UI에 노출 |
| RF Status dot | operator telemetry. 공개 소스 전무 | 사용자 입력 `rfStatus` + 별도 "TLE Freshness" proxy 병기 |
| Ground Stations 헬스 | 운영자 전용 | 사용자 정의 지상국 + pass 가시성(다음 AOS, 24h 누적 contact) |
| Upcoming Events 운영 일정 | 비공개 | 사용자 입력 스케줄 + OSINT 파생(decay ETA, 다음 pass) 병합 |
| Anomalies & Notes | 운영자 전용 | 사용자 입력 anomaly log + 선택적 maneuver detection 파생 |
| UCT Tracking, RFO Analysis, FMC Rates, Personnel Strength | 군사 내부 지표 | **구현 제외** |

**원칙**: 모든 화면의 모든 값은 (a) 출처(OSINT/DERIVED/USER/STALE)와 (b) fetched/recorded 시각을 노출합니다.

추가 Non-Goals (v0.2 추가):
- 네이티브 앱 (iOS/Android 앱스토어 배포) — **PWA로 충분**
- 푸시 알림 (v1에서 제외, v2 COULD)
- 멀티 사용자·공유 플릿 (v2)
- 완전 오프라인 TLE 갱신 (오프라인 상태에서 새 OSINT 데이터 수신 불가는 당연; 마지막 캐시만 제공)

---

## 1. 용어 / 약어

| 약어 | 설명 |
|---|---|
| GP | General Perturbations (SGP4 평균 궤도요소) |
| TLE / 3LE / 2LE | Two-Line Element (name line 유무) |
| OMM | CCSDS 502.0-B-3 Orbit Mean-Elements Message |
| SATCAT | Celestrak Satellite Catalog (메타데이터) |
| SGP4 | Simplified General Perturbations propagator |
| SOCRATES | Celestrak 주간 근접 접근 스크리닝 리포트 |
| TCA | Time of Closest Approach |
| Pc | Probability of Collision |
| AOS / LOS | Acquisition / Loss of Signal |
| NOAA SWPC | Space Weather Prediction Center |
| PWA | Progressive Web App |
| CQ | CSS Container Query |
| LOD | Level of Detail (렌더링 단순화) |
| FMC / PMC / NMC | Full / Partial / Non Mission Capable (사용자 정의 의미로만 사용) |

---

## 2. 시스템 컨텍스트

```
┌───────────────────────────────────────┐    ┌──────────────────────────────────────┐
│ User Device (any form factor)         │    │ blue-rabbit.kr / Cloudflare Workers  │
│                                       │    │                                      │
│ ┌───────────────────────────────────┐ │    │ ┌──────────────────────────────────┐ │
│ │ PWA (TS)                          │◄├────┤►│ /api/celestrak/gp (proxy+cache)  │ │
│ │  - Main Thread                    │ │    │ │ /api/celestrak/satcat            │ │
│ │    · UI, interactions             │ │    │ │ /api/celestrak/socrates (parser) │ │
│ │    · 2D/3D render                 │ │    │ │ /api/celestrak/decay             │ │
│ │  - Web Workers                    │ │    │ │ /api/swpc/*                      │ │
│ │    · SGP4 propagation (batch)     │ │    │ │ /api/utils/tle/parse             │ │
│ │    · Pass prediction              │ │    │ │ cache layer (Workers KV/Cache)   │ │
│ │    · TLE bulk parsing             │ │    │ └────────────┬─────────────────────┘ │
│ │  - Service Worker                 │ │    └──────────────┼───────────────────────┘
│ │    · Offline cache                │ │                   │
│ │    · Stale-while-revalidate       │ │                   ▼
│ │  - IndexedDB                      │ │      ┌─────────────────────────────┐
│ │    · fleets, custom TLEs          │ │      │ celestrak.org               │
│ │    · ops status, ground stations  │ │      │ services.swpc.noaa.gov      │
│ │    · user anomalies/events        │ │      └─────────────────────────────┘
│ └───────────────────────────────────┘ │
└───────────────────────────────────────┘
```

프런트엔드는 외부 소스를 **절대 직접 호출하지 않습니다**. CORS·캐시·Celestrak 2시간 예절·SOCRATES 파싱 격리 모두 엣지에서 처리.

---

## 3. 기기 지원 매트릭스 (Device Support Matrix)

### 3.1. 지원 기기 클래스

| 클래스 | 대표 기기 | 뷰포트(폭) | 입력 | 성능 | 지원 수준 |
|---|---|---|---|---|---|
| 모바일 세로 | iPhone SE 2020~15 Pro Max, Galaxy S21+ | 360–430px | 터치 | 중 | Tier-1 |
| 모바일 가로 | 동상 회전 | 640–932px | 터치 | 중 | Tier-1 |
| 태블릿 세로 | iPad mini/Air/Pro, Galaxy Tab S7+ | 744–1024px | 터치 (+키보드 선택) | 중-상 | Tier-1 |
| 태블릿 가로 | 동상 회전 | 1024–1366px | 터치 (+키보드 선택) | 중-상 | Tier-1 |
| 노트북/데스크톱 | 일반 | 1280–1920px | 마우스+키보드 | 상 | Tier-1 |
| 대형 데스크톱 | 4K/울트라와이드 | ≥1920px | 마우스+키보드 | 상 | Tier-2 (best-effort 확장) |
| 폴더블 | Z Fold 류 | 가변 (접힘 600~900px / 펼침 1700+) | 터치 | 상 | Tier-3 (동작 보장, 전용 최적화 없음) |

Tier-1: 모든 기능 지원·정기 테스트. Tier-2: 동작 보장, 레이아웃 최적화만. Tier-3: 크래시 없음 보장.

### 3.2. 브라우저 지원

| 브라우저 | 최소 버전 | 근거 |
|---|---|---|
| Chrome / Edge (Chromium) | 120+ | 컨테이너 쿼리, `view-transition`, Service Worker |
| Safari (iOS/macOS) | 17+ | 컨테이너 쿼리, `dynamic-viewport-units`, PWA 설치 |
| Firefox | 121+ | |
| Samsung Internet | 23+ | |

IE·레거시 지원 없음. 비지원 브라우저는 페이지 진입 시 업그레이드 안내.

### 3.3. 최소 하드웨어 전제

| 자원 | 최소 | 권장 | 비고 |
|---|---|---|---|
| CPU | 2 코어 | 4+ 코어 | Web Worker 활용 |
| RAM | 2GB | 4GB+ | 5000개 위성 propagation 시 ~200MB |
| GPU | WebGL 2.0 | WebGL 2.0 / WebGPU | 3D 모드 |
| 저장 | 50MB 여유 | 200MB | Service Worker 캐시 + IndexedDB |
| 네트워크 | 초기 로드 시 연결 필수 | 4G+ / Wi-Fi | 초기 이후 오프라인 가능 |

### 3.4. 입력 모달리티

| 입력 | 대응 |
|---|---|
| 터치 | 44×44 CSS px 최소 히트 영역, 인접 히트 간 ≥8px 간격 |
| 마우스 | hover 상태 활용 (단, 터치에서는 등가 대안 제공) |
| 키보드 | 전 기능 키보드 탐색 가능 (Tab/Shift-Tab/Arrow), 포커스 링 명시 |
| 스타일러스 | 터치로 폴백 |
| 제스처 | 핀치-줌, 드래그-회전 (3D), 스와이프 (탭 전환) — 각각 대안 UI 버튼 병존 |

---

## 4. 아키텍처

### 4.1. 계산 경계 (Compute Boundary)

| 작업 | 위치 | 근거 |
|---|---|---|
| SGP4 실시간 표시 (≤500 위성) | 브라우저 메인 스레드 또는 Web Worker | 60fps 목표. 모바일은 항상 Worker 사용 |
| SGP4 대량 propagation (>500 또는 pass 예측) | **Web Worker** | 메인 스레드 블로킹 방지 |
| Pass 예측 (N 지상국 × M 위성 × T 시간) | Web Worker | 모바일 특히 중요 |
| TLE 1000개+ 일괄 파싱 | Web Worker | 5000 OMM 파싱 시 메인 스레드 300ms+ 블록 |
| 자체 all-vs-all 근접 접근 | **엣지 Worker** (선택 기능) | O(N²). 브라우저에선 비현실적 |
| SOCRATES HTML 파싱 | 엣지 | 파서 격리·버전 관리 |
| 캐시·재검증 오케스트레이션 | 엣지 | 다수 클라이언트 공유 |

### 4.2. 저장 전략

**v0.2 변경**: v0.1의 localStorage 단일 계층 → **IndexedDB 주 + localStorage 보조** 2계층. 이유: (a) 모바일에서 대량 TLE import 요구, (b) 오프라인 PWA에서 상당량 OSINT 캐시 저장, (c) localStorage 5–10MB 쿼터 부족.

| 데이터 | 저장소 | 이유 |
|---|---|---|
| 플릿, 커스텀 TLE, ops 상태, anomaly, ground station | IndexedDB | 큰 용량, 인덱스 지원, 트랜잭션 |
| OSINT API 응답 캐시 (오프라인용) | Cache Storage API (Service Worker) | 응답 객체 단위 캐시 |
| 사용자 설정 (테마·언어·기본 지상국) | localStorage | 빈번한 동기 읽기 |
| 세션 상태 (선택 위성·시뮬레이션 시각) | sessionStorage | 탭 단위 수명 |

`FleetStore` 인터페이스는 동일 유지:

```typescript
interface FleetStore {
  listFleets(): Promise<UserFleet[]>;
  getFleet(id: string): Promise<UserFleet | null>;
  upsertFleet(f: UserFleet): Promise<void>;
  deleteFleet(id: string): Promise<void>;
  listCustomTLEs(): Promise<CustomTLE[]>;
  upsertCustomTLE(t: CustomTLE): Promise<void>;
  deleteCustomTLE(id: string): Promise<void>;
  listOpsStatus(ref: FleetMemberRef, limit: number): Promise<OperationalStatus[]>;
  appendOpsStatus(s: OperationalStatus): Promise<void>;
  listAnomalies(filter: AnomalyFilter): Promise<AnomalyEntry[]>;
  upsertAnomaly(a: AnomalyEntry): Promise<void>;
  listGroundStations(): Promise<GroundStation[]>;
  upsertGroundStation(g: GroundStation): Promise<void>;
  listEvents(from: string, to: string): Promise<ScheduledEvent[]>;
  upsertEvent(e: ScheduledEvent): Promise<void>;
  export(): Promise<string>;
  import(json: string, mode: 'merge'|'replace'): Promise<ImportReport>;
  getSchemaVersion(): Promise<number>;
  migrate(fromVersion: number): Promise<void>;
}
```

구현체:
- `IndexedDBFleetStore` (v1 기본)
- `D1FleetStore` (v2, 클라우드 동기화 시)
- `InMemoryFleetStore` (테스트용)

IndexedDB 스키마는 버전 필드 유지, 자동 마이그레이션 파이프라인 내장.

### 4.3. 엣지 캐시 정책

| 리소스 | s-maxage | stale-while-revalidate | 파싱 실패 시 |
|---|---|---|---|
| GP (그룹) | 7200s (2h) | 86400s (24h) | — |
| GP (CATNR) | 7200s | 86400s | — |
| SATCAT (CATNR) | 86400s (24h) | 604800s (7d) | — |
| SOCRATES | 21600s (6h) | 86400s | 직전 성공 스냅샷 반환 + `X-Parser-Status: degraded` |
| SWPC X-ray 1d | 60s | 900s | last-known 값 |
| SWPC Kp | 900s | 10800s | last-known |
| Celestrak Decay | 21600s | 86400s | — |

응답 헤더: `X-Upstream-Source`, `X-Cached-At`, `X-Stale`, `X-Parser-Version`.

### 4.4. 실패 모드 및 UX

| 실패 | 엣지 동작 | 클라이언트 UX |
|---|---|---|
| Celestrak 5xx | stale 반환 | 상단 배너 "데이터 N분 전" |
| Celestrak 404 | 404 전파 | "카탈로그 미등록 — 커스텀 TLE로 추가" CTA |
| SOCRATES 파싱 실패 | 직전 스냅샷 + degraded 플래그 | 대시보드 "근접 접근 리스트 N시간 전" 노란색 배너 |
| SWPC 장애 | last-known + 0-or-stale | 게이지 회색, last updated 표시 |
| SGP4 오류 (decayed) | — | 위성 "decayed" 뱃지, 기본 필터에서 제외 |
| 네트워크 단절 (모바일) | Service Worker 캐시에서 응답 | "오프라인 — 마지막 동기화 시각" 뱃지 |
| IndexedDB 쓰기 실패 | — | 모달: export 유도 + 자동 저장 보류 |

---

## 5. 데이터 모델

### 5.1. OSINT 레이어 (엣지 정규화 결과)

```typescript
type CatalogNumber = number;  // 5 or 9 digit

interface SatCatRecord {
  catalogNumber: CatalogNumber;
  objectId: string;                          // "1998-067A"
  objectName: string;
  objectType: 'PAYLOAD'|'ROCKET BODY'|'DEBRIS'|'UNKNOWN'|'TBA';
  opsStatusCode: string;
  ownerCountry: string;
  launchDate?: string;
  launchSite?: string;
  decayDate?: string;
  periodMinutes?: number;
  inclinationDeg?: number;
  apogeeKm?: number;
  perigeeKm?: number;
  rcsSizeClass?: 'SMALL'|'MEDIUM'|'LARGE';
  fetchedAt: string;
}

interface OrbitalElementSet {
  catalogNumber: CatalogNumber;
  epoch: string;                             // ISO 8601
  meanMotionRevPerDay: number;
  eccentricity: number;
  inclinationDeg: number;
  raanDeg: number;
  argOfPericenterDeg: number;
  meanAnomalyDeg: number;
  bstar: number;
  // 파생
  semiMajorAxisKm: number;
  apogeeKm: number;
  perigeeKm: number;
  periodMinutes: number;
  // 메타
  raw: TleRaw | OmmRaw;
  source: 'celestrak-gp'|'celestrak-sup-gp'|'user-tle'|'user-omm';
  fetchedAt: string;
}

type TleRaw = { format: 'TLE'|'3LE'; line1: string; line2: string; line0?: string };
type OmmRaw = { format: 'OMM-XML'|'OMM-JSON'; payload: string };
```

### 5.2. 사용자 레이어 (IndexedDB)

```typescript
interface UserFleet {
  id: string;                                // uuid v4
  name: string;
  description?: string;
  memberRefs: FleetMemberRef[];
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

interface FleetMemberRef {
  refType: 'catalog'|'custom';
  catalogNumber?: CatalogNumber;
  customTleId?: string;
  displayName?: string;
  tags: string[];
}

interface CustomTLE {
  id: string;
  name: string;
  format: 'TLE'|'3LE'|'OMM-XML'|'OMM-JSON';
  raw: string;
  parsed?: OrbitalElementSet;
  parseErrors?: string[];
  sourceLabel?: string;
  addedAt: string;
  schemaVersion: 1;
}

interface OperationalStatus {
  id: string;
  satelliteRef: FleetMemberRef;
  recordedAt: string;
  mcStatus: 'FMC'|'PMC'|'NMC'|'UNKNOWN';
  rfStatus: 'NOMINAL'|'DEGRADED'|'LOSS'|'UNKNOWN';
  notes?: string;
  schemaVersion: 1;
}

interface AnomalyEntry {
  id: string;
  satelliteRef: FleetMemberRef;
  openedAt: string;
  closedAt?: string;
  severity: 'INFO'|'WARN'|'CRITICAL';
  subsystem?: string;
  description: string;
  schemaVersion: 1;
}

interface ScheduledEvent {
  id: string;
  satelliteRef?: FleetMemberRef;
  startAt: string;
  endAt?: string;
  kind: 'MANEUVER'|'MAINTENANCE'|'SW_UPDATE'|'HANDOVER'|'OTHER';
  title: string;
  notes?: string;
  schemaVersion: 1;
}

interface GroundStation {
  id: string;
  name: string;
  latDeg: number;
  lonDeg: number;
  altitudeM: number;
  elevationMaskDeg: number;
  enabled: boolean;
  schemaVersion: 1;
}

interface UserPreferences {
  theme: 'light'|'dark'|'system';
  language: 'ko'|'en';
  defaultGroundStationId?: string;
  units: { distance: 'km'|'mi'; speed: 'km/s'|'km/h' };
  mobileRenderMode: '2d'|'3d';               // 모바일 기본 2D
  tabletRenderMode: '2d'|'3d';
  desktopRenderMode: '2d'|'3d';
  reducedMotion: boolean;
  dataSaver: boolean;                        // 셀룰러 절약 모드
  schemaVersion: 1;
}
```

### 5.3. 파생 / 외부 스냅샷

```typescript
interface ConjunctionRecord {
  id: string;                                // hash(primary, secondary, tca)
  tca: string;
  primary: ObjectRef;
  secondary: ObjectRef;
  missDistanceKm: number;
  relVelocityKmS: number;
  pc?: number;
  source: 'celestrak-socrates'|'self-computed';
  fetchedAt: string;
}

interface SpaceWeatherSnapshot {
  fetchedAt: string;
  xray: {
    currentWm2: number | null;
    flareClass?: 'A'|'B'|'C'|'M'|'X';
    classMagnitude?: number;
    series?: Array<{ t: string; flux: number }>;
  };
  kp: {
    current: number | null;
    forecast?: Array<{ t: string; kp: number }>;
    storm: 'QUIET'|'UNSETTLED'|'MINOR'|'MODERATE'|'STRONG'|'SEVERE'|'EXTREME';
  };
  notices?: Array<{ issuedAt: string; type: string; text: string }>;
}

interface DecayPrediction {
  catalogNumber: CatalogNumber;
  name: string;
  predictedDecayAt: string;
  confidence: 'HIGH'|'MEDIUM'|'LOW';
  source: 'celestrak-decay';
  fetchedAt: string;
}

interface PassPrediction {
  satelliteRef: FleetMemberRef;
  groundStationId: string;
  aos: string;          // rise
  tca: string;          // max elevation moment
  los: string;          // set
  maxElevationDeg: number;
  aosAzimuthDeg: number;
  losAzimuthDeg: number;
  illuminationAtTca: 'SUNLIT'|'ECLIPSED'|'PENUMBRA';
  computedAt: string;
}
```

---

## 6. 외부 통합 상세

### 6.1. Celestrak GP Query

- `GET https://celestrak.org/NORAD/elements/gp.php`
- 파라미터: `GROUP`, `NAME`, `CATNR`, `INTDES`, `FORMAT`
- **엣지 기본 포맷**: `JSON` (파싱 용이)
- **TLE 포맷 사용 금지**: 2026년 중 5자리 catalog 소진 임박. 9자리 수용을 위해 OMM 기반 포맷만 사용.

### 6.2. Celestrak SATCAT

- `GET https://celestrak.org/satcat/records.php?CATNR={n}&FORMAT=JSON`
- 그룹: `?GROUP=stations&FORMAT=CSV`
- TTL 24h

### 6.3. Celestrak SOCRATES

- `https://celestrak.org/SOCRATES/` (HTML)
- **파서 요건**: 버전 태그 `v1.0.0`, 스냅샷 회귀 테스트 필수
- 구조 변경 탐지: 예상 컬럼 수/헤더 불일치 시 즉시 실패 + 직전 스냅샷 반환 + `degraded` 플래그
- 정규화 필드: `tca`, `missDistanceKm`, `relVelocityKmS`, `primary`, `secondary`, `maxPc`

### 6.4. Celestrak Decay

- `https://celestrak.org/NORAD/elements/decay.php`
- LEO decay 예측 리스트, TTL 6h

### 6.5. NOAA SWPC

| 대상 | 엔드포인트 | 갱신 |
|---|---|---|
| X-ray 1-day | `services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json` | 1 min |
| X-ray 6-hour (고해상) | `services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json` | 1 min |
| Planetary K | `services.swpc.noaa.gov/products/noaa-planetary-k-index.json` | 1h |
| 3-day forecast | `services.swpc.noaa.gov/text/3-day-forecast.txt` | daily |
| Alerts | `services.swpc.noaa.gov/products/alerts.json` | 수시 |

저작권: NOAA public domain. Celestrak는 출처 표기 필수 (푸터 + API 응답 헤더).

---

## 7. API 설계 (엣지 프록시)

### 7.1. 공통 규약

- Base: `https://www.blue-rabbit.kr/api/`
- Content-Type: `application/json; charset=utf-8`
- 오류: RFC 7807 Problem Details
- 표준 헤더: `X-Upstream-Source`, `X-Cached-At`, `X-Stale`, `X-Parser-Version`
- Rate limit: IP당 분당 60회 soft, 200회 hard (Cloudflare WAF)
- 모든 응답에 `Cache-Control: public, s-maxage=..., stale-while-revalidate=...`

### 7.2. 엔드포인트

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/celestrak/gp?group={g}` | 그룹 단위 GP 정규화 배열 |
| GET | `/api/celestrak/gp?catnr={n}` | 단건 |
| GET | `/api/celestrak/gp?name={q}&limit={n}` | 이름 검색 |
| GET | `/api/celestrak/satcat?catnr={n}` | SATCAT 단건 |
| GET | `/api/celestrak/satcat/groups` | 그룹 목록 |
| GET | `/api/celestrak/socrates?since={iso}` | 근접 접근 |
| GET | `/api/celestrak/decay` | decay 예측 |
| GET | `/api/swpc/xray?window={1d\|6h}` | X-ray flux |
| GET | `/api/swpc/kp` | Kp + 예보 |
| GET | `/api/swpc/notices` | 알림/경보 |
| POST | `/api/utils/tle/parse` | TLE/OMM 검증·파싱 (stateless) |
| POST | `/api/utils/conjunction/screen` | 자체 all-vs-all (선택, M6) |

### 7.3. 인증 / CORS

- v1 인증 없음 (public read). v2 D1 도입 시 Cloudflare Access 또는 Worker-issued JWT.
- CORS: `Access-Control-Allow-Origin: https://www.blue-rabbit.kr` 고정.

---

## 8. 반응형 디자인 시스템 (Responsive Design System)

### 8.1. 브레이크포인트

| 토큰 | min-width | 대상 | 주된 레이아웃 | 네비게이션 |
|---|---|---|---|---|
| `xs` | 0 | 모바일 세로 작은 기기 | 1열 스택 | 하단 탭 바 |
| `sm` | 480px | 모바일 세로 큰 기기 / 모바일 가로 | 1열 스택 | 하단 탭 바 |
| `md` | 768px | 태블릿 세로 | 2열 그리드 | 상단 탭 또는 드로어 |
| `lg` | 1024px | 태블릿 가로 / 소형 노트북 | 3열 그리드 + 사이드 | 접이식 사이드 네비 |
| `xl` | 1280px | 데스크톱 표준 | 4열 그리드 + 사이드 | 고정 사이드 네비 |
| `2xl` | 1536px | 대형 데스크톱 | 폭 제한 1600px | 고정 사이드 네비 |

**구현 원칙**: Tailwind(또는 동등) + CSS Container Queries. 화면 폭뿐 아니라 패널 폭에 반응해야 하는 컴포넌트는 컨테이너 쿼리 사용.

### 8.2. 그리드 시스템

| 브레이크포인트 | 컬럼 | 거터 | 페이지 여백 |
|---|---|---|---|
| xs | 4 | 16px | 16px |
| sm | 4 | 16px | 24px |
| md | 8 | 24px | 32px |
| lg | 12 | 24px | 32px |
| xl+ | 12 | 24px | 48px (최대 폭 1536px 중앙 정렬) |

### 8.3. 타이포그래피 스케일 (반응형)

| 역할 | xs-sm | md | lg-xl | 2xl |
|---|---|---|---|---|
| Display | 24/32 | 28/36 | 32/40 | 36/44 |
| H1 | 20/28 | 22/30 | 24/32 | 24/32 |
| H2 | 18/26 | 20/28 | 22/30 | 22/30 |
| Body | 14/22 | 15/24 | 16/24 | 16/24 |
| Small / meta | 12/18 | 13/20 | 13/20 | 13/20 |
| Table / mono | 12/18 | 13/20 | 13/20 | 14/22 |

단위: px/px (font-size/line-height). 모바일 본문 14px 미만 금지.

### 8.4. 간격 스케일

4px 기본 그리드. 간격 토큰: 0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64. 모바일 섹션 간 간격 최소 16px, 데스크톱 24px 권장.

### 8.5. 터치 타겟 / 히트 영역

- 최소 44×44 CSS px (WCAG 2.5.5 AAA)
- 1차 액션 버튼 48×48 권장
- 인접 타겟 간 ≥ 8px 여백
- 리스트 행: 행 높이 52px 이상 (모바일)

### 8.6. 안전 영역 (Safe Area)

iOS notch, Android gesture bar 대응:
- `padding-top: env(safe-area-inset-top)`
- `padding-bottom: env(safe-area-inset-bottom)` (하단 탭 바에 반드시 적용)

### 8.7. 입력 모달리티 검출

- `@media (hover: hover) and (pointer: fine)` → 마우스/트랙패드
- `@media (hover: none) and (pointer: coarse)` → 터치
- JS: `navigator.maxTouchPoints > 0`로 폴백
- hover에만 의존하는 정보(툴팁 등)는 터치에서 탭으로 열림 대안 제공

### 8.8. 방향 (Orientation)

- 모바일 세로: 메인 지원
- 모바일 가로: 동작 보장, 브리핑 뷰는 세로 최적화 우선
- 태블릿 가로: 데스크톱에 준하는 레이아웃
- 태블릿 세로: 2열 그리드

---

## 9. UI 정보 아키텍처 (브레이크포인트별)

### 9.1. 최상위 네비게이션

| 브레이크포인트 | 네비 구조 |
|---|---|
| xs·sm | 하단 탭 바 5슬롯: **Briefing / Catalog / Fleets / Space Weather / More**. "More"에 Ground Stations, Conjunctions, Settings |
| md | 상단 앱바 + 햄버거 드로어 (전 메뉴 노출) |
| lg | 접이식 좌측 사이드 네비 (기본 접힘, 클릭 시 펼침) |
| xl+ | 고정 좌측 사이드 네비 (펼침 상태 기본) |

### 9.2. 데이터 출처 시각 규칙

| 배지 | 색 | 의미 |
|---|---|---|
| `OSINT` | 파랑 (예: `#2563EB`) | Celestrak/NOAA 직접 |
| `DERIVED` | 보라 (예: `#7C3AED`) | 자체 계산 (pass, maneuver, self-conjunction) |
| `USER` | 초록 (예: `#059669`) | 사용자 입력 |
| `STALE` | 회색 오버레이 + 타임스탬프 | 재검증 실패 |
| `⚠ divergence` | 노랑 | OSINT/USER 충돌 |

접근성: 색만으로 전달 금지. 배지는 아이콘 + 텍스트 병행.

### 9.3. 브리핑 뷰 — 레이아웃 매트릭스

브리핑 뷰는 **적응형**. 브레이크포인트별로 다른 정보 우선순위.

| 패널 | xs·sm (세로 스택 순서) | md (2열) | lg (3열) | xl+ (4열) |
|---|---|---|---|---|
| 1. 전역 경보 배너 (SWPC + SOCRATES degraded + offline) | P0 (최상단) | P0 (전폭) | P0 (전폭) | P0 (전폭) |
| 2. 플릿 건강 요약 (FMC% 등) | P1 | 좌 | 좌 | 좌1 |
| 3. 우주 기상 카드 (X-ray + Kp) | P2 | 우 | 중 | 좌2 |
| 4. 다음 근접 접근 (top 3) | P3 | 하좌 | 우 | 중1 |
| 5. 다음 패스 (사용자 위치 기준 top 3) | P4 | 하우 | 하좌 | 중2 |
| 6. 오픈 anomaly (top 5) | P5 (접힘) | 하좌 | 하중 | 우1 |
| 7. 플릿 구성원 테이블 | P6 (카드) | 하전폭 | 하우 | 우2 |
| 8. Decay 임박 (30d 이내) | P7 (접힘) | (접힘) | 우하 | 중3 |
| 9. 다가오는 사용자 이벤트 | P8 (접힘) | (접힘) | 우하2 | 우3 |
| 10. 2D 지도 (간이) | P9 (접힘) | 중간 전폭 | 좌하 | 좌3 |

- 모바일에서 P5 이하는 **기본 접힌 상태**. 헤더 + 간이 요약만 노출, 탭하여 펼침.
- 초기 로드 시 **P0–P4만 먼저 렌더링**. 나머지는 intersection observer 기반 lazy.

### 9.4. 카탈로그 뷰

| 브레이크포인트 | 레이아웃 |
|---|---|
| xs·sm | 상단 검색·필터 sticky + 카드 리스트 (각 카드: 이름·NORAD·궤도요약·플릿 추가 버튼). 무한 스크롤 |
| md | 좌 필터 드로어(오버레이) + 우 카드 그리드 (2열) |
| lg+ | 좌 고정 필터 사이드바 + 우 테이블 (전 컬럼: Name, NORAD, INTDES, Epoch, Apogee, Perigee, Incl, Period, 플릿 추가) |

필터: 그룹 프리셋(GPS-OPS, Starlink, Active, Weather, Stations 등), 궤도 영역(LEO/MEO/GEO), 국적, 상태, TLE freshness.

### 9.5. 플릿 관리

| 브레이크포인트 | 레이아웃 |
|---|---|
| xs·sm | 플릿 리스트 → 탭 상세. 멤버 추가는 카탈로그에서 "플릿에 추가" 경로. 드래그 재정렬 없음(긴 탭 후 상하 버튼) |
| md | 좌 플릿 리스트 + 우 멤버 편집 |
| lg+ | 좌 플릿 리스트 + 중 멤버 테이블 + 우 상세 패널 |

### 9.6. 커스텀 TLE 입력

**모바일에서 TLE 수기 입력은 비현실적**. 모바일은 아래 3 경로 우선:

1. **파일 import** (`.txt`, `.tle`, `.xml`, `.json`) — Capacitor-less, 브라우저 `<input type="file">`
2. **클립보드 붙여넣기** — 단건/복수 자동 감지
3. **카메라 OCR** — v2 COULD. iOS/Android live text 사용 가능하나 정확도 낮음. 보조 수단.

데스크톱은 **대량 편집 UI 제공** (모노스페이스 에디터, 체크섬 실시간 검증).

| 브레이크포인트 | TLE 입력 UX |
|---|---|
| xs·sm | 3개 큰 버튼: 파일 / 붙여넣기 / 수동입력(폴백). 수동입력은 한 번에 한 건. |
| md | 파일 drop zone + 모노스페이스 에디터. |
| lg+ | 좌 에디터(여러 건 붙여넣기) + 우 파싱 결과·에러 (행별). |

### 9.7. 2D 지도 / 3D 글로브

| 기기 | 기본 모드 | 이유 |
|---|---|---|
| 모바일 | **2D (Equirectangular)** | GPU·배터리·열. 3D는 설정에서 opt-in |
| 태블릿 | 2D 기본, 3D 가능 | 태블릿도 배터리 관리 필요. UI 토글 노출 |
| 데스크톱 | **3D** | 성능 여유 |

공통:
- 2D: 지구 평면 + 위성 sub-satellite point + 궤도 trail + 지상국 핀 + 사용자 위치
- 3D: `satellite.js` + WebGL/Three.js. LOD: 위성 수 > 500이면 심볼 축소, > 2000이면 trail 비활성
- 터치 제스처: 1손가락 드래그 = 회전(3D)/팬(2D), 2손가락 핀치 = 줌
- 키보드: `Arrow`/`+`/`-`/`0` (리셋)

**모바일 특수**: 배터리 20% 이하에서는 프레임율 30fps→15fps로 자동 낮춤. 백그라운드 탭은 즉시 정지 (`Page Visibility API`).

### 9.8. 테이블 패턴

| 브레이크포인트 | 패턴 |
|---|---|
| xs·sm | **카드**: 각 행 → 카드. 핵심 3–4 필드(이름·NORAD·궤도요약·상태 배지) 표면, 나머지는 "자세히" 접기 |
| md | **축약 테이블** + 가로 스크롤. 첫 컬럼 sticky (이름) |
| lg+ | **전체 테이블**. 컬럼 정렬·숨김 UI |

### 9.9. 폼 패턴

- 모바일: 1열, 단계별 disclosure. 큰 필드 레이블. 숫자 입력은 `inputmode="decimal"` 등 힌트.
- 데스크톱: 2열 가능, 인라인 검증.
- 위·경도 입력: 모바일 공용 "현재 위치 불러오기" CTA 상단 고정.

### 9.10. 스켈레톤 & 로딩

모든 주요 패널은 skeleton placeholder. **모바일은 P0–P4만 initial skeleton**, 하위는 뷰포트 진입 시 스켈레톤 표시.

---

## 10. PWA & 오프라인 전략

### 10.1. 매니페스트 (`manifest.webmanifest`)

```json
{
  "name": "CelesTrak Orbit Lab Pro",
  "short_name": "Orbit Lab",
  "start_url": "/utils/celestrak/?source=pwa",
  "display": "standalone",
  "orientation": "any",
  "theme_color": "#0B1020",
  "background_color": "#0B1020",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "screenshots": [
    { "src": "/screenshots/briefing-mobile.png", "sizes": "430x932", "form_factor": "narrow" },
    { "src": "/screenshots/briefing-desktop.png", "sizes": "1920x1200", "form_factor": "wide" }
  ],
  "categories": ["utilities", "productivity", "science"]
}
```

### 10.2. Service Worker 전략

| 리소스 | 전략 | TTL | 비고 |
|---|---|---|---|
| 정적 자산 (JS/CSS/이미지) | Cache-First + version-hash | 무제한 (새 버전 배포 시 교체) | Vite 번들 해시 활용 |
| 앱 셸 (HTML) | Network-First with fallback | — | 오프라인 시 `/offline.html` |
| GP/SATCAT 응답 | Stale-While-Revalidate | 헤더 존중 | 오프라인이면 stale 반환 |
| SWPC 응답 | Network-First, 실패 시 cache | 짧음 | 오프라인 시 last-known |
| SOCRATES/Decay | SWR | 헤더 | |
| IndexedDB | (SW 개입 없음) | — | 자체 영속 |

라이브러리: Workbox 7+ 또는 직접 구현.

### 10.3. 업데이트 UX

- 새 SW 설치 감지 시 상단 배너: "새 버전 사용 가능 - 새로고침". `skipWaiting` 사용자 승인 후.
- `navigator.onLine` + Fetch 실패 기반 오프라인 감지. 상단 얇은 배너 "오프라인 모드".

### 10.4. 데이터 절약 모드

`UserPreferences.dataSaver=true` 또는 `navigator.connection.saveData=true` 감지 시:
- 그룹 초기 로드 비활성 (사용자가 명시 선택한 그룹만)
- 3D 비활성 (강제 2D)
- X-ray 6-hour 대신 1-day (해상도 낮음, 크기 작음)

### 10.5. 설치 UX

- `beforeinstallprompt` 이벤트 가로채서 자체 설치 버튼 제공 (첫 방문 시 방해되지 않는 위치)
- iOS: 공식 A2HS 미지원. 가이드 모달 제공 ("공유 → 홈화면에 추가")

---

## 11. 기능 요구사항

### MUST (v1 릴리스 조건)

**F-MUST-01. 카탈로그 브라우저**
- 그룹 프리셋, 이름/INTDES/CATNR 검색, SATCAT 메타 표시, 플릿 추가
- 모바일 카드, 태블릿 축약 테이블, 데스크톱 전체 테이블
- 수락: 5000건 리스트 60fps, 검색 <200ms (로컬 인덱스)

**F-MUST-02. 커스텀 TLE/OMM 입력**
- 포맷: TLE/3LE/OMM-XML/OMM-JSON
- 경로: 파일 / 붙여넣기 / 수동입력(데스크톱 편집기)
- 인라인 검증, 1000건 일괄 import (Web Worker, 3s 이내)
- 카탈로그 충돌 시 `user:*` 네임스페이스
- Export/Import JSON (merge/replace)

**F-MUST-03. 2D 지도 + 3D 글로브 (기기별 기본값 적용)**
- 실시간 sub-satellite point, 궤도 trail, 가시권 음영
- 터치 제스처 + 키보드
- 시뮬레이션 시각 이동
- 수락: 500위성 동시 30fps (태블릿 기준)

**F-MUST-04. 사용자 위치 기반 가시성**
- 기본 서울, GPS 권한 선택, 수동 입력
- 복수 위치 저장(지상국)

**F-MUST-05. 플릿 관리 (CRUD)**
- 동일 위성 복수 플릿 가능
- 태그·displayName 오버라이드

**F-MUST-06. 운영 상태 입력**
- mcStatus, rfStatus, 노트
- 이력 기본 30개 보관
- UI에 OSINT/USER 시각 구분·divergence 경고

**F-MUST-07. Anomaly 로그**
- CRUD, 오픈/종료 필터, 심각도

**F-MUST-08. 운영자 브리핑 뷰 (반응형)**
- 섹션 9.3 레이아웃 매트릭스 준수
- 초기 로드 P0–P4 우선 렌더
- 모든 패널 fetched/recorded 타임스탬프 표시
- 수락: 모바일 초기 LCP <2.5s (Fast 3G), 데스크톱 <1.5s

**F-MUST-09. 태양 플레어 · 지자기 패널**
- X-ray 시계열(1d), 현재 flare class
- Kp 현재 + 3일 예보
- 심각도 색상 단계 (접근성 고려)

**F-MUST-10. 근접 접근 대시보드 (SOCRATES)**
- 정규화 리스트, 플릿 멤버 필터
- degraded 배너

**F-MUST-11. Pass 가시성 캘린더**
- 지상국 × 위성 × 시간 윈도우
- 모바일: 리스트 뷰 기본, 캘린더 토글
- 데스크톱: 캘린더 뷰 기본
- 수락: 5지상국×50위성×24h Web Worker에서 <5s

**F-MUST-12. Decay 예측 통합**
- 플릿 교집합 강조, 30일 이내 브리핑 노출

**F-MUST-13. PWA 설치·오프라인**
- 매니페스트, 아이콘, 스크린샷
- Service Worker: 앱 셸 + API SWR
- 오프라인 상태 배너, last-cached 표시
- 설치 프롬프트 커스텀, iOS 가이드

**F-MUST-14. 반응형 레이아웃**
- xs/sm/md/lg/xl 전 범위 동작
- Tier-1 기기 테스트 통과

**F-MUST-15. 데이터 절약 모드**
- 자동 감지 + 수동 토글
- 자동 fetch 억제, 강제 2D

### SHOULD (v1.1)

- F-SHOULD-01. Maneuver Detection (연속 TLE delta 기반, 거짓양성율 공개)
- F-SHOULD-02. 자체 근접 접근 (엣지 스크리닝)
- F-SHOULD-03. 사용자 이벤트 스케줄 + 브리핑 타임라인 병합
- F-SHOULD-04. 경보 규칙 (임계 기반 UI 알림)
- F-SHOULD-05. 카메라 OCR (TLE 인식) — 베타
- F-SHOULD-06. 웹 푸시 (데스크톱/Android)

### COULD (v2+)

- 다중 사용자 (D1 + Access)
- 공개 공유 링크 (읽기 전용 스냅샷)
- CSV/OMM XML export 고급
- 플릿 간 비교 뷰
- WebGPU 렌더러
- 네이티브 알림 (iOS Safari push 확대 시)

---

## 12. 비기능 요구사항

### 12.1. 성능 예산 (기기 티어별)

| 지표 | 모바일 (Low) | 모바일 (Mid) | 태블릿 | 데스크톱 |
|---|---|---|---|---|
| LCP (4G) | ≤ 3.0s | ≤ 2.5s | ≤ 2.0s | ≤ 1.5s |
| LCP (Fast 3G) | ≤ 4.5s | ≤ 3.5s | ≤ 3.0s | — |
| INP | ≤ 200ms | ≤ 150ms | ≤ 100ms | ≤ 100ms |
| CLS | ≤ 0.1 | ≤ 0.1 | ≤ 0.1 | ≤ 0.1 |
| 메인 JS 번들 (gzip) | ≤ 200KB | ≤ 250KB | ≤ 250KB | ≤ 300KB |
| 위성 500개 렌더 | 30fps | 45fps | 60fps | 60fps |
| SGP4 단일 프롭 | ≤ 100µs | ≤ 50µs | ≤ 30µs | ≤ 20µs |
| Pass 예측 (5×50×24h) | ≤ 15s | ≤ 8s | ≤ 5s | ≤ 3s |
| 1000 TLE 파싱 | ≤ 10s | ≤ 5s | ≤ 3s | ≤ 2s |
| 초기 Service Worker precache | ≤ 2MB | ≤ 2MB | ≤ 2MB | ≤ 3MB |

**기기 티어 기준**: Low=iPhone SE(2020)·Pixel 4a급, Mid=iPhone 13·Pixel 7급, 태블릿=iPad(9세대)+, 데스크톱=일반 노트북.

### 12.2. 접근성 (WCAG 2.1 AA)

- 색상만으로 정보 전달 금지 (모든 상태에 아이콘+텍스트)
- 키보드 전체 조작, 포커스 링 가시
- 스크린 리더: `aria-live` 로 업데이트 알림 (SWPC 경보, SOCRATES degraded 등)
- 3D 뷰는 대체 리스트 뷰 필수 제공 (스크린 리더용)
- `prefers-reduced-motion` 준수 (궤도 애니메이션 정지)
- `prefers-color-scheme` 지원 (기본 시스템)
- 터치 타겟 44×44 (AAA 기준 적용)
- 확대/축소 pinch-zoom 허용 (`user-scalable=yes`)

### 12.3. 보안

- CSP: `default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self'; manifest-src 'self'`
- 외부 도메인 접근은 엣지 프록시를 통해서만
- SRI: 3rd-party JS 번들 인라인
- 사용자 입력(notes, tags) XSS 방지: 렌더링 시 텍스트화 (v1 Markdown 미지원)
- 비밀값 없음

### 12.4. i18n / l10n

- 기본 한국어·영어. 추가 언어는 v2.
- 문자열 외부화 (i18next 또는 동등)
- 날짜: 사용자 locale + UTC 동시 표기
- 숫자: 국가별 구분자·단위 전환 (km/mi, km/s 등)
- 폰트: 한글 웹폰트 + 영문 서브셋, `font-display: swap`
- RTL 비지원 (v1)

### 12.5. 개인정보

- 위치정보: 브라우저 Geolocation API, **엣지로 전송 금지**
- 사용자 플릿·ops·anomaly: 디바이스 이탈 없음
- 엣지 로그: 쿼리 파라미터(GROUP/CATNR/NAME/INTDES)만, 사용자 식별자 없음
- 쿠키 미사용 (v1)

### 12.6. 저작권

- Celestrak: 데이터 출처 표시 (푸터 + 각 패널 정보 아이콘 tooltip)
- NOAA: public domain, 출처 표시 관행 준수
- satellite.js / Three.js: MIT·라이선스 표기

---

## 13. 관측성

### 13.1. 로깅 (엣지)

Workers `console.log` → Logpush (선택)

- 필드: `ts`, `cf-ray`, `route`, `upstream_status`, `cache_status` (HIT/MISS/STALE), `duration_ms`, `parser_version`, `client_country` (coarse)

### 13.2. 메트릭 (Analytics Engine)

- 경로별 QPS
- 캐시 hit 비율 (경로별)
- 외부 API 지연 히스토그램
- SOCRATES 파싱 실패 카운터
- TLE 파서 에러 카운터
- RUM: Core Web Vitals (기기 티어 라벨)

### 13.3. 알림

- SOCRATES 파서 실패 연속 3회 → Slack 웹훅
- NOAA SWPC 장애 10분+ → Slack
- Celestrak GP 재검증 실패 1h+ → Slack
- 엣지 5xx 비율 1% 초과 → Slack

---

## 14. 테스트 전략

### 14.1. 단위·통합

- **SGP4 검증 벡터**: Vallado et al. (AIAA 2006-6753) 공개 테스트 세트. satellite.js 오차 허용치 고정.
- **TLE 파서**: 체크섬, 컬럼 오프셋, 2/3라인, 9자리 catalog 명시 실패.
- **OMM 파서**: CCSDS 예제, 선택 필드 부재.
- **SOCRATES 파서**: HTML 스냅샷 회귀, CI 주간 스모크.
- **정규화 계층**: `OrbitalElementSet` 필드 완결성·파생 정확성.
- **저장 어댑터**: `FleetStore` 계약 테스트 (InMemory/IndexedDB 공통).
- **Service Worker**: Workbox 시뮬레이션, 오프라인 시나리오.

### 14.2. E2E (기기 매트릭스)

Playwright 프로젝트 설정:

| 프로젝트 | 디바이스 에뮬 | 브라우저 |
|---|---|---|
| desktop-chrome | 1920×1080 | Chromium |
| desktop-firefox | 1920×1080 | Firefox |
| desktop-safari | 1920×1080 | WebKit |
| tablet-ipad | iPad Pro | WebKit |
| tablet-android | Galaxy Tab S7 | Chromium |
| mobile-ios | iPhone 13 | WebKit |
| mobile-android | Pixel 7 | Chromium |
| mobile-small | iPhone SE | WebKit |

핵심 시나리오:
- 커스텀 TLE 10건 import → 플릿 생성 → 브리핑 로드 → 패스 캘린더 확인
- SOCRATES degraded 배너 노출
- 시뮬레이션 시각 이동 후 위성 위치 일관성
- 오프라인 전환 후 마지막 캐시 렌더링
- PWA 설치 프롬프트 (Chrome Android)
- 데이터 절약 모드 활성 시 3D 강제 비활성

### 14.3. 시각 회귀

- Percy 또는 Chromatic
- 4 브레이크포인트 × 6 주요 페이지 = 24 스냅샷 최소
- 다크/라이트 모드 각각

### 14.4. 성능 테스트

- Lighthouse CI: 모바일 에뮬 성능 ≥90, 접근성 ≥95, PWA ≥ 95
- WebPageTest: Fast 3G / 4G 프로파일
- Chrome DevTools `Performance` 수동 확인 (저사양 CPU 4x throttle)

### 14.5. 접근성

- axe-core 자동 CI gate (위반 0)
- 키보드 전용 수동 체크리스트
- VoiceOver / TalkBack 수동 샘플 검증

### 14.6. 실기기 테스트

최소 1회/릴리스:
- iPhone SE (Low), iPhone 15 (Mid)
- Pixel 6a (Low), Pixel 8 (Mid)
- iPad Air, Galaxy Tab S7
- MacBook + Chrome/Safari
- Windows Chrome/Edge

---

## 15. 리스크 레지스터

| 리스크 | 영향 | 가능성 | 대응 |
|---|---|---|---|
| SOCRATES HTML 구조 변경 | 근접 접근 기능 불능 | 중 | 파서 버전 핀 + 스냅샷 회귀 + stale fallback + 알림 |
| Celestrak 예절 위반 차단 | 전체 장애 | 낮 | 엣지 단일 경유 + 2h s-maxage |
| 9자리 catalog 전환 누락 | 신 위성 데이터 결손 | 중 | OMM 전용 정책 |
| IndexedDB 쿼터 부족/삭제 | 사용자 데이터 소실 | 저–중 | 쓰기 실패 감지·export 유도·trimming 정책 |
| 자체 all-vs-all 비용 폭발 | 응답 지연 | 중 | 1차 apogee/perigee 필터 + 시간 bucketing + Web Worker/엣지 분리 |
| 사용자 입력 데이터 신뢰 오용 | 의사결정 위험 | 중 | origin 배지·타임스탬프·divergence 경고·면책 |
| NOAA SWPC 엔드포인트 변경 | 우주기상 결손 | 저 | schema 계약 테스트, 버전 고정 |
| SGP4 장기 예측 오차 | Pass 오차 | 중 | 기본 예측 48h, 장기 시 경고 |
| 3D 렌더 모바일 열/배터리 | 기기 과열·사용자 이탈 | 중 | 모바일 기본 2D, 배터리 ≤20% 시 자동 fallback |
| iOS Safari PWA 제한 | 설치·푸시 불가 | 중 | A2HS 가이드 모달, 푸시 비의존 설계 |
| 저가 모바일 성능 미달 | Core Web Vitals 실패 | 중 | 데이터 절약 모드·코드 분할·Worker 이전 |
| localStorage ↔ IndexedDB 마이그레이션 버그 | 기존 사용자 데이터 손상 | 저–중 | schemaVersion 기반 자동 마이그레이션·롤백 |
| Service Worker 캐시 오염 | 구 버전 고착 | 저 | 버전 해시·skipWaiting 사용자 승인 UX |
| 태블릿 가로/세로 전환 레이아웃 버그 | UX 저하 | 중 | orientationchange 테스트 케이스 |

---

## 16. 마일스톤 / 단계 배포

| M | 기간 | 범위 |
|---|---|---|
| **M0 — 1주** | 기존 페이지 리브랜드, origin 배지 프로토타입, 브레이크포인트·디자인 토큰 정립 |
| **M1 — 2주** | IndexedDB 기반 `FleetStore`, 커스텀 TLE 영구 저장, 플릿 CRUD, import/export, 반응형 카탈로그 뷰 |
| **M2 — 2주** | OperationalStatus, Anomaly, 지상국, Pass 캘린더 (Web Worker 기반) |
| **M3 — 2주** | SWPC 패널, Decay 통합, 브리핑 뷰 v1 (반응형 레이아웃 매트릭스 구현) |
| **M4 — 2주** | SOCRATES 파서·대시보드, degraded UX |
| **M5 — 2주** | **PWA 완성**: Service Worker, 매니페스트, 오프라인 배너, 설치 UX, 데이터 절약 모드 |
| **M6 — 1주** | 관측성·운영: Logpush, Analytics Engine, 알림, 성능 튜닝, Lighthouse CI 게이트 |
| **M7 — 1주 (선택)** | F-SHOULD: Maneuver detection, self-conjunction, 이벤트 스케줄 |

총 13주 (MUST 범위 12주). 기기 매트릭스 테스트는 M2 이후부터 각 마일스톤 종료 시 실시.

---

## 17. 공개 질문 (스펙 확정을 위한 잔존 결정)

1. **프런트엔드 프레임워크**: 기존 `blue-rabbit.kr/utils/celestrak`의 스택(추정: Next.js 기반?) 재사용 vs. 독립 번들. 반응형·PWA 요구 고려 시 Next.js App Router + Workbox 조합 또는 Vite + React 조합 우선 검토.
2. **3D 렌더 라이브러리**: Three.js vs. Cesium vs. 기존 구현 재활용. Cesium은 기능 풍부하나 번들 큼(모바일 예산 위반 가능). 본 스펙은 **Three.js + 자체 레이어** 전제.
3. **CSS 접근법**: Tailwind(+CQ) vs. CSS Modules + design tokens. 본 스펙은 **Tailwind + CSS Custom Properties**를 기본으로 기술.
4. **알림 채널 범위**: v1 UI 인앱 배지만 vs. 웹 푸시 포함. 현재 스펙은 **인앱 전용**, 푸시는 SHOULD.
5. **브리핑 뷰 시각 스타일**: 레퍼런스 이미지 Style 1/2/3 중 지향 vs. 독자. 스펙은 정보 아키텍처만 규정, 시각 디자인은 별도 UX 단계.
6. **카메라 OCR (TLE 인식)**: 모바일 UX 강화에 유용하나 v1 범위 포함 여부. 현재 SHOULD.
7. **지상국 관리 복수**: 상한 N (기본 20?) 정의.
8. **ops status 이력 보관 정책**: 기본 30개 vs. 시간 기반 (90일) vs. 무제한. 무제한은 쿼터 리스크.

---

## 18. 부록

### 부록 A. CelesTrak GP Query 포맷 매트릭스

| FORMAT | 9-digit 지원 | 파싱 용이 | 크기 |
|---|---|---|---|
| TLE / 3LE / 2LE | ❌ | 체크섬 | 최소 |
| OMM-XML | ✅ | CCSDS 스키마 | 大 (~7×) |
| OMM-KVN | ✅ | 텍스트 | 중 |
| JSON / JSON-PRETTY | ✅ | ad-hoc | 중 (~3×) |
| CSV | ✅ | ad-hoc | 최소 |

**본 스펙 채택**: 엣지 요청 JSON, 사용자 export OMM-XML/JSON 선택.

### 부록 B. NOAA SWPC 엔드포인트 참조

- X-ray 1d: `json/goes/primary/xrays-1-day.json`
- X-ray 6h: `json/goes/primary/xrays-6-hour.json`
- Planetary K: `products/noaa-planetary-k-index.json`
- 3-day forecast: `text/3-day-forecast.txt`
- Alerts: `products/alerts.json`

도메인: `services.swpc.noaa.gov`

### 부록 C. 결정 기록 (누적)

| # | 결정 | 버전 | 비고 |
|---|---|---|---|
| 1 | 제품 포지셔닝 = C (사용자 입력 수용형) | v0.1 | origin 배지·divergence UX 필수 |
| 2 | 브라우저 영구 저장 = B (복수 import + 영구) | v0.1 | v0.2에서 IndexedDB로 상향 |
| 3 | 부가 데이터 = 전체 (SWPC/SOCRATES/Decay/Pass) | v0.1 | |
| 4 | **기기 지원 = PC/태블릿/모바일 웹** | v0.2 | Tier-1 기기 매트릭스 정의 |
| 5 | **PWA 채택 + 오프라인 지원** | v0.2 | Service Worker + 매니페스트 |
| 6 | **IndexedDB 기본, localStorage 보조** | v0.2 | 용량·오프라인·대량 import 요구 |
| 7 | **모바일 기본 2D, 3D opt-in** | v0.2 | 배터리·열 관리 |
| 8 | **TLE/3LE 응답 포맷 금지** | v0.1 | 9-digit catalog 대비 |

### 부록 D. 브레이크포인트 토큰 참조

```css
:root {
  --bp-sm: 480px;
  --bp-md: 768px;
  --bp-lg: 1024px;
  --bp-xl: 1280px;
  --bp-2xl: 1536px;

  /* 간격 */
  --space-1: 4px; --space-2: 8px; --space-3: 12px;
  --space-4: 16px; --space-5: 20px; --space-6: 24px;
  --space-8: 32px; --space-10: 40px; --space-12: 48px; --space-16: 64px;

  /* 페이지 여백 */
  --page-pad: 16px;
  /* 타이포그래피 스케일 등은 Tailwind config 참조 */
}

@media (min-width: 480px)  { :root { --page-pad: 24px; } }
@media (min-width: 768px)  { :root { --page-pad: 32px; } }
@media (min-width: 1280px) { :root { --page-pad: 48px; } }
```

### 부록 E. Service Worker 라이프사이클

```
install  → precache(app-shell, icons, core CSS/JS)
activate → cleanup old caches (by version hash)
fetch    → route match:
  - /api/*      : SWR
  - *.html      : NetworkFirst → offline fallback
  - *.{js,css}  : CacheFirst (hashed)
  - images      : CacheFirst with expiry (7d)
message  → SKIP_WAITING on user confirm
```
