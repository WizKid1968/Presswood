"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/dist/ScrollTrigger";
import Lenis from "lenis";

const KINDS = ["url", "har", "spec"] as const;
type Kind = (typeof KINDS)[number];

/* ---------------- hero terminal ---------------- */
const SCRIPT: [string, string][] = [
  ["cmd", "presswood --har capture.har --email rudy@dev.null"],
  ["out", "→ sniffing 412 requests … 23 endpoints found"],
  ["out", "→ generating Go CLI … MCP server … agent skill"],
  ["ok", "✓ built + verified        e2e-press-one-pp-cli      [download]"],
  ["ok", "✓ built + verified        e2e-press-one-pp-mcp     [download]"],
];
function useTerminal() {
  const [lines, setLines] = useState<{ c: string; t: string }[]>([]);
  const reduced = useRef(false);
  useEffect(() => {
    reduced.current = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced.current) setLines(SCRIPT.map(([c, t]) => ({ c, t })));
  }, []);
  useEffect(() => {
    if (reduced.current) return;
    let li = 0, ch = 0, dead = false;
    const step = () => {
      if (dead) return;
      const [c, t] = SCRIPT[li];
      if (ch <= t.length) {
        setLines(prev => [...prev.slice(0, li), { c, t: t.slice(0, ch) }]);
        ch += 1;
        setTimeout(step, c === "cmd" ? 55 : 12);
      } else if (li + 1 < SCRIPT.length) {
        li += 1; ch = 0; setLines(prev => [...prev, { c: "", t: "" }]);
        setTimeout(step, c === "cmd" ? 500 : 250);
      } else {
        setTimeout(() => { if (!dead) { li = 0; ch = 0; setLines([]); step(); } }, 6000);
      }
    };
    setLines([{ c: "", t: "" }]); setTimeout(step, 600);
    return () => { dead = true; };
  }, []);
  return { lines };
}

/* ---------------- particles: atmosphere, not the meal ---------------- */
function Particles({ orderRef }: { orderRef: React.RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const N = 300;
    const P = Array.from({ length: N }, () => ({ x: Math.random(), y: Math.random(), v: Math.random() * 0.4 + 0.1, p: Math.random() * 6.28 }));
    let raf = 0, t = 0, running = true;
    const resize = () => { canvas.width = canvas.offsetWidth * 1.5; canvas.height = canvas.offsetHeight * 1.5; };
    resize(); addEventListener("resize", resize);
    const draw = () => {
      if (!running) return;
      t += 0.016;
      const order = orderRef?.current ? Number(orderRef.current.dataset.order ?? 0) : 0;
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      for (const pt of P) {
        let x = pt.x, y = (pt.y + t * pt.v * 0.02) % 1;
        if (order > 0.6 && order <= 1.6) {
          const s = pt.p > 3.14 ? 1 : -1;
          y = (pt.y + t * 0.03) % 1; x = 0.5 + s * 0.12 * Math.sin(y * 18 + t * 2) + (pt.x - 0.5) * 0.15;
        } else if (order > 1.6 && order <= 2.6) {
          x = 0.12 + Math.round(pt.x * 6) / 6 * 0.76; y = 0.25 + Math.round(pt.y * 4) / 4 * 0.5;
        } else if (order > 2.6) {
          const a = pt.p + t * 0.1; x = 0.5 + 0.3 * Math.cos(a); y = 0.5 + 0.25 * Math.sin(a);
        }
        const px = x * w, py = (1 - y) * h;
        const tw = 0.55 + 0.45 * Math.sin(t * 2 + pt.p);
        if (pt.p > 4.4) {
          ctx.fillStyle = `rgba(255,215,0,${0.75 * tw})`;
          ctx.fillRect(px, py, 4.5, 4.5);
        } else {
          ctx.fillStyle = `rgba(190,240,200,${0.55 * tw})`;
          ctx.fillRect(px, py, 3.2, 3.2);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    if (!reduced) raf = requestAnimationFrame(draw);
    const io = new IntersectionObserver(([e]) => {
      running = e.isIntersecting && !reduced;
      if (running) raf = requestAnimationFrame(draw); else cancelAnimationFrame(raf);
    });
    io.observe(canvas);
    const vis = () => { if (document.hidden) { running = false; cancelAnimationFrame(raf); } else { running = true; raf = requestAnimationFrame(draw); } };
    document.addEventListener("visibilitychange", vis);
    return () => { running = false; cancelAnimationFrame(raf); io.disconnect(); removeEventListener("resize", resize); document.removeEventListener("visibilitychange", vis); };
  }, [orderRef]);
  return <canvas ref={ref} className="absolute inset-0 h-full w-full" aria-hidden="true" />;
}

/* ---------------- Turnstile (activates when NEXT_PUBLIC_TURNSTILE_SITE is set at build) ---------------- */
declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id: string) => void;
    };
    onTurnstileLoad?: () => void;
  }
}
const TURNSTILE_SITE = process.env.NEXT_PUBLIC_TURNSTILE_SITE;

