import type { MediaRole } from '../types';

export function formatTimecode(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00.000';
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  const whole = Math.floor(rem);
  const ms = Math.round((rem - whole) * 1000);
  return `${String(mins).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function formatShortTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0';
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${mins}:${rem.toFixed(1).padStart(4, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function roleLabel(role: MediaRole): string {
  switch (role) {
    case 'reference':
      return 'Reference Motion';
    case 'edited':
      return 'Edited Cut';
    case 'rendered':
      return 'Rendered Output';
    case 'audio':
      return 'Audio Track';
  }
}

export function roleShortLabel(role: MediaRole): string {
  switch (role) {
    case 'reference':
      return 'Reference';
    case 'edited':
      return 'Edited';
    case 'rendered':
      return 'Rendered';
    case 'audio':
      return 'Audio';
  }
}
