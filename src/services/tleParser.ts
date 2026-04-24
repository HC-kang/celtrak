import * as satellite from 'satellite.js';
import type { CustomTLE, OrbitalElementSet, TleRaw } from '@/domain/types';

interface ParsedImport {
  entries: CustomTLE[];
  errors: string[];
}

export function parseImportedText(rawText: string, sourceLabel?: string): ParsedImport {
  const text = rawText.trim();
  if (!text) return { entries: [], errors: ['입력 데이터가 비어 있습니다.'] };

  if (text.startsWith('{') || text.startsWith('[')) {
    return parseOmmJson(text, sourceLabel);
  }

  if (text.startsWith('<')) {
    return parseOmmXml(text, sourceLabel);
  }

  return parseTleText(text, sourceLabel);
}

function parseTleText(text: string, sourceLabel?: string): ParsedImport {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const entries: CustomTLE[] = [];
  const errors: string[] = [];

  let index = 0;
  while (index < lines.length) {
    let name: string | undefined;
    let line1 = lines[index];
    let line2 = lines[index + 1];
    let format: 'TLE' | '3LE' = 'TLE';

    if (line1.startsWith('0 ') || (!line1.startsWith('1 ') && lines[index + 1]?.startsWith('1 '))) {
      name = line1.replace(/^0\s*/, '').trim();
      line1 = lines[index + 1];
      line2 = lines[index + 2];
      format = '3LE';
      index += 3;
    } else {
      index += 2;
    }

    if (!line1?.startsWith('1 ') || !line2?.startsWith('2 ')) {
      errors.push(`${name ?? `항목 ${entries.length + errors.length + 1}`}: TLE 라인 구조가 올바르지 않습니다.`);
      continue;
    }

    try {
      const parsed = parseTleLines(name ?? 'Custom TLE', line1, line2, format);
      entries.push({
        id: crypto.randomUUID(),
        name: name ?? parsed.catalogNumber.toString(),
        format,
        raw: [name, line1, line2].filter(Boolean).join('\n'),
        parsed,
        sourceLabel,
        addedAt: new Date().toISOString(),
        schemaVersion: 1,
      });
    } catch (error) {
      errors.push(`${name ?? 'Unknown'}: ${(error as Error).message}`);
    }
  }

  return { entries, errors };
}

function parseOmmJson(text: string, sourceLabel?: string): ParsedImport {
  const payload = JSON.parse(text);
  const objects = Array.isArray(payload) ? payload : [payload];
  const entries: CustomTLE[] = [];
  const errors: string[] = [];

  for (const object of objects) {
    if (!object || typeof object !== 'object') {
      errors.push('OMM JSON 항목 형식이 잘못되었습니다.');
      continue;
    }

    const result = parseOmmLike(object, 'OMM-JSON', sourceLabel);
    if ('error' in result) errors.push(result.error);
    else entries.push(result.entry);
  }

  return { entries, errors };
}

function parseOmmXml(text: string, sourceLabel?: string): ParsedImport {
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'application/xml');
  const segments = [...xml.querySelectorAll('segment')];
  const entries: CustomTLE[] = [];
  const errors: string[] = [];

  if (!segments.length) {
    errors.push('OMM XML에서 segment를 찾지 못했습니다.');
  }

  for (const segment of segments) {
    const lookup = (tagName: string) => segment.querySelector(tagName)?.textContent?.trim();
    const object = {
      OBJECT_NAME: lookup('OBJECT_NAME'),
      NORAD_CAT_ID: lookup('NORAD_CAT_ID'),
      EPOCH: lookup('EPOCH'),
      MEAN_MOTION: lookup('MEAN_MOTION'),
      ECCENTRICITY: lookup('ECCENTRICITY'),
      INCLINATION: lookup('INCLINATION'),
      RA_OF_ASC_NODE: lookup('RA_OF_ASC_NODE'),
      ARG_OF_PERICENTER: lookup('ARG_OF_PERICENTER'),
      MEAN_ANOMALY: lookup('MEAN_ANOMALY'),
      BSTAR: lookup('BSTAR'),
    };
    const result = parseOmmLike(object, 'OMM-XML', sourceLabel, text);
    if ('error' in result) errors.push(result.error);
    else entries.push(result.entry);
  }

  return { entries, errors };
}

