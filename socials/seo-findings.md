# SEO findings: by-line.xyz

Checked on 2026-11-09 with five skills from `coreyhaines31/marketingskills`: seo-audit, ai-seo, site-architecture, programmatic-seo and schema. The only sources were this repo, the live site (`curl` against www, the bare domain and testnet) and a rendered copy of the page in a local browser. No third-party tools were used: no Search Console, PageSpeed, Ahrefs or `npx is-agentic`. Keyword volumes and current AI citations were not measured.

**What the live site doesn't have yet:** today's local changes aren't deployed. These are the NEAR title and description, the Open Graph and X card tags, and `/og.png`, which returns 404 on www right now. Deploying fixes those items. Everything below is still open after that deploy, unless it's marked otherwise.

## Status (2026-11-09, after applying the fixes)

Applied locally; **not deployed or committed yet**, so the live site still shows the "before" state below.

| Done | Items |
| --- | --- |
| ✓ | T1 static page in `#root` (hidden once the terminal boots) · T2 `robots.txt` with an explicit AI-crawler policy · T3 `sitemap.xml` (built) · T4/T5 canonical tags, testnet `X-Robots-Tag: noindex` · T7 `<h1>` (static page and terminal tagline) · T8 codes and the leaderboard nav are real links |
| ✓ | O1 title "Byline · On-chain identity for AI agents on NEAR" · O2 description cut to 162 chars · O3 social preview · O5 key phrases in crawlable text · O6 GitHub and verified-contract links (static page, status bar, docs) |
| ✓ | A1 static HTML + `text/markdown` on `/` returns `/llms.txt` · A2 repo, contract and skill links in `llms.txt`/`llms-full.txt` · A3 robots policy · A4 `llms.txt` is now an index, the manual moved to `/llms-full.txt` · A5 definition block on `/`, `/docs`, `llms.txt` · A6 facts re-checked while writing `/docs` |
| ✓ | S1 path URLs `/agents/<code>` and `/leaderboard` (hash links still work) · S2 footer/status bar links · P1 prerendered agent pages, `noindex` until an agent has a credited action · P2 `/docs` with the explainer sections · Schema: JSON-LD on `/`, `/docs`, `/leaderboard`, `/agents/<code>`; `logo.png` added |
| — | **Needs you:** T6 redirect hop (Vercel domain settings: point `by-line.xyz` straight at `https://www`) · A7 publishing `@by-line/sdk` and the MCP server to npm (outward-facing, needs your npm account) · deploy, then validate in Google's Rich Results Test and validator.schema.org |
| — | **Not done:** T9 bundle split (needs a refactor of how commands load the SDK; the static page covers the first paint meanwhile) · A8 off-site presence and the monthly AI-citation check (not code) |
| ! | **Unverified until deploy:** the `routes` entry in `vercel.json` (markdown negotiation). Current Vercel docs allow `routes` next to `rewrites`/`headers`/`cleanUrls`, but no `vercel build` was run. If a deploy rejects it, delete the `routes` block; nothing else depends on it. |

## Summary

Byline's main audience reads it through machines: search crawlers, AI assistants, and coding agents that fetch `llms.txt`. The site makes that hard.

1. **The HTML is empty.** The server sends a 1.1 KB page with an empty `<div id="root">`. All text is drawn by a 535 KB script. Google renders JavaScript, but most AI crawlers and agents don't, so they see only the title and meta description. (High)
2. **The site has no robots.txt and no sitemap.xml.** Both return 404. (High)
3. **testnet.by-line.xyz serves a byte-identical copy of the homepage,** with no canonical tag and no noindex. Search engines may split signals between the two hosts or pick the wrong one. (High)
4. **The only indexable URL is `/`.** Agent records, the leaderboard and verify all live behind `#hash` links, which search engines treat as the same page. (Medium)
5. **`llms.txt` never links to the GitHub repo.** It tells agents to use `/absolute/path/to/byline/packages/mcp/dist/index.js` and says the SDK is "built from the Byline repo", but gives no URL for cloning it. An agent that reads it can't finish the setup. (High for agent adoption; one-line fix)

**Quick wins** (each under an hour): add robots.txt and a sitemap, put a canonical tag on www, send `noindex` from the testnet host, add the repo link to `llms.txt`, put static text and JSON-LD in `index.html`, and deploy the meta changes that are ready locally.

## Technical SEO (seo-audit)

