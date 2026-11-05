// npm start : the WhatsApp sender. Runs forever on the spare phone (Termux), see docs/whatsapp/README.md.
// Every round: deliver old reports, say "alive", ask the server for queued messages, send them slowly, report each one.
// The server decides WHAT and WHEN (mode, sending hours, daily cap, gap); this only sends and reports.
"use strict";
const fs = require("fs"), path = require("path");
const { Journal } = require("./lib/journal");
const { makeApi } = require("./lib/api");
const { cycle } = require("./lib/loop");

function loadConfig() {
  const file = path.join(__dirname, "config.json");
  if (!fs.existsSync(file)) { console.error("config.json is missing: copy config.example.json and fill it in"); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(cfg.api_url || "")) { console.error("config.json: api_url must be the /exec URL"); process.exit(2); }
  if (!/^[0-9a-f]{32,}$/.test(cfg.wa_token || "")) { console.error("config.json: wa_token is missing (run fu2_wa_setup in Apps Script)"); process.exit(2); }
  return cfg;
}
function log(s) { console.log(new Date().toISOString().replace("T", " ").slice(0, 19) + "  " + s); }

async function main() {
  const cfg = loadConfig();
  const api = makeApi(cfg);
  const journal = new Journal(path.join(__dirname, "data", "journal.json"));
  const wa = await require("./lib/wa").connect(cfg, log);
  if (!wa.registered()) log("This phone is not linked yet: stop this and run `npm run pair` first.");
  let rounds = 0;
  process.on("SIGTERM", () => { log("stopping"); wa.stop(); process.exit(0); });
  for (;;) {
    let r;
    try { r = await cycle({ api, wa, journal, log }); } catch (e) { log("round failed: " + (e && e.stack || e)); r = { wait_sec: 60 }; }
    if (r.sent || r.failed) log("round: " + r.sent + " sent, " + r.failed + " not sent");
    else if (rounds % 12 === 0) log("idle: " + (r.why || "nothing to do"));
    if (++rounds % 500 === 0) journal.prune(30);
    const wait = Math.max(5, Math.min(1800, r.wait_sec || 60));
    await new Promise(res => setTimeout(res, wait * 1000));
  }
}
main().catch(e => { log("fatal: " + (e && e.stack || e)); process.exit(1); });
