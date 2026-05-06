export interface KasaScaleWindow {
  current: string | null;
  previous24: string | null;
  previous48: string | null;
}

export interface KasaProbabilityWindow {
  startHour: number;
  endHour: number;
  minorPct: number | null;
  majorPct: number | null;
}

export interface KasaKindexPoint {
  t: string;
  kp: number | null;
  kk: number | null;
}

export interface KasaSpaceWeatherSupplement {
  fetchedAt: string;
  stale?: boolean;
  warn?: {
    lastUpdate?: string;
    r: KasaScaleWindow;
    s: KasaScaleWindow;
    g: KasaScaleWindow;
  };
  prob?: {
    issuedAt?: string;
    r: KasaProbabilityWindow[];
    s: KasaProbabilityWindow[];
    g: KasaProbabilityWindow[];
  };
  kindex?: {
    observedAt?: string;
    currentKp: number | null;
    currentKk: number | null;
    max24Kp: number | null;
    max24Kk: number | null;
    series: KasaKindexPoint[];
  };
}

export function normalizeKasaSupplement(options: {
  fetchedAt: string;
  warn?: unknown;
  prob?: unknown;
  kindex?: unknown;
  stale?: boolean;
}): KasaSpaceWeatherSupplement {
  const warn = normalizeKasaWarn(options.warn);
  const prob = normalizeKasaProb(options.prob);
  const kindex = normalizeKasaKindex(options.kindex);
  return {
    fetchedAt: options.fetchedAt,
    stale: options.stale || (!warn && !prob && !kindex) ? true : undefined,
    warn: warn ?? undefined,
    prob: prob ?? undefined,
    kindex: kindex ?? undefined,
  };
}

export function normalizeKasaWarn(raw: unknown): KasaSpaceWeatherSupplement['warn'] | null {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!record || record.Error === true) return null;
  const warn = record.Warn && typeof record.Warn === 'object' ? (record.Warn as Record<string, unknown>) : null;
  if (!warn) return null;
  return {
    lastUpdate: normalizeEpochMillis(record.LastUpdate),
    r: normalizeScaleWindow(warn.R),
    s: normalizeScaleWindow(warn.S),
    g: normalizeScaleWindow(warn.G),
  };
}

export function normalizeKasaProb(raw: unknown): KasaSpaceWeatherSupplement['prob'] | null {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!record || record.Error === true) return null;
  const prob = record.prob && typeof record.prob === 'object' ? (record.prob as Record<string, unknown>) : null;
  if (!prob) return null;
  return {
    issuedAt: normalizeKasaLocalTime(prob.date),
    r: [
      probabilityWindow(0, 24, prob.R1D1, prob.R3D1),
      probabilityWindow(24, 48, prob.R1D2, prob.R3D2),
      probabilityWindow(48, 72, prob.R1D3, prob.R3D3),
    ],
    s: [
      probabilityWindow(0, 24, prob.S1D1, prob.S3D1),
      probabilityWindow(24, 48, prob.S1D2, prob.S3D2),
      probabilityWindow(48, 72, prob.S1D3, prob.S3D3),
    ],
    g: [
      probabilityWindow(0, 24, prob.G1MD1, prob.G2MD1),
      probabilityWindow(24, 48, prob.G1MD2, prob.G2MD2),
      probabilityWindow(48, 72, prob.G1MD3, prob.G2MD3),
    ],
  };
}

export function normalizeKasaKindex(raw: unknown): KasaSpaceWeatherSupplement['kindex'] | null {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!record || record.Error === true) return null;
  const kindex = record.Kindex && typeof record.Kindex === 'object' ? (record.Kindex as Record<string, unknown>) : null;
  if (!kindex) return null;
  const series = Array.isArray(kindex.Recent)
    ? kindex.Recent.map((item) => {
        const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        return {
          t: normalizeKasaUtcTime(row.Time),
          kp: numberOrNull(row.Kp),
          kk: numberOrNull(row.Kk),
        };
      })
        .filter((row): row is KasaKindexPoint => Boolean(row.t))
        .sort((left, right) => left.t.localeCompare(right.t))
    : [];

  return {
    observedAt: normalizeKasaUtcTime(kindex.Time),
    currentKp: numberOrNull(kindex.CurrentP),
    currentKk: numberOrNull(kindex.CurrentK),
    max24Kp: numberOrNull(kindex.Max24P),
    max24Kk: numberOrNull(kindex.Max24K),
    series,
  };
}

function normalizeScaleWindow(raw: unknown): KasaScaleWindow {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    current: cleanString(record.v0) ?? null,
    previous24: cleanString(record.v1) ?? null,
    previous48: cleanString(record.v2) ?? null,
  };
}

function probabilityWindow(startHour: number, endHour: number, minor: unknown, major: unknown): KasaProbabilityWindow {
  return {
    startHour,
    endHour,
    minorPct: numberOrNull(minor),
    majorPct: numberOrNull(major),
  };
}

function normalizeEpochMillis(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const date = new Date(number);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function normalizeKasaUtcTime(value: unknown) {
  const text = cleanString(value);
  if (!text) return undefined;
  const parsed = new Date(`${text.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function normalizeKasaLocalTime(value: unknown) {
  const text = cleanString(value);
  if (!text) return undefined;
  const parsed = new Date(`${text.replace(' ', 'T')}+09:00`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function numberOrNull(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanString(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}
