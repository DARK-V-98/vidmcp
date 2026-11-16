import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Film,
  Pause,
  Play,
  Plus,
  Send,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { MediaAsset, MediaRole, SsimComparisonRecord } from '../types';
import { formatBytes, formatShortTime, formatTimecode, roleLabel } from '../utils/format';
import {
  buildSingleAssetNleExport,
  downloadJsonFile,
  slugifyFilename,
  type LiveFlowSample,
} from '../utils/nleExport';
import { OpticalFlowOverlay, type OpticalFlowMode } from './OpticalFlowOverlay';
import { WaveformVisualizer } from './WaveformVisualizer';

interface MediaPlayerViewProps {
  asset: MediaAsset;
  allAssets?: MediaAsset[];
  comparisons?: SsimComparisonRecord[];
  onRefresh: () => void;
  onDelete: (id: string) => void;
  onSendToReview: (asset: MediaAsset) => void;
}

interface FrameThumb {
  timestampSec: number;
  dataUrl: string;
}

export function MediaPlayerView({
  asset,
  allAssets = [],
  comparisons = [],
  onRefresh,
  onDelete,
  onSendToReview,
}: MediaPlayerViewProps) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const liveFlowRef = useRef<LiveFlowSample | null>(null);
  const [mediaEl, setMediaEl] = useState<HTMLMediaElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [frames, setFrames] = useState<FrameThumb[]>([]);
  const [loadingFrames, setLoadingFrames] = useState(false);
  const [markerLabel, setMarkerLabel] = useState('');
  const [savingMarker, setSavingMarker] = useState(false);
  const [cutThreshold, setCutThreshold] = useState(0.25);
  const [detectingCuts, setDetectingCuts] = useState(false);
  const [flowMode, setFlowMode] = useState<OpticalFlowMode>(
    asset.opticalFlow ? 'both' : 'off'
  );
  const [flowThreshold, setFlowThreshold] = useState(
    asset.opticalFlow?.highMotionThreshold ?? 2.0
  );
  const [flowOpacity, setFlowOpacity] = useState(0.9);
  const [analyzingFlow, setAnalyzingFlow] = useState(false);
  const [exportedNle, setExportedNle] = useState(false);

  const streamUrl = `/api/media/${asset.id}/stream`;
  const fps = asset.probe.fps > 0 ? asset.probe.fps : 30;
  const frameNumber = Math.round(currentTime * fps);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setFrames([]);
    liveFlowRef.current = null;
    if (!asset.probe.hasVideo) return;

    let cancelled = false;
    setLoadingFrames(true);
    fetch(`/api/media/${asset.id}/frames?count=8`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data.frames)) {
          setFrames(data.frames);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingFrames(false);
      });

    return () => {
      cancelled = true;
    };
  }, [asset.id, asset.probe.hasVideo]);

  useEffect(() => {
    if (mediaRef.current) {
      mediaRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, asset.id]);

  useEffect(() => {
    if (asset.opticalFlow?.generatedAt) {
      setFlowMode((prev) => (prev === 'off' ? 'both' : prev));
      setFlowThreshold(asset.opticalFlow.highMotionThreshold);
    }
  }, [asset.opticalFlow?.generatedAt, asset.opticalFlow?.highMotionThreshold]);

  const togglePlay = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
      setPlaying(true);
    } else {
      el.pause();
      setPlaying(false);
    }
  };

  const seekTo = (sec: number) => {
    const el = mediaRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(sec, asset.probe.durationSec || sec));
    el.currentTime = clamped;
    setCurrentTime(clamped);
  };

  const stepFrames = (deltaFrames: number) => {
    const el = mediaRef.current;
    if (!el) return;
    el.pause();
    setPlaying(false);
    seekTo(el.currentTime + deltaFrames / fps);
  };

  const handleRoleChange = async (newRole: MediaRole) => {
    await fetch(`/api/media/${asset.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    });
    onRefresh();
  };

  const handleAddMarker = async (e: FormEvent) => {
    e.preventDefault();
    if (!markerLabel.trim()) return;
    setSavingMarker(true);
    try {
      await fetch(`/api/media/${asset.id}/markers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestampSec: currentTime,
          label: markerLabel.trim(),
          author: 'human',
        }),
      });
      setMarkerLabel('');
      onRefresh();
    } finally {
      setSavingMarker(false);
    }
  };

  const handleDeleteMarker = async (markerId: string) => {
    await fetch(`/api/media/${asset.id}/markers/${markerId}`, {
      method: 'DELETE',
    });
    onRefresh();
  };

  const handleDetectCuts = async () => {
    setDetectingCuts(true);
    try {
      await fetch(`/api/media/${asset.id}/detect-cuts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold: cutThreshold }),
      });
      onRefresh();
    } finally {
      setDetectingCuts(false);
    }
  };

  const handleAnalyzeOpticalFlow = async () => {
    setAnalyzingFlow(true);
    try {
      await fetch(`/api/media/${asset.id}/optical-flow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ samples: 8, highMotionThreshold: flowThreshold }),
      });
      setFlowMode('both');
      onRefresh();
    } finally {
      setAnalyzingFlow(false);
    }
  };

  const handleExportNleJson = () => {
    const related = comparisons.filter(
      (c) => c.referenceId === asset.id || c.targetId === asset.id
    );
    const payload = buildSingleAssetNleExport(
      asset,
      related,
      allAssets.length > 0 ? allAssets : [asset],
      {
        includeVectors: true,
        liveFlowSample: liveFlowRef.current,
      }
    );
    const filename = `cutcheck-nle-${slugifyFilename(asset.title)}-${asset.id}.json`;
    downloadJsonFile(filename, payload);
    setExportedNle(true);
    setTimeout(() => setExportedNle(false), 1800);
  };

  return (
    <div className="space-y-6">
      {/* Header row */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800/90 pb-5">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>{roleLabel(asset.role)}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{asset.id}</span>
            <span aria-hidden="true">·</span>
            <span>{asset.sourceType}</span>
            <span aria-hidden="true">·</span>
            <span>{formatBytes(asset.sizeBytes)}</span>
          </div>
          <h1 className="font-display truncate text-xl font-semibold tracking-tight text-slate-100">
            {asset.title}
          </h1>
          {asset.notes && <p className="text-sm text-slate-400">{asset.notes}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <select
            aria-label="Asset role"
            value={asset.role}
            onChange={(e) => handleRoleChange(e.target.value as MediaRole)}
            className="rounded-lg border border-slate-800 bg-[#121721] px-3 py-2 text-xs font-medium text-slate-200 focus:border-blue-500 focus:outline-none"
          >
            <option value="reference">Role: Reference Motion</option>
            <option value="edited">Role: Edited Cut</option>
            <option value="rendered">Role: Rendered Output</option>
            <option value="audio">Role: Audio Track</option>
          </select>

          <button
            type="button"
            onClick={handleExportNleJson}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#121721] px-3 py-2 text-xs font-medium text-slate-200 whitespace-nowrap shrink-0 transition-colors hover:border-slate-600 hover:bg-slate-800"
          >
            <Download className="h-3.5 w-3.5" />
            {exportedNle ? 'Exported JSON' : 'Export NLE JSON'}
          </button>

          <button
            type="button"
            onClick={() => onSendToReview(asset)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#121721] px-3 py-2 text-xs font-medium text-slate-200 whitespace-nowrap shrink-0 transition-colors hover:border-slate-600 hover:bg-slate-800"
          >
            <Send className="h-3.5 w-3.5" />
            Queue Review
          </button>

          <button
            type="button"
            onClick={() => onDelete(asset.id)}
            aria-label="Delete asset"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-[#121721] px-3 py-2 text-xs font-medium text-red-400 whitespace-nowrap shrink-0 transition-colors hover:border-red-900/60 hover:bg-red-950/30"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </button>
        </div>
      </div>

      {/* Primary Player Surface */}
      <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#0d1118]">
        {asset.probe.hasVideo ? (
          <div className="flex max-h-[460px] items-center justify-center bg-black">
            <div className="relative inline-flex max-h-[460px] max-w-full items-center justify-center">
              <video
                ref={(el) => {
                  if (mediaRef.current !== el) {
                    mediaRef.current = el;
                    setMediaEl(el);
                  }
                }}
                src={streamUrl}
                muted={muted}
                playsInline
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onClick={togglePlay}
                className="block max-h-[460px] max-w-full cursor-pointer object-contain"
              />
              <OpticalFlowOverlay
                videoElement={mediaEl instanceof HTMLVideoElement ? mediaEl : null}
                mode={flowMode}
                threshold={flowThreshold}
                opacity={flowOpacity}
                analysis={asset.opticalFlow}
                onTelemetryUpdate={(sample) => {
                  liveFlowRef.current = sample;
                }}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-10">
            <Volume2 className="h-8 w-8 text-slate-400" />
            <p className="text-sm font-medium text-slate-200">Audio Track Playback</p>
            <audio
              ref={(el) => {
                if (mediaRef.current !== el) {
                  mediaRef.current = el;
                  setMediaEl(el);
                }
              }}
              src={streamUrl}
              muted={muted}
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
            />
          </div>
        )}

        {/* Scrubber + Waveform + Frame-Step Bar */}
        <div className="space-y-3 border-t border-slate-800 bg-[#121721] px-4 py-3.5">
          {asset.probe.hasAudio && (
            <WaveformVisualizer
              assetId={asset.id}
              streamUrl={streamUrl}
              mediaElement={mediaEl}
              durationSec={asset.probe.durationSec}
              currentTime={currentTime}
              fallbackPeaks={asset.waveformPeaks}
              initialSummary={asset.audioAnalysis}
              onSeek={seekTo}
            />
          )}

          {/* Visual Playback Timeline with Marker & Scene-Cut Pins */}
          <div className="space-y-1">
            {asset.markers.length > 0 && asset.probe.durationSec > 0 && (
              <div
                aria-label="Timeline markers track"
                className="relative h-5 w-full rounded bg-[#0b0e14]"
              >
                {asset.markers.map((m) => {
                  const pct = Math.max(
                    0,
                    Math.min(100, (m.timestampSec / asset.probe.durationSec) * 100)
                  );
                  const isCut = m.kind === 'scene_cut';
                  return (
                    <button
                      key={m.id}
                      type="button"
                      title={`${formatTimecode(m.timestampSec)} · ${m.label}`}
                      onClick={() => seekTo(m.timestampSec)}
                      style={{ left: `${pct}%` }}
                      className="group absolute top-0 bottom-0 -translate-x-1/2 px-1 focus:outline-none"
                    >
                      <span
                        className={`block h-full w-[2px] transition-colors ${
                          isCut
                            ? 'bg-amber-400 group-hover:bg-amber-300'
                            : m.author === 'ai'
                              ? 'bg-blue-400 group-hover:bg-blue-300'
                              : 'bg-emerald-400 group-hover:bg-emerald-300'
                        }`}
                      />
                    </button>
                  );
                })}
              </div>
            )}

            <input
              type="range"
              min={0}
              max={asset.probe.durationSec || 1}
              step={0.01}
              value={currentTime}
              onChange={(e) => seekTo(Number(e.target.value))}
              aria-label="Timeline scrubber"
              className="h-1.5 w-full cursor-pointer accent-blue-500"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={togglePlay}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white whitespace-nowrap shrink-0 transition-colors hover:bg-blue-500"
              >
                {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {playing ? 'Pause' : 'Play'}
              </button>

              {asset.probe.hasVideo && (
                <>
                  <button
                    type="button"
                    onClick={() => stepFrames(-1)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-[#0b0e14] px-2.5 py-1.5 font-mono text-xs text-slate-300 whitespace-nowrap shrink-0 hover:border-slate-700 hover:text-white"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    1f
                  </button>
                  <button
                    type="button"
                    onClick={() => stepFrames(1)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-[#0b0e14] px-2.5 py-1.5 font-mono text-xs text-slate-300 whitespace-nowrap shrink-0 hover:border-slate-700 hover:text-white"
                  >
                    1f
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => setMuted((m) => !m)}
                aria-label={muted ? 'Unmute' : 'Mute'}
                className="rounded-lg border border-slate-800 bg-[#0b0e14] p-1.5 text-slate-300 hover:border-slate-700 hover:text-white"
              >
                {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              </button>
            </div>

            <div className="flex items-center gap-4">
              <div className="font-mono text-xs text-slate-200 tabular-nums">
                {formatTimecode(currentTime)}{' '}
                <span className="text-slate-500">/ {formatTimecode(asset.probe.durationSec)}</span>
                {asset.probe.hasVideo && (
                  <span className="ml-2 text-slate-400">Frame {frameNumber}</span>
                )}
              </div>

              <div className="flex items-center gap-1 rounded-lg bg-[#0b0e14] p-0.5">
                {[0.25, 0.5, 1, 1.5].map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    onClick={() => setPlaybackRate(rate)}
                    className={`rounded-md px-2 py-1 font-mono text-[11px] whitespace-nowrap transition-colors ${
                      playbackRate === rate
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {rate}x
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Technical ffprobe Telemetry Grid */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-800 bg-slate-800 sm:grid-cols-3 lg:grid-cols-6">
        {[
          {
            label: 'Resolution',
            value: asset.probe.hasVideo ? `${asset.probe.width} × ${asset.probe.height}` : 'Audio only',
          },
          {
            label: 'Frame Rate',
            value: asset.probe.fps > 0 ? `${asset.probe.fps} fps` : '—',
          },
          {
            label: 'Duration',
            value: `${asset.probe.durationSec.toFixed(3)} s`,
          },
          {
            label: 'Total Frames',
            value: asset.probe.frameCount > 0 ? String(asset.probe.frameCount) : '—',
          },
          {
            label: 'Video / Audio',
            value: [asset.probe.videoCodec, asset.probe.audioCodec].filter(Boolean).join(' / ') || '—',
          },
          {
            label: 'Bitrate',
            value: asset.probe.bitrateKbps ? `${asset.probe.bitrateKbps} kbps` : '—',
          },
        ].map((item) => (
          <div key={item.label} className="bg-[#121721] px-4 py-3">
            <div className="text-[11px] font-medium text-slate-400">{item.label}</div>
            <div className="mt-1 font-mono text-sm font-medium text-slate-100 tabular-nums">
              {item.value}
            </div>
          </div>
        ))}
      </div>

      {/* Optical Flow & Motion Vector Visualization Controls */}
      {asset.probe.hasVideo && (
        <div className="rounded-xl border border-slate-800 bg-[#121721] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium text-slate-200">
                Optical Flow Motion Vectors
              </span>
              <div className="flex items-center gap-1 rounded-lg bg-[#0b0e14] p-0.5 text-[11px]">
                {(
                  [
                    ['off', 'Off'],
                    ['both', 'Vectors + Heat'],
                    ['vectors', 'Vectors'],
                    ['heat', 'Intensity Heat'],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setFlowMode(m)}
                    className={`rounded-md px-2.5 py-1 font-medium whitespace-nowrap transition-colors ${
                      flowMode === m
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
              {flowMode !== 'off' && (
                <>
                  <label className="flex items-center gap-2">
                    <span>Motion Cutoff</span>
                    <input
                      type="range"
                      min={0.5}
                      max={6}
                      step={0.25}
                      value={flowThreshold}
                      onChange={(e) => setFlowThreshold(Number(e.target.value))}
                      className="w-20 accent-amber-500"
                    />
                    <span className="w-11 font-mono text-[11px] text-slate-200 tabular-nums">
                      {flowThreshold.toFixed(2)}px
                    </span>
                  </label>
                  <label className="flex items-center gap-2">
                    <span>Opacity</span>
                    <input
                      type="range"
                      min={0.25}
                      max={1}
                      step={0.05}
                      value={flowOpacity}
                      onChange={(e) => setFlowOpacity(Number(e.target.value))}
                      className="w-16 accent-blue-500"
                    />
                    <span className="w-8 font-mono text-[11px] text-slate-200 tabular-nums">
                      {Math.round(flowOpacity * 100)}%
                    </span>
                  </label>
                </>
              )}

              <button
                type="button"
                disabled={analyzingFlow}
                onClick={() => void handleAnalyzeOpticalFlow()}
                className="rounded-lg border border-slate-700 bg-[#0b0e14] px-3 py-1.5 text-xs font-medium text-slate-200 whitespace-nowrap shrink-0 transition-colors hover:border-slate-600 hover:bg-slate-800 disabled:opacity-50"
              >
                {analyzingFlow ? 'Analyzing Flow...' : 'Analyze Optical Flow'}
              </button>
            </div>
          </div>

          {asset.opticalFlow && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/80 pt-3 text-xs">
              <div className="flex flex-wrap items-center gap-4 font-mono text-slate-400 tabular-nums">
                <span>
                  Global Mean{' '}
                  <strong className="text-slate-100">
                    {asset.opticalFlow.globalMeanMagnitude.toFixed(2)} px
                  </strong>
                </span>
                <span>
                  Global Peak{' '}
                  <strong className="text-amber-300">
                    {asset.opticalFlow.globalPeakMagnitude.toFixed(2)} px
                  </strong>
                </span>
                <button
                  type="button"
                  onClick={() => seekTo(asset.opticalFlow!.peakMotionTimestampSec)}
                  className="text-blue-300 hover:underline"
                >
                  Peak @ {formatShortTime(asset.opticalFlow.peakMotionTimestampSec)}
                </button>
              </div>

              {asset.opticalFlow.motionBurstTimestampsSec.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-slate-500">High Motion Bursts:</span>
                  {asset.opticalFlow.motionBurstTimestampsSec.slice(0, 8).map((t, i) => (
                    <button
                      key={`${t}-${i}`}
                      type="button"
                      onClick={() => seekTo(t)}
                      className="rounded border border-slate-800 bg-[#0b0e14] px-2 py-0.5 font-mono text-[11px] text-amber-300 tabular-nums hover:border-amber-500/60"
                    >
                      {formatShortTime(t)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Scene Cut Detection Strip */}
      {asset.probe.hasVideo && (
        <div className="rounded-xl border border-slate-800 bg-[#121721] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-100">
                Detected Motion & Scene Cuts
              </h2>
              <p className="text-xs text-slate-400">
                Extracted via ffmpeg scene-change threshold and pinned onto the playback timeline.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <select
                aria-label="Scene cut sensitivity"
                value={cutThreshold}
                onChange={(e) => setCutThreshold(Number(e.target.value))}
                className="rounded-md border border-slate-800 bg-[#0b0e14] px-2.5 py-1.5 font-mono text-xs text-slate-300 focus:border-blue-500 focus:outline-none"
              >
                <option value={0.15}>Threshold 0.15 (High)</option>
                <option value={0.25}>Threshold 0.25 (Default)</option>
                <option value={0.4}>Threshold 0.40 (Hard Cuts)</option>
              </select>
              <button
                type="button"
                disabled={detectingCuts}
                onClick={() => void handleDetectCuts()}
                className="rounded-lg border border-slate-700 bg-[#0b0e14] px-3 py-1.5 text-xs font-medium text-slate-200 whitespace-nowrap shrink-0 transition-colors hover:border-slate-600 hover:bg-slate-800 disabled:opacity-50"
              >
                {detectingCuts ? 'Detecting...' : 'Detect & Pin Cuts'}
              </button>
              <span className="font-mono text-xs text-slate-400 tabular-nums">
                {asset.cuts.length} cuts
              </span>
            </div>
          </div>

          {asset.cuts.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {asset.cuts.map((cutSec, idx) => (
                <button
                  key={`${cutSec}-${idx}`}
                  type="button"
                  onClick={() => seekTo(cutSec)}
                  className="rounded-md border border-slate-800 bg-[#0b0e14] px-2.5 py-1 font-mono text-xs text-amber-300 transition-colors hover:border-amber-500/60"
                >
                  {formatShortTime(cutSec)}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-slate-500">
              No abrupt scene cuts detected at this threshold (try 0.15 for subtle transitions).
            </p>
          )}
        </div>
      )}

      {/* Storyboard Keyframe Strip */}
      {asset.probe.hasVideo && (
        <div className="rounded-xl border border-slate-800 bg-[#121721] p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-100">
                Extracted Keyframes Seen by MCP
              </h2>
              <p className="text-xs text-slate-400">
                Click any frame to jump the player to that exact timestamp.
              </p>
            </div>
            {loadingFrames && (
              <span className="font-mono text-xs text-slate-400">Extracting frames...</span>
            )}
          </div>

          {frames.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
              {frames.map((frame, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => seekTo(frame.timestampSec)}
                  className="group overflow-hidden rounded-lg border border-slate-800 bg-[#0b0e14] text-left transition-colors hover:border-blue-500"
                >
                  <div className="aspect-video w-full overflow-hidden bg-black">
                    <img
                      src={frame.dataUrl}
                      alt={`Frame at ${frame.timestampSec}s`}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-105"
                    />
                  </div>
                  <div className="px-2 py-1.5 font-mono text-[11px] text-slate-400 tabular-nums group-hover:text-slate-200">
                    {formatTimecode(frame.timestampSec)}
                  </div>
                </button>
              ))}
            </div>
          ) : !loadingFrames ? (
            <div className="flex items-center gap-2 rounded-lg border border-slate-800/80 bg-[#0b0e14] px-3 py-4 text-xs text-slate-500">
              <Film className="h-4 w-4" />
              No preview frames available for this video.
            </div>
          ) : null}
        </div>
      )}

      {/* Timeline Markers (Human + AI) */}
      <div className="rounded-xl border border-slate-800 bg-[#121721] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-100">
              Timestamped Motion & QA Markers
            </h2>
            <p className="text-xs text-slate-400">
              Shared between you and Claude (via the add_ai_note MCP tool).
            </p>
          </div>
          <span className="font-mono text-xs text-slate-400 tabular-nums">
            {asset.markers.length} notes
          </span>
        </div>

        <form onSubmit={handleAddMarker} className="mb-4 flex flex-wrap gap-2">
          <div className="flex items-center rounded-lg border border-slate-800 bg-[#0b0e14] px-3 py-2 font-mono text-xs text-slate-300 tabular-nums">
            {formatTimecode(currentTime)}
          </div>
          <input
            type="text"
            value={markerLabel}
            onChange={(e) => setMarkerLabel(e.target.value)}
            placeholder="Add note at current playhead (e.g. ease-in curve starts 4 frames late)..."
            className="min-w-[220px] flex-1 rounded-lg border border-slate-800 bg-[#0b0e14] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={savingMarker || !markerLabel.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-100 whitespace-nowrap shrink-0 transition-colors hover:bg-slate-700 disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            Pin Note
          </button>
        </form>

        {asset.markers.length === 0 ? (
          <p className="text-xs text-slate-500">
            No markers pinned yet. Scrub to a frame and pin a note above.
          </p>
        ) : (
          <div className="divide-y divide-slate-800/80 rounded-lg border border-slate-800 bg-[#0b0e14]">
            {asset.markers.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => seekTo(m.timestampSec)}
                    className="rounded bg-slate-800 px-2 py-1 font-mono text-[11px] text-blue-300 tabular-nums hover:bg-slate-700"
                  >
                    {formatTimecode(m.timestampSec)}
                  </button>
                  <span
                    className={`text-[11px] font-medium ${
                      m.kind === 'scene_cut'
                        ? 'text-amber-400'
                        : m.author === 'ai'
                          ? 'text-blue-400'
                          : 'text-emerald-400'
                    }`}
                  >
                    {m.kind === 'scene_cut'
                      ? 'Scene Cut'
                      : m.author === 'ai'
                        ? 'AI Note'
                        : 'Human'}
                  </span>
                  <span aria-hidden="true" className="text-slate-600">
                    ·
                  </span>
                  <span className="truncate text-slate-200">{m.label}</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleDeleteMarker(m.id)}
                  aria-label="Delete marker"
                  className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
