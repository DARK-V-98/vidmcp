import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ingestMediaFile } from './ingest.ts';
import {
  analyzeAudioEnvelope,
  analyzeOpticalFlow,
  detectSceneCuts,
  probeMedia,
} from './mediaProcessor.ts';
import { FRAMES_DIR, MEDIA_DIR, ensureDataDirs, studioStore } from './store.ts';
import type {
  BatchJob,
  BatchOperation,
  BatchQueueItem,
  MediaAsset,
  MediaRole,
} from './types.ts';

export interface BatchProcessOptions {
  targetWidth?: number;
  targetFps?: number;
  crf?: number;
  sceneCutThreshold?: number;
  flowSamples?: number;
  registerOutputs?: boolean;
  outputRole?: MediaRole;
}

interface QueuedBatchExecution {
  jobId: string;
  options: BatchProcessOptions;
  resolveWaiters: Array<(job: BatchJob) => void>;
}

const executionQueue: QueuedBatchExecution[] = [];
const jobWaiters = new Map<string, Array<(job: BatchJob) => void>>();
let workerRunning = false;

function computeOverallProgress(items: BatchQueueItem[]): number {
  if (items.length === 0) return 100;
  const total = items.reduce((acc, item) => {
    if (item.status === 'completed' || item.status === 'failed') return acc + 100;
    if (item.status === 'running') return acc + Math.max(0, Math.min(99, item.progressPct));
    return acc;
  }, 0);
  return Math.min(100, Math.round(total / items.length));
}

function runFfmpegWithProgress(
  args: string[],
  durationSec: number,
  onProgress: (pct: number) => void,
  timeoutMs = 120000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-progress', 'pipe:1', '-nostats', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrTail = '';
    let stdoutBuf = '';
    let lastReport = 0;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('out_time_us=')) {
          const us = Number(line.slice('out_time_us='.length).trim());
          if (Number.isFinite(us) && durationSec > 0) {
            const pct = Math.max(1, Math.min(98, Math.round((us / 1_000_000 / durationSec) * 100)));
            const now = Date.now();
            if (now - lastReport >= 250) {
              lastReport = now;
              onProgress(pct);
            }
          }
        } else if (line.startsWith('progress=end')) {
          onProgress(99);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const lastLine = stderrTail.trim().split(/\r?\n/).pop() || `exit code ${code}`;
        reject(new Error(`ffmpeg failed: ${lastLine}`));
      }
    });
  });
}

function updateItemState(
  jobId: string,
  itemIndex: number,
  patch: Partial<BatchQueueItem>,
  jobPatch?: Partial<Pick<BatchJob, 'currentAssetId' | 'currentAssetTitle'>>
): BatchJob | undefined {
  return studioStore.updateBatchJob(jobId, (job) => {
    const items = job.items.map((item, idx) =>
      idx === itemIndex ? { ...item, ...patch } : item
    );
    const completedItems = items.filter((i) => i.status === 'completed').length;
    const failedItems = items.filter((i) => i.status === 'failed').length;
    const progressPct = computeOverallProgress(items);
    return {
      ...job,
      ...jobPatch,
      items,
      completedItems,
      failedItems,
      progressPct,
      updatedAt: new Date().toISOString(),
    };
  });
}

