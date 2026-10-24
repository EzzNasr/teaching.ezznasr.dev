// FROZEN. Shared constants (must equal MASTER-SPEC section 1).
(function (g) {
  g.ATT_CONFIG = Object.freeze({
    API_URL: "https://script.google.com/macros/s/AKfycbzpyJWSI9aRseig5JBmydzo34ogfNYv9qQH1HrzIUGcgETF1rk4pE8qO8j7Hp3FrVjCvw/exec",
    WINDOW_SEC: 10, GRACE_SEC: 3, TICKET_SEC: 90, SESSION_MIN: 5,
    GEO_RADIUS_M: 100, GEO_WEAK_ACC_M: 150,
    ID_REGEX: /^[0-9]{4,12}$/, TZ: "Africa/Cairo", TOKEN_LEN: 16,
  });
  if (typeof module !== "undefined") module.exports = g.ATT_CONFIG;
})(typeof window !== "undefined" ? window : globalThis);
