import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  GitCompare,
  Pause,
  Play,
  RotateCcw,
} from 'lucide-react';
import type { CompareResultUI, MediaAsset, SsimComparisonRecord } from '../types';
import { formatTimecode, roleShortLabel } from '../utils/format';
import {
  buildComparePairNleExport,
  downloadJsonFile,
  type LiveSsimSample,
} from '../utils/nleExport';
import { SsimHeatmapOverlay, type HeatmapMode } from './SsimHeatmapOverlay';

interface CompareViewProps {
  assets: MediaAsset[];
  comparisons?: SsimComparisonRecord[];
}

export function CompareView({ assets, comparisons = [] }: CompareViewProps) {
  const videoAssets = assets.filter((a) => a.probe.hasVideo);
  const defaultRef =
    videoAssets.find((a) => a.role === 'reference')?.id ?? videoAssets[0]?.id ?? '';
  const defaultTarget =
    videoAssets.find((a) => a.role === 'rendered' || a.role === 'edited')?.id ??
    videoAssets[1]?.id ??
    videoAssets[0]?.id ??
    '';

  const [refId, setRefId] = useState(defaultRef);
  const [targetId, setTargetId] = useState(defaultTarget);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioSource, setAudioSource] = useState<'none' | 'ref' | 'target'>('target');
  const [diffResult, setDiffResult] = useState<CompareResultUI | null>(null);
  const [runningDiff, setRunningDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>('overlay');
  const [heatmapOpacity, setHeatmapOpacity] = useState(0.8);
  const [heatmapSensitivity, setHeatmapSensitivity] = useState(0.92);
  const [exportedNle, setExportedNle] = useState(false);

  const refVideo = useRef<HTMLVideoElement | null>(null);
  const targetVideo = useRef<HTMLVideoElement | null>(null);
  const liveSsimRef = useRef<LiveSsimSample | null>(null);
  const [refVideoEl, setRefVideoEl] = useState<HTMLVideoElement | null>(null);
  const [targetVideoEl, setTargetVideoEl] = useState<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!refId && videoAssets[0]) setRefId(videoAssets[0].id);
    if (!targetId && (videoAssets[1] || videoAssets[0])) {
      setTargetId((videoAssets[1] ?? videoAssets[0]).id);
    }
  }, [videoAssets, refId, targetId]);

  const refAsset = videoAssets.find((a) => a.id === refId);
  const targetAsset = videoAssets.find((a) => a.id === targetId);
  const maxDuration = Math.max(
    refAsset?.probe.durationSec ?? 0,
    targetAsset?.probe.durationSec ?? 0,
    1
  );

  const syncSeek = (sec: number) => {
    const clamped = Math.max(0, Math.min(sec, maxDuration));
    if (refVideo.current) {
      refVideo.current.currentTime = Math.min(clamped, refAsset?.probe.durationSec ?? clamped);
    }
    if (targetVideo.current) {
      targetVideo.current.currentTime = Math.min(
        clamped,
        targetAsset?.probe.durationSec ?? clamped
      );
    }
    setCurrentTime(clamped);
  };

  const togglePlayBoth = () => {
    const r = refVideo.current;
    const t = targetVideo.current;
    if (!r || !t) return;
    if (playing) {
      r.pause();
      t.pause();
      setPlaying(false);
    } else {
      void r.play();
      void t.play();
      setPlaying(true);
    }
  };

  const stepBoth = (deltaFrames: number) => {
    const fps = targetAsset?.probe.fps || refAsset?.probe.fps || 30;
    if (refVideo.current) refVideo.current.pause();
    if (targetVideo.current) targetVideo.current.pause();
    setPlaying(false);
    syncSeek(currentTime + deltaFrames / fps);
  };

  const runFfmpegDiff = async () => {
    if (!refId || !targetId) return;
    setRunningDiff(true);
    setDiffError(null);
    try {
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceId: refId, targetId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Comparison failed.');
      setDiffResult(data);
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : 'Comparison failed.');
    } finally {
      setRunningDiff(false);
    }
  };

  const handleExportCompareNleJson = () => {
    if (!refAsset || !targetAsset) return;
    const savedComparison =
      comparisons.find(
        (c) => c.referenceId === refAsset.id && c.targetId === targetAsset.id
      ) ?? null;
    const payload = buildComparePairNleExport(
      refAsset,
      targetAsset,
      savedComparison,
      diffResult,
      liveSsimRef.current
    );
    const filename = `cutcheck-nle-compare-${refAsset.id}-vs-${targetAsset.id}.json`;
    downloadJsonFile(filename, payload);
    setExportedNle(true);
    setTimeout(() => setExportedNle(false), 1800);
  };

  if (videoAssets.length < 1) {
    return (
      <div className="rounded-xl border border-slate-800 bg-[#121721] p-10 text-center">
        <GitCompare className="mx-auto h-8 w-8 text-slate-500" />
        <h2 className="mt-3 font-display text-base font-semibold text-slate-100">
          Add Videos to Run Side-by-Side QA
        </h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">
          Upload a reference motion video and an edited or rendered video to compare playback timing, SSIM similarity, and pixel differences.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <h1 className="font-display text-xl font-semibold text-slate-100">
            Reference vs. Rendered QA Compare
          </h1>
          <p className="mt-0.5 text-sm text-slate-400">
            Synced dual playback and deterministic ffmpeg SSIM / pixel-difference verification.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleExportCompareNleJson}
            disabled={!refAsset || !targetAsset}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#121721] px-3.5 py-2 text-xs font-medium text-slate-200 whitespace-nowrap shrink-0 transition-colors hover:border-slate-600 hover:bg-slate-800 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            {exportedNle ? 'Exported NLE JSON' : 'Export NLE JSON'}
          </button>

          <button
            type="button"
            onClick={runFfmpegDiff}
            disabled={runningDiff || !refId || !targetId}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0 transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            <GitCompare className="h-3.5 w-3.5" />
            {runningDiff ? 'Running ffmpeg Diff...' : 'Run Visual & SSIM Diff'}
          </button>
        </div>
      </div>

      {/* Asset Selectors + Dual Video Viewports */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#121721]">
          <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <span className="text-xs font-medium text-slate-400">Left · Reference</span>
            <select
              aria-label="Reference video"
              value={refId}
              onChange={(e) => {
                setRefId(e.target.value);
                setDiffResult(null);
              }}
              className="max-w-[260px] rounded-md border border-slate-800 bg-[#0b0e14] px-2.5 py-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none"
            >
              {videoAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  [{roleShortLabel(a.role)}] {a.title}
                </option>
              ))}
            </select>
          </div>
          <div className="aspect-video bg-black">
            {refAsset && (
              <video
                ref={(el) => {
                  if (refVideo.current !== el) {
                    refVideo.current = el;
                    setRefVideoEl(el);
                  }
                }}
                src={`/api/media/${refAsset.id}/stream`}
                muted={audioSource !== 'ref'}
                playsInline
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                onEnded={() => setPlaying(false)}
                className="h-full w-full object-contain"
              />
            )}
          </div>
          {refAsset && (
            <div className="flex items-center justify-between px-4 py-2.5 font-mono text-xs text-slate-400 tabular-nums">
              <span>
                {refAsset.probe.width}×{refAsset.probe.height} · {refAsset.probe.fps}fps
              </span>
              <span>{refAsset.probe.durationSec.toFixed(3)}s</span>
            </div>
          )}
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#121721]">
          <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <span className="text-xs font-medium text-slate-400">Right · Edited / Rendered</span>
            <select
              aria-label="Target video"
              value={targetId}
              onChange={(e) => {
                setTargetId(e.target.value);
                setDiffResult(null);
              }}
              className="max-w-[260px] rounded-md border border-slate-800 bg-[#0b0e14] px-2.5 py-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none"
            >
              {videoAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  [{roleShortLabel(a.role)}] {a.title}
                </option>
              ))}
            </select>
          </div>
          <div className="relative aspect-video bg-black">
            {targetAsset && (
              <>
                <video
                  ref={(el) => {
                    if (targetVideo.current !== el) {
                      targetVideo.current = el;
                      setTargetVideoEl(el);
                    }
                  }}
                  src={`/api/media/${targetAsset.id}/stream`}
                  muted={audioSource !== 'target'}
                  playsInline
                  onEnded={() => setPlaying(false)}
                  className="h-full w-full object-contain"
                />
                <SsimHeatmapOverlay
                  refVideo={refVideoEl}
                  targetVideo={targetVideoEl}
                  mode={heatmapMode}
                  opacity={heatmapOpacity}
                  sensitivity={heatmapSensitivity}
                  onMetricsUpdate={(sample) => {
                    liveSsimRef.current = sample
                      ? {
                          timestampSec: sample.timestampSec,
                          meanSsim: sample.meanSsim,
                          diffAreaPct: sample.diffAreaPct,
                          sensitivityCutoff: heatmapSensitivity,
                          mode: heatmapMode,
                        }
                      : null;
                  }}
                />
              </>
            )}
          </div>
          {targetAsset && (
            <div className="flex items-center justify-between px-4 py-2.5 font-mono text-xs text-slate-400 tabular-nums">
              <span>
                {targetAsset.probe.width}×{targetAsset.probe.height} · {targetAsset.probe.fps}fps
              </span>
              <span>{targetAsset.probe.durationSec.toFixed(3)}s</span>
            </div>
          )}
        </div>
      </div>

      {/* SSIM Heatmap Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-[#121721] px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-medium text-slate-300">SSIM Heatmap Layer</span>
          <div className="flex items-center gap-1 rounded-lg bg-[#0b0e14] p-0.5 text-[11px]">
            {(
              [
                ['off', 'Off'],
                ['overlay', 'Overlay'],
                ['isolated', 'Isolated Diff'],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setHeatmapMode(m)}
                className={`rounded-md px-2.5 py-1 font-medium whitespace-nowrap transition-colors ${
                  heatmapMode === m
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="hidden sm:flex items-center gap-2 text-[11px] text-slate-400">
            <span>Low Diff</span>
            <span className="h-2 w-16 rounded-sm bg-gradient-to-r from-sky-400 via-amber-400 to-red-500" />
            <span>High Diff</span>
          </div>
        </div>

        {heatmapMode !== 'off' && (
          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
            <label className="flex items-center gap-2">
              <span>Opacity</span>
              <input
                type="range"
                min={0.2}
                max={1}
                step={0.05}
                value={heatmapOpacity}
                onChange={(e) => setHeatmapOpacity(Number(e.target.value))}
                className="w-20 accent-blue-500"
              />
              <span className="w-8 font-mono text-[11px] text-slate-200 tabular-nums">
                {Math.round(heatmapOpacity * 100)}%
              </span>
            </label>
            <label className="flex items-center gap-2">
              <span>SSIM Cutoff</span>
              <input
                type="range"
                min={0.75}
                max={0.99}
                step={0.01}
                value={heatmapSensitivity}
                onChange={(e) => setHeatmapSensitivity(Number(e.target.value))}
                className="w-20 accent-blue-500"
              />
              <span className="w-10 font-mono text-[11px] text-slate-200 tabular-nums">
                {heatmapSensitivity.toFixed(2)}
              </span>
            </label>
          </div>
        )}
      </div>

      {/* Synced Transport Bar */}
      <div className="space-y-3 rounded-xl border border-slate-800 bg-[#121721] px-4 py-3.5">
        <input
          type="range"
          min={0}
          max={maxDuration}
          step={0.01}
          value={currentTime}
          onChange={(e) => syncSeek(Number(e.target.value))}
          aria-label="Synced timeline scrubber"
          className="h-1.5 w-full cursor-pointer accent-blue-500"
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={togglePlayBoth}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white whitespace-nowrap shrink-0 hover:bg-blue-500"
            >
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {playing ? 'Pause Synced' : 'Play Synced'}
            </button>
            <button
              type="button"
              onClick={() => stepBoth(-1)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-[#0b0e14] px-2.5 py-1.5 font-mono text-xs text-slate-300 hover:border-slate-700"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              1f
            </button>
            <button
              type="button"
              onClick={() => stepBoth(1)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-[#0b0e14] px-2.5 py-1.5 font-mono text-xs text-slate-300 hover:border-slate-700"
            >
              1f
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setPlaying(false);
                if (refVideo.current) refVideo.current.pause();
                if (targetVideo.current) targetVideo.current.pause();
                syncSeek(0);
              }}
              aria-label="Reset playhead to start"
              className="rounded-lg border border-slate-800 bg-[#0b0e14] p-1.5 text-slate-400 hover:text-white"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <span className="font-mono text-xs text-slate-200 tabular-nums">
              {formatTimecode(currentTime)} / {formatTimecode(maxDuration)}
            </span>

            <div className="flex items-center gap-1 rounded-lg bg-[#0b0e14] p-0.5 text-[11px]">
              {(
                [
                  ['ref', 'Hear Ref'],
                  ['target', 'Hear Rendered'],
                  ['none', 'Mute Both'],
                ] as const
              ).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setAudioSource(val)}
                  className={`rounded-md px-2.5 py-1 font-medium whitespace-nowrap transition-colors ${
                    audioSource === val
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {diffError && (
        <div className="rounded-lg border border-red-900/70 bg-red-950/40 px-4 py-3 text-xs text-red-300">
          {diffError}
        </div>
      )}

      {/* Visual & SSIM Diff Output (matches what Claude sees via compare_reference_and_rendered) */}
      {diffResult && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-800 bg-slate-800 sm:grid-cols-4">
            <div className="bg-[#121721] px-4 py-3">
              <div className="text-[11px] text-slate-400">SSIM Visual Similarity</div>
              <div className="mt-1 font-mono text-base font-semibold text-slate-100 tabular-nums">
                {diffResult.ssimScore !== null ? diffResult.ssimScore.toFixed(4) : 'N/A'}
              </div>
            </div>
            <div className="bg-[#121721] px-4 py-3">
              <div className="text-[11px] text-slate-400">Duration Delta</div>
              <div className="mt-1 font-mono text-base font-semibold text-slate-100 tabular-nums">
                {diffResult.durationDeltaSec >= 0 ? '+' : ''}
                {diffResult.durationDeltaSec.toFixed(3)}s
              </div>
            </div>
            <div className="bg-[#121721] px-4 py-3">
              <div className="text-[11px] text-slate-400">FPS Delta</div>
              <div className="mt-1 font-mono text-base font-semibold text-slate-100 tabular-nums">
                {diffResult.fpsDelta >= 0 ? '+' : ''}
                {diffResult.fpsDelta} fps
              </div>
            </div>
            <div className="bg-[#121721] px-4 py-3">
              <div className="text-[11px] text-slate-400">Resolution Match</div>
              <div
                className={`mt-1 text-sm font-semibold ${
                  diffResult.resolutionMatch ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {diffResult.resolutionMatch ? 'Exact Match' : 'Dimension Mismatch'}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {diffResult.pairs.map((pair) => (
              <div
                key={pair.progressPct}
                className="overflow-hidden rounded-xl border border-slate-800 bg-[#121721] p-4"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-slate-400 tabular-nums">
                  <span>Progress {pair.progressPct}%</span>
                  <span>
                    Ref {pair.refTimestampSec}s vs Target {pair.targetTimestampSec}s
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                  <div className="overflow-hidden rounded-lg border border-slate-800 bg-black lg:col-span-2">
                    <img
                      src={pair.sideBySideDataUrl}
                      alt={`Side by side at ${pair.progressPct}%`}
                      referrerPolicy="no-referrer"
                      className="w-full object-contain"
                    />
                  </div>
                  {pair.diffDataUrl && (
                    <div className="overflow-hidden rounded-lg border border-slate-800 bg-black">
                      <img
                        src={pair.diffDataUrl}
                        alt={`Pixel diff map at ${pair.progressPct}%`}
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-contain"
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