async function processSingleItem(
  jobId: string,
  operation: BatchOperation,
  itemIndex: number,
  asset: MediaAsset,
  opts: BatchProcessOptions
): Promise<{ outputAssetId?: string; message: string }> {
  ensureDataDirs();
  const baseName = path.basename(asset.filePath, path.extname(asset.filePath));
  const registerOutputs = opts.registerOutputs !== false;

  switch (operation) {
    case 'extract_metadata': {
      updateItemState(jobId, itemIndex, { progressPct: 25 });
      const probe = await probeMedia(asset.filePath);
      updateItemState(jobId, itemIndex, { progressPct: 65 });
      let waveformPeaks = asset.waveformPeaks;
      if (probe.hasAudio) {
        const env = await analyzeAudioEnvelope(asset.filePath, probe.durationSec, { bins: 96 });
        waveformPeaks = env.bins.map((b) => Math.round(b.peak * 1000) / 1000);
      }
      studioStore.updateAsset(asset.id, { probe, waveformPeaks });
      return {
        message: probe.hasVideo
          ? `${probe.width}x${probe.height} · ${probe.fps}fps · ${probe.durationSec.toFixed(2)}s (${probe.videoCodec ?? 'video'})`
          : `Audio ${probe.sampleRate ?? 0}Hz · ${probe.durationSec.toFixed(2)}s (${probe.audioCodec ?? 'audio'})`,
      };
    }

    case 'detect_scene_cuts': {
      if (!asset.probe.hasVideo) {
        throw new Error('Asset has no video stream for scene cut detection.');
      }
      updateItemState(jobId, itemIndex, { progressPct: 25 });
      const threshold = Math.min(0.9, Math.max(0.05, opts.sceneCutThreshold ?? 0.25));
      const cuts = await detectSceneCuts(asset.filePath, threshold);
      const fps = asset.probe.fps > 0 ? asset.probe.fps : 30;
      const markers = cuts.map((t, idx) => ({
        id: crypto.randomUUID().slice(0, 10),
        timestampSec: t,
        author: 'ai' as const,
        kind: 'scene_cut' as const,
        label: `Scene cut #${idx + 1} (t=${t.toFixed(3)}s, f=${Math.round(t * fps)})`,
        createdAt: new Date().toISOString(),
      }));
      studioStore.setSceneCutMarkers(asset.id, cuts, markers, true);
      return {
        message: `${cuts.length} scene cuts detected (threshold=${threshold})`,
      };
    }

    case 'analyze_optical_flow': {
      if (!asset.probe.hasVideo) {
        throw new Error('Asset has no video stream for optical flow analysis.');
      }
      updateItemState(jobId, itemIndex, { progressPct: 20 });
      const outDir = path.join(FRAMES_DIR, asset.id, `batch_flow_${Date.now()}`);
      const { analysis } = await analyzeOpticalFlow(
        asset.id,
        asset.filePath,
        asset.probe,
        outDir,
        {
          samples: opts.flowSamples ?? 6,
          includeVectorFrames: false,
        }
      );
      studioStore.updateAsset(asset.id, { opticalFlow: analysis });
      return {
        message: `Mean ${analysis.globalMeanMagnitude.toFixed(2)}px · Peak ${analysis.globalPeakMagnitude.toFixed(2)}px`,
      };
    }

    case 'transcode_mp4': {
      if (!asset.probe.hasVideo) {
        throw new Error('transcode_mp4 requires a video stream.');
      }
      const outId = crypto.randomUUID().slice(0, 8);
      const outPath = path.join(MEDIA_DIR, `${baseName}_${outId}.mp4`);
      const vfParts: string[] = [];
      if (opts.targetWidth && opts.targetWidth >= 160) {
        vfParts.push(`scale='min(${Math.round(opts.targetWidth)},iw)':-2`);
      }
      if (opts.targetFps && opts.targetFps > 0) {
        vfParts.push(`fps=${opts.targetFps}`);
      }
      const crf = Math.min(35, Math.max(14, Math.round(opts.crf ?? 22)));
      const args = ['-y', '-i', asset.filePath];
      if (vfParts.length > 0) {
        args.push('-vf', vfParts.join(','));
      }
      args.push(
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'fast',
        '-crf',
        String(crf)
      );
      if (asset.probe.hasAudio) {
        args.push('-c:a', 'aac', '-b:a', '128k');
      } else {
        args.push('-an');
      }
      args.push('-movflags', '+faststart', outPath);

      await runFfmpegWithProgress(args, asset.probe.durationSec || 1, (pct) => {
        updateItemState(jobId, itemIndex, { progressPct: pct });
      });

      let outputAssetId: string | undefined;
      if (registerOutputs && fs.existsSync(outPath)) {
        const created = await ingestMediaFile({
          filePath: outPath,
          title: `${asset.title} [H.264 MP4]`,
          role: opts.outputRole ?? 'rendered',
          sourceType: 'generated',
          mimeType: 'video/mp4',
          notes: `Batch transcoded from ${asset.id} (CRF ${crf}).`,
        });
        outputAssetId = created.id;
      }
      return {
        outputAssetId,
        message: outputAssetId
          ? `Transcoded MP4 registered as ${outputAssetId}`
          : `Transcoded to ${path.basename(outPath)}`,
      };
    }

    case 'transcode_webm': {
      if (!asset.probe.hasVideo) {
        throw new Error('transcode_webm requires a video stream.');
      }
      const outId = crypto.randomUUID().slice(0, 8);
      const outPath = path.join(MEDIA_DIR, `${baseName}_${outId}.webm`);
      const vfParts: string[] = [];
      if (opts.targetWidth && opts.targetWidth >= 160) {
        vfParts.push(`scale='min(${Math.round(opts.targetWidth)},iw)':-2`);
      }
      if (opts.targetFps && opts.targetFps > 0) {
        vfParts.push(`fps=${opts.targetFps}`);
      }
      const crf = Math.min(45, Math.max(18, Math.round(opts.crf ?? 30)));
      const args = ['-y', '-i', asset.filePath];
      if (vfParts.length > 0) {
        args.push('-vf', vfParts.join(','));
      }
      args.push(
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'realtime',
        '-cpu-used',
        '4',
        '-crf',
        String(crf),
        '-b:v',
        '0'
      );
      if (asset.probe.hasAudio) {
        args.push('-c:a', 'libopus', '-b:a', '112k');
      } else {
        args.push('-an');
      }
      args.push(outPath);

      await runFfmpegWithProgress(args, asset.probe.durationSec || 1, (pct) => {
        updateItemState(jobId, itemIndex, { progressPct: pct });
      });

      let outputAssetId: string | undefined;
      if (registerOutputs && fs.existsSync(outPath)) {
        const created = await ingestMediaFile({
          filePath: outPath,
          title: `${asset.title} [VP9 WebM]`,
          role: opts.outputRole ?? 'rendered',
          sourceType: 'generated',
          mimeType: 'video/webm',
          notes: `Batch WebM transcode from ${asset.id} (CRF ${crf}).`,
        });
        outputAssetId = created.id;
      }
      return {
        outputAssetId,
        message: outputAssetId
          ? `Transcoded WebM registered as ${outputAssetId}`
          : `Transcoded to ${path.basename(outPath)}`,
      };
    }

    case 'transcode_mp3': {
      if (!asset.probe.hasAudio) {
        throw new Error('Asset has no audio stream to extract/transcode.');
      }
      const outId = crypto.randomUUID().slice(0, 8);
      const outPath = path.join(MEDIA_DIR, `${baseName}_${outId}.mp3`);
      const args = [
        '-y',
        '-i',
        asset.filePath,
        '-vn',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        outPath,
      ];

      await runFfmpegWithProgress(args, asset.probe.durationSec || 1, (pct) => {
        updateItemState(jobId, itemIndex, { progressPct: pct });
      });

      let outputAssetId: string | undefined;
      if (registerOutputs && fs.existsSync(outPath)) {
        const created = await ingestMediaFile({
          filePath: outPath,
          title: `${asset.title} [MP3 192k]`,
          role: opts.outputRole ?? 'audio',
          sourceType: 'generated',
          mimeType: 'audio/mpeg',
          notes: `Batch audio extraction/transcode from ${asset.id}.`,
        });
        outputAssetId = created.id;
      }
      return {
        outputAssetId,
        message: outputAssetId
          ? `Extracted MP3 registered as ${outputAssetId}`
          : `Extracted MP3 to ${path.basename(outPath)}`,
      };
    }
  }
}

