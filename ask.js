/* Ask SoleSight — a conversational analyst over data.json.
 *
 * Dual-engine, mirroring the pipeline's own llm.py/rules.py philosophy:
 *   1. RULES  — a deterministic intent engine that answers the common analyst
 *      questions for every visitor, no key required, zero hallucination risk.
 *   2. CLAUDE — genuine agentic tool-use: bring-your-own Anthropic API key
 *      (stored ONLY in your browser's localStorage), and the model answers
 *      free-form questions by calling data tools; every number comes from a
 *      tool result, not the model's memory.
 */
"use strict";

const KEY_STORE = "solesight_anthropic_key";
const ASK_MODEL = "claude-haiku-4-5-20251001";
let ASK_BUSY = false;
const CHAT = [];   // Anthropic-format history for the LLM path

/* ---------------- boot ---------------- */
function askInit() {
  const el = document.createElement("div");
  el.innerHTML = `
    <button class="ask-fab" id="ask-fab" aria-label="Ask SoleSight">
      <span class="ask-fab-dot"></span> Ask SoleSight</button>
    <div class="ask-panel" id="ask-panel" aria-hidden="true">
      <div class="ask-head">
        <div><b>Ask SoleSight</b><span class="ask-engine" id="ask-engine"></span></div>
        <div class="ask-head-btns">
          <button id="ask-key-btn" title="Connect an Anthropic API key"
                  aria-label="Connect an Anthropic API key">⚙</button>
          <button id="ask-close" aria-label="Close">×</button>
        </div>
      </div>
      <div class="ask-msgs" id="ask-msgs" role="log" aria-live="polite"></div>
      <div class="ask-chips" id="ask-chips"></div>
      <form class="ask-inputrow" id="ask-form">
        <input id="ask-input" type="text" autocomplete="off"
               aria-label="Ask about hype, momentum, brands, restocks"
               placeholder="Ask about hype, momentum, brands, restocks…" />
        <button type="submit">→</button>
      </form>
    </div>`;
  document.body.appendChild(el);

  $("#ask-fab").onclick = askToggle;
  $("#ask-close").onclick = askToggle;
  $("#ask-key-btn").onclick = askKeyDialog;
  $("#ask-form").onsubmit = (e) => { e.preventDefault(); askSend(); };
  askEngineLabel();
  askChips();
  askSay("bot", `Hey — I'm the SoleSight analyst. I can rank the index, compare
    brands, surface risers, and suggest restock candidates, all from tonight's
    data. Try a chip below, or connect an Anthropic key (⚙) for free-form
    questions answered with real tool-use.`, "rules");
}

function askToggle() {
  const p = $("#ask-panel");
  const open = p.classList.toggle("open");
  p.setAttribute("aria-hidden", String(!open));
  if (open) $("#ask-input").focus();
}

function askEngineLabel() {
  $("#ask-engine").textContent = localStorage.getItem(KEY_STORE)
    ? "· Claude tool-use + rules" : "· rule-based engine (no key needed)";
}

function askChips() {
  const chips = ["Top 5 right now", "What just spiked?", "Which ASICS are rising?",
                 "Compare Jordan vs adidas", "What should a boutique restock?"];
  $("#ask-chips").innerHTML = chips.map((c) =>
    `<button class="ask-chip">${c}</button>`).join("");
  $$("#ask-chips .ask-chip").forEach((b) =>
    (b.onclick = () => { $("#ask-input").value = b.textContent; askSend(); }));
}

function askKeyDialog() {
  const cur = localStorage.getItem(KEY_STORE) || "";
  const v = prompt(
    "Paste an Anthropic API key to enable free-form questions (Claude answers " +
    "by querying the index's data tools).\n\nThe key is stored only in THIS " +
    "browser's localStorage and sent only to api.anthropic.com. Leave empty to " +
    "remove.", cur);
  if (v === null) return;
  if (v.trim()) localStorage.setItem(KEY_STORE, v.trim());
  else localStorage.removeItem(KEY_STORE);
  askEngineLabel();
}

