/** The terminal: scrollback, an inline prompt, history, completion, and the boot sequence. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  COMMAND_NAMES,
  COMMANDS,
  DEMO_CODE,
  REGISTRY,
  parse,
} from "./commands";
import {
  Clearing,
  clearDuration,
  prefersReducedMotion,
  type ClearStep,
} from "./clearing";
import { ago, clearSnapshotCache, loadSnapshot, type Room } from "./data";
import { DEMO_TX, IS_MAINNET, NETWORK, OTHER_NETWORK, OTHER_SITE, REGISTRY as REGISTRY_ID, registryMissing, registryUp } from "./network";
import { TermContext } from "./term-context";
import { Err, Line } from "./ui";
import { useWallet } from "./wallet";

interface Entry {
  id: number;
  prompt?: string;
  command?: string;
  out?: ReactNode;
  pending?: string;
  /** Printed at startup: shown in grey so the live prompt below reads as the place to type. */
  boot?: boolean;
}

type Health = "checking" | "up" | "down";
const HEALTH_LABEL: Record<Health, string> = {
  checking: `checking ${REGISTRY_ID}…`,
  up: `operational: ${REGISTRY_ID} is answering`,
  down: `down: can't reach ${REGISTRY_ID} right now`,
};

interface RunOpts {
  record?: boolean;
  boot?: boolean;
}

/** Quick buttons that fill the prompt (with the amount selected) instead of running right away. */
const CHIP_DRAFTS: Record<string, { line: string; select: [number, number] }> = {
  swap: { line: "swap 0.4 NEAR USDC", select: [5, 8] },
};

/** The quick buttons under the prompt; disconnect appears before help while a wallet is connected. */
const suggestions = (connected: boolean) => [
  "quote",
  `show ${DEMO_CODE}`,
  ...(DEMO_TX ? [`verify ${DEMO_TX}`] : []),
  "pay",
  ...(IS_MAINNET ? ["swap"] : []),
  "register",
  "mcp",
  ...(connected ? ["disconnect"] : []),
  "help",
];
const HISTORY_KEY = "byline.history";

const BANNER = String.raw` _           _ _
| |__  _   _| (_)_ __   ___
| '_ \| | | | | | '_ \ / _ \
| |_) | |_| | | | | | |  __/
|_.__/ \__, |_|_|_| |_|\___|
       |___/`;

/** The mark: a prompt with a credit line under it. Same drawing as the favicon. */
function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#e6e6e6" />
      <path
        d="M8 11l5 5-5 5"
        fill="none"
        stroke="#1e1e1e"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="15" y="19.5" width="9" height="2.6" rx="1" fill="#1e1e1e" />
    </svg>
  );
}

/** The opening lines of every session: the banner and what this is. */
function Banner() {
  return (
    <>
      <pre className="banner" aria-label="byline">
        {BANNER}
      </pre>
      <Line>
        <h1 className="tagline">Every agent action, credited.</h1>{" "}
        <span className="t-dim">
          registry {REGISTRY} · agents read <a href="/llms.txt">/llms.txt</a>
        </span>
      </Line>
      <Line tone="dim">
        Identity and track record for AI agents, kept by the NEAR blockchain: the start of a credit history for agents.
      </Line>
    </>
  );
}

/** Commands a link may run on page load: they only read and display. */
const DEEP_LINK_SAFE = new Set(["show", "top", "quote", "verify", "help", "about", "mcp", "sponsor", "whoami", "use"]);

/**
 * May a link run this command on load? Read-only commands, plus `connect` (it only opens the wallet
 * picker) and a bare `register` (the guide). `register --wallet` and anything that moves money only
 * goes into the prompt, for the visitor to read and run.
 */
/**
 * A command from a link, rebuilt from its parsed parts with --yes removed, so the reader always sees the
 * preview first (a quoted "--yes" can't slip through a text replace).
 */
function prefillWithoutYes(line: string): string {
  const { name, args, flags } = parse(line);
  const q = (v: string) => (/\s/.test(v) ? `"${v.replace(/"/g, "")}"` : v);
  const parts = [name, ...args.map(q)];
  for (const [k, v] of Object.entries(flags)) {
    if (k === "yes") continue;
    parts.push(`--${k}`);
    if (v !== true) parts.push(q(v));
  }
  return parts.join(" ");
}

function deepLinkSafe(line: string): boolean {
  const [name, ...rest] = line.split(" ");
  if (DEEP_LINK_SAFE.has(name!)) return true;
  if (name === "connect") return rest.length === 0;
  if (name === "register") return rest.length === 0;
  return false;
}

