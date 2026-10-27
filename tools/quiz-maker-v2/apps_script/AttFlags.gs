/* AttFlags.gs — attendance flag rules (MASTER-SPEC §5). PURE: no sheet writes, no network, no globals except constants below.
 * Entry point: att_runFlags_(ctx) -> string[]
 *   ctx = { session, student_id, device_id, fp, geo, serverUtc, hall:{lat,lng}|null, priorCheckins:[…] }
 *   geo = {lat,lng,acc} | {denied:true};  priorCheckins rows look like Attendance.gs att_attend_ builds them
 *   (all rows of this session + all earlier rows of this student, flags already split into an array).
 * Flags: GEO_FAR · GEO_WEAK (soft) · GEO_DENIED · SAME_PHONE_MULTI_ID · IDENTICAL_COORDS · REPEATED.
 * Status "review" is decided by the caller: any flag except GEO_WEAK.
 */
var ATT_FLAG_C = {
  GEO_RADIUS_M: 100, GEO_WEAK_ACC_M: 150,
  SAME_PHONE_M: 10, SAME_PHONE_SEC: 60,
  IDENTICAL_MIN_IDS: 3, REPEATED_MIN: 3,
};

function att_flagDist_(lat1, lng1, lat2, lng2) {
  var R = 6371000, rad = Math.PI / 180, dLa = (lat2 - lat1) * rad, dLo = (lng2 - lng1) * rad;
  var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function att_flagHasCoords_(r) {
  return r && r.lat != null && r.lng != null && isFinite(Number(r.lat)) && isFinite(Number(r.lng));
}
function att_flagKey_(lat, lng, acc) {
  return Number(lat).toFixed(6) + "|" + Number(lng).toFixed(6) + "|" + Number(acc == null ? 0 : acc).toFixed(6);
}

function att_runFlags_(ctx) {
  var C = ATT_FLAG_C, flags = [], geo = ctx.geo || { denied: true }, sid = String(ctx.student_id);
  var sessionId = ctx.session && ctx.session.session_id;
  var priors = ctx.priorCheckins || [];
  var nowMs = Date.parse(ctx.serverUtc);

  // --- location ---
  var hasGeo = !geo.denied && att_flagHasCoords_(geo);
  if (!hasGeo) flags.push("GEO_DENIED");
  else {
    var acc = Number(geo.acc) || 0;
    if (ctx.hall && att_flagHasCoords_(ctx.hall)) {
      var d = att_flagDist_(Number(geo.lat), Number(geo.lng), Number(ctx.hall.lat), Number(ctx.hall.lng));
      if (d - acc > C.GEO_RADIUS_M) flags.push("GEO_FAR");
    }
    if (acc > C.GEO_WEAK_ACC_M) flags.push("GEO_WEAK");
  }

  // --- same phone, two IDs: same fingerprint, <=10 m apart, <=60 s apart (this session's other students) ---
  if (hasGeo && ctx.fp) {
    var multi = priors.some(function (p) {
      if (p.session_id !== sessionId || String(p.student_id) === sid || !p.fp_hash || p.fp_hash !== ctx.fp || !att_flagHasCoords_(p)) return false;
      var dt = Math.abs(nowMs - Date.parse(p.server_utc));
      if (!isFinite(dt) || dt > C.SAME_PHONE_SEC * 1000) return false;
      return att_flagDist_(Number(geo.lat), Number(geo.lng), Number(p.lat), Number(p.lng)) <= C.SAME_PHONE_M;
    });
    if (multi) flags.push("SAME_PHONE_MULTI_ID");
  }

  // --- identical coordinates (lat/lng/acc to 6 decimals) shared by >=3 different IDs in this session (this one included) ---
  if (hasGeo) {
    var mine = att_flagKey_(geo.lat, geo.lng, geo.acc), ids = {};
    ids[sid] = 1;
    priors.forEach(function (p) {
      if (p.session_id === sessionId && att_flagHasCoords_(p) && att_flagKey_(p.lat, p.lng, p.acc) === mine) ids[String(p.student_id)] = 1;
    });
    if (Object.keys(ids).length >= C.IDENTICAL_MIN_IDS) flags.push("IDENTICAL_COORDS");
  }

  // --- repeat offender: >=3 earlier flagged (status review) check-ins by this student, ever ---
  var flaggedBefore = priors.filter(function (p) { return String(p.student_id) === sid && p.status === "review"; }).length;
  if (flaggedBefore >= C.REPEATED_MIN) flags.push("REPEATED");

  return flags;
}
