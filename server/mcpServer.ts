import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { downloadAndIngestUrl, ingestMediaFile } from './ingest.ts';
import { enqueueBatchJob, waitForBatchJob } from './batchProcessor.ts';
import {
  analyzeAudioEnvelope,
  analyzeOpticalFlow,
  buildContactSheet,
  compareVideos,
  detectSceneCuts,
  extractAudioSegment,
  extractFramesRange,
  extractSingleFrame,
} from './mediaProcessor.ts';
import {
  buildComparePairNleExport,
  buildSingleAssetNleExport,
  slugifyFilename,
} from './nleExport.ts';
import { AUDIO_DIR, EXPORTS_DIR, FRAMES_DIR, studioStore } from './store.ts';
import type { McpActivityEntry, MediaAsset, ReviewRequest } from './types.ts';

export type TransportKind = 'streamable-http' | 'sse' | 'stdio';

function formatAssetSummary(a: MediaAsset, baseUrl?: string) {
  return {
    id: a.id,
    title: a.title,
    role: a.role,
    kind: a.kind,
    sourceType: a.sourceType,
    durationSec: a.probe.durationSec,
    resolution: a.probe.hasVideo ? `${a.probe.width}x${a.probe.height}` : null,
    fps: a.probe.fps || null,
    hasAudio: a.probe.hasAudio,
    detectedCutTimestampsSec: a.cuts,
    markerCount: a.markers.length,
    streamUrl: baseUrl ? `${baseUrl}/api/media/${a.id}/stream` : undefined,
    createdAt: a.createdAt,
  };
}

async function trackedTool<T>(
  toolName: string,
  transport: TransportKind,
  mediaId: string | undefined,
  summary: string,
  fn: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  try {
    const res = await fn();
    const entry: McpActivityEntry = {
      id: crypto.randomUUID().slice(0, 10),
      toolName,
      transport,
      summary,
      mediaId,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - started,
      ok: true,
    };
    studioStore.logActivity(entry);
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const entry: McpActivityEntry = {
      id: crypto.randomUUID().slice(0, 10),
      toolName,
      transport,
      summary: `${summary} (failed: ${msg})`,
      mediaId,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - started,
      ok: false,
    };
    studioStore.logActivity(entry);
    throw err;
  }
}