/** The command a page path stands for: /agents/<code> → `show <code>`. The leaderboard already runs at boot. */
function pathCommand(pathname: string): string | null {
  const m = /^\/agents\/([0-9a-z]+)\/?$/.exec(pathname);
  return m ? `show ${m[1]!}` : null;
}

/** The command a link asks for: a page path (/agents/<code>) or the older hash links (#show/<code>). */
function deepLinkCommand(): string {
  let hash = "";
  try {
    hash = decodeURIComponent(window.location.hash.replace(/^#\/?/, ""));
  } catch {
    hash = ""; // a malformed escape (/#%) is ignored, not a blank page
  }
  return (pathCommand(window.location.pathname) ?? hash).replace(/\//g, " ").replace(/\s+/g, " ").trim();
}

const lastLogin = () =>
  `Last login: ${new Date().toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} on byline`;

function readHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function Terminal() {
  const wallet = useWallet();
  const [room, setRoom] = useState<Room>(NETWORK);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>(readHistory);
  const [cursor, setCursor] = useState<number | null>(null);
  const [indexedAt, setIndexedAt] = useState<string | null>(null);
  const nextId = useRef(1);
  const inputRef = useRef<HTMLInputElement>(null);
  /** A selection to apply once a chip's draft line is in the input (see CHIP_DRAFTS). */
  const pendingSelect = useRef<[number, number] | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const roomRef = useRef(room);
  roomRef.current = room;
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const booted = useRef(false);
  const [health, setHealth] = useState<Health>("checking");
  // The status dot: green while the registry answers over RPC, red when it doesn't. Checked every minute.
  useEffect(() => {
    let alive = true;
    const check = () => void registryUp().then((up) => alive && setHealth(up ? "up" : "down"));
    check();
    const timer = window.setInterval(check, 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  /** Follow new output to the bottom only once the visitor runs something; the opening screen stays at the top. */
  const follow = useRef(false);
  const [clearing, setClearing] = useState<{ steps: ClearStep[]; command: string } | null>(null);
  const clearingNow = useRef(false);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  /**
   * The red light and the `clear` command: clear the scrollback and caches with a short progress run,
   * then start a fresh session. Resolves once the fresh session is up, so queued commands wait for it.
   */
  function closeSession(command = "clear"): Promise<void> {
    if (clearingNow.current) return Promise.resolve();
    clearingNow.current = true;
    const lines = entriesRef.current.length;
    const snapshots = clearSnapshotCache();
    return new Promise((resolve) => {
      const fresh = () => {
        setEntries([]);
        setRoom(NETWORK);
        setInput("");
        setCursor(null);
        push({ out: <Banner /> });
        push({ out: <Line tone="dim">{lastLogin()}</Line> });
        setClearing(null);
        follow.current = false;
        clearingNow.current = false;
        void loadSnapshot(NETWORK).then((s) => s && setIndexedAt(s.generatedAt));
        requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
        resolve();
      };
      if (prefersReducedMotion()) return fresh();
      const steps: ClearStep[] = [
        { label: "scrollback", detail: `${lines} ${lines === 1 ? "entry" : "entries"}` },
        { label: "index snapshot cache", detail: `${snapshots} ${snapshots === 1 ? "snapshot" : "snapshots"}` },
        { label: "session", detail: `back to ${NETWORK}` },
      ];
      setClearing({ steps, command });
      window.setTimeout(fresh, clearDuration(steps.length));
    });
  }
  const closeRef = useRef(closeSession);
  closeRef.current = closeSession;

  const prompt = `byline@${room}`;
  const push = (e: Omit<Entry, "id">) => {
    const id = nextId.current++;
    setEntries((xs) => [...xs, { ...e, id }]);
    return id;
  };
  const patch = (id: number, p: Partial<Entry>) =>
    setEntries((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const execute = useCallback(async (line: string, opts: RunOpts = {}) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (opts.record !== false) {
      setHistory((h) => {
        const next = [...h.filter((x) => x !== trimmed), trimmed].slice(-50);
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        } catch {
          /* private mode: history just doesn't persist */
        }
        return next;
      });
    }
    const { name, args, flags } = parse(trimmed);
    if (name === "clear") {
      await closeRef.current(trimmed);
      return;
    }
    if (!opts.boot) follow.current = true;
    const id = push({
      prompt: `byline@${roomRef.current}`,
      command: trimmed,
      pending: "working…",
      boot: opts.boot,
    });
    const cmd = COMMANDS[name];
    if (!cmd) {
      const near = COMMAND_NAMES.filter((c) => c.startsWith(name.slice(0, 2)));
      patch(id, {
        pending: undefined,
        out: (
          <Err>
            command not found: {name}
            {near.length ? ` (did you mean ${near.join(", ")}?)` : ""} · try
            help
          </Err>
        ),
      });
      return;
    }
    setBusy(true);
    try {
      const out = await cmd.run({
        args,
        flags,
        room: roomRef.current,
        setRoom,
        wallet: walletRef.current,
        status: (text) => patch(id, { pending: text }),
        live: (node) => patch(id, { pending: undefined, out: node }),
        then: (next) => runRef.current(next),
      });
      patch(id, { pending: undefined, out });
    } catch (e) {
      const msg = registryMissing(e)
        ? `the ${NETWORK} registry (${REGISTRY_ID}) isn't deployed yet${IS_MAINNET ? `; try it on testnet: ${OTHER_SITE}` : ""}`
        : ((e as Error)?.message ?? String(e));
      patch(id, { pending: undefined, out: <Err>{msg}</Err> });
    } finally {
      setBusy(false);
    }
  }, []);

  const runRef = useRef<(line: string) => void>(() => {});
  /** Commands run one at a time, in order, like a real shell. */
  const run = useCallback(
    (line: string, opts?: RunOpts) => {
      queue.current = queue.current
        .then(() => execute(line, opts))
        .catch(() => {});
      inputRef.current?.focus({ preventScroll: true });
    },
    [execute],
  );
  runRef.current = run;

  // Boot: banner, what this is, the live leaderboard, then any deep-linked command:
  // a page path (/agents/<code>) or the older hash links (#show/<code>, #quote), which still work.
  useEffect(() => {
    if (booted.current) return; // React dev mode runs effects twice; boot once.
    booted.current = true;
    push({ out: <Banner /> });
    run("about", { record: false, boot: true });
    run("top", { record: false, boot: true });
    const deep = deepLinkCommand();
    if (deep && COMMAND_NAMES.includes(deep.split(" ")[0]!)) {
      // A link may only show things. Anything that signs, pays, downloads a key or changes the wallet is
      // typed into the prompt for the reader to run (without --yes), never run on load.
      if (deepLinkSafe(deep)) run(deep, { record: false });
      else setInput(prefillWithoutYes(deep));
      // The link has done its job: drop #mcp, #register… so the address stays clean and a reload doesn't re-run it.
      if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    void loadSnapshot(NETWORK).then((s) => s && setIndexedAt(s.generatedAt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (follow.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  // After a chip fills the prompt, select its amount so typing replaces it.
  useEffect(() => {
    const sel = pendingSelect.current;
    const el = inputRef.current;
    if (!sel || !el) return;
    pendingSelect.current = null;
    el.focus();
    el.setSelectionRange(sel[0], sel[1]);
  }, [input]);

  const completions = useMemo(() => {
    const [head, ...rest] = input.split(" ");
    if (!rest.length)
      return COMMAND_NAMES.filter(
        (c) => c.startsWith(head ?? "") && c !== head,
      );
    return [];
  }, [input]);

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      // Like a real shell: typing ahead while a command runs queues the next one.
      const line = input;
      setInput("");
      setCursor(null);
      run(line);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!history.length) return;
      const i = cursor === null ? history.length - 1 : Math.max(0, cursor - 1);
      setCursor(i);
      setInput(history[i] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (cursor === null) return;
      const i = cursor + 1;
      if (i >= history.length) {
        setCursor(null);
        setInput("");
      } else {
        setCursor(i);
        setInput(history[i] ?? "");
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (completions.length === 1) setInput(`${completions[0]} `);
      else if (completions.length > 1)
        push({ out: <Line tone="dim">{completions.join("   ")}</Line> });
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setEntries([]);
    } else if (e.key === "Escape") {
      setInput("");
    }
  }

  return (
    <TermContext.Provider value={{ run, room }}>
      <div className="term">
        <header className="bar">
          <button
            type="button"
            className="close"
            aria-label="Clear the terminal"
            title="Clear the terminal"
            onClick={() => void closeSession()}
            disabled={clearing !== null}
          />
          <a className="brand" href="/" aria-label="byline, home">
            <Logo />
            <span>byline</span>
          </a>
          <nav className="nav" aria-label="Byline">
            <a
              className="navlink"
              href="/leaderboard"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new tab: let the link open
                e.preventDefault();
                run("top");
              }}
            >
              leaderboard
            </a>
            <button
              type="button"
              className="navlink"
              onClick={() => run("register")}
            >
              register
            </button>
            <button type="button" className="navlink" onClick={() => run("mcp")}>
              mcp
            </button>
            <a className="navlink" href="/docs">
              docs
            </a>
            <a
              className="navlink"
              href="/llms.txt"
              target="_blank"
              rel="noreferrer"
              title="Instructions for AI agents"
            >
              llms.txt
            </a>
            <button
              type="button"
              className={`navlink wallet${wallet.accountId ? " on" : ""}`}
              onClick={() => run(wallet.accountId ? "whoami" : "connect")}
            >
              {wallet.accountId ?? (
                <>
                  connect<span className="hide-sm"> wallet</span>
                </>
              )}
            </button>
          </nav>
        </header>

        <main
          className="screen"
          onClick={() => {
            // On a phone a tap shouldn't pop the keyboard up while you're reading or scrolling.
            if (window.matchMedia("(pointer: coarse)").matches) return;
            if (!window.getSelection()?.toString())
              inputRef.current?.focus({ preventScroll: true });
          }}
        >
          <div
            className="scroll"
            role="log"
            aria-live="polite"
            aria-label="Terminal output"
          >
            {clearing ? (
              <Clearing prompt={prompt} command={clearing.command} steps={clearing.steps} />
            ) : (
              <>
                {entries.map((e) => (
                  <section
                    key={e.id}
                    className={e.boot ? "entry boot" : "entry"}
                  >
                    {e.command !== undefined && (
                      <div className="ln cmdline">
                        <span className="ps">{e.prompt} $</span> {e.command}
                      </div>
                    )}
                    {e.pending && (
                      <div className="ln t-dim pending">
                        <span className="spin" aria-hidden /> {e.pending}
                      </div>
                    )}
                    {e.out}
                  </section>
                ))}
                <div className="ln cmdline live">
                  <label htmlFor="cmd" className="ps">
                    {prompt} $
                  </label>
                  <input
                    id="cmd"
                    ref={inputRef}
                    value={input}
                    onChange={(e) => {
                      setInput(e.target.value);
                      setCursor(null);
                    }}
                    onKeyDown={onKey}
                    autoFocus
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    aria-describedby="hints"
                    placeholder={
                      busy ? "" : "type a command, or click one below"
                    }
                  />
                </div>
                <div
                  id="hints"
                  className="chips"
                  aria-label="Suggested commands"
                >
                  {(completions.length && input
                    ? completions
                    : suggestions(Boolean(wallet.accountId))
                  ).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="chip"
                      onClick={() => {
                        if (completions.length && input) return setInput(`${s} `);
                        const draft = CHIP_DRAFTS[s];
                        if (!draft) return run(s);
                        // Commands that move money open as an editable line instead of running: the amount is selected, so typing replaces it.
                        pendingSelect.current = draft.select;
                        setInput(draft.line);
                      }}
                    >
                      {s.length > 34 ? `${s.slice(0, 31)}…` : s}
                    </button>
                  ))}
                </div>
              </>
            )}
            {/* Breathing room: the prompt never sits on the bottom edge; a third of the screen stays empty below it. */}
            <div ref={endRef} className="tail" aria-hidden />
          </div>
        </main>

        <footer className="status">
          <span className="seg">
            <span
              className={`dot ${health}`}
              role="img"
              aria-label={HEALTH_LABEL[health]}
              title={HEALTH_LABEL[health]}
            />
            {room === "sample" ? "sample" : `NEAR ${room}`}
          </span>
          <a className="seg seg-link" href={OTHER_SITE} title={`Open Byline on ${OTHER_NETWORK}`}>
            {OTHER_NETWORK} ↗
          </a>
          <a
            className="seg seg-link"
            href={`${IS_MAINNET ? "https://nearblocks.io" : "https://testnet.nearblocks.io"}/address/${REGISTRY}?tab=contract`}
            target="_blank"
            rel="noreferrer"
            title={IS_MAINNET ? "The registry contract on NearBlocks (source verified)" : "The registry contract on NearBlocks"}
          >
            registry {REGISTRY}
            {IS_MAINNET ? " ✓ verified" : ""}
          </a>
          <a className="seg seg-link hide-sm" href="https://github.com/alitiknazoglu/byline" target="_blank" rel="noreferrer">
            github ↗
          </a>
          <span className="seg hide-sm">
            indexed {indexedAt ? ago(indexedAt) : "…"}
          </span>
          <span className="seg right">© 2026 byline</span>
        </footer>
      </div>
    </TermContext.Provider>
  );
}
