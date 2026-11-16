import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeAudioEnvelope,
  detectSceneCuts,
  probeMedia,
} from './mediaProcessor.ts';
import { MEDIA_DIR, ensureDataDirs, studioStore } from './store.ts';
import type { MediaAsset, MediaKind, MediaRole, MediaSourceType } from './types.ts';

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

export function inferMimeFromPath(filePath: string, fallback = 'video/mp4'): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? fallback;
}

export async function ingestMediaFile(params: {
  filePath: string;
  title: string;
  role: MediaRole;
  sourceType: MediaSourceType;
  mimeType?: string;
  originalUrl?: string;
  notes?: string;
}): Promise<MediaAsset> {
  const resolved = path.resolve(params.filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${resolved}`);
  }

  const probe = await probeMedia(resolved);
  if (!probe.hasVideo && !probe.hasAudio) {
    throw new Error('ffprobe could not detect a valid video or audio stream.');
  }

  const kind: MediaKind = probe.hasVideo ? 'video' : 'audio';
  const cuts = probe.hasVideo ? await detectSceneCuts(resolved) : [];
  const envelope = probe.hasAudio
    ? await analyzeAudioEnvelope(resolved, probe.durationSec, { bins: 96 })
    : null;
  const waveformPeaks = envelope ? envelope.bins.map((b) => Math.round(b.peak * 1000) / 1000) : [];

  const asset: MediaAsset = {
    id: crypto.randomUUID().slice(0, 12),
    title: params.title.trim() || path.basename(resolved),
    role: params.role,
    kind,
    sourceType: params.sourceType,
    filePath: resolved,
    originalUrl: params.originalUrl,
    mimeType: params.mimeType ?? inferMimeFromPath(resolved, kind === 'video' ? 'video/mp4' : 'audio/mpeg'),
    sizeBytes: stat.size,
    createdAt: new Date().toISOString(),
    probe,
    cuts,
    waveformPeaks,
    audioAnalysis: envelope?.summary,
    markers: [],
    notes: params.notes,
  };

  return studioStore.addAsset(asset);
}

export async function downloadAndIngestUrl(params: {
  url: string;
  title?: string;
  role: MediaRole;
  notes?: string;
}): Promise<MediaAsset> {
  ensureDataDirs();
  const parsedUrl = new URL(params.url);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  const response = await fetch(params.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch media URL (${response.status} ${response.statusText})`);
  }

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  let ext = path.extname(parsedUrl.pathname).toLowerCase();
  if (!ext) {
    if (contentType.includes('webm')) ext = '.webm';
    else if (contentType.includes('quicktime')) ext = '.mov';
    else if (contentType.includes('mpeg') || contentType.includes('mp3')) ext = '.mp3';
    else if (contentType.includes('wav')) ext = '.wav';
    else ext = '.mp4';
  }

  const id = crypto.randomUUID().slice(0, 12);
  const destPath = path.join(MEDIA_DIR, `${id}${ext}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destPath, buffer);

  const fallbackTitle =
    params.title?.trim() || path.basename(parsedUrl.pathname) || `Remote media ${id}`;

  return ingestMediaFile({
    filePath: destPath,
    title: fallbackTitle,
    role: params.role,
    sourceType: 'url',
    mimeType: contentType || inferMimeFromPath(destPath),
    originalUrl: params.url,
    notes: params.notes,
  });
}
