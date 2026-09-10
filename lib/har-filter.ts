// ponytail: pure primary-host selection + entry filter, split out of jobs.ts so the
// selftest can exercise it without booting the worker. Logic (Sep 9, owner-approved):
// primary = the host that served the PAGES (HTML) the user browsed — never the
// noisiest CDN. Rank: HTML docs, then JSON responses, then raw request count.
// The old "most requests wins" rule let cdn.ssref.net gut a good Stathead capture.

export type HarEntry = {
  request: { url: string };
  response?: { content?: { mimeType?: string } };
};

export type PrimaryPick = {
  primary: string;
  reg: string;
  keep: HarEntry[];
};

export function pickPrimaryAndKeep(es: HarEntry[]): PrimaryPick | null {
  if (!es.length) return null;
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
  if (!stats.size) return null;
  const primary = [...stats.entries()].sort((a, b) =>
    (b[1].html - a[1].html) || (b[1].json - a[1].json) || (b[1].req - a[1].req))[0][0];
  const reg = primary.split(".").slice(-2).join(".");
  const keep = es.filter((e) => {
    try {
      const h = new URL(e.request.url).hostname;
      return h === primary || h === reg || h.endsWith("." + reg);
    } catch { return false; }
  });
  return { primary, reg, keep };
}
