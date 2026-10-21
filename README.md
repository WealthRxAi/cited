# Cited

AI-visibility reports for CPA firms, by LLCreativity LLC.

- `site/` — static landing page (`index.html`) and report page (`r.html`), deployed on Vercel.
- `supabase/functions/cited-api/` — the API (Supabase edge function on project `igussyvvpcrgriugnvlx`, schema `cited`).
  It asks Claude with live web search six prospect questions, records which firms get named, scores the target firm,
  sells a $149/month plan through Stripe Checkout, and writes the paid fix pack.
