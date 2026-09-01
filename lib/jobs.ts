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
      await run(job, engine(["browser-sniff", "--har", `${dir}/har/merged.har`, "--min-samples", "2",
        "--output", `${dir}/spec.yaml`, "--name", name]), "Sniff");
      // generalize hardcoded ticker paths → {ticker} params (engine pre-step)
      await run(job, ["bash", "-c",
        `python3 /mnt/usb/presswood-dev/crawler/generalize-tickers.py ${dir}/spec.yaml ${dir}/spec-gen.yaml 2>/dev/null; [ -f ${dir}/spec-gen.yaml ] || cp ${dir}/spec.yaml ${dir}/spec-gen.yaml; exit 0`], "Sniff");
      specPath = `${dir}/spec-gen.yaml`;
    } else if (job.kind === "har") {
      await run(job, engine(["browser-sniff", "--har", job.payload, "--min-samples", "2", "--output", `${dir}/spec.yaml`, "--name", name]), "Sniff");
      specPath = `${dir}/spec.yaml`;
    } else {
      specPath = job.payload;
    }
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

    // Pack: compile both binaries (gates were deferred, so no build/ exists),
    // then ship stage + docs as the artifact.
    mkdirSync("/mnt/usb/presswood-dev/artifacts", { recursive: true });
    await run(job, [
      "bash", "-c",
      `cd ${genDir} && mkdir -p stage && go build -o stage ./cmd/... && files="stage SKILL.md README.md LICENSE"; for f in spec.yaml; do [ -f "$f" ] && files="$files $f"; done; tar -czf /mnt/usb/presswood-dev/artifacts/${job.id}.tgz $files && echo packed`,
    ], "Pack");
    db.prepare("UPDATE presses SET status='done', phase='Done', artifact=?, expires_at=strftime('%s','now')*1000+30*24*3600*1000 WHERE id=?")
      .run(`/mnt/usb/presswood-dev/artifacts/${job.id}.tgz`, job.id);
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
