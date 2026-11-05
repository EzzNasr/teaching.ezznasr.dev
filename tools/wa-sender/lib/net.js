// A small fetch() for the phone that survives dead Google addresses.
// Found on the first setup (2026-11-05): from the home connection some of Google's address ranges (142.250.x) never answer,
// and the system DNS sometimes hands out only those, so plain fetch() fails with a connect timeout for minutes at a time.
// This one asks two public DNS servers as well, and lets Node try every address in turn (autoSelectFamily) until one connects.
// Only the CONNECTION is retried on another address: a request that was already sent is never sent again (W5, never twice).
"use strict";
const https = require("https"), dns = require("dns");

const resolver = new dns.Resolver({ timeout: 4000, tries: 1 });
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

function lookupAll(host, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  let pending = 2, sys = [], pub = [], err = null;
  const done = () => {
    if (--pending) return;
    const seen = new Set(), out = [];
    // public-DNS IPv4 first (that is where the working addresses came from), then the system's answers
    pub.map(a => ({ address: a, family: 4 })).concat(sys).forEach(a => { if (!seen.has(a.address)) { seen.add(a.address); out.push(a); } });
    if (!out.length) return cb(err || new Error("no address for " + host));
    if (opts && opts.all) cb(null, out); else cb(null, out[0].address, out[0].family);
  };
  dns.lookup(host, { all: true }, (e, a) => { if (e) err = e; else sys = a || []; done(); });
  resolver.resolve4(host, (e, a) => { if (e) err = err || e; else pub = a || []; done(); });
}

function once(url, opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: opts.method || "GET", headers: opts.headers || {}, lookup: lookupAll,
      autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 2500, timeout: 60000,
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (opts.signal) opts.signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** fetch-like: (url, {method, headers, body, signal}) -> {status, text()}. Follows redirects the way fetch does (303/302 after POST -> GET). */
async function phoneFetch(url, opts) {
  opts = opts || {};
  let r = await once(url, opts);
  for (let hops = 0; r.status >= 300 && r.status < 400 && r.location && hops < 5; hops++) {
    url = new URL(r.location, url).toString();
    r = await once(url, { method: "GET", signal: opts.signal });
  }
  return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => r.body };
}

module.exports = { phoneFetch, lookupAll };
