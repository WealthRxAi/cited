// CITED — AI-visibility reports for local businesses (CPA firms, tax offices, jewelers).
// JSON API only; pages live on Vercel (Supabase rewrites text/html to text/plain on its domain).
//
// Routes under /functions/v1/cited-api:
//   GET  /health
//   POST /audit             {firm_name, website?, city, state, vertical?, email?, source?} -> {id}
//   GET  /audit/:id         report JSON (poll until status = done)
//   POST /checkout          {id} -> Stripe Checkout, one-time fix pack
//   POST /confirm           {id, session_id} -> marks paid, builds the fix pack, schedules the 45-day re-check
//   POST /internal/audit    x-cited-token: run an audit for a prospect, no rate limits
//   POST /internal/recheck  x-cited-token: re-run due re-checks and email the before/after (daily cron)
// Secrets (shared project secrets): ANTHROPIC_API_KEY, ANTHROPIC_WORKSPACE_ID, RESEND_API_KEY,
//   STRIPE_SECRET_KEY. Optional: CITED_MODEL, CITED_FROM.

import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10 });

const MODEL = Deno.env.get("CITED_MODEL") ?? "claude-sonnet-5-5";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ANTHROPIC_WS = Deno.env.get("ANTHROPIC_WORKSPACE_ID") ?? "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const FROM = Deno.env.get("CITED_FROM") ?? "Cited <cited@getsokra.com>";
const REPLY_TO = "salman@llcreativityllc.com";
const OWNER_EMAIL = "salman@llcreativityllc.com";
const IP_SALT = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RECHECK_DAYS = 45;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cited-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));

type Vertical = "cpa" | "tax_prep" | "jeweler";
const VERTICALS = new Set<Vertical>(["cpa", "tax_prep", "jeweler"]);
const KIND: Record<Vertical, string> = { cpa: "accounting firm", tax_prep: "tax preparation office", jeweler: "jewelry store" };

