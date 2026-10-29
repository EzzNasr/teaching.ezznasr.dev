// S1: student page (attend/attend.js + index.html) in a stub browser. node tests/attendance/student_page.test.js
// The stub DOM is built from the REAL index.html ids, so a script reference to a missing element fails loudly.
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const site = path.join(__dirname, "..", "..");
const html = fs.readFileSync(path.join(site, "attend/index.html"), "utf8");
const src = fs.readFileSync(path.join(site, "attend/attend.js"), "utf8");
const BASE_CFG = require(path.join(site, "contract/att_config.js"));
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok  " + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 1500) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await wait(5); } assert.fail("timeout waiting for: " + what); }

function mkEl(id, hidden, disabled) {
  const h = {}, e = { id, hidden: !!hidden, textContent: "", className: "", value: "", readOnly: false, disabled: !!disabled, children: [], style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, f) { (h[t] = h[t] || []).push(f); }, focus() {}, appendChild(c) { e.children.push(c); return c; },
    click() { if (e.disabled || e.hidden) return; (h.click || []).forEach(f => f({})); }, fire(t, ev) { (h[t] || []).forEach(f => f(ev || {})); } };
  return e;
}
// opts: perm ('granted'|'prompt'|'denied'|undefined=no Permissions API), geo(call#, options) -> {ok,coords}|{code}|'hang', api(action,payload) -> object|Promise, cfg overrides, ls seed, ua
function boot(opts = {}) {
  const ids = {}; for (const m of html.matchAll(/<(\w+)([^>]*?)\sid="([^"]+)"([^>]*)>/g)) ids[m[3]] = [/\bhidden\b/.test(m[2] + " " + m[4]), /\bdisabled\b/.test(m[2] + " " + m[4])];
  const els = {}; Object.keys(ids).forEach(i => els[i] = mkEl(i, ids[i][0], ids[i][1]));
  const ls = Object.assign({}, opts.ls || {}), geoCalls = [], apiCalls = [], docH = {}, winH = {};
  let permChange = null;
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, URLSearchParams, crypto: require("crypto").webcrypto });
  ctx.window = ctx; ctx.self = ctx;
  ctx.ATT_CONFIG = Object.assign({}, BASE_CFG, opts.cfg || {});
  ctx.document = { getElementById: i => els[i] || null, createElement: t => t === "canvas" ? { getContext: () => null } : mkEl("_" + t), cookie: "", hidden: false,
    addEventListener: (t, f) => { (docH[t] = docH[t] || []).push(f); } };
  ctx.addEventListener = (t, f) => { (winH[t] = winH[t] || []).push(f); };
  ctx.localStorage = { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } };
  ctx.location = { search: opts.qs === undefined ? "?s=S-1&t=tok" : opts.qs, protocol: "https:" };
  ctx.screen = { width: 390, height: 844 };
  ctx.isSecureContext = opts.insecure ? false : true;
  const nav = { language: "en", hardwareConcurrency: 4, userAgent: opts.ua || "Mozilla/5.0 (Linux; Android 14) Chrome/120", onLine: opts.online !== false, maxTouchPoints: 5 };
  if (!opts.noGeo) nav.geolocation = { getCurrentPosition(ok2, err, o) {
    const n = geoCalls.push(o); const r = (opts.geo || (() => ({ ok: true, coords: { latitude: 31.2, longitude: 29.9, accuracy: 12 } })))(n, o);
    if (r === "hang") return;
    setTimeout(() => r.coords ? ok2({ coords: r.coords }) : err({ code: r.code }), 1);
  } };
  if (opts.perm) { const state = { state: opts.perm, addEventListener(t, f) { if (t === "change") permChange = f; } }; nav.permissions = { query: async () => state }; ctx._permState = state; }
  ctx.navigator = nav;
  ctx.attApi = { call: (a, p) => { apiCalls.push({ action: a, payload: p }); const r = opts.api ? opts.api(a, p) : undefined; return Promise.resolve(r === undefined ? defaultApi(a, p) : r); } };
  const now = Date.now();
  function defaultApi(a) {
    if (a === "att_ticket") return { ok: true, ticket: "TK", expires_at: now + 240000, close_utc: new Date(now + 300000).toISOString(), server_utc: new Date().toISOString() };
    if (a === "att_attend") return { ok: true, status: "recorded", server_utc: new Date().toISOString(), name: "Ali" };
    if (a === "att_signup") return { ok: true, status: "registered" };
    if (a === "att_change_device") return { ok: true, status: "pending", req_id: "R1" };
    return { ok: false, code: "UNKNOWN_ACTION" };
  }
  vm.runInContext(src, ctx, { filename: "attend.js" });
  const page = { els, ls, geoCalls, apiCalls, ctx, docH, winH,
    shown: () => ["gate", "form", "done"].filter(v => !els[v].hidden),
    acts: () => apiCalls.map(c => c.action),
    last: a => apiCalls.filter(c => c.action === a).pop(),
    setPerm(s) { ctx._permState.state = s; if (permChange) permChange(); },
    stop() { vm.runInContext("void 0", ctx); } };
  return page;
}
const okGeo = () => ({ coords: { latitude: 31.2, longitude: 29.9, accuracy: 12 } });
const timers = []; const origSI = global.setInterval;

