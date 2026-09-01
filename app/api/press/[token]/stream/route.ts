import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// SSE: poll the row every 1s, push status+phase+new log lines.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const job = db.prepare("SELECT * FROM presses WHERE token=?").get(token) as
    | { id: string; status: string; phase: string; log: string; error: string | null }
    | undefined;
  if (!job) return new Response("not found", { status: 404 });

  const enc = new TextEncoder();
  let sentLogLen = 0;
  const stream = new ReadableStream({
    start(controller) {
      const push = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const tick = () => {
        const j = db.prepare("SELECT * FROM presses WHERE id=?").get(job.id) as typeof job | undefined;
        if (!j) return close();
        push("progress", {
          status: j.status,
          phase: j.phase,
          log: j.log.slice(sentLogLen),
          error: j.error,
          artifactUrl: j.status === "done" ? `/api/press/${token}/artifact` : null,
        });
        sentLogLen = j.log.length;
        if (j.status === "done" || j.status === "failed") return close();
      };
      const iv = setInterval(tick, 1000);
      const close = () => { clearInterval(iv); try { controller.close(); } catch {} };
      tick();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
