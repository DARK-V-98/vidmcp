import { useEffect, useMemo, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import type { AudioAnalysisSummary, AudioEnvelopeBin } from '../types';
import { formatShortTime } from '../utils/format';

interface WaveformVisualizerProps {
  assetId: string;
  streamUrl: string;
  mediaElement: HTMLMediaElement | null;
  durationSec: number;
  currentTime: number;
  fallbackPeaks: number[];
  initialSummary?: AudioAnalysisSummary;
  onSeek: (sec: number) => void;
}

export function WaveformVisualizer({
  assetId,
  streamUrl,
  mediaElement,
  durationSec,
  currentTime,
  fallbackPeaks,
  initialSummary,
  onSeek,
}: WaveformVisualizerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  const [zoomFactor, setZoomFactor] = useState<1 | 2 | 4>(1);
  const [ready, setReady] = useState(false);
  const [bins, setBins] = useState<AudioEnvelopeBin[]>([]);
  const [summary, setSummary] = useState<AudioAnalysisSummary | undefined>(initialSummary);
  const [decodedChannels, setDecodedChannels] = useState<number>(0);
  const [decodedSampleRate, setDecodedSampleRate] = useState<number>(0);

  // Fetch deterministic server-side Peak & RMS bins (same math exposed to MCP)
  useEffect(() => {
    let cancelled = false;
    setBins([]);
    setSummary(initialSummary);

    fetch(`/api/media/${assetId}/waveform?bins=128`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data.bins)) setBins(data.bins);
        if (data.summary) setSummary(data.summary);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [assetId, initialSummary]);

  // Mount wavesurfer.js Web Audio waveform analyzer synced to the HTMLMediaElement
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !mediaElement) return;

    setReady(false);
    setDecodedChannels(0);
    setDecodedSampleRate(0);

    const ws = WaveSurfer.create({
      container,
      media: mediaElement,
      url: streamUrl,
      peaks: fallbackPeaks.length > 0 ? [fallbackPeaks] : undefined,
      duration: durationSec > 0 ? durationSec : undefined,
      height: 76,
      waveColor: '#334155',
      progressColor: '#3b82f6',
      cursorColor: '#93c5fd',
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: true,
      dragToSeek: true,
      hideScrollbar: false,
    });

    wsRef.current = ws;

    ws.on('ready', () => {
      setReady(true);
      const decoded = ws.getDecodedData();
      if (decoded) {
        setDecodedChannels(decoded.numberOfChannels);
        setDecodedSampleRate(decoded.sampleRate);
      }
    });

    ws.on('interaction', (newTime) => {
      onSeekRef.current(newTime);
    });

    ws.on('error', () => {
      // Fallback peaks still render even if browser rejects decoding an exotic codec
      setReady(true);
    });

    return () => {
      wsRef.current = null;
      try {
        ws.destroy();
      } catch {
        // ignore abort during rapid clip switch
      }
    };
  }, [assetId, streamUrl, mediaElement, durationSec, fallbackPeaks]);

  // Apply zoom via WaveSurfer API
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    try {
      if (zoomFactor === 1) {
        ws.zoom(0);
      } else if (zoomFactor === 2) {
        ws.zoom(110);
      } else {
        ws.zoom(240);
      }
    } catch {
      // ignore if not yet decoded
    }
  }, [zoomFactor, ready]);

  // Active Peak/RMS bin under playhead
  const activeBin = useMemo(() => {
    if (bins.length === 0) return null;
    const found = bins.find((b) => currentTime >= b.startSec && currentTime <= b.endSec);
    return found ?? bins[Math.min(bins.length - 1, Math.floor((currentTime / Math.max(0.1, durationSec)) * bins.length))];
  }, [bins, currentTime, durationSec]);

  return (
    <div className="space-y-2.5 rounded-lg border border-slate-800 bg-[#0b0e14] p-3">
      {/* Top Telemetry & Zoom Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-3 font-mono text-slate-400 tabular-nums">
          <span className="font-sans text-xs font-medium text-slate-300">
            Audio Waveform (WaveSurfer)
          </span>
          {activeBin && (
            <>
              <span>
                Peak <strong className="text-slate-100">{activeBin.peakDb.toFixed(1)} dBFS</strong>
              </span>
              <span>
                RMS <strong className="text-blue-300">{activeBin.rmsDb.toFixed(1)} dBFS</strong>
              </span>
            </>
          )}
          {summary && (
            <>
              <span className="hidden sm:inline">
                Max {summary.maxPeakDb.toFixed(1)} dB
              </span>
              <span className="hidden md:inline">
                Mean RMS {summary.meanRmsDb.toFixed(1)} dB
              </span>
              <span className="hidden md:inline">
                Crest {summary.crestFactorDb.toFixed(1)} dB
              </span>
            </>
          )}
          {decodedSampleRate > 0 && (
            <span className="hidden lg:inline text-slate-500">
              {decodedChannels}ch · {(decodedSampleRate / 1000).toFixed(1)}kHz
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 rounded-md bg-[#121721] p-0.5">
          {([1, 2, 4] as const).map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => setZoomFactor(z)}
              className={`rounded px-2 py-0.5 font-mono text-[11px] whitespace-nowrap transition-colors ${
                zoomFactor === z
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {z}x
            </button>
          ))}
        </div>
      </div>

      {/* WaveSurfer Canvas Mount */}
      <div
        ref={containerRef}
        className="w-full overflow-x-auto rounded bg-[#0d1118] px-1 py-1"
      />

      {/* Clickable Audio Transients / Beat Peaks */}
      {summary && summary.transientTimestampsSec.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[11px]">
          <span className="text-slate-500">Audio Transients:</span>
          {summary.transientTimestampsSec.slice(0, 12).map((t, idx) => (
            <button
              key={`${t}-${idx}`}
              type="button"
              onClick={() => onSeek(t)}
              className="rounded border border-slate-800 bg-[#121721] px-2 py-0.5 font-mono text-[11px] text-slate-300 tabular-nums transition-colors hover:border-blue-500/60 hover:text-blue-300"
            >
              {formatShortTime(t)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
