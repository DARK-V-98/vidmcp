import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AudioAnalysisSummary,
  AudioEnvelopeBin,
  MediaProbeInfo,
  OpticalFlowAnalysis,
  OpticalFlowFrame,
  OpticalFlowVector,
} from './types.ts';

const execFileAsync = promisify(execFile);

export async function checkFfmpegAvailable(): Promise<{
  ffmpeg: boolean;
  ffprobe: boolean;
}> {
  const check = async (bin: string): Promise<boolean> => {
    try {
      await execFileAsync(bin, ['-version'], { timeout: 4000 });
      return true;
    } catch {
      return false;
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([check('ffmpeg'), check('ffprobe')]);
  return { ffmpeg, ffprobe };
}

function parseFrameRate(raw?: string): number {
  if (!raw) return 0;
  const parts = raw.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
      return Math.round((num / den) * 1000) / 1000;
    }
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
    bit_rate?: string;
  };
}

export async function probeMedia(filePath: string): Promise<MediaProbeInfo> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }
  );

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  const durationSec =
    Number(parsed.format?.duration ?? videoStream?.duration ?? audioStream?.duration ?? 0) || 0;
  const fps = parseFrameRate(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate);
  const nbFrames = Number(videoStream?.nb_frames ?? 0);
  const frameCount =
    Number.isFinite(nbFrames) && nbFrames > 0
      ? nbFrames
      : fps > 0 && durationSec > 0
        ? Math.round(fps * durationSec)
        : 0;

  const bitrateBps = Number(parsed.format?.bit_rate ?? 0);

  return {
    durationSec: Math.round(durationSec * 1000) / 1000,
    width: videoStream?.width ?? 0,
    height: videoStream?.height ?? 0,
    fps,
    frameCount,
    videoCodec: videoStream?.codec_name ?? null,
    pixelFormat: videoStream?.pix_fmt ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    sampleRate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : null,
    channels: audioStream?.channels ?? null,
    bitrateKbps: Number.isFinite(bitrateBps) && bitrateBps > 0 ? Math.round(bitrateBps / 1000) : null,
    hasAudio: Boolean(audioStream),
    hasVideo: Boolean(videoStream),
  };
}

export async function detectSceneCuts(
  filePath: string,
  threshold = 0.28
): Promise<number[]> {
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-i',
        filePath,
        '-filter:v',
        `select='gt(scene,${threshold})',showinfo`,
        '-f',
        'null',
        '-',
      ],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }
    );

    const cuts: number[] = [];
    const regex = /pts_time:([0-9.]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(stderr)) !== null) {
      const t = Math.round(Number(match[1]) * 1000) / 1000;
      if (Number.isFinite(t)) {
        cuts.push(t);
      }
    }
    return cuts.slice(0, 80);
  } catch {
    return [];
  }
}

function amplitudeToDb(val: number): number {
  if (val <= 1e-6) return -96;
  return Math.round(20 * Math.log10(val) * 100) / 100;
}

