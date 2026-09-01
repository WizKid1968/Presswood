import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { db } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const job = db.prepare("SELECT * FROM presses WHERE token=?").get(token) as
    | { artifact: string | null; expires_at: number | null }
    | undefined;
  if (!job?.artifact || !existsSync(job.artifact))
    return new Response("no artifact", { status: 404 });
  if ((job.expires_at ?? 0) < Date.now())
    return new Response("expired (artifacts keep for 30 days)", { status: 410 });

  const size = statSync(job.artifact).size;
  const stream = Readable.toWeb(createReadStream(job.artifact)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "content-type": "application/gzip",
      "content-length": String(size),
      "content-disposition": `attachment; filename="presswood-${token.slice(0, 8)}.tgz"`,
    },
  });
}
