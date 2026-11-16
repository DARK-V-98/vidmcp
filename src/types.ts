export type MediaRole = 'reference' | 'edited' | 'rendered' | 'audio';
export type MediaKind = 'video' | 'audio';
export type MediaSourceType = 'upload' | 'local' | 'url' | 'generated';
export type ReviewStatus = 'pending' | 'approved' | 'changes_requested';

export interface MediaProbeInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  videoCodec: string | null;
  pixelFormat: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  bitrateKbps: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
}

export interface TimelineMarker {
  id: string;
  timestampSec: number;
  author: 'human' | 'ai';
  kind?: 'note' | 'scene_cut';
  label: string;
  createdAt: string;
}

export interface AudioEnvelopeBin {
  index: number;
  startSec: number;
  endSec: number;
  peak: number;
  rms: number;
  peakDb: number;
  rmsDb: number;
}

export interface AudioAnalysisSummary {
  binsCount: number;
  maxPeak: number;
  maxPeakDb: number;
  meanRms: number;
  meanRmsDb: number;
  crestFactorDb: number;
  transientTimestampsSec: number[];
}

export interface OpticalFlowVector {
  gx: number;
  gy: number;
  dx: number;
  dy: number;
  magnitude: number;
}

export interface OpticalFlowFrame {
  timestampSec: number;
  meanMagnitude: number;
  peakMagnitude: number;
  highMotionCoveragePct: number;
  dominantDirectionDeg: number;
  vectors: OpticalFlowVector[];
}

export interface OpticalFlowAnalysis {
  assetId: string;
  method: 'block_match_sad';
  gridCols: number;
  gridRows: number;
  sampleCount: number;
  highMotionThreshold: number;
  globalMeanMagnitude: number;
  globalPeakMagnitude: number;
  peakMotionTimestampSec: number;
  motionBurstTimestampsSec: number[];
  frames: OpticalFlowFrame[];
  generatedAt: string;
}

export interface MediaAsset {
  id: string;
  title: string;
  role: MediaRole;
  kind: MediaKind;
  sourceType: MediaSourceType;
  filePath: string;
  originalUrl?: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  probe: MediaProbeInfo;
  cuts: number[];
  waveformPeaks: number[];
  audioAnalysis?: AudioAnalysisSummary;
  opticalFlow?: OpticalFlowAnalysis;
  markers: TimelineMarker[];
  notes?: string;
}

export interface ReviewRequest {
  id: string;
  mediaId: string;
  referenceMediaId?: string;
  prompt: string;
  requestedBy: string;
  status: ReviewStatus;
  reviewerNote?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface McpActivityEntry {
  id: string;
  toolName: string;
  transport: 'streamable-http' | 'sse' | 'stdio';
  summary: string;
  mediaId?: string;
  timestamp: string;
  durationMs: number;
  ok: boolean;
}

export interface ServerCapabilities {
  ffmpeg: boolean;
  ffprobe: boolean;
  authProtected: boolean;
  workspaceRoot: string;
  baseUrl: string;
  streamableHttpUrl: string;
  sseUrl: string;
}

export interface SsimComparisonSample {
  progressPct: number;
  refTimestampSec: number;
  targetTimestampSec: number;
}

export interface SsimComparisonRecord {
  id: string;
  referenceId: string;
  targetId: string;
  ssimScore: number | null;
  durationDeltaSec: number;
  fpsDelta: number;
  resolutionMatch: boolean;
  samples: SsimComparisonSample[];
  generatedAt: string;
}

export type BatchOperation =
  | 'extract_metadata'
  | 'transcode_mp4'
  | 'transcode_webm'
  | 'transcode_mp3'
  | 'detect_scene_cuts'
  | 'analyze_optical_flow';

export type BatchItemStatus = 'queued' | 'running' | 'completed' | 'failed';
export type BatchJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed';

export interface BatchQueueItem {
  mediaId: string;
  assetTitle: string;
  status: BatchItemStatus;
  progressPct: number;
  outputAssetId?: string;
  message?: string;
  error?: string;
}

export interface BatchJob {
  id: string;
  operation: BatchOperation;
  status: BatchJobStatus;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  progressPct: number;
  currentAssetId?: string;
  currentAssetTitle?: string;
  items: BatchQueueItem[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface StudioStateResponse {
  assets: MediaAsset[];
  reviews: ReviewRequest[];
  activity: McpActivityEntry[];
  comparisons: SsimComparisonRecord[];
  batchJobs: BatchJob[];
  capabilities: ServerCapabilities;
}

export interface ComparisonPairUI {
  progressPct: number;
  refTimestampSec: number;
  targetTimestampSec: number;
  sideBySideDataUrl: string;
  diffDataUrl?: string;
}

export interface CompareResultUI {
  ssimScore: number | null;
  durationDeltaSec: number;
  fpsDelta: number;
  resolutionMatch: boolean;
  pairs: ComparisonPairUI[];
}
