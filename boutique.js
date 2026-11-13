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
  return (size) => {
    const g = global[size] ?? 0.5, s = stat[size] || { n: 0, out: 0 };
    let score = BQ_PRIOR[size] ?? 0.3;
    // sells out here more (or less) than this size usually does, shrunk when few listings
    if (s.n) score += 0.3 * (s.out / s.n - g) * (s.n / (s.n + 2));
    // resells above (or below) this shoe's typical deadstock ask
    if (med && asks[size]) score += 0.25 * Math.max(-0.5, Math.min(0.5, asks[size] / med - 1));
    return { score: Math.max(0, Math.min(1, score)), seen: s.n, ask: asks[size] || null };
  };
}

/* ---------- verdicts ---------- */
const BQ_HOT = new Set(["peaking", "heating", "emerging"]);
function bqShoeVerdict(m, units) {
  const h = m.hype ?? 0;
  if (h >= 70 || (BQ_HOT.has(m.stage) && h >= 50))
    return { key: "reorder", label: "Reorder", why: `Hype ${h}${m.stage ? `, ${m.stage}` : ""}${m.hype_delta_7d ? `, ${fmtSigned(m.hype_delta_7d, "")} this week` : ""}` };
  if (h < 40 || (m.stage === "cooling" && h < 60))
    return { key: units >= 10 ? "markdown" : "hold-off", label: units >= 10 ? "Consider a markdown" : "Don't reorder",
             why: `Hype ${h}${m.stage ? `, ${m.stage}` : ""} — sell through what you have` };
  return { key: "hold", label: "Hold", why: `Hype ${h}, steady — keep your current depth` };
}
function bqSizeVerdict(shoeKey, qty, sc) {
  const hotSize = sc.score >= 0.6, coldSize = sc.score < 0.4;
  if (shoeKey === "reorder" && hotSize && (qty ?? 0) <= 1) return "restock";
  if ((qty ?? 0) >= 3 && (coldSize || shoeKey !== "reorder")) return "heavy";
  return "ok";
}

