import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { downloadAndIngestUrl, inferMimeFromPath, ingestMediaFile } from './server/ingest.ts';
import { enqueueBatchJob } from './server/batchProcessor.ts';
import { createCutCheckMcpServer } from './server/mcpServer.ts';
import {
  analyzeAudioEnvelope,
  analyzeOpticalFlow,
  checkFfmpegAvailable,
  compareVideos,
  detectSceneCuts,
  extractFramesRange,
  generateCalibrationClip,
} from './server/mediaProcessor.ts';
import {
  buildComparePairNleExport,
  buildSingleAssetNleExport,
  slugifyFilename,
} from './server/nleExport.ts';
import { FRAMES_DIR, MEDIA_DIR, ensureDataDirs, studioStore } from './server/store.ts';
import type { BatchOperation, MediaRole, ReviewRequest } from './server/types.ts';

const PORT = Number(process.env.PORT || 3000);
const AUTH_TOKEN = (process.env.CUTCHECK_MCP_TOKEN || '').trim();

ensureDataDirs();

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureDataDirs();
    cb(null, MEDIA_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `${crypto.randomUUID().slice(0, 12)}${ext}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 500 * 1024 * 1024 },
});

function mcpAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_TOKEN) {
    next();
    return;
  }
  const authHeader = req.headers.authorization || '';
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (bearer === AUTH_TOKEN || queryToken === AUTH_TOKEN) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized MCP request. Provide valid Bearer token.' });
}

function getRequestBaseUrl(req?: Request): string {
  if (process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL') {
    return process.env.APP_URL.replace(/\/$/, '');
  }
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    return `${proto}://${host}`;
  }
  return `http://localhost:${PORT}`;
}

