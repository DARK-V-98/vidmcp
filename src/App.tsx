import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Film,
  Loader2,
  Play,
  Plus,
  Sparkles,
  Volume2,
} from 'lucide-react';
import { CompareView } from './components/CompareView';
import { ConnectMcpView } from './components/ConnectMcpView';
import { MediaPlayerView } from './components/MediaPlayerView';
import { ReviewInboxView } from './components/ReviewInboxView';
import { UploadModal } from './components/UploadModal';
import type {
  BatchJob,
  BatchOperation,
  McpActivityEntry,
  MediaAsset,
  MediaRole,
  ReviewRequest,
  ServerCapabilities,
  SsimComparisonRecord,
  StudioStateResponse,
} from './types';
import { formatTimecode, roleShortLabel } from './utils/format';

const BATCH_OP_LABELS: Record<BatchOperation, string> = {
  extract_metadata: 'Extract Metadata',
  transcode_mp4: 'Transcode MP4',
  transcode_webm: 'Transcode WebM',
  transcode_mp3: 'Extract MP3',
  detect_scene_cuts: 'Detect Cuts',
  analyze_optical_flow: 'Optical Flow',
};

type ActiveTab = 'library' | 'compare' | 'reviews' | 'connect';
type RoleFilter = 'all' | MediaRole;

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('library');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [reviews, setReviews] = useState<ReviewRequest[]>([]);
  const [activity, setActivity] = useState<McpActivityEntry[]>([]);
  const [comparisons, setComparisons] = useState<SsimComparisonRecord[]>([]);
  const [batchJobs, setBatchJobs] = useState<BatchJob[]>([]);
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [generatingSample, setGeneratingSample] = useState(false);
  const [batchOp, setBatchOp] = useState<BatchOperation>('extract_metadata');
  const [startingBatch, setStartingBatch] = useState(false);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) return;
      const data: StudioStateResponse = await res.json();
      setAssets(data.assets);
      setReviews(data.reviews);
      setActivity(data.activity);
      setComparisons(Array.isArray(data.comparisons) ? data.comparisons : []);
      setBatchJobs(Array.isArray(data.batchJobs) ? data.batchJobs : []);
      setCapabilities(data.capabilities);
      setSelectedAssetId((prev) => {
        if (prev && data.assets.some((a) => a.id === prev)) return prev;
        return data.assets[0]?.id ?? '';
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchState();

    const evtSource = new EventSource('/api/events');
    evtSource.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed?.type && parsed.type !== 'connected') {
          void fetchState();
        }
      } catch {
        // ignore malformed heartbeat
      }
    };

    return () => {
      evtSource.close();
    };
  }, [fetchState]);

  const filteredAssets = useMemo(() => {
    if (roleFilter === 'all') return assets;
    return assets.filter((a) => a.role === roleFilter);
  }, [assets, roleFilter]);

  const selectedAsset = useMemo(() => {
    return (
      filteredAssets.find((a) => a.id === selectedAssetId) ??
      assets.find((a) => a.id === selectedAssetId) ??
      filteredAssets[0]
    );
  }, [assets, filteredAssets, selectedAssetId]);

  const pendingReviewsCount = reviews.filter((r) => r.status === 'pending').length;

  const handleDeleteAsset = async (id: string) => {
    await fetch(`/api/media/${id}`, { method: 'DELETE' });
    await fetchState();
  };

  const handleSendToReview = async (asset: MediaAsset) => {
    const refCandidate = assets.find(
      (a) => a.role === 'reference' && a.id !== asset.id && a.probe.hasVideo
    );
    await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mediaId: asset.id,
        referenceMediaId: refCandidate?.id,
        prompt: `Manual QA check for "${asset.title}" (${roleShortLabel(asset.role)}).`,
        requestedBy: 'Studio User',
      }),
    });
    await fetchState();
    setActiveTab('reviews');
  };

  const handleGenerateCalibration = async () => {
    setGeneratingSample(true);
    try {
      const res = await fetch('/api/media/generate-sample', { method: 'POST' });
      const data = await res.json();
      await fetchState();
      if (data?.reference?.id) {
        setSelectedAssetId(data.reference.id);
      }
    } finally {
      setGeneratingSample(false);
    }
  };

  const handleRunBatch = async () => {
    const ids = filteredAssets.map((a) => a.id);
    if (ids.length === 0) return;
    setStartingBatch(true);
    try {
      await fetch('/api/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaIds: ids, operation: batchOp }),
      });
      await fetchState();
    } finally {
      setStartingBatch(false);
    }
  };

  const handleClearCompletedBatch = async () => {
    await fetch('/api/batch/completed', { method: 'DELETE' });
    await fetchState();
  };

  const hasCompletedBatch = batchJobs.some(
    (j) => j.status === 'completed' || j.status === 'completed_with_errors' || j.status === 'failed'
  );

  return (
    <div className="min-h-screen bg-[#0b0e14] text-slate-100 flex flex-col">
      {/* 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 border-b border-slate-800/90 bg-[#0b0e14] px-6 py-3.5">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('library');
          }}
          className="font-display text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          CutCheck
        </a>

        <nav className="flex items-center gap-6 overflow-x-auto text-sm font-medium">
          {(
            [
              ['library', 'Library'],
              ['compare', 'Compare QA'],
              [
                'reviews',
                pendingReviewsCount > 0 ? `Review Inbox (${pendingReviewsCount})` : 'Review Inbox',
              ],
              ['connect', 'Connect AI'],
            ] as const
          ).map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`border-b-2 py-1 whitespace-nowrap shrink-0 transition-colors ${
                activeTab === tab
                  ? 'border-blue-500 text-slate-100'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => setUploadOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0 transition-colors hover:bg-blue-500"
          >
            <Plus className="h-3.5 w-3.5" />
            Upload Media
          </button>
        </div>
      </header>

      {/* Workspace Body: Sidebar + Main Viewport */}
      <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col lg:flex-row">
        {/* Sidebar */}
        <aside className="w-full shrink-0 border-b border-slate-800/90 bg-[#0e121a] p-4 lg:w-[272px] lg:border-r lg:border-b-0">
          <div className="space-y-5">
            {/* Role Filter */}
            <div>
              <div className="mb-2 text-xs font-medium text-slate-400">Workspace Filter</div>
              <div className="space-y-0.5">
                {(
                  [
                    ['all', 'All Assets'],
                    ['reference', 'Reference Motion'],
                    ['edited', 'Edited Cuts'],
                    ['rendered', 'Rendered Output'],
                    ['audio', 'Audio Tracks'],
                  ] as const
                ).map(([role, label]) => {
                  const count =
                    role === 'all'
                      ? assets.length
                      : assets.filter((a) => a.role === role).length;
                  const active = roleFilter === role;
                  return (
                    <button
                      key={role}
                      type="button"
                      onClick={() => setRoleFilter(role)}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                        active
                          ? 'bg-slate-800 text-slate-100'
                          : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
                      }`}
                    >
                      <span className="truncate">{label}</span>
                      <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Asset List */}
            <div className="border-t border-slate-800/80 pt-4">
              <div className="mb-2 flex items-center justify-between text-xs font-medium text-slate-400">
                <span>Clips & Audio</span>
                <span className="font-mono text-[11px] tabular-nums">{filteredAssets.length}</span>
              </div>

              {loading ? (
                <div className="space-y-2">
                  <div className="h-14 animate-pulse rounded-lg bg-slate-800/50" />
                  <div className="h-14 animate-pulse rounded-lg bg-slate-800/50" />
                </div>
              ) : filteredAssets.length === 0 ? (
                <p className="py-3 text-xs text-slate-500">
                  No media in this category yet.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {filteredAssets.map((asset) => {
                    const isSelected =
                      activeTab === 'library' && selectedAsset?.id === asset.id;
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        onClick={() => {
                          setSelectedAssetId(asset.id);
                          setActiveTab('library');
                        }}
                        className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                          isSelected
                            ? 'border-blue-500/70 bg-[#151c29]'
                            : 'border-transparent bg-[#121721] hover:border-slate-800'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {asset.kind === 'video' ? (
                            <Film className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                          ) : (
                            <Volume2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                          )}
                          <span className="truncate text-xs font-semibold text-slate-100">
                            {asset.title}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-slate-400 tabular-nums">
                          <span>{roleShortLabel(asset.role)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatTimecode(asset.probe.durationSec).slice(0, 8)}</span>
                          {asset.probe.fps > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{asset.probe.fps}fps</span>
                            </>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Batch Processing Queue */}
            <div className="border-t border-slate-800/80 pt-4">
              <div className="mb-2 flex items-center justify-between text-xs font-medium text-slate-400">
                <span>Batch Queue</span>
                {hasCompletedBatch && (
                  <button
                    type="button"
                    onClick={() => void handleClearCompletedBatch()}
                    className="text-[11px] text-slate-500 hover:text-slate-300"
                  >
                    Clear Done
                  </button>
                )}
              </div>

              {filteredAssets.length > 0 && (
                <div className="mb-2.5 flex items-center gap-1.5">
                  <select
                    aria-label="Batch operation"
                    value={batchOp}
                    onChange={(e) => setBatchOp(e.target.value as BatchOperation)}
                    className="min-w-0 flex-1 rounded-md border border-slate-800 bg-[#121721] px-2 py-1 text-[11px] text-slate-200 focus:border-blue-500 focus:outline-none"
                  >
                    <option value="extract_metadata">Extract Metadata</option>
                    <option value="transcode_mp4">Transcode MP4</option>
                    <option value="transcode_webm">Transcode WebM</option>
                    <option value="transcode_mp3">Extract MP3</option>
                    <option value="detect_scene_cuts">Detect Scene Cuts</option>
                    <option value="analyze_optical_flow">Optical Flow</option>
                  </select>
                  <button
                    type="button"
                    disabled={startingBatch}
                    onClick={() => void handleRunBatch()}
                    title={`Run on ${filteredAssets.length} shown asset(s)`}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-[#121721] px-2 py-1 text-[11px] font-medium text-slate-200 whitespace-nowrap shrink-0 hover:border-slate-600 hover:bg-slate-800 disabled:opacity-50"
                  >
                    <Play className="h-3 w-3" />
                    Run ({filteredAssets.length})
                  </button>
                </div>
              )}

              {batchJobs.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No batch jobs queued. Trigger via MCP <code className="font-mono text-slate-400">batch_process_assets</code> or Run above.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {batchJobs.slice(0, 4).map((job) => {
                    const doneCount = job.completedItems + job.failedItems;
                    const barColor =
                      job.status === 'completed'
                        ? 'bg-emerald-500'
                        : job.status === 'failed'
                          ? 'bg-red-500'
                          : job.status === 'completed_with_errors'
                            ? 'bg-amber-500'
                            : 'bg-blue-500';
                    return (
                      <div
                        key={job.id}
                        className="rounded-lg border border-slate-800 bg-[#121721] p-2.5 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium text-slate-200">
                            {BATCH_OP_LABELS[job.operation]}
                          </span>
                          <span className="font-mono text-[11px] text-slate-400 tabular-nums shrink-0">
                            {doneCount}/{job.totalItems} · {job.progressPct}%
                          </span>
                        </div>

                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#0b0e14]">
                          <div
                            className={`h-full transition-all duration-200 ${barColor}`}
                            style={{ width: `${job.progressPct}%` }}
                          />
                        </div>

                        {job.status === 'running' && job.currentAssetTitle && (
                          <p className="mt-1.5 truncate text-[11px] text-blue-300">
                            Processing: {job.currentAssetTitle}
                          </p>
                        )}

                        <div className="mt-2 space-y-1">
                          {job.items.slice(0, 4).map((item) => (
                            <div
                              key={item.mediaId}
                              className="flex items-center justify-between gap-2 text-[11px]"
                            >
                              <div className="flex min-w-0 items-center gap-1.5">
                                {item.status === 'running' ? (
                                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-400" />
                                ) : item.status === 'completed' ? (
                                  <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />
                                ) : item.status === 'failed' ? (
                                  <AlertCircle className="h-3 w-3 shrink-0 text-red-400" />
                                ) : (
                                  <Clock className="h-3 w-3 shrink-0 text-slate-500" />
                                )}
                                <span
                                  title={item.error || item.message || item.assetTitle}
                                  className={`truncate ${
                                    item.status === 'failed'
                                      ? 'text-red-300'
                                      : 'text-slate-300'
                                  }`}
                                >
                                  {item.assetTitle}
                                </span>
                              </div>
                              {item.outputAssetId ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedAssetId(item.outputAssetId!);
                                    setActiveTab('library');
                                  }}
                                  className="shrink-0 font-mono text-[10px] text-blue-300 hover:underline"
                                >
                                  Open
                                </button>
                              ) : (
                                <span className="shrink-0 font-mono text-[10px] text-slate-500 tabular-nums">
                                  {item.status === 'running'
                                    ? `${item.progressPct}%`
                                    : item.status}
                                </span>
                              )}
                            </div>
                          ))}
                          {job.items.length > 4 && (
                            <div className="text-[10px] text-slate-500">
                              +{job.items.length - 4} more item(s)
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Real MCP Tool Activity */}
            <div className="border-t border-slate-800/80 pt-4">
              <div className="mb-2 text-xs font-medium text-slate-400">Recent MCP Tool Calls</div>
              {activity.length === 0 ? (
                <p className="text-xs text-slate-500">
                  Waiting for Claude or another MCP client to call a tool.
                </p>
              ) : (
                <div className="space-y-2">
                  {activity.slice(0, 6).map((item) => (
                    <div key={item.id} className="text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <code className="truncate font-mono text-[11px] text-blue-300">
                          {item.toolName}
                        </code>
                        <span className="font-mono text-[10px] text-slate-500 tabular-nums">
                          {item.durationMs}ms
                        </span>
                      </div>
                      <p className="truncate text-[11px] text-slate-400">{item.summary}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* Main Viewport */}
        <main className="min-w-0 flex-1 p-6 lg:p-8">
          {activeTab === 'library' && (
            <>
              {selectedAsset ? (
                <MediaPlayerView
                  asset={selectedAsset}
                  allAssets={assets}
                  comparisons={comparisons}
                  onRefresh={() => void fetchState()}
                  onDelete={(id) => void handleDeleteAsset(id)}
                  onSendToReview={(asset) => void handleSendToReview(asset)}
                />
              ) : (
                <div className="mx-auto max-w-2xl rounded-xl border border-slate-800 bg-[#121721] p-8 text-center">
                  <Film className="mx-auto h-9 w-9 text-slate-400" />
                  <h1 className="mt-4 font-display text-xl font-semibold text-slate-100">
                    Reference Motion & Render QA Bridge
                  </h1>
                  <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-slate-400">
                    Upload a reference motion video, an edited cut, a rendered output, or an audio track. Connect Claude via MCP (online HTTP or local stdio) so it can inspect frames, scene cuts, SSIM diffs, and audio — or send renders to your Review Inbox.
                  </p>
                  <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={() => setUploadOpen(true)}
                      className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white whitespace-nowrap shrink-0 transition-colors hover:bg-blue-500"
                    >
                      <Plus className="h-4 w-4" />
                      Upload Video or Audio
                    </button>
                    <button
                      type="button"
                      disabled={generatingSample}
                      onClick={() => void handleGenerateCalibration()}
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0b0e14] px-4 py-2.5 text-xs font-medium text-slate-200 whitespace-nowrap shrink-0 transition-colors hover:border-slate-600 hover:bg-slate-800 disabled:opacity-50"
                    >
                      <Sparkles className="h-4 w-4 text-slate-400" />
                      {generatingSample
                        ? 'Generating ffmpeg Clips...'
                        : 'Generate Calibration Clips (ffmpeg)'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('connect')}
                      className="rounded-lg px-4 py-2.5 text-xs font-medium text-slate-300 underline-offset-4 hover:text-white hover:underline"
                    >
                      View MCP Connection Setup
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {activeTab === 'compare' && (
            <CompareView assets={assets} comparisons={comparisons} />
          )}

          {activeTab === 'reviews' && (
            <ReviewInboxView
              reviews={reviews}
              assets={assets}
              onRefresh={() => void fetchState()}
            />
          )}

          {activeTab === 'connect' && <ConnectMcpView capabilities={capabilities} />}
        </main>
      </div>

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={(asset) => {
          void fetchState();
          setSelectedAssetId(asset.id);
          setActiveTab('library');
        }}
      />
    </div>
  );
}
