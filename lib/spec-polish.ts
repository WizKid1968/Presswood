// ponytail: spec polish — turn the sniffer's raw output into a spec that contains
// only endpoints with positive data evidence. Runs AFTER browser-sniff + generalize,
// BEFORE generate, on URL presses only (spec_source: sniffed guard keeps hand-written
// spec presses like carpart-journey untouched).
//
// Evidence standard (deliberate, owner-approved Sep 9):
//   KEEP   = engine traffic-analysis cluster shows >= 1 sample with 2xx status AND
//            a JSON content-type. JSON-only is the deliberate product bar for
//            auto-discovered specs: the engine can only build typed responses from
//            JSON. HTML 2xx = a page got recorded, not an API. Empty/x-unknown 2xx
//            (204 telemetry) carries no data to wrap.
//   REDIRECTS = cluster statuses are browser-final responses (the browser follows
//            redirects before recording), so judgment lands on the settled status.
//            A cluster with only 3xx never settled -> no data evidence -> dropped.
//   COMPOSITION = this bar stacks ON TOP of the engine's --min-samples filter
//            (which already ran inside sniff); it never re-adds thin endpoints.
//   INFRASTRUCTURE (evidence != utility): survivors whose path is infrastructure-
//            shaped (auth/session/config/token/health...) are moved to x-pp-latent
//            with full params — out of the generated command tree, preserved for
//            human promotion. Tagged, not dropped.
//   AUTH FLIP (per-endpoint bar): flip cookie -> none ONLY when (a) no 401/403
//            appears anywhere in the capture AND (b) every surviving kept endpoint
//            passes an anonymous probe (2xx + JSON). Freemium sites keep their auth.
//
// Data source: the engine's OWN spec-traffic-analysis.json (endpoint_clusters carry
// per-endpoint statuses/content_types/count) + spec-samples/. No HAR re-parsing.

import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";

export type TrafficCluster = {
  host?: string;
  method?: string;
  path?: string;
  count?: number;
  statuses?: number[];
  content_types?: string[];
  size_class?: string;
};

const is2xx = (s: number) => s >= 200 && s <= 299;
const isJsonCt = (ct: string) => /json/i.test(ct || "");

