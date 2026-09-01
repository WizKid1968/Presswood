// Two emails via Resend REST. No SDK.
const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.MAIL_FROM ?? "Presswood <press@presswood.dev>";
const SITE = process.env.PW_SITE_URL ?? "https://presswood.dev";

interface Job { email: string; token: string; label: string }

export async function started(j: Job) {
  if (!KEY) return console.log(`[email:dry] started → ${j.email} ${SITE}/press/${j.token}`);
  await send(j.email, `Your press is running: ${j.label}`,
    `<p>We're printing your API now. Watch it live:</p><p><a href="${SITE}/press/${j.token}">${SITE}/press/${j.token}</a></p>`);
}

export async function finished(j: Job & { ok: boolean; error?: string }) {
  const link = `${SITE}/press/${j.token}`;
  const body = j.ok
    ? `<p>Your CLI + MCP bundle is ready — downloadable for 30 days:</p>
       <p><a href="${link}">${link}</a></p><hr><p>Reply and tell us what broke. We read everything.</p>`
    : `<p>Your press couldn't print this one.</p><p>Reason: ${escapeHtml(j.error ?? "unknown")}</p>
       <p>Try a fuller HAR capture or a real OpenAPI spec. Details: ${link}</p>`;
  if (!KEY) return console.log(`[email:dry] finished(${j.ok}) → ${j.email}`);
  await send(j.email, j.ok ? `Ready: ${j.label}` : `Couldn't print: ${j.label}`, body);
}

async function send(to: string, subject: string, html: string) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, reply_to: FROM, html }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
  console.log(`[email] sent → ${to} (${subject})`);
}

function escapeHtml(s: string) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}
