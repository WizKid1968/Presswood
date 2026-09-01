"use client";

import { useEffect, useRef, useState } from "react";

const PHASES = ["Resolve", "Sniff", "Compose", "Final check", "Pack"];
type State = {
  status: string; phase: string; log: string;
  error?: string | null; artifactUrl?: string | null;
};

export default function PressPage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState<string>("");
  const [s, setS] = useState<State>({ status: "connecting", phase: "", log: "" });
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => { params.then(p => setToken(p.token)); }, [params]);

  useEffect(() => {
    if (!token) return;
    const es = new EventSource(`/api/press/${token}/stream`);
    es.addEventListener("progress", e => {
      const d = JSON.parse((e as MessageEvent).data);
      setS(prev => ({ ...prev, ...d, log: prev.log + (d.log ?? "") }));
      if (d.status === "done" || d.status === "failed") es.close();
    });
    es.onerror = () => {/* EventSource retries on its own */};
    return () => es.close();
  }, [token]);

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [s.log]);

  const phaseIdx = PHASES.indexOf(s.phase);
  const done = s.status === "done", failed = s.status === "failed";

  return (
    <main className="min-h-screen bg-[#0B1512] text-[#E8F0EA] font-mono px-6 py-16">
      <div className="max-w-2xl mx-auto">
        <a href="/" className="text-xs tracking-[0.3em] uppercase text-emerald-300/70 hover:text-emerald-200">← presswood home</a>
        <h1 className="mt-4 text-2xl mb-6 break-all">{failed ? "Couldn't print" : done ? "Printed ✦" : "Printing…"} <span className="text-emerald-400/60">/{token.slice(0, 10)}</span></h1>

        <ol className="flex flex-wrap gap-3 text-sm mb-8">
          {PHASES.map((p, i) => (
            <li key={p} className={
              i < phaseIdx || done ? "text-emerald-400 line-through decoration-emerald-700"
                : i === phaseIdx && !done && !failed ? "text-white border-b border-white pb-0.5"
                  : "text-white/30"}>{p}</li>
          ))}
        </ol>

        {done && s.artifactUrl && (
          <a href={s.artifactUrl} className="inline-block mb-8 rounded-lg bg-emerald-500 px-6 py-3 font-bold text-black hover:bg-emerald-400">
            Download CLI + MCP bundle
          </a>
        )}
        {failed && (
          <div className="mb-8 rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm">
            <p className="font-bold text-red-300 mb-1">The press jammed.</p>
            <p className="text-red-200/80 whitespace-pre-wrap">{s.error}</p>
            <p className="text-red-200/50 mt-2">Try a fuller HAR capture or a real OpenAPI spec.</p>
          </div>
        )}

        {!done && !failed && (
          <pre ref={logRef} className="h-64 overflow-y-auto rounded-lg bg-black/50 p-4 text-xs leading-relaxed text-emerald-200/80 whitespace-pre-wrap" aria-live="polite">
            {s.log || "warming up the press…"}
          </pre>
        )}
      </div>
    </main>
  );
}
