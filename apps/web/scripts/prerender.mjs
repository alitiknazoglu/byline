/**
 * After `vite build`: static pages for crawlers and agents that don't run JavaScript.
 *
 *   dist/leaderboard.html          the mainnet leaderboard   → www.by-line.xyz/leaderboard   (vercel.json cleanUrls)
 *   dist/agents/<code>.html        one page per mainnet byline → www.by-line.xyz/agents/<code>
 *   dist/sitemap.xml               the pages worth indexing
 *
 * Each page is dist/index.html with its own <head> (title, description, canonical, JSON-LD) and its own static
 * content in #root. In a browser the terminal boots over it as usual (/agents/<code> runs `show <code>`).
 *
 * Only mainnet is prerendered: www is the canonical site and testnet.by-line.xyz is noindex. An agent page is
 * indexed once the agent has at least one credited action on-chain; until then it's `noindex` and left out of
 * the sitemap, so search engines don't see empty profiles. Sample data never gets a page.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const SITE = "https://www.by-line.xyz";
const REPO = "https://github.com/alitiknazoglu/byline";

const template = readFileSync(join(DIST, "index.html"), "utf8");
for (const marker of ["<!--seo", "<!--/seo-->", "<!--fallback-->", "<!--/fallback-->"]) {
  if (!template.includes(marker)) throw new Error(`prerender: dist/index.html lost the ${marker} marker (did Vite strip comments?)`);
}

let snap;
try {
  snap = JSON.parse(readFileSync(join(DIST, "data", "mainnet.json"), "utf8"));
} catch {
  snap = null;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const n = (x) => Number(x ?? 0).toLocaleString("en-US");
const usd = (x) => Number(x ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const activity = (r) => (r.swaps ?? 0) + (r.memo_transfers ?? 0) + (r.txs ?? 0);
const indexable = (r) => !r.sample && activity(r) > 0;

function head({ title, description, path, robots, jsonld }) {
  const url = `${SITE}${path}`;
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    robots ? `<meta name="robots" content="${robots}" />` : "",
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Byline" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:image" content="${SITE}/og.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${SITE}/og.png" />`,
    `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>`,
  ]
    .filter(Boolean)
    .join("\n    ");
}

function page(opts, body) {
  const out = template
    .replace(/<!--seo[\s\S]*?<!--\/seo-->/, `<!--seo-->\n    ${head(opts)}\n    <!--/seo-->`)
    .replace(/<!--fallback-->[\s\S]*?<!--\/fallback-->/, `<!--fallback-->\n      <main class="static">\n${body}\n      </main>\n    <!--/fallback-->`);
  const file = join(DIST, `${opts.path.slice(1)}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, out);
  return file;
}

const brand = `        <p class="static-brand"><a href="/">byline</a> · <a href="/leaderboard">leaderboard</a> · <a href="/docs">docs</a> · <a href="/llms.txt">llms.txt</a></p>`;
const foot = `        <p class="static-note">by-line.xyz is a working terminal and needs JavaScript. Source: <a href="${REPO}">GitHub</a> · registry <a href="https://nearblocks.io/address/byline.near?tab=contract">byline.near</a> (source verified).</p>`;
const breadcrumb = (items) => ({
  "@type": "BreadcrumbList",
  itemListElement: items.map(([name, path], i) => ({ "@type": "ListItem", position: i + 1, name, item: `${SITE}${path}` })),
});

const rows = (snap?.rows ?? []).filter((r) => !r.sample);
const written = [];

// ---------- /leaderboard ----------
{
  const sorted = [...rows].sort((a, b) => b.volume_usd - a.volume_usd || activity(b) - activity(a));
  const table = sorted.length
    ? [
        `        <table>`,
        `          <thead><tr><th>#</th><th>code</th><th>agent</th><th>swaps</th><th>volume</th><th>builder fees</th><th>txs</th><th>payments</th><th>counterparties</th></tr></thead>`,
        `          <tbody>`,
        ...sorted.map(
          (r, i) =>
            `            <tr><td>${i + 1}</td><td><a href="/agents/${esc(r.name)}">${esc(r.name)}</a></td><td>${esc(r.title ?? "")}</td><td>${n(r.swaps)}</td><td>${usd(r.volume_usd)}</td><td>${usd(r.builder_fees_usd)}</td><td>${n(r.txs)}</td><td>${n(r.memo_transfers)}</td><td>${n(r.counterparties)}</td></tr>`,
        ),
        `          </tbody>`,
        `        </table>`,
      ].join("\n")
    : `        <p>No bylines on mainnet yet.</p>`;
  written.push(
    page(
      {
        title: "Leaderboard: AI agents credited on NEAR · Byline",
        description: `Every AI agent with a byline on NEAR mainnet, ranked by credited swaps, volume, builder fees, transactions and payments. ${rows.length} agent${rows.length === 1 ? "" : "s"} so far.`,
        path: "/leaderboard",
        jsonld: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "CollectionPage",
              name: "Byline leaderboard",
              url: `${SITE}/leaderboard`,
              dateModified: snap?.generatedAt,
              isPartOf: { "@id": `${SITE}/#website` },
              mainEntity: {
                "@type": "ItemList",
                numberOfItems: sorted.length,
                itemListElement: sorted.map((r, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}/agents/${r.name}`, name: r.title ?? r.name })),
              },
            },
            breadcrumb([["Byline", "/"], ["Leaderboard", "/leaderboard"]]),
          ],
        },
      },
      [
        brand,
        `        <h1>Leaderboard: AI agents credited on NEAR</h1>`,
        `        <p>Every agent registered in <a href="https://nearblocks.io/address/byline.near?tab=contract">byline.near</a>, with what it has been credited for on NEAR mainnet: swaps through NEAR Intents (refunds and failures are never counted as success), token payments carrying its memo, and transactions its own account signed.${snap ? ` Indexed ${day(snap.generatedAt)}.` : ""}</p>`,
        table,
        foot,
      ].join("\n"),
    ),
  );
}

// ---------- /agents/<code> ----------
for (const r of rows) {
  const d = snap.details[r.name];
  const name = r.title ?? r.name;
  const events = d?.events ?? [];
  const firstSeen = events.length ? Math.min(...events.map((e) => e.block_ts_ms)) : null;
  const latest = [
    ...(d?.txs ?? []).map((t) => ({ ms: t.block_ts_ms, what: `signed ${t.methods || "a transaction"} → ${t.receiver}`, hash: t.hash })),
    ...(d?.memoTransfers ?? []).map((m) => ({ ms: m.block_ts_ms, what: `payment ${m.sender} → ${m.receiver} (memo ${m.memo})`, hash: m.tx_hash })),
  ]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10);
  const counted = activity(r);
  const description = counted
    ? `${r.name} is an AI agent on NEAR with ${n(r.swaps)} credited swaps, ${n(r.memo_transfers)} payments and ${n(r.txs)} transactions. Every action verified on-chain.`
    : `${r.name} is an AI agent registered on NEAR with Byline. No credited actions yet; its record starts with its first swap, payment or transaction.`;
  written.push(
    page(
      {
        title: `${name === r.name ? r.name : `${name} (${r.name})`} · AI agent on NEAR · Byline`,
        description,
        path: `/agents/${r.name}`,
        robots: indexable(r) ? undefined : "noindex",
        jsonld: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "ProfilePage",
              url: `${SITE}/agents/${r.name}`,
              dateModified: snap.generatedAt,
              isPartOf: { "@id": `${SITE}/#website` },
              mainEntity: {
                "@type": "SoftwareApplication",
                name,
                identifier: r.name,
                applicationCategory: "AI agent",
                url: `${SITE}/agents/${r.name}`,
                sameAs: r.account ? [`https://nearblocks.io/address/${r.account}`] : undefined,
              },
            },
            breadcrumb([["Byline", "/"], ["Leaderboard", "/leaderboard"], [r.name, `/agents/${r.name}`]]),
          ],
        },
      },
      [
        brand,
        `        <h1>${esc(name)} <code>${esc(r.name)}</code></h1>`,
        `        <p>${esc(description)}</p>`,
        `        <table>`,
        `          <tbody>`,
        `            <tr><th>code</th><td><code>${esc(r.name)}</code></td></tr>`,
        r.account ? `            <tr><th>account</th><td><a href="https://nearblocks.io/address/${esc(r.account)}">${esc(r.account)}</a> (created by the registry)</td></tr>` : "",
        `            <tr><th>owner</th><td>${esc(r.owner)}</td></tr>`,
        r.payout ? `            <tr><th>fee payout</th><td>${esc(r.payout)} · ${r.fee_bps} bps requested</td></tr>` : "",
        firstSeen ? `            <tr><th>registered</th><td>${day(firstSeen)}</td></tr>` : "",
        `            <tr><th>swaps</th><td>${n(r.swaps)}${r.swaps_failed ? ` (+${n(r.swaps_failed)} refunded or failed)` : ""} · ${usd(r.volume_usd)} volume · ${usd(r.builder_fees_usd)} builder fees</td></tr>`,
        `            <tr><th>payments</th><td>${n(r.memo_transfers)} carrying <code>byline:${esc(r.name)}</code>, from ${n(r.memo_payers)} payer${r.memo_payers === 1 ? "" : "s"}</td></tr>`,
        `            <tr><th>transactions</th><td>${n(r.txs)} signed · ${n(r.counterparties)} counterparties</td></tr>`,
        `          </tbody>`,
        `        </table>`,
        latest.length
          ? [
              `        <h2>Latest activity</h2>`,
              `        <ul>`,
              ...latest.map((a) => `          <li>${day(a.ms)}: ${esc(a.what)} · <a href="https://nearblocks.io/txns/${esc(a.hash)}">tx</a></li>`),
              `        </ul>`,
            ].join("\n")
          : "",
        `        <p>Check any of it yourself: in the terminal, <code>show ${esc(r.name)}</code> or <code>verify &lt;tx&gt;</code>; or read the registry directly (<code>get_byline {"code":"${esc(r.name)}"}</code> on byline.near).${snap ? ` Indexed ${day(snap.generatedAt)}.` : ""}</p>`,
        foot,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  );
}

// ---------- sitemap.xml ----------
const urls = [
  { loc: `${SITE}/` },
  { loc: `${SITE}/leaderboard`, lastmod: snap?.generatedAt },
  { loc: `${SITE}/docs` },
  ...rows.filter(indexable).map((r) => ({ loc: `${SITE}/agents/${r.name}`, lastmod: snap.generatedAt })),
];
writeFileSync(
  join(DIST, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ""}</url>`)
    .join("\n")}\n</urlset>\n`,
);

console.log(
  `prerender: ${written.length} pages (${rows.filter(indexable).length} agent pages indexable, ${rows.length - rows.filter(indexable).length} noindex), sitemap with ${urls.length} URLs`,
);
