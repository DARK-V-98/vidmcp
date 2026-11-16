import type {
  CompareResultUI,
  MediaAsset,
  OpticalFlowVector,
  SsimComparisonRecord,
} from '../types';

export interface LiveFlowSample {
  timestampSec: number;
  meanMagnitude: number;
  peakMagnitude: number;
  highMotionCoveragePct: number;
  dominantDirectionDeg: number;
  source: 'live' | 'mcp';
  vectors?: OpticalFlowVector[];
}

export interface LiveSsimSample {
  timestampSec: number;
  meanSsim: number;
  diffAreaPct: number;
  sensitivityCutoff: number;
  mode: string;
}

export function toFrameIndex(timestampSec: number, fps: number): number {
  const safeFps = fps > 0 ? fps : 30;
  return Math.max(0, Math.round(timestampSec * safeFps));
}

export function toSmpteTimecode(timestampSec: number, fps: number): string {
  const safeFps = fps > 0 ? fps : 30;
  const nominalFps = Math.max(1, Math.round(safeFps));
  const totalFrames = Math.max(0, Math.round(timestampSec * safeFps));
  const ff = totalFrames % nominalFps;
  const totalSec = Math.floor(totalFrames / nominalFps);
  const ss = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const mm = totalMin % 60;
  const hh = Math.floor(totalMin / 60);
  return [hh, mm, ss, ff].map((n) => String(n).padStart(2, '0')).join(':');
}

export function slugifyFilename(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'asset'
  );
}