function askSay(who, html, engine) {
  const tag = engine ? `<div class="ask-src">${engine === "llm"
    ? "Claude · agentic tool-use" : "rule-based analyst · deterministic"}</div>` : "";
  $("#ask-msgs").insertAdjacentHTML("beforeend",
    `<div class="ask-msg ${who}"><div class="ask-bubble">${html}${tag}</div></div>`);
  $("#ask-msgs").scrollTop = $("#ask-msgs").scrollHeight;
}

async function askSend() {
  const q = $("#ask-input").value.trim();
  if (!q || ASK_BUSY || !DATA) return;
  $("#ask-input").value = "";
  askSay("user", esc(q));
  ASK_BUSY = true;
  try {
    const ruled = askRules(q);
    if (ruled) {
      askSay("bot", ruled, "rules");
    } else if (localStorage.getItem(KEY_STORE)) {
      askSay("bot", `<span class="ask-think">thinking — querying the index…</span>`);
      const ans = await askClaude(q);
      $("#ask-msgs").lastElementChild.remove();
      askSay("bot", ans, "llm");
    } else {
      askSay("bot", `I couldn't map that to one of my built-in questions. Try a
        chip below — or connect an Anthropic API key (⚙ above) and I'll answer
        free-form questions with real tool-use over the data.`, "rules");
    }
  } catch (err) {
    askSay("bot", `Something went wrong: ${esc(err.message)}`, "rules");
  } finally {
    ASK_BUSY = false;
  }
}

/* ---------------- shared data helpers (both engines) ---------------- */
const fmtRow = (m, extra) => `<li><b>${esc(m.name)}</b> — hype ${m.hype ?? "—"}${
  extra ? ` · ${extra(m)}` : ""}</li>`;
const olist = (ms, extra) => `<ol>${ms.map((m) => fmtRow(m, extra)).join("")}</ol>`;

function findBrand(text) {
  return DATA.brands.filter((b) => text.toLowerCase().includes(b.toLowerCase()));
}
function findCategory(text) {
  return DATA.categories.filter((c) => text.toLowerCase().includes(c));
}
function fuzzyModel(text) {
  const t = text.toLowerCase();
  // exact full-name inclusion wins outright
  const exact = DATA.models.filter((m) => t.includes(m.name.toLowerCase()));
  if (exact.length) return exact;
  // otherwise require every distinctive word of the model's name (≥2 of them)
  return DATA.models.filter((m) => {
    const words = m.name.toLowerCase().split(/[\s-]+/).filter((w) => w.length > 2);
    return words.length >= 2 && words.every((w) => t.includes(w));
  });
}
function pool(brands, cats) {
  return DATA.models.filter((m) =>
    (!brands.length || brands.includes(m.brand)) &&
    (!cats.length || cats.includes(m.category)));
}

