"use client";

import * as React from "react";

export type VoiceHeroVisualHandle = { bump: () => void };

type SystemState = "idle" | "listening" | "processing" | "speaking" | "error";

type Props = {
  systemState: SystemState;
  sessionLive: boolean;
};

/**
 * Immersive topographic / fluid visualization — reacts to `bump()` from speech
 * results and to system state (processing / speaking pulses).
 * Optional Web Audio mic level when session is live (best-effort; falls back if blocked).
 */
export const VoiceHeroVisual = React.forwardRef<VoiceHeroVisualHandle, Props>(
  function VoiceHeroVisual({ systemState, sessionLive }, ref) {
    const canvasRef = React.useRef<HTMLCanvasElement>(null);
    const wrapRef = React.useRef<HTMLDivElement>(null);
    const energyRef = React.useRef(0);
    const [displayEnergy, setDisplayEnergy] = React.useState(0);
    const frameRef = React.useRef(0);
    const tRef = React.useRef(0);
    const analyserRef = React.useRef<AnalyserNode | null>(null);
    const dataRef = React.useRef<Uint8Array | null>(null);
    const streamRef = React.useRef<MediaStream | null>(null);
    const ctxRef = React.useRef<AudioContext | null>(null);

    React.useImperativeHandle(ref, () => ({
      bump: () => {
        energyRef.current = Math.min(1, energyRef.current + 0.28);
      },
    }));

    /* Optional real mic levels (does not replace SpeechRecognition). */
    React.useEffect(() => {
      if (!sessionLive || systemState === "error") {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        void ctxRef.current?.close();
        ctxRef.current = null;
        analyserRef.current = null;
        dataRef.current = null;
        return;
      }

      let cancelled = false;
      (async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = stream;
          const ctx = new AudioContext();
          ctxRef.current = ctx;
          const src = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.65;
          src.connect(analyser);
          analyserRef.current = analyser;
          dataRef.current = new Uint8Array(analyser.frequencyBinCount);
        } catch {
          /* Common when SR already holds mic — visual still works via bumps. */
        }
      })();

      return () => {
        cancelled = true;
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        void ctxRef.current?.close();
        ctxRef.current = null;
        analyserRef.current = null;
        dataRef.current = null;
      };
    }, [sessionLive, systemState]);

    React.useEffect(() => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;

      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;

      let raf = 0;

      const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const { width, height } = wrap.getBoundingClientRect();
        canvas.width = Math.max(1, Math.floor(width * dpr));
        canvas.height = Math.max(1, Math.floor(height * dpr));
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      };

      const ro = new ResizeObserver(resize);
      ro.observe(wrap);
      resize();

      const tick = () => {
        tRef.current += 0.018;
        const t = tRef.current;

        let micBoost = 0;
        const an = analyserRef.current;
        const data = dataRef.current;
        if (an && data) {
          an.getByteFrequencyData(data as Parameters<AnalyserNode["getByteFrequencyData"]>[0]);
          let s = 0;
          const n = Math.min(data.length, 48);
          for (let i = 0; i < n; i++) s += data[i] ?? 0;
          micBoost = (s / (n * 255)) * 0.85;
        }

        let target = energyRef.current + micBoost;
        if (systemState === "speaking") {
          target = Math.max(
            target,
            0.38 + 0.32 * Math.sin(t * 2.8) + 0.12 * Math.sin(t * 6.1)
          );
        } else if (systemState === "processing") {
          target = Math.max(target, 0.22 + 0.12 * Math.sin(t * 3.5));
        } else if (systemState === "listening" && sessionLive) {
          target = Math.max(target, 0.08);
        }

        energyRef.current += (target - energyRef.current) * 0.14;
        energyRef.current *= 0.965;
        energyRef.current = Math.max(0, Math.min(1, energyRef.current));
        frameRef.current += 1;
        if (frameRef.current % 2 === 0) {
          setDisplayEnergy(energyRef.current);
        }

        const w = wrap.getBoundingClientRect().width;
        const h = wrap.getBoundingClientRect().height;
        const e = energyRef.current;

        ctx2d.fillStyle = "#060606";
        ctx2d.fillRect(0, 0, w, h);

        /* Chromatic offset pass — subtle glitch / wave feel */
        const shift = e * 2.5;
        ctx2d.save();
        ctx2d.globalCompositeOperation = "screen";
        ctx2d.strokeStyle = `rgba(120, 80, 255, ${0.04 + e * 0.12})`;
        ctx2d.lineWidth = 1;
        const lines = 42;
        const mid = h * 0.48;
        for (let i = 0; i < lines; i++) {
          const p = i / lines;
          const phase = t * (0.9 + p * 0.4) + p * 6.28;
          const ampY = (0.04 + e * 0.22 + p * 0.06) * h;
          ctx2d.beginPath();
          for (let x = -20; x <= w + 20; x += 3) {
            const nx = x * 0.004;
            const y =
              mid +
              Math.sin(nx * 2.2 + phase) * ampY * 0.35 +
              Math.sin(nx * 5 + phase * 1.3 + i) * ampY * 0.18 +
              (p - 0.5) * h * 0.15;
            if (x === -20) ctx2d.moveTo(x, y);
            else ctx2d.lineTo(x, y);
          }
          ctx2d.strokeStyle = `rgba(255, 255, 255, ${0.03 + e * 0.1 + p * 0.04})`;
          ctx2d.stroke();
        }
        ctx2d.restore();

        /* Second pass: magenta / amber accent moiré */
        ctx2d.save();
        ctx2d.translate(shift, -shift * 0.5);
        ctx2d.globalAlpha = 0.12 + e * 0.35;
        for (let i = 0; i < 18; i++) {
          const p = i / 18;
          ctx2d.beginPath();
          const ampY = (0.05 + e * 0.35) * h;
          const phase = t * 1.2 + i * 0.4;
          for (let x = -20; x <= w + 20; x += 4) {
            const y =
              mid +
              Math.sin(x * 0.012 + phase) * ampY * (0.2 + p * 0.5) +
              Math.cos(x * 0.006 + t + p) * ampY * 0.12;
            if (x === -20) ctx2d.moveTo(x, y);
            else ctx2d.lineTo(x, y);
          }
          ctx2d.strokeStyle =
            i % 2 === 0
              ? `rgba(236, 72, 153, ${0.15 + e * 0.2})`
              : `rgba(251, 191, 36, ${0.1 + e * 0.15})`;
          ctx2d.lineWidth = 0.8;
          ctx2d.stroke();
        }
        ctx2d.restore();

        raf = requestAnimationFrame(tick);
      };

      raf = requestAnimationFrame(tick);
      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
      };
    }, [systemState, sessionLive]);

    const orbScale = 1 + displayEnergy * 0.38;

    return (
      <div
        ref={wrapRef}
        className="relative h-full min-h-[280px] w-full flex-1 overflow-hidden bg-[#060606] lg:min-h-0"
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 block h-full w-full"
          aria-hidden
        />

        {/* Fluid gradient layer — organic “shimmer” tied to energy */}
        <div
          className="pointer-events-none absolute left-1/2 top-[42%] h-[min(85%,520px)] w-[min(100%,680px)] -translate-x-1/2 -translate-y-1/2 rounded-[50%] opacity-90 mix-blend-screen blur-3xl transition-transform duration-300 ease-out"
          style={{
            background:
              "radial-gradient(ellipse at 30% 40%, rgba(251, 146, 60, 0.45), transparent 55%), radial-gradient(ellipse at 70% 55%, rgba(168, 85, 247, 0.5), transparent 50%), radial-gradient(ellipse at 50% 80%, rgba(34, 211, 238, 0.25), transparent 45%)",
            transform: `translate(-50%, -50%) scale(${orbScale})`,
          }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/70 to-transparent"
          aria-hidden
        />
      </div>
    );
  }
);