function questionsFor(v: Vertical, city: string, state: string): string[] {
  const at = `${city}, ${state}`;
  if (v === "jeweler") return [
    `Where's the best place to buy an engagement ring in ${at}?`,
    `Can you recommend a local jeweler in ${at} who does custom engagement rings?`,
    `Who does reliable jewelry repair in ${at}?`,
    `I want to buy a nice anniversary gift. Which jewelry store in ${at} should I go to?`,
    `What's a trustworthy independent jewelry store near ${at}?`,
    `Where should we buy wedding bands in ${at}?`,
  ];
  if (v === "tax_prep") return [
    `Who's a good tax preparer in ${at}?`,
    `I'm self-employed. Who can do my taxes this year in ${at}?`,
    `I got a letter from the IRS. Who in ${at} can help me deal with it?`,
    `Is there an enrolled agent in ${at} you'd recommend?`,
    `Where can I get my taxes done in ${at} for a fair price?`,
    `Who does bookkeeping for small businesses in ${at}?`,
  ];
  return [
    `Who are the best CPA firms in ${at}?`,
    `I own a small business in ${at}. Which accountant or CPA should I hire for taxes and bookkeeping?`,
    `Can you recommend a tax preparer in ${at} for someone who is self-employed?`,
    `Which CPA firm in ${at} is good at small business tax planning?`,
    `I got a letter from the IRS. Which tax professional in ${at} should I call?`,
    `What's a good accounting firm near ${at} for a growing company?`,
  ];
}

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function cfg(key: string): Promise<string | null> {
  const r = await sql`select value from cited.config where key = ${key}`;
  return r[0]?.value ?? null;
}
async function log(kind: string, audit_id: string | null, meta: unknown = null) {
  try { await sql`insert into cited.events (kind, audit_id, meta) values (${kind}, ${audit_id}, ${meta ? sql.json(meta as never) : null})`; } catch { /* non-fatal */ }
}
function bg(p: Promise<unknown>) {
  try { (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(p); } catch { /* run unawaited */ }
}
function domainOf(u: string | null | undefined): string | null {
  if (!u) return null;
  try { return new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; }
}
async function internalOk(req: Request) {
  const want = await cfg("internal_token");
  return !!want && req.headers.get("x-cited-token") === want;
}

// ─── Claude ───
const anthropicHeaders = (beta?: string) => ({
  "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json",
  ...(ANTHROPIC_WS ? { "anthropic-workspace-id": ANTHROPIC_WS } : {}),
  ...(beta ? { "anthropic-beta": beta } : {}),
});

function parseLooseJson(raw: string): Record<string, unknown> {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no json object in response");
  return JSON.parse(m[0]);
}

type Usage = { in: number; out: number };
async function claudeText(system: string, user: string, maxTokens: number, usage?: Usage): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: anthropicHeaders(),
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const b = await r.json();
  if (!r.ok) throw new Error(b?.error?.message ?? "claude error");
  if (usage) { usage.in += b?.usage?.input_tokens ?? 0; usage.out += b?.usage?.output_tokens ?? 0; }
  return (b.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
}

// The assistant persona deliberately does NOT know which business is being checked, so the
// answer is what a member of the public would actually see.
const ASSISTANT_SYSTEM = `You are a helpful AI assistant answering a member of the public. Search the web, then answer the question the way a consumer AI assistant normally would: when the person asks for a recommendation, name specific local businesses (aim for 3 to 6) with one short reason each, based on what you found. Plain text, no markdown tables. Keep it under 220 words.`;

const SEARCH_TOOL_ATTEMPTS: { tool: string; beta?: string }[] = [
  { tool: "web_search_20250305" },
  { tool: "web_search_20250305", beta: "web-search-2025-03-05" },
  { tool: "web_search" },
];

type Answer = { q: string; qi: number; run: number; text: string; sources: { url: string; title: string | null }[]; searches: number; error?: string };

async function askWithSearch(question: string, qi: number, run: number, usage: Usage): Promise<Answer> {
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const att of SEARCH_TOOL_ATTEMPTS) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 100_000);
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: anthropicHeaders(att.beta), signal: ctl.signal,
          body: JSON.stringify({
            model: MODEL, max_tokens: 1500, system: ASSISTANT_SYSTEM,
            tools: [{ type: att.tool, name: "web_search", max_uses: 3 }],
            messages: [{ role: "user", content: question }],
          }),
        });
        const b = await r.json();
        if (!r.ok) {
          lastErr = String(b?.error?.message ?? r.status);
          if (r.status === 429 || r.status === 529 || r.status >= 500) break; // retry after a pause
          if (!/tool|web_search|beta/i.test(lastErr)) return { q: question, qi, run, text: "", sources: [], searches: 0, error: lastErr };
          continue;
        }
        usage.in += b?.usage?.input_tokens ?? 0; usage.out += b?.usage?.output_tokens ?? 0;
        const blocks = (b.content ?? []) as Record<string, any>[];
        const text = blocks.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
        const seen = new Map<string, string | null>();
        for (const c of blocks) {
          if (c.type === "web_search_tool_result" && Array.isArray(c.content)) {
            for (const x of c.content) if (x?.url && !seen.has(x.url)) seen.set(x.url, x.title ?? null);
          }
          if (c.type === "text" && Array.isArray(c.citations)) {
            for (const x of c.citations) if (x?.url && !seen.has(x.url)) seen.set(x.url, x.title ?? null);
          }
        }
        const searches = Number(b?.usage?.server_tool_use?.web_search_requests ?? 0);
        return { q: question, qi, run, text, sources: [...seen].map(([url, title]) => ({ url, title })), searches };
      } catch (e) {
        lastErr = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
        break;
      } finally { clearTimeout(timer); }
    }
    await new Promise((r) => setTimeout(r, 4000 + Math.random() * 4000));
  }
  return { q: question, qi, run, text: "", sources: [], searches: 0, error: lastErr || "failed" };
}

