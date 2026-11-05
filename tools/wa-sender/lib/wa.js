// The only file that touches WhatsApp: a thin adapter over Baileys (pinned in package.json).
// It links as a companion device of the WhatsApp account on THIS phone (pairing code, not a QR: the phone cannot scan its own
// screen), keeps the login in ./auth, reconnects by itself, and exposes four calls to loop.js:
//   state() -> "connecting" | "connected" | "logged_out" | "closed"     exists(to) -> bool     typing(to, ms)     send(to, text) -> id
// 2026-11-05: Baileys 7 (ESM, so it is loaded with import()). 6.7.x could not address WhatsApp's newer "LID" chats, and every
// message showed "Waiting for this message" on the receiving phones. Also new: getMessage answers a phone's "please resend"
// (retry receipt) from a small store of what we sent, so a message that failed to decrypt the first time can still arrive.
"use strict";
const path = require("path"), fs = require("fs");

function jidOf(digits) { return String(digits).replace(/\D/g, "") + "@s.whatsapp.net"; }

async function connect(cfg, log) {
  const B = await import("@whiskeysockets/baileys");
  const makeWASocket = B.makeWASocket || (B.default && (B.default.makeWASocket || B.default));
  const pino = require("pino"), logger = pino({ level: "warn" });
  const authDir = path.resolve(__dirname, "..", cfg.auth_dir || "auth");
  const { state: auth, saveCreds } = await B.useMultiFileAuthState(authDir);
  const sent = sentStore(path.resolve(__dirname, "..", "data", "sent-messages.json"));
  let version;
  try { version = (await B.fetchLatestBaileysVersion()).version; } catch (e) { /* the built-in version is used */ }
  let sock = null, state = "connecting", stopped = false, retry = 0;

  function open() {
    sock = makeWASocket(Object.assign({
      auth: { creds: auth.creds, keys: B.makeCacheableSignalKeyStore ? B.makeCacheableSignalKeyStore(auth.keys, logger) : auth.keys },
      logger, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false,
      getMessage: async key => sent.get(key && key.id),   // undefined when unknown: an empty message would burn the retry
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
    async send(to, text) {
      const m = await sock.sendMessage(jidOf(to), { text });
      if (m && m.key && m.key.id) sent.put(m.key.id, m.message || { conversation: text });
      return m && m.key ? m.key.id : "";
    },
    async pairingCode(phoneDigits) { return sock.requestPairingCode(String(phoneDigits).replace(/\D/g, "")); },
    stop() { stopped = true; try { sock.end(); } catch (e) {} },
  };
}
// The last 300 messages we sent, kept on disk (data/sent-messages.json) so a resend request after a restart can be answered.
function sentStore(file) {
  let m = {};
  try { m = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { /* first run */ }
  return {
    get: id => (id && m[id] ? m[id].msg : undefined),
    put(id, msg) {
      m[id] = { at: Date.now(), msg };
      const ids = Object.keys(m).sort((a, b) => m[b].at - m[a].at);
      ids.slice(300).forEach(x => delete m[x]);
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(m)); } catch (e) { /* not fatal */ }
    },
  };
}
module.exports = { connect, jidOf, sentStore };