function TurnstileBox({ onToken }: { onToken: (t: string | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  useEffect(() => {
    if (!TURNSTILE_SITE || !box.current) return;
    let dead = false;
    const render = () => {
      if (dead || widgetId.current || !box.current || !window.turnstile) return;
      widgetId.current = window.turnstile.render(box.current, {
        sitekey: TURNSTILE_SITE,
        theme: "dark",
        callback: (t: string) => onToken(t),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
      });
    };
    if (window.turnstile) render();
    else {
      window.onTurnstileLoad = render;
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad";
      s.async = true;
      document.head.appendChild(s);
    }
    return () => {
      dead = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [onToken]);
  if (!TURNSTILE_SITE) return null;
  return <div ref={box} className="mb-3" aria-label="human check" />;
}

/* ---------------- submit form ---------------- */
function PressForm() {
  const [kind, setKind] = useState<Kind>("url");
  const [target, setTarget] = useState<"linux" | "mac">("linux");
  const [email, setEmail] = useState("");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ e: boolean; t: string } | null>(null);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const onToken = useCallback((t: string | null) => setCaptcha(t), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (TURNSTILE_SITE && !captcha) { setMsg({ e: true, t: "complete the human check first" }); return; }
    setBusy(true); setMsg(null);
    const fd = new FormData();
    fd.set("email", email); fd.set("kind", kind); fd.set("label", label); fd.set("target", target);
    fd.set("turnstile_token", captcha ?? "dev"); // "dev" only while server runs TURNSTILE_SECRET=dev
    if (kind === "url") fd.set("url", url);
    if (file) fd.set("file", file);
    const r = await fetch("/api/press", { method: "POST", body: fd }).then(r => r.json()).catch(() => ({ error: "network" }));
    setBusy(false);
    if (r.token) location.href = `/press/${r.token}`;
    else setMsg({ e: true, t: r.error ?? "failed" });
  }

  return (
    <form onSubmit={submit} className="mono rounded-2xl border border-emerald-400/15 bg-[#0B1512]/80 p-5 shadow-2xl backdrop-blur-sm sm:p-6">
      <div className="mb-4 flex gap-1 rounded-lg bg-black/40 p-1 text-sm" role="tablist" aria-label="input type">
        {KINDS.map(k => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
            className={`flex-1 rounded-md px-3 py-2 uppercase tracking-wider ${kind === k ? "bg-emerald-500/20 text-emerald-300" : "text-white/40 hover:text-white/70"}`}>
            {k === "url" ? "paste url" : k === "har" ? "drop har" : "upload spec"}
          </button>
        ))}
      </div>

      {kind === "url" && (
        <input required type="url" name="url" value={url} onChange={e => setUrl(e.target.value)}
          placeholder="https://unusualwhales.com"
          className="mb-3 w-full rounded-lg border border-white/10 bg-black/40 px-4 py-3 text-sm placeholder:text-white/25"
          aria-label="site url to crawl" />
      )}
      {kind === "har" && (
        <label className="mb-3 flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed border-white/15 bg-black/30 px-4 py-6 text-center text-sm text-white/40 hover:border-emerald-400/40 hover:text-white/70">
          <input type="file" className="sr-only" accept=".har,application/json"
            onChange={e => setFile(e.target.files?.[0] ?? null)} />
          <span className="text-base">{file ? `✓ ${file.name}` : "capture.har — DevTools → Network → Save all as HAR"}</span>
          <span className="text-xs text-white/25">up to 50MB</span>
        </label>
      )}
      {kind === "spec" && (
        <label className="mb-3 flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed border-white/15 bg-black/30 px-4 py-6 text-center text-sm text-white/40 hover:border-emerald-400/40 hover:text-white/70">
          <input type="file" className="sr-only" accept=".yaml,.yml,.json"
            onChange={e => setFile(e.target.files?.[0] ?? null)} />
          <span className="text-base">{file ? `✓ ${file.name}` : "openapi.yaml or .json"}</span>
          <span className="text-xs text-white/25">up to 2MB</span>
        </label>
      )}

      <TurnstileBox onToken={onToken} />

      <div className="flex flex-col gap-3 sm:flex-row">
        <input required type="email" name="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@domain.dev"
          className="w-full rounded-lg border border-white/10 bg-black/40 px-4 py-3 text-sm placeholder:text-white/25" aria-label="email for delivery" />
        <select value={target} onChange={e => setTarget(e.target.value as "linux" | "mac")} aria-label="build for"
          className="shrink-0 rounded-lg border border-white/10 bg-black/40 px-3 py-3 text-sm">
          <option value="linux">linux</option>
          <option value="mac">mac</option>
        </select>
        <button disabled={busy} className="shrink-0 rounded-lg bg-[#FFD700] px-7 py-3 text-sm font-bold uppercase tracking-wider text-black transition hover:bg-[#ffe14d] disabled:opacity-50">
          {busy ? "pressing…" : "Press it"}
        </button>
      </div>
      <input value={label} onChange={e => setLabel(e.target.value)} placeholder="label it (optional) — e.g. sec-api"
        className="mt-3 w-full rounded-lg border border-white/10 bg-black/40 px-4 py-2.5 text-xs placeholder:text-white/25" aria-label="label" />
      <p className="mt-3 text-xs text-white/35">
        free while in alpha · bundle lands in your inbox · link lives 30 days
        {msg?.e && <span className="ml-2 text-red-400">⚠ {msg.t}</span>}
      </p>
    </form>
  );
}

/* ---------------- shelf ---------------- */
function Shelf() {
  const [rows, setRows] = useState<{ token: string; label: string; kind: string; status: string }[]>([]);
  const [total, setTotal] = useState(0);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let off = 0, live = true;
    const io = new IntersectionObserver(async ([e]) => {
      if (!e.isIntersecting || !live) return;
      const d = await fetch(`/api/presses?off=${off}`).then(r => r.json());
      setTotal(d.total); setRows(p => [...p, ...d.rows]); off += 20;
    }, { rootMargin: "200px" });
    if (sentinel.current) io.observe(sentinel.current);
    return () => { live = false; io.disconnect(); };
  }, []);
  return (
    <section id="shelf" data-alt="orbit" className="relative mx-auto max-w-6xl px-6 py-28">
      <p className="mono text-xs uppercase tracking-[0.3em] text-emerald-300/60">the shelf</p>
      <h2 className="rise mt-2 text-3xl sm:text-4xl">Everything already printed.</h2>
      <p className="mt-2 text-white/40">{total} presses and counting. Every card opens its live receipt.</p>
      <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r, i) => (
          <a key={r.token + i} href={`/press/${r.token}`}
            className="mono group rounded-xl border border-white/8 bg-black/40 p-4 transition hover:border-emerald-400/30 hover:bg-black/60">
            <div className="flex items-center justify-between">
              <span className="truncate text-sm text-emerald-200/90">{r.label || r.kind}</span>
              <span className={`text-[10px] uppercase ${r.status === "done" ? "text-emerald-400" : r.status === "failed" ? "text-red-400" : "text-white/30"}`}>{r.status}</span>
            </div>
            <div className="mt-2 text-xs text-white/30">/press/{r.token.slice(0, 12)}…</div>
          </a>
        ))}
      </div>
      <div ref={sentinel} className="pulse mono py-8 text-center text-xs text-white/30">{rows.length < total ? "loading more…" : "that's the whole shelf"}</div>
    </section>
  );
}