export function downloadJsonFile(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function serializeAssetForNle(
  asset: MediaAsset,
  opts: {
    includeVectors?: boolean;
    liveFlowSample?: LiveFlowSample | null;
  } = {}
) {
  const fps = asset.probe.fps > 0 ? asset.probe.fps : 30;
  const includeVectors = opts.includeVectors !== false;

  const cuts = asset.cuts.map((sec, idx) => ({
    index: idx + 1,
    timestampSec: sec,
    frame: toFrameIndex(sec, fps),
    timecode: toSmpteTimecode(sec, fps),
  }));

  const markers = asset.markers.map((m) => ({
    id: m.id,
    timestampSec: m.timestampSec,
    frame: toFrameIndex(m.timestampSec, fps),
    timecode: toSmpteTimecode(m.timestampSec, fps),
    author: m.author,
    kind: m.kind ?? 'note',
    label: m.label,
    createdAt: m.createdAt,
  }));

  const opticalFlow = asset.opticalFlow
    ? {
        method: asset.opticalFlow.method,
        gridCols: asset.opticalFlow.gridCols,
        gridRows: asset.opticalFlow.gridRows,
        sampleCount: asset.opticalFlow.sampleCount,
        highMotionThreshold: asset.opticalFlow.highMotionThreshold,
        globalMeanMagnitude: asset.opticalFlow.globalMeanMagnitude,
        globalPeakMagnitude: asset.opticalFlow.globalPeakMagnitude,
        peakMotionTimestampSec: asset.opticalFlow.peakMotionTimestampSec,
        peakMotionFrame: toFrameIndex(asset.opticalFlow.peakMotionTimestampSec, fps),
        peakMotionTimecode: toSmpteTimecode(asset.opticalFlow.peakMotionTimestampSec, fps),
        motionBurstEvents: asset.opticalFlow.motionBurstTimestampsSec.map((sec) => ({
          timestampSec: sec,
          frame: toFrameIndex(sec, fps),
          timecode: toSmpteTimecode(sec, fps),
        })),
        generatedAt: asset.opticalFlow.generatedAt,
        frames: asset.opticalFlow.frames.map((f) => ({
          timestampSec: f.timestampSec,
          frame: toFrameIndex(f.timestampSec, fps),
          timecode: toSmpteTimecode(f.timestampSec, fps),
          meanMagnitude: f.meanMagnitude,
          peakMagnitude: f.peakMagnitude,
          highMotionCoveragePct: f.highMotionCoveragePct,
          dominantDirectionDeg: f.dominantDirectionDeg,
          ...(includeVectors ? { vectors: f.vectors } : { vectorCount: f.vectors.length }),
        })),
        ...(opts.liveFlowSample
          ? {
              liveOverlaySnapshot: {
                timestampSec: opts.liveFlowSample.timestampSec,
                frame: toFrameIndex(opts.liveFlowSample.timestampSec, fps),
                timecode: toSmpteTimecode(opts.liveFlowSample.timestampSec, fps),
                meanMagnitude: opts.liveFlowSample.meanMagnitude,
                peakMagnitude: opts.liveFlowSample.peakMagnitude,
                highMotionCoveragePct: opts.liveFlowSample.highMotionCoveragePct,
                dominantDirectionDeg: opts.liveFlowSample.dominantDirectionDeg,
                source: opts.liveFlowSample.source,
                ...(includeVectors && opts.liveFlowSample.vectors
                  ? { vectors: opts.liveFlowSample.vectors }
                  : {}),
              },
            }
          : {}),
      }
    : opts.liveFlowSample
      ? {
          method: 'block_match_sad_live',
          liveOverlaySnapshot: {
            timestampSec: opts.liveFlowSample.timestampSec,
            frame: toFrameIndex(opts.liveFlowSample.timestampSec, fps),
            timecode: toSmpteTimecode(opts.liveFlowSample.timestampSec, fps),
            meanMagnitude: opts.liveFlowSample.meanMagnitude,
            peakMagnitude: opts.liveFlowSample.peakMagnitude,
            highMotionCoveragePct: opts.liveFlowSample.highMotionCoveragePct,
            dominantDirectionDeg: opts.liveFlowSample.dominantDirectionDeg,
            source: opts.liveFlowSample.source,
            ...(includeVectors && opts.liveFlowSample.vectors
              ? { vectors: opts.liveFlowSample.vectors }
              : {}),
          },
        }
      : null;

  const audioAnalysis = asset.audioAnalysis
    ? {
        binsCount: asset.audioAnalysis.binsCount,
        maxPeak: asset.audioAnalysis.maxPeak,
        maxPeakDb: asset.audioAnalysis.maxPeakDb,
        meanRms: asset.audioAnalysis.meanRms,
        meanRmsDb: asset.audioAnalysis.meanRmsDb,
        crestFactorDb: asset.audioAnalysis.crestFactorDb,
        transientEvents: asset.audioAnalysis.transientTimestampsSec.map((sec) => ({
          timestampSec: sec,
          frame: toFrameIndex(sec, fps),
          timecode: toSmpteTimecode(sec, fps),
        })),
        waveformPeaksCount: asset.waveformPeaks.length,
      }
    : null;

  return {
    id: asset.id,
    title: asset.title,
    role: asset.role,
    kind: asset.kind,
    sourceType: asset.sourceType,
    filePath: asset.filePath,
    originalUrl: asset.originalUrl ?? null,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    createdAt: asset.createdAt,
    notes: asset.notes ?? null,
    probe: asset.probe,
    sceneAnalysis: {
      cutCount: cuts.length,
      cuts,
      markerCount: markers.length,
      markers,
    },
    opticalFlow,
    audioAnalysis,
  };
}

export function buildSingleAssetNleExport(
  asset: MediaAsset,
  relatedComparisons: SsimComparisonRecord[],
  allAssets: MediaAsset[],
  opts: {
    includeVectors?: boolean;
    liveFlowSample?: LiveFlowSample | null;
  } = {}
) {
  return {
    schema: 'cutcheck.nle-analysis.v1',
    exportScope: 'single_asset' as const,
    sourceApp: 'CutCheck MCP',
    exportedAt: new Date().toISOString(),
    asset: serializeAssetForNle(asset, opts),
    ssimComparisons: relatedComparisons.map((c) => {
      const ref = allAssets.find((a) => a.id === c.referenceId);
      const tgt = allAssets.find((a) => a.id === c.targetId);
      const refFps = ref?.probe.fps || asset.probe.fps || 30;
      const tgtFps = tgt?.probe.fps || asset.probe.fps || 30;
      return {
        id: c.id,
        referenceId: c.referenceId,
        targetId: c.targetId,
        ssimScore: c.ssimScore,
        durationDeltaSec: c.durationDeltaSec,
        fpsDelta: c.fpsDelta,
        resolutionMatch: c.resolutionMatch,
        generatedAt: c.generatedAt,
        samples: c.samples.map((s) => ({
          progressPct: s.progressPct,
          refTimestampSec: s.refTimestampSec,
          refFrame: toFrameIndex(s.refTimestampSec, refFps),
          refTimecode: toSmpteTimecode(s.refTimestampSec, refFps),
          targetTimestampSec: s.targetTimestampSec,
          targetFrame: toFrameIndex(s.targetTimestampSec, tgtFps),
          targetTimecode: toSmpteTimecode(s.targetTimestampSec, tgtFps),
        })),
      };
    }),
  };
}

export function buildComparePairNleExport(
  refAsset: MediaAsset,
  targetAsset: MediaAsset,
  comparison: SsimComparisonRecord | null,
  diffResult: CompareResultUI | null,
  liveSsimSample: LiveSsimSample | null
) {
  const refFps = refAsset.probe.fps > 0 ? refAsset.probe.fps : 30;
  const tgtFps = targetAsset.probe.fps > 0 ? targetAsset.probe.fps : 30;

  const ffmpegComparison = diffResult
    ? {
        referenceId: refAsset.id,
        targetId: targetAsset.id,
        ssimScore: diffResult.ssimScore,
        durationDeltaSec: diffResult.durationDeltaSec,
        fpsDelta: diffResult.fpsDelta,
        resolutionMatch: diffResult.resolutionMatch,
        generatedAt: comparison?.generatedAt ?? new Date().toISOString(),
        samples: diffResult.pairs.map((p) => ({
          progressPct: p.progressPct,
          refTimestampSec: p.refTimestampSec,
          refFrame: toFrameIndex(p.refTimestampSec, refFps),
          refTimecode: toSmpteTimecode(p.refTimestampSec, refFps),
          targetTimestampSec: p.targetTimestampSec,
          targetFrame: toFrameIndex(p.targetTimestampSec, tgtFps),
          targetTimecode: toSmpteTimecode(p.targetTimestampSec, tgtFps),
        })),
      }
    : comparison
      ? {
          id: comparison.id,
          referenceId: comparison.referenceId,
          targetId: comparison.targetId,
          ssimScore: comparison.ssimScore,
          durationDeltaSec: comparison.durationDeltaSec,
          fpsDelta: comparison.fpsDelta,
          resolutionMatch: comparison.resolutionMatch,
          generatedAt: comparison.generatedAt,
          samples: comparison.samples.map((s) => ({
            progressPct: s.progressPct,
            refTimestampSec: s.refTimestampSec,
            refFrame: toFrameIndex(s.refTimestampSec, refFps),
            refTimecode: toSmpteTimecode(s.refTimestampSec, refFps),
            targetTimestampSec: s.targetTimestampSec,
            targetFrame: toFrameIndex(s.targetTimestampSec, tgtFps),
            targetTimecode: toSmpteTimecode(s.targetTimestampSec, tgtFps),
          })),
        }
      : null;

  return {
    schema: 'cutcheck.nle-analysis.v1',
    exportScope: 'compare_pair' as const,
    sourceApp: 'CutCheck MCP',
    exportedAt: new Date().toISOString(),
    reference: serializeAssetForNle(refAsset),
    target: serializeAssetForNle(targetAsset),
    ssimAnalysis: {
      ffmpegComparison,
      liveHeatmapSnapshot: liveSsimSample
        ? {
            timestampSec: liveSsimSample.timestampSec,
            frame: toFrameIndex(liveSsimSample.timestampSec, tgtFps),
            timecode: toSmpteTimecode(liveSsimSample.timestampSec, tgtFps),
            mode: liveSsimSample.mode,
            sensitivityCutoff: liveSsimSample.sensitivityCutoff,
            meanSsim: liveSsimSample.meanSsim,
            diffAreaPct: liveSsimSample.diffAreaPct,
          }
        : null,
    },
  };
}
