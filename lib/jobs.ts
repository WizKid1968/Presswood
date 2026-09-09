// Worker loop: claims queued presses, runs the engine, streams logs to the DB.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { db, type PressRow } from "./db";
import { finished } from "./email";

const BIN = process.env.PW_ENGINE ?? "/mnt/usb/go/bin/cli-printing-press";
const WORK = "/mnt/usb/presswood-dev/work"; // ponytail: flat workdir; per-run dirs when parallelism lands
export const PHASES = ["Resolve", "Sniff", "Compose", "Final check", "Pack"] as const;

let running = false;

export function startWorker() {
  if (running) return; running = true;
  void tick();
}

async function tick() {
  for (;;) {
    try { await workOne(); } catch (e) { console.error("[worker]", e); }
    await sleep(process.env.NODE_ENV === "production" ? 10_000 : 3_000);
  }
}

function claim(): PressRow | undefined {
  return db.prepare("UPDATE presses SET status='running', phase='Resolve', updated_at=strftime('%s','now')*1000 " +
    "WHERE id=(SELECT id FROM presses WHERE status='queued' ORDER BY created_at LIMIT 1) RETURNING *").get() as PressRow | undefined;
}

function envFor() {
  // Engine needs Go on PATH for go test/vet inside generated trees.
  // ponytail: crawler JSON.stringify's 270MB+ HARs; default heap OOMs.
  return { ...process.env, PATH: `/mnt/usb/go/bin:${process.env.HOME}/go/bin:/usr/local/go/bin:${process.env.PATH}`, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=8192`.trim() };
}

async function workOne() {
  const job = claim();
  if (!job) return;
  console.log(`[worker] press ${job.id} (${job.kind})`);
  const dir = `${WORK}/${job.id}`;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });

  try {
    const name = (job.label.replace(/\W+/g, "-").toLowerCase() || "api") + "-pp-cli";
    // ponytail: unique workdir per press — colliding names ("api" with no label)
    // were renaming each other (api-pp-cli-5, "could not rename" warnings).
    const libDir = `${process.env.HOME}/printing-press/library/${name}`;
    const workName = `${name}-${job.id.slice(0, 6)}`;
    const engine = (args: string[]) => [BIN, ...args];
    let specPath = "";

    if (job.kind === "url") {
      // ponytail: URL presses crawl via the multi-pass har-to-cli crawler.
      // Known hosts match a curated config in crawler/targets/; unknown hosts
      // get a shallow auto-config (homepage only) — curated configs yield deeper.
      const CRAWL = "/mnt/usb/presswood-dev/crawler";
      const host = new URL(job.payload).hostname;
      const slug = host.replace(/^www\./, "").replace(/\W+/g, "-").toLowerCase();
      const fsMod = await import("node:fs");
      const known = fsMod.existsSync(`/mnt/usb/presswood-dev/crawler/targets/${slug}.json`);
      const target = known ? slug
        : await import("node:child_process").then(cp =>
            cp.execSync(`node /mnt/usb/presswood-dev/crawler/make-config.js ${host}`).toString().trim());
      // ponytail: unknown hosts run learn mode — press #1 discovers pages + writes
      // the map; press #2 of the same host follows it and runs deep. Curated
      // targets skip --learn (their maps are hand-tuned, learn step won't touch them).
      const crawlArgs = ["node", "/mnt/usb/presswood-dev/crawler/crawler.js",
        "--target", target, "--depth", "medium", "--outputDir", `${dir}/har`];
      if (!known) crawlArgs.push("--learn");
      await run(job, crawlArgs, "Crawl");
      await run(job, ["bash", "-c",
        `cd ${dir}/har && python3 -c "
import json, glob, os
entries = []
for f in sorted(__import__('os').listdir('.')):
    if f.startswith('pass-') and f.endswith('.har') and os.path.getsize(f) > 0:
        try: entries.extend(json.load(open(f))['log']['entries'])
        except Exception: pass
json.dump({'log': {'version': '1.2', 'creator': {'name': 'presswood-merge', 'version': '1'}, 'entries': entries}}, open('merged.har', 'w'))
print(len(entries), 'entries merged')"` ], "Sniff");
      // ponytail: URL presses get the same primary-host filter HAR presses get
      // (Sep 9, owner-approved) — without it the sniffer crowns the analytics host
      // (optable.co out-counted statmuse on JSON calls) and the spec wraps junk.
      // Pre-sniff HAR stage: no stored analysis exists yet, so this filters HARs;
      // post-sniff evidence work happens in spec-polish from the engine's store.
      const harForSniff = await filterHarToPrimary(`${dir}/har/merged.har`, `${dir}/har/filtered.har`, job.id) ?? `${dir}/har/merged.har`;
      await run(job, engine(["browser-sniff", "--har", harForSniff, "--min-samples", "2",
        "--output", `${dir}/spec.yaml`, "--name", name]), "Sniff");
      // generalize hardcoded ticker paths → {ticker} params (engine pre-step)
      await run(job, ["bash", "-c",
        `python3 /mnt/usb/presswood-dev/crawler/generalize-tickers.py ${dir}/spec.yaml ${dir}/spec-gen.yaml 2>/dev/null; [ -f ${dir}/spec-gen.yaml ] || cp ${dir}/spec.yaml ${dir}/spec-gen.yaml; exit 0`], "Sniff");
      // ponytail: spec polish (Sep 9, owner-approved) — drop endpoints with no
      // positive data evidence (2xx + JSON in the engine's traffic analysis),
      // tag infra-shaped survivors into x-pp-latent, and flip cookie auth to
      // none ONLY when no 401/403 exists anywhere AND every probeable kept
      // endpoint passes anonymous. Sniffed specs only; hand specs untouched.
      try {
        const { polishSpecFile } = await import("./spec-polish");
        await polishSpecFile(`${dir}/spec-gen.yaml`, job.id, (line) => log(job.id, line + "\n"), `${dir}/spec-traffic-analysis.json`);
      } catch (e: any) {
        log(job.id, `[spec-polish] failed (press continues with unpolished spec): ${e?.message ?? e}\n`);
      }
      specPath = `${dir}/spec-gen.yaml`;
    } else if (job.kind === "har") {
      // ponytail: HARs recorded by humans collect third-party noise (analytics,
      // ad/image hosts) — and any CAPTCHA challenge served by those hosts makes
      // the engine's traffic analysis refuse the WHOLE press ("requires live
      // browser execution"), even when the primary site threw no challenge.
      // Filter to the dominant host's registrable domain before sniffing.
      const harForSniff = await filterHarToPrimary(job.payload, `${dir}/filtered.har`, job.id) ?? job.payload;
      await run(job, engine(["browser-sniff", "--har", harForSniff, "--min-samples", "2", "--output", `${dir}/spec.yaml`, "--name", name]), "Sniff");
      specPath = `${dir}/spec.yaml`;
    } else {
      specPath = job.payload;
    }
    // ponytail: Chrome strips cookies from every HAR export, so logged-in HARs
    // sniff as auth:none and the audit fails them live ("try a fuller HAR" can
    // never help). If the site bounces anonymous GETs to a login, flip the spec
    // to cookie auth — the CLI then takes the user's Cookie header via env var.
    // Upgrade path: per-site probe results cached in targets/ if knocks add up.
    const probe = job.kind === "har" ? await probeLoginWall(specPath) : { walled: false, names: [] as string[] };
    if (probe.walled) await flipToCookieAuth(specPath, job.id, probe.names);
    // One generate, gates deferred: upstream v4.31.1 emits _next*.go for Next.js
    // data-routes — underscore files the Go toolchain ignores → build fails.
    await run(job, engine(["generate", "--spec", specPath, "--name", workName, "--validate=false"]), "Compose");
    // Remedy: rename illegal files, then run the engine's own gates ourselves.
    const genDir = `${process.env.HOME}/printing-press/library/${workName}`;
    await run(job, ["bash", "-c",
      `cd ${genDir}/internal/cli 2>/dev/null && for f in _*.go; do [ -e "$f" ] && mv "$f" "x_\${f#_}"; done; exit 0`], "Compose");
    await run(job, ["bash", "-c",
      `cd ${genDir} && go mod tidy >/dev/null 2>&1; go vet ./... && go build ./... && go test ./... -count=1 2>&1 | tail -30`], "Final check");
    // Polish: scrub engine branding/authorship — shipped artifacts speak Presswood only.
    await run(job, ["bash", "-c",
      `cd ${genDir} && awk 'BEGIN{skip=0} /^## Sources and Inspiration/{skip=1;next} /^## /{skip=0} !skip' README.md > README.tmp && mv README.tmp README.md 2>/dev/null; ` +
      `grep -rlI -e "CLI Printing Press" -e "cli-printing-press" -e "printing-press" -e "mvanhorn" -e "steipete" -e "Peter Steinberger" -e "Trevin Chow" -e "discrawl" -e "gogcli" -e "tryramp" -e "Printing Press Library" . 2>/dev/null | while read -r f; do ` +
      `sed -i -e 's/npx -y @[a-z-]*printing-press-library install [a-z0-9-]*/# install: see presswood receipt page/g' -e 's/CLI Printing Press/Presswood/g' -e 's#https://github.com/[a-z]*/[a-z-]*printing-press[^ )"\`]*##g' -e 's#printing-press-library#presswood-shelf#g' -e 's#printing-press#presswood#g' -e 's/Printing Press Library/Presswood shelf/g' -e 's/PrintingPress/Presswood/g' -e 's/Printing Press/Presswood/g' -e 's/mvanhorn/presswood/g' -e 's/Peter Steinberger//g' -e 's/steipete//g' -e 's/Trevin Chow//g' -e 's/discrawl//g' -e 's/gogcli//g' "$f"; done; exit 0`], "Polish");

    // AUDIT: the adversary's checklist, run by the machine (Aug 31 lesson —
    // builder-tests passed a phantom-endpoint CLI; this gate fails presses).
    // Traceability (phantom endpoints fail the press), auth sanity (no fake
    // analytics-cookie logins), branding (zero tolerance), live-fire (public
    // specs must return real data from this box).
    await run(job, ["node", "/mnt/usb/presswood-dev/crawler/audit-press.js",
      "--spec", specPath, "--stage", genDir,
      ...(job.kind === "url" ? ["--har", `${dir}/har/merged.har`] : [])], "Audit");

    // Pack: compile binaries for the requested target (linux = host build,
    // mac = cross-compile darwin/arm64 — generated code is pure Go, modernc sqlite, no CGO),
    // then ship stage + docs as the artifact.
    mkdirSync("/mnt/usb/presswood-dev/artifacts", { recursive: true });
    const isMac = job.target === "mac";
    const goenv = isMac ? "GOOS=darwin GOARCH=arm64 CGO_ENABLED=0" : "";
    const artifact = `/mnt/usb/presswood-dev/artifacts/${job.id}${isMac ? "-mac" : ""}.tgz`;
    await run(job, [
      "bash", "-c",
      `cd ${genDir} && mkdir -p stage && env ${goenv} go build -o stage ./cmd/... && files="stage SKILL.md README.md LICENSE"; for f in spec.yaml; do [ -f "$f" ] && files="$files $f"; done; tar -czf ${artifact} $files && echo packed`,
    ], "Pack");
    db.prepare("UPDATE presses SET status='done', phase='Done', artifact=?, expires_at=strftime('%s','now')*1000+30*24*3600*1000 WHERE id=?")
      .run(artifact, job.id);
    void finished({ email: job.email, token: job.token, label: job.label || job.kind, ok: true }).catch(e => console.error("[email]", e));
  } catch (e) {
    // Surface the engine's own last words, not just our wrapper's exit note.
    let tail = "";
    try {
      const r = db.prepare("SELECT log FROM presses WHERE id=?").get(job.id) as { log: string } | undefined;
      tail = (r?.log ?? "").split("\n").filter(Boolean).slice(-4).join("\n").slice(0, 400);
    } catch { /* log read is best-effort */ }
    const msg = `${e instanceof Error ? e.message : String(e)}${tail ? `\n\nengine said:\n${tail}` : ""}`;
    db.prepare("UPDATE presses SET status='failed', error=? WHERE id=?").run(msg.slice(0, 900), job.id);
    void finished({ email: job.email, token: job.token, label: job.label || job.kind, ok: false, error: msg }).catch(e => console.error("[email]", e));
  }
}

