/** The red close light's "clear" run: progress bars for each thing being cleared, then a fresh terminal. */
import { useEffect, useState } from "react";

export interface ClearStep {
  label: string;
  /** Shown once the step is done, e.g. "42 lines". */
  detail?: string;
}

const STEP_MS = 750;
const SETTLE_MS = 350;
const CELLS = 24;

/** True when the user asked for less motion: then the clear happens at once. */
export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Total run time for `n` steps, so the caller can line up the real clear with the animation. */
export const clearDuration = (n: number) => n * STEP_MS + SETTLE_MS;

export function Clearing({ prompt, command, steps }: { prompt: string; command: string; steps: ClearStep[] }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      setElapsed(now - start);
      if (now - start < clearDuration(steps.length)) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [steps.length]);

  const width = Math.max(...steps.map((s) => s.label.length));
  const done = elapsed >= steps.length * STEP_MS;

  return (
    <section className="entry clearing" aria-live="polite">
      <div className="ln cmdline">
        <span className="ps">{prompt} $</span> {command}
      </div>
      {steps.map((s, i) => {
        // Ease each bar so it starts quick and slows near the end, like a real upload.
        const t = Math.min(1, Math.max(0, (elapsed - i * STEP_MS) / STEP_MS));
        const pct = Math.round((1 - (1 - t) ** 2.2) * 100);
        const filled = Math.round((pct / 100) * CELLS);
        const state = pct >= 100 ? "done" : pct > 0 ? "busy" : "wait";
        return (
          <div key={s.label} className={`ln clr ${state}`}>
            <span className="mark">{state === "done" ? "✓" : state === "busy" ? "›" : " "}</span> {s.label.padEnd(width)}{"  "}
            <span className="bar-cells" aria-hidden>
              [{"█".repeat(filled)}
              <span className="t-dim">{"░".repeat(CELLS - filled)}</span>]
            </span>{" "}
            {String(pct).padStart(3)}%{state === "done" && s.detail ? <span className="t-dim">  {s.detail}</span> : null}
          </div>
        );
      })}
      <div className="ln t-dim">{done ? "cleared · starting a fresh session…" : "clearing caches…"}</div>
    </section>
  );
}
