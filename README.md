# Presswood

Presswood turns any website with an API into a finished, self-contained command-line tool. You give it a URL, a HAR recording, or an API spec — it crawls the site, learns its API, generates a CLI around it, verifies the CLI actually works against the live site, and hands you a downloadable artifact with the compiled binary and docs inside.

Built with Next.js, running as a service on a Raspberry Pi.

## How it works

1. **Submit** — choose one of three press kinds:
   - **URL** — Presswood crawls the site itself (best for public sites).
   - **HAR upload** — you record your own logged-in browsing session and upload it (required for sites behind a login; the crawler can't authenticate).
   - **Spec** — bring your own OpenAPI spec, skip discovery entirely.
2. **Crawl & learn** — a headless-browser crawler records real traffic across the site's pages, discovers API endpoints, and infers parameter patterns.
3. **Build** — the captured API is turned into a CLI project and compiled with the Go-based printing-press engine.
4. **Audit** — every generated CLI is machine-audited before it ships (details below).
5. **Download** — a `.tgz` artifact with the compiled binary, README, and skill docs.

Progress is visible live: each press has a status page with a streaming phase log, so you watch the crawl, build, and audit happen in real time.

## Features

### Learn mode — "first press teaches the machine, second press is gold"
Unknown hosts get an automatic two-pass treatment: the first press runs a link-discovery pass and writes a learned crawl map for that site (API host, endpoint families templated to shared parameters, pages ranked by API volume, scroll strategies). The second press of that host follows the learned map and runs deep. Learned maps never overwrite hand-curated ones.

### Back-door knock
Many sites ship a public API their own pages never call — every WordPress site, for example. When a capture shows zero JSON traffic, Presswood automatically knocks on the standard doors (`/wp-json/`, `/api`, `/graphql`, `/openapi.json`, …) and records what answers. Sites that previously came back "no API found" become buildable. If nothing answers, you get an honest "no public API" verdict.

### Automatic crawl maps
Known complex sites have hand-curated crawl maps (which pages to visit, what to click, when to scroll). Unknown sites get a shallow auto-map instantly. This is why a second press of the same site is always much richer than the first.

### The Audit gate — nothing ships unverified
Every press passes a four-part machine audit between build and packaging:

1. **Traceability** — every endpoint in the generated spec must appear in that press's own captured traffic. Invented ("phantom") endpoints fail the press.
2. **Auth sanity** — a capture containing only analytics cookies with no 401/403 responses cannot ship a spec claiming authenticated cookie access.
3. **Branding zero-tolerance** — shipped artifacts are scrubbed of any upstream engine or author names.
4. **Live-fire** — specs with no auth must answer real HTTP 200 + JSON from the server before packaging. A spec that merely *looks* right isn't enough; it has to work right now.

### Crash-safe captures
A press that fails mid-crawl often already captured everything. Captures are kept on disk per job, so a failed crawl can be re-run through the build pipeline offline in ~15 minutes instead of re-crawling for an hour.

### Hardened crawler
- Infinite streams (video embeds, websockets, event sources) are blocked up front — they used to block HAR finalization and hang browser shutdown for 90+ minutes.
- Browser shutdown now has a hard deadline with an escalating soft-close → SIGKILL fallback, so one bad page can never stall a press indefinitely.
- Per-press crawl ceilings abort runaway crawls.
- Large captures (hundreds of MB) are handled without memory blowups.
- Unique working directories per press prevent collisions between duplicate jobs.

### Engine fixes
The bundled printing-press engine carries local patches: generated Go module paths with underscores are renamed (upstream bug, unfixed upstream as of v4.31.1), and builds run through our own vet/test gate.

### Verified results
Generated CLIs are smoke-tested before delivery: `--version` exits 0, `--help` is clean, and live-fire results (real JSON from the target site) are included in the press report.

## Constraints worth knowing

- **Logged-in sites need a HAR upload.** The crawler browses as an anonymous visitor. Record a session in your browser's DevTools (Network tab → "Save all as HAR with content") and upload it. Note: a HAR contains your session cookies — only upload HARs from accounts you're comfortable with Presswood processing.
- **Deep presses take time.** A curated site with hundreds of pages takes roughly an hour to crawl and build. Unknown sites start shallow (minutes) and deepen on the second press.
- **Public beta email delivery** is currently limited to the owner's address until the sending domain is verified.

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/press` | POST | Submit a press (`kind=url\|har\|spec`, multipart) |
| `/api/presses` | GET | List recent presses |
| `/api/press/[token]/stream` | GET | Live phase/progress stream for a press |
| `/api/press/[token]/artifact` | GET | Download the finished artifact |

Submissions are rate-limited and protected by a Cloudflare Turnstile challenge (bypassed in development).

## Stack

- **App:** Next.js (App Router, TypeScript, Tailwind), production build under systemd
- **Crawler:** Node + Playwright, multi-pass with learned configs
- **Engine:** printing-press (Go) — HAR capture → API inference → CLI generation → compile
- **Storage:** SQLite (`node:sqlite`) for job state; per-job work dirs for captures and artifacts