export async function analyzeAudioEnvelope(
  filePath: string,
  totalDurationSec: number,
  opts: { startSec?: number; endSec?: number; bins?: number } = {}
): Promise<{ bins: AudioEnvelopeBin[]; summary: AudioAnalysisSummary }> {
  const safeDuration = Math.max(0.05, totalDurationSec || 1);
  const startSec = Math.max(0, Math.min(opts.startSec ?? 0, safeDuration));
  const endSec = Math.max(
    startSec + 0.05,
    Math.min(opts.endSec ?? safeDuration, safeDuration)
  );
  const windowDuration = endSec - startSec;
  const requestedBins = Math.max(8, Math.min(opts.bins ?? 96, 256));

  try {
    const args = ['-v', 'error'];
    if (startSec > 0) {
      args.push('-ss', String(startSec));
    }
    args.push('-t', String(windowDuration), '-i', filePath, '-ac', '1', '-ar', '8000', '-f', 's16le', '-');

    const { stdout } = await execFileAsync('ffmpeg', args, {
      timeout: 20000,
      maxBuffer: 48 * 1024 * 1024,
      encoding: 'buffer',
    });

    const buf = stdout as unknown as Buffer;
    const totalSamples = Math.floor(buf.length / 2);
    if (totalSamples === 0) {
      return {
        bins: [],
        summary: {
          binsCount: 0,
          maxPeak: 0,
          maxPeakDb: -96,
          meanRms: 0,
          meanRmsDb: -96,
          crestFactorDb: 0,
          transientTimestampsSec: [],
        },
      };
    }

    const binCount = Math.min(requestedBins, totalSamples);
    const chunkSize = Math.max(1, Math.floor(totalSamples / binCount));
    const bins: AudioEnvelopeBin[] = [];
    let globalMaxPeak = 0;
    let totalRmsSqSum = 0;

    for (let i = 0; i < binCount; i++) {
      const s = i * chunkSize;
      const e = i === binCount - 1 ? totalSamples : Math.min(totalSamples, s + chunkSize);
      const count = Math.max(1, e - s);
      let maxVal = 0;
      let sumSq = 0;

      for (let j = s; j < e; j++) {
        const sample = buf.readInt16LE(j * 2) / 32768;
        const abs = Math.abs(sample);
        if (abs > maxVal) maxVal = abs;
        sumSq += sample * sample;
      }

      const rmsVal = Math.sqrt(sumSq / count);
      const roundedPeak = Math.round(maxVal * 10000) / 10000;
      const roundedRms = Math.round(rmsVal * 10000) / 10000;

      if (roundedPeak > globalMaxPeak) globalMaxPeak = roundedPeak;
      totalRmsSqSum += rmsVal * rmsVal;

      const binStart = Math.round((startSec + (i / binCount) * windowDuration) * 1000) / 1000;
      const binEnd = Math.round((startSec + ((i + 1) / binCount) * windowDuration) * 1000) / 1000;

      bins.push({
        index: i,
        startSec: binStart,
        endSec: binEnd,
        peak: roundedPeak,
        rms: roundedRms,
        peakDb: amplitudeToDb(roundedPeak),
        rmsDb: amplitudeToDb(roundedRms),
      });
    }

    const meanRms = Math.round(Math.sqrt(totalRmsSqSum / binCount) * 10000) / 10000;
    const maxPeakDb = amplitudeToDb(globalMaxPeak);
    const meanRmsDb = amplitudeToDb(meanRms);
    const crestFactorDb = Math.round((maxPeakDb - meanRmsDb) * 100) / 100;

    const transientTimestampsSec: number[] = [];
    for (let i = 1; i < bins.length; i++) {
      const lookbackStart = Math.max(0, i - 4);
      let localSum = 0;
      for (let k = lookbackStart; k < i; k++) {
        localSum += bins[k].rms;
      }
      const localAvg = localSum / Math.max(1, i - lookbackStart);
      if (bins[i].rms > Math.max(0.06, localAvg * 1.65)) {
        const center = Math.round(((bins[i].startSec + bins[i].endSec) / 2) * 1000) / 1000;
        const last = transientTimestampsSec[transientTimestampsSec.length - 1];
        if (last === undefined || center - last >= 0.15) {
          transientTimestampsSec.push(center);
        }
      }
    }

    return {
      bins,
      summary: {
        binsCount: bins.length,
        maxPeak: globalMaxPeak,
        maxPeakDb,
        meanRms,
        meanRmsDb,
        crestFactorDb,
        transientTimestampsSec: transientTimestampsSec.slice(0, 60),
      },
    };
  } catch {
    return {
      bins: [],
      summary: {
        binsCount: 0,
        maxPeak: 0,
        maxPeakDb: -96,
        meanRms: 0,
        meanRmsDb: -96,
        crestFactorDb: 0,
        transientTimestampsSec: [],
      },
    };
  }
}

export async function computeWaveformPeaks(
  filePath: string,
  bars = 96,
  durationSec = 10
): Promise<number[]> {
  const { bins } = await analyzeAudioEnvelope(filePath, durationSec, { bins: bars });
  return bins.map((b) => Math.round(b.peak * 1000) / 1000);
}

export interface ExtractedFrame {
  timestampSec: number;
  fileName: string;
  filePath: string;
  base64: string;
  mimeType: 'image/jpeg';
}

