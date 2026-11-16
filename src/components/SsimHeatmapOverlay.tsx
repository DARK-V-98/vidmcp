import { useEffect, useRef, useState } from 'react';

export type HeatmapMode = 'off' | 'overlay' | 'isolated';

interface SsimHeatmapOverlayProps {
  refVideo: HTMLVideoElement | null;
  targetVideo: HTMLVideoElement | null;
  mode: HeatmapMode;
  opacity: number;
  sensitivity: number;
  onMetricsUpdate?: (
    sample: {
      timestampSec: number;
      meanSsim: number;
      diffAreaPct: number;
    } | null
  ) => void;
}

const GRID_W = 160;
const GRID_H = 90;
const C1 = (0.01 * 255) ** 2; // 6.5025
const C2 = (0.03 * 255) ** 2; // 58.5225

export function SsimHeatmapOverlay({
  refVideo,
  targetVideo,
  mode,
  opacity,
  sensitivity,
  onMetricsUpdate,
}: SsimHeatmapOverlayProps) {
  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workRefCanvas = useRef<HTMLCanvasElement | null>(null);
  const workTargetCanvas = useRef<HTMLCanvasElement | null>(null);
  const workOutCanvas = useRef<HTMLCanvasElement | null>(null);
  const lumaRefBuf = useRef<Float32Array>(new Float32Array(GRID_W * GRID_H));
  const lumaTgtBuf = useRef<Float32Array>(new Float32Array(GRID_W * GRID_H));
  const onMetricsRef = useRef(onMetricsUpdate);
  onMetricsRef.current = onMetricsUpdate;

  const [metrics, setMetrics] = useState<{ meanSsim: number; diffAreaPct: number } | null>(
    null
  );

  useEffect(() => {
    if (mode === 'off') {
      setMetrics(null);
      onMetricsRef.current?.(null);
      return;
    }
    if (!refVideo || !targetVideo) return;

    if (!workRefCanvas.current) {
      workRefCanvas.current = document.createElement('canvas');
      workRefCanvas.current.width = GRID_W;
      workRefCanvas.current.height = GRID_H;
    }
    if (!workTargetCanvas.current) {
      workTargetCanvas.current = document.createElement('canvas');
      workTargetCanvas.current.width = GRID_W;
      workTargetCanvas.current.height = GRID_H;
    }
    if (!workOutCanvas.current) {
      workOutCanvas.current = document.createElement('canvas');
      workOutCanvas.current.width = GRID_W;
      workOutCanvas.current.height = GRID_H;
    }

    const ctxR = workRefCanvas.current.getContext('2d', { willReadFrequently: true });
    const ctxT = workTargetCanvas.current.getContext('2d', { willReadFrequently: true });
    const ctxOut = workOutCanvas.current.getContext('2d');
    const dispCanvas = displayCanvasRef.current;
    const ctxDisp = dispCanvas?.getContext('2d');

    if (!ctxR || !ctxT || !ctxOut || !dispCanvas || !ctxDisp) return;

    let rafId = 0;
    let cancelled = false;
    let lastMetricTick = 0;

    const computeFrame = () => {
      if (cancelled) return;
      if (refVideo.readyState < 2 || targetVideo.readyState < 2) return;

      ctxR.drawImage(refVideo, 0, 0, GRID_W, GRID_H);
      ctxT.drawImage(targetVideo, 0, 0, GRID_W, GRID_H);

      const dataR = ctxR.getImageData(0, 0, GRID_W, GRID_H).data;
      const dataT = ctxT.getImageData(0, 0, GRID_W, GRID_H).data;
      const lumaR = lumaRefBuf.current;
      const lumaT = lumaTgtBuf.current;

      const total = GRID_W * GRID_H;
      for (let i = 0; i < total; i++) {
        const p = i * 4;
        lumaR[i] = 0.299 * dataR[p] + 0.587 * dataR[p + 1] + 0.114 * dataR[p + 2];
        lumaT[i] = 0.299 * dataT[p] + 0.587 * dataT[p + 1] + 0.114 * dataT[p + 2];
      }

      const outImg = ctxOut.createImageData(GRID_W, GRID_H);
      const out = outImg.data;

      let sumSsim = 0;
      let diffCount = 0;
      const floor = Math.max(0.15, sensitivity - 0.55);
      const span = Math.max(0.05, sensitivity - floor);

      for (let y = 0; y < GRID_H; y++) {
        const y0 = y > 0 ? y - 1 : 0;
        const y1 = y < GRID_H - 1 ? y + 1 : GRID_H - 1;
        for (let x = 0; x < GRID_W; x++) {
          const x0 = x > 0 ? x - 1 : 0;
          const x1 = x < GRID_W - 1 ? x + 1 : GRID_W - 1;

          let sX = 0;
          let sY = 0;
          let sXX = 0;
          let sYY = 0;
          let sXY = 0;
          let n = 0;

          for (let wy = y0; wy <= y1; wy++) {
            const row = wy * GRID_W;
            for (let wx = x0; wx <= x1; wx++) {
              const vx = lumaR[row + wx];
              const vy = lumaT[row + wx];
              sX += vx;
              sY += vy;
              sXX += vx * vx;
              sYY += vy * vy;
              sXY += vx * vy;
              n++;
            }
          }

          const muX = sX / n;
          const muY = sY / n;
          const varX = Math.max(0, sXX / n - muX * muX);
          const varY = Math.max(0, sYY / n - muY * muY);
          const covXY = sXY / n - muX * muY;

          const num = (2 * muX * muY + C1) * (2 * covXY + C2);
          const den = (muX * muX + muY * muY + C1) * (varX + varY + C2);
          const ssim = Math.max(0, Math.min(1, den > 0 ? num / den : 1));

          sumSsim += ssim;

          const idx = (y * GRID_W + x) * 4;
          if (ssim < sensitivity) {
            diffCount++;
            const intensity = Math.max(0, Math.min(1, (sensitivity - ssim) / span));
            let r = 245;
            let g = 158;
            let b = 11;
            if (intensity < 0.45) {
              const t = intensity / 0.45;
              r = Math.round(56 + t * (245 - 56));
              g = Math.round(189 + t * (158 - 189));
              b = Math.round(248 + t * (11 - 248));
            } else {
              const t = (intensity - 0.45) / 0.55;
              r = Math.round(245 + t * (239 - 245));
              g = Math.round(158 + t * (56 - 158));
              b = Math.round(11 + t * (68 - 11));
            }
            out[idx] = r;
            out[idx + 1] = g;
            out[idx + 2] = b;
            out[idx + 3] = Math.round(opacity * (115 + intensity * 140));
          } else if (mode === 'isolated') {
            out[idx] = 11;
            out[idx + 1] = 14;
            out[idx + 2] = 20;
            out[idx + 3] = Math.round(opacity * 240);
          } else {
            out[idx] = 0;
            out[idx + 1] = 0;
            out[idx + 2] = 0;
            out[idx + 3] = 0;
          }
        }
      }

      ctxOut.putImageData(outImg, 0, 0);
      ctxDisp.clearRect(0, 0, dispCanvas.width, dispCanvas.height);
      ctxDisp.imageSmoothingEnabled = true;
      ctxDisp.drawImage(workOutCanvas.current!, 0, 0, dispCanvas.width, dispCanvas.height);

      const next = {
        meanSsim: Math.round((sumSsim / total) * 10000) / 10000,
        diffAreaPct: Math.round((diffCount / total) * 1000) / 10,
      };
      onMetricsRef.current?.({
        timestampSec: Math.round(targetVideo.currentTime * 1000) / 1000,
        ...next,
      });
      const now = performance.now();
      if (now - lastMetricTick > 100 || refVideo.paused || targetVideo.paused) {
        lastMetricTick = now;
        setMetrics(next);
      }
    };

    const tick = () => {
      if (cancelled) return;
      computeFrame();
      if (!refVideo.paused || !targetVideo.paused) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const onSyncEvent = () => {
      computeFrame();
    };
    const onPlay = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    };
    const onPause = () => {
      cancelAnimationFrame(rafId);
      computeFrame();
    };

    computeFrame();

    const events: Array<[HTMLVideoElement, string, () => void]> = [
      [refVideo, 'seeked', onSyncEvent],
      [targetVideo, 'seeked', onSyncEvent],
      [refVideo, 'loadeddata', onSyncEvent],
      [targetVideo, 'loadeddata', onSyncEvent],
      [refVideo, 'timeupdate', onSyncEvent],
      [targetVideo, 'timeupdate', onSyncEvent],
      [refVideo, 'play', onPlay],
      [targetVideo, 'play', onPlay],
      [refVideo, 'pause', onPause],
      [targetVideo, 'pause', onPause],
    ];

    for (const [el, ev, fn] of events) {
      el.addEventListener(ev, fn);
    }
    if (!refVideo.paused || !targetVideo.paused) {
      rafId = requestAnimationFrame(tick);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      for (const [el, ev, fn] of events) {
        el.removeEventListener(ev, fn);
      }
    };
  }, [refVideo, targetVideo, mode, opacity, sensitivity]);

  if (mode === 'off') return null;

  return (
    <div className="pointer-events-none absolute inset-0">
      <canvas
        ref={displayCanvasRef}
        width={480}
        height={270}
        className="h-full w-full object-contain"
      />
      {metrics && (
        <div className="absolute top-2.5 left-2.5 rounded-md bg-black/75 px-2.5 py-1 font-mono text-[11px] text-slate-100 backdrop-blur-xs tabular-nums">
          SSIM {metrics.meanSsim.toFixed(4)} · Diff {metrics.diffAreaPct.toFixed(1)}%
        </div>
      )}
    </div>
  );
}