const EXTRACT_SYSTEM = `You analyse how visible one local business is in AI-assistant answers. You get the target business (name, type, optional website) and a set of answers an AI assistant gave to members of the public; each question was asked more than once, so you see several answers per question. For each answer, record whether it clearly names the target (minor spelling or suffix differences like LLC/PA/CPAs/Jewelers are fine; a different business with a similar name is not), and list every OTHER business it recommends, in order. Use one consistent name for each business across all answers. Never invent businesses that are not in the answers. Exclude the target from "others".

Then write fixes: concrete actions that would make an AI assistant more likely to name the target for these questions. Base them on the evidence: which sources the answers relied on (given as domains with counts) and what the named competitors seem to have. Each fix must be doable by a small business in under a week. No generic SEO filler. If the business type is a tax preparation office, never call it a CPA or CPA firm and never suggest wording that implies CPA status.

Respond with ONLY a JSON object:
{
  "per_answer": [ { "i": 0, "mentioned": false, "rank": null, "others": ["Business A", "Business B"] } ],
  "headline": "one sentence, plain, specific, written to the owner; refer to 'the AI assistant' (singular); give the count as 'X of N answers'",
  "fixes": [ { "title": "short imperative", "why": "one sentence tied to the evidence", "how": "two or three concrete sentences" } ]
}
per_answer: one entry per answer, by its i. rank: the target's position among businesses named, or null. fixes: exactly 5.`;

async function runAudit(id: string) {
  const r = await sql`select * from cited.audits where id = ${id}`;
  const a = r[0];
  if (!a || a.status === "done") return;
  const runs = Math.max(1, Math.min(3, Number(await cfg("runs") ?? 2)));
  await sql`update cited.audits set status = 'running', model = ${MODEL}, runs = ${runs} where id = ${id}`;
  const t0 = Date.now();
  const usage: Usage = { in: 0, out: 0 };
  try {
    const v = (VERTICALS.has(a.vertical) ? a.vertical : "cpa") as Vertical;
    const qs = questionsFor(v, a.city, a.state);
    const jobs: Promise<Answer>[] = [];
    for (let run = 0; run < runs; run++) qs.forEach((q, qi) => jobs.push(askWithSearch(q, qi, run, usage)));
    const answers = await Promise.all(jobs);
    const good = answers.filter((x) => x.text);
    if (good.length < Math.ceil(answers.length / 2)) throw new Error("too few answers: " + answers.map((x) => x.error).filter(Boolean).slice(0, 3).join("; "));

    // Source domains the assistant leaned on, counted per answer (not model-reported).
    const domCount = new Map<string, number>();
    for (const ans of good) {
      const ds = new Set(ans.sources.map((s) => domainOf(s.url)).filter((d): d is string => !!d));
      for (const d of ds) domCount.set(d, (domCount.get(d) ?? 0) + 1);
    }
    const domains = [...domCount].sort((x, y) => y[1] - x[1]).map(([domain, answers]) => ({ domain, answers }));
    const target = domainOf(a.website);
    const citedAsSource = target ? good.filter((ans) => ans.sources.some((s) => domainOf(s.url) === target)).length : 0;

    const payload = {
      target: a.firm_name, business_type: KIND[v], target_website: a.website ?? null, city: a.city, state: a.state,
      source_domains: domains.slice(0, 15),
      answers: answers.map((x, i) => ({ i, question: x.q, answer: x.text || "(no answer)" })),
    };
    const ext = parseLooseJson(await claudeText(EXTRACT_SYSTEM, JSON.stringify(payload), 6000, usage));
    const perAnswer = (Array.isArray(ext.per_answer) ? ext.per_answer : []) as { i: number; mentioned: boolean; rank: number | null; others: string[] }[];
    const byI = new Map(perAnswer.map((p) => [p.i, p]));

    const asked = good.length;
    let mentioned = 0;
    const compCount = new Map<string, number>();
    const perQuestion = qs.map((q, qi) => {
      const mine = answers.map((x, i) => ({ x, i })).filter(({ x }) => x.qi === qi && x.text);
      let named = 0;
      const others: string[] = [];
      for (const { i } of mine) {
        const p = byI.get(i);
        if (!p) continue;
        if (p.mentioned) named++;
        for (const o of p.others ?? []) if (!others.includes(o)) others.push(o);
      }
      mentioned += named;
      return { i: qi, q, runs: mine.length, named_count: named, mentioned: named > 0, firms_named: others };
    });
    for (const p of perAnswer) {
      if (!answers[p.i]?.text) continue;
      for (const o of new Set(p.others ?? [])) compCount.set(o, (compCount.get(o) ?? 0) + 1);
    }
    const competitors = [...compCount].sort((x, y) => y[1] - x[1]).map(([name, times_named]) => ({ name, times_named }));
    const score = asked ? Math.round((mentioned / asked) * 100) : 0;

    const result = {
      vertical: v, asked, mentioned, score, runs,
      cited_as_source: citedAsSource,
      headline: ext.headline ?? null,
      per_question: perQuestion,
      per_answer: perAnswer,
      competitors: competitors.slice(0, 15),
      source_domains: domains.slice(0, 12),
      fixes: Array.isArray(ext.fixes) ? (ext.fixes as unknown[]).slice(0, 5) : [],
      engine: { model: MODEL, assistant: "Claude with live web search", run_at: new Date().toISOString() },
    };
    const searches = answers.reduce((s, x) => s + x.searches, 0);
    await sql`update cited.audits set status = 'done', queries = ${sql.json(qs as never)}, answers = ${sql.json(answers as never)},
      result = ${sql.json(result as never)}, score = ${score}, searches = ${searches}, tokens_in = ${usage.in}, tokens_out = ${usage.out},
      finished_at = now(), error = null where id = ${id}`;
    await log("audit_done", id, { score, ms: Date.now() - t0, searches, tin: usage.in, tout: usage.out });
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    await sql`update cited.audits set status = 'error', error = ${msg}, tokens_in = ${usage.in}, tokens_out = ${usage.out}, finished_at = now() where id = ${id}`;
    await log("audit_error", id, { msg, ms: Date.now() - t0 });
  }
}

