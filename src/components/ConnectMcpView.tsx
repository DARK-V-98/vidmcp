import { useState } from 'react';
import { Check, Copy, Globe, Terminal } from 'lucide-react';
import type { ServerCapabilities } from '../types';

interface ConnectMcpViewProps {
  capabilities: ServerCapabilities | null;
}

const MCP_TOOLS = [
  {
    name: 'list_media',
    purpose: 'Lists reference, edited, rendered, and audio clips with IDs, durations, FPS, and stream URLs.',
  },
  {
    name: 'register_media',
    purpose: 'Registers a local file path (local mode) or HTTP/HTTPS URL and probes it with ffprobe.',
  },
  {
    name: 'inspect_media',
    purpose: 'Returns exact ffprobe metadata, detected scene-cut timestamps, and timeline markers.',
  },
  {
    name: 'get_contact_sheet',
    purpose: 'Builds a 4×3 storyboard grid image so Claude sees overall motion pacing in one glance.',
  },
  {
    name: 'get_video_frames',
    purpose: 'Extracts up to 12 timestamped JPEG frames across a range [startSec, endSec] as MCP images.',
  },
  {
    name: 'get_frame_at',
    purpose: 'Captures a high-res frame at an exact second to verify easing, typography, or transitions.',
  },
  {
    name: 'compare_reference_and_rendered',
    purpose: 'Computes ffmpeg SSIM, duration/FPS drift, side-by-side frames, and pixel-diff maps.',
  },
  {
    name: 'get_audio_clip',
    purpose: 'Extracts an audio clip (up to 30s) + dB loudness stats, Peak/RMS bins, and returns MCP AudioContent.',
  },
  {
    name: 'get_audio_waveform',
    purpose: 'Returns per-bin Peak, RMS, dBFS levels, crest factor, and audio transient/beat timestamps.',
  },
  {
    name: 'analyze_optical_flow',
    purpose: 'Computes optical flow motion vectors, highlights high-motion zones in UI, and returns codecview frames.',
  },
  {
    name: 'detect_scene_cuts',
    purpose: 'Runs automated ffmpeg scene-cut detection and pins cut timestamps onto the playback timeline.',
  },
  {
    name: 'export_nle_analysis',
    purpose: 'Exports scene cuts, SMPTE timecodes, markers, SSIM metrics, and optical flow vectors as NLE JSON.',
  },
  {
    name: 'batch_process_assets',
    purpose: 'Queues batch FFmpeg transcoding (MP4/WebM/MP3), metadata extraction, scene cuts, or optical flow with sidebar progress.',
  },
  {
    name: 'get_batch_job_status',
    purpose: 'Checks progress, per-asset status, and output asset IDs for queued batch processing jobs.',
  },
  {
    name: 'add_ai_note',
    purpose: 'Pins Claude’s timestamped motion breakdown or QA note onto the Studio timeline.',
  },
  {
    name: 'request_human_review',
    purpose: 'Sends a video or audio (with optional reference) to the Human QA Review Inbox.',
  },
  {
    name: 'get_review_status',
    purpose: 'Checks your Approve / Request Changes decision and timestamped notes.',
  },
];

function CopyBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#0b0e14]">
      <div className="flex items-center justify-between border-b border-slate-800 bg-[#121721] px-4 py-2.5">
        <span className="text-xs font-medium text-slate-300">{label}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-[#0b0e14] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:text-white"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-slate-200">
        {code}
      </pre>
    </div>
  );
}