| # | Issue | Impact | Evidence | Fix |
| --- | --- | --- | --- | --- |
| T1 | The body content needs JavaScript | High | `curl https://www.by-line.xyz/` returns 1,134 bytes with an empty `#root`; the JS bundle is 535 KB (166 KB gzipped) | Put a static, readable version of `about` in `index.html` inside `#root`: an `<h1>`, a two-paragraph definition, links to `/llms.txt`, GitHub and the leaderboard. React replaces it when the app mounts, so the terminal works as before. A build-time prerender is the bigger version of this fix. |
| T2 | No robots.txt | High | `/robots.txt` returns 404 on www and on testnet | Add `apps/web/public/robots.txt`: allow everything, point to the sitemap, and name the AI crawlers explicitly (see A3) |
| T3 | No XML sitemap | Medium | `/sitemap.xml` returns 404 | Add `public/sitemap.xml` listing `https://www.by-line.xyz/` and `/llms.txt`, plus agent pages if P1 ships |
| T4 | Testnet duplicates mainnet | High | Both hosts return the same 1,134-byte HTML, with no canonical tag | Add `<link rel="canonical" href="https://www.by-line.xyz/">`. Also send the header `X-Robots-Tag: noindex` from testnet.by-line.xyz with a host-matched `headers` rule in `vercel.json`. The testnet site stays usable but won't compete in search. |
| T5 | No canonical tag on any host | Medium | No `link[rel=canonical]` in the rendered DOM | Included in T4 |
| T6 | Two redirect hops from `http://by-line.xyz` | Low | `http://by-line.xyz` → `https://by-line.xyz` → `https://www.by-line.xyz` (two 308s) | Optional: redirect straight to `https://www` in the Vercel domain settings |
| T7 | No `<h1>` | Medium | The rendered DOM has 0 `h1`/`h2`/`h3`; the tagline is a `<b>` | Make "Every agent action, credited." an `<h1>`, styled exactly as now. Do the same in the static fallback from T1. |
| T8 | Internal navigation uses buttons, not links | Medium | 13 `<button>` elements and 4 `<a href>` (`/`, `/llms.txt` twice, testnet). Crawlers don't follow buttons. | Once real URLs exist (S1), make the nav items and codes `<a href>` links that the terminal intercepts on click |
| T9 | Large first-load script | Low–Medium | 166 KB gzipped of JS before any text shows. The wallet library is already lazy-loaded. | Measure LCP with Lighthouse locally. Look at splitting near-kit and the SDK out of the first chunk. T1 also fixes the text arriving late. |
| ✓ | HTTPS, HSTS, real 404s, `lang="en"`, viewport | — | `strict-transport-security: max-age=63072000`; unknown paths return real 404s, not a soft-404 SPA fallback | Keep as is |

## On-page (seo-audit)

| # | Item | Live now | Ready locally | Note |
| --- | --- | --- | --- | --- |
| O1 | Title | `Byline · Every agent action, credited` (37 chars, no topic keywords) | `Byline · Every agent action, credited on NEAR` (45 chars) | Closer to search phrasing: `Byline: on-chain identity for AI agents on NEAR` (47). Keep the tagline in the H1 instead. Your call. |
| O2 | Meta description | 133 chars, NEAR named once | 234 chars, which Google truncates at about 155–160 | Shorten to about 155, for example: "Byline gives AI agents an on-chain identity on NEAR. Every swap, payment and transaction is credited, building a public track record: a credit history for agents." |
| O3 | Social preview | None | `og:*`, `twitter:card`, `/og.png` 1200×630 | Ready; needs a deploy |
| O4 | Image alt text | No `<img>` elements (the logo is an inline SVG with `aria-hidden`) | — | Fine |
| O5 | Keyword focus | The page never says "AI agent identity", "agent reputation" or "trust score" in crawlable text | `about` now says "trust score" and "credit history", but only after JavaScript runs | Use these phrases in the static fallback from T1. Don't stuff them. |
| O6 | Trust signals (E-E-A-T) | No visible link to the source code, the verified contract, or a contact | — | Add GitHub, the `byline.near` NearBlocks link with "source verified", and a contact (an X handle) to the static fallback and the status bar. The verified build is the strongest trust signal you have. |

## AI search and agent readiness (ai-seo)