export function createCutCheckMcpServer(options: {
  transport: TransportKind;
  getBaseUrl?: () => string;
}): McpServer {
  const server = new McpServer({
    name: 'cutcheck-mcp',
    version: '1.0.0',
  });

  const baseUrl = () => (options.getBaseUrl ? options.getBaseUrl() : '');

  server.registerTool(
    'list_media',
    {
      title: 'List Media Assets',
      description:
        'List all uploaded, local, or URL-registered reference motion videos, edited cuts, rendered videos, and audio tracks in the CutCheck workspace.',
      inputSchema: {
        role: z
          .enum(['all', 'reference', 'edited', 'rendered', 'audio'])
          .optional()
          .describe('Optional filter by asset role.'),
      },
    },
    async ({ role }) => {
      return trackedTool('list_media', options.transport, undefined, `Listed media (${role ?? 'all'})`, async () => {
        const assets = studioStore.listAssets();
        const filtered =
          role && role !== 'all' ? assets.filter((a) => a.role === role) : assets;
        const reviews = studioStore.listReviews();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: filtered.length,
                  assets: filtered.map((a) => formatAssetSummary(a, baseUrl())),
                  pendingReviews: reviews.filter((r) => r.status === 'pending').length,
                },
                null,
                2
              ),
            },
          ],
        };
      });
    }
  );

  server.registerTool(
    'register_media',
    {
      title: 'Register Video or Audio',
      description:
        'Register a local video/audio file path (when running locally) or a public HTTP/HTTPS URL into CutCheck, probe it with ffprobe, detect scene cuts, and show it live in the Studio UI.',
      inputSchema: {
        source: z
          .string()
          .describe('Absolute local file path (e.g. /Users/me/render.mp4) OR http/https URL.'),
        role: z
          .enum(['reference', 'edited', 'rendered', 'audio'])
          .describe('Purpose of the clip: reference motion, edited cut, rendered output, or audio track.'),
        title: z.string().optional().describe('Human-readable label for the clip.'),
        notes: z.string().optional().describe('Optional context or motion notes.'),
      },
    },
    async ({ source, role, title, notes }) => {
      return trackedTool(
        'register_media',
        options.transport,
        undefined,
        `Registered ${role} media: ${title ?? source}`,
        async () => {
          const isUrl = /^https?:\/\//i.test(source.trim());
          const asset = isUrl
            ? await downloadAndIngestUrl({ url: source.trim(), role, title, notes })
            : await ingestMediaFile({
                filePath: source.trim(),
                role,
                title: title ?? path.basename(source.trim()),
                sourceType: 'local',
                notes,
              });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'registered',
                    asset: formatAssetSummary(asset, baseUrl()),
                    probe: asset.probe,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      );
    }
  );

  server.registerTool(
    'inspect_media',
    {
      title: 'Inspect Media Telemetry',
      description:
        'Get exact ffprobe technical specs (duration, FPS, frame count, resolution, codecs, bitrate), detected scene-cut timestamps (great for motion pacing), and timeline markers.',
      inputSchema: {
        mediaId: z.string().describe('Media asset ID from list_media or register_media.'),
      },
    },
    async ({ mediaId }) => {
      return trackedTool('inspect_media', options.transport, mediaId, `Inspected ${mediaId}`, async () => {
        const asset = studioStore.getAsset(mediaId);
        if (!asset) {
          throw new Error(`Media asset not found: ${mediaId}`);
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: asset.id,
                  title: asset.title,
                  role: asset.role,
                  kind: asset.kind,
                  probe: asset.probe,
                  detectedSceneCutsSec: asset.cuts,
                  markers: asset.markers,
                  waveformPeakCount: asset.waveformPeaks.length,
                  audioAnalysis: asset.audioAnalysis ?? null,
                },
                null,
                2
              ),
            },
          ],
        };
      });
    }
  );

  server.registerTool(
    'get_contact_sheet',
    {
      title: 'Get Storyboard Contact Sheet',
      description:
        'Generate a 4x3 storyboard grid image of a video so the AI can grasp overall motion flow, framing, and pacing in a single image.',
      inputSchema: {
        mediaId: z.string().describe('Video asset ID.'),
        cols: z.number().int().min(2).max(6).optional().describe('Grid columns (default 4).'),
        rows: z.number().int().min(2).max(5).optional().describe('Grid rows (default 3).'),
      },
    },
    async ({ mediaId, cols, rows }) => {
      return trackedTool(
        'get_contact_sheet',
        options.transport,
        mediaId,
        `Generated contact sheet for ${mediaId}`,
        async () => {
          const asset = studioStore.getAsset(mediaId);
          if (!asset) throw new Error(`Media asset not found: ${mediaId}`);
          if (!asset.probe.hasVideo) throw new Error(`Asset ${mediaId} has no video stream.`);

          const c = cols ?? 4;
          const r = rows ?? 3;
          const outPath = path.join(FRAMES_DIR, asset.id, `contact_${c}x${r}.jpg`);
          const sheet = await buildContactSheet(asset.filePath, outPath, asset.probe, c, r);

          return {
            content: [
              {
                type: 'text',
                text: `Contact sheet (${c}x${r}, ${sheet.frameCount} frames across ${asset.probe.durationSec}s @ ${asset.probe.fps}fps) for "${asset.title}" [${asset.role}]. Detected scene cuts at: ${asset.cuts.length ? asset.cuts.map((t) => `${t}s`).join(', ') : 'none detected'}.`,
              },
              {
                type: 'image',
                data: sheet.base64,
                mimeType: sheet.mimeType,
              },
            ],
          };
        }
      );
    }
  );

  server.registerTool(
    'get_video_frames',
    {
      title: 'Extract Timestamped Video Frames',
      description:
        'Extract sequential JPEG frames across a video or specific [startSec, endSec] time window so the AI can inspect motion easing, keyframes, cuts, or rendered visual bugs.',
      inputSchema: {
        mediaId: z.string().describe('Video asset ID.'),
        startSec: z.number().min(0).optional().describe('Start timestamp in seconds (default 0).'),
        endSec: z.number().min(0).optional().describe('End timestamp in seconds (default end of video).'),
        count: z
          .number()
          .int()
          .min(1)
          .max(12)
          .optional()
          .describe('Number of evenly spaced frames to extract (1-12, default 6).'),
        maxWidth: z
          .number()
          .int()
          .min(320)
          .max(1280)
          .optional()
          .describe('Max pixel width per frame (default 720).'),
      },
    },
    async ({ mediaId, startSec, endSec, count, maxWidth }) => {
      return trackedTool(
        'get_video_frames',
        options.transport,
        mediaId,
        `Extracted ${count ?? 6} frames from ${mediaId}`,
        async () => {
          const asset = studioStore.getAsset(mediaId);
          if (!asset) throw new Error(`Media asset not found: ${mediaId}`);
          if (!asset.probe.hasVideo) throw new Error(`Asset ${mediaId} has no video stream.`);

          const outDir = path.join(FRAMES_DIR, asset.id, `seq_${Date.now()}`);
          const frames = await extractFramesRange(asset.filePath, outDir, asset.probe, {
            startSec,
            endSec,
            count: count ?? 6,
            maxWidth: maxWidth ?? 720,
          });

          const content: Array<
            | { type: 'text'; text: string }
            | { type: 'image'; data: string; mimeType: string }
          > = [
            {
              type: 'text',
              text: `Extracted ${frames.length} frames from "${asset.title}" (${asset.role}, ${asset.probe.width}x${asset.probe.height}, ${asset.probe.fps}fps, duration ${asset.probe.durationSec}s). Frame timestamps: ${frames.map((f, idx) => `#${idx + 1}=${f.timestampSec}s`).join(', ')}`,
            },
          ];

          for (const frame of frames) {
            content.push({
              type: 'image',
              data: frame.base64,
              mimeType: frame.mimeType,
            });
          }

          return { content };
        }
      );
    }
  );

  server.registerTool(
    'get_frame_at',
    {
      title: 'Capture Single Frame at Timestamp',
      description:
        'Extract a higher-resolution frame at an exact timestamp (seconds) to check fine typography, transition alignment, or render artifacts.',
      inputSchema: {
        mediaId: z.string().describe('Video asset ID.'),
        timestampSec: z.number().min(0).describe('Exact timestamp in seconds.'),
        maxWidth: z.number().int().min(320).max(1920).optional().describe('Max width (default 1080).'),
      },
    },
    async ({ mediaId, timestampSec, maxWidth }) => {
      return trackedTool(
        'get_frame_at',
        options.transport,
        mediaId,
        `Captured frame @ ${timestampSec}s for ${mediaId}`,
        async () => {
          const asset = studioStore.getAsset(mediaId);
          if (!asset) throw new Error(`Media asset not found: ${mediaId}`);
          if (!asset.probe.hasVideo) throw new Error(`Asset ${mediaId} has no video stream.`);

          const clamped = Math.min(Math.max(0, timestampSec), Math.max(0, asset.probe.durationSec - 0.02));
          const outPath = path.join(
            FRAMES_DIR,
            asset.id,
            `single_${Math.round(clamped * 1000)}ms.jpg`
          );
          const frame = await extractSingleFrame(asset.filePath, outPath, clamped, maxWidth ?? 1080);

          return {
            content: [
              {
                type: 'text',
                text: `Frame from "${asset.title}" [${asset.role}] at t=${clamped}s (approx frame #${Math.round(clamped * (asset.probe.fps || 30))}).`,
              },
              {
                type: 'image',
                data: frame.base64,
                mimeType: frame.mimeType,
              },
            ],
          };
        }
      );
    }
  );

  server.registerTool(
    'compare_reference_and_rendered',
    {
      title: 'Compare Reference Motion vs Rendered Video',
      description:
        'Compare a reference motion video against an edited or rendered video using ffmpeg SSIM, duration/FPS drift, side-by-side frames ([Reference | Rendered]), and optional pixel difference maps.',
      inputSchema: {
        referenceId: z.string().describe('Asset ID of the reference motion video.'),
        targetId: z.string().describe('Asset ID of the edited or rendered video to verify.'),
        sampleCount: z
          .number()
          .int()
          .min(2)
          .max(6)
          .optional()
          .describe('Number of normalized timepoints to compare (default 4).'),
        includeDiffMap: z
          .boolean()
          .optional()
          .describe('Include pixel-difference heat frames (default true).'),
      },
    },
    async ({ referenceId, targetId, sampleCount, includeDiffMap }) => {
      return trackedTool(
        'compare_reference_and_rendered',
        options.transport,
        targetId,
        `Compared ${referenceId} vs ${targetId}`,
        async () => {
          const ref = studioStore.getAsset(referenceId);
          const target = studioStore.getAsset(targetId);
          if (!ref) throw new Error(`Reference asset not found: ${referenceId}`);
          if (!target) throw new Error(`Target asset not found: ${targetId}`);
          if (!ref.probe.hasVideo || !target.probe.hasVideo) {
            throw new Error('Both assets must contain video streams.');
          }

          const outDir = path.join(FRAMES_DIR, `cmp_${ref.id}_${target.id}_${Date.now()}`);
          const result = await compareVideos(
            ref.filePath,
            ref.probe,
            target.filePath,
            target.probe,
            outDir,
            sampleCount ?? 4,
            includeDiffMap ?? true
          );

          studioStore.saveComparison({
            id: crypto.randomUUID().slice(0, 12),
            referenceId: ref.id,
            targetId: target.id,
            ssimScore: result.ssimScore,
            durationDeltaSec: result.durationDeltaSec,
            fpsDelta: result.fpsDelta,
            resolutionMatch: result.resolutionMatch,
            samples: result.pairs.map((p) => ({
              progressPct: p.progressPct,
              refTimestampSec: p.refTimestampSec,
              targetTimestampSec: p.targetTimestampSec,
            })),
            generatedAt: new Date().toISOString(),
          });

          const content: Array<
            | { type: 'text'; text: string }
            | { type: 'image'; data: string; mimeType: string }
          > = [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  reference: { id: ref.id, title: ref.title, durationSec: ref.probe.durationSec, fps: ref.probe.fps, resolution: `${ref.probe.width}x${ref.probe.height}`, cuts: ref.cuts },
                  target: { id: target.id, title: target.title, role: target.role, durationSec: target.probe.durationSec, fps: target.probe.fps, resolution: `${target.probe.width}x${target.probe.height}`, cuts: target.cuts },
                  ssimScore: result.ssimScore,
                  durationDeltaSec: result.durationDeltaSec,
                  fpsDelta: result.fpsDelta,
                  resolutionMatch: result.resolutionMatch,
                  note: 'Images below alternate side-by-side [Left=Reference | Right=Target] and pixel-difference maps (brighter = greater difference).',
                },
                null,
                2
              ),
            },
          ];

          for (const pair of result.pairs) {
            content.push({
              type: 'text',
              text: `Progress ${pair.progressPct}% (Ref ${pair.refTimestampSec}s vs Target ${pair.targetTimestampSec}s) — Side-by-Side`,
            });
            content.push({
              type: 'image',
              data: pair.sideBySideBase64,
              mimeType: 'image/jpeg',
            });
            if (pair.diffBase64) {
              content.push({
                type: 'image',
                data: pair.diffBase64,
                mimeType: 'image/jpeg',
              });
            }
          }

          return { content };
        }
      );
    }
  );

  server.registerTool(
    'get_audio_clip',
    {
      title: 'Extract Audio Clip for Listening',
      description:
        'Extract an audio segment (up to 30s) from an audio asset or video audio track, compute loudness dB stats, and return an MCP audio content block.',
      inputSchema: {
        mediaId: z.string().describe('Audio or video asset ID.'),
        startSec: z.number().min(0).optional().describe('Start time in seconds (default 0).'),
        durationSec: z
          .number()
          .min(0.5)
          .max(30)
          .optional()
          .describe('Segment duration in seconds (max 30, default 15).'),
        format: z.enum(['mp3', 'wav']).optional().describe('Audio encoding format (default mp3).'),
      },
    },
    async ({ mediaId, startSec, durationSec, format }) => {
      return trackedTool(
        'get_audio_clip',
        options.transport,
        mediaId,
        `Extracted audio clip from ${mediaId}`,
        async () => {
          const asset = studioStore.getAsset(mediaId);
          if (!asset) throw new Error(`Media asset not found: ${mediaId}`);
          if (!asset.probe.hasAudio) throw new Error(`Asset ${mediaId} has no audio track.`);

          const fmt = format ?? 'mp3';
          const outPath = path.join(AUDIO_DIR, `${asset.id}_${Date.now()}.${fmt}`);
          const clip = await extractAudioSegment(asset.filePath, outPath, {
            startSec: startSec ?? 0,
            durationSec: durationSec ?? 15,
            format: fmt,
          });

          const segStart = startSec ?? 0;
          const segDur = Math.min(durationSec ?? 15, asset.probe.durationSec || 15);
          const envelope = await analyzeAudioEnvelope(asset.filePath, asset.probe.durationSec, {
            startSec: segStart,
            endSec: segStart + segDur,
            bins: 24,
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    mediaId: asset.id,
                    title: asset.title,
                    startSec: segStart,
                    durationSec: segDur,
                    meanVolumeDb: clip.meanVolumeDb,
                    maxVolumeDb: clip.maxVolumeDb,
                    segmentEnvelopeSummary: envelope.summary,
                    segmentPeakRmsBins: envelope.bins,
                    mimeType: clip.mimeType,
                    clientNote:
                      'Audio returned as MCP AudioContent along with segment Peak/RMS envelope bins. If your host client does not decode AudioContent tool results, inspect segmentPeakRmsBins or use request_human_review.',
                  },
                  null,
                  2
                ),
              },
              {
                type: 'audio',
                data: clip.base64,
                mimeType: clip.mimeType,
              },
            ],
          };
        }
      );
    }
  );

  server.registerTool(
    'get_audio_waveform',
    {
      title: 'Get Audio Peak & RMS Waveform Envelope',
      description:
        'Analyze an audio track or video audio stream to return deterministic per-bin Peak, RMS, dBFS levels, crest factor, and detected audio transient/beat timestamps across a time window.',
      inputSchema: {
        mediaId: z.string().describe('Audio or video asset ID.'),
        startSec: z.number().min(0).optional().describe('Window start timestamp in seconds (default 0).'),
        endSec: z.number().min(0).optional().describe('Window end timestamp in seconds (default full duration).'),
        bins: z
          .number()
          .int()
          .min(8)
          .max(256)
          .optional()
          .describe('Number of time bins to return (8-256, default 64).'),
      },
    },
    async ({ mediaId, startSec, endSec, bins }) => {
      return trackedTool(
        'get_audio_waveform',
        options.transport,
        mediaId,
        `Analyzed audio waveform (${bins ?? 64} bins) for ${mediaId}`,
        async () => {
          const asset = studioStore.getAsset(mediaId);
          if (!asset) throw new Error(`Media asset not found: ${mediaId}`);
          if (!asset.probe.hasAudio) throw new Error(`Asset ${mediaId} has no audio track.`);

          const analysis = await analyzeAudioEnvelope(asset.filePath, asset.probe.durationSec, {
            startSec,
            endSec,
            bins: bins ?? 64,
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    mediaId: asset.id,
                    title: asset.title,
                    durationSec: asset.probe.durationSec,
                    sampleRate: asset.probe.sampleRate,
                    channels: asset.probe.channels,
                    summary: analysis.summary,
                    bins: analysis.bins,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      );
    }
  );

  server.registerTool(
    'analyze_optical_flow',
    {
      title: 'Analyze Optical Flow & Motion Vectors',
      description:
        'Run deterministic block-matching optical flow analysis on a video asset, persist the motion vector field onto the asset so the Studio player visualizes high-motion vectors/heat zones live, and return motion telemetry + ffmpeg codecview motion-vector frames.',
      inputSchema: {
        mediaId: z.string().describe('Video asset ID.'),
        startSec: z.number().min(0).optional().describe('Window start timestamp in seconds (default 0).'),
        endSec: z.number().min(0).optional().describe('Window end timestamp in seconds (default full duration).'),
        samples: z
          .number()
          .int()
          .min(2)
          .max(16)
          .optional()
          .describe('Number of timestamps to sample across the window (2-16, default 6).'),
        highMotionThreshold: z
          .number()
          .min(0.25)
          .max(12)
          .optional()
          .describe('Motion magnitude threshold (px/frame) for flagging high-motion areas (default 2.0).'),
        pinBurstMarkers: z
          .boolean()
          .optional()
          .describe('Pin detected high-motion burst timestamps onto the playback timeline (default false).'),
        includeVectorFrames: z
          .boolean()
          .optional()
          .describe('Include ffmpeg mestimate + codecview motion-vector annotated frames (default true).'),
      },
    },
    async ({
      mediaId,
      startSec,
      endSec,
      samples,
      highMotionThreshold,
      pinBurstMarkers,
      includeVectorFrames,
    }) => {
      return trackedTool(
        'analyze_optical_flow',
        options.transport,
        mediaId,
        `Analyzed optical flow (${samples ?? 6} samples) for ${mediaId}`,
        async () => {
          const asset = studioStore.getAsset(mediaId);
          if (!asset) throw new Error(`Media asset not found: ${mediaId}`);
          if (!asset.probe.hasVideo) throw new Error(`Asset ${mediaId} has no video stream.`);

          const outDir = path.join(FRAMES_DIR, asset.id, `flow_${Date.now()}`);
          const { analysis, vectorFrames } = await analyzeOpticalFlow(
            asset.id,
            asset.filePath,
            asset.probe,
            outDir,
            {
              startSec,
              endSec,
              samples: samples ?? 6,
              highMotionThreshold: highMotionThreshold ?? 2.0,
              includeVectorFrames: includeVectorFrames ?? true,
            }
          );

          studioStore.updateAsset(asset.id, { opticalFlow: analysis });

          if (pinBurstMarkers) {
            for (const t of analysis.motionBurstTimestampsSec) {
              studioStore.addMarker(asset.id, {
                id: crypto.randomUUID().slice(0, 10),
                timestampSec: t,
                author: 'ai',
                kind: 'note',
                label: `High-motion burst (t=${t.toFixed(3)}s)`,
                createdAt: new Date().toISOString(),
              });
            }
          }

          const content: Array<
            | { type: 'text'; text: string }
            | { type: 'image'; data: string; mimeType: string }
          > = [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  mediaId: asset.id,
                  title: asset.title,
                  method: analysis.method,
                  grid: `${analysis.gridCols}x${analysis.gridRows}`,
                  highMotionThreshold: analysis.highMotionThreshold,
                  globalMeanMagnitude: analysis.globalMeanMagnitude,
                  globalPeakMagnitude: analysis.globalPeakMagnitude,
                  peakMotionTimestampSec: analysis.peakMotionTimestampSec,
                  motionBurstTimestampsSec: analysis.motionBurstTimestampsSec,
                  framesSummary: analysis.frames.map((f) => ({
                    timestampSec: f.timestampSec,
                    meanMagnitude: f.meanMagnitude,
                    peakMagnitude: f.peakMagnitude,
                    highMotionCoveragePct: f.highMotionCoveragePct,
                    dominantDirectionDeg: f.dominantDirectionDeg,
                    activeVectorCount: f.vectors.filter((v) => v.magnitude > 0).length,
                  })),
                  uiNote:
                    'Optical flow vector field saved to the asset and synced to the Studio video player overlay.',
                },
                null,
                2
              ),
            },
          ];

          for (const vf of vectorFrames) {
            content.push({
              type: 'text',
              text: `Motion vector visualization frame @ t=${vf.timestampSec}s`,
            });
            content.push({
              type: 'image',
              data: vf.base64,
              mimeType: vf.mimeType,
            });
          }

          return { content };
        }
      );
    }
  );

  server.registerTool(
    'detect_scene_cuts',
    {
      title: 'Detect Scene Cuts & Pin Timeline Markers',
      description:
        'Run automated ffmpeg scene-change detection on a video asset and display all detected cut timestamps as markers on the playback timeline in the Studio UI.',
      inputSchema: {
        mediaId: z.string().describe('Video asset ID.'),
        threshold: z
          .number()
          .min(0.05)
          .max(0.9)
          .optional()
          .describe('ffmpeg scene change sensitivity between 0.05 (very sensitive) and 0.9 (hard cuts only). Default 0.25.'),
        pinMarkers: z
          .boolean()
          .optional()
          .describe('Pin detected cuts as markers on the Studio playback timeline (default true).'),
        replaceExistingAutoMarkers: z
          .boolean()
          .optional()
          .describe('Replace previously auto-detected scene_cut markers before pinning new ones (default true).'),
      },
    },
    async ({ mediaId, threshold, pinMarkers, replaceExistingAutoMarkers }) => {
      const thresh = threshold ?? 0.25;
      return trackedTool(
        'detect_scene_cuts',
        options.transport,
        mediaId,
        `Detected scene cuts (threshold=${thresh}) for ${mediaId}`,
        async () => {
          const asset = studioStore.getAsset(mediaId);
          if (!asset) throw new Error(`Media asset not found: ${mediaId}`);
          if (!asset.probe.hasVideo) throw new Error(`Asset ${mediaId} has no video stream.`);

          const cuts = await detectSceneCuts(asset.filePath, thresh);
          const shouldPin = pinMarkers ?? true;
          const shouldReplace = replaceExistingAutoMarkers ?? true;
          const fps = asset.probe.fps > 0 ? asset.probe.fps : 30;

          const newMarkers = shouldPin
            ? cuts.map((t, idx) => ({
                id: crypto.randomUUID().slice(0, 10),
                timestampSec: t,
                author: 'ai' as const,
                kind: 'scene_cut' as const,
                label: `Scene cut #${idx + 1} (t=${t.toFixed(3)}s, f=${Math.round(t * fps)})`,
                createdAt: new Date().toISOString(),
              }))
            : [];

          const updated = shouldPin
            ? studioStore.setSceneCutMarkers(asset.id, cuts, newMarkers, shouldReplace)
            : studioStore.updateAsset(asset.id, { cuts });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    mediaId: asset.id,
                    title: asset.title,
                    threshold: thresh,
                    detectedCount: cuts.length,
                    detectedCutTimestampsSec: cuts,
                    markersPinned: newMarkers.length,
                    totalTimelineMarkers: updated?.markers.length ?? asset.markers.length,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      );
    }
  );

  server.registerTool(
    'add_ai_note',
    {
      title: 'Pin Timeline Note in Studio UI',
      description:
        'Attach a timestamped motion analysis or QA observation directly onto the asset timeline in the CutCheck Studio UI.',
      inputSchema: {
        mediaId: z.string().describe('Media asset ID.'),
        timestampSec: z.number().min(0).describe('Timestamp in seconds.'),
        label: z.string().min(1).max(240).describe('Short description of motion/cut/QA observation.'),
      },
    },
    async ({ mediaId, timestampSec, label }) => {
      return trackedTool('add_ai_note', options.transport, mediaId, `Pinned note @ ${timestampSec}s`, async () => {
        const updated = studioStore.addMarker(mediaId, {
          id: crypto.randomUUID().slice(0, 10),
          timestampSec,
          author: 'ai',
          kind: 'note',
          label,
          createdAt: new Date().toISOString(),
        });
        if (!updated) throw new Error(`Media asset not found: ${mediaId}`);
        return {
          content: [
            {
              type: 'text',
              text: `Pinned AI marker on "${updated.title}" at ${timestampSec}s: ${label}`,
            },
          ],
        };
      });
    }
  );

  server.registerTool(
    'request_human_review',
    {
      title: 'Send Video or Audio to Human Reviewer',
      description:
        'Push a video or audio asset (optionally paired with a reference video) to the Human QA Review Inbox in the CutCheck web UI so the user can watch/listen and approve or request changes.',
      inputSchema: {
        mediaId: z.string().describe('Asset ID to review (e.g. edited or rendered video, or audio).'),
        referenceMediaId: z
          .string()
          .optional()
          .describe('Optional reference motion video ID for side-by-side playback in the UI.'),
        prompt: z
          .string()
          .describe('What the human reviewer should check (e.g. motion pacing, audio sync, final render QA).'),
        requestedBy: z.string().optional().describe('Client/agent name (default "Claude").'),
      },
    },
    async ({ mediaId, referenceMediaId, prompt, requestedBy }) => {
      return trackedTool(
        'request_human_review',
        options.transport,
        mediaId,
        `Requested human review for ${mediaId}`,
        async () => {
          const asset = studioStore.getAsset(mediaId);
          if (!asset) throw new Error(`Media asset not found: ${mediaId}`);
          if (referenceMediaId && !studioStore.getAsset(referenceMediaId)) {
            throw new Error(`Reference asset not found: ${referenceMediaId}`);
          }

          const review: ReviewRequest = {
            id: crypto.randomUUID().slice(0, 12),
            mediaId,
            referenceMediaId,
            prompt,
            requestedBy: requestedBy ?? 'Claude',
            status: 'pending',
            createdAt: new Date().toISOString(),
          };
          studioStore.addReview(review);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    reviewId: review.id,
                    status: review.status,
                    message: `Review queued in CutCheck Studio UI for "${asset.title}". Call get_review_status(reviewId="${review.id}") after the user finishes watching/listening.`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      );
    }
  );

  server.registerTool(
    'get_review_status',
    {
      title: 'Check Human Review Decision',
      description:
        'Check if the human reviewer has approved or requested changes on a review request, including all human timestamped timeline notes.',
      inputSchema: {
        reviewId: z.string().describe('Review ID returned by request_human_review.'),
      },
    },
    async ({ reviewId }) => {
      return trackedTool('get_review_status', options.transport, undefined, `Checked review ${reviewId}`, async () => {
        const review = studioStore.getReview(reviewId);
        if (!review) throw new Error(`Review request not found: ${reviewId}`);
        const asset = studioStore.getAsset(review.mediaId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  review,
                  timelineMarkers: asset?.markers ?? [],
                },
                null,
                2
              ),
            },
          ],
        };
      });
    }
  );

  server.registerTool(
    'export_nle_analysis',
    {
      title: 'Export NLE Analysis JSON',
      description:
        'Export scene cuts, SMPTE timecodes, timeline markers, SSIM comparisons, optical flow vectors, and audio transients as a structured JSON file (schema cutcheck.nle-analysis.v1) for external NLEs (Premiere Pro, DaVinci Resolve, After Effects, OTIO pipelines).',
      inputSchema: {
        mediaId: z.string().describe('Primary or target video/audio asset ID to export.'),
        referenceMediaId: z
          .string()
          .optional()
          .describe('Optional reference asset ID to export a paired SSIM & motion comparison bundle.'),
        includeVectors: z
          .boolean()
          .optional()
          .describe('Include full per-cell optical flow vector grids in the JSON (default true).'),
        saveToExportsDir: z
          .boolean()
          .optional()
          .describe('Also write the exported JSON file to data/exports/ on disk (default false).'),
      },
    },
    async ({ mediaId, referenceMediaId, includeVectors, saveToExportsDir }) => {
      return trackedTool(
        'export_nle_analysis',
        options.transport,
        mediaId,
        referenceMediaId
          ? `Exported NLE JSON (${referenceMediaId} vs ${mediaId})`
          : `Exported NLE JSON for ${mediaId}`,
        async () => {
          const asset = studioStore.getAsset(mediaId);
          if (!asset) throw new Error(`Media asset not found: ${mediaId}`);

          const incVec = includeVectors ?? true;
          let payload: unknown;
          let filename: string;
          let downloadUrl: string | undefined;

          if (referenceMediaId) {
            const refAsset = studioStore.getAsset(referenceMediaId);
            if (!refAsset) throw new Error(`Reference asset not found: ${referenceMediaId}`);
            const comparison = studioStore.getComparison(refAsset.id, asset.id) ?? null;
            payload = buildComparePairNleExport(refAsset, asset, comparison, {
              includeVectors: incVec,
            });
            filename = `cutcheck-nle-compare-${refAsset.id}-vs-${asset.id}.json`;
            if (baseUrl()) {
              downloadUrl = `${baseUrl()}/api/compare/export?referenceId=${encodeURIComponent(refAsset.id)}&targetId=${encodeURIComponent(asset.id)}&download=1&includeVectors=${incVec ? '1' : '0'}`;
            }
          } else {
            const allAssets = studioStore.listAssets();
            const relatedComparisons = studioStore
              .listComparisons()
              .filter((c) => c.referenceId === asset.id || c.targetId === asset.id);
            payload = buildSingleAssetNleExport(asset, relatedComparisons, allAssets, {
              includeVectors: incVec,
            });
            filename = `cutcheck-nle-${slugifyFilename(asset.title)}-${asset.id}.json`;
            if (baseUrl()) {
              downloadUrl = `${baseUrl()}/api/media/${encodeURIComponent(asset.id)}/export?download=1&includeVectors=${incVec ? '1' : '0'}`;
            }
          }

          let savedPath: string | undefined;
          if (saveToExportsDir) {
            fs.mkdirSync(EXPORTS_DIR, { recursive: true });
            savedPath = path.join(EXPORTS_DIR, filename);
            fs.writeFileSync(savedPath, JSON.stringify(payload, null, 2), 'utf-8');
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    filename,
                    ...(savedPath ? { savedPath } : {}),
                    ...(downloadUrl ? { downloadUrl } : {}),
                    nleExport: payload,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      );
    }
  );

  server.registerTool(
    'batch_process_assets',
    {
      title: 'Batch Process Media Assets',
      description:
        'Queue a batch job across multiple media assets for FFmpeg transcoding (MP4, WebM, MP3), ffprobe/audio metadata extraction, scene-cut detection, or optical flow analysis. Live queue progress streams directly into the CutCheck Studio sidebar.',
      inputSchema: {
        operation: z
          .enum([
            'extract_metadata',
            'transcode_mp4',
            'transcode_webm',
            'transcode_mp3',
            'detect_scene_cuts',
            'analyze_optical_flow',
          ])
          .describe('Batch task to execute sequentially across all queued assets.'),
        mediaIds: z
          .array(z.string())
          .optional()
          .describe('Explicit list of asset IDs to process. If omitted, selects assets matching roleFilter.'),
        roleFilter: z
          .enum(['all', 'reference', 'edited', 'rendered', 'audio'])
          .optional()
          .describe('Filter workspace assets when mediaIds is omitted (default "all").'),
        targetWidth: z
          .number()
          .int()
          .min(160)
          .max(3840)
          .optional()
          .describe('Optional max width for video transcode operations.'),
        targetFps: z
          .number()
          .min(1)
          .max(120)
          .optional()
          .describe('Optional target FPS for video transcode operations.'),
        crf: z
          .number()
          .int()
          .min(14)
          .max(45)
          .optional()
          .describe('Optional FFmpeg CRF quality (default 22 for MP4, 30 for WebM).'),
        sceneCutThreshold: z
          .number()
          .min(0.05)
          .max(0.9)
          .optional()
          .describe('Optional threshold when operation is detect_scene_cuts (default 0.25).'),
        flowSamples: z
          .number()
          .int()
          .min(2)
          .max(16)
          .optional()
          .describe('Optional sample count when operation is analyze_optical_flow (default 6).'),
        registerOutputs: z
          .boolean()
          .optional()
          .describe('Register transcoded files as new assets in the Studio library (default true).'),
        outputRole: z
          .enum(['reference', 'edited', 'rendered', 'audio'])
          .optional()
          .describe('Role for newly registered transcoded outputs (default "rendered", or "audio" for MP3).'),
        waitForCompletion: z
          .boolean()
          .optional()
          .describe('Wait until the batch queue finishes before returning (default false; use get_batch_job_status to poll while sidebar shows live progress).'),
      },
    },
    async ({
      operation,
      mediaIds,
      roleFilter,
      targetWidth,
      targetFps,
      crf,
      sceneCutThreshold,
      flowSamples,
      registerOutputs,
      outputRole,
      waitForCompletion,
    }) => {
      return trackedTool(
        'batch_process_assets',
        options.transport,
        mediaIds?.[0],
        `Queued batch ${operation}`,
        async () => {
          const resolvedIds =
            mediaIds && mediaIds.length > 0
              ? mediaIds
              : studioStore
                  .listAssets()
                  .filter((a) => (!roleFilter || roleFilter === 'all' ? true : a.role === roleFilter))
                  .map((a) => a.id);

          if (resolvedIds.length === 0) {
            throw new Error('No matching media assets found to enqueue.');
          }

          const queuedJob = enqueueBatchJob({
            mediaIds: resolvedIds,
            operation,
            options: {
              targetWidth,
              targetFps,
              crf,
              sceneCutThreshold,
              flowSamples,
              registerOutputs,
              outputRole,
            },
          });

          const resultJob = waitForCompletion ? await waitForBatchJob(queuedJob.id) : queuedJob;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    job: resultJob,
                    note: waitForCompletion
                      ? 'Batch job finished and sidebar queue has been updated.'
                      : 'Batch job queued and running. Live progress is visible in the CutCheck sidebar; call get_batch_job_status(jobId) to check final results.',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      );
    }
  );

  server.registerTool(
    'get_batch_job_status',
    {
      title: 'Check Batch Queue Status',
      description:
        'Check progress, per-asset status, and output asset IDs for queued or completed batch processing jobs.',
      inputSchema: {
        jobId: z
          .string()
          .optional()
          .describe('Optional batch job ID. If omitted, returns all recent batch jobs.'),
      },
    },
    async ({ jobId }) => {
      return trackedTool(
        'get_batch_job_status',
        options.transport,
        undefined,
        jobId ? `Checked batch job ${jobId}` : 'Listed batch queue jobs',
        async () => {
          if (jobId) {
            const job = studioStore.getBatchJob(jobId);
            if (!job) throw new Error(`Batch job not found: ${jobId}`);
            return {
              content: [{ type: 'text', text: JSON.stringify({ job }, null, 2) }],
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ jobs: studioStore.listBatchJobs() }, null, 2),
              },
            ],
          };
        }
      );
    }
  );

  return server;
}
