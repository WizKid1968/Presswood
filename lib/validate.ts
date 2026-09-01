// Trust-boundary validation for /api/press. Never lazy here.
import { createHash, randomBytes } from "node:crypto";

export const KINDS = ["har", "spec", "url"] as const;
export const MAX_HAR = 50 * 1024 * 1024; // 50MB
export const MAX_SPEC = 2 * 1024 * 1024; // 2MB

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ponytail: hostname-shape private-range block only; crawler does its own
// resolution-time guard when it lands (pin resolved IPs there).
const PRIVATE_HOST =
  /^(localhost|.*\.local|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|\[fc|\[fd)/i;

export function emailHash(email: string) {
  return createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 32);
}

export interface Validated {
  ok: true; email: string; hash: string; kind: string;
  label: string; payloadPath?: string; payloadText?: string;
}
export interface Rejected { ok: false; reason: string; status: number }

export async function validateSubmission(req: Request): Promise<Validated | Rejected> {
  const t = await req.formData().catch(() => null);
  if (!t) return { ok: false, reason: "expected multipart form", status: 400 };

  // Turnstile first — fail closed if unconfigured. ("dev" secret skips check for local e2e only)
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return { ok: false, reason: "captcha not configured", status: 503 };
  const tok = String(t.get("turnstile_token") ?? "");
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  let ok = secret === "dev";
  if (!ok) {
    const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: tok, ...(ip && { remoteip: ip }) }),
    }).then(r => r.json()).catch(() => ({ success: false }));
    ok = Boolean((v as { success?: boolean }).success);
  }
  if (!ok) return { ok: false, reason: "captcha failed", status: 403 };

  const email = String(t.get("email") ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, reason: "invalid email", status: 400 };

  const kind = String(t.get("kind") ?? "");
  if (!(KINDS as readonly string[]).includes(kind))
    return { ok: false, reason: "kind must be har|spec|url", status: 400 };

  let payload = "", payloadPath: string | undefined;
  if (kind === "url") {
    const u = String(t.get("url") ?? "").trim();
    let parsed: URL;
    try { parsed = new URL(u); } catch { return { ok: false, reason: "invalid url", status: 400 }; }
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, reason: "only http(s) urls allowed", status: 400 };
    if (PRIVATE_HOST.test(parsed.hostname)) return { ok: false, reason: "private hosts not allowed", status: 400 };
    payload = u;
    return { ok: true, email, hash: emailHash(email), kind, label: String(t.get("label") ?? "").slice(0, 80), payloadText: payload };
  }
  const file = t.get("file");
  if (!(file instanceof File)) return { ok: false, reason: "file required", status: 400 };
  const cap = kind === "har" ? MAX_HAR : MAX_SPEC;
  if (file.size > cap) return { ok: false, reason: `file exceeds ${cap >> 20}MB`, status: 413 };
  if (kind === "spec" && !/\.(ya?ml|json)$/i.test(file.name))
    return { ok: false, reason: "spec must be .yaml/.yml/.json", status: 415 };

  payloadPath = `/mnt/usb/presswood-dev/uploads/${randomBytes(8).toString("hex")}-${file.name.replace(/[^\w.-]/g, "_")}`;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync("/mnt/usb/presswood-dev/uploads", { recursive: true });
  writeFileSync(payloadPath, Buffer.from(await file.arrayBuffer()));
  payload = payloadPath;

  const label = String(t.get("label") ?? "").slice(0, 80);
  return { ok: true, email, hash: emailHash(email), kind, label, payloadPath, payloadText: payload };
}