function log(id: string, line: string) {
  db.prepare("UPDATE presses SET log=log||?, updated_at=strftime('%s','now')*1000 WHERE id=?")
    .run(line.endsWith("\n") || !line ? line + "\n" : line + "\n", id);
}

function setPhase(id: string, p: string) {
  db.prepare("UPDATE presses SET phase=? WHERE id=?").run(p, id);
}

function run(job: PressRow, cmd: string[], phase: string): Promise<void> {
  setPhase(job.id, phase);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { env: envFor(), cwd: `${WORK}/${job.id}` });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`press exceeded ${PW_CEIL_MS / 60000}min ceiling`));
    }, PW_CEIL_MS);
    child.stdout.on("data", d => log(job.id, d.toString()));
    child.stderr.on("data", d => log(job.id, d.toString()));
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${cmd[0]} exited ${code}`));
    });
  });
}
const PW_CEIL_MS = Number(process.env.PW_CEIL_MIN ?? 30) * 60_000;

// ponytail: keep only entries from the primary host's registrable domain.
// Sep 9 fix (owner-approved, sports-reference postmortem): primary = the host that
// served the PAGES the user browsed (HTML documents), NOT the noisiest host. The old
// "dominant = most requests" rule let cdn.ssref.net (131 image/js requests) outrank
// www.sports-reference.com (47 requests but ALL 21 Stathead JSON API calls) and the
// filter gutted a good logged-in capture. Rank: HTML docs first (analytics hosts and
// CDNs never serve pages), JSON responses second (tie-break), raw requests last.
// Falls back to the original HAR if filtering is a no-op or would gut the capture.
function filterHarToPrimary(src: string, dst: string, jobId: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const { readFileSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
      const har = JSON.parse(readFileSync(src, "utf8"));
      const es: { request: { url: string }; response?: { content?: { mimeType?: string } } }[] = har.log?.entries ?? [];
      if (!es.length) return resolve(null);
      const stats = new Map<string, { html: number; json: number; req: number }>();
      for (const e of es) {
        try {
          const h = new URL(e.request.url).hostname;
          const st = stats.get(h) ?? { html: 0, json: 0, req: 0 };
          st.req++;
          const mt = e.response?.content?.mimeType ?? "";
          if (/^text\/html/i.test(mt)) st.html++;
          else if (/json/i.test(mt)) st.json++;
          stats.set(h, st);
        } catch { /* skip junk */ }
      }
      const primary = [...stats.entries()].sort((a, b) =>
        (b[1].html - a[1].html) || (b[1].json - a[1].json) || (b[1].req - a[1].req))[0][0];
      const reg = primary.split(".").slice(-2).join(".");
      const keep = es.filter(e => {
        try { const h = new URL(e.request.url).hostname; return h === primary || h === reg || h.endsWith("." + reg); }
        catch { return false; }
      });
      if (keep.length < 10 || keep.length >= es.length) return resolve(null);
      har.log.entries = keep;
      writeFileSync(dst, JSON.stringify(har));
      log(jobId, `[har-filter] primary host ${primary}: kept ${keep.length}/${es.length} entries, dropped ${es.length - keep.length} third-party/noise (incl. any CAPTCHAs served by other hosts)\n`);
      resolve(dst);
    } catch { resolve(null); }
  });
}

// ponytail: anonymous probe of the spec's own base_url. 302/303 to a login URL
// = this site needs a session; 200/3xx-to-content = public, leave auth alone.
// Harvests Set-Cookie names from the bounce AND the login page itself — that's
// where the server reveals its real session-cookie name (e.g. JSESSIONID),
// which the generated CLI's `auth login --chrome` then keys on.
function probeLoginWall(specPath: string): Promise<{ walled: boolean; names: string[] }> {
  return new Promise((resolve) => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const m = readFileSync(specPath, "utf8").match(/^base_url:\s*(\S+)\s*$/m);
    let u: URL;
    try { u = new URL((m?.[1] ?? "") + "/"); } catch { return resolve({ walled: false, names: [] }); }
    const names = new Set<string>();
    const finish = (walled: boolean) => resolve({ walled, names: [...names] });
    const mod = u.protocol === "https:" ? require("node:https") : require("node:http");
    const req = mod.get(u, { headers: { "user-agent": "Mozilla/5.0 (compatible; Presswood/1)" }, timeout: 15000 }, (res: import("node:http").IncomingMessage) => {
      for (const h of res.headers["set-cookie"] ?? []) names.add(h.split("=")[0].trim());
      const loc = String(res.headers.location ?? "");
      if (res.statusCode === 302 || res.statusCode === 303) {
        if (!/login|signin|sign-in|auth|session/i.test(loc)) { res.resume(); return finish(false); }
        res.resume();
        let u2: URL;
        try { u2 = new URL(loc, u); } catch { return finish(true); }
        const mod2 = u2.protocol === "https:" ? require("node:https") : require("node:http");
        const req2 = mod2.get(u2, { headers: { "user-agent": "Mozilla/5.0 (compatible; Presswood/1)" }, timeout: 15000 }, (res2: import("node:http").IncomingMessage) => {
          for (const h of res2.headers["set-cookie"] ?? []) names.add(h.split("=")[0].trim());
          res2.resume();
          finish(true);
        });
        req2.on("timeout", () => { req2.destroy(); finish(true); });
        req2.on("error", () => finish(true));
        return;
      }
      res.resume();
      finish(false);
    });
    req.on("timeout", () => { req.destroy(); finish(false); });
    req.on("error", () => finish(false));
  });
}

// ponytail: same edit I made by hand for carpart-pro (proven artifact), now automatic.
// Cookie names come from the site's own Set-Cookie (probeLoginWall); `session` is
// only a last-ditch fallback — the generated CLI requires ALL listed names before
// it will auto-accept a Chrome profile, so a wrong name breaks `auth login --chrome`.
function flipToCookieAuth(specPath: string, jobId: string, names: string[]) {
  const { readFileSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const yaml = readFileSync(specPath, "utf8");
  if (/^auth:\n[ \t]+type:\s*cookie/m.test(yaml)) return; // already auth'd
  const envName = (yaml.match(/^name:\s*(\S+)/m)?.[1] ?? "CLI").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") + "_COOKIES";
  const cookieList = names.length ? names : ["session"];
  const flipped = yaml.replace(
    /^auth:\n((?:[ \t]+.*\n?)*)/m,
    `auth:\n    type: cookie\n    header: Cookie\n    format: ""\n    env_vars:\n        - ${envName}\n    in: cookie\n    cookies:\n${cookieList.map(n => `        - ${n}`).join("\n")}\n`
  );
  writeFileSync(specPath, flipped);
  log(jobId, `[auth-fix] site requires login; spec flipped to cookie auth (env ${envName}, cookies: ${cookieList.join(", ")})\n`);
}
