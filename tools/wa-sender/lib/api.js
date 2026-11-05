// Talks to the Apps Script /exec URL (FollowupWhatsApp.gs). Plain POST with a text/plain JSON body, like the site does.
// Apps Script answers a POST with a redirect to the result; fetch follows it.
"use strict";

function makeApi(cfg, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  async function call(action, extra) {
    const body = JSON.stringify(Object.assign({ action, wa_token: cfg.wa_token }, extra || {}));
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 60000);
    try {
      const res = await f(cfg.api_url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, redirect: "follow", signal: ctl.signal });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (e) { throw new Error("not JSON (HTTP " + res.status + "): " + text.slice(0, 80)); }
      if (json && json.ok === false && /Unauthorized/.test(json.error || "")) throw new Error("Unauthorized: check wa_token in config.json (fu2_wa_setup shows it)");
      return json;
    } finally { clearTimeout(t); }
  }
  return {
    claim: max => call("admin_fu2_wa_claim", { max }),
    report: results => call("admin_fu2_wa_report", { results }).then(r => { if (!r || r.ok === false) throw new Error((r && r.error) || "report refused"); return r; }),
    heartbeat: (state, extra) => call("admin_fu2_wa_heartbeat", Object.assign({ state, app: "wa-sender/1" }, extra || {})),
  };
}
module.exports = { makeApi };
