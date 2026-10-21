const API = "https://igussyvvpcrgriugnvlx.supabase.co/functions/v1/cited-api";
const STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");

// Short forms of the questions the engine asks, shown while a check runs.
const QUESTION_SETS = {
  cpa: (c) => [
    `Who are the best CPA firms in ${c}?`,
    `Which accountant should a small business in ${c} hire?`,
    `A tax preparer in ${c} for someone self-employed?`,
    `Which CPA firm in ${c} is good at small business tax planning?`,
    `Who do I call in ${c} about an IRS letter?`,
    `A good accounting firm near ${c} for a growing company?`,
  ],
  tax_prep: (c) => [
    `Who's a good tax preparer in ${c}?`,
    `Who can do my taxes in ${c}? I'm self-employed.`,
    `Who in ${c} can help with a letter from the IRS?`,
    `An enrolled agent in ${c} you'd recommend?`,
    `Where can I get my taxes done in ${c} for a fair price?`,
    `Who does small business bookkeeping in ${c}?`,
  ],
  jeweler: (c) => [
    `Where's the best place to buy an engagement ring in ${c}?`,
    `A local jeweler in ${c} who does custom engagement rings?`,
    `Who does reliable jewelry repair in ${c}?`,
    `Which jewelry store in ${c} for an anniversary gift?`,
    `A trustworthy independent jewelry store near ${c}?`,
    `Where should we buy wedding bands in ${c}?`,
  ],
};
const KIND_LABEL = { cpa: "firm", tax_prep: "office", jeweler: "store" };
const CUSTOMER = { cpa: "client", tax_prep: "client", jeweler: "customer" };

async function api(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Something went wrong (" + r.status + "). Try again.");
  return data;
}

// Build DOM without innerHTML so nothing from the report can inject markup.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// Shared form handler for the landing pages.
function wireCheckForm(defaultVertical) {
  const sel = document.getElementById("state");
  for (const s of STATES) { const o = document.createElement("option"); o.value = o.textContent = s; if (s === "FL") o.selected = true; sel.appendChild(o); }
  const form = document.getElementById("check"), status = document.getElementById("status");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.className = "status";
    const fd = Object.fromEntries(new FormData(form));
    if (!fd.firm_name.trim() || !fd.city.trim() || !fd.state) { status.textContent = "Add your business name, city and state to run the check."; status.className = "status err"; return; }
    const btn = form.querySelector("button"); const label = btn.textContent; btn.disabled = true; btn.textContent = "Starting the check…";
    try {
      const r = await api("/audit", { method: "POST", body: JSON.stringify({ vertical: defaultVertical, ...fd, source: new URLSearchParams(location.search).get("src") || "site" }) });
      if (!r.id) throw new Error("No report was created. Try again.");
      location.href = "/r.html?id=" + r.id;
    } catch (err) {
      status.textContent = err.message; status.className = "status err";
      btn.disabled = false; btn.textContent = label;
    }
  });
}
