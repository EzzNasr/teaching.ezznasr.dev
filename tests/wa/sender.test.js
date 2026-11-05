// node tests/wa/sender.test.js : the phone's sending loop (tools/wa-sender/lib/loop.js + journal.js) with a fake server and a fake
// WhatsApp, plus a run against the REAL FollowupWhatsApp.gs (harness) end to end. No WhatsApp library is loaded.
//  - sends what the server hands out, waits the server's gap, reports each one
//  - journal before sending: a restart mid-send never resends, it reports "check the chat" instead
//  - a report that fails (network) is delivered on the next round; a duplicate hand-out is never sent twice
//  - not on WhatsApp = final failure; a socket error = retryable; not connected = no claim
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
const { cycle } = require("../../tools/wa-sender/lib/loop");
const { Journal } = require("../../tools/wa-sender/lib/journal");
const { makeApi } = require("../../tools/wa-sender/lib/api");
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok  " + m); };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-")), "journal.json");

function fakeWa(o = {}) {
  const sent = [], typed = [];
  return { sent, typed, st: o.state || "connected", state() { return this.st; },
    async exists(to) { return !(o.notOn || []).includes(to); },
    async typing(to, ms) { typed.push(ms); },
    async send(to, text) { if (o.boom && o.boom.includes(to)) { if (o.drop) this.st = "connecting"; throw new Error("socket closed"); } sent.push({ to, text }); return "MSG" + sent.length; } };
}
function fakeApi(items, o = {}) {
  const reports = [], beats = [];
  let claims = 0;
  return { reports, beats, get claims() { return claims; },
    async claim() { claims++; if (o.claimFail) throw new Error("offline"); const out = items.splice(0); return { ok: true, items: out, gap: { min: 1, max: 2 }, wait_sec: out.length ? 0 : 300 }; },
    async report(r) { if (o.reportFail && o.reportFail-- > 0) throw new Error("offline"); reports.push(...r); return { ok: true }; },
    async heartbeat(s) { beats.push(s); return { ok: true }; } };
}
const sleeps = [];
const sleep = ms => { sleeps.push(ms); return Promise.resolve(); };