function parseOmmLike(
  object: Record<string, unknown>,
  format: 'OMM-XML' | 'OMM-JSON',
  sourceLabel?: string,
  rawPayload?: string,
) {
  const catalogNumber = Number(object.NORAD_CAT_ID);
  const epoch = String(object.EPOCH ?? '');
  const meanMotion = Number(object.MEAN_MOTION);
  const eccentricity = Number(object.ECCENTRICITY);
  const inclination = Number(object.INCLINATION);
  const raan = Number(object.RA_OF_ASC_NODE);
  const argPericenter = Number(object.ARG_OF_PERICENTER);
  const meanAnomaly = Number(object.MEAN_ANOMALY);
  const bstar = Number(object.BSTAR ?? 0);
  const name = String(object.OBJECT_NAME ?? `OMM ${catalogNumber || 'unknown'}`);

  if (!catalogNumber || !epoch || !meanMotion) {
    return { error: `${name}: OMM 필수 필드가 부족합니다.` };
  }

  const orbital = createOrbitalElementSet({
    catalogNumber,
    epoch,
    meanMotionRevPerDay: meanMotion,
    eccentricity,
    inclinationDeg: inclination,
    raanDeg: raan,
    argOfPericenterDeg: argPericenter,
    meanAnomalyDeg: meanAnomaly,
    bstar,
    raw: {
      format,
      payload: rawPayload ?? JSON.stringify(object),
    },
    source: 'user-omm',
    fetchedAt: new Date().toISOString(),
  });

  return {
    entry: {
      id: crypto.randomUUID(),
      name,
      format,
      raw: rawPayload ?? JSON.stringify(object, null, 2),
      parsed: orbital,
      sourceLabel,
      addedAt: new Date().toISOString(),
      schemaVersion: 1,
    } satisfies CustomTLE,
  };
}

export function parseTleLines(name: string, line1: string, line2: string, format: 'TLE' | '3LE' = 'TLE') {
  satellite.twoline2satrec(line1, line2);
  const catalogNumber = Number(line1.slice(2, 7).trim());
  const meanMotionRevPerDay = Number(line2.slice(52, 63).trim());
  const eccentricity = Number(`0.${line2.slice(26, 33).trim()}`);
  const inclinationDeg = Number(line2.slice(8, 16).trim());
  const raanDeg = Number(line2.slice(17, 25).trim());
  const argOfPericenterDeg = Number(line2.slice(34, 42).trim());
  const meanAnomalyDeg = Number(line2.slice(43, 51).trim());
  const bstar = parseBstar(line1.slice(53, 61));
  const epoch = tleEpochToIso(line1.slice(18, 32));

  return createOrbitalElementSet({
    catalogNumber,
    epoch,
    meanMotionRevPerDay,
    eccentricity,
    inclinationDeg,
    raanDeg,
    argOfPericenterDeg,
    meanAnomalyDeg,
    bstar,
    raw: {
      format,
      line0: name,
      line1,
      line2,
    } satisfies TleRaw,
    source: 'user-tle',
    fetchedAt: new Date().toISOString(),
  });
}

function createOrbitalElementSet(input: Omit<OrbitalElementSet, 'semiMajorAxisKm' | 'apogeeKm' | 'perigeeKm' | 'periodMinutes'>): OrbitalElementSet {
  const mu = 398600.4418;
  const meanMotionRadPerSecond = (input.meanMotionRevPerDay * 2 * Math.PI) / 86400;
  const semiMajorAxisKm = Math.cbrt(mu / (meanMotionRadPerSecond ** 2));
  const apogeeKm = semiMajorAxisKm * (1 + input.eccentricity) - 6378.137;
  const perigeeKm = semiMajorAxisKm * (1 - input.eccentricity) - 6378.137;
  const periodMinutes = 1440 / input.meanMotionRevPerDay;

  return {
    ...input,
    semiMajorAxisKm,
    apogeeKm,
    perigeeKm,
    periodMinutes,
  };
}

function parseBstar(raw: string) {
  const normalized = raw.trim();
  if (!normalized) return 0;
  const sign = normalized.startsWith('-') ? -1 : 1;
  const mantissa = Number(`0.${normalized.slice(1, 6).replace(/[^\d]/g, '')}`);
  const exponent = Number(normalized.slice(-2));
  return sign * mantissa * 10 ** exponent;
}

function tleEpochToIso(raw: string) {
  const yearFragment = Number(raw.slice(0, 2));
  const dayOfYear = Number(raw.slice(2));
  const year = yearFragment < 57 ? 2000 + yearFragment : 1900 + yearFragment;
  const date = new Date(Date.UTC(year, 0, 1));
  date.setUTCDate(date.getUTCDate() + Math.floor(dayOfYear) - 1);
  const fraction = dayOfYear % 1;
  date.setUTCHours(0, fraction * 24 * 60, 0, 0);
  return date.toISOString();
}
