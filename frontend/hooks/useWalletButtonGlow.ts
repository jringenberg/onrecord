'use client';

import { type CSSProperties, type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/** All tunable values for the glow physics engine. */
export const CONFIG = {
  /** Safety fallback max distance (px) if viewport math fails; normal path uses dynamic viewport reach. */
  proximityFallbackMaxDistance: 4500,
  /** Distance (px) where near-field ramp starts becoming obvious. */
  proximityNearDistance: 360,
  /** Distance (px) where ramp becomes aggressively exponential-feeling. */
  proximityHotDistance: 108,
  /** Relative intensity (0..1) at proximityNearDistance before cap scaling. */
  proximityNearLevel: 0.18,
  /** Relative intensity (0..1) at proximityHotDistance before cap scaling. */
  proximityHotLevel: 0.72,
  /** Exponential steepness for the final hot-zone ramp (higher = sharper near button). */
  proximityHotExponent: 4,
  /** Intensity [0–1] at closest approach in PROXIMATE; ~1/3 of hover so it stays subtle. Linear ramp from 0 (far) to this (at button). */
  proximityCapIntensity: 1 / 3,
  /** Multiplier applied when a wallet extension is detected; capped at proximityCapIntensity. */
  chainAwareResponseMultiplier: 1.4,
  /** Duration (ms) for hover transition bookkeeping (visual glow is disabled on hover). */
  hoverBloomMs: 200,
  /** Fade duration (ms) when glow exits on hover enter and returns on hover leave. */
  hoverFadeMs: 300,
  /** Duration (ms) of the blast wave CSS animation on hover. */
  hoverBlastDurationMs: 600,
  /** Period of the sinusoidal pending pulse (ms). */
  pendingPulsePeriodMs: 2000,
  /** ±amplitude of pending pulse as a fraction of maxOpacity. */
  pendingPulseAmplitude: 0.08,
  /** Max glow opacity [0–1]. */
  maxOpacity: 1.0,
  /** Max glow blur (px). Huge radius so the glow can wash across most of the page. */
  maxBlur: 260,
  /** Max glow spread (px). */
  maxSpread: 8,
  /** Blur (px) for the connected-state glow. Kept at 0 so connected state has no glow. */
  connectedBlur: 0,
  /** Spread (px) for the connected-state glow. Kept at 0 so connected state has no glow. */
  connectedSpread: 0,
  /** Opacity for the connected-state glow. Kept at 0 so connected state has no glow. */
  connectedOpacity: 0,
  /** Duration (ms) to collapse glow when wallet connects. */
  collapseMs: 400,
  /** Duration (ms) to decay glow when connection is dismissed/rejected. */
  decayMs: 800,
  /** Glow colour as space-separated RGB for CSS color level-4 `rgb(R G B / A)` syntax. */
  glowRgb: '0 47 167', // Klein Blue
} as const;

type GlowStateName = 'idle' | 'proximate' | 'hover' | 'pending' | 'connected' | 'rejected';

interface GlowValues {
  blur: number;
  spread: number;
  opacity: number;
}

export interface UseWalletButtonGlowParams {
  buttonRef: RefObject<HTMLButtonElement | null>;
  walletDetected: boolean;
  connectionState: 'disconnected' | 'pending' | 'connected';
}

export interface UseWalletButtonGlowReturn {
  cssVars: CSSProperties & Record<`--${string}`, string>;
  dataState: GlowStateName;
  handleMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => void;
  handleMouseLeave: () => void;
  handleClick: () => void;
  handleReject: () => void;
}

export function useWalletButtonGlow({
  buttonRef,
  walletDetected,
  connectionState,
}: UseWalletButtonGlowParams): UseWalletButtonGlowReturn {
  const [dataState, setDataState] = useState<GlowStateName>('idle');

  // All animation state lives in refs — no re-renders for physics values.
  const stateRef = useRef<GlowStateName>('idle');
  const glowRef = useRef<GlowValues>({ blur: 0, spread: 0, opacity: 0 });
  const pulseRafRef = useRef<number>(0);
  const tweenRafRef = useRef<number>(0);
  const hoverReturnTweeningRef = useRef(false);
  const blastPosRef = useRef<{ x: number; y: number }>({ x: 50, y: 50 });
  const lastMouseRef = useRef<{ x: number; y: number } | null>(null);
  const walletDetectedRef = useRef(walletDetected);

  // Keep walletDetectedRef fresh without re-registering the mousemove listener.
  useEffect(() => {
    walletDetectedRef.current = walletDetected;
  }, [walletDetected]);

  // Sync stateRef and React state together so closures and React both see the truth.
  const transitionTo = useCallback((newState: GlowStateName) => {
    stateRef.current = newState;
    setDataState(newState);
  }, []);

  // Hot path: write CSS custom props directly to the DOM element — zero React overhead.
  const writeGlow = useCallback(
    (updates: Partial<GlowValues>) => {
      const el = buttonRef.current;
      if (!el) return;
      if (updates.blur !== undefined) {
        glowRef.current.blur = updates.blur;
        el.style.setProperty('--glow-blur', `${updates.blur}px`);
      }
      if (updates.spread !== undefined) {
        glowRef.current.spread = updates.spread;
        el.style.setProperty('--glow-spread', `${updates.spread}px`);
      }
      if (updates.opacity !== undefined) {
        glowRef.current.opacity = updates.opacity;
        el.style.setProperty('--glow-opacity', String(updates.opacity));
      }
    },
    [buttonRef],
  );

  const cancelPulse = useCallback(() => {
    if (pulseRafRef.current) {
      cancelAnimationFrame(pulseRafRef.current);
      pulseRafRef.current = 0;
    }
  }, []);

  const cancelTween = useCallback(() => {
    if (tweenRafRef.current) {
      cancelAnimationFrame(tweenRafRef.current);
      tweenRafRef.current = 0;
    }
    hoverReturnTweeningRef.current = false;
  }, []);

  const getProximityGlow = useCallback(
    (rect: DOMRect, mx: number, my: number): GlowValues => {
      const dx = Math.max(rect.left - mx, 0, mx - rect.right);
      const dy = Math.max(rect.top - my, 0, my - rect.bottom);
      const dist = Math.sqrt(dx * dx + dy * dy);

      const viewportCorners = [
        { x: 0, y: 0 },
        { x: window.innerWidth, y: 0 },
        { x: 0, y: window.innerHeight },
        { x: window.innerWidth, y: window.innerHeight },
      ];
      const maxReachableDist = viewportCorners.reduce((max, corner) => {
        const cdx = Math.max(rect.left - corner.x, 0, corner.x - rect.right);
        const cdy = Math.max(rect.top - corner.y, 0, corner.y - rect.bottom);
        const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
        return Math.max(max, cdist);
      }, 0);
      const normMaxDist = maxReachableDist > 0 ? maxReachableDist : CONFIG.proximityFallbackMaxDistance;

      const near = Math.min(CONFIG.proximityNearDistance, normMaxDist - 1);
      const hot = Math.min(CONFIG.proximityHotDistance, near - 1);
      let raw: number;

      if (dist >= near) {
        const t = (normMaxDist - dist) / Math.max(normMaxDist - near, 1);
        raw = Math.max(0, Math.min(1, t)) * CONFIG.proximityNearLevel;
      } else if (dist >= hot) {
        const t = (near - dist) / Math.max(near - hot, 1);
        raw =
          CONFIG.proximityNearLevel +
          (CONFIG.proximityHotLevel - CONFIG.proximityNearLevel) * (t * t);
      } else {
        const t = Math.max(0, Math.min(1, (hot - dist) / Math.max(hot, 1)));
        const expT =
          (Math.exp(CONFIG.proximityHotExponent * t) - 1) /
          (Math.exp(CONFIG.proximityHotExponent) - 1);
        raw = CONFIG.proximityHotLevel + (1 - CONFIG.proximityHotLevel) * expT;
      }

      let intensity =
        (walletDetectedRef.current ? raw * CONFIG.chainAwareResponseMultiplier : raw) *
        CONFIG.proximityCapIntensity;
      intensity = Math.min(intensity, CONFIG.proximityCapIntensity);

      return {
        blur: intensity * CONFIG.maxBlur,
        spread: intensity * CONFIG.maxSpread,
        opacity: intensity,
      };
    },
    [],
  );

  // Window-level mousemove — attached once on mount, reads only from refs.
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const el = buttonRef.current;
      if (!el) return;
      const state = stateRef.current;

      const rect = el.getBoundingClientRect();
      const mx = e.clientX;
      const my = e.clientY;
      lastMouseRef.current = { x: mx, y: my };

      // State machine owns glow in these states — skip proximity writes.
      if (state === 'hover' || state === 'pending' || state === 'connected') return;
      if (hoverReturnTweeningRef.current) return;

      const nextGlow = getProximityGlow(rect, mx, my);
      if (state === 'idle' && nextGlow.opacity > 0) transitionTo('proximate');
      if (state === 'proximate' && nextGlow.opacity <= 0) transitionTo('idle');
      writeGlow(nextGlow);
    };

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, [buttonRef, getProximityGlow, transitionTo, writeGlow]);

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      const state = stateRef.current;
      if (state !== 'proximate' && state !== 'idle') return;
      transitionTo('hover');

      // Record blast origin — cursor position relative to button in percent.
      const el = buttonRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const bx = ((e.clientX - rect.left) / rect.width) * 100;
        const by = ((e.clientY - rect.top) / rect.height) * 100;
        blastPosRef.current = { x: bx, y: by };
        el.style.setProperty('--blast-x', `${bx}%`);
        el.style.setProperty('--blast-y', `${by}%`);
        el.style.setProperty('--blast-duration', `${CONFIG.hoverBlastDurationMs}ms`);
      }

      // Hover entry: fade glow out instead of snapping off.
      cancelTween();
      const start = { ...glowRef.current };
      const t0 = performance.now();

      const fadeOut = (now: number) => {
        if (stateRef.current !== 'hover') return;
        const t = Math.min((now - t0) / CONFIG.hoverFadeMs, 1);
        writeGlow({
          blur: start.blur * (1 - t),
          spread: start.spread * (1 - t),
          opacity: start.opacity * (1 - t),
        });
        if (t < 1) tweenRafRef.current = requestAnimationFrame(fadeOut);
        else tweenRafRef.current = 0;
      };
      tweenRafRef.current = requestAnimationFrame(fadeOut);
    },
    [buttonRef, cancelTween, transitionTo, writeGlow],
  );

  const handleMouseLeave = useCallback(() => {
    if (stateRef.current === 'hover') {
      cancelTween();
      transitionTo('proximate');
      const el = buttonRef.current;
      const lastMouse = lastMouseRef.current;
      if (!el || !lastMouse) return;

      // Hover exit: fade glow back in to current proximity target.
      const rect = el.getBoundingClientRect();
      const target = getProximityGlow(rect, lastMouse.x, lastMouse.y);
      const start = { ...glowRef.current };
      const t0 = performance.now();
      hoverReturnTweeningRef.current = true;

      const fadeIn = (now: number) => {
        if (stateRef.current !== 'proximate') {
          hoverReturnTweeningRef.current = false;
          return;
        }
        const t = Math.min((now - t0) / CONFIG.hoverFadeMs, 1);
        writeGlow({
          blur: start.blur + (target.blur - start.blur) * t,
          spread: start.spread + (target.spread - start.spread) * t,
          opacity: start.opacity + (target.opacity - start.opacity) * t,
        });
        if (t < 1) {
          tweenRafRef.current = requestAnimationFrame(fadeIn);
        } else {
          hoverReturnTweeningRef.current = false;
          tweenRafRef.current = 0;
          if (target.opacity <= 0) transitionTo('idle');
        }
      };
      tweenRafRef.current = requestAnimationFrame(fadeIn);
    }
  }, [buttonRef, cancelTween, getProximityGlow, transitionTo, writeGlow]);

  const handleClick = useCallback(() => {
    const state = stateRef.current;
    if (state !== 'hover' && state !== 'proximate') return;

    cancelPulse();
    cancelTween();
    transitionTo('pending');

    // Snap to full glow (handles the case where click fired from PROXIMATE).
    writeGlow({
      blur: CONFIG.maxBlur,
      spread: CONFIG.maxSpread,
      opacity: CONFIG.maxOpacity,
    });

    // Sinusoidal opacity pulse for pending state.
    const pulse = () => {
      const t = Date.now() / (CONFIG.pendingPulsePeriodMs / (2 * Math.PI));
      const intensity = 1.0 + Math.sin(t) * CONFIG.pendingPulseAmplitude;
      writeGlow({ opacity: intensity * CONFIG.maxOpacity });
      pulseRafRef.current = requestAnimationFrame(pulse);
    };
    pulseRafRef.current = requestAnimationFrame(pulse);
  }, [cancelPulse, cancelTween, transitionTo, writeGlow]);

  const handleReject = useCallback(() => {
    cancelPulse();
    cancelTween();
    transitionTo('rejected');

    const startOpacity = glowRef.current.opacity;
    const t0 = performance.now();

    const decay = (now: number) => {
      const t = Math.min((now - t0) / CONFIG.decayMs, 1);
      writeGlow({ opacity: startOpacity * (1 - t) });
      if (t < 1) {
        tweenRafRef.current = requestAnimationFrame(decay);
      } else {
        writeGlow({ blur: 0, spread: 0, opacity: 0 });
        transitionTo('idle');
        tweenRafRef.current = 0;
      }
    };
    tweenRafRef.current = requestAnimationFrame(decay);
  }, [cancelPulse, cancelTween, transitionTo, writeGlow]);

  // React to external connectionState changes (Privy auth resolution).
  useEffect(() => {
    if (connectionState === 'connected' && stateRef.current !== 'connected') {
      cancelPulse();
      cancelTween();

      if (stateRef.current === 'pending') {
        // Animate the connection success: collapse to crisp outline.
        const start = { ...glowRef.current };
        const t0 = performance.now();

        const collapse = (now: number) => {
          const t = Math.min((now - t0) / CONFIG.collapseMs, 1);
          writeGlow({
            blur: start.blur + (CONFIG.connectedBlur - start.blur) * t,
            spread: start.spread + (CONFIG.connectedSpread - start.spread) * t,
            opacity: start.opacity + (CONFIG.connectedOpacity - start.opacity) * t,
          });
          if (t < 1) {
            tweenRafRef.current = requestAnimationFrame(collapse);
          } else {
            transitionTo('connected');
            tweenRafRef.current = 0;
          }
        };
        tweenRafRef.current = requestAnimationFrame(collapse);
      } else {
        // Auto-connect (page reload with existing session): skip animation.
        writeGlow({
          blur: CONFIG.connectedBlur,
          spread: CONFIG.connectedSpread,
          opacity: CONFIG.connectedOpacity,
        });
        transitionTo('connected');
      }
    } else if (connectionState === 'disconnected' && stateRef.current === 'connected') {
      cancelPulse();
      cancelTween();
      writeGlow({ blur: 0, spread: 0, opacity: 0 });
      transitionTo('idle');
    }
  }, [connectionState, cancelPulse, cancelTween, transitionTo, writeGlow]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      cancelPulse();
      cancelTween();
    };
  }, [cancelPulse, cancelTween]);

  // cssVars: SSR/initial-render snapshot. Live updates go via direct DOM writes above.
  const cssVars: CSSProperties & Record<`--${string}`, string> = {
    '--glow-blur': `${glowRef.current.blur}px`,
    '--glow-spread': `${glowRef.current.spread}px`,
    '--glow-opacity': String(glowRef.current.opacity),
    '--glow-x': '0px',
    '--glow-y': '0px',
    '--blast-x': `${blastPosRef.current.x}%`,
    '--blast-y': `${blastPosRef.current.y}%`,
    '--blast-duration': `${CONFIG.hoverBlastDurationMs}ms`,
    '--glow-rgb': CONFIG.glowRgb,
  };

  return { cssVars, dataState, handleMouseEnter, handleMouseLeave, handleClick, handleReject };
}
