import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// ponytail: OFFSET paging; cursor-keyset when shelf > few hundred rows.
export async function GET(req: Request) {
  const off = Number(new URL(req.url).searchParams.get("off") ?? 0);
  const rows = db.prepare(
    "SELECT token,label,kind,status,created_at FROM presses ORDER BY created_at DESC LIMIT 20 OFFSET ?"
  ).all(off) as { token: string; label: string; kind: string; status: string; created_at: number }[];
  const { c } = db.prepare("SELECT COUNT(*) c FROM presses").get() as { c: number };
  return Response.json({ rows, total: c });
}