export function ConnectMcpView({ capabilities }: ConnectMcpViewProps) {
  const [mode, setMode] = useState<'online' | 'local'>('online');

  const baseUrl = capabilities?.baseUrl || window.location.origin;
  const streamableUrl = capabilities?.streamableHttpUrl || `${baseUrl}/mcp`;
  const sseUrl = capabilities?.sseUrl || `${baseUrl}/sse`;
  const root = capabilities?.workspaceRoot || '/path/to/cutcheck-mcp';

  const claudeCodeRemote = `claude mcp add --transport http cutcheck "${streamableUrl}"`;

  const remoteJsonConfig = JSON.stringify(
    {
      mcpServers: {
        cutcheck: {
          type: 'http',
          url: streamableUrl,
        },
      },
    },
    null,
    2
  );

  const localStdioConfig = JSON.stringify(
    {
      mcpServers: {
        cutcheck: {
          command: 'npx',
          args: ['tsx', `${root}/mcp-stdio.ts`],
          env: {
            APP_URL: 'http://localhost:3000',
          },
        },
      },
    },
    null,
    2
  );

  const localClaudeCode = `claude mcp add cutcheck -- npx tsx "${root}/mcp-stdio.ts"`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <h1 className="font-display text-xl font-semibold text-slate-100">
            Connect Claude or Any MCP Client
          </h1>
          <p className="mt-0.5 text-sm text-slate-400">
            Zero AI runs inside CutCheck. Connect your external AI via Streamable HTTP (online) or stdio (local hard drive access).
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-[#121721] p-1 border border-slate-800">
          <button
            type="button"
            onClick={() => setMode('online')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
              mode === 'online'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            Online / Remote HTTP
          </button>
          <button
            type="button"
            onClick={() => setMode('local')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
              mode === 'local'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="h-3.5 w-3.5" />
            Local Desktop (stdio)
          </button>
        </div>
      </div>

      {mode === 'online' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-slate-800 bg-slate-800 md:grid-cols-2">
            <div className="bg-[#121721] p-4">
              <div className="text-xs font-medium text-slate-400">
                Streamable HTTP Endpoint (Recommended)
              </div>
              <div className="mt-1 break-all font-mono text-xs text-blue-300">
                {streamableUrl}
              </div>
            </div>
            <div className="bg-[#121721] p-4">
              <div className="text-xs font-medium text-slate-400">
                Legacy HTTP+SSE Endpoint
              </div>
              <div className="mt-1 break-all font-mono text-xs text-slate-200">
                {sseUrl}
              </div>
            </div>
          </div>

          <CopyBlock label="Claude Code CLI (Online / Remote)" code={claudeCodeRemote} />
          <CopyBlock
            label="Cursor / MCP Client JSON (.cursor/mcp.json or claude_desktop_config.json)"
            code={remoteJsonConfig}
          />
          <p className="text-xs text-slate-400">
            In online mode, upload reference videos, edited cuts, and rendered outputs in the Studio UI (or pass public URLs to <code className="font-mono text-slate-200">register_media</code>). Claude inspects frames, scene cuts, SSIM diffs, and audio clips directly over HTTPS.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <CopyBlock
            label="Claude Desktop (claude_desktop_config.json) — Direct Local Filesystem Access"
            code={localStdioConfig}
          />
          <CopyBlock label="Claude Code CLI (Local stdio)" code={localClaudeCode} />
          <CopyBlock
            label="Run Local Studio UI + HTTP MCP Together"
            code={`npm install && npm run dev\n# Studio UI at http://localhost:3000\n# Local HTTP MCP at http://localhost:3000/mcp`}
          />
          <p className="text-xs text-slate-400">
            In local mode, Claude can call <code className="font-mono text-slate-200">register_media</code> with any file path on your computer (e.g. <code className="font-mono text-slate-200">/Users/you/renders/final.mp4</code>) while you watch live in <code className="font-mono text-slate-200">http://localhost:3000</code>.
          </p>
        </div>
      )}

      {/* MCP Tool Catalog */}
      <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#121721]">
        <div className="border-b border-slate-800 px-4 py-3">
          <h2 className="font-display text-sm font-semibold text-slate-100">
            Available MCP Tools ({MCP_TOOLS.length})
          </h2>
        </div>
        <div className="divide-y divide-slate-800/80">
          {MCP_TOOLS.map((t) => (
            <div
              key={t.name}
              className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
            >
              <code className="w-64 shrink-0 font-mono text-xs font-medium text-blue-300">
                {t.name}
              </code>
              <span className="text-xs text-slate-300">{t.purpose}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