/* ---------- competitors (public Shopify data from tracked boutiques) ---------- */
const bqMedian = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null; };
const bqStoreName = (d) => (typeof STORE_NAMES !== "undefined" && STORE_NAMES[d]) || d;
function bqCompetitors(m, myStore) {
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

/* ---------- report ---------- */
let BQ_LAST = null, BQ_ROWS = null, BQ_TEXT = null, BQ_FILENAME = null;
function bqAnalyze(rows, myStore) {
  const index = DATA.models.map((m) => ({ m, sku: m.sku ? bqNorm(m.sku) : null, tok: bqTokens(m.name) }));
  const global = bqGlobalCurve();
  const shoes = new Map(), untracked = new Map();
  rows.forEach((r) => {
    const hit = bqMatch(r, index);
    if (!hit) { untracked.set(r.title, (untracked.get(r.title) || 0) + (r.qty || 0)); return; }
    const e = shoes.get(hit.m.slug) || { m: hit.m, how: hit.how, sizes: {}, colors: new Set(), units: 0, sold: null, prices: [] };
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
    const mine = [...e.colors].map((c) => c.toLowerCase());
    const colorways = (e.m.colorways || []).map((c) => ({
      ...c, carried: mine.some((x) => bqTokens(c.name).size && [...bqTokens(c.name)].every((t) => x.includes(t))),
    }));
    const comps = bqCompetitors(e.m, myStore);
    const myPrice = bqMedian(e.prices);
    const compPrice = bqMedian(comps.filter((c) => c.comparable).map((c) => c.price));
    return { ...e, verdict: v, sizes, missingSizes, colorways, comps, myPrice, compPrice,
             soldOutAt: comps.filter((c) => c.left === 0).length };
  });
  const order = { reorder: 0, hold: 1, "hold-off": 2, markdown: 3 };
  out.sort((a, b) => order[a.verdict.key] - order[b.verdict.key] || (b.m.hype ?? 0) - (a.m.hype ?? 0));
  const carried = new Set(out.map((e) => e.m.slug));
  const missing = DATA.models.filter((m) => !carried.has(m.slug)).slice(0, 8);
  // which competitors overlap most with this store's shelves
  const byStore = {};
  out.forEach((e) => e.comps.forEach((c) => {
    const b = byStore[c.store] = byStore[c.store] || { name: c.name, shoes: 0, inStock: 0, gaps: [] };
    b.shoes++; if (c.left > 0) b.inStock++;
    if (e.myPrice && c.comparable) b.gaps.push(c.price - e.myPrice);
  }));
  const overview = Object.values(byStore).sort((a, b) => b.shoes - a.shoes || b.inStock - a.inStock)
    .map((b) => ({ ...b, gap: bqMedian(b.gaps) }));
  BQ_LAST = { out, untracked: [...untracked.entries()], missing, rows: rows.length, overview, myStore };
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
  const restock = rep.out.reduce((a, e) => a + e.sizes.filter((s) => s.verdict === "restock").length + e.missingSizes.length, 0);
  const lbl = { restock: "Restock", ok: "OK", heavy: "Heavy" };
  const cards = rep.out.map((e) => `
    <article class="bq-shoe">
      <div class="bq-thumb tile" data-slug="${e.m.slug}">${img(e.m, "")}</div>
      <div class="bq-main">
        <div class="bq-top"><span class="bq-badge ${e.verdict.key}">${e.verdict.label}</span>
          <span class="bq-why">${esc(e.verdict.why)}</span>
          <button class="bq-buybtn" data-buy="${e.m.slug}" type="button">Buy prices →</button></div>
        <h4 class="bq-name" data-slug="${e.m.slug}">${esc(e.m.name)}</h4>
        <div class="bq-meta">${e.units} pairs in stock · matched by ${e.how}${e.sold != null ? ` · ${e.sold} sold` : ""}${e.m.resale_premium ? ` · resells at ${e.m.resale_premium.toFixed(1)}× retail` : ""}</div>
        ${e.sizes.length ? `<div class="bq-sizes">${e.sizes.map((s) => `
          <span class="bq-size ${s.verdict}" title="Demand ${Math.round(s.score * 100)}/100 · ${s.seen ? `${s.seen} tracked store listing${s.seen === 1 ? "" : "s"}` : "market-wide size curve"}${s.ask ? ` · eBay ask $${Math.round(s.ask)}` : ""}">
            <b>${s.size}</b><small>${s.qty} · ${lbl[s.verdict]}</small></span>`).join("")}</div>` : ""}
        ${e.missingSizes.length ? `<p class="bq-note"><b>Not stocked, but in demand:</b> sizes ${e.missingSizes.join(", ")}.</p>` : ""}
        ${bqOutlook(e)}
        ${bqCompBlock(e)}
        ${e.colorways.length ? `<p class="bq-note"><b>Colorways in the market:</b> ${e.colorways.slice(0, 4).map((c) =>
          `${esc(c.name)} ($${Math.round(c.price_low)}${c.price_high !== c.price_low ? `–$${Math.round(c.price_high)}` : ""}, ${c.stores} store${c.stores === 1 ? "" : "s"})${c.carried ? " ✓ you carry" : ""}`).join(" · ")}</p>` : ""}
      </div>
    </article>`).join("");
  el.innerHTML = `
    <div class="bq-summary">
      <div><b>${rep.out.length}</b><span>Tracked shoes found</span></div>
      <div class="hl"><b>${n("reorder")}</b><span>To reorder</span></div>
      <div><b>${restock}</b><span>Sizes to restock</span></div>
      <div><b>${n("hold-off") + n("markdown")}</b><span>Don't reorder</span></div>
    </div>
    <div class="bq-actions"><button class="btn btn-solid" id="bq-pdf">Save as PDF</button>
      <button class="btn btn-ghost" id="bq-dl">Download as CSV</button>
      <span class="bq-fine">Based on tonight's index (${new Date(DATA.generated_at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}).
        Size advice blends the typical sneaker size curve with each shoe's own resale prices and sell-outs at
        tracked stores — guidance, not exact quantities${rep.out.some((e) => e.sold != null) ? "" : ". Add a units-sold column to make it specific to your store"}.</span></div>
    ${bqOverview(rep)}
    <h3 class="bq-h">Shoe by shoe</h3>
    <div class="bq-list">${cards}</div>
    ${rep.missing.length ? `<h3 class="bq-h">Hot right now — not in your inventory</h3>
      <div class="bq-missing">${rep.missing.map((m) => `<div class="bq-miss" data-slug="${m.slug}">
        <div class="tile">${img(m, "")}</div><span>${esc(m.name)}</span><b>${m.hype ?? "—"}</b></div>`).join("")}</div>` : ""}
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
  if (!e.comps.length) return `<p class="bq-note"><b>Competitors:</b> none of the ${typeof STORE_NAMES !== "undefined" ? Object.keys(STORE_NAMES).length : 19} tracked boutiques list it right now.</p>`;
  const inStock = e.comps.filter((c) => c.left > 0).length;
  const priced = e.comps.filter((c) => c.comparable).map((c) => c.price);
  const from = priced.length ? `from $${Math.round(Math.min(...priced))}` : "";
  let gap = "";
  if (e.myPrice && e.compPrice) {
    const d = Math.round(e.myPrice - e.compPrice);
    gap = Math.abs(d) < 5 ? `Your price ($${Math.round(e.myPrice)}) is in line with the median competitor.`
      : `Your price ($${Math.round(e.myPrice)}) is <b>$${Math.abs(d)} ${d > 0 ? "above" : "below"}</b> the median competitor ($${Math.round(e.compPrice)}).`;
  }
  const scarce = e.soldOutAt && e.units > 0
    ? `Sold out at ${e.soldOutAt} of ${e.comps.length} other store${e.comps.length === 1 ? "" : "s"} — you're one of the few with stock.` : "";
  const rows = e.comps.map((c) => `<tr>
      <td><a href="${c.url || `https://${c.store}`}" target="_blank" rel="noopener">${esc(c.name)} ↗</a>${c.title ? `<small class="bq-ptitle">${esc(c.title)}</small>` : ""}</td>
      <td class="num">${c.price ? "$" + Math.round(c.price) : "—"}${c.price && !c.comparable ? `<small class="bq-ptitle" title="Looks like a different listing (${c.used ? "used pair" : "price far from this shoe's usual range"}), so it's left out of price comparisons">not compared</small>` : ""}</td>
      <td>${c.left === 0 ? `<span class="bq-out">Sold out</span>` : `${c.left} of ${c.total} sizes left${c.sizes.length ? `: ${c.sizes.slice(0, 8).join(", ")}${c.sizes.length > 8 ? "…" : ""}` : ""}`}</td></tr>`).join("");
  return `<details class="bq-comp">
      <summary><b>Competitors:</b> ${e.comps.length} store${e.comps.length === 1 ? "" : "s"} carry it · ${inStock} in stock ${from ? "· " + from : ""}</summary>
      ${gap || scarce ? `<p class="bq-note">${[gap, scarce].filter(Boolean).join(" ")}</p>` : ""}
      <table class="bq-table"><thead><tr><th>Store</th><th class="num">Price</th><th>Sizes</th></tr></thead><tbody>${rows}</tbody></table>
    </details>`;
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
      <span>${when} · scored against tonight's index · solesight.xyz/boutiques.html</span></div>`;
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
  const lines = [["shoe", "action", "why", "size", "in_stock", "size_advice",
                  "competitors_carrying", "competitors_sold_out", "median_competitor_price", "your_price",
                  "ebay_ask_today", "predicted_resale_30d", "predicted_low", "predicted_high", "predicted_change_pct"]];
  BQ_LAST.out.forEach((e) => {
    const o = e.m.price_outlook && e.m.price_outlook.ok ? e.m.price_outlook : null;
    const c = [e.comps.length, e.soldOutAt, e.compPrice ? Math.round(e.compPrice) : "", e.myPrice ? Math.round(e.myPrice) : "",
               o ? o.now : "", o ? o.in30 : "", o ? o.lo : "", o ? o.hi : "", o ? o.change_pct : ""];
    if (!e.sizes.length) lines.push([e.m.name, e.verdict.label, e.verdict.why, "", e.units, "", ...c]);
    e.sizes.forEach((s) => lines.push([e.m.name, e.verdict.label, e.verdict.why, s.size, s.qty, s.verdict, ...c]));
    e.missingSizes.forEach((sz) => lines.push([e.m.name, e.verdict.label, e.verdict.why, sz, 0, "restock (not stocked)", ...c]));
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
    restock_sizes: r.out.reduce((a, e) => a + e.sizes.filter((z) => z.verdict === "restock").length + e.missingSizes.length, 0),
    dont_reorder: r.out.filter((e) => e.verdict.key === "hold-off" || e.verdict.key === "markdown").length,
    top_reorder: reorder.slice(0, 3).map((e) => e.m.name),
    hot_missing: r.missing.slice(0, 3).map((m) => m.name),
  };
}
async function bqWeeklyMode() {
  const q = new URLSearchParams(location.search);
  const path = q.get("weekly");
  if (!path) return;
  const pick = $("#bq-store");
  if (pick && q.get("store")) pick.value = q.get("store");
  if (q.get("name")) window.BQ_STORE_NAME = q.get("name");
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
const BC_KEYS = ["fee", "margin", "real"];
const BC_MIN_SIZE_LISTINGS = 3;
function bcSettings() {
  const num = (id, d) => { const v = parseFloat($("#bc-" + id).value); return isNaN(v) ? d : v; };
  const st = { fee: num("fee", 3) / 100, margin: num("margin", 25) / 100, real: num("real", 90) / 100,
               cond: $("#bc-cond").value, outlook: $("#bc-outlook").checked };
  try { localStorage.setItem("bc-settings", JSON.stringify(BC_KEYS.reduce((o, k) => ({ ...o, [k]: $("#bc-" + k).value }), {}))); } catch (_) {}
  return st;
}
function bcCompute(m, st) {
  // per-size medians over every distinct listing in the last 14 days (size_asks);
  // older data files only had the cheapest listing per size (size_sources)
  const stats = (m.size_asks || {})[st.cond];
  const asks = stats ? Object.fromEntries(Object.entries(stats).map(([k, v]) => [bqSize(k), v]).filter(([k]) => k))
    : Object.fromEntries(Object.entries(bcAsks(m, st.cond)).map(([k, v]) => [k, { median: bcMedian(v), n: v.length }]));
  const n = Object.values(asks).reduce((a, v) => a + v.n, 0);
  const pooled = bcMedian(Object.values(asks).map((v) => v.median));
  const shoeAsk = st.cond === "Deadstock" ? (m.resale_last || pooled) : pooled;
  const o = m.price_outlook;
  const trend = st.outlook && o && o.ok && o.change_pct < 0 ? 1 + o.change_pct / 100 : 1;
  const row = (ask) => {
    const sells = ask * st.real * trend;
    return { ask, sells, pay: Math.max(0, Math.floor(sells * (1 - st.fee - st.margin) / 5) * 5) };
  };
  // a size gets its own price only with >=3 listings; one optimistic ask
  // shouldn't make a shop overpay. Otherwise it uses the typical-pair price.
  const sizes = Object.keys(asks).sort((a, b) => a - b).map((sz) => {
    const own = asks[sz].n >= BC_MIN_SIZE_LISTINGS;
    return { size: sz, n: asks[sz].n, own, ...row(own ? asks[sz].median : shoeAsk) };
  });
  return { sizes, shoe: shoeAsk ? row(shoeAsk) : null, trend, n };
}
function bcRender() {
  const out = $("#bc-out");
  if (!out) return;
  const name = $("#bc-shoe").value.trim().toLowerCase();
  const m = DATA.models.find((x) => x.name.toLowerCase() === name);
  if (!m) { out.innerHTML = name ? `<p class="bq-fine">Pick a shoe from the list.</p>` : ""; return; }
  const st = bcSettings();
  const r = bcCompute(m, st);
  if (!r.shoe) { out.innerHTML = `<p class="bq-empty">No ${st.cond === "Used" ? "used" : "new"} eBay asks for this shoe right now.</p>`; return; }
  const $$$ = (v) => "$" + Math.round(v);
  out.innerHTML = `
    <div class="bc-head"><div class="tile" data-slug="${m.slug}">${img(m, "")}</div>
      <div><b>${esc(m.name)}</b>
        <span>Typical ${st.cond === "Used" ? "used" : "new"} pair: pay at most <em>${$$$(r.shoe.pay)}</em>
          · sells for about ${$$$(r.shoe.sells)}${m.retail ? ` · retail $${m.retail}` : ""}</span>
        ${r.trend < 1 ? `<span class="bc-note">Prices lowered ${Math.round((1 - r.trend) * 100)}% — the 30-day forecast expects them to fall.</span>` : ""}</div></div>
    ${r.sizes.some((z) => z.own) ? `<table class="bq-table bc-table"><thead><tr><th>Size</th><th class="num">eBay ask</th>
      <th class="num">Listings</th><th class="num">Sells for</th><th class="num">Pay at most</th></tr></thead><tbody>
      ${r.sizes.map((z) => `<tr${z.own ? "" : ' class="thin"'}><td>${z.size}</td><td class="num">${z.own ? $$$(z.ask) : "typical"}</td>
        <td class="num">${z.n}</td><td class="num">${$$$(z.sells)}</td>
        <td class="num"><b>${$$$(z.pay)}</b></td></tr>`).join("")}</tbody></table>`
      : `<p class="bq-fine">Not enough listings per size yet to price sizes separately — the typical-pair
        price above applies to every size.</p>`}
    <p class="bq-fine">From ${r.n} current eBay ${st.cond === "Used" ? "used" : "new"} listings (asking prices, not completed sales).
      A size gets its own price only with ${BC_MIN_SIZE_LISTINGS}+ listings; otherwise it uses the typical-pair price
      (greyed out). Always check the pair is authentic.</p>`;
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
    BC_KEYS.forEach((k) => { if (saved[k] != null) $("#bc-" + k).value = saved[k]; });
  } catch (_) {}
  ["bc-shoe", "bc-cond", "bc-fee", "bc-margin", "bc-real", "bc-outlook"].forEach((id) => {
    $("#" + id).addEventListener("input", bcRender);
    $("#" + id).addEventListener("change", bcRender);
  });
}

function initBoutique() {
  initBuyCalc();
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
    pick.onchange = bqRerender;
  }
  file.onchange = () => read(file.files[0]);
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => read(e.dataTransfer.files[0]));
  $("#bq-sample").onclick = () => fetch("sample-inventory.csv").then((r) => r.text()).then((t) => { BQ_FILENAME = "sample-inventory.csv"; bqLoadText(t); });
  bqWeeklyMode();
}
