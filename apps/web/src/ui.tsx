/** Output primitives for the terminal: everything a command prints is built from these. */
import type { ReactNode } from "react";
import { useTerm } from "./term-context";

export function Line({ children, tone }: { children?: ReactNode; tone?: "dim" | "ok" | "err" | "warn" | "code" }) {
  return <div className={`ln${tone ? ` t-${tone}` : ""}`}>{children ?? " "}</div>;
}

export const Gap = () => <div className="ln gap" aria-hidden />;

export function Ok({ children }: { children: ReactNode }) {
  return (
    <div className="ln t-ok">
      <span className="mark">✓</span> {children}
    </div>
  );
}

export function Err({ children }: { children: ReactNode }) {
  return (
    <div className="ln t-err" role="alert">
      <span className="mark">✗</span> {children}
    </div>
  );
}

export function Warn({ children }: { children: ReactNode }) {
  return (
    <div className="ln t-warn">
      <span className="mark">!</span> {children}
    </div>
  );
}

/** A section heading inside output, like `> payments (2)`. */
export function Head({ children, n }: { children: ReactNode; n?: number }) {
  return (
    <div className="ln head">
      <span>{children}</span>
      {n !== undefined && <span className="t-dim"> ({n})</span>}
    </div>
  );
}

/** Aligned key/value rows. */
export function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ?? <span className="t-dim">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface Col<R> {
  head: string;
  cell: (r: R) => ReactNode;
  right?: boolean;
}

/** A plain-text-looking table that stays a real <table> for screen readers. */
export function Table<R>({ cols, rows, empty }: { cols: Col<R>[]; rows: R[]; empty?: string }) {
  if (!rows.length) return <Line tone="dim">{empty ?? "(nothing yet)"}</Line>;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.head} className={c.right ? "r" : undefined}>
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c.head} className={c.right ? "r" : undefined}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Pretty JSON where the byline's own lines (referral, appFees) are marked in amber. */
export function Json({ value, mark = [] }: { value: unknown; mark?: string[] }) {
  const lines = JSON.stringify(value, null, 2).split("\n");
  let inside = false;
  let depth = 0;
  return (
    <pre className="json">
      {lines.map((text, i) => {
        const opens = mark.some((k) => text.includes(`"${k}":`));
        if (opens && /[[{]\s*$/.test(text)) {
          inside = true;
          depth = 0;
        }
        const hit = inside || opens;
        if (inside) {
          depth += (text.match(/[[{]/g) ?? []).length - (text.match(/[\]}]/g) ?? []).length;
          if (depth <= 0) inside = false;
        }
        return (
          <span key={i} className={`jl${hit ? " hit" : ""}`}>
            {text}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

export function Code({ children }: { children: string }) {
  return <pre className="snippet">{children}</pre>;
}

/** An external link (explorer, docs). */
export function Ext({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="ext">
      {children}
    </a>
  );
}

/**
 * A byline code that opens its record when clicked. A real link to /agents/<code>, so crawlers can follow it and
 * a middle-click opens the agent's page; a plain click runs `show <code>` in place.
 */
export function CodeRef({ code }: { code: string }) {
  const { run } = useTerm();
  return (
    <a
      className="cmdlink t-code"
      href={`/agents/${encodeURIComponent(code)}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        run(`show ${code}`);
      }}
      title={`show ${code}`}
    >
      {code}
    </a>
  );
}

/** A command the reader can click instead of typing. */
export function Cmd({ children }: { children: string }) {
  const { run } = useTerm();
  return (
    <button type="button" className="cmdlink" onClick={() => run(children)}>
      {children}
    </button>
  );
}

export type StepState = "wait" | "run" | "ok" | "skip" | "fail";

export interface Step {
  label: string;
  /** Where the check reads from, shown while it runs. */
  via: string;
  state: StepState;
  detail?: ReactNode;
}

const STEP_MARK: Record<Exclude<StepState, "run">, string> = { wait: "·", ok: "✓", skip: "–", fail: "✗" };

/** A checklist that fills in as each check runs: spinner while working, then ✓ / – / ✗ with what it found. */
export function Trace({ steps }: { steps: Step[] }) {
  const width = Math.max(...steps.map((s) => s.label.length));
  return (
    <div className="trace">
      {steps.map((s) => (
        <div key={s.label} className={`ln tr ${s.state}`}>
          <span className="mark">{s.state === "run" ? <span className="spin" aria-hidden /> : STEP_MARK[s.state]}</span> {s.label.padEnd(width)}
          {"  "}
          {s.state === "run" ? <span className="t-dim">{s.via}…</span> : s.state === "wait" ? <span className="t-dim">{s.via}</span> : s.detail}
        </div>
      ))}
    </div>
  );
}
