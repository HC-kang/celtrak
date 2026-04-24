export function formatTimestamp(value?: string) {
  if (!value) return '시간 정보 없음';
  const date = new Date(value);
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatRelative(value?: string) {
  if (!value) return '알 수 없음';
  const delta = new Date(value).getTime() - Date.now();
  const absMinutes = Math.round(Math.abs(delta) / 60000);
  if (absMinutes < 60) {
    return delta >= 0 ? `${absMinutes}분 후` : `${absMinutes}분 전`;
  }
  const absHours = Math.round(absMinutes / 60);
  if (absHours < 48) {
    return delta >= 0 ? `${absHours}시간 후` : `${absHours}시간 전`;
  }
  const absDays = Math.round(absHours / 24);
  return delta >= 0 ? `${absDays}일 후` : `${absDays}일 전`;
}

export function formatNumber(value: number | null | undefined, maximumFractionDigits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits }).format(value);
}

export function formatPercent(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function truncate(text: string, length = 120) {
  if (text.length <= length) return text;
  return `${text.slice(0, length - 1)}…`;
}
