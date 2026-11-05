// The only file that touches WhatsApp: a thin adapter over Baileys (pinned in package.json).
// It links as a companion device of the WhatsApp account on THIS phone (pairing code, not a QR: the phone cannot scan its own
// screen), keeps the login in ./auth, reconnects by itself, and exposes four calls to loop.js:
//   state() -> "connecting" | "connected" | "logged_out" | "closed"     exists(to) -> bool     typing(to, ms)     send(to, text) -> id
"use strict";
const path = require("path");

function jidOf(digits) { return String(digits).replace(/\D/g, "") + "@s.whatsapp.net"; }

async function connect(cfg, log) {
  const B = require("@whiskeysockets/baileys");
  const makeWASocket = B.default || B.makeWASocket;
  const pino = require("pino");
  const authDir = path.resolve(__dirname, "..", cfg.auth_dir || "auth");
  const { state: auth, saveCreds } = await B.useMultiFileAuthState(authDir);
  let version;
  try { version = (await B.fetchLatestBaileysVersion()).version; } catch (e) { /* the built-in version is used */ }
  let sock = null, state = "connecting", stopped = false, retry = 0;

  function open() {
    sock = makeWASocket(Object.assign({
      auth, logger: pino({ level: "warn" }), printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false,
      browser: B.Browsers ? B.Browsers.ubuntu("Chrome") : ["Ubuntu", "Chrome", "22.04"],
    }, version ? { version } : {}));
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", u => {
      if (u.connection === "open") { state = "connected"; retry = 0; log("WhatsApp connected"); }
      if (u.connection === "close") {
        const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
        if (code === B.DisconnectReason.loggedOut) { state = "logged_out"; log("WhatsApp LOGGED OUT: run `npm run pair` again"); return; }
        state = "connecting";
        if (stopped) return;
        const wait = Math.min(300000, 5000 * Math.pow(2, retry++));
        log("WhatsApp closed (" + (code || "?") + "), reconnecting in " + Math.round(wait / 1000) + " s");
        setTimeout(open, wait);
      }
    });
  }
  open();

  return {
    sock: () => sock,
    registered: () => !!(auth.creds && auth.creds.registered),
    state: () => state,
    async exists(to) { const r = await sock.onWhatsApp(jidOf(to)); return !!(r && r[0] && r[0].exists); },
    async typing(to, ms) {
      try { await sock.presenceSubscribe(jidOf(to)); await sock.sendPresenceUpdate("composing", jidOf(to)); } catch (e) { /* cosmetic */ }
      await new Promise(r => setTimeout(r, ms));
      try { await sock.sendPresenceUpdate("paused", jidOf(to)); } catch (e) { /* cosmetic */ }
    },
    async send(to, text) { const m = await sock.sendMessage(jidOf(to), { text }); return m && m.key ? m.key.id : ""; },
    async pairingCode(phoneDigits) { return sock.requestPairingCode(String(phoneDigits).replace(/\D/g, "")); },
    stop() { stopped = true; try { sock.end(); } catch (e) {} },
  };
}
module.exports = { connect, jidOf };
