/* SoleSight store accounts (optional) — sign in by email link, save your store
   and inventory, get the reorder report every Monday.

   Off unless web/config.js has Supabase settings (written at build time from
   the SUPABASE_URL / SUPABASE_ANON_KEY repo settings). The anon key is meant to
   be public: row-level security (supabase/schema.sql) means a signed-in shop
   can only reach its own rows. Without an account nothing is uploaded. */
(function () {
  const cfg = window.SOLESIGHT_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return;
  const SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
  let sb = null, store = null;

  const $a = (s) => document.querySelector(s);
  const say = (msg, bad) => { const el = $a("#acct-msg"); if (el) { el.textContent = msg; el.classList.toggle("bad", !!bad); } };

  function load(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  async function refresh() {
    const { data: { session } } = await sb.auth.getSession();
    const signedIn = !!session;
    $a("#acct-out").hidden = signedIn;
    $a("#acct-in").hidden = !signedIn;
    if (!signedIn) return;
    $a("#acct-who").textContent = session.user.email;
    const { data } = await sb.from("stores").select("*").maybeSingle();
    store = data;
    if (!store) {
      const ins = await sb.from("stores").insert({ email: session.user.email }).select().single();
      store = ins.data;
    }
    if (!store) { say("Couldn't open your store — try signing in again.", true); return; }
    $a("#acct-name").value = store.name || "";
    $a("#acct-email").value = store.email || session.user.email;
    $a("#acct-weekly").checked = store.weekly_email;
    const pick = $a("#bq-store");
    if (pick && store.tracked_store) { pick.value = store.tracked_store; }
    if (store.fee != null && $a("#bc-fee")) $a("#bc-fee").value = store.fee;
    if (store.margin != null && $a("#bc-margin")) $a("#bc-margin").value = store.margin;
    const last = await sb.from("inventories").select("id, filename, rows, uploaded_at")
      .eq("store_id", store.id).order("uploaded_at", { ascending: false }).limit(1).maybeSingle();
    const inv = last.data;
    $a("#acct-load").hidden = !inv;
    $a("#acct-last").textContent = inv
      ? `Saved inventory: ${inv.filename || "inventory.csv"}, ${new Date(inv.uploaded_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
      : "No inventory saved yet — load one above, then save it.";
  }

  async function saveSettings() {
    if (!store) return;
    const patch = {
      name: $a("#acct-name").value.trim() || null,
      email: $a("#acct-email").value.trim() || null,
      weekly_email: $a("#acct-weekly").checked,
      tracked_store: ($a("#bq-store") || {}).value || null,
      fee: parseFloat(($a("#bc-fee") || {}).value) || null,
      margin: parseFloat(($a("#bc-margin") || {}).value) || null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await sb.from("stores").update(patch).eq("id", store.id);
    say(error ? "Couldn't save: " + error.message : "Saved.", !!error);
    if (!error) Object.assign(store, patch);
  }

  async function saveInventory() {
    if (!store) return;
    if (typeof BQ_TEXT === "undefined" || !BQ_TEXT) { say("Load an inventory file first.", true); return; }
    const { error } = await sb.from("inventories").insert({
      store_id: store.id, csv: BQ_TEXT, filename: BQ_FILENAME || "inventory.csv",
      rows: (BQ_ROWS || []).length });
    say(error ? "Couldn't save: " + error.message : "Inventory saved to your account — it's what Monday's report will use.", !!error);
    if (!error) refresh();
  }

  async function loadSaved(id, quiet) {
    let q = sb.from("inventories").select("csv, filename").eq("store_id", store.id);
    q = id ? q.eq("id", id) : q.order("uploaded_at", { ascending: false }).limit(1);
    const { data, error } = await q.maybeSingle();
    if (error || !data) { if (!quiet) say("Nothing saved yet.", true); return; }
    BQ_FILENAME = data.filename;
    bqLoadText(data.csv);
    if (!quiet) say("Loaded your saved inventory.");
  }

  async function sendLink() {
    const email = $a("#acct-login").value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) { say("Enter your email address.", true); return; }
    const { error } = await sb.auth.signInWithOtp({
      email, options: { emailRedirectTo: location.origin + "/boutiques.html" } });
    say(error ? "Couldn't send the link: " + error.message : "Check your inbox — the sign-in link is on its way.", !!error);
  }

  async function init() {
    const box = $a("#acct");
    if (!box) return;
    try { await load(SDK); } catch (_) { return; }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    box.hidden = false;
    $a("#acct-send").onclick = sendLink;
    $a("#acct-save").onclick = saveSettings;
    $a("#acct-saveinv").onclick = saveInventory;
    $a("#acct-load").onclick = () => loadSaved(null, false);
    $a("#acct-signout").onclick = async () => { await sb.auth.signOut(); store = null; refresh(); };
    sb.auth.onAuthStateChange(() => refresh());
    refresh();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