/* ---------------- FAQ ---------------- */
const FAQS: [string, string][] = [
  ["What exactly do I get back?",
    "Three artifacts from one input: a compiled Go CLI binary that pipes JSON and speaks in typed exit codes; an MCP server bundle you can drop into Claude Desktop or Cursor; and an agent skill that teaches your coding agent how to drive the CLI. The full source tree ships in the bundle too — read it, audit it, fork it."],
  ["How does a HAR become a CLI?",
    "A HAR is your browser's recording of real traffic. The engine sniffs it — inferring endpoints, auth surfaces, pagination and response shapes — writes a spec, generates the Go code, then runs its own gates: build, vet, tests, vulnerability scan. What lands in your inbox already compiles and passes its checks."],
  ["What does it cost?",
    "Nothing while we're in alpha. Fair-use limits: 2 active presses, 5 per day per email. When monetization arrives, existing users hear about it first — this list is the product's early community."],
  ["What happens to my uploads?",
    "Raw uploads purge in 72 hours. Bundles keep for 30 days. Download links are unguessable tokens — only you and your inbox. Nothing is shared to the public shelf without your label saying so."],
  ["The URL tab says coming soon — why?",
    "Pasting a link needs a headless browser to capture that site's traffic. It's the next build. Until then, open the site, record a HAR from DevTools (Network → Save all as HAR), and drop that instead — it works behind logins too, since it's your own session."],
  ["What can't it do?",
    "It won't defeat bot walls or scrape what a site hides — refusal with a plain-English reason is part of the product. And a noisy HAR (mostly page navigation, few API calls) yields a thin CLI; the receipt tells you exactly what was found."],
];
function Faq() {
  return (
    <section id="faq" className="relative mx-auto max-w-3xl px-6 py-28">
      <h2 className="rise text-3xl">Straight answers.</h2>
      <div className="mt-10 space-y-9">
        {FAQS.map(([q, a]) => (
          <div key={q}>
            <h3 className="text-lg">{q}</h3>
            <p className="mt-2 text-sm leading-relaxed text-white/55">{a}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------- page ---------------- */
// Backdrop world: five altitudes of ONE scene. Each plate's stop is MEASURED
// from its section's real offset — no magic scroll fractions.
const PLATES: [string, string][] = [
  ["/og.png", "soil"],
  ["/plate-roots.png", "roots"],
  ["/plate-canopy.png", "canopy"],
  ["/plate-cloudeck.png", "clouds"],
  ["/band-orbit.png", "orbit"],
];

export default function Home() {
  const { lines } = useTerminal();
  const worldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      // static world: every plate faintly present, no driving
      gsap.set(".plate", { opacity: i => (i === 0 ? 0.35 : 0.14) });
      return;
    }
    gsap.registerPlugin(ScrollTrigger);
    const lenis = new Lenis({ lerp: 0.11 });
    lenis.on("scroll", ScrollTrigger.update);
    const raf = (t: number) => lenis.raf(t * 1000);
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);

    const plates = gsap.utils.toArray<HTMLElement>(".plate");
    const measure = () => {
      const span = document.body.scrollHeight - innerHeight;
      // each plate peaks where its anchor section's CENTER crosses viewport center
      return PLATES.map(([file, label]) => {
        const el = document.querySelector(`[data-alt="${label}"]`);
        if (!el || span <= 0) return 0;
        const top = (el as HTMLElement).offsetTop + el.clientHeight / 2 - innerHeight / 2;
        return Math.min(1, Math.max(0, top / span));
      });
    };
    let stops = measure();
    const setWorld = (p: number) => {
      plates.forEach((el, i) => {
        const stop = stops[i];
        const band = 0.16;
        const d = Math.abs(p - stop);
        const w = Math.max(0, 1 - d / band);
        gsap.set(el, { opacity: 0.1 + 0.24 * w, yPercent: (p - stop) * -16 });
      });
      // particles fade out as the shelf arrives — never cross real content again
      const shelfStop = stops[stops.length - 1];
      gsap.set("#fx", { opacity: Math.max(0, Math.min(1, (shelfStop - 0.08 - p) / 0.1)) });
      if (worldRef.current) worldRef.current.dataset.order = String(Math.min(3.2, p * 3.4));
    };
    ScrollTrigger.create({
      start: 0, end: "max", scrub: 0.5,
      onUpdate: st => setWorld(st.progress),
      onRefresh: () => { stops = measure(); },
    });
    setWorld(0);
    addEventListener("resize", () => { stops = measure(); });

    document.querySelectorAll<HTMLElement>(".rise").forEach(el => {
      gsap.fromTo(el, { autoAlpha: 0, y: 36 }, {
        autoAlpha: 1, y: 0, ease: "none",
        scrollTrigger: { trigger: el, start: "top 88%", end: "top 55%", scrub: 0.6 },
      });
    });

    return () => { lenis.destroy(); gsap.ticker.remove(raf); ScrollTrigger.getAll().forEach(t => t.kill()); };
  }, []);

  return (
    <main>
      {/* ===== the world: fixed backdrop, five altitudes ===== */}
      <div className="fixed inset-0 -z-20 overflow-hidden bg-[#0B1512]" aria-hidden="true">
        {PLATES.map(([src]) => (
          <div key={src} className="plate absolute inset-0 bg-cover bg-center will-change-transform" style={{ backgroundImage: `url(${src})` }} />
        ))}
      </div>
      {/* legibility scrim + focal glow + film grain */}
      <div className="fixed inset-0 -z-10" aria-hidden="true"
        style={{ background: "linear-gradient(180deg, rgba(11,21,18,.62), rgba(11,21,18,.18) 38%, rgba(11,21,18,.55))" }} />
      <div className="fixed inset-0 -z-10" aria-hidden="true"
        style={{ background: "radial-gradient(720px at 86% 104%, rgba(255,215,0,.085), transparent 62%), radial-gradient(560px at 8% 108%, rgba(127,185,140,.07), transparent 60%)" }} />
      <div className="fixed inset-0 -z-10 grain" aria-hidden="true" />
      <div id="fx" className="fixed inset-0 -z-10" ref={worldRef} data-order="0" aria-hidden="true">
        <Particles orderRef={worldRef} />
      </div>

      {/* ===== chrome (always present, like the reference) ===== */}
      <header className="fixed inset-x-0 top-0 z-40 flex items-center justify-between px-6 py-4">
        <a href="#start" className="mono text-[11px] uppercase tracking-[0.35em] text-white/80">
          press<span className="text-[#FFD700]">wood</span>
        </a>
        <nav className="mono flex items-center gap-6 text-[11px] uppercase tracking-[0.2em] text-white/50">
          <a href="#shelf" className="hover:text-white">shelf</a>
          <a href="#faq" className="hover:text-white">faq</a>
          <a href="#start" className="rounded-md border border-white/15 px-3 py-1.5 text-white/80 hover:border-[#FFD700]/60 hover:text-[#FFD700]">start a press</a>
        </nav>
      </header>
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex items-end justify-between px-6 py-4">
        <span className="mono text-[10px] uppercase tracking-[0.25em] text-white/30">grown in the forest · launched into orbit</span>
        <button disabled title="sound ships with the alpha build"
          className="mono pointer-events-auto rounded-full border border-white/10 px-3 py-1.5 text-[10px] uppercase tracking-[0.25em] text-white/30">
          sound · off
        </button>
      </div>

      {/* ===== viewport 1 ===== */}
      <section id="start" data-alt="soil" className="relative">
        <div className="mx-auto grid max-w-6xl gap-12 px-6 pt-32 pb-16 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:pt-40 lg:pb-24">
          <div>
            <p className="mono text-xs uppercase tracking-[0.35em] text-emerald-300/70">presswood · free while in alpha</p>
            <h1 className="mt-4 text-4xl leading-[1.05] font-medium sm:text-5xl lg:text-6xl">
              Turn any API into a <span className="text-[#FFD700]">CLI + MCP server</span> your agent can drive.
            </h1>
            <p className="mt-5 max-w-lg text-lg text-white/60">
              Drop a HAR, paste a URL, or upload a spec. Get back binaries — built, verified, shipped to your inbox.
            </p>
            <pre className="mono mt-8 min-h-[7.5rem] overflow-x-auto rounded-xl border border-emerald-400/15 bg-black/60 p-4 text-[13px] leading-relaxed shadow-2xl">
              {lines.map((l, i) => (
                <div key={i} className={l.c === "cmd" ? "text-emerald-300" : l.c === "ok" ? "text-[#FFD700]" : "text-white/50"}>
                  {l.c === "cmd" && <span className="text-white/30">$ </span>}
                  {l.t}
                  {i === lines.length - 1 && <span className="cursor">▌</span>}
                </div>
              ))}
            </pre>
          </div>
          <PressForm />
        </div>
      </section>

      {/* ===== statements over the world (normal flow, no pin) ===== */}
      <section data-alt="roots" className="mx-auto flex min-h-[85vh] max-w-4xl flex-col items-center justify-center px-6 text-center">
        <h2 className="rise text-4xl leading-tight sm:text-5xl">Every API has a secret identity.</h2>
        <p className="rise mt-5 max-w-xl text-lg text-white/55">Designed by committee. Used by agents for something else entirely.</p>
        <p className="rise mono mt-8 text-xs text-emerald-300/70">paste a url → presswood sniffs its real traffic: endpoints, auth, pagination — the shape beneath the site</p>
      </section>

      <section data-alt="canopy" className="mx-auto flex min-h-[85vh] max-w-4xl flex-col items-center justify-center px-6">
        <div className="rise mono w-full max-w-2xl rounded-xl border border-white/10 bg-black/60 p-5 text-sm shadow-2xl sm:p-6">
          <p className="text-[#FFD700]">THE PRESS — feed it noise, it prints precision</p>
          <p className="mt-2 text-white/60">capture.har → <span className="text-emerald-300">cli binary · mcp server · agent skill</span></p>
          <div className="mt-4 grid gap-2 text-left text-xs text-white/50">
            <p><span className="text-emerald-300">discord</span> isn&apos;t chat — it&apos;s institutional memory.</p>
            <p><span className="text-emerald-300">stripe</span> isn&apos;t payments — it&apos;s the business&apos;s health monitor.</p>
            <p><span className="text-emerald-300">linear</span> isn&apos;t tickets — it&apos;s an observatory of how work really moves.</p>
          </div>
          <p className="mt-4 border-t border-white/10 pt-3 text-xs text-white/40">your agent asks in one command what used to cost forty tool calls and a doc-diving headache.</p>
        </div>
      </section>

      <section data-alt="clouds" className="mx-auto flex min-h-[85vh] max-w-4xl flex-col items-center justify-center px-6 text-center">
        <h2 className="rise text-4xl leading-tight sm:text-5xl">Verified, not vibes.</h2>
        <p className="rise mt-5 max-w-xl text-lg text-white/55">Every press runs the engine&apos;s own gates before you ever see it: build, vet, tests, vulnerability scan.</p>
        <p className="rise mono mt-8 text-xs text-emerald-300/70">typed exit codes · auto-json when piped · --dry-run everywhere · compact mode for small token budgets</p>
      </section>

      <Shelf />
      <Faq />

      <footer className="relative border-t border-white/5 px-6 pt-10 pb-24">
        <div className="mono mx-auto flex max-w-6xl flex-col gap-3 text-xs text-white/35 sm:flex-row sm:items-center sm:justify-between">
          <span>© 2026 presswood · alpha</span>
          <span>engine: <a className="underline hover:text-white/60" href="https://github.com/mvanhorn/cli-printing-press">cli-printing-press</a></span>
        </div>
      </footer>
    </main>
  );
}
