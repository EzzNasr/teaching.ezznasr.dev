// npm run pair : links this script to the WhatsApp account on THIS phone, once.
// It prints an 8-character code. Then, on the same phone: WhatsApp > Settings (⋮) > Linked devices > Link a device >
// "Link with phone number instead" > type the code. When it says "linked", press Ctrl+C and start the sender (npm start).
"use strict";
const fs = require("fs"), path = require("path");

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  const phone = String(cfg.phone_number || "").replace(/\D/g, "");
  if (!/^[1-9]\d{10,14}$/.test(phone)) { console.error("config.json: phone_number must be this phone's WhatsApp number with the country code, e.g. 2010xxxxxxxx"); process.exit(2); }
  const wa = await require("./lib/wa").connect(cfg, s => console.log(s));
  if (wa.registered()) { console.log("Already linked. To link again, delete the auth folder first."); }
  else {
    await new Promise(r => setTimeout(r, 3000));   // let the socket open before asking for a code
    const code = await wa.pairingCode(phone);
    console.log("\n   Pairing code:  " + String(code).replace(/(.{4})(.{4})/, "$1-$2") + "\n");
    console.log("WhatsApp > ⋮ > Linked devices > Link a device > Link with phone number instead > type the code.");
  }
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (wa.state() === "connected") { console.log("\nLinked and connected. Press Ctrl+C, then: npm start"); clearInterval(iv); }
    else if (Date.now() - t0 > 180000) { console.log("No link after 3 minutes. Run npm run pair again."); clearInterval(iv); wa.stop(); process.exit(1); }
  }, 2000);
}
main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
