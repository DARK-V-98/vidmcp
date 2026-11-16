import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type {
  BatchJob,
  McpActivityEntry,
  MediaAsset,
  ReviewRequest,
  SsimComparisonRecord,
  StudioDatabase,
  TimelineMarker,
} from './types.ts';

export const DATA_ROOT = path.resolve(process.cwd(), 'data');
export const MEDIA_DIR = path.join(DATA_ROOT, 'media');
export const FRAMES_DIR = path.join(DATA_ROOT, 'frames');
export const AUDIO_DIR = path.join(DATA_ROOT, 'audio');
export const EXPORTS_DIR = path.join(DATA_ROOT, 'exports');
export const DB_FILE = path.join(DATA_ROOT, 'db.json');

export function ensureDataDirs(): void {
  for (const dir of [DATA_ROOT, MEDIA_DIR, FRAMES_DIR, AUDIO_DIR, EXPORTS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

class StudioStore extends EventEmitter {
  private db: StudioDatabase = {
    assets: [],
    reviews: [],
    activity: [],
    comparisons: [],
    batchJobs: [],
  };

  constructor() {
    super();
    ensureDataDirs();
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<StudioDatabase>;
        this.db = {
          assets: Array.isArray(parsed.assets) ? parsed.assets : [],
          reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
          activity: Array.isArray(parsed.activity) ? parsed.activity : [],
          comparisons: Array.isArray(parsed.comparisons) ? parsed.comparisons : [],
          batchJobs: Array.isArray(parsed.batchJobs) ? parsed.batchJobs : [],
        };
      }
    } catch {
      this.db = { assets: [], reviews: [], activity: [], comparisons: [], batchJobs: [] };
    }
  }

  private save(): void {
    ensureDataDirs();
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2), 'utf-8');
    fs.renameSync(tmp, DB_FILE);
  }

  public reload(): void {
    this.load();
  }

  public getSnapshot(): StudioDatabase {
    this.load();
    return {
      assets: [...this.db.assets],
      reviews: [...this.db.reviews],
      activity: [...this.db.activity],
      comparisons: [...this.db.comparisons],
      batchJobs: [...this.db.batchJobs],
    };
  }

  public listAssets(): MediaAsset[] {
    this.load();
    return [...this.db.assets];
  }

  public getAsset(id: string): MediaAsset | undefined {
    this.load();
    return this.db.assets.find((a) => a.id === id);
  }

  public addAsset(asset: MediaAsset): MediaAsset {
    this.load();
    this.db.assets.unshift(asset);
    this.save();
    this.emit('change', { type: 'asset_added', assetId: asset.id });
    return asset;
  }

  public updateAsset(
    id: string,
    patch: Partial<
      Pick<MediaAsset, 'title' | 'role' | 'notes' | 'cuts' | 'waveformPeaks' | 'probe' | 'opticalFlow'>
    >
  ): MediaAsset | undefined {
    this.load();
    const idx = this.db.assets.findIndex((a) => a.id === id);
    if (idx === -1) return undefined;
    this.db.assets[idx] = { ...this.db.assets[idx], ...patch };
    this.save();
    this.emit('change', { type: 'asset_updated', assetId: id });
    return this.db.assets[idx];
  }

  public addMarker(assetId: string, marker: TimelineMarker): MediaAsset | undefined {
    this.load();
    const idx = this.db.assets.findIndex((a) => a.id === assetId);
    if (idx === -1) return undefined;
    const markers = [...this.db.assets[idx].markers, marker].sort(
      (a, b) => a.timestampSec - b.timestampSec
    );
    this.db.assets[idx] = { ...this.db.assets[idx], markers };
    this.save();
    this.emit('change', { type: 'marker_added', assetId });
    return this.db.assets[idx];
  }

  public setSceneCutMarkers(
    assetId: string,
    cuts: number[],
    newMarkers: TimelineMarker[],
    replaceExisting = true
  ): MediaAsset | undefined {
    this.load();
    const idx = this.db.assets.findIndex((a) => a.id === assetId);
    if (idx === -1) return undefined;
    const baseMarkers = replaceExisting
      ? this.db.assets[idx].markers.filter((m) => m.kind !== 'scene_cut')
      : this.db.assets[idx].markers;
    const markers = [...baseMarkers, ...newMarkers].sort(
      (a, b) => a.timestampSec - b.timestampSec
    );
    this.db.assets[idx] = { ...this.db.assets[idx], cuts, markers };
    this.save();
    this.emit('change', { type: 'scene_cuts_updated', assetId });
    return this.db.assets[idx];
  }

  public deleteMarker(assetId: string, markerId: string): MediaAsset | undefined {
    this.load();
    const idx = this.db.assets.findIndex((a) => a.id === assetId);
    if (idx === -1) return undefined;
    const markers = this.db.assets[idx].markers.filter((m) => m.id !== markerId);
    this.db.assets[idx] = { ...this.db.assets[idx], markers };
    this.save();
    this.emit('change', { type: 'marker_deleted', assetId });
    return this.db.assets[idx];
  }

  public deleteAsset(id: string): boolean {
    this.load();
    const asset = this.db.assets.find((a) => a.id === id);
    if (!asset) return false;
    this.db.assets = this.db.assets.filter((a) => a.id !== id);
    this.db.reviews = this.db.reviews.filter(
      (r) => r.mediaId !== id && r.referenceMediaId !== id
    );
    this.db.comparisons = this.db.comparisons.filter(
      (c) => c.referenceId !== id && c.targetId !== id
    );
    this.save();

    if (asset.sourceType !== 'local' && asset.filePath.startsWith(MEDIA_DIR)) {
      fs.rmSync(asset.filePath, { force: true });
    }
    const assetFramesDir = path.join(FRAMES_DIR, id);
    if (fs.existsSync(assetFramesDir)) {
      fs.rmSync(assetFramesDir, { recursive: true, force: true });
    }

    this.emit('change', { type: 'asset_deleted', assetId: id });
    return true;
  }

  public listReviews(): ReviewRequest[] {
    this.load();
    return [...this.db.reviews];
  }

  public getReview(id: string): ReviewRequest | undefined {
    this.load();
    return this.db.reviews.find((r) => r.id === id);
  }

  public addReview(review: ReviewRequest): ReviewRequest {
    this.load();
    this.db.reviews.unshift(review);
    this.save();
    this.emit('change', { type: 'review_created', reviewId: review.id });
    return review;
  }

  public resolveReview(
    id: string,
    status: 'approved' | 'changes_requested',
    reviewerNote: string
  ): ReviewRequest | undefined {
    this.load();
    const idx = this.db.reviews.findIndex((r) => r.id === id);
    if (idx === -1) return undefined;
    this.db.reviews[idx] = {
      ...this.db.reviews[idx],
      status,
      reviewerNote,
      resolvedAt: new Date().toISOString(),
    };
    this.save();
    this.emit('change', { type: 'review_resolved', reviewId: id });
    return this.db.reviews[idx];
  }

  public listComparisons(): SsimComparisonRecord[] {
    this.load();
    return [...this.db.comparisons];
  }

  public getComparison(referenceId: string, targetId: string): SsimComparisonRecord | undefined {
    this.load();
    return this.db.comparisons.find(
      (c) => c.referenceId === referenceId && c.targetId === targetId
    );
  }

  public saveComparison(record: SsimComparisonRecord): SsimComparisonRecord {
    this.load();
    this.db.comparisons = [
      record,
      ...this.db.comparisons.filter(
        (c) => !(c.referenceId === record.referenceId && c.targetId === record.targetId)
      ),
    ].slice(0, 30);
    this.save();
    this.emit('change', {
      type: 'comparison_saved',
      referenceId: record.referenceId,
      targetId: record.targetId,
    });
    return record;
  }

  public listBatchJobs(): BatchJob[] {
    this.load();
    return [...this.db.batchJobs];
  }

  public getBatchJob(id: string): BatchJob | undefined {
    this.load();
    return this.db.batchJobs.find((j) => j.id === id);
  }

  public addBatchJob(job: BatchJob): BatchJob {
    this.load();
    this.db.batchJobs = [job, ...this.db.batchJobs].slice(0, 15);
    this.save();
    this.emit('change', { type: 'batch_job_created', jobId: job.id });
    return job;
  }

  public updateBatchJob(
    id: string,
    updater: (current: BatchJob) => BatchJob
  ): BatchJob | undefined {
    this.load();
    const idx = this.db.batchJobs.findIndex((j) => j.id === id);
    if (idx === -1) return undefined;
    const updated = updater(this.db.batchJobs[idx]);
    this.db.batchJobs[idx] = updated;
    this.save();
    this.emit('change', { type: 'batch_job_updated', jobId: id });
    return updated;
  }

  public clearCompletedBatchJobs(): number {
    this.load();
    const before = this.db.batchJobs.length;
    this.db.batchJobs = this.db.batchJobs.filter(
      (j) => j.status === 'queued' || j.status === 'running'
    );
    const removed = before - this.db.batchJobs.length;
    if (removed > 0) {
      this.save();
      this.emit('change', { type: 'batch_jobs_cleared' });
    }
    return removed;
  }

  public logActivity(entry: McpActivityEntry): void {
    this.load();
    this.db.activity.unshift(entry);
    if (this.db.activity.length > 60) {
      this.db.activity = this.db.activity.slice(0, 60);
    }
    this.save();
    this.emit('change', { type: 'activity_logged', activityId: entry.id });
  }
}

export const studioStore = new StudioStore();
