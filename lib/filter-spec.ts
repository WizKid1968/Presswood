// Drop HEAD endpoints from a sniffed spec: they have no response body, the
// GET sibling carries the data, and the engine's generator emits broken code
// for them (undefined newNextCmd — upstream bug, we filter at our boundary).
import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";

export function filterHeadEndpoints(specPath: string): number {
  const doc = parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;
  const resources = (doc?.resources ?? {}) as Record<string, { endpoints?: Record<string, { method?: string }> }>;
  let dropped = 0;
  for (const res of Object.values(resources)) {
    const eps = res?.endpoints;
    if (!eps) continue;
    for (const [name, ep] of Object.entries(eps)) {
      if ((ep as { method?: string })?.method === "HEAD") {
        delete eps[name];
        dropped += 1;
      }
    }
  }
  writeFileSync(specPath, stringify(doc));
  return dropped;
}
