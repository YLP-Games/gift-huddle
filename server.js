// Gift Huddle server: serves the web app, plus two optional endpoints.
//   POST /api/suggest  -> AI gift ideas (needs ANTHROPIC_API_KEY)
//   GET  /api/prices   -> live South African listings via Google Shopping (needs SERPAPI_KEY)
// Without the keys the app still works, using its built-in ranking only.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, ".env")); } catch { /* no .env file: keys may come from the environment */ }

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(here, "public");
const AI_ON = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const PRICES_ON = Boolean(process.env.SERPAPI_KEY);
const client = AI_ON ? new Anthropic() : null;

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".ico": "image/x-icon" };

const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const clip = (v, n) => String(v ?? "").slice(0, n);

// ---------- AI suggestions ----------
const Ideas = z.object({
  ideas: z.array(z.object({
    name: z.string().describe("Specific gift, e.g. 'AeroPress Go travel coffee maker'"),
    why: z.string().describe("One sentence linking the gift to what the friends said"),
    est_low: z.number().describe("Estimated low price in rand"),
    est_high: z.number().describe("Estimated high price in rand"),
    kind: z.enum(["ship", "digital", "exp", "custom", "make"]).describe(
      "ship = physical item that is posted or bought in a shop; digital = emailed voucher or subscription; exp = experience or event; custom = personalised or made to order; make = something the group makes themselves"),
    search_query: z.string().describe("Short phrase to type into a South African shopping search to find it"),
    shop_type: z.string().describe("Kind of physical shop that sells it, e.g. 'outdoor shop', or an empty string if none"),
  })),
});

const SYSTEM = `You help a group of friends in South Africa choose one shared gift for someone.

You get the traits the friends listed (with how many friends mentioned each), the recipient's location, a total budget in rand, and how many days are left before the gift is needed.

Suggest 8 gift ideas, best first. Good ideas are specific enough to search for and buy, and the strongest ones combine two or more traits or lean on traits several friends agreed on. Stay inside the budget: the friends are pooling money, so an idea near the top of the range is fine. Prefer things that can realistically be bought in South Africa, online or in the recipient's area, and include a mix of physical gifts and experiences where the traits suit it. If time is short, favour things that can be bought in a shop, booked, or emailed over anything made to order.

Price estimates are your best judgement of typical South African prices; the app checks live prices separately.`;

async function suggest(body) {
  const traits = (Array.isArray(body.traits) ? body.traits : []).slice(0, 40)
    .map(t => `- ${clip(t.label, 60)} (${Math.max(1, Math.min(50, Number(t.count) || 1))} friend${t.count > 1 ? "s" : ""})`).join("\n");
  if (!traits) return { status: 400, body: { error: "Add at least one trait first." } };
  const days = body.days == null ? "no deadline" : `${Number(body.days)} days from today`;
  const prompt = `Recipient: ${clip(body.recipient, 60) || "not given"}
Occasion: ${clip(body.occasion, 80) || "not given"}
Location: ${clip(body.location, 60) || "South Africa (city not given)"}
Total budget: R${Number(body.min) || 0} to R${Number(body.max) || 0}
Needed by: ${days}

What the friends said they like:
${traits}`;

  const msg = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",               // if a safety classifier declines, retry on a fallback model
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "low", format: betaZodOutputFormat(Ideas) },
  });
  if (msg.stop_reason === "refusal" || !msg.parsed_output) return { status: 502, body: { error: "The AI couldn't produce ideas for that. Try rewording the traits." } };
  return { status: 200, body: msg.parsed_output };
}

// ---------- Live prices (Google Shopping, South Africa, via SerpApi) ----------
const priceCache = new Map();           // key -> { at, items }
async function prices(q, min, max) {
  const key = `${q.toLowerCase()}|${min}|${max}`, hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < 3600e3) return hit.items;
  const url = new URL("https://serpapi.com/search.json");
  url.search = new URLSearchParams({ engine: "google_shopping", q, gl: "za", hl: "en", google_domain: "google.co.za", api_key: process.env.SERPAPI_KEY });
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Price lookup failed (${r.status})`);
  const data = await r.json();
  const items = (data.shopping_results || [])
    .filter(p => typeof p.extracted_price === "number" && p.extracted_price >= min && p.extracted_price <= max)
    .slice(0, 4)
    .map(p => ({ title: p.title, price: p.extracted_price, source: p.source, link: p.product_link || p.link, delivery: p.delivery || "" }));
  priceCache.set(key, { at: Date.now(), items });
  return items;
}

// ---------- HTTP ----------
async function readBody(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 20000) throw new Error("Request too large"); }
  return JSON.parse(raw || "{}");
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/status") return json(res, 200, { ai: AI_ON, prices: PRICES_ON });

    if (url.pathname === "/api/suggest" && req.method === "POST") {
      if (!AI_ON) return json(res, 503, { error: "AI is off. Add ANTHROPIC_API_KEY to the .env file and restart." });
      const out = await suggest(await readBody(req));
      return json(res, out.status, out.body);
    }

    if (url.pathname === "/api/prices") {
      if (!PRICES_ON) return json(res, 503, { error: "Live prices are off. Add SERPAPI_KEY to the .env file and restart." });
      const q = clip(url.searchParams.get("q"), 120).trim();
      if (!q) return json(res, 400, { error: "Missing search text." });
      const min = Number(url.searchParams.get("min")) || 0, max = Number(url.searchParams.get("max")) || Infinity;
      return json(res, 200, { items: await prices(q, min, max) });
    }

    // Static files
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: "Forbidden" });
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "EISDIR") return json(res, 404, { error: "Not found" });
    if (err instanceof Anthropic.AuthenticationError) return json(res, 502, { error: "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env." });
    if (err instanceof Anthropic.RateLimitError) return json(res, 429, { error: "The AI is busy right now. Try again in a minute." });
    if (err instanceof Anthropic.APIError) { console.error(err); return json(res, 502, { error: `AI request failed (${err.status ?? "network"}).` }); }
    console.error(err);
    json(res, 500, { error: err.message || "Something went wrong." });
  }
}).listen(PORT, () => console.log(`Gift Huddle running at http://localhost:${PORT}  (AI: ${AI_ON ? "on" : "off"}, live prices: ${PRICES_ON ? "on" : "off"})`));
