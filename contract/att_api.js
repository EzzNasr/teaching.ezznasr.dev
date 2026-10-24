// FROZEN. call(action, payload) -> parsed JSON; 3 tries with 300-900 ms jitter on network errors only.
(function (g) {
  async function call(action, payload) {
    const body = JSON.stringify(Object.assign({ action }, payload || {}));
    let last;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await (g.ATT_FETCH || g.fetch)(g.ATT_CONFIG.API_URL, { method: "POST", body, redirect: "follow" });
        return await r.json();
      } catch (e) {
        last = e;
        await new Promise(res => setTimeout(res, 300 + Math.random() * 600));
      }
    }
    return { ok: false, error: "Network error", code: "NETWORK", detail: String(last) };
  }
  g.attApi = { call };
  if (typeof module !== "undefined") module.exports = g.attApi;
})(typeof window !== "undefined" ? window : globalThis);