async function processNextInQueue(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;

  try {
    while (executionQueue.length > 0) {
      const task = executionQueue.shift()!;
      const { jobId, options } = task;
      const initialJob = studioStore.getBatchJob(jobId);
      if (!initialJob) continue;

      studioStore.updateBatchJob(jobId, (j) => ({
        ...j,
        status: 'running',
        updatedAt: new Date().toISOString(),
      }));

      for (let i = 0; i < initialJob.items.length; i++) {
        const item = initialJob.items[i];
        const asset = studioStore.getAsset(item.mediaId);
        if (!asset) {
          updateItemState(
            jobId,
            i,
            {
              status: 'failed',
              progressPct: 100,
              error: `Asset not found: ${item.mediaId}`,
            },
            { currentAssetId: item.mediaId, currentAssetTitle: item.assetTitle }
          );
          continue;
        }

        updateItemState(
          jobId,
          i,
          { status: 'running', progressPct: 5 },
          { currentAssetId: asset.id, currentAssetTitle: asset.title }
        );

        try {
          const outcome = await processSingleItem(
            jobId,
            initialJob.operation,
            i,
            asset,
            options
          );
          updateItemState(jobId, i, {
            status: 'completed',
            progressPct: 100,
            outputAssetId: outcome.outputAssetId,
            message: outcome.message,
          });
        } catch (err) {
          updateItemState(jobId, i, {
            status: 'failed',
            progressPct: 100,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const finalJob = studioStore.updateBatchJob(jobId, (j) => {
        const completed = j.items.filter((x) => x.status === 'completed').length;
        const failed = j.items.filter((x) => x.status === 'failed').length;
        const status =
          failed === 0
            ? 'completed'
            : completed === 0
              ? 'failed'
              : 'completed_with_errors';
        return {
          ...j,
          status,
          completedItems: completed,
          failedItems: failed,
          progressPct: 100,
          currentAssetId: undefined,
          currentAssetTitle: undefined,
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      });

      const waiters = jobWaiters.get(jobId) ?? [];
      jobWaiters.delete(jobId);
      if (finalJob) {
        for (const resolve of waiters) resolve(finalJob);
      }
    }
  } finally {
    workerRunning = false;
  }
}

export function enqueueBatchJob(params: {
  mediaIds: string[];
  operation: BatchOperation;
  options?: BatchProcessOptions;
}): BatchJob {
  const uniqueIds = Array.from(new Set(params.mediaIds.map((id) => id.trim()).filter(Boolean)));
  if (uniqueIds.length === 0) {
    throw new Error('Provide at least one mediaId for batch processing.');
  }

  const now = new Date().toISOString();
  const items: BatchQueueItem[] = uniqueIds.map((id) => {
    const asset = studioStore.getAsset(id);
    return {
      mediaId: id,
      assetTitle: asset?.title ?? id,
      status: 'queued',
      progressPct: 0,
    };
  });

  const job: BatchJob = {
    id: crypto.randomUUID().slice(0, 10),
    operation: params.operation,
    status: 'queued',
    totalItems: items.length,
    completedItems: 0,
    failedItems: 0,
    progressPct: 0,
    items,
    createdAt: now,
    updatedAt: now,
  };

  studioStore.addBatchJob(job);
  executionQueue.push({
    jobId: job.id,
    options: params.options ?? {},
    resolveWaiters: [],
  });
  void processNextInQueue();

  return job;
}

export function waitForBatchJob(jobId: string, timeoutMs = 120000): Promise<BatchJob> {
  const current = studioStore.getBatchJob(jobId);
  if (!current) {
    return Promise.reject(new Error(`Batch job not found: ${jobId}`));
  }
  if (
    current.status === 'completed' ||
    current.status === 'completed_with_errors' ||
    current.status === 'failed'
  ) {
    return Promise.resolve(current);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for batch job ${jobId}`));
    }, timeoutMs);

    const list = jobWaiters.get(jobId) ?? [];
    list.push((finishedJob) => {
      clearTimeout(timer);
      resolve(finishedJob);
    });
    jobWaiters.set(jobId, list);
  });
}