async function startServer(): Promise<void> {
  const app = express();
  app.set('trust proxy', 1);
  app.use(
    cors({
      origin: true,
      credentials: true,
      exposedHeaders: ['Mcp-Session-Id'],
    })
  );
  app.use(express.json({ limit: '25mb' }));

  const ffmpegStatus = await checkFfmpegAvailable();

  // ===========================================================================
  // MCP Transport 1: Streamable HTTP (/mcp) — Online & Localhost Remote Clients
  // ===========================================================================
  const httpSessions = new Map<
    string,
    {
      transport: StreamableHTTPServerTransport;
      close: () => Promise<void>;
    }
  >();

  app.post('/mcp', mcpAuthMiddleware, async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers['mcp-session-id'];
      const sid = typeof sessionId === 'string' ? sessionId : undefined;

      if (sid) {
        const existing = httpSessions.get(sid);
        if (!existing) {
          res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'MCP session not found. Re-initialize connection.' },
            id: null,
          });
          return;
        }
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      const body = req.body;
      const isInit =
        (body && !Array.isArray(body) && body.method === 'initialize') ||
        (Array.isArray(body) && body.some((m) => m && m.method === 'initialize'));

      if (!isInit) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: Missing Mcp-Session-Id for non-initialize call.' },
          id: null,
        });
        return;
      }

      const mcpServer = createCutCheckMcpServer({
        transport: 'streamable-http',
        getBaseUrl: () => getRequestBaseUrl(req),
      });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (newSessionId) => {
          httpSessions.set(newSessionId, {
            transport,
            close: async () => {
              await mcpServer.close();
            },
          });
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          httpSessions.delete(transport.sessionId);
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : 'Internal MCP error',
          },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', mcpAuthMiddleware, async (req: Request, res: Response) => {
    const sid = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : '';
    const existing = sid ? httpSessions.get(sid) : undefined;
    if (!existing) {
      res.status(400).json({ error: 'Invalid or missing Mcp-Session-Id header.' });
      return;
    }
    await existing.transport.handleRequest(req, res);
  });

  app.delete('/mcp', mcpAuthMiddleware, async (req: Request, res: Response) => {
    const sid = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : '';
    const existing = sid ? httpSessions.get(sid) : undefined;
    if (!existing) {
      res.status(404).json({ error: 'MCP session not found.' });
      return;
    }
    await existing.transport.handleRequest(req, res);
    httpSessions.delete(sid);
  });

  // ===========================================================================
  // MCP Transport 2: Legacy HTTP+SSE (/sse + /messages)
  // ===========================================================================
  const sseSessions = new Map<string, SSEServerTransport>();

  app.get('/sse', mcpAuthMiddleware, async (req: Request, res: Response) => {
    const transport = new SSEServerTransport('/messages', res);
    sseSessions.set(transport.sessionId, transport);

    const mcpServer = createCutCheckMcpServer({
      transport: 'sse',
      getBaseUrl: () => getRequestBaseUrl(req),
    });

    res.on('close', () => {
      sseSessions.delete(transport.sessionId);
      void mcpServer.close();
    });

    await mcpServer.connect(transport);
  });

  app.post('/messages', mcpAuthMiddleware, async (req: Request, res: Response) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    const transport = sseSessions.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: 'SSE session not found.' });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  // ===========================================================================
  // Studio REST API + Live SSE Stream
  // ===========================================================================
  app.get('/api/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    const onChange = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    studioStore.on('change', onChange);

    const heartbeat = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 20000);

    req.on('close', () => {
      clearInterval(heartbeat);
      studioStore.off('change', onChange);
    });
  });

  app.get('/api/state', (req: Request, res: Response) => {
    const snapshot = studioStore.getSnapshot();
    const baseUrl = getRequestBaseUrl(req);
    res.json({
      ...snapshot,
      capabilities: {
        ffmpeg: ffmpegStatus.ffmpeg,
        ffprobe: ffmpegStatus.ffprobe,
        authProtected: Boolean(AUTH_TOKEN),
        workspaceRoot: process.cwd(),
        baseUrl,
        streamableHttpUrl: `${baseUrl}/mcp`,
        sseUrl: `${baseUrl}/sse`,
      },
    });
  });

  app.post('/api/media/upload', upload.single('file'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No video or audio file uploaded.' });
        return;
      }
      const rawRole = String(req.body.role || 'reference');
      const role: MediaRole =
        rawRole === 'edited' || rawRole === 'rendered' || rawRole === 'audio'
          ? rawRole
          : 'reference';
      const title = String(req.body.title || req.file.originalname);
      const notes = req.body.notes ? String(req.body.notes) : undefined;

      const asset = await ingestMediaFile({
        filePath: req.file.path,
        title,
        role,
        sourceType: 'upload',
        mimeType: req.file.mimetype || inferMimeFromPath(req.file.path),
        notes,
      });

      res.json({ asset });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to process uploaded media.',
      });
    }
  });

  app.post('/api/media/source', async (req: Request, res: Response) => {
    try {
      const source = String(req.body?.source || '').trim();
      if (!source) {
        res.status(400).json({ error: 'Provide a local file path or http/https media URL.' });
        return;
      }
      const rawRole = String(req.body?.role || 'reference');
      const role: MediaRole =
        rawRole === 'edited' || rawRole === 'rendered' || rawRole === 'audio'
          ? rawRole
          : 'reference';
      const title = req.body?.title ? String(req.body.title) : undefined;
      const notes = req.body?.notes ? String(req.body.notes) : undefined;

      const isUrl = /^https?:\/\//i.test(source);
      const asset = isUrl
        ? await downloadAndIngestUrl({ url: source, role, title, notes })
        : await ingestMediaFile({
            filePath: source,
            role,
            title: title || path.basename(source),
            sourceType: 'local',
            notes,
          });

      res.json({ asset });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to register media source.',
      });
    }
  });

  app.post('/api/media/generate-sample', async (_req: Request, res: Response) => {
    try {
      ensureDataDirs();
      const refPath = path.join(MEDIA_DIR, `sample_ref_${Date.now()}.mp4`);
      const renPath = path.join(MEDIA_DIR, `sample_ren_${Date.now()}.mp4`);

      await generateCalibrationClip(refPath, 'reference');
      await generateCalibrationClip(renPath, 'rendered');

      const refAsset = await ingestMediaFile({
        filePath: refPath,
        title: 'Calibration Motion Reference (4s 30fps)',
        role: 'reference',
        sourceType: 'generated',
        notes: 'Deterministic ffmpeg testsrc2 + 440Hz tone reference clip.',
      });
      const renAsset = await ingestMediaFile({
        filePath: renPath,
        title: 'Calibration Render Output (4s 30fps)',
        role: 'rendered',
        sourceType: 'generated',
        notes: 'Rendered variant with +4% brightness & 523Hz tone for QA diff testing.',
      });

      res.json({ reference: refAsset, rendered: renAsset });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to generate calibration clips.',
      });
    }
  });

  app.patch('/api/media/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const patch: { title?: string; role?: MediaRole; notes?: string } = {};
    if (typeof req.body?.title === 'string') patch.title = req.body.title;
    if (
      req.body?.role === 'reference' ||
      req.body?.role === 'edited' ||
      req.body?.role === 'rendered' ||
      req.body?.role === 'audio'
    ) {
      patch.role = req.body.role;
    }
    if (typeof req.body?.notes === 'string') patch.notes = req.body.notes;

    const updated = studioStore.updateAsset(id, patch);
    if (!updated) {
      res.status(404).json({ error: 'Asset not found.' });
      return;
    }
    res.json({ asset: updated });
  });

  app.delete('/api/media/:id', (req: Request, res: Response) => {
    const ok = studioStore.deleteAsset(String(req.params.id));
    if (!ok) {
      res.status(404).json({ error: 'Asset not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  app.get('/api/media/:id/stream', (req: Request, res: Response) => {
    const asset = studioStore.getAsset(String(req.params.id));
    if (!asset || !fs.existsSync(asset.filePath)) {
      res.status(404).json({ error: 'Media file not found.' });
      return;
    }

    const stat = fs.statSync(asset.filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      const stream = fs.createReadStream(asset.filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': asset.mimeType,
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': asset.mimeType,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(asset.filePath).pipe(res);
    }
  });

  app.get('/api/media/:id/waveform', async (req: Request, res: Response) => {
    try {
      const asset = studioStore.getAsset(String(req.params.id));
      if (!asset) {
        res.status(404).json({ error: 'Asset not found.' });
        return;
      }
      if (!asset.probe.hasAudio) {
        res.json({ bins: [], summary: null });
        return;
      }
      const bins = Math.min(256, Math.max(16, Number(req.query.bins || 128)));
      const result = await analyzeAudioEnvelope(asset.filePath, asset.probe.durationSec, {
        bins,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Waveform analysis failed.',
      });
    }
  });

  app.get('/api/media/:id/frames', async (req: Request, res: Response) => {
    try {
      const asset = studioStore.getAsset(String(req.params.id));
      if (!asset) {
        res.status(404).json({ error: 'Asset not found.' });
        return;
      }
      if (!asset.probe.hasVideo) {
        res.json({ frames: [] });
        return;
      }
      const count = Math.min(12, Math.max(2, Number(req.query.count || 8)));
      const outDir = path.join(FRAMES_DIR, asset.id, `ui_${count}`);
      const frames = await extractFramesRange(asset.filePath, outDir, asset.probe, {
        count,
        maxWidth: 480,
      });
      res.json({
        frames: frames.map((f) => ({
          timestampSec: f.timestampSec,
          dataUrl: `data:image/jpeg;base64,${f.base64}`,
        })),
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Frame extraction failed.',
      });
    }
  });

  app.post('/api/media/:id/markers', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const timestampSec = Number(req.body?.timestampSec ?? 0);
    const label = String(req.body?.label || '').trim();
    if (!label) {
      res.status(400).json({ error: 'Marker label is required.' });
      return;
    }
    const updated = studioStore.addMarker(id, {
      id: crypto.randomUUID().slice(0, 10),
      timestampSec: Math.max(0, Math.round(timestampSec * 1000) / 1000),
      author: req.body?.author === 'ai' ? 'ai' : 'human',
      label,
      createdAt: new Date().toISOString(),
    });
    if (!updated) {
      res.status(404).json({ error: 'Asset not found.' });
      return;
    }
    res.json({ asset: updated });
  });

  app.delete('/api/media/:id/markers/:markerId', (req: Request, res: Response) => {
    const updated = studioStore.deleteMarker(
      String(req.params.id),
      String(req.params.markerId)
    );
    if (!updated) {
      res.status(404).json({ error: 'Asset not found.' });
      return;
    }
    res.json({ asset: updated });
  });

  app.post('/api/media/:id/detect-cuts', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const asset = studioStore.getAsset(id);
      if (!asset) {
        res.status(404).json({ error: 'Asset not found.' });
        return;
      }
      if (!asset.probe.hasVideo) {
        res.status(400).json({ error: 'Scene cut detection requires a video stream.' });
        return;
      }
      const threshold = Math.min(0.9, Math.max(0.05, Number(req.body?.threshold ?? 0.25)));
      const cuts = await detectSceneCuts(asset.filePath, threshold);
      const fps = asset.probe.fps > 0 ? asset.probe.fps : 30;
      const newMarkers = cuts.map((t, idx) => ({
        id: crypto.randomUUID().slice(0, 10),
        timestampSec: t,
        author: 'ai' as const,
        kind: 'scene_cut' as const,
        label: `Scene cut #${idx + 1} (t=${t.toFixed(3)}s, f=${Math.round(t * fps)})`,
        createdAt: new Date().toISOString(),
      }));
      const updated = studioStore.setSceneCutMarkers(id, cuts, newMarkers, true);
      res.json({ asset: updated, detectedCount: cuts.length, threshold });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Scene cut detection failed.',
      });
    }
  });

  app.post('/api/media/:id/optical-flow', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const asset = studioStore.getAsset(id);
      if (!asset) {
        res.status(404).json({ error: 'Asset not found.' });
        return;
      }
      if (!asset.probe.hasVideo) {
        res.status(400).json({ error: 'Optical flow requires a video stream.' });
        return;
      }
      const samples = Math.min(16, Math.max(2, Number(req.body?.samples ?? 6)));
      const highMotionThreshold = Math.min(
        12,
        Math.max(0.25, Number(req.body?.highMotionThreshold ?? 2.0))
      );
      const outDir = path.join(FRAMES_DIR, asset.id, `ui_flow_${Date.now()}`);
      const { analysis } = await analyzeOpticalFlow(
        asset.id,
        asset.filePath,
        asset.probe,
        outDir,
        {
          samples,
          highMotionThreshold,
          includeVectorFrames: false,
        }
      );
      const updated = studioStore.updateAsset(id, { opticalFlow: analysis });
      res.json({ asset: updated, analysis });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Optical flow analysis failed.',
      });
    }
  });

  app.post('/api/compare', async (req: Request, res: Response) => {
    try {
      const referenceId = String(req.body?.referenceId || '');
      const targetId = String(req.body?.targetId || '');
      const ref = studioStore.getAsset(referenceId);
      const target = studioStore.getAsset(targetId);
      if (!ref || !target) {
        res.status(404).json({ error: 'Reference or target asset not found.' });
        return;
      }
      if (!ref.probe.hasVideo || !target.probe.hasVideo) {
        res.status(400).json({ error: 'Both selected assets must contain video.' });
        return;
      }
      const outDir = path.join(FRAMES_DIR, `ui_cmp_${ref.id}_${target.id}`);
      const result = await compareVideos(
        ref.filePath,
        ref.probe,
        target.filePath,
        target.probe,
        outDir,
        4,
        true
      );
      const comparison = studioStore.saveComparison({
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

      res.json({
        ssimScore: result.ssimScore,
        durationDeltaSec: result.durationDeltaSec,
        fpsDelta: result.fpsDelta,
        resolutionMatch: result.resolutionMatch,
        comparisonId: comparison.id,
        pairs: result.pairs.map((p) => ({
          progressPct: p.progressPct,
          refTimestampSec: p.refTimestampSec,
          targetTimestampSec: p.targetTimestampSec,
          sideBySideDataUrl: `data:image/jpeg;base64,${p.sideBySideBase64}`,
          diffDataUrl: p.diffBase64 ? `data:image/jpeg;base64,${p.diffBase64}` : undefined,
        })),
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Comparison failed.',
      });
    }
  });

  app.get('/api/media/:id/export', (req: Request, res: Response) => {
    const asset = studioStore.getAsset(String(req.params.id));
    if (!asset) {
      res.status(404).json({ error: 'Asset not found.' });
      return;
    }
    const includeVectors = req.query.includeVectors !== '0' && req.query.includeVectors !== 'false';
    const allAssets = studioStore.listAssets();
    const relatedComparisons = studioStore
      .listComparisons()
      .filter((c) => c.referenceId === asset.id || c.targetId === asset.id);
    const payload = buildSingleAssetNleExport(asset, relatedComparisons, allAssets, {
      includeVectors,
    });

    if (req.query.download === '1' || req.query.download === 'true') {
      const filename = `cutcheck-nle-${slugifyFilename(asset.title)}-${asset.id}.json`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(payload, null, 2));
  });

  app.get('/api/compare/export', (req: Request, res: Response) => {
    const referenceId = String(req.query.referenceId || '');
    const targetId = String(req.query.targetId || '');
    const refAsset = studioStore.getAsset(referenceId);
    const targetAsset = studioStore.getAsset(targetId);
    if (!refAsset || !targetAsset) {
      res.status(404).json({ error: 'Reference or target asset not found.' });
      return;
    }
    const includeVectors = req.query.includeVectors !== '0' && req.query.includeVectors !== 'false';
    const comparison = studioStore.getComparison(refAsset.id, targetAsset.id) ?? null;
    const payload = buildComparePairNleExport(refAsset, targetAsset, comparison, {
      includeVectors,
    });

    if (req.query.download === '1' || req.query.download === 'true') {
      const filename = `cutcheck-nle-compare-${refAsset.id}-vs-${targetAsset.id}.json`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(payload, null, 2));
  });

  app.post('/api/reviews', (req: Request, res: Response) => {
    const mediaId = String(req.body?.mediaId || '');
    const referenceMediaId = req.body?.referenceMediaId
      ? String(req.body.referenceMediaId)
      : undefined;
    const prompt = String(req.body?.prompt || 'Check motion timing and render quality.');
    if (!studioStore.getAsset(mediaId)) {
      res.status(404).json({ error: 'Media asset not found.' });
      return;
    }
    const review: ReviewRequest = {
      id: crypto.randomUUID().slice(0, 12),
      mediaId,
      referenceMediaId,
      prompt,
      requestedBy: String(req.body?.requestedBy || 'Studio'),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    studioStore.addReview(review);
    res.json({ review });
  });

  app.post('/api/reviews/:id/resolve', (req: Request, res: Response) => {
    const status = req.body?.status === 'approved' ? 'approved' : 'changes_requested';
    const reviewerNote = String(req.body?.reviewerNote || '').trim();
    const resolved = studioStore.resolveReview(String(req.params.id), status, reviewerNote);
    if (!resolved) {
      res.status(404).json({ error: 'Review request not found.' });
      return;
    }
    res.json({ review: resolved });
  });

  app.get('/api/batch', (_req: Request, res: Response) => {
    res.json({ jobs: studioStore.listBatchJobs() });
  });

  app.get('/api/batch/:id', (req: Request, res: Response) => {
    const job = studioStore.getBatchJob(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: 'Batch job not found.' });
      return;
    }
    res.json({ job });
  });

  app.post('/api/batch', (req: Request, res: Response) => {
    try {
      const validOps = new Set<BatchOperation>([
        'extract_metadata',
        'transcode_mp4',
        'transcode_webm',
        'transcode_mp3',
        'detect_scene_cuts',
        'analyze_optical_flow',
      ]);
      const rawOp = String(req.body?.operation || '') as BatchOperation;
      if (!validOps.has(rawOp)) {
        res.status(400).json({ error: `Unsupported batch operation: ${rawOp}` });
        return;
      }

      let mediaIds: string[] = Array.isArray(req.body?.mediaIds)
        ? req.body.mediaIds.map((v: unknown) => String(v))
        : [];
      if (mediaIds.length === 0) {
        const roleFilter = String(req.body?.roleFilter || 'all');
        mediaIds = studioStore
          .listAssets()
          .filter((a) => (roleFilter === 'all' ? true : a.role === roleFilter))
          .map((a) => a.id);
      }
      if (mediaIds.length === 0) {
        res.status(400).json({ error: 'No matching media assets found for batch processing.' });
        return;
      }

      const job = enqueueBatchJob({
        mediaIds,
        operation: rawOp,
        options: req.body?.options ?? {},
      });
      res.json({ job });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to enqueue batch job.',
      });
    }
  });

  app.delete('/api/batch/completed', (_req: Request, res: Response) => {
    const removed = studioStore.clearCompletedBatchJobs();
    res.json({ removed });
  });

  // ===========================================================================
  // Frontend Serving (Vite Dev Middleware or Static Production Build)
  // ===========================================================================
  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*splat', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CutCheck MCP server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start CutCheck MCP server:', err);
  process.exit(1);
});
