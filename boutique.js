/* SoleSight — "For boutiques" reorder report.
   A store uploads its inventory CSV (Shopify export or any sheet with
   product / size / quantity columns). Everything runs in the browser: the
   file is never uploaded. Each row is matched to a tracked shoe (style code
   first, then name), then scored against tonight's index:
     - shoe:  reorder / hold / don't reorder, from Hype Score + stage
     - sizes: which to restock, from where sizes sell out across tracked
              boutiques and which sizes resell highest on eBay
     - colorways: what the market carries and prices
     - missing: hot shoes that aren't in the file at all
   Relies on DATA (loaded by app.js) and its helpers ($, esc, img, openSheet). */

/* ---------- CSV ---------- */
function bqParseCSV(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()])));
}

const BQ_COLS = {
  handle: ["handle"],
  title: ["title", "product", "product name", "name", "item", "description"],
  sku: ["variant sku", "sku", "style code", "style", "barcode"],
  size: ["size"],
  color: ["colorway", "color", "colour"],
  qty: ["available", "on hand", "variant inventory qty", "inventory", "quantity", "qty", "stock", "on_hand"],
  sold: ["sold", "units sold", "sold_30d", "sold 30d", "sales", "sold last 30 days"],
  price: ["variant price", "price", "your price", "selling price", "retail price"],
};
const bqPick = (row, key) => {
  for (const k of BQ_COLS[key]) if (row[k] != null && row[k] !== "") return row[k];
  return "";
};
const bqSize = (v) => {
  const m = String(v).match(/(\d{1,2}(?:\.5)?)/);
  return m ? String(parseFloat(m[1])) : null;
};

/* Normalize a sheet (Shopify products export, Shopify inventory export or a
   simple sheet) into [{title, sku, size, color, qty, sold}]. */
function bqRows(raw) {
  let lastTitle = {};
  return raw.map((r) => {
    const handle = bqPick(r, "handle");
    let title = bqPick(r, "title");
    if (title) lastTitle[handle] = title; else title = lastTitle[handle] || handle.replace(/-/g, " ");
    let size = bqPick(r, "size"), color = bqPick(r, "color");
    for (const n of [1, 2, 3]) {   // Shopify "Option1 Name / Option1 Value"
      const name = (r[`option${n} name`] || "").toLowerCase(), val = r[`option${n} value`] || "";
      if (!val) continue;
      if (!size && name.includes("size")) size = val;
      else if (!color && /colou?r/.test(name)) color = val;
    }
    const qty = parseFloat(bqPick(r, "qty"));
    const sold = parseFloat(bqPick(r, "sold"));
    const price = parseFloat(String(bqPick(r, "price")).replace(/[$,]/g, ""));
    return { title, sku: bqPick(r, "sku"), size: bqSize(size), color,
             qty: isNaN(qty) ? null : Math.max(0, qty), sold: isNaN(sold) ? null : sold,
             price: isNaN(price) || price <= 0 ? null : price };
  }).filter((r) => r.title);
}

/* ---------- matching to tracked shoes ---------- */
const BQ_STOP = new Set(["the", "x", "and", "mens", "men", "womens", "women", "gs", "size", "sz", "new", "retro", "og"]);
const bqTokens = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9.]+/g, " ").split(" ")
  .filter((t) => t && !BQ_STOP.has(t)));
const bqNorm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");

function bqMatch(row, index) {
  const hay = bqNorm(row.sku + " " + row.title);
  for (const e of index) if (e.sku && e.sku.length >= 6 && hay.includes(e.sku)) return { m: e.m, how: "style code" };
  const t = bqTokens(row.title);
  let best = null;
  for (const e of index) {
    let hit = 0;
    e.tok.forEach((k) => { if (t.has(k)) hit++; });
    const ratio = hit / e.tok.size;
    if (ratio >= 0.75 && (!best || hit > best.hit || (hit === best.hit && ratio > best.ratio)))
      best = { m: e.m, hit, ratio };
  }
  return best ? { m: best.m, how: "name" } : null;
}

/* ---------- size demand ---------- */
// Raw "how often is this size sold out" is misleading on its own: stores stock
// one pair of a 13.5 and five of a 10, so the 13.5 reads "sold out" more often
// without being in more demand. So a size's score starts from the typical
// sneaker size curve (men's 9-11 sell most) and is adjusted by this shoe's own
// signals: sizes that resell above its usual eBay ask, and sizes that sell out
// at tracked stores MORE than that size usually does (which cancels the
// stocking-depth effect).
const BQ_PRIOR = { 7: .35, 7.5: .4, 8: .5, 8.5: .55, 9: .62, 9.5: .66, 10: .7, 10.5: .68,
                   11: .65, 11.5: .56, 12: .5, 12.5: .42, 13: .4, 14: .3 };