| # | Finding | Impact | Fix |
| --- | --- | --- | --- |
| A1 | Agents and AI crawlers can't read the page (see T1) | High | T1. Optional extra: when a request has `Accept: text/markdown`, serve `llms.txt`-style markdown at `/` (with `Vary: Accept`), so agents that ask for markdown get it |
| A2 | `llms.txt` has no repo URL | High | Add `https://github.com/alitiknazoglu/byline` to the summary, to §7 (MCP: clone, `npm ci`, then the path) and §8 (SDK), and to "Links". Also link the verified contract on NearBlocks. |
| A3 | No AI-crawler policy | Medium | GPTBot and ClaudeBot get 200 today, so nothing blocks them. Write the policy down in robots.txt anyway: allow search crawlers (`OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`) and the user-fetch agents. Decide training crawlers (`GPTBot`, `ClaudeBot`, `Google-Extended`) on purpose; allowing them helps future models know Byline. |
| A4 | `llms.txt` is a 25 KB manual, not an index | Low–Medium | The llmstxt.org convention is a short index. Keep the full manual, move it to `/llms-full.txt` (404 today), and make `/llms.txt` a short summary with links. Or leave it as is and add `/llms-full.txt` as a copy. Either way, update the `<link rel="alternate">`. |
| A5 | No "what is" answer block anywhere crawlable | Medium | Add a 40–60 word definition at the top of the static fallback and `llms.txt`. For example: "Byline is an on-chain identity for AI agents on NEAR. A registry contract gives each agent a code and its own account; every swap, payment and transaction carrying that code is credited to the agent, building a public track record that works like a credit history." |
| A6 | Facts drift between surfaces | Low | Keep one list of facts and check it in the README, `llms.txt`, `about`, the npm descriptions and the MCP README: 20 sponsored agents, 0.03 NEAR seed, 40 bps default fee, nine MCP tools, Node ≥ 22. Today they agree. Re-check after each change. |
| A7 | Coding-agent default path | Medium | When a developer asks Claude Code or Cursor to "give my agent an identity on NEAR", the agent should find a one-step setup. That needs `npx` or `npm i @by-line/sdk` published, the MCP server runnable with `npx`, and the repo's `skill/SKILL.md` linked from `llms.txt`. Publishing the packages is the biggest single lever here. |
| A8 | No presence outside the site | Medium (later) | AI assistants recommend what other sources say. Plan a NEAR forum post, an entry in the NEAR ecosystem directory, an X thread linking the verified contract, and a README badge. Not urgent before submission. |

Run one check by hand after deploying (no tools needed). Ask ChatGPT, Claude and Perplexity each question three times and note whether by-line.xyz is cited:
- "what is Byline on NEAR"
- "how do I give my AI agent an identity on NEAR"
- "agent reputation NEAR"

## Site architecture (site-architecture)

**Today:** one URL (`/`) holds the whole product. Views are `#hash` deep links (`#show/<code>`, `#top`, `#quote`, `#verify/<tx>`). Testnet is a full duplicate on a subdomain.

**Proposed** (small, keeps the terminal as the homepage):

```
www.by-line.xyz/                  terminal + static fallback (H1, definition, links)
├── /agents/<code>                one page per byline (prerendered from the snapshot); terminal opens with `show <code>`
├── /leaderboard                  prerendered `top`; links to every /agents/<code>
├── /docs                         how it works: three channels, onboarding paths, verify (human version of llms.txt)
├── /llms.txt  /llms-full.txt     agent index + full manual
├── /robots.txt  /sitemap.xml
└── /og.png
testnet.by-line.xyz/*             same app, sent with X-Robots-Tag: noindex
```

| Page | URL | Nav | Priority |
| --- | --- | --- | --- |
| Home | `/` | brand | High |
| Leaderboard | `/leaderboard` | header: leaderboard | High |
| Agent record | `/agents/<code>` | from leaderboard and codes | Medium (grows with agents) |
| Docs | `/docs` | header: register / mcp → docs sections | Medium |
| llms.txt | `/llms.txt` | header | High (agents) |

- **S1:** move deep links from hash to paths (`/agents/<code>` instead of `/#show/<code>`). Add a Vercel rewrite so those paths serve the app, and keep reading the old hash links so existing links still work.
- **S2:** make the status bar a footer with plain links: GitHub, contract (NearBlocks, verified), llms.txt, testnet, X.
- No breadcrumbs needed at this depth.

## Programmatic pages (programmatic-seo)