(async () => {
  console.log("boot without a QR");
  let p = boot({ qs: "" }); await wait(20);
  ok(/Scan the QR/.test(p.els.msg.textContent) && p.shown().length === 0, "no QR: message only, no gate/form");
  ok(p.geoCalls.length === 0, "no location request without a QR");

  console.log("gate: permission still to be asked");
  p = boot({ perm: "prompt" }); await until(() => p.shown().join() === "gate", "gate visible");
  ok(p.els.gateBtn.textContent === "Allow location" && !p.els.gateBtn.disabled, "gate shows an Allow location button");
  ok(p.els.form.hidden && p.els.save.disabled, "ID/name/Save are not usable before the gate passes");
  await wait(30); ok(p.geoCalls.length === 0, "NO location request until the student taps");
  ok(!p.acts().includes("att_attend"), "no auto check-in on load");

  console.log("gate: returning student is NOT auto-checked-in any more");
  p = boot({ perm: "prompt", ls: { att_secret: "a".repeat(64), att_id: "20240001", att_name: "Ali" } });
  await until(() => p.shown().join() === "gate", "gate for a returning student"); await wait(30);
  ok(p.geoCalls.length === 0 && !p.acts().includes("att_attend"), "returning student: no geolocation call and no att_attend before a tap");
  p.els.gateBtn.click(); await until(() => p.shown().join() === "form", "form after allow");
  ok(p.geoCalls.length === 1 && p.geoCalls[0].enableHighAccuracy === true && p.geoCalls[0].maximumAge === 0, "stage 1 = high accuracy, no cache");
  ok(/Welcome, Ali/.test(p.els.welcome.textContent) && !p.els.save.disabled, "form shows Welcome + enabled Save after the gate");
  ok(!p.acts().includes("att_attend"), "still no att_attend until Save is tapped");
  p.els.save.click(); await until(() => p.shown().join() === "done", "done screen");
  let pl = p.last("att_attend").payload;
  ok(pl.geo.lat === 31.2 && pl.geo.lng === 29.9 && pl.geo.acc === 12 && !("denied" in pl.geo), "attend carries the real fix");
  ok(pl.diag.perm && pl.diag.attempts === 1 && pl.diag.online === true && pl.diag.inapp === false, "diag: perm, attempts, online, inapp");
  ok(p.els.doneName.textContent === "Welcome, Ali" && /^Recorded at \d\d:\d\d:\d\d$/.test(p.els.doneTime.textContent) && p.els.doneNote.textContent === "", "success screen: name + recorded time, no location note");
  ok(p.els.busy.hidden, "overlay closed after success");

  console.log("gate: permission already granted -> silent");
  p = boot({ perm: "granted" }); await until(() => p.shown().join() === "form", "silent pass");
  ok(p.geoCalls.length === 1, "granted: one silent fix, no tap needed");
  ok(!p.acts().includes("att_attend"), "granted: still no auto check-in");

  console.log("gate: denied, then skip after 2 failures");
  p = boot({ perm: "denied", geo: () => ({ code: 1 }) }); await until(() => p.shown().join() === "gate" && /blocked/i.test(p.els.gateTitle.textContent), "denied wording");
  ok(p.els.gateSteps.children.length >= 2 && !p.els.gateHelp.hidden, "denied: how-to steps shown");
  ok(p.els.gateSkipBox.hidden, "skip hidden before any failed attempt");
  p.els.gateBtn.click(); await until(() => p.els.gateMsg.textContent !== "" && !p.els.gateBtn.disabled, "first failure");
  ok(p.els.gateSkipBox.hidden && p.geoCalls.length === 1, "1 failure: still no skip, and a denial does not retry with a second stage");
  p.els.gateBtn.click(); await until(() => !p.els.gateSkipBox.hidden, "skip appears");
  ok(p.shown().join() === "gate", "2 failures: skip offered, student still on the gate");
  p.els.gateSkip.click(); ok(p.shown().join() === "form", "skip -> form");
  p.els.sid.value = "20240001"; p.els.save.click(); await until(() => p.acts().includes("att_attend"), "attend sent");
  pl = p.last("att_attend").payload;
  ok(pl.geo.denied === true && pl.geo.reason === "USER_SKIPPED" && pl.diag.fail_reason === "PERMISSION_DENIED" && pl.diag.attempts === 2, "skipped check-in: reason USER_SKIPPED, diag keeps PERMISSION_DENIED + attempts=2");

  console.log("location failure reasons");
  p = boot({ perm: "prompt", geo: (n, o) => o.enableHighAccuracy ? { code: 3 } : okGeo() });
  await until(() => p.shown().join() === "gate", "gate"); p.els.gateBtn.click(); await until(() => p.shown().join() === "form", "recovers via stage 2");
  ok(p.geoCalls.length === 2 && p.geoCalls[1].enableHighAccuracy === false && p.geoCalls[1].maximumAge === 60000, "high-accuracy timeout -> automatic coarse retry (cache <= 60 s)");
  p = boot({ perm: "prompt", geo: () => ({ code: 2 }) });
  await until(() => p.shown().join() === "gate", "gate"); p.els.gateBtn.click(); await until(() => /Couldn't find/.test(p.els.gateTitle.textContent), "weak wording");
  ok(p.geoCalls.length === 2, "unavailable: both stages tried");
  ok(!/blocked/i.test(p.els.gateTitle.textContent), "unavailable is NOT presented as blocked");
  p.els.gateBtn.click(); await until(() => !p.els.gateSkipBox.hidden, "skip");
  p.els.gateSkip.click(); p.els.sid.value = "20240001"; p.els.save.click(); await until(() => p.acts().includes("att_attend"), "attend");
  ok(p.last("att_attend").payload.diag.fail_reason === "POSITION_UNAVAILABLE", "server is told POSITION_UNAVAILABLE, not 'denied'");
  p = boot({ noGeo: true, perm: undefined }); await until(() => p.shown().join() === "gate", "gate");
  p.els.gateBtn.click(); await until(() => /can't share/i.test(p.els.gateTitle.textContent), "unsupported wording");
  ok(!p.els.gateSkipBox.hidden, "unsupported browser: skip offered immediately (retrying cannot help)");
  p = boot({ insecure: true }); await until(() => p.shown().join() === "gate", "gate");
  p.els.gateBtn.click(); await until(() => /can't share/i.test(p.els.gateTitle.textContent), "insecure");
  p.els.gateSkip.click(); p.els.sid.value = "20240001"; p.els.save.click(); await until(() => p.acts().includes("att_attend"), "attend");
  ok(p.last("att_attend").payload.diag.fail_reason === "INSECURE_CONTEXT", "INSECURE_CONTEXT reported");
  p = boot({ perm: undefined }); await until(() => p.shown().join() === "gate" && p.els.gateTitle.textContent.startsWith("Turn on"), "no Permissions API -> treated as 'ask'");
  ok(p.geoCalls.length === 0, "no Permissions API: still waits for a tap");
  p = boot({ perm: "prompt", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1", geo: () => ({ code: 1 }) });
  await until(() => p.shown().join() === "gate", "gate"); p.els.gateBtn.click(); await until(() => p.els.gateSteps.children.length > 0, "ios steps");
  ok(/aA/.test(p.els.gateSteps.children[0].textContent), "iOS gets the aA / Website Settings instructions");
  p = boot({ perm: "prompt", ua: "Mozilla/5.0 (iPhone) Instagram 300.0", geo: () => ({ code: 1 }) });
  await until(() => p.shown().join() === "gate", "gate"); p.els.gateBtn.click(); await until(() => p.els.gateSteps.children.length > 0, "inapp steps");
  ok(/menu/i.test(p.els.gateSteps.children[0].textContent), "in-app browser is told to open in Chrome/Safari");

  console.log("settings change while the gate is open");
  p = boot({ perm: "denied", geo: () => okGeo() }); await until(() => p.shown().join() === "gate", "gate");
  p.setPerm("granted"); await until(() => p.shown().join() === "form", "auto-continue when permission flips to granted");
  ok(p.geoCalls.length === 1, "flip to granted -> one automatic attempt");

  console.log("blocking overlay while saving");
  let release; const gate = new Promise(r => release = r);
  p = boot({ perm: "granted", ls: { att_secret: "a".repeat(64), att_id: "20240001" }, api: (a, pl2) => a === "att_attend" ? gate.then(() => ({ ok: true, status: "recorded", server_utc: new Date().toISOString() })) : undefined });
  await until(() => p.shown().join() === "form", "form"); p.els.save.click();
  await until(() => !p.els.busy.hidden, "overlay on tap");
  ok(/Don't close/.test(p.els.busyWarn.textContent), "overlay says don't close this page");
  await until(() => /Saving attendance/.test(p.els.busyStep.textContent), "saving step");
  ok(p.els.save.disabled && p.els.signup.disabled && p.els.change.disabled, "controls disabled while saving");
  let prevented = false; const ev = { preventDefault() { prevented = true; }, returnValue: undefined };
  p.winH.beforeunload.forEach(f => f(ev)); ok(prevented, "beforeunload asks the browser to confirm while saving");
  p.els.save.click(); await wait(10); ok(p.apiCalls.filter(c => c.action === "att_attend").length === 1, "a second tap while saving sends nothing");
  release(); await until(() => p.shown().join() === "done", "done"); ok(p.els.busy.hidden, "overlay closes only after the server answered");
  prevented = false; p.winH.beforeunload.forEach(f => f(ev)); ok(!prevented, "no unload warning once saved");

  console.log("watchdog + retry (never a false success)");
  let n = 0, late;
  p = boot({ perm: "granted", cfg: { SUBMIT_WATCHDOG_MS: 60 }, ls: { att_secret: "a".repeat(64), att_id: "20240001" },
    api: (a) => { if (a !== "att_attend") return undefined; n++; return n === 1 ? new Promise(r => late = r) : { ok: true, status: "recorded", server_utc: new Date().toISOString() }; } });
  await until(() => p.shown().join() === "form", "form"); p.els.save.click();
  await until(() => !p.els.busyRetry.hidden, "retry card after watchdog");
  ok(/not confirmed/i.test(p.els.busyErr.textContent) && p.shown().join() === "form" && !p.els.busy.hidden, "watchdog: 'not confirmed', overlay still blocks, no success shown");
  p.els.busyRetry.click(); await until(() => p.shown().join() === "done", "retry succeeds");
  ok(p.apiCalls.filter(c => c.action === "att_attend").length === 2, "retry sends att_attend again (server de-duplicates per session+student)");
  late({ ok: false, code: "SERVER_ERROR" }); await wait(10); ok(p.shown().join() === "done" && p.els.busy.hidden, "a stale error from the abandoned attempt changes nothing");
  n = 0; p = boot({ perm: "granted", cfg: { SUBMIT_WATCHDOG_MS: 60 }, ls: { att_secret: "a".repeat(64), att_id: "20240001" },
    api: (a) => { if (a !== "att_attend") return undefined; n++; return n === 1 ? new Promise(r => late = r) : new Promise(() => {}); } });
  await until(() => p.shown().join() === "form", "form"); p.els.save.click(); await until(() => !p.els.busyRetry.hidden, "retry card");
  p.els.busyRetry.click(); await wait(10);
  late({ ok: true, status: "recorded", server_utc: new Date().toISOString() }); await until(() => p.shown().join() === "done", "late success of the first attempt is honoured");

  console.log("network / server errors");
  p = boot({ perm: "granted", ls: { att_secret: "a".repeat(64), att_id: "20240001" }, api: (a) => a === "att_attend" ? { ok: false, code: "NETWORK" } : undefined });
  await until(() => p.shown().join() === "form", "form"); p.els.save.click(); await until(() => !p.els.busyRetry.hidden, "retry card on NETWORK");
  ok(/not saved yet/i.test(p.els.busyErr.textContent) && p.shown().join() === "form", "NETWORK: 'not saved yet' + Retry, never 'recorded'");
  p = boot({ perm: "granted", ls: { att_secret: "a".repeat(64), att_id: "20240001" }, api: (a) => a === "att_attend" ? { ok: false, code: "BUSY" } : undefined });
  await until(() => p.shown().join() === "form", "form"); p.els.save.click(); await until(() => !p.els.busyRetry.hidden, "retry card on BUSY");
  ok(/busy/i.test(p.els.busyErr.textContent), "BUSY -> retry card");
  p = boot({ perm: "granted", ls: { att_secret: "a".repeat(64), att_id: "20240001" }, api: (a) => a === "att_attend" ? { ok: false, code: "DEVICE_ID_CONFLICT" } : undefined });
  await until(() => p.shown().join() === "form", "form"); p.els.save.click(); await until(() => /DETECTED/.test(p.els.msg.textContent), "hard error message");
  ok(p.els.busy.hidden && p.shown().join() === "form", "definite server refusal: overlay closes and the message shows");

  console.log("fix freshness at submit");
  p = boot({ perm: "granted", cfg: { GEO_MAX_AGE_MS: 40 }, ls: { att_secret: "a".repeat(64), att_id: "20240001" } });
  await until(() => p.shown().join() === "form", "form"); await wait(90);
  p.els.save.click(); await until(() => p.shown().join() === "done", "done");
  ok(p.geoCalls.length === 2, "a stale fix (older than GEO_MAX_AGE_MS, 60 s by default) is re-acquired at submit");
  p = boot({ perm: "granted", cfg: { GEO_MAX_AGE_MS: 40 }, ls: { att_secret: "a".repeat(64), att_id: "20240001" }, geo: (n2) => n2 === 1 ? okGeo() : { code: 3 } });
  await until(() => p.shown().join() === "form", "form"); await wait(90);
  p.els.save.click(); await until(() => p.shown().join() === "done", "done");
  ok(p.last("att_attend").payload.geo.lat === 31.2, "re-acquire fails -> the older real fix is still sent, not 'denied'");
  p = boot({ perm: "granted", ls: { att_secret: "a".repeat(64), att_id: "20240001" } });
  await until(() => p.shown().join() === "form", "form"); p.els.save.click(); await until(() => p.shown().join() === "done", "done");
  ok(p.geoCalls.length === 1, "a fresh fix is reused (no second location request)");

  console.log("sign-up keeps one overlay across both calls");
  let seen = [];
  p = boot({ perm: "granted", api: (a, pl3) => { if (a === "att_attend" && !seen.includes("su")) return { ok: false, code: "UNKNOWN_STUDENT" }; if (a === "att_signup") { seen.push("su"); return { ok: true, status: "registered" }; } return undefined; } });
  await until(() => p.shown().join() === "form", "form");
  p.els.sid.value = "20241234"; p.els.save.click(); await until(() => /First time/.test(p.els.msg.textContent), "UNKNOWN_STUDENT -> sign up hint");
  ok(p.els.busy.hidden && !p.els.signup.hidden, "UNKNOWN_STUDENT: overlay closed, sign-up offered");
  p.els.name.value = "Sara"; p.els.signup.click(); await until(() => p.shown().join() === "done", "signup then attend");
  ok(p.acts().filter(a => a === "att_signup").length === 1 && p.acts().filter(a => a === "att_attend").length === 2, "sign-up then attend");
  ok(p.geoCalls.length === 1, "sign-up + attend share one location fix");
  ok(p.last("att_signup").payload.name === "Sara" && p.last("att_signup").payload.geo.lat === 31.2, "sign-up payload carries name + fix");
  p = boot({ perm: "granted" }); await until(() => p.shown().join() === "form", "form");
  p.els.sid.value = "20241234"; p.els.name.value = "Sara"; p.els.save.click(); await until(() => p.shown().join() === "done", "typed ID + name, big button");
  ok(p.acts().includes("att_signup"), "first-timer with ID + name on the big button is registered");

  console.log("change device");
  p = boot({ perm: "granted" }); await until(() => p.shown().join() === "form", "form");
  p.els.sid.value = "20240001"; p.els.change.click(); await until(() => /Request sent/.test(p.els.msg.textContent), "pending");
  ok(p.geoCalls.length === 1 && p.last("att_change_device").payload.geo === undefined, "change device sends no location");
  ok(p.els.busy.hidden, "overlay closed after the request was sent");

  console.log("countdown + ticket");
  p = boot({ perm: "granted", api: (a) => a === "att_ticket" ? { ok: true, ticket: "T", expires_at: Date.now() + 5000, close_utc: new Date(Date.now() + 300000).toISOString(), server_utc: new Date().toISOString() } : undefined });
  await until(() => p.shown().join() === "form", "form");
  await until(() => /QR valid/.test(p.els.sub.textContent), "countdown");
  ok(/QR valid 00:0[45]/.test(p.els.sub.textContent), "ticket countdown comes from the server's expires_at (" + p.els.sub.textContent + ")");
  p = boot({ perm: "granted", api: (a) => a === "att_ticket" ? { ok: true, ticket: "T", close_utc: new Date(Date.now() + 300000).toISOString(), server_utc: new Date().toISOString() } : undefined });
  await until(() => p.shown().join() === "form", "form");
  await until(() => /QR valid/.test(p.els.sub.textContent), "countdown");
  ok(/QR valid (04:00|03:59)/.test(p.els.sub.textContent), "no expires_at -> falls back to TICKET_SEC 240 (" + p.els.sub.textContent + ")");
  p = boot({ perm: "prompt", api: (a) => a === "att_ticket" ? { ok: true, ticket: "T", expires_at: Date.now() + 400, close_utc: new Date(Date.now() + 300000).toISOString(), server_utc: new Date().toISOString() } : undefined });
  await until(() => p.shown().join() === "gate", "gate"); await until(() => /expired/i.test(p.els.msg.textContent), "QR expiry while on the gate", 2500);
  ok(p.shown().length === 0 && p.els.gateBtn.disabled, "QR expiring on the gate: gate closes with 'scan again'");
  ok(BASE_CFG.TICKET_SEC === 240, "att_config.TICKET_SEC is 240");
  const closeAt = Date.now() + 900;
  p = boot({ perm: "granted", ls: { att_secret: "a".repeat(64), att_id: "20240001" }, api: (a) => a === "att_ticket" ? { ok: true, ticket: "T", expires_at: Date.now() + 240000, close_utc: new Date(closeAt).toISOString(), server_utc: new Date().toISOString() } : undefined });
  await until(() => p.shown().join() === "form", "form"); p.els.save.click(); await until(() => p.shown().join() === "done", "done");
  await wait(1100); ok(p.shown().join() === "done" && p.els.msg.textContent === "", "session closing after a successful save does not overwrite the success screen");

  console.log("skipped check-in shows the review note");
  p = boot({ perm: "denied", geo: () => ({ code: 1 }) }); await until(() => p.shown().join() === "gate", "gate");
  p.els.gateBtn.click(); await until(() => p.els.gateMsg.textContent !== "", "f1"); p.els.gateBtn.click(); await until(() => !p.els.gateSkipBox.hidden, "skip");
  p.els.gateSkip.click(); p.els.sid.value = "20240001"; p.els.name.value = "Ali"; p.els.save.click(); await until(() => p.shown().join() === "done", "done");
  ok(/could not be verified/.test(p.els.doneNote.textContent), "done screen tells a skipped student it was recorded for review");

  console.log(`\n${pass} passed`);
  process.exit(0);
})().catch(e => { console.error("FAIL:", e && e.message || e); process.exit(1); });