// The starting curve now comes from real sell-outs at tracked shops
// (DATA.sizes, solesight/insights/sizes.py): each size's share of sell-outs,
// scaled so the best-selling size sits where BQ_PRIOR's peak did (0.7), which
// keeps the hot (>= 0.6) / cold (< 0.4) thresholds meaning the same thing. A
// shoe with its own size curve (20+ sell-outs) blends it in, weighted by how
// many sell-outs it has. BQ_PRIOR is only the fallback until the market has
// BQ_MIN_MARKET sell-outs counted.
const BQ_PEAK = 0.7, BQ_MIN_MARKET = 150, BQ_OWN_K = 40;
function bqSizeBase(m) {
  const mk = DATA.sizes;
  if (!mk || !mk.sizes || (mk.sellouts || 0) < BQ_MIN_MARKET) {
    return { of: (z) => BQ_PRIOR[z] ?? 0.3, source: "curve", sellouts: 0 };
  }
  const rel = (share) => {
    const peak = Math.max(...Object.values(share));
    const o = {};
    Object.entries(share).forEach(([z, v]) => { o[z] = peak ? BQ_PEAK * v / peak : 0; });
    return o;
  };
  const mShare = Object.fromEntries(mk.sizes.map((r) => [r.size, r.sales_share || 0]));
  const sd = m && m.size_demand;
  const own = sd && sd.own_curve;
  // a shoe's own sell-outs per size, shrunk toward the market's share: with
  // 50 sales, a size with none yet is noise, not proof nobody buys it
  let share = mShare;
  if (own) {
    const n = Object.fromEntries(sd.sizes.map((r) => [r.size, r.sellouts || 0]));
    share = Object.fromEntries(Object.keys(mShare).map((z) =>
      [z, ((n[z] || 0) + BQ_OWN_K * mShare[z]) / (sd.sellouts + BQ_OWN_K)]));
  }
  const curve = rel(share);
  return { of: (z) => curve[z] ?? 0.15, source: own ? "shoe" : "market", sellouts: own ? sd.sellouts : mk.sellouts };
}
function bqGlobalCurve() {
  const c = {};
  DATA.models.forEach((m) => (m.size_sources || []).filter((s) => s.kind === "boutique")
    .forEach((s) => s.sizes.forEach((z) => {
      const k = bqSize(z.size); if (!k) return;
      c[k] = c[k] || { n: 0, out: 0 };
      c[k].n++; if (!z.available) c[k].out++;
    })));
  const out = {};
  Object.entries(c).forEach(([k, v]) => (out[k] = v.n >= 5 ? v.out / v.n : 0.5));
  return out;
}
// "Sizes that sell" for one shoe in the report: only with its own size curve
function bqSellLine(m) {
  const sd = m.size_demand;
  if (!sd || !sd.own_curve || !sd.hot || !sd.hot.length) return "";
  const share = sd.sizes.filter((r) => sd.hot.includes(r.size)).reduce((a, r) => a + (r.sales_share || 0), 0);
  const sizes = typeof szRange === "function" ? szRange(sd.hot) : sd.hot.join(", ");
  return `<p class="bq-note"><b>Sizes that sell:</b> ${sizes}, ${Math.round(share * 100)}% of its ${sd.sellouts}
    sell-outs at tracked shops${DATA.sizes && DATA.sizes.since ? ` since ${new Date(DATA.sizes.since + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}.</p>`;
}
function bqSizeScores(m, global) {
  const stat = {};
  (m.size_sources || []).filter((s) => s.kind === "boutique").forEach((s) => s.sizes.forEach((z) => {
    const k = bqSize(z.size); if (!k) return;
    stat[k] = stat[k] || { n: 0, out: 0 };
    stat[k].n++; if (!z.available) stat[k].out++;
  }));
  const asks = {};
  (m.size_sources || []).filter((s) => s.kind === "resale" && s.condition === "Deadstock")
    .forEach((s) => s.sizes.forEach((z) => { const k = bqSize(z.size); if (k && z.price) asks[k] = z.price; }));
  const askVals = Object.values(asks).sort((a, b) => a - b);
  const med = askVals.length ? askVals[Math.floor(askVals.length / 2)] : null;
  const base = bqSizeBase(m);
  return (size) => {
    const g = global[size] ?? 0.5, s = stat[size] || { n: 0, out: 0 };
    let score = base.of(size);
    // sells out here more (or less) than this size usually does, shrunk when few listings
    if (s.n) score += 0.3 * (s.out / s.n - g) * (s.n / (s.n + 2));
    // resells above (or below) this shoe's typical deadstock ask
    if (med && asks[size]) score += 0.25 * Math.max(-0.5, Math.min(0.5, asks[size] / med - 1));
    return { score: Math.max(0, Math.min(1, score)), seen: s.n, ask: asks[size] || null, base: base.source };
  };
}

/* ---------- verdicts ---------- */
const BQ_HOT = new Set(["peaking", "heating", "emerging"]);
function bqShoeVerdict(m, units) {
  const h = m.hype ?? 0;
  if (h >= 70 || (BQ_HOT.has(m.stage) && h >= 50))
    return { key: "reorder", label: "Reorder", why: `Hype ${h}${m.stage ? `, ${m.stage}` : ""}${m.hype_delta_7d ? `, ${fmtSigned(m.hype_delta_7d, "")} this week` : ""}` };
  if (h < 40 || (m.stage === "cooling" && h < 60))
    return { key: units >= 10 && !window.BQ_PUBLIC ? "markdown" : "hold-off",
             label: units >= 10 && !window.BQ_PUBLIC ? "Consider a markdown" : "Don't reorder",
             why: `Hype ${h}${m.stage ? `, ${m.stage}` : ""} — sell through what you have` };
  return { key: "hold", label: "Hold", why: `Hype ${h}, steady — keep your current depth` };
}
function bqSizeVerdict(shoeKey, qty, sc) {
  const hotSize = sc.score >= 0.6, coldSize = sc.score < 0.4;
  // public-shelf report: we only know in stock (1) or sold out (0), not counts
  if (window.BQ_PUBLIC) return shoeKey === "reorder" && hotSize && !qty ? "restock" : "ok";
  if (shoeKey === "reorder" && hotSize && (qty ?? 0) <= 1) return "restock";
  if ((qty ?? 0) >= 3 && (coldSize || shoeKey !== "reorder")) return "heavy";
  return "ok";
}

/* ---------- colorways ----------
   Same rules as solesight/ingest/colorways.py: a style code (from the shop's
   SKU column, e.g. CD4487-100-8 -> CD4487-100) identifies a colorway exactly;
   without one, colorway names match when they share most words. No regex
   lookbehind, so older iPhones (Safari < 16.4) can still run this file. */
const BQ_CODE_RX = [
  [null, /(?:^|[^A-Z0-9])(\d{4}[A-Z]\d{3})[-. ]?(\d{3})(?![0-9])/],
  [null, /(?:^|[^A-Z0-9])([A-Z]{2}\d{4})[-. ]?(\d{3})(?![0-9])/],
  [null, /(?:^|[^A-Z0-9])(\d{6})[-. ](\d{3})(?![0-9])/],
  [null, /(?:^|[^A-Z0-9])(VN0[A-Z0-9]{6,8})(?![A-Z0-9])/],
  [null, /(?:^|[^A-Z0-9])(L\d{8})(?![0-9])/],
  [null, /(?:^|[^A-Z0-9])(\d[A-Z]{2}\d{8})(?![0-9])/],
  ["puma", /(?:^|[^A-Z0-9])(\d{6})[-. ](\d{2})(?![0-9])/],
  ["on", /(?:^|[^A-Z0-9.])(\d{2}\.\d{5})(?![0-9])/],
  ["adidas", /(?:^|[^A-Z0-9])([A-Z]{1,2}\d{4,5})(?![A-Z0-9])(?!-\d{3})/],
  ["new balance", /(?:^|[^A-Z0-9])((?:BB|CM|GC|ML|MR|MS|MT|PC|U|M|W)\d{3,4}[A-Z][A-Z0-9]{1,3})(?![A-Z0-9])/],
];
function bqStyleCode(text, brand) {
  if (!text) return null;
  const t = String(text).toUpperCase().replace(/\|/g, "-"), b = (brand || "").toLowerCase();
  for (const [only, rx] of BQ_CODE_RX) {
    if (only && b !== only) continue;
    const m = t.match(rx);
    if (m) return m.slice(1).filter(Boolean).join("-");
  }
  return null;
}
const BQ_CW_STOP = new Set(["and", "the", "x", "with", "of"]);
const bqNameKey = (n) => new Set(((n || "").toLowerCase().replace(/grey/g, "gray").match(/[a-z0-9]+/g) || [])
  .filter((w) => w.length > 1 && !BQ_CW_STOP.has(w)));
function bqSameCw(codeA, nameA, codeB, nameB) {
  if (codeA && codeB) return codeA === codeB;
  const a = bqNameKey(nameA), b = bqNameKey(nameB);
  if (!a.size || !b.size) return false;
  let i = 0; a.forEach((w) => { if (b.has(w)) i++; });
  return i / Math.min(a.size, b.size) >= 0.75;
}
// colorways in the market (new data files group every store listing by colorway)
const bqMarketCws = (m) => (m.colorways || []).filter((c) => Array.isArray(c.listings));
function bqCwDemand(c) {   // for sorting: this week's sell-outs, then share sold out
  return (c.sold_7d || 0) * 10 + (c.sizes_total >= 4 ? (c.sold_out_share || 0) * 5 : 0) + c.stores * 0.1;
}
const bqSellingOut = (c) => !c.womens && !c.kids && ((c.sold_7d || 0) >= 3 || (c.sizes_total >= 6 && (c.sold_out_share || 0) >= 0.6));

/* ---------- competitors (public Shopify data from tracked boutiques) ---------- */
const bqMedian = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b), n = v.length;
  return n ? (n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2) : null; };
const bqStoreName = (d) => (DATA.stores && DATA.stores[d] && DATA.stores[d].name)
  || (typeof STORE_NAMES !== "undefined" && STORE_NAMES[d]) || d;
const bqStoreCount = () => Object.keys(DATA.stores || {}).length
  || (typeof STORE_NAMES !== "undefined" ? Object.keys(STORE_NAMES).length : 19);
function bqCompetitors(m, myStore, mine = []) {
  const cws = bqMarketCws(m);
  if (cws.length) return bqCwCompetitors(m, myStore, mine, cws);
  const sizesBy = {};
  (m.size_sources || []).filter((x) => x.kind === "boutique").forEach((x) => {
    sizesBy[x.source] = x.sizes.filter((z) => z.available).map((z) => bqSize(z.size)).filter(Boolean)
      .sort((a, b) => a - b);
  });
  // Only compare prices against listings that look like the same new shoe:
  // not used, and within 0.5x-2x of its typical deadstock ask (or retail).
  // Store listings are matched to shoes by title nightly, so the odd one is a
  // different product (e.g. a used Jumpman Jack in the same colorway).
  const ref = m.resale_last || m.retail;
  return (m.stockists || []).filter((c) => c.store !== myStore).map((c) => {
    const used = /\b(used|pre-?owned|worn)\b/i.test(c.title || "");
    const inBand = c.price && ref ? c.price >= 0.5 * ref && c.price <= 2 * ref : !!c.price;
    return { store: c.store, name: bqStoreName(c.store), price: c.price || null, url: c.url,
      title: c.title, left: c.avail, total: c.total, sizes: [...new Set(sizesBy[c.store] || [])],
      comparable: !!c.price && inBand && !used, used };
  }).sort((a, b) => (b.left > 0) - (a.left > 0) || (a.price ?? 1e9) - (b.price ?? 1e9));
}

// one row per store and colorway (consignment shops list each size separately)
function bqCwCompetitors(m, myStore, mine, cws) {
  const ref = m.resale_last || m.retail;
  const rows = [];
  cws.forEach((c) => {
    const same = !c.kids && mine.some((x) => bqSameCw(c.code, c.name, x.code, x.name) && (!c.womens || /women|wmns|\(w\)/i.test(x.name || "")));
    const by = {};
    c.listings.filter((l) => l.store !== myStore).forEach((l) => {
      const r = by[l.store] = by[l.store] || { store: l.store, name: bqStoreName(l.store), prices: [], left: 0, total: 0,
        sizes: new Set(), url: l.url || (l.h ? `https://${l.store}/products/${l.h}` : null), title: l.title,
        colorway: c.name, code: c.code, same, used: false };
      if (l.price) r.prices.push(l.price);
      r.left += l.left; r.total += l.total;
      (l.sizes_left || []).forEach((z) => { const k = bqSize(z); if (k) r.sizes.add(k); });
      if (/\b(used|pre-?owned|worn)\b/i.test(`${l.title || ""} ${l.h || ""}`)) r.used = true;
    });
    Object.values(by).forEach((r) => {
      const price = r.prices.length ? Math.min(...r.prices) : null;
      const inBand = price && ref ? price >= 0.5 * ref && price <= 2 * ref : !!price;
      rows.push({ ...r, price, sizes: [...r.sizes].sort((a, b) => a - b), comparable: !!price && inBand && !r.used });
    });
  });
  return rows.sort((a, b) => (b.same - a.same) || (b.left > 0) - (a.left > 0) || (a.price ?? 1e9) - (b.price ?? 1e9));
}

/* ---------- local demand ----------
   state_index (data.json, per shoe) = that state's Google search interest
   over the last 30 days ÷ the median across states with enough searches.
   1.8 reads "searched 1.8× the typical state". */
const BQ_STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
  "District of Columbia", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky",
  "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana",
  "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota",
  "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas",
  "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"];
const BQ_LOCAL_HI = 1.3, BQ_LOCAL_LO = 0.7;
function bqMyState(myStore) {
  const pick = $("#bq-state");
  if (pick && pick.value) return pick.value;
  return (myStore && DATA.stores && DATA.stores[myStore] && DATA.stores[myStore].state) || "";
}
const bqLocal = (m, state) => (state && m.state_index ? m.state_index[state] ?? null : null);
function bqLocalText(m, state) {
  const r = bqLocal(m, state);
  if (r == null) return "";
  if (r >= BQ_LOCAL_HI) return `Searched ${r.toFixed(1)}× the typical state in ${state}`;
  if (r <= BQ_LOCAL_LO) return `Searched less in ${state} (${r.toFixed(1)}× the typical state)`;
  return "";
}
function bqLocalBlock(rep) {
  if (!rep.state) return "";
  const rows = DATA.models.map((m) => ({ m, r: bqLocal(m, rep.state) })).filter((x) => x.r != null && x.r >= BQ_LOCAL_HI)
    .sort((a, b) => b.r - a.r).slice(0, 8);
  if (!rows.length) return "";
  const carried = new Set(rep.out.map((e) => e.m.slug));
  return `<h3 class="bq-h">Local demand · ${esc(rep.state)}</h3>
    <p class="bq-fine">Shoes searched most in ${esc(rep.state)} compared with the typical state, from Google search interest over
      the last 30 days (only states with enough searches count).</p>
    <table class="bq-table"><thead><tr><th>Shoe</th><th class="num">vs. typical state</th><th class="num">Hype</th><th>You carry</th></tr></thead>
      <tbody>${rows.map((x) => `<tr><td><a role="button" tabindex="0" class="bq-link" data-slug="${x.m.slug}">${esc(x.m.name)}</a></td>
        <td class="num"><b>${x.r.toFixed(1)}×</b></td><td class="num">${x.m.hype ?? "—"}</td>
        <td>${carried.has(x.m.slug) ? "✓" : "—"}</td></tr>`).join("")}</tbody></table>`;
}