(async () => {
  console.log("sending");
  {
    const wa = fakeWa(), api = fakeApi([{ id: "A", to: "201100000001", text: "hi 1" }, { id: "B", to: "201100000002", text: "hi 2" }]), j = new Journal(tmp());
    const r = await cycle({ api, wa, journal: j, sleep });
    ok(r.sent === 2 && wa.sent.length === 2 && wa.sent[0].text === "hi 1", "sends both messages in order");
    ok(api.reports.length === 2 && api.reports.every(x => x.ok === true) && api.reports[0].wa_id === "MSG1", "reports each one with the WhatsApp id");
    ok(sleeps.length === 1 && sleeps[0] >= 1000 && sleeps[0] <= 2000, "waits the server's random gap between two messages (" + sleeps[0] + " ms)");
    ok(wa.typed.length === 2 && wa.typed.every(ms => ms >= 1500 && ms <= 8000), "shows 'typing...' for a moment before each message");
    ok(api.beats[0] === "connected" && j.get("A").state === "sent" && j.get("A").reported === true, "heartbeat sent; journal records sent + reported");
    const again = await cycle({ api: fakeApi([{ id: "A", to: "201100000001", text: "hi 1" }]), wa, journal: j, sleep });
    ok(again.sent === 0 && wa.sent.length === 2, "the same id handed out again is never sent twice (journal)");
  }
  console.log("failures");
  {
    const wa = fakeWa({ notOn: ["201100000009"], boom: ["201100000008"] }), api = fakeApi([{ id: "N", to: "201100000009", text: "x" }, { id: "E", to: "201100000008", text: "y" }]), j = new Journal(tmp());
    await cycle({ api, wa, journal: j, sleep });
    const n = api.reports.find(x => x.id === "N"), e = api.reports.find(x => x.id === "E");
    ok(n && n.ok === false && n.retryable === false && /not on WhatsApp/.test(n.error), "a number not on WhatsApp is a final failure");
    ok(e && e.ok === false && e.retryable === true && /socket closed/.test(e.error), "a socket error is retryable");
    ok(!j.get("E"), "a reported retryable failure leaves the journal, so the server may hand it out again");
  }
  {
    const wa = fakeWa({ boom: ["201100000001"], drop: true }), api = fakeApi([{ id: "A", to: "201100000001", text: "x" }, { id: "B", to: "201100000002", text: "y" }]), j = new Journal(tmp());
    await cycle({ api, wa, journal: j, sleep });
    const B = api.reports.find(x => x.id === "B");
    ok(wa.sent.length === 0 && B && B.ok === false && B.retryable === true && /not attempted/.test(B.error) && !j.get("B"), "the socket drops mid-batch: the untouched rest goes straight back to the queue (never attempted)");
  }
  console.log("test mode reacts at once, live keeps the pace");
  {
    const mk = (mode, items, gap) => ({ beats: [], async claim() { return { ok: true, mode, items: items.splice(0), gap, wait_sec: 300 }; },
      async report() { return { ok: true }; }, async heartbeat(s) { this.beats.push(s); return { ok: true }; } });
    const j = new Journal(tmp()), ctx = {};
    const tEmpty = await cycle({ api: mk("test", [], { min: 25, max: 75 }), wa: fakeWa(), journal: j, sleep, ctx });
    ok(tEmpty.wait_sec === 10, "test mode, queue empty: looks again in 10 s, not the server's 5 minutes (" + tEmpty.wait_sec + ")");
    sleeps.length = 0;
    await cycle({ api: mk("test", [{ id: "T1", to: "201100000001", text: "a" }, { id: "T2", to: "201100000001", text: "b" }], { min: 25, max: 75 }), wa: fakeWa(), journal: j, sleep, ctx });
    ok(sleeps.length === 1 && sleeps[0] >= 5000 && sleeps[0] <= 10000, "test mode: messages 5-10 s apart (" + Math.round(sleeps[0]) + " ms)");
    const lEmpty = await cycle({ api: mk("live", [], { min: 25, max: 75 }), wa: fakeWa(), journal: j, sleep, ctx: {} });
    ok(lEmpty.wait_sec === 300, "live mode keeps the server's 5-minute check");
    sleeps.length = 0;
    await cycle({ api: mk("live", [{ id: "L1", to: "201100000001", text: "a" }, { id: "L2", to: "201100000002", text: "b" }], { min: 25, max: 75 }), wa: fakeWa(), journal: j, sleep, ctx: {} });
    ok(sleeps.length === 1 && sleeps[0] >= 25000 && sleeps[0] <= 75000, "live mode keeps the server's 25-75 s gap");
    const a = mk("test", [], { min: 25, max: 75 }), c2 = {};
    for (let i = 0; i < 5; i++) await cycle({ api: a, wa: fakeWa(), journal: j, sleep, ctx: c2 });
    ok(a.beats.length === 1, "fast polling sends the heartbeat once every few minutes, not every round (" + a.beats.length + " in 5 rounds)");
  }
  console.log("not connected / server down");
  {
    const wa = fakeWa({ state: "logged_out" }), api = fakeApi([{ id: "A", to: "201100000001", text: "x" }]), j = new Journal(tmp());
    const r = await cycle({ api, wa, journal: j, sleep });
    ok(api.claims === 0 && api.beats[0] === "logged_out" && /logged_out/.test(r.why), "logged out: tells the server, claims nothing");
    const r2 = await cycle({ api: fakeApi([], { claimFail: true }), wa: fakeWa(), journal: j, sleep });
    ok(/unreachable/.test(r2.why) && r2.wait_sec >= 60, "server unreachable: waits and tries later");
  }
  console.log("crash safety");
  {
    const file = tmp(), j1 = new Journal(file);
    const api = fakeApi([{ id: "A", to: "201100000001", text: "x" }], { reportFail: 1 }), wa = fakeWa();
    await cycle({ api, wa, journal: j1, sleep });
    ok(wa.sent.length === 1 && api.reports.length === 0 && j1.get("A").reported === false, "sent, but the report failed: kept in the journal");
    const j2 = new Journal(file);   // restart
    const api2 = fakeApi([]);
    await cycle({ api: api2, wa: fakeWa(), journal: j2, sleep });
    ok(api2.reports.length === 1 && api2.reports[0].id === "A" && api2.reports[0].ok === true, "after a restart the missing report is delivered first");
    j2.mark("Z", { state: "attempt", to: "201100000003", reported: false });   // a crash in the middle of sending Z
    const j3 = new Journal(file), api3 = fakeApi([{ id: "Z", to: "201100000003", text: "x" }]), wa3 = fakeWa();
    await cycle({ api: api3, wa: wa3, journal: j3, sleep });
    const z = api3.reports.find(x => x.id === "Z");
    ok(z && z.ok === false && z.retryable === false && /check the chat/.test(z.error) && wa3.sent.length === 0, "interrupted mid-send: never resent, reported as 'check the chat'");
    ok(JSON.parse(fs.readFileSync(file, "utf8")).items.Z.state === "failed" && !fs.existsSync(file + ".tmp"), "the journal is written atomically to disk");
  }
  console.log("against the real server (FollowupWhatsApp.gs on the harness)");
  {
    const { load } = require("../../tools/quiz-maker-v2/tests/harness");
    const AS = path.join(__dirname, "../../tools/quiz-maker-v2/apps_script");
    const env = load([path.join(AS, "Code.gs"), path.join(AS, "FollowupRouter.gs"), path.join(AS, "FollowupWhatsApp.gs")], { clock: true, props: { FF_PARENT_LOG: "1", WA_MODE: "live" } });
    env.ctx.UrlFetchApp = { fetch() { return { getResponseCode: () => 200 }; } };
    env.setNow("2026-11-07T12:00:00+02:00"); env.ctx.fu2_wa_setup();
    const L = "programming/grade-2/chapter-2-lesson-1-loops";
    const q = env.post({ action: "admin_fu2_wa_enqueue", token: "tok", event: "parents_hw", group: "Sat", items: [1, 2, 3].map(n => ({ student_key: "010000000" + n, student_phone: "010000000" + n, name: "S" + n, to: "2011000000" + n, text: "msg " + n, log_items: [{ kind: "homework", ref: L }] })) });
    ok(q.queued === 3, "3 messages queued through doPost");
    // the phone's real api client, with fetch going to the harness doPost
    const fetchImpl = async (url, init) => ({ status: 200, text: async () => JSON.stringify(env.post(JSON.parse(init.body))) });
    const api = makeApi({ api_url: "x", wa_token: env.props.WA_SENDER_TOKEN }, fetchImpl), wa = fakeWa(), j = new Journal(tmp());
    const r = await cycle({ api, wa, journal: j, sleep });
    ok(r.sent === 3 && wa.sent.map(m => m.to).join() === "20110000001,20110000002,20110000003", "the phone claims and sends all three");
    const rows = env.ctx.fu2_wa_rows_(env.getSS("DATA").getSheetByName("WaOutbox"));
    ok(rows.every(x => x.status === "sent"), "the server marks them sent");
    ok(env.ctx._p2fuNotifications(env.getSS("STU")).length === 3, "and writes the 3 parent contacts to the log");
    const bad = await makeApi({ api_url: "x", wa_token: "0".repeat(64) }, fetchImpl).claim(1).then(() => "no", e => e.message);
    ok(/Unauthorized: check wa_token/.test(bad), "a wrong token gives a clear message");
  }
  console.log("\n" + pass + " sender checks passed");
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