// ─── Fix pack (what a paying business receives) ───
const FIXPACK_SYSTEM = `You prepare a ready-to-use "AI visibility fix pack" for a small local business, from its AI-visibility audit. Everything must be usable as written: copy the owner can paste into their website, Google Business Profile and directory listings, plus a brief they can forward to whoever manages their website. Use only facts present in the input. Where you need a fact you do not have (founding year, credentials, exact services, phone, hours), write it as [BRACKETED PLACEHOLDER]; never invent it. Plain, specific, no hype. If the business type is a tax preparation office, never call it a CPA or CPA firm or imply CPA status.

Respond with ONLY a JSON object:
{
  "about": "a 120-160 word factual About paragraph, third person, stating plainly who the business serves, where, and for what: the kind of text AI assistants quote",
  "gbp_description": "a Google Business Profile description under 700 characters",
  "faq": [ { "q": "question phrased exactly as a customer asks an AI assistant", "a": "60-100 word answer naming the business and city" } ],
  "schema_jsonld": "a complete JSON-LD <script> block using the most specific schema.org type (AccountingService, JewelryStore, or ProfessionalService) with placeholders",
  "listings": [ { "site": "domain", "action": "what to claim or update there and why, from the audit evidence" } ],
  "vendor_brief": "a short email the owner can forward to their web person: what to add to which pages, where the schema goes, and why, in plain numbered steps",
  "plan_30_days": [ { "week": 1, "tasks": ["..."] } ]
}
faq: 8 items covering the audit's questions. listings: 4 to 8, prioritising domains the audit shows the assistant relied on. plan_30_days: 4 weeks.`;