/* ---------- selling fastest ----------
   sold_7d (data.json, per shoe) = sizes that went from in stock to sold out at
   each tracked store over the last 7 days (both readings listed, ≤3 days apart).
   Ranked by shops like yours when that signal is live, else every tracked shop. */
const BQ_SOLD_MIN_NEAR = 10;
function bqSoldFast(rep, n = 8) {
  const near = rep.shelf && rep.shelf.similar ? rep.shelf.nearStores : [];
  const carried = new Set(rep.out.map((e) => e.m.slug));
  const rows = DATA.models.map((m) => {
    const by = m.sold_7d || {};
    const all = Object.entries(by).filter(([d]) => d !== rep.myStore).reduce((a, [, v]) => a + v, 0);
    const nearN = near.reduce((a, d) => a + (by[d] || 0), 0);
    const shops = Object.keys(by).filter((d) => d !== rep.myStore && by[d] > 0).length;
    return { m, all, near: nearN, shops, carried: carried.has(m.slug) };
  }).filter((x) => x.all > 0);
  // shops like yours only when they sold enough this week to rank on; else every tracked shop
  const nearTotal = rows.reduce((a, x) => a + x.near, 0);
  const key = near.length && nearTotal >= BQ_SOLD_MIN_NEAR ? "near" : "all";
  const pool = key === "near" ? rows.filter((x) => x.near > 0) : rows;
  return { key, rows: pool.sort((a, b) => b[key] - a[key] || b.all - a.all).slice(0, n) };
}
function bqSoldBlock(rep) {
  const sf = rep.sold;
  if (!sf || !sf.rows.length) return "";
  const nearHead = sf.key === "near";
  return `<h3 class="bq-h">Selling fastest this week</h3>
    <p class="bq-fine">Sizes that sold out at ${nearHead ? "the shops most like yours" : "tracked boutiques"} in the last 7 days.
      A size counts when a shop listed it in stock and then as sold out on the next reading. That's a strong sign
      of a sale, not proof of one.</p>
    <table class="bq-table"><thead><tr><th>Shoe</th>${nearHead ? `<th class="num">Shops like yours</th>` : ""}
      <th class="num">All tracked shops</th><th>You carry</th></tr></thead>
      <tbody>${sf.rows.map((x) => `<tr><td><a role="button" tabindex="0" class="bq-link" data-slug="${x.m.slug}">${esc(x.m.name)}</a></td>
        ${nearHead ? `<td class="num"><b>${x.near}</b> size${x.near === 1 ? "" : "s"}</td>` : ""}
        <td class="num">${x.all} size${x.all === 1 ? "" : "s"} · ${x.shops} shop${x.shops === 1 ? "" : "s"}</td>
        <td>${x.carried ? "✓" : "—"}</td></tr>`).join("")}</tbody></table>`;
}

/* ---------- "Add to your shelf" ----------
   Index shoes the shop doesn't carry, ranked by four things it can check:
   shops with shelves like yours carry it, Hype level and this week's rise,
   resale margin over retail, and fit with the shop's usual price range.
   "Shops like yours" = the BQ_SHELF_K tracked boutiques whose shelves overlap
   most with this shop's (Jaccard, weighted). It's used only while the nightly
   hide-a-shoe test (solesight/insights/shelf_recs.py, same K) shows it beats
   "what most shops carry"; otherwise the peer part is plain popularity. */
const BQ_SHELF_K = 5;
const BQ_REC_W = { peer: 0.35, level: 0.2, rise: 0.15, margin: 0.2, fit: 0.1 };
function bqShelfRecs(carried, myStore, n = 8, state = "") {
  const shelves = {};
  DATA.models.forEach((m) => (m.stockists || []).forEach((s) => {
    if (s.store !== myStore) (shelves[s.store] = shelves[s.store] || new Set()).add(m.slug);
  }));
  const stores = Object.keys(shelves);
  const sm = DATA.shelf_model || {};
  const jac = (a, b) => { let i = 0; a.forEach((x) => { if (b.has(x)) i++; }); const u = a.size + b.size - i; return u ? i / u : 0; };
  const near = stores.map((d) => ({ d, w: jac(carried, shelves[d]) })).filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w || (a.d < b.d ? -1 : 1)).slice(0, BQ_SHELF_K);
  const similar = !!sm.similar_live && near.length > 0;
  const wsum = near.reduce((a, x) => a + x.w, 0);
  const priceOf = (m) => m.boutique_price || m.resale_last || m.retail || null;
  const mine = DATA.models.filter((m) => carried.has(m.slug)).map(priceOf).filter(Boolean).sort((a, b) => a - b);
  const q = (f) => mine[Math.round(f * (mine.length - 1))];
  const range = mine.length >= 3 ? [q(0.25), q(0.75)] : null;
  const recs = DATA.models
    .filter((m) => !carried.has(m.slug) && (m.hype ?? 0) >= 40 && m.stage !== "cooling")
    .map((m) => {
      const carriers = stores.filter((d) => shelves[d].has(m.slug)).length;
      const nearHave = near.filter((x) => shelves[x.d].has(m.slug));
      const peer = similar ? nearHave.reduce((a, x) => a + x.w, 0) / wsum : stores.length ? carriers / stores.length : 0;
      const rise = Math.max(0, Math.min(1, (m.hype_delta_7d || 0) / 15));
      const prem = m.resale_premium;
      const margin = prem ? Math.max(0, Math.min(1, prem - 1)) : 0;
      const p = priceOf(m);
      const inRange = !!(range && p && p >= range[0] / 1.2 && p <= range[1] * 1.2);
      const fit = !range || !p ? 0.5 : inRange ? 1
        : Math.max(0, 1 - Math.abs(Math.log(p / (p < range[0] ? range[0] / 1.2 : range[1] * 1.2))));
      const score = BQ_REC_W.peer * peer + BQ_REC_W.level * (m.hype ?? 0) / 100 + BQ_REC_W.rise * rise
        + BQ_REC_W.margin * margin + BQ_REC_W.fit * fit;
      const why = [];
      if (similar && nearHave.length) why.push(`${nearHave.length} of the ${near.length} shops most like yours carry it`);
      else if (carriers) why.push(`Carried by ${carriers} of ${stores.length} tracked shops`);
      why.push(`Hype ${m.hype ?? "—"}${(m.hype_delta_7d || 0) >= 1 ? `, up ${Math.round(m.hype_delta_7d)} this week` : ""}`);
      if (prem && prem >= 1.1) why.push(`Resells at ${prem.toFixed(1)}× retail`);
      if (inRange) why.push("In your usual price range");
      const loc = bqLocal(m, state);
      if (loc != null && loc >= BQ_LOCAL_HI) why.push(`Searched ${loc.toFixed(1)}× the typical state in ${state}`);
      return { m, score, why };
    })
    .sort((a, b) => b.score - a.score || (b.m.hype ?? 0) - (a.m.hype ?? 0))
    .slice(0, n);
  return { recs, similar, near: near.length, nearStores: near.map((x) => x.d), range, test: sm };
}

