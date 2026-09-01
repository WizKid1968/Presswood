import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { validateSubmission } from "@/lib/validate";
import { started } from "@/lib/email";
import { startWorker } from "@/lib/jobs";

const ACTIVE_CAP = 2, DAILY_CAP = 5;

export async function POST(req: Request) {
  const v = await validateSubmission(req);
  if (!v.ok) return NextResponse.json({ error: v.reason }, { status: v.status });

  const hash = v.hash;
  const active = (db.prepare(
    "SELECT COUNT(*) c FROM presses WHERE email=? AND status IN ('queued','running')").get(hash)) as { c: number } | undefined;
  const daily = (db.prepare(
    "SELECT COUNT(*) c FROM presses WHERE email=? AND created_at > strftime('%s','now')*1000 - 24*3600*1000").get(hash)) as { c: number } | undefined;
  if ((active?.c ?? 0) >= ACTIVE_CAP) return NextResponse.json({ error: "you already have 2 presses running — wait for one to finish" }, { status: 429 });
  if ((daily?.c ?? 0) >= DAILY_CAP) return NextResponse.json({ error: "daily limit reached (5) — back tomorrow" }, { status: 429 });

  const id = crypto.randomUUID(), token = randomBytes(16).toString("hex"), now = Date.now();
  db.prepare(`INSERT INTO presses(id,token,email,kind,label,target,payload,status,phase,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?, 'queued','', ?, ?)`)
    .run(id, token, v.email, v.kind, v.label, v.target, v.payloadPath ?? v.payloadText ?? "", now, now);

  startWorker();
  await started({ email: v.email, token, label: v.label || v.kind }).catch(e => console.error("[email]", e));

  return NextResponse.json({ token, url: `/press/${token}` });
}