async function buildFixpack(id: string) {
  const r = await sql`select firm_name, website, city, state, vertical, result, fixpack from cited.audits where id = ${id}`;
  const a = r[0];
  if (!a || a.fixpack || !a.result) return;
  try {
    const v = (VERTICALS.has(a.vertical) ? a.vertical : "cpa") as Vertical;
    const fp = parseLooseJson(await claudeText(FIXPACK_SYSTEM, JSON.stringify({ business: a.firm_name, business_type: KIND[v], website: a.website, city: a.city, state: a.state, audit: a.result }), 10000));
    await sql`update cited.audits set fixpack = ${sql.json(fp as never)}, fixpack_at = now() where id = ${id}`;
    await log("fixpack_done", id);
  } catch (e) { await log("fixpack_error", id, { msg: (e as Error).message }); }
}

// ─── Email / Stripe ───
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_KEY) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to, subject, html, reply_to: REPLY_TO }),
    });
    return r.ok;
  } catch { return false; }
}
async function stripe(path: string, form: Record<string, string> | null) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method: form ? "POST" : "GET",
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  const b = await r.json();
  if (!r.ok) throw new Error(b?.error?.message ?? "stripe error");
  return b;
}
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const FOOT = `<p style="color:#777;font-size:12px">Cited by LLCreativity LLC · 11185 Egeria Dr, Odessa, FL 33556</p>`;

