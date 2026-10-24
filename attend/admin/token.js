// Local rotating-token generator (WebCrypto HMAC-SHA256). Works in browser and node >= 19.
// token(window) = HMAC(session_key, session_id + ":" + window).hex.slice(0, TOKEN_LEN), window = floor(unix_sec / WINDOW_SEC)
(function (g) {
  var subtle = (g.crypto && g.crypto.subtle) || (typeof require !== "undefined" ? require("crypto").webcrypto.subtle : null);
  var enc = new TextEncoder();
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  async function hmacHex(key, msg) {
    var k = await subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return hex(await subtle.sign("HMAC", k, enc.encode(msg)));
  }
  var LEN = (g.ATT_CONFIG && g.ATT_CONFIG.TOKEN_LEN) || 16, WIN = (g.ATT_CONFIG && g.ATT_CONFIG.WINDOW_SEC) || 10;
  function windowOf(ms) { return Math.floor(ms / 1000 / WIN); }
  async function token(sessionKey, sessionId, win) { return (await hmacHex(sessionKey, sessionId + ":" + win)).slice(0, LEN); }
  // Spec section 2 vectors (same as contract/check_contract.js). Returns true/false.
  async function selfTest() {
    var sk = await hmacHex("MASTER1", "key:S-TEST");
    var a = sk === "30720e548ab67b904aaf2c32c6a98b7d7b4dcf1595213b25c93d1b1f5caa0eba";
    var b = (await token(sk, "S-TEST", 170000000)) === "a592d194c472b486";
    return a && b;
  }
  var api = { token: token, windowOf: windowOf, selfTest: selfTest, hmacHex: hmacHex };
  g.ATT_TOKEN = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
