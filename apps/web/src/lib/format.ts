import { format, formatDistanceToNow, isToday, isTomorrow, isYesterday, parseISO } from 'date-fns';

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

/** Compact human timestamp: "14:00 today", "Tue 09:30", "Mar 4". */
export function smartTime(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = parseISO(iso);
    if (isToday(d)) return `${format(d, 'HH:mm')} today`;
    if (isTomorrow(d)) return `${format(d, 'HH:mm')} tomorrow`;
    if (isYesterday(d)) return `yesterday ${format(d, 'HH:mm')}`;
    return format(d, 'EEE MMM d');
  } catch {
    return '';
  }
}

export function fullDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return format(parseISO(iso), 'EEEE, MMMM d yyyy · HH:mm');
  } catch {
    return '';
  }
}

export function fileSize(bytes: number | null | undefined): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