/* ---------- report ---------- */
let BQ_LAST = null, BQ_ROWS = null, BQ_TEXT = null, BQ_FILENAME = null;
function bqAnalyze(rows, myStore) {
  const index = DATA.models.map((m) => ({ m, sku: m.sku ? bqNorm(m.sku) : null, tok: bqTokens(m.name) }));
  const global = bqGlobalCurve();
  const shoes = new Map(), untracked = new Map();
  rows.forEach((r) => {
    const hit = bqMatch(r, index);
    if (!hit) { untracked.set(r.title, (untracked.get(r.title) || 0) + (r.qty || 0)); return; }
    const e = shoes.get(hit.m.slug) || { m: hit.m, how: hit.how, sizes: {}, colors: new Set(), units: 0, sold: null, prices: [], cws: new Map() };
    const code = bqStyleCode(r.sku, hit.m.brand) || bqStyleCode(r.title, hit.m.brand);
    if (code || r.color) {
      const k = code || [...bqNameKey(r.color)].sort().join(" ");
      const x = e.cws.get(k) || { code, name: r.color || null, units: 0 };
      x.code = x.code || code; x.name = x.name || r.color || null; x.units += r.qty || 0;
      e.cws.set(k, x);
    }
    if (r.price) e.prices.push(r.price);
    if (r.size) e.sizes[r.size] = (e.sizes[r.size] || 0) + (r.qty || 0);
    if (r.color) e.colors.add(r.color);
    e.units += r.qty || 0;
    if (r.sold != null) e.sold = (e.sold || 0) + r.sold;
    shoes.set(hit.m.slug, e);
  });
  const out = [...shoes.values()].map((e) => {
    const v = bqShoeVerdict(e.m, e.units);
    const scoreOf = bqSizeScores(e.m, global);
    const sizes = Object.keys(e.sizes).sort((a, b) => a - b).map((sz) => {
      const sc = scoreOf(sz);
      return { size: sz, qty: e.sizes[sz], ...sc, verdict: bqSizeVerdict(v.key, e.sizes[sz], sc) };
    });
    // the market's hottest sizes the store doesn't stock at all
    const missingSizes = v.key === "reorder"
      ? ["7", "7.5", "8", "8.5", "9", "9.5", "10", "10.5", "11", "11.5", "12"]
          .filter((sz) => !(sz in e.sizes)).map((sz) => ({ size: sz, ...scoreOf(sz) }))
          .filter((x) => x.score >= 0.6).map((x) => x.size)
      : [];
    // the shop's colorways: from its SKUs/colors, else (picked a tracked store
    // and the file has neither) from that store's own public listings
    let mineCw = [...e.cws.values()];
    const market = bqMarketCws(e.m);
    if (!mineCw.length && myStore) {
      mineCw = market.filter((c) => c.listings.some((l) => l.store === myStore))
        .map((c) => ({ code: c.code, name: c.name, units: null, fromSite: true }));
    }
    mineCw.forEach((x) => { x.market = market.find((c) => bqSameCw(c.code, c.name, x.code, x.name)) || null; });
    const legacy = (e.m.colorways || []).length > 0 && !market.length;
    const mineLower = [...e.colors].map((c) => c.toLowerCase());
    const colorways = (e.m.colorways || []).map((c) => ({
      ...c, carried: legacy
        ? mineLower.some((x) => bqTokens(c.name).size && [...bqTokens(c.name)].every((t) => x.includes(t)))
        : !c.kids && mineCw.some((x) => bqSameCw(c.code, c.name, x.code, x.name) && (!c.womens || /women|wmns|\(w\)/i.test(x.name || ""))),
    }));
    const toAdd = colorways.filter((c) => !c.carried && !legacy && bqSellingOut(c))
      .sort((a, b) => bqCwDemand(b) - bqCwDemand(a)).slice(0, 2);
    const comps = bqCompetitors(e.m, myStore, mineCw);
    // the shop's own price gets the same sanity band as competitors' (0.5x-2x the
    // shoe's deadstock ask or retail): far outside it, the listing is probably a
    // different edition, so it isn't compared
    const rawPrice = bqMedian(e.prices), pRef = e.m.resale_last || e.m.retail;
    const myPriceOdd = rawPrice && pRef && (rawPrice < 0.5 * pRef || rawPrice > 2 * pRef) ? rawPrice : null;
    const myPrice = myPriceOdd ? null : rawPrice;
    // compare prices against the same colorway when another shop lists it
    const sameComps = comps.filter((c) => c.same && c.comparable);
    const compBasis = sameComps.length ? "same" : mineCw.length && !legacy ? "other" : "all";
    const compPrice = bqMedian((sameComps.length ? sameComps : comps.filter((c) => c.comparable)).map((c) => c.price));
    const outPool = comps.some((c) => c.same) ? comps.filter((c) => c.same) : comps;
    const storesOf = (xs) => new Set(xs.map((c) => c.store)).size;
    return { ...e, verdict: v, sizes, missingSizes, colorways, mineCw, toAdd, comps, myPrice, myPriceOdd, compPrice, compBasis,
             soldOutAt: storesOf(outPool.filter((c) => c.left === 0)), compStores: storesOf(outPool) };
  });
  const order = { reorder: 0, hold: 1, "hold-off": 2, markdown: 3 };
  out.sort((a, b) => order[a.verdict.key] - order[b.verdict.key] || (b.m.hype ?? 0) - (a.m.hype ?? 0));
  const carried = new Set(out.map((e) => e.m.slug));
  const state = bqMyState(myStore);
  const shelf = bqShelfRecs(carried, myStore, 8, state);
  const missing = shelf.recs.map((r) => r.m);
  // which competitors overlap most with this store's shelves
  const byStore = {};
  out.forEach((e) => {
    const seen = {};
    e.comps.forEach((c) => {
      const b = byStore[c.store] = byStore[c.store] || { name: c.name, shoes: 0, inStock: 0, gaps: [] };
      const s0 = seen[c.store] = seen[c.store] || { counted: false, stocked: false };
      if (!s0.counted) { b.shoes++; s0.counted = true; }
      if (c.left > 0 && !s0.stocked) { b.inStock++; s0.stocked = true; }
      if (e.myPrice && c.comparable && (c.same || e.compBasis !== "same")) b.gaps.push(c.price - e.myPrice);
    });
  });
  const overview = Object.values(byStore).sort((a, b) => b.shoes - a.shoes || b.inStock - a.inStock)
    .map((b) => ({ ...b, gap: bqMedian(b.gaps) }));
  BQ_LAST = { out, untracked: [...untracked.entries()], missing, shelf, rows: rows.length, overview, myStore, state };
  BQ_LAST.sold = bqSoldFast(BQ_LAST);
  return BQ_LAST;
}