export async function extractFramesRange(
  filePath: string,
  outDir: string,
  probe: MediaProbeInfo,
  opts: {
    startSec?: number;
    endSec?: number;
    count?: number;
    maxWidth?: number;
  }
): Promise<ExtractedFrame[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const duration = Math.max(0.1, probe.durationSec || 1);
  const startSec = Math.max(0, Math.min(opts.startSec ?? 0, duration));
  const endSec = Math.max(startSec + 0.05, Math.min(opts.endSec ?? duration, duration));
  const count = Math.max(1, Math.min(opts.count ?? 6, 12));
  const maxWidth = Math.max(240, Math.min(opts.maxWidth ?? 720, 1920));

  const span = Math.max(0.05, endSec - startSec);
  const timestamps: number[] = [];
  if (count === 1) {
    timestamps.push(Math.round(startSec * 1000) / 1000);
  } else {
    for (let i = 0; i < count; i++) {
      const ratio = i / (count - 1);
      const t = Math.min(duration - 0.02, startSec + span * ratio);
      timestamps.push(Math.round(Math.max(0, t) * 1000) / 1000);
    }
  }

  const frames: ExtractedFrame[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    const fileName = `frame_${i}_${Math.round(t * 1000)}ms.jpg`;
    const outPath = path.join(outDir, fileName);

    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        String(t),
        '-i',
        filePath,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${maxWidth},iw)':-2`,
        '-q:v',
        '3',
        outPath,
      ],
      { timeout: 15000 }
    );

    if (fs.existsSync(outPath)) {
      const base64 = fs.readFileSync(outPath).toString('base64');
      frames.push({
        timestampSec: t,
        fileName,
        filePath: outPath,
        base64,
        mimeType: 'image/jpeg',
      });
    }
  }

  return frames;
}

export async function extractSingleFrame(
  filePath: string,
  outPath: string,
  timestampSec: number,
  maxWidth = 1080
): Promise<ExtractedFrame> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-ss',
      String(Math.max(0, timestampSec)),
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-vf',
      `scale='min(${maxWidth},iw)':-2`,
      '-q:v',
      '2',
      outPath,
    ],
    { timeout: 15000 }
  );

  const base64 = fs.readFileSync(outPath).toString('base64');
  return {
    timestampSec,
    fileName: path.basename(outPath),
    filePath: outPath,
    base64,
    mimeType: 'image/jpeg',
  };
}

export async function buildContactSheet(
  filePath: string,
  outPath: string,
  probe: MediaProbeInfo,
  cols = 4,
  rows = 3
): Promise<{ filePath: string; base64: string; mimeType: 'image/jpeg'; frameCount: number }> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const total = Math.max(1, cols * rows);
  const duration = Math.max(0.2, probe.durationSec || 1);
  const fps = total / duration;

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      filePath,
      '-vf',
      `fps=${fps.toFixed(4)},scale=320:-2,tile=${cols}x${rows}:padding=6:color=0x111827`,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      outPath,
    ],
    { timeout: 25000 }
  );

  const base64 = fs.readFileSync(outPath).toString('base64');
  return {
    filePath: outPath,
    base64,
    mimeType: 'image/jpeg',
    frameCount: total,
  };
}

export interface ComparisonPair {
  progressPct: number;
  refTimestampSec: number;
  targetTimestampSec: number;
  sideBySideBase64: string;
  diffBase64?: string;
  sideBySidePath: string;
  diffPath?: string;
}

export interface VideoComparisonResult {
  ssimScore: number | null;
  durationDeltaSec: number;
  fpsDelta: number;
  resolutionMatch: boolean;
  pairs: ComparisonPair[];
}