/* ---------------- engine 1: deterministic intents ---------------- */
function askRules(q) {
  const t = q.toLowerCase();
  const brands = findBrand(t);
  const cats = findCategory(t);
  const P = pool(brands, cats);
  const scope = [...brands, ...cats].join(" + ") || "the index";

  if (/spik|just (dropped|launched)|demand event|launch radar/.test(t)) {
    const ev = DATA.radar?.events?.slice(0, 5) || [];
    if (!ev.length) return "No demand events detected recently.";
    return `Most recent detected demand spikes:<ol>${ev.map((e) => {
      const m = DATA.models.find((x) => x.slug === e.slug);
      return `<li><b>${esc(m?.name || e.slug)}</b> — ${e.date}, ${e.multiple}×
        its baseline (${e.baseline} → ${e.peak})</li>`; }).join("")}</ol>`;
  }
  if (/restock|invest|buy|undervalued|stock up|order/.test(t)) {
    const picks = DATA.models
      .filter((m) => (m.momentum ?? -99) > 10 && (m.resale_premium ?? 9) < 1.25
                      && (m.hype ?? 0) > 35)
      .sort((a, b) => b.momentum - a.momentum).slice(0, 5);
    if (!picks.length) return `Nothing currently clears my restock screen
      (momentum > +10%, resale still under 1.25× retail).`;
    return `Restock candidates — demand is accelerating but resale hasn't priced
      it in yet (momentum > +10%, premium < 1.25×):${olist(picks,
      (m) => `${fmtSigned(m.momentum, "%")} momentum · ${m.resale_premium ?? "—"}× retail`)}
      <small>Demo signals where labeled — not financial advice.</small>`;
  }
  if (/(rising|gaining|momentum|climbing|heating up|trending up)/.test(t)) {
    const ms = P.filter((m) => m.momentum != null)
      .sort((a, b) => b.momentum - a.momentum).slice(0, 5);
    return `Fastest-rising in ${scope} by 14-day search momentum:${olist(ms,
      (m) => `${fmtSigned(m.momentum, "%")}`)}`;
  }
  if (/(falling|cooling|declining|dropping|losing)/.test(t)) {
    const ms = P.filter((m) => m.momentum != null)
      .sort((a, b) => a.momentum - b.momentum).slice(0, 5);
    return `Cooling fastest in ${scope}:${olist(ms, (m) => `${fmtSigned(m.momentum, "%")}`)}`;
  }
  if (/emerging|dormant|peaking|steady|lifecycle|stage/.test(t)) {
    const st = ["emerging", "heating", "peaking", "steady", "cooling", "dormant"]
      .find((s) => t.includes(s));
    if (st) {
      const ms = DATA.models.filter((m) => m.stage === st).slice(0, 8);
      return `${ms.length ? "" : "None right now. "}Models in the
        <b>${st}</b> stage:${olist(ms.slice(0, 6))}`;
    }
  }
  if (/compare|vs\.?|versus/.test(t) && brands.length >= 2) {
    const rows = brands.map((b) => {
      const r = DATA.market.brands.find((x) => x.name === b);
      return `<li><b>${b}</b> — avg hype ${r?.avg_hype ?? "—"}, avg premium
        ${r?.avg_premium ?? "—"}×, momentum ${fmtSigned(r?.avg_momentum, "%")},
        ${r?.models ?? "?"} models</li>`; }).join("");
    return `Brand comparison (index averages):<ul>${rows}</ul>`;
  }
  if (/(top|best|hottest|highest|rank)/.test(t)) {
    const n = (t.match(/\b(\d{1,2})\b/) || [])[1] || 5;
    const ms = P.slice().sort((a, b) => (b.hype ?? 0) - (a.hype ?? 0)).slice(0, +n);
    return `Top ${ms.length} in ${scope} by Hype Score:${olist(ms,
      (m) => `${esc(m.brand)}${m.stage ? " · " + m.stage : ""}`)}`;
  }
  if (/how (fresh|old|many)|updated|data|observations/.test(t)) {
    const s = DATA.stats;
    const d = new Date(DATA.generated_at * 1000).toLocaleDateString("en-US",
      { month: "long", day: "numeric", year: "numeric" });
    return `Index refreshed <b>${d}</b> — ${s.models} models, ${s.brands} brands,
      ${s.daily_observations.toLocaleString()} daily observations,
      ${s.forecast_days} forecast days generated.`;
  }
  const hits = fuzzyModel(t);
  if (hits.length === 1) {
    const m = hits[0];
    return `<b>${esc(m.name)}</b> — rank #${m.rank}, hype <b>${m.hype}</b>,
      momentum ${fmtSigned(m.momentum, "%")}, resale ${m.resale_premium ?? "—"}×
      retail${m.stage ? `, stage: ${m.stage}` : ""}.<br><br>
      <em>${esc(m.insight || "")}</em>`;
  }
  return null;   // hand off to the LLM (or the capability hint)
}