// ── pure: apply evidence bar + infra tagging to a parsed spec ──
// Returns { spec, dropped: string[], latent: string[], kept: string[] }.
export function polishSpecFromTraffic(spec: any, traffic: any): { spec: any; dropped: string[]; latent: string[]; kept: string[] } {
  const dropped: string[] = [];
  const latent: string[] = [];
  const kept: string[] = [];

  const clusters: TrafficCluster[] = traffic?.endpoint_clusters ?? [];
  // evidence key: "METHOD /path" -> does any sample prove data?
  const evidence = new Map<string, boolean>();
  for (const c of clusters) {
    if (!c?.method || !c?.path) continue;
    const key = `${String(c.method).toUpperCase()} ${c.path}`;
    const hasData = (c.statuses ?? []).some(is2xx) && (c.content_types ?? []).some(isJsonCt);
    evidence.set(key, hasData || (evidence.get(key) ?? false));
  }

  const resources = spec?.resources;
  if (!resources || typeof resources !== "object") return { spec, dropped, latent, kept };

  // infra shapes: first path segment is infra-ish, or path contains an auth/session segment
  const INFRA_SEG = new Set(["auth", "session", "config", "settings", "login", "logout", "token", "oauth", "health", "ping", "status", "metrics", "telemetry"]);
  const isInfraPath = (path: string) => {
    const segs = path.replace(/^\//, "").split("/");
    return segs.some((s) => INFRA_SEG.has(s.toLowerCase()));
  };

  const latentBlock: any = {};
  for (const [resName, res] of Object.entries<any>(resources)) {
    const endpoints = res?.endpoints;
    if (!endpoints || typeof endpoints !== "object") continue;
    for (const [epName, ep] of Object.entries<any>(endpoints)) {
      const method = String(ep?.method ?? "GET").toUpperCase();
      const path = String(ep?.path ?? "");
      const key = `${method} ${path}`;
      const hasData = evidence.get(key);
      if (hasData === false) {
        // no positive data evidence anywhere in the capture
        dropped.push(key);
        delete endpoints[epName];
        continue;
      }
      if (hasData === undefined) {
        // path not in traffic analysis (e.g. generalize-tickers renamed it).
        // Conservative: keep, but it keeps whatever auth the sniffer chose.
        kept.push(`${key} (unverified — no cluster match)`);
        continue;
      }
      if (isInfraPath(path)) {
        // proven data but not useful as a CLI command — tag out, preserve for promotion
        latentBlock[key] = { ...ep, resource: resName, endpoint: epName, x_note: "infrastructure-shaped; promote by moving back into resources" };
        latent.push(key);
        delete endpoints[epName];
        continue;
      }
      kept.push(key);
    }
    // drop resources left with zero endpoints
    if (res && typeof res === "object" && res.endpoints && Object.keys(res.endpoints).length === 0) {
      delete (resources as any)[resName];
    }
  }

  if (Object.keys(latentBlock).length > 0) {
    spec["x-pp-latent"] = { description: "Proven endpoints withheld from generated commands (infrastructure-shaped). Promote by moving into resources.", endpoints: latentBlock };
  }

  return { spec, dropped, latent, kept };
}

// ── pure: does the capture show any 401/403 on ANY cluster? ──
export function captureShowsAuthChallenge(traffic: any): boolean {
  for (const c of (traffic?.endpoint_clusters ?? []) as TrafficCluster[]) {
    for (const s of c?.statuses ?? []) if (s === 401 || s === 403) return true;
  }
  return false;
}

// ── io: read traffic analysis JSON ──
function loadTrafficAnalysisFile(p: string): any | null {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// ── io: anonymous probe of surviving kept endpoints (per-endpoint bar) ──
// Pass = every probed endpoint answers 2xx with a JSON content-type.
export async function probeEndpointsPublic(endpoints: { method: string; path: string }[], baseUrl: string, timeoutMs = 12000): Promise<{ allPublic: boolean; results: { key: string; status: number; json: boolean }[] }> {
  const results: { key: string; status: number; json: boolean }[] = [];
  const base = baseUrl.replace(/\/$/, "");
  for (const ep of endpoints) {
    if (ep.method !== "GET") { results.push({ key: `${ep.method} ${ep.path}`, status: -1, json: false }); continue; } // non-GET: no cheap anon probe — treated as not-proven
    const key = `${ep.method} ${ep.path}`;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(base + ep.path, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; Presswood/1)" }, signal: ctl.signal, redirect: "follow" });
      clearTimeout(t);
      const ct = res.headers.get("content-type") || "";
      results.push({ key, status: res.status, json: isJsonCt(ct) });
    } catch {
      results.push({ key, status: 0, json: false });
    }
  }
  const allPublic = results.length > 0 && results.every((r) => is2xx(r.status) && r.json);
  return { allPublic, results };
}

// ── main entry: polish a spec file in place. Returns a log-line summary. ──
// trafficPath defaults to the engine's convention NEXT to the original spec.yaml
// (generalize renames the spec to -gen.yaml but leaves the analysis where it was).
export async function polishSpecFile(specPath: string, jobId: string, log: (s: string) => void, trafficPath?: string): Promise<void> {
  let spec: any;
  try { spec = YAML.parse(readFileSync(specPath, "utf8")); } catch (e) { log(`[spec-polish] skipped: unparseable spec (${e})`); return; }
  if (spec?.spec_source !== "sniffed") { log("[spec-polish] skipped: not a sniffed spec (hand-authored specs are never polished)"); return; }

  const tPath = trafficPath ?? specPath.replace(/\.yaml$/, "") + "-traffic-analysis.json";
  const traffic = loadTrafficAnalysisFile(tPath);
  if (!traffic?.endpoint_clusters) { log(`[spec-polish] skipped: no traffic analysis at ${tPath} — leaving spec as sniffed`); return; }

  const { spec: polished, dropped, latent, kept } = polishSpecFromTraffic(spec, traffic);

  // auth flip — per-endpoint bar (owner condition #5)
  let authNote = "";
  const baseUrl: string = polished?.base_url ?? "";
  if (captureShowsAuthChallenge(traffic)) {
    authNote = "auth unchanged: capture shows 401/403";
  } else {
    const probeList: { method: string; path: string }[] = [];
    for (const [, res] of Object.entries<any>(polished?.resources ?? {})) {
      for (const [, ep] of Object.entries<any>(res?.endpoints ?? {})) {
        probeList.push({ method: String(ep?.method ?? "GET").toUpperCase(), path: String(ep?.path ?? "") });
      }
    }
    if (probeList.length > 0) {
      // per-endpoint bar fires on literal GET paths only — templated paths
      // (/stock/{ticker}) can't be probed anonymously without a sample value
      const literal = probeList.filter((e) => e.method === "GET" && !e.path.includes("{"));
      if (literal.length === 0) {
        authNote = "auth unchanged: no literal GET endpoint to probe anonymously";
      } else {
        const { allPublic, results } = await probeEndpointsPublic(literal, baseUrl);
        if (allPublic) {
          const prevType = polished?.auth?.type ?? "none";
          polished.auth = { type: "none" };
          authNote = `auth ${prevType}->none: all ${results.length} probeable kept endpoints anonymously 2xx+JSON`;
        } else {
          authNote = `auth unchanged: anonymous probe failed on ${results.filter((r) => !(r.status >= 200 && r.status <= 299 && r.json)).map((r) => r.key).join(", ")}`;
        }
      }
    } else {
      authNote = "auth unchanged: no kept endpoints to probe";
    }
  }

  writeFileSync(specPath, YAML.stringify(polished));
  log(`[spec-polish] kept ${kept.length} (${kept.join(", ") || "none"}) | dropped ${dropped.length} (${dropped.join(", ") || "none"}) | latent ${latent.length} (${latent.join(", ") || "none"}) | ${authNote}`);
}