export async function compareVideos(
  refPath: string,
  refProbe: MediaProbeInfo,
  targetPath: string,
  targetProbe: MediaProbeInfo,
  outDir: string,
  sampleCount = 4,
  includeDiffMap = true
): Promise<VideoComparisonResult> {
  fs.mkdirSync(outDir, { recursive: true });

  // Compute SSIM across normalized scaled streams
  let ssimScore: number | null = null;
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-i',
        refPath,
        '-i',
        targetPath,
        '-filter_complex',
        '[0:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS[v0];[1:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS[v1];[v0][v1]ssim',
        '-f',
        'null',
        '-',
      ],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }
    );
    const match = /All:([0-9.]+)/.exec(stderr);
    if (match) {
      ssimScore = Math.round(Number(match[1]) * 10000) / 10000;
    }
  } catch {
    ssimScore = null;
  }

  const count = Math.max(1, Math.min(sampleCount, 6));
  const refDur = Math.max(0.1, refProbe.durationSec || 1);
  const tgtDur = Math.max(0.1, targetProbe.durationSec || 1);
  const pairs: ComparisonPair[] = [];

  for (let i = 0; i < count; i++) {
    const ratio = count === 1 ? 0.5 : i / (count - 1);
    const refT = Math.round(Math.min(refDur - 0.03, Math.max(0, refDur * ratio)) * 1000) / 1000;
    const tgtT = Math.round(Math.min(tgtDur - 0.03, Math.max(0, tgtDur * ratio)) * 1000) / 1000;

    const sidePath = path.join(outDir, `pair_${i}_sbs.jpg`);
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        String(refT),
        '-i',
        refPath,
        '-ss',
        String(tgtT),
        '-i',
        targetPath,
        '-filter_complex',
        '[0:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:color=0x0f172a[a];[1:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:color=0x0f172a[b];[a][b]hstack=inputs=2',
        '-frames:v',
        '1',
        '-q:v',
        '3',
        sidePath,
      ],
      { timeout: 15000 }
    );

    let diffPath: string | undefined;
    let diffBase64: string | undefined;
    if (includeDiffMap) {
      diffPath = path.join(outDir, `pair_${i}_diff.jpg`);
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-ss',
          String(refT),
          '-i',
          refPath,
          '-ss',
          String(tgtT),
          '-i',
          targetPath,
          '-filter_complex',
          "[0:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:color=0x000000[a];[1:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:color=0x000000[b];[a][b]blend=all_mode=difference,format=rgb24,lutrgb='r=min(255,val*3.5):g=min(255,max(0,val-40)*2.2):b=min(255,max(0,80-val)*0.9)'",
          '-frames:v',
          '1',
          '-q:v',
          '3',
          diffPath,
        ],
        { timeout: 15000 }
      );
      if (fs.existsSync(diffPath)) {
        diffBase64 = fs.readFileSync(diffPath).toString('base64');
      }
    }

    if (fs.existsSync(sidePath)) {
      pairs.push({
        progressPct: Math.round(ratio * 100),
        refTimestampSec: refT,
        targetTimestampSec: tgtT,
        sideBySideBase64: fs.readFileSync(sidePath).toString('base64'),
        diffBase64,
        sideBySidePath: sidePath,
        diffPath,
      });
    }
  }

  return {
    ssimScore,
    durationDeltaSec: Math.round((targetProbe.durationSec - refProbe.durationSec) * 1000) / 1000,
    fpsDelta: Math.round((targetProbe.fps - refProbe.fps) * 1000) / 1000,
    resolutionMatch:
      refProbe.width === targetProbe.width && refProbe.height === targetProbe.height,
    pairs,
  };
}

export async function extractAudioSegment(
  filePath: string,
  outPath: string,
  opts: { startSec?: number; durationSec?: number; format?: 'mp3' | 'wav' }
): Promise<{
  filePath: string;
  base64: string;
  mimeType: string;
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
}> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const format = opts.format ?? 'mp3';
  const args = ['-y'];
  if (opts.startSec !== undefined && opts.startSec > 0) {
    args.push('-ss', String(opts.startSec));
  }
  args.push('-i', filePath, '-vn');
  if (opts.durationSec !== undefined && opts.durationSec > 0) {
    args.push('-t', String(Math.min(opts.durationSec, 30)));
  } else {
    args.push('-t', '20');
  }
  if (format === 'mp3') {
    args.push('-ac', '1', '-ar', '24000', '-b:a', '64k', outPath);
  } else {
    args.push('-ac', '1', '-ar', '16000', outPath);
  }

  await execFileAsync('ffmpeg', args, { timeout: 20000 });

  let meanVolumeDb: number | null = null;
  let maxVolumeDb: number | null = null;
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      ['-hide_banner', '-i', outPath, '-af', 'volumedetect', '-f', 'null', '-'],
      { timeout: 10000 }
    );
    const meanMatch = /mean_volume:\s*(-?[0-9.]+)\s*dB/.exec(stderr);
    const maxMatch = /max_volume:\s*(-?[0-9.]+)\s*dB/.exec(stderr);
    if (meanMatch) meanVolumeDb = Number(meanMatch[1]);
    if (maxMatch) maxVolumeDb = Number(maxMatch[1]);
  } catch {
    // ignore loudness parse failure
  }

  const base64 = fs.readFileSync(outPath).toString('base64');
  return {
    filePath: outPath,
    base64,
    mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    meanVolumeDb,
    maxVolumeDb,
  };
}

