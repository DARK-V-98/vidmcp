import { useEffect, useRef, useState } from 'react';
import type { OpticalFlowAnalysis, OpticalFlowVector } from '../types';

export type OpticalFlowMode = 'off' | 'both' | 'vectors' | 'heat';

interface OpticalFlowOverlayProps {
  videoElement: HTMLVideoElement | null;
  mode: OpticalFlowMode;
  threshold: number;
  opacity: number;
  analysis?: OpticalFlowAnalysis;
  onTelemetryUpdate?: (
    sample: {
      timestampSec: number;
      meanMagnitude: number;
      peakMagnitude: number;
      highMotionCoveragePct: number;
      dominantDirectionDeg: number;
      source: 'live' | 'mcp';
      vectors: OpticalFlowVector[];
    } | null
  ) => void;
}

const FLOW_W = 160;
const FLOW_H = 90;
const GRID_COLS = 16;
const GRID_ROWS = 9;
const BLOCK_W = 10;
const BLOCK_H = 10;
const SEARCH_R = 5;

function computeBlockMatchSad(
  prev: Uint8Array,
  curr: Uint8Array,
  threshold: number
): {
  vectors: OpticalFlowVector[];
  meanMagnitude: number;
  peakMagnitude: number;
  highMotionPct: number;
  dominantDeg: number;
} {
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

      let zeroSad = 0;
      let minLuma = 255;
      let maxLuma = 0;
      for (let py = 0; py < BLOCK_H; py++) {
        const off = (by + py) * FLOW_W + bx;
        for (let px = 0; px < BLOCK_W; px++) {
          const v0 = prev[off + px];
          const v1 = curr[off + px];
          zeroSad += Math.abs(v0 - v1);
          if (v0 < minLuma) minLuma = v0;
          if (v0 > maxLuma) maxLuma = v0;
        }
      }

      let bestDx = 0;
      let bestDy = 0;
      let bestSad = zeroSad;

      if (maxLuma - minLuma >= 12 && zeroSad > BLOCK_W * BLOCK_H * 1.5) {
        for (let dy = -SEARCH_R; dy <= SEARCH_R; dy++) {
          const ty = by + dy;
          if (ty < 0 || ty + BLOCK_H > FLOW_H) continue;
          for (let dx = -SEARCH_R; dx <= SEARCH_R; dx++) {
            if (dx === 0 && dy === 0) continue;
            const tx = bx + dx;
            if (tx < 0 || tx + BLOCK_W > FLOW_W) continue;

            let sad = 0;
            for (let py = 0; py < BLOCK_H; py++) {
              const r0 = (by + py) * FLOW_W + bx;
              const r1 = (ty + py) * FLOW_W + tx;
              for (let px = 0; px < BLOCK_W; px++) {
                sad += Math.abs(prev[r0 + px] - curr[r1 + px]);
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
        if (bestSad > zeroSad * 0.9) {
          bestDx = 0;
          bestDy = 0;
        }
      }

      const mag = Math.hypot(bestDx, bestDy);
      sumMag += mag;
      if (mag > peakMag) peakMag = mag;
      if (mag >= threshold) highCount++;
      sumDx += bestDx;
      sumDy += bestDy;

      vectors.push({
        gx: (gx + 0.5) / GRID_COLS,
        gy: (gy + 0.5) / GRID_ROWS,
        dx: bestDx,
        dy: bestDy,
        magnitude: mag,
      });
    }
  }

  const n = Math.max(1, vectors.length);
  return {
    vectors,
    meanMagnitude: sumMag / n,
    peakMagnitude: peakMag,
    highMotionPct: (highCount / n) * 100,
    dominantDeg:
      Math.hypot(sumDx, sumDy) > 0.5 ? (Math.atan2(sumDy, sumDx) * 180) / Math.PI : 0,
  };
}

function drawFlowField(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  vectors: OpticalFlowVector[],
  cols: number,
  rows: number,
  mode: OpticalFlowMode,
  threshold: number,
  opacity: number
) {
  ctx.clearRect(0, 0, w, h);
  if (mode === 'off' || vectors.length === 0) return;

  const cellW = w / cols;
  const cellH = h / rows;

  // 1. Intensity Heat Layer
  if (mode === 'both' || mode === 'heat') {
    for (const v of vectors) {
      if (v.magnitude < 0.25) continue;
      const cx = v.gx * w;
      const cy = v.gy * h;
      const x0 = cx - cellW / 2;
      const y0 = cy - cellH / 2;
      const isHigh = v.magnitude >= threshold;
      const norm = Math.min(1, v.magnitude / Math.max(2, threshold * 2.2));

      if (isHigh) {
        const r = 239;
        const g = Math.round(158 - norm * 90);
        const b = Math.round(11 + norm * 57);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(0.22 + norm * 0.34) * opacity})`;
        ctx.fillRect(x0, y0, cellW, cellH);

        ctx.strokeStyle = `rgba(251, 191, 36, ${0.55 * opacity})`;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, cellW - 1, cellH - 1);
      } else {
        ctx.fillStyle = `rgba(56, 189, 248, ${(0.08 + norm * 0.14) * opacity})`;
        ctx.fillRect(x0, y0, cellW, cellH);
      }
    }
  }

  // 2. Motion Vector Arrows
  if (mode === 'both' || mode === 'vectors') {
    const scale = 5.5;
    for (const v of vectors) {
      if (v.magnitude < 0.4) continue;
      const x1 = v.gx * w;
      const y1 = v.gy * h;
      const vx = v.dx * scale;
      const vy = v.dy * scale;
      const x2 = x1 + vx;
      const y2 = y1 + vy;
      const isHigh = v.magnitude >= threshold;

      ctx.strokeStyle = isHigh
        ? `rgba(251, 146, 60, ${0.95 * opacity})`
        : `rgba(56, 189, 248, ${0.78 * opacity})`;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = isHigh ? 2 : 1.4;

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      const angle = Math.atan2(vy, vx);
      const headLen = isHigh ? 6.5 : 5;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(
        x2 - headLen * Math.cos(angle - Math.PI / 6),
        y2 - headLen * Math.sin(angle - Math.PI / 6)
      );
      ctx.lineTo(
        x2 - headLen * Math.cos(angle + Math.PI / 6),
        y2 - headLen * Math.sin(angle + Math.PI / 6)
      );
      ctx.closePath();
      ctx.fill();
    }
  }
}

export function OpticalFlowOverlay({
  videoElement,
  mode,
  threshold,
  opacity,
  analysis,
  onTelemetryUpdate,
}: OpticalFlowOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevLumaRef = useRef<Uint8Array | null>(null);
  const prevTimeRef = useRef<number>(-1);
  const onTelemetryRef = useRef(onTelemetryUpdate);
  onTelemetryRef.current = onTelemetryUpdate;

  const [hud, setHud] = useState<{
    meanMag: number;
    peakMag: number;
    highPct: number;
    deg: number;
    source: 'live' | 'mcp';
  } | null>(null);

  useEffect(() => {
    if (mode === 'off') {
      setHud(null);
      onTelemetryRef.current?.(null);
      return;
    }
    if (!videoElement) return;

    if (!workCanvasRef.current) {
      workCanvasRef.current = document.createElement('canvas');
      workCanvasRef.current.width = FLOW_W;
      workCanvasRef.current.height = FLOW_H;
    }

    const workCtx = workCanvasRef.current.getContext('2d', { willReadFrequently: true });
    const dispCanvas = canvasRef.current;
    const dispCtx = dispCanvas?.getContext('2d');
    if (!workCtx || !dispCanvas || !dispCtx) return;

    let rafId = 0;
    let cancelled = false;
    let lastHudTick = 0;

    const findNearestAnalyzedFrame = (t: number) => {
      if (!analysis || analysis.frames.length === 0) return null;
      let best = analysis.frames[0];
      let bestDist = Math.abs(best.timestampSec - t);
      for (const f of analysis.frames) {
        const d = Math.abs(f.timestampSec - t);
        if (d < bestDist) {
          best = f;
          bestDist = d;
        }
      }
      return bestDist <= 0.45 ? best : null;
    };

    const captureLuma = (): Uint8Array | null => {
      if (videoElement.readyState < 2) return null;
      workCtx.drawImage(videoElement, 0, 0, FLOW_W, FLOW_H);
      const rgba = workCtx.getImageData(0, 0, FLOW_W, FLOW_H).data;
      const out = new Uint8Array(FLOW_W * FLOW_H);
      for (let i = 0; i < out.length; i++) {
        const p = i * 4;
        out[i] = Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]);
      }
      return out;
    };

    const updateFrame = (allowPrecomputedFallback: boolean) => {
      if (cancelled) return;
      const t = videoElement.currentTime;

      if (allowPrecomputedFallback && videoElement.paused) {
        const pre = findNearestAnalyzedFrame(t);
        if (pre) {
          drawFlowField(
            dispCtx,
            dispCanvas.width,
            dispCanvas.height,
            pre.vectors,
            analysis?.gridCols ?? GRID_COLS,
            analysis?.gridRows ?? GRID_ROWS,
            mode,
            threshold,
            opacity
          );
          setHud({
            meanMag: pre.meanMagnitude,
            peakMag: pre.peakMagnitude,
            highPct: pre.highMotionCoveragePct,
            deg: pre.dominantDirectionDeg,
            source: 'mcp',
          });
          onTelemetryRef.current?.({
            timestampSec: Math.round(t * 1000) / 1000,
            meanMagnitude: pre.meanMagnitude,
            peakMagnitude: pre.peakMagnitude,
            highMotionCoveragePct: pre.highMotionCoveragePct,
            dominantDirectionDeg: pre.dominantDirectionDeg,
            source: 'mcp',
            vectors: pre.vectors,
          });
          prevLumaRef.current = captureLuma();
          prevTimeRef.current = t;
          return;
        }
      }

      const curr = captureLuma();
      if (!curr) return;

      const vw = videoElement.videoWidth;
      const vh = videoElement.videoHeight;
      if (vw > 0 && vh > 0) {
        const targetW = Math.min(720, vw);
        const targetH = Math.max(180, Math.round((targetW * vh) / vw));
        if (dispCanvas.width !== targetW || dispCanvas.height !== targetH) {
          dispCanvas.width = targetW;
          dispCanvas.height = targetH;
        }
      }

      const dt = Math.abs(t - prevTimeRef.current);
      if (prevLumaRef.current && dt > 0.005 && dt < 0.35) {
        const res = computeBlockMatchSad(prevLumaRef.current, curr, threshold);
        drawFlowField(
          dispCtx,
          dispCanvas.width,
          dispCanvas.height,
          res.vectors,
          GRID_COLS,
          GRID_ROWS,
          mode,
          threshold,
          opacity
        );

        const roundedSample = {
          meanMag: Math.round(res.meanMagnitude * 100) / 100,
          peakMag: Math.round(res.peakMagnitude * 100) / 100,
          highPct: Math.round(res.highMotionPct * 10) / 10,
          deg: Math.round(res.dominantDeg),
        };
        onTelemetryRef.current?.({
          timestampSec: Math.round(t * 1000) / 1000,
          meanMagnitude: roundedSample.meanMag,
          peakMagnitude: roundedSample.peakMag,
          highMotionCoveragePct: roundedSample.highPct,
          dominantDirectionDeg: roundedSample.deg,
          source: 'live',
          vectors: res.vectors,
        });

        const now = performance.now();
        if (now - lastHudTick > 90 || videoElement.paused) {
          lastHudTick = now;
          setHud({
            ...roundedSample,
            source: 'live',
          });
        }
      } else if (allowPrecomputedFallback) {
        const pre = findNearestAnalyzedFrame(t);
        if (pre) {
          drawFlowField(
            dispCtx,
            dispCanvas.width,
            dispCanvas.height,
            pre.vectors,
            analysis?.gridCols ?? GRID_COLS,
            analysis?.gridRows ?? GRID_ROWS,
            mode,
            threshold,
            opacity
          );
        } else {
          dispCtx.clearRect(0, 0, dispCanvas.width, dispCanvas.height);
        }
      }

      prevLumaRef.current = curr;
      prevTimeRef.current = t;
    };

    const tick = () => {
      if (cancelled) return;
      updateFrame(false);
      if (!videoElement.paused) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const onPlay = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    };
    const onPauseOrSeek = () => {
      cancelAnimationFrame(rafId);
      updateFrame(true);
    };

    updateFrame(true);

    videoElement.addEventListener('play', onPlay);
    videoElement.addEventListener('pause', onPauseOrSeek);
    videoElement.addEventListener('seeked', onPauseOrSeek);
    videoElement.addEventListener('loadeddata', onPauseOrSeek);

    if (!videoElement.paused) {
      rafId = requestAnimationFrame(tick);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      videoElement.removeEventListener('play', onPlay);
      videoElement.removeEventListener('pause', onPauseOrSeek);
      videoElement.removeEventListener('seeked', onPauseOrSeek);
      videoElement.removeEventListener('loadeddata', onPauseOrSeek);
    };
  }, [videoElement, mode, threshold, opacity, analysis]);

  if (mode === 'off') return null;

  return (
    <div className="pointer-events-none absolute inset-0">
      <canvas
        ref={canvasRef}
        width={640}
        height={360}
        className="h-full w-full"
      />
      {hud && (
        <div className="absolute top-2.5 left-2.5 rounded-md bg-black/75 px-2.5 py-1 font-mono text-[11px] text-slate-100 backdrop-blur-xs tabular-nums">
          Flow {hud.meanMag.toFixed(2)}px · Peak {hud.peakMag.toFixed(1)}px · High {hud.highPct.toFixed(1)}% · {hud.deg}° ({hud.source === 'mcp' ? 'MCP' : 'Live'})
        </div>
      )}
    </div>
  );
}
