// The sending loop, with no WhatsApp library in it (wa.js is passed in), so it is tested in CI with fakes
// (tests/wa/sender.test.js). One call of cycle() = one round: deliver old reports, heartbeat, claim, send, report.
//
// Rules it keeps:
//   - write the journal BEFORE sending; an id already in the journal is never sent again
//   - wait the server's random gap between two messages, plus a short "typing..." pause that grows with the text
//   - a number that is not on WhatsApp is a final failure; a network / socket error is retryable
//   - if WhatsApp is not connected, do not claim (the server would hold the items for 15 minutes for nothing)
"use strict";

function rand(a, b) { return a + Math.random() * (b - a); }

/** api: {claim(max), report(results), heartbeat(state)} ; wa: {state(), exists(to), send(to, text), typing(to, ms)} ; journal: Journal */
async function cycle(o) {
  const { api, wa, journal, log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)) } = o;
  const out = { sent: 0, failed: 0, reported: 0, wait_sec: 60, why: "" };

  // 1. results the server never got (network down last time, or a restart right after sending)
  const pending = journal.unreported();
  journal.interrupted().forEach(id => {   // stopped mid-send: we do not know whether it went out, so never resend it
    journal.mark(id, { state: "failed", reported: false, error: "the phone restarted while sending; check the chat before sending again" });
    pending.push(Object.assign({ id }, journal.get(id)));
  });
  if (pending.length) {
    try {
      await api.report(pending.map(x => x.state === "sent" ? { id: x.id, ok: true, wa_id: x.wa_id || "" }
        : { id: x.id, ok: false, error: x.error || "failed", retryable: x.state === "retry" }));
      pending.forEach(x => { if (x.state === "retry") { delete journal.data.items[x.id]; journal.save(); } else journal.mark(x.id, { reported: true }); });
      out.reported += pending.length;
    } catch (e) { log("report later: " + e.message); out.why = "server unreachable"; return out; }
  }

  // 2. alive?
  const state = wa.state();
  try { await api.heartbeat(state); } catch (e) { log("heartbeat failed: " + e.message); }
  if (state !== "connected") { out.why = "WhatsApp " + state; out.wait_sec = 30; return out; }

  // 3. work
  let claim;
  try { claim = await api.claim(5); } catch (e) { log("claim failed: " + e.message); out.why = "server unreachable"; out.wait_sec = 120; return out; }
  if (!claim || claim.ok === false) { out.why = (claim && claim.error) || "claim refused"; out.wait_sec = 600; return out; }
  const items = claim.items || [], gap = claim.gap || { min: 25, max: 75 };
  out.wait_sec = items.length ? 5 : (claim.wait_sec || 300); out.why = claim.why || "";

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (journal.get(it.id)) { log("skip " + it.id + ": already in the journal"); continue; }   // handed out twice? never send twice
    if (i > 0) await sleep(rand(gap.min, gap.max) * 1000);
    journal.mark(it.id, { state: "attempt", to: it.to, reported: false });
    let res;
    try {
      if (!(await wa.exists(it.to))) res = { ok: false, error: "this number is not on WhatsApp", retryable: false };
      else {
        await wa.typing(it.to, Math.min(8000, 1500 + it.text.length * 25));
        const id = await wa.send(it.to, it.text);
        res = { ok: true, wa_id: id || "" };
      }
    } catch (e) { res = { ok: false, error: String(e && e.message || e).slice(0, 200), retryable: true }; }
    journal.mark(it.id, res.ok ? { state: "sent", wa_id: res.wa_id, reported: false } : { state: res.retryable ? "retry" : "failed", error: res.error, reported: false });
    if (res.ok) out.sent++; else out.failed++;
    log((res.ok ? "sent " : "not sent ") + it.id + (res.ok ? "" : ": " + res.error));
    try {
      await api.report([Object.assign({ id: it.id }, res)]);
      journal.mark(it.id, { reported: true });
      out.reported++;
    } catch (e) { log("report later " + it.id + ": " + e.message); }
    // a retryable failure is the server's to re-queue; drop it from the journal so the next hand-out is allowed
    if (!res.ok && res.retryable && journal.get(it.id).reported) { delete journal.data.items[it.id]; journal.save(); }
    if (!res.ok && res.retryable && wa.state() !== "connected") {   // the socket dropped: hand the untouched rest straight back
      const rest = items.slice(i + 1).filter(x => !journal.get(x.id));
      if (rest.length) { try { await api.report(rest.map(x => ({ id: x.id, ok: false, error: "not attempted: WhatsApp disconnected", retryable: true }))); } catch (e) { log("could not return " + rest.length + " items: " + e.message); } }
      break;
    }
  }
  return out;
}

module.exports = { cycle };