export async function generateCalibrationClip(
  outPath: string,
  variant: 'reference' | 'rendered'
): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // Uses ffmpeg lavfi testsrc2 + sine audio to produce a genuine 4-second 30fps MP4
  const colorFilter =
    variant === 'reference'
      ? 'testsrc2=size=960x540:rate=30:duration=4'
      : 'testsrc2=size=960x540:rate=30:duration=4,eq=brightness=0.04:saturation=1.08';
  const freq = variant === 'reference' ? 440 : 523.25;

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      colorFilter,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${freq}:sample_rate=44100:duration=4`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-shortest',
      outPath,
    ],
    { timeout: 25000 }
  );
}

export async function renderMotionVectorFrame(
  filePath: string,
  outPath: string,
  timestampSec: number,
  maxWidth = 720
): Promise<{ timestampSec: number; base64: string; mimeType: 'image/jpeg' } | null> {
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const seekStart = Math.max(0, timestampSec - 0.12);
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        String(seekStart),
        '-i',
        filePath,
        '-vf',
        `mestimate=method=ds:mb_size=16,codecview=mv=pf+bf+bb,scale='min(${maxWidth},iw)':-2`,
        '-frames:v',
        '1',
        '-ss',
        String(Math.max(0, timestampSec - seekStart)),
        '-q:v',
        '3',
        outPath,
      ],
      { timeout: 15000 }
    );
    if (!fs.existsSync(outPath)) return null;
    return {
      timestampSec,
      base64: fs.readFileSync(outPath).toString('base64'),
      mimeType: 'image/jpeg',
    };
  } catch {
    return null;
  }
}

export async function analyzeOpticalFlow(
  assetId: string,
  filePath: string,
  probe: MediaProbeInfo,
  outDir: string,
  opts: {
    startSec?: number;
    endSec?: number;
    samples?: number;
    highMotionThreshold?: number;
    includeVectorFrames?: boolean;
  } = {}
): Promise<{
  analysis: OpticalFlowAnalysis;
  vectorFrames: Array<{ timestampSec: number; base64: string; mimeType: 'image/jpeg' }>;
}> {
  const FLOW_W = 160;
  const FLOW_H = 90;
  const GRID_COLS = 16;
  const GRID_ROWS = 9;
  const BLOCK_W = 10;
  const BLOCK_H = 10;
  const SEARCH_RADIUS = 6;
  const FRAME_BYTES = FLOW_W * FLOW_H;

  const duration = Math.max(0.2, probe.durationSec || 1);
  const startSec = Math.max(0, Math.min(opts.startSec ?? 0, duration - 0.08));
  const endSec = Math.max(startSec + 0.08, Math.min(opts.endSec ?? duration, duration));
  const sampleCount = Math.max(2, Math.min(opts.samples ?? 6, 16));
  const highMotionThreshold = Math.max(0.25, Math.min(opts.highMotionThreshold ?? 2.0, 12));

  const timestamps: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const ratio = i / Math.max(1, sampleCount - 1);
    const t = Math.min(duration - 0.06, startSec + (endSec - startSec) * ratio);
    timestamps.push(Math.round(Math.max(0, t) * 1000) / 1000);
  }

  const frames: OpticalFlowFrame[] = [];

  for (const t of timestamps) {
    try {
      const { stdout } = await execFileAsync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          String(t),
          '-i',
          filePath,
          '-frames:v',
          '2',
          '-vf',
          `scale=${FLOW_W}:${FLOW_H},format=gray`,
          '-f',
          'rawvideo',
          '-',
        ],
        { timeout: 12000, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' }
      );

      const raw = stdout as unknown as Buffer;
      if (raw.length < FRAME_BYTES * 2) continue;

      const f0 = raw.subarray(0, FRAME_BYTES);
      const f1 = raw.subarray(FRAME_BYTES, FRAME_BYTES * 2);

      const vectors: OpticalFlowVector[] = [];
      let sumMag = 0;
      let peakMag = 0;
      let highCount = 0;
      let sumDx = 0;
      let sumDy = 0;

      for (let gy = 0; gy < GRID_ROWS; gy++) {
        const by = gy * BLOCK_H;
        for (let gx = 0; gx < GRID_COLS; gx++) {
          const bx = gx * BLOCK_W;

          // Zero-motion SAD + check local contrast
          let zeroSad = 0;
          let minLuma = 255;
          let maxLuma = 0;
          for (let py = 0; py < BLOCK_H; py++) {
            const rowOffset = (by + py) * FLOW_W + bx;
            for (let px = 0; px < BLOCK_W; px++) {
              const v0 = f0[rowOffset + px];
              const v1 = f1[rowOffset + px];
              zeroSad += Math.abs(v0 - v1);
              if (v0 < minLuma) minLuma = v0;
              if (v0 > maxLuma) maxLuma = v0;
            }
          }

          let bestDx = 0;
          let bestDy = 0;
          let bestSad = zeroSad;

          if (maxLuma - minLuma >= 12 && zeroSad > BLOCK_W * BLOCK_H * 1.5) {
            for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
              const ty = by + dy;
              if (ty < 0 || ty + BLOCK_H > FLOW_H) continue;
              for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
                if (dx === 0 && dy === 0) continue;
                const tx = bx + dx;
                if (tx < 0 || tx + BLOCK_W > FLOW_W) continue;

                let sad = 0;
                for (let py = 0; py < BLOCK_H; py++) {
                  const r0 = (by + py) * FLOW_W + bx;
                  const r1 = (ty + py) * FLOW_W + tx;
                  for (let px = 0; px < BLOCK_W; px++) {
                    sad += Math.abs(f0[r0 + px] - f1[r1 + px]);
                  }
                  if (sad >= bestSad) break;
                }

                if (sad < bestSad) {
                  bestSad = sad;
                  bestDx = dx;
                  bestDy = dy;
                }
              }
            }

            // Require >= 10% SAD improvement over zero-motion to suppress noise
            if (bestSad > zeroSad * 0.9) {
              bestDx = 0;
              bestDy = 0;
            }
          }

          const mag = Math.round(Math.hypot(bestDx, bestDy) * 100) / 100;
          sumMag += mag;
          if (mag > peakMag) peakMag = mag;
          if (mag >= highMotionThreshold) highCount++;
          sumDx += bestDx;
          sumDy += bestDy;

          vectors.push({
            gx: Math.round(((gx + 0.5) / GRID_COLS) * 1000) / 1000,
            gy: Math.round(((gy + 0.5) / GRID_ROWS) * 1000) / 1000,
            dx: bestDx,
            dy: bestDy,
            magnitude: mag,
          });
        }
      }

      const cellCount = Math.max(1, vectors.length);
      const meanMagnitude = Math.round((sumMag / cellCount) * 1000) / 1000;
      const highMotionCoveragePct = Math.round((highCount / cellCount) * 1000) / 10;
      const dominantDirectionDeg =
        Math.hypot(sumDx, sumDy) > 0.5
          ? Math.round(((Math.atan2(sumDy, sumDx) * 180) / Math.PI) * 10) / 10
          : 0;

      frames.push({
        timestampSec: t,
        meanMagnitude,
        peakMagnitude: peakMag,
        highMotionCoveragePct,
        dominantDirectionDeg,
        vectors,
      });
    } catch {
      // skip failed sample timestamp
    }
  }

  let globalMeanMagnitude = 0;
  let globalPeakMagnitude = 0;
  let peakMotionTimestampSec = frames[0]?.timestampSec ?? 0;

  for (const f of frames) {
    globalMeanMagnitude += f.meanMagnitude;
    if (f.peakMagnitude > globalPeakMagnitude) {
      globalPeakMagnitude = f.peakMagnitude;
      peakMotionTimestampSec = f.timestampSec;
    }
  }
  globalMeanMagnitude =
    frames.length > 0 ? Math.round((globalMeanMagnitude / frames.length) * 1000) / 1000 : 0;

  const motionBurstTimestampsSec = frames
    .filter((f) => f.meanMagnitude >= Math.max(0.4, globalMeanMagnitude * 1.25) || f.highMotionCoveragePct >= 15)
    .map((f) => f.timestampSec);

  const vectorFrames: Array<{ timestampSec: number; base64: string; mimeType: 'image/jpeg' }> = [];
  if (opts.includeVectorFrames !== false && frames.length > 0) {
    const keyTimestamps = Array.from(
      new Set([
        frames[0].timestampSec,
        peakMotionTimestampSec,
        frames[frames.length - 1].timestampSec,
      ])
    ).slice(0, 3);

    for (let i = 0; i < keyTimestamps.length; i++) {
      const ts = keyTimestamps[i];
      const outPath = path.join(outDir, `mv_${i}_${Math.round(ts * 1000)}ms.jpg`);
      const rendered = await renderMotionVectorFrame(filePath, outPath, ts, 720);
      if (rendered) vectorFrames.push(rendered);
    }
  }

  return {
    analysis: {
      assetId,
      method: 'block_match_sad',
      gridCols: GRID_COLS,
      gridRows: GRID_ROWS,
      sampleCount: frames.length,
      highMotionThreshold,
      globalMeanMagnitude,
      globalPeakMagnitude,
      peakMotionTimestampSec,
      motionBurstTimestampsSec,
      frames,
      generatedAt: new Date().toISOString(),
    },
    vectorFrames,
  };
}

