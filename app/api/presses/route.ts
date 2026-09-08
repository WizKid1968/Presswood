import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// ponytail: OFFSET paging; cursor-keyset when shelf > few hundred rows.
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const off = Number(sp.get("off") ?? 0);
  const limit = Math.min(50, Math.max(1, Number(sp.get("limit") ?? 20)));
  const rows = db.prepare(
    "SELECT token,label,kind,status,created_at FROM presses ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ).all(limit, off) as { token: string; label: string; kind: string; status: string; created_at: number }[];
  const { c } = db.prepare("SELECT COUNT(*) c FROM presses").get() as { c: number };
  return Response.json({ rows, total: c });
}