function bqRender(rep) {
  const el = $("#bq-out");
  if (!rep.out.length && !rep.untracked.length) {
    el.innerHTML = `<p class="bq-empty">Couldn't read any products from that file. It needs a product name
      column and, ideally, size and quantity columns — see "What file works" above.</p>`;
    return;
  }
  const n = (k) => rep.out.filter((e) => e.verdict.key === k).length;
  // public-shelf report: count sold-out sizes only (missing sizes may just be consignment gaps)
  const restock = rep.out.reduce((a, e) => a + e.sizes.filter((s) => s.verdict === "restock").length + (window.BQ_PUBLIC ? 0 : e.missingSizes.length), 0);
  const lbl = { restock: "Restock", ok: "OK", heavy: "Heavy" };
  const cards = rep.out.map((e) => `
    <article class="bq-shoe">
      <div class="bq-thumb tile" data-slug="${e.m.slug}">${img(e.m, "")}</div>
      <div class="bq-main">
        <div class="bq-top"><span class="bq-badge ${e.verdict.key}">${e.verdict.label}</span>
          <span class="bq-why">${esc(e.verdict.why)}</span>
          <button class="bq-buybtn" data-buy="${e.m.slug}" type="button">Buy prices →</button></div>
        <h4 class="bq-name" data-slug="${e.m.slug}">${esc(e.m.name)}</h4>
        <div class="bq-meta">${window.BQ_PUBLIC ? `${e.sizes.filter((z) => z.qty).length} of ${e.sizes.length} sizes in stock on your site` : `${e.units} pairs in stock · matched by ${e.how}`}${e.sold != null ? ` · ${e.sold} sold` : ""}${e.m.resale_premium ? ` · resells at ${e.m.resale_premium.toFixed(1)}× retail` : ""}</div>
        ${e.sizes.length ? `<div class="bq-sizes">${e.sizes.map((s) => `
          <span class="bq-size ${s.verdict}" title="Demand ${Math.round(s.score * 100)}/100 · ${s.base === "shoe" ? "this shoe's sell-outs by size" : s.base === "market" ? "sell-outs by size, all shoes" : "typical size curve"}${s.seen ? ` · ${s.seen} tracked store listing${s.seen === 1 ? "" : "s"}` : ""}${s.ask ? ` · eBay ask $${Math.round(s.ask)}` : ""}">
            <b>${s.size}</b><small>${window.BQ_PUBLIC ? (s.qty ? "in stock" : "sold out") : s.qty} · ${lbl[s.verdict]}</small></span>`).join("")}</div>` : ""}
        ${typeof outlookNote === "function" ? outlookNote(e.m, "bq-note") : ""}
        ${bqSellLine(e.m)}
        ${bqLocalText(e.m, rep.state) ? `<p class="bq-note"><b>Near you:</b> ${esc(bqLocalText(e.m, rep.state))}.</p>` : ""}
        ${e.missingSizes.length ? `<p class="bq-note"><b>Not stocked, but in demand:</b> sizes ${e.missingSizes.join(", ")}.</p>` : ""}
        ${bqOutlook(e)}
        ${bqCompBlock(e)}
        ${bqCwBlock(e)}
      </div>
    </article>`).join("");
  el.innerHTML = `
    <div class="bq-summary">
      <div><b>${rep.out.length}</b><span>Tracked shoes found</span></div>
      <div class="hl"><b>${n("reorder")}</b><span>To reorder</span></div>
      <div><b>${restock}</b><span>${window.BQ_PUBLIC ? "Sold-out sizes to restock" : "Sizes to restock"}</span></div>
      <div><b>${n("hold-off") + n("markdown")}</b><span>Don't reorder</span></div>
    </div>
    <div class="bq-actions"><button class="btn btn-solid" id="bq-pdf">Save as PDF</button>
      <button class="btn btn-ghost" id="bq-dl">Download as CSV</button>
      <span class="bq-fine">Based on tonight's index (${new Date(DATA.generated_at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}).
        Size advice starts from ${bqBaseText(bqSizeBase(null))}, using each shoe's own sell-outs once it has
        ${DATA.sizes && DATA.sizes.min_sales ? DATA.sizes.min_sales : 20}+, and is adjusted by its resale prices by size — guidance, not exact quantities${rep.out.some((e) => e.sold != null) || window.BQ_PUBLIC ? "" : ". Add a units-sold column to make it specific to your store"}.</span></div>
    ${bqOverview(rep)}
    ${bqSoldBlock(rep)}
    ${bqLocalBlock(rep)}
    <h3 class="bq-h">Shoe by shoe</h3>
    <div class="bq-list">${cards}</div>
    ${bqShelfBlock(rep)}
    ${rep.untracked.length ? `<h3 class="bq-h">Not tracked yet (${rep.untracked.length})</h3>
      <p class="bq-fine">We don't score these yet — tell us which matter and we'll add them.</p>
      <ul class="bq-untracked">${rep.untracked.slice(0, 40).map(([t, q]) => `<li>${esc(t)}<span>${q} pairs</span></li>`).join("")}</ul>` : ""}`;
  $$("#bq-out [data-slug]").forEach((x) => (x.onclick = () => openSheet(x.dataset.slug)));
  $$("#bq-out [data-buy]").forEach((x) => (x.onclick = () => bcOpen(x.dataset.buy)));
  $("#bq-dl").onclick = bqDownload;
  $("#bq-pdf").onclick = bqPrint;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function bqOutlook(e) {
  const o = e.m.price_outlook;
  if (!o) return "";
  if (!o.ok) return `<p class="bq-note"><b>Resale outlook:</b> not enough clean price history to
    forecast this one yet.</p>`;
  const up = o.change_pct >= 5, down = o.change_pct <= -5;
  const hint = up ? "Resale is expected to climb — no need to discount; price toward the top of your range."
    : down ? "Resale is expected to soften — sell through sooner rather than later."
    : "Resale is expected to hold steady.";
  const vsYou = e.myPrice ? ` Your price is $${Math.round(e.myPrice)}.` : "";
  return `<div class="bq-outlook ${up ? "up" : down ? "down" : "flat"}">
      <div><span class="bq-ol-lab">Predicted resale · ${new Date(o.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
        <b>$${o.in30}</b><small>likely $${o.lo}–$${o.hi}</small></div>
      <div><span class="bq-ol-lab">eBay ask today</span><b>$${o.now}</b>
        <small class="delta ${up ? "up" : down ? "down" : "flat"}">${fmtSigned(o.change_pct, "%")} in 30 days</small></div>
      <p>${hint}${vsYou}</p>
    </div>`;
}

function bqCompBlock(e) {
  if (!e.comps.length) return `<p class="bq-note"><b>Competitors:</b> none of the ${bqStoreCount()} tracked boutiques list it right now.</p>`;
  const nStores = new Set(e.comps.map((c) => c.store)).size;
  const inStock = new Set(e.comps.filter((c) => c.left > 0).map((c) => c.store)).size;
  const sameN = new Set(e.comps.filter((c) => c.same).map((c) => c.store)).size;
  const priced = e.comps.filter((c) => c.comparable).map((c) => c.price);
  const from = priced.length ? `from $${Math.round(Math.min(...priced))}` : "";
  let gap = "";
  if (e.myPrice && e.compPrice) {
    const d = Math.round(e.myPrice - e.compPrice);
    const vs = e.compBasis === "same" ? "the median competitor for your colorway"
      : e.compBasis === "other" ? "the median competitor in other colorways" : "the median competitor";
    gap = Math.abs(d) < 5 ? `Your price ($${Math.round(e.myPrice)}) is in line with ${vs}.`
      : `Your price ($${Math.round(e.myPrice)}) is <b>$${Math.abs(d)} ${d > 0 ? "above" : "below"}</b> ${vs} ($${Math.round(e.compPrice)}).`;
    if (e.compBasis === "other") gap += " No tracked shop lists your colorway.";
  }
  if (e.myPriceOdd) gap = `Your price ($${Math.round(e.myPriceOdd)}) is far from this shoe's usual range, so it may be a different edition; it isn't compared.`;
  const cs = e.compStores || nStores;
  const scarce = e.soldOutAt && e.units > 0
    ? `${e.compBasis === "same" ? "Your colorway is sold" : "Sold"} out at ${e.soldOutAt} of ${cs} other store${cs === 1 ? "" : "s"} — you're one of the few with stock.` : "";
  // public-shelf report (a cold-outreach PDF): the 5 most useful rows, in stock and cheapest first
  const COMP_CAP = 5;
  const shown = window.BQ_PUBLIC
    ? [...e.comps].sort((a, b) => (b.left > 0) - (a.left > 0) || (b.comparable - a.comparable) || (a.price || 1e9) - (b.price || 1e9)).slice(0, COMP_CAP)
    : e.comps;
  const more = e.comps.length - shown.length;
  const rows = shown.map((c) => `<tr>
      <td><a href="${c.url || `https://${c.store}`}" target="_blank" rel="noopener">${esc(c.name)} ↗</a>${c.colorway !== undefined
        ? `<small class="bq-cwtag${c.same ? " same" : ""}">${c.same ? "Your colorway · " : ""}${esc(c.colorway || c.code || "colorway not stated")}${c.code && c.colorway && c.code !== c.colorway ? ` · ${esc(c.code)}` : ""}</small>`
        : c.title ? `<small class="bq-ptitle">${esc(c.title)}</small>` : ""}</td>
      <td class="num">${c.price ? "$" + Math.round(c.price) : "—"}${c.price && !c.comparable ? `<small class="bq-ptitle" title="Looks like a different listing (${c.used ? "used pair" : "price far from this shoe's usual range"}), so it's left out of price comparisons">not compared</small>` : ""}</td>
      <td>${c.left === 0 ? `<span class="bq-out">Sold out</span>` : `${c.left} of ${c.total} sizes left${c.sizes.length ? `: ${c.sizes.slice(0, 8).join(", ")}${c.sizes.length > 8 ? "…" : ""}` : ""}`}</td></tr>`).join("");
  return `<details class="bq-comp">
      <summary><b>Competitors:</b> ${nStores} store${nStores === 1 ? "" : "s"} carry it${sameN ? ` (${sameN} in your colorway)` : ""} · ${inStock} in stock ${from ? "· " + from : ""}</summary>
      ${gap || scarce ? `<p class="bq-note">${[gap, scarce].filter(Boolean).join(" ")}</p>` : ""}
      <table class="bq-table"><thead><tr><th>Store</th><th class="num">Price</th><th>Sizes</th></tr></thead><tbody>${rows}${more > 0 ? `<tr><td colspan="3" class="bq-fine">+ ${more} more store${more === 1 ? "" : "s"} (full list at solesight.xyz/boutiques.html)</td></tr>` : ""}</tbody></table>
    </details>`;
}

function bqCwBlock(e) {
  const legacy = (e.m.colorways || []).length > 0 && !bqMarketCws(e.m).length;
  if (legacy) {
    return e.colorways.length ? `<p class="bq-note"><b>Colorways in the market:</b> ${e.colorways.slice(0, 4).map((c) =>
      `${esc(c.name)} ($${Math.round(c.price_low)}${c.price_high !== c.price_low ? `–$${Math.round(c.price_high)}` : ""}, ${c.stores} store${c.stores === 1 ? "" : "s"})${c.carried ? " ✓ you carry" : ""}`).join(" · ")}</p>` : "";
  }
  const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
  const mine = e.mineCw || [];
  const MINE_CAP = 4;
  const yours = mine.length ? `<p class="bq-note"><b>Your colorway${mine.length === 1 ? "" : "s"}:</b> ${mine.slice(0, MINE_CAP).map((x) =>
      `${esc(x.name || (x.market && x.market.name) || x.code)}${x.code && x.code !== (x.name || (x.market && x.market.name)) ? ` (${esc(x.code)})` : ""}${x.units != null ? ` · ${x.units} pair${x.units === 1 ? "" : "s"}` : ""}${
        x.market ? (bqSellingOut(x.market) ? " · <b>selling out elsewhere</b>" : "") : " · no tracked shop lists it"}`).join("; ")}${
        mine.length > MINE_CAP ? `; and ${mine.length - MINE_CAP} more` : ""}</p>`
    : window.BQ_PUBLIC ? ""     // built from a store's website: there's no file to add a column to
    : `<p class="bq-fine">Add a style code or color column to your file to see how your colorways are doing.</p>`;
  const add = e.toAdd.length ? `<p class="bq-note bq-cwadd"><b>Colorway${e.toAdd.length === 1 ? "" : "s"} to add:</b> ${e.toAdd.map((c) =>
      `${esc(c.name)}${c.code && c.code !== c.name ? ` (${esc(c.code)})` : ""} — ${c.sold_7d ? `${c.sold_7d} size${c.sold_7d === 1 ? "" : "s"} sold out this week, ` : ""}${pct(c.sold_out_share)} of sizes gone across ${c.stores} shop${c.stores === 1 ? "" : "s"}`).join("; ")}.</p>` : "";
  const rows = [...e.colorways].sort((a, b) => (b.carried - a.carried) || bqCwDemand(b) - bqCwDemand(a)).slice(0, 6);
  const more = e.colorways.length - rows.length;
  const table = rows.length ? `<table class="bq-table bq-cwtable"><thead><tr><th>Colorway</th><th class="num cw-x">Shops</th>
      <th class="num cw-x">Sizes left</th><th class="num">Sold out</th><th class="num">This week</th><th>You</th></tr></thead><tbody>
      ${rows.map((c) => `<tr><td>${esc(c.name || c.code)}${c.code && c.name && c.code !== c.name ? `<small class="bq-ptitle">${esc(c.code)}</small>` : ""}${
        bqSellingOut(c) ? ` <span class="bq-hot">selling out</span>` : ""}</td>
        <td class="num cw-x">${c.stores}</td><td class="num cw-x">${c.sizes_left} of ${c.sizes_total}</td>
        <td class="num">${pct(c.sold_out_share)}</td><td class="num">${c.sold_7d ? c.sold_7d + " size" + (c.sold_7d === 1 ? "" : "s") : "—"}</td>
        <td>${c.carried ? "✓" : "—"}</td></tr>`).join("")}
      ${more > 0 ? `<tr><td colspan="6" class="bq-fine">+ ${more} more colorway${more === 1 ? "" : "s"} at tracked shops</td></tr>` : ""}</tbody></table>` : "";
  return `<div class="bq-cw">${yours}${add}${rows.length ? `<details class="bq-comp bq-cwd"${e.toAdd.length ? " open" : ""}>
      <summary><b>Colorways in the market:</b> ${e.colorways.length} at tracked shops</summary>${table}
      <p class="bq-fine">"Sold out" is the share of listed sizes with none left; "this week" counts sizes that went from in stock to sold out.</p></details>` : ""}</div>`;
}

function bqShelfBlock(rep) {
  const sh = rep.shelf;
  if (!sh || !sh.recs.length) return "";
  const t = sh.test || {};
  const pct = (x) => Math.round((x || 0) * 100) + "%";
  const how = sh.similar
    ? `"Shops like yours" means the ${sh.near} tracked boutiques whose shelves overlap most with yours. We test it every night:
       hide a shoe a shop carries and check it comes back in the top ${t.top_n || 10}. It does ${pct(t.hit_similar)} of the time,
       vs ${pct(t.hit_popular)} for "what most shops carry" (${t.pairs} tests).`
    : t.pairs
      ? `Ranked with how many tracked shops carry each shoe. "Shops like yours" isn't beating that in our nightly test right now
         (${pct(t.hit_similar)} vs ${pct(t.hit_popular)}), so it isn't used.`
      : `Ranked with how many tracked shops carry each shoe.`;
  const range = sh.range ? ` Your usual price range: $${Math.round(sh.range[0])}–$${Math.round(sh.range[1])}.` : "";
  return `<h3 class="bq-h">Add to your shelf</h3>
    <p class="bq-fine">Shoes on the index you don't carry, ranked by shops like yours, Hype, resale margin and price fit.
      ${how}${range}</p>
    <div class="bq-recs">${sh.recs.map((r) => `<div class="bq-rec" data-slug="${r.m.slug}">
      <div class="tile">${img(r.m, "")}</div>
      <div><b>${esc(r.m.name)}</b><ul>${r.why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div></div>`).join("")}</div>`;
}

function bqOverview(rep) {
  if (!rep.overview.length) return "";
  const anyGap = rep.overview.some((b) => b.gap != null);
  return `<h3 class="bq-h">Your competitors</h3>
    <p class="bq-fine">Tracked boutiques that carry the same shoes you do, from their public store listings.${rep.myStore ? ` ${esc(bqStoreName(rep.myStore))} (you) is left out.` : " Pick your store above if you're one of them."}</p>
    <table class="bq-table bq-overview"><thead><tr><th>Store</th><th class="num">Your shoes they carry</th><th class="num">In stock</th>${anyGap ? `<th class="num">Their price vs yours</th>` : ""}</tr></thead>
    <tbody>${rep.overview.slice(0, 10).map((b) => `<tr><td>${esc(b.name)}</td><td class="num">${b.shoes}</td><td class="num">${b.inStock}</td>${anyGap ? `<td class="num">${b.gap == null ? "—" : (b.gap > 0 ? "+" : b.gap < 0 ? "−" : "") + "$" + Math.abs(Math.round(b.gap))}</td>` : ""}</tr>`).join("")}</tbody></table>`;
}

/* PDF: the browser's own print-to-PDF with a report-only print layout
   (see "@media print" in styles.css). Crisp text, nothing uploaded, works on
   desktop and iOS. Competitor tables are expanded for the printout. */
function bqPrintHead() {
  const store = window.BQ_STORE_NAME || (BQ_LAST && BQ_LAST.myStore ? bqStoreName(BQ_LAST.myStore) : "Your store");
  const when = new Date(DATA.generated_at * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  let head = $("#bq-print-head");
  if (!head) {
    head = document.createElement("div");
    head.id = "bq-print-head";
    $("#bq-out").prepend(head);
  }
  const logo = document.querySelector(".nav .brand-lockup");
  head.innerHTML = `${logo ? logo.outerHTML : "<b>SoleSight</b>"}
    <div><b>Reorder report · ${esc(store)}</b>
      <span>${when} · scored against tonight's index · solesight.xyz/boutiques.html</span>
      ${window.BQ_PUBLIC ? `<span>Built from ${esc(store)}'s public website, no inventory file: only shoes on the SoleSight index,
        and sizes show as in stock or sold out (not pair counts). Upload your inventory at solesight.xyz/boutiques.html for the full version.</span>` : ""}</div>`;
  return `SoleSight reorder report - ${store} - ${when}`;
}
let BQ_OPENED = [], BQ_SWAPPED = [];
// Product photos are ~1600px PNGs; embedded as-is they make a ~18 MB PDF.
// For the printout, swap each for a small JPEG on the tile colour (restored after).
function bqShrinkImages() {
  $$("#bq-out img").forEach((im) => {
    if (!im.complete || !im.naturalWidth || im.dataset.full) return;
    const w = 320, h = Math.round(w * im.naturalHeight / im.naturalWidth);
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const cx = cv.getContext("2d");
    cx.fillStyle = "#F1F1EE"; cx.fillRect(0, 0, w, h);
    try {
      cx.drawImage(im, 0, 0, w, h);
      im.dataset.full = im.src;
      im.src = cv.toDataURL("image/jpeg", 0.82);
      BQ_SWAPPED.push(im);
    } catch (_) { /* cross-origin image: leave it */ }
  });
}
function bqBeforePrint() {
  if (!BQ_LAST || PAGE !== "boutiques") return;
  document.body.classList.add("printing-bq");
  BQ_OPENED = $$("#bq-out details:not([open])");
  BQ_OPENED.forEach((d) => (d.open = true));
  bqShrinkImages();
  bqPrintHead();
}
function bqAfterPrint() {
  document.body.classList.remove("printing-bq");
  BQ_OPENED.forEach((d) => (d.open = false));
  BQ_SWAPPED.forEach((im) => { im.src = im.dataset.full; delete im.dataset.full; });
  BQ_OPENED = []; BQ_SWAPPED = [];
}
function bqPrint() {
  if (!BQ_LAST) return;
  const title = document.title;
  bqBeforePrint();
  document.title = bqPrintHead();          // becomes the suggested PDF file name
  const restore = () => { document.title = title; window.removeEventListener("afterprint", restore); };
  window.addEventListener("afterprint", restore);
  window.print();
}
window.addEventListener("beforeprint", bqBeforePrint);   // Cmd+P on the report works too
window.addEventListener("afterprint", bqAfterPrint);

function bqDownload() {
  if (!BQ_LAST) return;
  const lines = [["shoe", "your_colorways", "colorways_to_add", "action", "why", "size", "in_stock", "size_advice",
                  "competitors_carrying", "competitors_sold_out", "median_competitor_price", "your_price",
                  "ebay_ask_today", "predicted_resale_30d", "predicted_low", "predicted_high", "predicted_change_pct"]];
  BQ_LAST.out.forEach((e) => {
    const o = e.m.price_outlook && e.m.price_outlook.ok ? e.m.price_outlook : null;
    const c = [e.comps.length, e.soldOutAt, e.compPrice ? Math.round(e.compPrice) : "", e.myPrice ? Math.round(e.myPrice) : "",
               o ? o.now : "", o ? o.in30 : "", o ? o.lo : "", o ? o.hi : "", o ? o.change_pct : ""];
    const cwMine = (e.mineCw || []).map((x) => x.name || x.code).filter(Boolean).join(" | ");
    const cwAdd = (e.toAdd || []).map((x) => x.name).join(" | ");
    const head = [e.m.name, cwMine, cwAdd, e.verdict.label, e.verdict.why];
    if (!e.sizes.length) lines.push([...head, "", e.units, "", ...c]);
    e.sizes.forEach((s) => lines.push([...head, s.size, s.qty, s.verdict, ...c]));
    e.missingSizes.forEach((sz) => lines.push([...head, sz, 0, "restock (not stocked)", ...c]));
  });
  const csv = lines.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "solesight-reorder-report.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function bqRerender() { if (BQ_ROWS) bqRender(bqAnalyze(BQ_ROWS, ($("#bq-store") || {}).value || "")); }
function bqLoadText(text) { BQ_TEXT = text; BQ_ROWS = bqRows(bqParseCSV(text)); bqRerender(); }

/* Weekly email mode: scripts/weekly_reports.py opens
   boutiques.html?weekly=<csv path>&store=<domain> headlessly, prints it to PDF
   and reads the summary this writes into #bq-summary. */
function bqSummary() {
  const r = BQ_LAST;
  if (!r) return null;
  const reorder = r.out.filter((e) => e.verdict.key === "reorder");
  return {
    shoes: r.out.length, reorder: reorder.length,
    restock_sizes: r.out.reduce((a, e) => a + e.sizes.filter((z) => z.verdict === "restock").length + (window.BQ_PUBLIC ? 0 : e.missingSizes.length), 0),
    dont_reorder: r.out.filter((e) => e.verdict.key === "hold-off" || e.verdict.key === "markdown").length,
    top_reorder: reorder.slice(0, 3).map((e) => e.m.name),
    hot_missing: r.missing.slice(0, 3).map((m) => m.name),
    sold_fast: (r.sold ? r.sold.rows : []).slice(0, 3).map((x) => x.m.name),
    colorways_to_add: r.out.flatMap((e) => (e.toAdd || []).map((c) => ({ shoe: e.m.name, name: c.name, d: bqCwDemand(c) })))
      .sort((a, b) => b.d - a.d).slice(0, 3).map((x) => `${x.shoe} ${x.name}`),
    sold_fast_near: !!(r.sold && r.sold.key === "near"),
  };
}
async function bqWeeklyMode() {
  const q = new URLSearchParams(location.search);
  const path = q.get("weekly");
  if (!path) return;
  const pick = $("#bq-store");
  if (pick && q.get("store")) pick.value = q.get("store");
  const stq = q.get("state") || (DATA.stores && DATA.stores[q.get("store")] && DATA.stores[q.get("store")].state);
  if (stq && $("#bq-state")) $("#bq-state").value = stq;
  if (q.get("name")) window.BQ_STORE_NAME = q.get("name");
  if (q.get("public")) window.BQ_PUBLIC = true;
  const text = await fetch(path).then((r) => r.text());
  bqLoadText(text);
  bqBeforePrint();
  const out = document.createElement("script");
  out.type = "application/json"; out.id = "bq-summary";
  out.textContent = JSON.stringify(bqSummary());
  document.body.appendChild(out);
}

/* ---------- buy-price calculator ----------
   pay at most = sells for x (1 - fees - margin), per size, where
   sells for = median eBay ask for that size + condition x "% of ask you expect",
   lowered to the 30-day forecast when prices are expected to fall. */
const bcMedian = (xs) => { const v = [...xs].sort((a, b) => a - b); const n = v.length;
  return n ? (n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2) : null; };
function bcAsks(m, cond) {
  const by = {};
  (m.size_sources || []).filter((s) => s.kind === "resale" && s.condition === cond)
    .forEach((s) => s.sizes.forEach((z) => {
      const k = bqSize(z.size);
      if (k && z.price) (by[k] = by[k] || []).push(z.price);
    }));
  return by;
}
const BC_KEYS = ["fee", "margin", "real", "src"];
const BC_MIN_SIZE_LISTINGS = 3;
function bcSettings() {
  const num = (id, d) => { const v = parseFloat($("#bc-" + id).value); return isNaN(v) ? d : v; };
  const st = { fee: num("fee", 3) / 100, margin: num("margin", 25) / 100, real: num("real", 90) / 100,
               cond: $("#bc-cond").value, outlook: $("#bc-outlook").checked, src: ($("#bc-src") || {}).value || "ebay" };
  try { localStorage.setItem("bc-settings", JSON.stringify(BC_KEYS.reduce((o, k) => ({ ...o, [k]: ($("#bc-" + k) || {}).value }), {}))); } catch (_) {}
  return st;
}
// Stadium Goods (new pairs only): lowest ask per in-stock size, from its public store data
function bcMarket(m, st) {
  const sg = (m.marketplaces || {}).stadiumgoods;
  if (!sg || st.cond !== "Deadstock") return null;
  const sizes = {}, outliers = {};
  Object.entries(sg.sizes || {}).forEach(([k, v]) => { const z = bqSize(k); if (z && +z >= 3.5 && +z <= 18) sizes[z] = v; });
  // one consignor asking $992 when the other sizes sit at $269 isn't a price to pay off
  const mid = bcMedian(Object.values(sizes));
  Object.entries(sizes).forEach(([z, v]) => { if (v > mid * BC_SG_OUTLIER || v < mid / BC_SG_OUTLIER) { outliers[z] = v; delete sizes[z]; } });
  return Object.keys(sizes).length ? { ...sg, typical: bcMedian(Object.values(sizes)), sizes, outliers } : null;
}
const BC_SG_OUTLIER = 1.6;
// eBay sold prices (data.json "sold", last 90 days) when SoleSight has access
function bcSold(m, st) {
  const so = m.sold;
  if (!so) return null;
  if (st.cond === "Used") return so.used_median ? { shoe: so.used_median, n: so.used_n, sizes: {} } : null;
  const sizes = {};
  Object.entries(so.by_size || {}).forEach(([k, v]) => { const z = bqSize(k); if (z) sizes[z] = v; });
  return { shoe: so.new_median, n: so.new_n, sizes };
}
function bcCompute(m, st) {
  // per-size medians over every distinct listing in the last 14 days (size_asks);
  // older data files only had the cheapest listing per size (size_sources)
  const stats = (m.size_asks || {})[st.cond];
  const asks = stats ? Object.fromEntries(Object.entries(stats).map(([k, v]) => [bqSize(k), v]).filter(([k]) => k))
    : Object.fromEntries(Object.entries(bcAsks(m, st.cond)).map(([k, v]) => [k, { median: bcMedian(v), n: v.length }]));
  const n = Object.values(asks).reduce((a, v) => a + v.n, 0);
  const pooled = bcMedian(Object.values(asks).map((v) => v.median));
  const ebayShoe = (st.cond === "Deadstock" ? (m.resale_last || pooled) : pooled) || null;
  const sg = bcMarket(m, st);
  const sold = bcSold(m, st);
  const src = st.src === "sold" ? (sold ? "sold" : "ebay") : sg ? st.src : "ebay";
  // eBay / Stadium Goods / the lower of the two; falls back to whichever exists
  const pickAsk = (eb, sgv) => {
    if (eb == null) return sgv;
    if (sgv == null) return eb;
    return src === "sg" ? sgv : src === "low" ? Math.min(eb, sgv) : eb;
  };
  const shoeAsk = src === "sold" ? sold.shoe : pickAsk(ebayShoe, sg ? sg.typical : null);
  const o = m.price_outlook;
  const trend = st.outlook && o && o.ok && o.change_pct < 0 ? 1 + o.change_pct / 100 : 1;
  // sold prices are what pairs went for: no "% of the ask" discount
  const realize = src === "sold" ? 1 : st.real;
  const row = (ask) => {
    const sells = ask * realize * trend;
    return { ask, sells, pay: Math.max(0, Math.floor(sells * (1 - st.fee - st.margin) / 5) * 5) };
  };
  // An eBay size gets its own price only with >=3 listings; one optimistic ask
  // shouldn't make a shop overpay. Otherwise it uses the typical-pair price.
  // A Stadium Goods size price is that store's own lowest ask, so it stands alone.
  const all = [...new Set([...Object.keys(asks), ...Object.keys(sg ? sg.sizes : {}),
    ...Object.keys(sold ? sold.sizes : {})])].sort((a, b) => a - b);
  const sizes = all.map((sz) => {
    const e = asks[sz], own = !!e && e.n >= BC_MIN_SIZE_LISTINGS;
    const sgv = sg ? (sg.sizes[sz] ?? null) : null;
    const sv = sold && sold.sizes[sz] ? sold.sizes[sz] : null;     // 3+ sales in this size
    const eb = own ? e.median : ebayShoe;
    let ask, priced;
    if (src === "sold") { ask = sv ? sv.median : sold.shoe; priced = !!sv; }
    else {
      ask = sgv == null ? (eb ?? shoeAsk) : pickAsk(eb, sgv);
      // greyed out unless this size's own price (eBay with 3+ listings, or Stadium Goods) set it
      priced = (own && ask === eb) || (sgv != null && ask === sgv);
    }
    return { size: sz, n: e ? e.n : 0, own, ebay: own ? e.median : null, sg: sgv, sold: sv,
             sgOut: sg ? (sg.outliers[sz] ?? null) : null, priced, ...row(ask) };
  });
  return { sizes, shoe: shoeAsk ? row(shoeAsk) : null, trend, n, sg, sold, src };
}
function bcRender() {
  const out = $("#bc-out");
  if (!out) return;
  const name = $("#bc-shoe").value.trim().toLowerCase();
  const m = DATA.models.find((x) => x.name.toLowerCase() === name);
  if (!m) { out.innerHTML = name ? `<p class="bq-fine">Pick a shoe from the list.</p>` : ""; return; }
  const st = bcSettings();
  const r = bcCompute(m, st);
  const used = st.cond === "Used";
  if (!r.shoe) { out.innerHTML = `<p class="bq-empty">No ${used ? "used" : "new"} asks for this shoe right now.</p>`; return; }
  const money = (v) => "$" + Math.round(v);
  const srcName = { ebay: "eBay asks", sg: "Stadium Goods", low: "the lower of eBay and Stadium Goods",
    sold: "eBay sold prices (last 90 days)" }[r.src];
  const soldNote = st.src === "sold" && !r.sold
    ? (DATA.models.some((x) => x.sold) ? "Not enough eBay sales of this shoe in the last 90 days, so prices come from eBay asks."
      : "eBay sold prices aren't available yet, so prices come from eBay asks.") : "";
  const sgNote = used ? "Stadium Goods sells new pairs only, so used prices come from eBay."
    : !r.sg && DATA.models.some((x) => x.marketplaces && x.marketplaces.stadiumgoods)
      ? "Stadium Goods doesn't list this shoe right now, so prices come from eBay." : "";
  out.innerHTML = `
    <div class="bc-head"><div class="tile" data-slug="${m.slug}">${img(m, "")}</div>
      <div><b>${esc(m.name)}</b>
        <span>Typical ${used ? "used" : "new"} pair: pay at most <em>${money(r.shoe.pay)}</em>
          · sells for about ${money(r.shoe.sells)}${m.retail ? ` · retail $${m.retail}` : ""}</span>
        ${r.sg ? `<span class="bc-src">Priced off ${srcName}. New pair, typical ask:
          eBay ${m.resale_last ? money(m.resale_last) : "—"} ·
          <a href="${r.sg.url}" target="_blank" rel="noopener">Stadium Goods</a> ${money(r.sg.typical)}</span>` : ""}
        ${r.trend < 1 ? `<span class="bc-note">Prices lowered ${Math.round((1 - r.trend) * 100)}% — the 30-day forecast expects them to fall.</span>` : ""}
        ${r.sold ? `<span class="bc-src">eBay sold: typical ${money(r.sold.shoe)} over ${r.sold.n} ${used ? "used" : "new"} sale${r.sold.n === 1 ? "" : "s"} in 90 days${r.src === "sold" ? " — priced off these" : ""}.</span>` : ""}
        ${soldNote ? `<span class="bc-note">${soldNote}</span>` : ""}
        ${sgNote ? `<span class="bc-note">${sgNote}</span>` : ""}</div></div>
    ${r.sizes.some((z) => z.priced) ? `<table class="bq-table bc-table"><thead><tr><th>Size</th><th class="num">eBay ask</th>
      <th class="num">eBay listings</th>${r.sold ? `<th class="num">eBay sold</th>` : ""}${r.sg ? `<th class="num">Stadium Goods</th>` : ""}<th class="num">Sells for</th><th class="num">Pay at most</th></tr></thead><tbody>
      ${r.sizes.map((z) => `<tr${z.priced ? "" : ' class="thin"'}><td>${z.size}</td>
        <td class="num">${z.ebay != null ? money(z.ebay) : z.n ? "typical" : "—"}</td>
        <td class="num">${z.n || "—"}</td>${r.sold ? `<td class="num">${z.sold ? `${money(z.sold.median)}<small class="bq-ptitle">${z.sold.n} sold</small>` : "—"}</td>` : ""}${r.sg ? `<td class="num">${z.sg != null ? money(z.sg) : z.sgOut != null
          ? `<s title="Far from Stadium Goods' other sizes, so it isn't used">${money(z.sgOut)}</s>` : "—"}</td>` : ""}
        <td class="num">${money(z.sells)}</td><td class="num"><b>${money(z.pay)}</b></td></tr>`).join("")}</tbody></table>`
      : `<p class="bq-fine">Not enough listings per size yet to price sizes separately — the typical-pair
        price above applies to every size.</p>`}
    <p class="bq-fine">From ${r.n} current eBay ${used ? "used" : "new"} listings${r.sg ? ` and Stadium Goods' lowest new-pair ask in ${Object.keys(r.sg.sizes).length} sizes (checked ${r.sg.date})` : ""}
      — asking prices, not completed sales. An eBay size gets its own price only with ${BC_MIN_SIZE_LISTINGS}+ listings; otherwise it
      uses the typical-pair price (greyed out).${r.sold ? ` Sold prices: a size gets its own with 3+ sales; sold prices aren't discounted by "% of the ask".` : ""} A Stadium Goods size priced far from its other sizes is crossed out and not used. StockX and GOAT don't share their prices openly, so they aren't included.
      Always check the pair is authentic.</p>`;
  $$("#bc-out [data-slug]").forEach((x) => (x.onclick = () => openSheet(x.dataset.slug)));
}
function bcOpen(slug) {
  const m = DATA.models.find((x) => x.slug === slug);
  if (!m) return;
  $("#bc-shoe").value = m.name;
  bcRender();
  $("#bc").scrollIntoView({ behavior: "smooth", block: "start" });
}
function initBuyCalc() {
  if (!$("#bc")) return;
  $("#bc-shoes").innerHTML = DATA.models.map((m) => `<option value="${esc(m.name)}"></option>`).join("");
  try {
    const saved = JSON.parse(localStorage.getItem("bc-settings") || "{}");
    BC_KEYS.forEach((k) => { if (saved[k] != null && $("#bc-" + k)) $("#bc-" + k).value = saved[k]; });
    if (saved.src == null && $("#bc-src") && DATA.models.some((x) => x.sold)) $("#bc-src").value = "sold";
  } catch (_) {}
  ["bc-shoe", "bc-cond", "bc-src", "bc-fee", "bc-margin", "bc-real", "bc-outlook"].forEach((id) => {
    const el = $("#" + id);                 // a cached older page may lack a control
    if (!el) return;
    el.addEventListener("input", bcRender);
    el.addEventListener("change", bcRender);
  });
}

function initBoutique() {
  initBuyCalc();
  initDropPlan();
  const drop = $("#bq-drop"), file = $("#bq-file");
  if (!drop || !file) return;
  const read = (f) => { if (f) { BQ_FILENAME = f.name; f.text().then(bqLoadText); } };
  const pick = $("#bq-store");
  if (pick) {
    const stores = new Set();
    DATA.models.forEach((m) => (m.stockists || []).forEach((c) => stores.add(c.store)));
    pick.innerHTML = `<option value="">My store isn't one of the tracked boutiques</option>` +
      [...stores].map((d) => [d, bqStoreName(d)]).sort((a, b) => a[1].localeCompare(b[1]))
        .map(([d, n]) => `<option value="${d}">${esc(n)}</option>`).join("");
    pick.onchange = () => {
      const st = DATA.stores && DATA.stores[pick.value] && DATA.stores[pick.value].state;
      if (st && $("#bq-state")) $("#bq-state").value = st;
      bqRerender();
    };
  }
  const stPick = $("#bq-state");
  if (stPick) {
    stPick.innerHTML = `<option value="">Pick your state</option>` + BQ_STATES.map((x) => `<option>${x}</option>`).join("");
    stPick.onchange = bqRerender;
  }
  file.onchange = () => read(file.files[0]);
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => read(e.dataTransfer.files[0]));
  $("#bq-sample").onclick = () => fetch("sample-inventory.csv").then((r) => r.text()).then((t) => { BQ_FILENAME = "sample-inventory.csv"; bqLoadText(t); });
  bqWeeklyMode();
}


/* ---------- plan a drop ----------
   How many pairs per size for an upcoming release. Weights per size start from
   the sell-out size curve (bqSizeBase; BQ_PRIOR until there's enough data) and are adjusted like the report's
   size advice: by how often each size sells out at tracked shops, for this shoe
   if it's already on the index, otherwise for the brand's shoes on the index.
   Squared, so the middle of the run gets more than the tails; then the order is
   split with largest-remainder rounding. A starting point, not a guarantee. */
const DP_SIZES = Object.keys(BQ_PRIOR).sort((a, b) => a - b);
const DP_NOT_MENS = /\b(wmns|women'?s|womens|\(w\)|gs|grade school|kids|toddler|td|ps|preschool)\b/i;
function dpDrops() {
  const today = new Date().toISOString().slice(0, 10);
  return (DATA.releases || []).filter((r) => r.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
}
function dpPlan(drop, total) {
  const global = bqGlobalCurve();
  const m = drop.slug && DATA.models.find((x) => x.slug === drop.slug);
  let basis, model;
  if (m) { model = m; basis = `${m.name}'s own sell-outs at tracked shops`; }
  else {
    const same = DATA.models.filter((x) => (x.brand || "").toLowerCase() === (drop.brand || "").toLowerCase());
    model = { size_sources: same.flatMap((x) => (x.size_sources || []).filter((src) => src.kind === "boutique")) };
    basis = same.length ? `sell-outs of ${same.length} ${drop.brand} shoe${same.length === 1 ? "" : "s"} on the index`
      : "the typical sneaker size curve only (no shoes from this brand on the index yet)";
  }
  const scoreOf = bqSizeScores(model, global);
  const w = DP_SIZES.map((sz) => ({ size: sz, score: scoreOf(sz).score, seen: scoreOf(sz).seen }));
  const sum = w.reduce((a, x) => a + x.score ** 2, 0) || 1;
  w.forEach((x) => { x.share = x.score ** 2 / sum; x.exact = x.share * total; x.pairs = Math.floor(x.exact); });
  let left = total - w.reduce((a, x) => a + x.pairs, 0);
  [...w].sort((a, b) => (b.exact - b.pairs) - (a.exact - a.pairs)).forEach((x) => { if (left > 0) { x.pairs++; left--; } });
  return { rows: w, basis, seen: w.reduce((a, x) => a + x.seen, 0), base: bqSizeBase(model) };
}
// what the size curve under the report/plan starts from, in words
function bqBaseText(b, name) {
  if (b.source === "shoe") return `which sizes of ${name ? esc(name) : "this shoe"} sell out at tracked shops (${b.sellouts.toLocaleString("en-US")} sell-outs)`;
  if (b.source === "market") return `which sizes sell out across all tracked shoes and shops (${b.sellouts.toLocaleString("en-US")} sell-outs)`;
  return "the typical sneaker size curve";
}
function dpRender() {
  const out = $("#dp-out");
  if (!out) return;
  const drops = dpDrops();
  const drop = drops[+$("#dp-drop").value];
  const total = Math.max(1, Math.min(2000, parseInt($("#dp-pairs").value, 10) || 24));
  if (!drop) { out.innerHTML = `<p class="bq-empty">No upcoming drops on the calendar right now.</p>`; return; }
  const plan = dpPlan(drop, total);
  const peak = Math.max(...plan.rows.map((x) => x.pairs), 1);
  out.innerHTML = `
    ${DP_NOT_MENS.test(drop.name) ? `<p class="bc-note">This looks like a women's or kids' release. The run below uses men's sizes, so adjust it.</p>` : ""}
    <table class="bq-table dp-table"><thead><tr><th>Size</th><th class="num">Share</th><th class="num">Pairs</th><th></th></tr></thead>
      <tbody>${plan.rows.map((x) => `<tr${x.pairs ? "" : ' class="thin"'}><td>${x.size}</td>
        <td class="num">${Math.round(x.share * 100)}%</td><td class="num"><b>${x.pairs}</b></td>
        <td><span class="dp-bar" style="width:${Math.round(x.pairs / peak * 100)}%"></span></td></tr>`).join("")}</tbody></table>
    <p class="bq-fine">${total} pairs of ${esc(drop.name)} (${dropWhen ? dropWhen(drop) : drop.date}${drop.price ? `, $${drop.price} retail` : ""}).
      Based on ${bqBaseText(plan.base, drop.slug ? (DATA.models.find((x) => x.slug === drop.slug) || {}).name : null)}, adjusted by ${plan.basis}${plan.seen ? ` (${plan.seen} size listings)` : ""}.
      A starting point: your own past sales by size beat any curve.</p>`;
}
function initDropPlan() {
  const sel = $("#dp-drop");
  if (!sel) return;
  const drops = dpDrops();
  sel.innerHTML = drops.length ? drops.map((r, i) => `<option value="${i}">${esc(r.date.slice(5).replace("-", "/"))} · ${esc(r.name)}</option>`).join("")
    : `<option value="">No upcoming drops</option>`;
  const want = new URLSearchParams(location.search).get("drop");
  if (want) { const i = drops.findIndex((r) => r.name === want); if (i >= 0) sel.value = String(i); }
  ["dp-drop", "dp-pairs"].forEach((id) => { const el = $("#" + id); el.addEventListener("input", dpRender); el.addEventListener("change", dpRender); });
  dpRender();
}