/* ---------------- engine 2: Claude with tool-use ---------------- */
const ASK_TOOLS = [
  { name: "top_models",
    description: "Ranked models from the index. sort_by: hype|momentum|resale_premium|buzz. Optional brand, category (basketball/running/lifestyle/skate), stage, n (default 5).",
    input_schema: { type: "object", properties: {
      sort_by: { type: "string" }, brand: { type: "string" },
      category: { type: "string" }, stage: { type: "string" },
      n: { type: "integer" } } } },
  { name: "get_model",
    description: "Look up one model by (partial) name. Returns its full record: scores, momentum, resale, forecast, stage, insight.",
    input_schema: { type: "object", properties: { query: { type: "string" } },
      required: ["query"] } },
  { name: "market_overview",
    description: "Brand and category rollups (avg hype, premium, momentum), pipeline freshness stats, and the lifecycle stage distribution.",
    input_schema: { type: "object", properties: {} } },
  { name: "recent_events",
    description: "Recently detected demand spikes (date, multiple over baseline, retention).",
    input_schema: { type: "object", properties: {} } },
];

function askRunTool(name, args) {
  const strip = (m) => ({ name: m.name, brand: m.brand, category: m.category,
    rank: m.rank, hype: m.hype, momentum: m.momentum, buzz: m.buzz,
    sentiment: m.sentiment, resale_premium: m.resale_premium,
    resale_last: m.resale_last, retail: m.retail, stage: m.stage,
    forecast_peak_date: m.forecast_peak_date, insight: m.insight });
  if (name === "top_models") {
    const key = ["hype", "momentum", "resale_premium", "buzz"]
      .includes(args.sort_by) ? args.sort_by : "hype";
    let ms = DATA.models.filter((m) =>
      (!args.brand || m.brand.toLowerCase() === args.brand.toLowerCase()) &&
      (!args.category || m.category === args.category) &&
      (!args.stage || m.stage === args.stage));
    ms = ms.sort((a, b) => (b[key] ?? -1e9) - (a[key] ?? -1e9))
           .slice(0, Math.min(args.n || 5, 15));
    return ms.map(strip);
  }
  if (name === "get_model") {
    const hits = fuzzyModel(args.query || "");
    return hits.length ? strip(hits[0]) : { error: "no model matched" };
  }
  if (name === "market_overview")
    return { brands: DATA.market.brands, categories: DATA.market.categories,
             stats: DATA.stats, stages: DATA.radar?.stages };
  if (name === "recent_events") return DATA.radar?.events || [];
  return { error: "unknown tool" };
}

async function askClaude(q) {
  const key = localStorage.getItem(KEY_STORE);
  CHAT.push({ role: "user", content: q });
  const system =
    "You are the SoleSight analyst — concise, sharp, honest. SoleSight is an AI " +
    "hype index for sneakers (0-100 Hype Score from search demand, resale premium, " +
    "social buzz, sentiment, forecasts). ALWAYS ground numbers in tool results — " +
    "never invent data. Search/forecasts are live; resale & sentiment are demo " +
    "data until API keys are added; social buzz is modeled — mention this only " +
    "when directly relevant. Answer in 2-5 sentences or a short list. Plain text " +
    "only (no markdown headers).";
  for (let round = 0; round < 5; round++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: ASK_MODEL, max_tokens: 700, system,
        tools: ASK_TOOLS, messages: CHAT }),
    });
    if (!resp.ok) {
      CHAT.pop();
      const body = await resp.text();
      throw new Error(`Anthropic API ${resp.status} — check your key (⚙). ${body.slice(0, 120)}`);
    }
    const msg = await resp.json();
    CHAT.push({ role: "assistant", content: msg.content });
    if (msg.stop_reason !== "tool_use") {
      const text = msg.content.filter((b) => b.type === "text")
        .map((b) => b.text).join(" ");
      return esc(text).replace(/\n/g, "<br>");
    }
    const results = msg.content.filter((b) => b.type === "tool_use").map((b) => ({
      type: "tool_result", tool_use_id: b.id,
      content: JSON.stringify(askRunTool(b.name, b.input || {})).slice(0, 6000),
    }));
    CHAT.push({ role: "user", content: results });
  }
  return "I hit my tool budget — try a more specific question.";
}

/* boot once app.js has data */
(function waitForData() {
  if (typeof DATA !== "undefined" && DATA) askInit();
  else setTimeout(waitForData, 250);
})();
