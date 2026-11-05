// npm run selftest : sends ONE message to this phone's own WhatsApp ("Message yourself" chat) and reports what WhatsApp said.
// It checks the WhatsApp side (lib/wa.js) without the server and without touching any parent. Stop the sender first
// (two connections with the same login fight each other); the boot script starts it again by itself.
"use strict";
const fs = require("fs"), path = require("path");

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  const me = String(cfg.phone_number || "").replace(/\D/g, "");
  const log = s => console.log(new Date().toISOString().slice(11, 19) + "  " + s);
  const wa = await require("./lib/wa").connect(cfg, log);
  if (!wa.registered()) { log("not linked: run npm run pair"); process.exit(2); }
  for (let i = 0; i < 30 && wa.state() !== "connected"; i++) await new Promise(r => setTimeout(r, 2000));
  if (wa.state() !== "connected") { log("WhatsApp did not connect (state " + wa.state() + ")"); process.exit(1); }
  log("own number on WhatsApp: " + await wa.exists(me));
  await wa.typing(me, 2000);
  const id = await wa.send(me, "✅ wa-sender self-test " + new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC: the spare phone can send. (Only you get this.)");
  log("sent, WhatsApp message id " + id);
  await new Promise(r => setTimeout(r, 5000));
  wa.stop();
  process.exit(0);
}
main().catch(e => { console.error("FAILED: " + (e && e.stack || e)); process.exit(1); });