// ─── 45-day re-check ───
async function runRechecks(): Promise<number> {
  const due = await sql`select id, firm_name, website, city, state, vertical, email, score, result from cited.audits
    where paid = true and parent_id is null and rechecked_at is null and recheck_due_at <= now() order by recheck_due_at limit 1`;
  const appUrl = (await cfg("app_url")) ?? "";
  for (const a of due) {
    await sql`update cited.audits set rechecked_at = now() where id = ${a.id}`;
    const ins = await sql`insert into cited.audits (firm_name, website, city, state, vertical, email, source, parent_id)
      values (${a.firm_name}, ${a.website}, ${a.city}, ${a.state}, ${a.vertical}, ${a.email}, 'recheck', ${a.id}) returning id`;
    const nid = ins[0].id as string;
    await runAudit(nid);
    const n = (await sql`select status, result from cited.audits where id = ${nid}`)[0];
    if (n?.status !== "done") { await log("recheck_error", a.id, { nid }); continue; }
    const before = `${a.result?.mentioned ?? 0} of ${a.result?.asked ?? 0}`, after = `${n.result.mentioned} of ${n.result.asked}`;
    const improved = (n.result.mentioned / Math.max(1, n.result.asked)) > ((a.result?.mentioned ?? 0) / Math.max(1, a.result?.asked ?? 1));
    const link = `${appUrl}/r.html?id=${nid}`;
    const body = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;color:#111">
      <p>It's been ${RECHECK_DAYS} days, so we re-ran your AI visibility check for ${esc(a.firm_name)}.</p>
      <p><b>Before: named in ${before} answers. Now: named in ${after}.</b></p>
      <p>Full new report: <a href="${esc(link)}">${esc(link)}</a></p>
      ${improved ? "" : "<p>You weren't named more often, so you're covered by our guarantee: reply to this email and we'll refund you in full.</p>"}
      ${FOOT}</div>`;
    if (a.email) await sendEmail(a.email, `${a.firm_name}: your ${RECHECK_DAYS}-day AI visibility re-check`, body);
    await sendEmail(OWNER_EMAIL, `Re-check done: ${a.firm_name} ${before} → ${after}${improved ? "" : " (refund owed if asked)"}`, body);
    await log("recheck_done", a.id, { nid, before, after, improved });
  }
  return due.length;
}

// ─── Router ───
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/cited-api/, "") || "/";

  if (req.method === "GET" && (path === "/" || path === "/health")) {
    let db = false; try { await sql`select 1`; db = true; } catch { /* down */ }
    return json({ ok: true, db, has_key: !!ANTHROPIC_KEY, has_email: !!RESEND_KEY, has_stripe: !!STRIPE_KEY, stripe_mode: STRIPE_KEY.startsWith("sk_live") || STRIPE_KEY.startsWith("rk_live") ? "live" : (STRIPE_KEY ? "test" : null), model: MODEL, price_cents: Number(await cfg("price_cents") ?? 29700) });
  }

  if (req.method === "GET" && path.startsWith("/audit/")) {
    const id = path.slice(7);
    if (!isUuid(id)) return json({ error: "bad id" }, 400);
    const r = await sql`select id, created_at, firm_name, website, city, state, vertical, runs, status, queries, answers, result, score, finished_at, paid, fixpack, parent_id from cited.audits where id = ${id}`;
    const a = r[0];
    if (!a) return json({ error: "not found" }, 404);
    const answers = Array.isArray(a.answers) ? (a.answers as Answer[]).map((x) => ({ q: x.q, qi: x.qi ?? null, run: x.run ?? 0, text: x.text, sources: (x.sources ?? []).slice(0, 6) })) : null;
    return json({ ok: true, ...a, answers, price_cents: Number(await cfg("price_cents") ?? 29700), error: a.status === "error" ? "The check didn't finish. Run it again in a minute." : null, fixpack: a.paid ? a.fixpack : null });
  }

  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const s = (k: string, n = 160) => (body[k] ?? "").toString().trim().slice(0, n);

  if (path === "/internal/recheck") {
    if (!(await internalOk(req))) return json({ error: "unauthorized" }, 401);
    const n = await runRechecks();
    return json({ ok: true, ran: n });
  }

  if (path === "/audit" || path === "/internal/audit") {
    const internal = path === "/internal/audit";
    if (internal && !(await internalOk(req))) return json({ error: "unauthorized" }, 401);
    if (s("hp")) return json({ ok: true, id: null }); // honeypot
    const firm = s("firm_name", 120), city = s("city", 80), state = s("state", 2).toUpperCase();
    const vRaw = s("vertical", 12) as Vertical;
    const vertical: Vertical = VERTICALS.has(vRaw) ? vRaw : "cpa";
    const website = s("website", 200) || null;
    const emailRaw = s("email", 200).toLowerCase();
    const email = EMAIL_RE.test(emailRaw) ? emailRaw : null;
    if (firm.length < 2 || city.length < 2 || !STATES.has(state)) return json({ error: "Business name, city and state are required." }, 400);
    if (!ANTHROPIC_KEY) return json({ error: "Checks are paused for maintenance. Try again shortly." }, 503);

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "";
    const ipHash = ip ? (await sha(IP_SALT + "|" + ip)).slice(0, 32) : null;
    if (!internal) {
      if (ipHash) {
        const c = await sql`select count(*)::int as n from cited.audits where ip_hash = ${ipHash} and created_at >= now() - interval '1 hour'`;
        if ((c[0]?.n ?? 0) >= 3) return json({ error: "That's a few checks from one connection. Try again in an hour." }, 429);
      }
      const cap = Number(await cfg("daily_cap") ?? 40);
      const d = await sql`select count(*)::int as n from cited.audits where created_at >= now() - interval '1 day' and coalesce(source,'') not in ('internal','recheck')`;
      if ((d[0]?.n ?? 0) >= cap) return json({ error: "Today's free checks are used up. Try again tomorrow." }, 429);
    }
    // Same business checked in the last day: return that report instead of paying for a new run.
    const dup = await sql`select id from cited.audits where lower(firm_name) = lower(${firm}) and lower(city) = lower(${city}) and state = ${state} and vertical = ${vertical}
      and status in ('queued','running','done') and created_at >= now() - interval '1 day' and parent_id is null order by created_at desc limit 1`;
    if (dup[0]) return json({ ok: true, id: dup[0].id, reused: true });
    const ins = await sql`insert into cited.audits (firm_name, website, city, state, vertical, email, source, ip_hash)
      values (${firm}, ${website}, ${city}, ${state}, ${vertical}, ${email}, ${internal ? "internal" : (s("source", 60) || "site")}, ${ipHash}) returning id`;
    const id = ins[0].id as string;
    await log("audit_started", id, { internal, vertical });
    bg(runAudit(id));
    return json({ ok: true, id });
  }

  if (path === "/checkout") {
    if (!STRIPE_KEY) return json({ error: "Checkout isn't open yet." }, 503);
    const id = s("id", 40);
    if (!isUuid(id)) return json({ error: "id required" }, 400);
    const r = await sql`select id, firm_name, email, paid, status from cited.audits where id = ${id}`;
    const a = r[0];
    if (!a || a.status !== "done") return json({ error: "not found" }, 404);
    if (a.paid) return json({ ok: true, already: true });
    const appUrl = (await cfg("app_url")) ?? "";
    if (!appUrl) return json({ error: "Checkout isn't open yet." }, 503);
    const price = Number(await cfg("price_cents") ?? 29700);
    try {
      const sess = await stripe("checkout/sessions", {
        mode: "payment",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(price),
        "line_items[0][price_data][product_data][name]": (await cfg("product_name")) ?? "Cited AI visibility fix pack",
        "line_items[0][price_data][product_data][description]": `Fix pack and ${RECHECK_DAYS}-day re-check for ${a.firm_name}`.slice(0, 500),
        "line_items[0][quantity]": "1",
        success_url: `${appUrl}/r.html?id=${a.id}&cs={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/r.html?id=${a.id}`,
        client_reference_id: a.id,
        "metadata[audit_id]": a.id,
        ...(a.email ? { customer_email: a.email } : {}),
        allow_promotion_codes: "true",
      });
      await sql`update cited.audits set stripe_session_id = ${sess.id} where id = ${a.id}`;
      await log("checkout_started", a.id);
      return json({ ok: true, url: sess.url });
    } catch (e) { await log("checkout_error", a.id, { msg: (e as Error).message }); return json({ error: "Couldn't open checkout. Try again." }, 502); }
  }

  if (path === "/confirm") {
    const id = s("id", 40), sid = s("session_id", 200);
    if (!isUuid(id) || !/^cs_[A-Za-z0-9_]+$/.test(sid)) return json({ error: "id and session_id required" }, 400);
    try {
      const sess = await stripe("checkout/sessions/" + sid, null);
      if ((sess.metadata?.audit_id ?? sess.client_reference_id) !== id) return json({ error: "not found" }, 404);
      if (sess.payment_status !== "paid") return json({ ok: true, paid: false });
      const was = await sql`select paid, firm_name, city, state from cited.audits where id = ${id}`;
      if (!was[0]) return json({ error: "not found" }, 404);
      if (!was[0].paid) {
        const email = sess.customer_details?.email ?? sess.customer_email ?? null;
        await sql`update cited.audits set paid = true, paid_at = now(), recheck_due_at = now() + make_interval(days => ${RECHECK_DAYS}),
          stripe_session_id = ${sess.id}, stripe_customer = ${sess.customer ?? null}, amount_paid_cents = ${sess.amount_total ?? null},
          email = coalesce(email, ${email}) where id = ${id}`;
        await log("paid", id, { amount: sess.amount_total });
        const appUrl = (await cfg("app_url")) ?? "";
        const link = `${appUrl}/r.html?id=${id}`;
        bg((async () => {
          await buildFixpack(id);
          if (email) await sendEmail(email, `Your Cited fix pack for ${was[0].firm_name}`,
            `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;color:#111"><p>Thanks for your order.</p><p>Your fix pack is on your report page: an About section, Google Business Profile description, 8 FAQ answers, schema markup, a brief you can forward to your web person, and a 30-day plan.</p><p><a href="${esc(link)}">${esc(link)}</a></p><p>In ${RECHECK_DAYS} days we'll re-run your check and email you the before and after. If you aren't named more often, reply and we'll refund you in full.</p>${FOOT}</div>`);
          await sendEmail(OWNER_EMAIL, `New Cited order: ${was[0].firm_name} (${was[0].city}, ${was[0].state})`,
            `<p>${esc(was[0].firm_name)} bought the fix pack. Report: <a href="${esc(link)}">${esc(link)}</a></p>`);
        })());
      }
      return json({ ok: true, paid: true });
    } catch (e) { await log("confirm_error", id, { msg: (e as Error).message }); return json({ error: "Couldn't confirm yet." }, 502); }
  }

  return json({ error: "not found" }, 404);
});