- **P1, agent profiles (the "Profiles" playbook), `/agents/<code>`.** This is the one programmatic set that fits. The data is Byline's own (registry plus indexer), it grows with every agent, and no one else has it.
  - **Each page has:** title, code, owner, accounts, credited swaps, payments, transactions and counterparties, first-seen date, latest activity with explorer links, and a "verify on NearBlocks" link.
  - **Indexing:** today there is 1 mainnet agent with no activity yet, so these pages would be thin. Build the template, but set `noindex` until an agent has at least one credited on-chain action. Sample-room agents are never indexed. Testnet profiles are covered by the testnet noindex.
  - **Page title:** `<title or code> · AI agent on NEAR · Byline`. Description: "<code> is an AI agent on NEAR with N credited swaps, M payments and K transactions. Every action verified on-chain."
- **P2, glossary pages: skip programmatic generation.** There are too few terms to template. Write 3–5 explainers by hand instead, as sections of `/docs`: what an agent byline is, NEAR Intents referral fees, NEP-413 gasless onboarding, verifying agent activity, agent trust scores.
- **P3, integrations: skip for now.** "Byline + Claude Code / Cursor / any MCP client" can be one `/docs/mcp` section until there's demand.
- **Don't build:** comparison or "best agent identity" pages. There isn't enough third-party consensus yet, and the repo's no-comparison rule rules them out anyway.

## Structured data (schema)

**Today:** no JSON-LD (0 `script[type="application/ld+json"]` in the rendered DOM).

**Add this statically to `index.html`** so crawlers that don't run JavaScript see it. It describes only what's on the page. There are no ratings or reviews, so don't add any.

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://www.by-line.xyz/#website",
      "name": "Byline",
      "url": "https://www.by-line.xyz/",
      "description": "On-chain identity and track record for AI agents on NEAR."
    },
    {
      "@type": "Organization",
      "@id": "https://www.by-line.xyz/#org",
      "name": "Byline",
      "url": "https://www.by-line.xyz/",
      "logo": "https://www.by-line.xyz/logo.png",
      "sameAs": ["https://github.com/alitiknazoglu/byline"]
    },
    {
      "@type": "SoftwareApplication",
      "name": "Byline",
      "applicationCategory": "DeveloperApplication",
      "operatingSystem": "Any (Node.js 22+ for the SDK and MCP server)",
      "url": "https://www.by-line.xyz/",
      "description": "Gives an AI agent an identity on NEAR: a registry code and its own account. Every swap, payment and transaction is credited to the agent and its builder.",
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
      "publisher": { "@id": "https://www.by-line.xyz/#org" }
    },
    {
      "@type": "SoftwareSourceCode",
      "name": "Byline",
      "codeRepository": "https://github.com/alitiknazoglu/byline",
      "programmingLanguage": ["TypeScript", "Rust"],
      "license": "https://opensource.org/licenses/MIT"
    }
  ]
}
```

- `logo.png` doesn't exist on the site yet. Copy `socials/logo.png` to `apps/web/public/logo.png`.
- Add `sameAs` entries for X and other profiles once they exist.
- **Not recommended:** `FAQPage` and `HowTo`. Google no longer shows rich results for either. Add them only if `/docs` has a visible FAQ, and then only as plain description.
- **For P1 later:** each agent page can carry a `ProfilePage` with the agent as `mainEntity` (a `SoftwareApplication`, or `Thing` with `identifier` = code), plus a `BreadcrumbList` (Leaderboard → code).
- **Validate** with validator.schema.org and Google's Rich Results Test after deploying. Those are external tools, so they weren't used here.

## Action plan

1. **Before submission (small, no design change):**
   - Deploy the local meta and OG changes.
   - Add robots.txt and the sitemap (T2, T3).
   - Add the canonical tag and the testnet noindex (T4).
   - Add the repo link to `llms.txt` (A2).
   - Add the JSON-LD and `logo.png` (schema).
   - Add a static fallback with an `<h1>`, the definition and trust links in `#root` (T1, T7, O6, A5).
   - Shorten the meta description (O2).
2. **High impact, after submission:**
   - Move to path URLs with `/agents/<code>` and `/leaderboard` (S1, P1).
   - Add `/docs` (P2).
   - Split `llms.txt` and `llms-full.txt` (A4).
   - Publish the SDK and MCP packages on npm (A7).
3. **Ongoing:**
   - Run the monthly by-hand AI-citation check (A-section).
   - Keep facts consistent across surfaces (A6).
   - Build presence outside the site (A8).
   - Index agent pages only once they have real activity.
