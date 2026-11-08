// BKK Departures - transform for the default JS runtime.
//
// Input is either one FUTÁR reply, or several when the polling URL has one line
// per stop ({ IDX_0: reply, IDX_1: reply, ... }). Each reply can be:
//   for-location:  data.list  = departure groups { routeId, headsign, stopTimes }
//   for-stop:      data.entry = { stopId, stopTimes }   (stopTimes lack stopId)
// Output: one group per line + destination + stop, with its next departures.
// Line/direction filtering and "minutes until" happen in Liquid at render time.

function transform(input) {
  // --- Budapest local time (CET/CEST, EU rule: last Sunday of March/October, 01:00 UTC)
  function lastSundayUTC(year, month) {
    var d = new Date(Date.UTC(year, month + 1, 0, 1, 0, 0));
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.getTime();
  }
  function budapestOffset(ms) {
    var y = new Date(ms).getUTCFullYear();
    return (ms >= lastSundayUTC(y, 2) && ms < lastSundayUTC(y, 9)) ? 7200000 : 3600000;
  }
  function hhmm(sec) {
    var ms = sec * 1000, d = new Date(ms + budapestOffset(ms));
    var h = d.getUTCHours(), m = d.getUTCMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  function plain(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  // Error code for the template (which shows it in the chosen language) plus English text.
  function errorInfo(r) {
    if (typeof r === 'string') r = { text: r };   // BKK can answer errors as plain text
    var text = String((r && (r.text || r.status || r.error)) || '');
    var parse = /Failed to parse: (\w+)/i.exec(text);
    // LIMIT_EXCEEDED: the request covers too much (for example a very large radius), not a used-up quota.
    if (r && (r.status === 'LIMIT_EXCEEDED' || /limit exceeded/i.test(text))) return { code: 'limit', field: '' };
    if (r && (r.code === 401 || r.code === 403 || /api key/i.test(text))) return { code: 'key', field: '' };
    if (r && (r.code === 404 || r.status === 'NOT_FOUND')) return { code: 'stop', field: '' };
    if (parse) return { code: 'field', field: parse[1] };
    if (!text) return { code: 'none', field: '' };
    return { code: 'other', field: text };
  }
  // A reply that is not from BKK (TRMNL's example data on unused polling lines).
  function isFiller(r) {
    // Every BKK reply, success or error, carries currentTime and version.
    return r && typeof r === 'object' && r.currentTime === undefined && r.version === undefined;
  }

  var TYPES = {
    BUS: ['Bus', 'Busz'], TRAM: ['Tram', 'Villamos'], TROLLEYBUS: ['Trolleybus', 'Troli'],
    SUBWAY: ['Metro', 'Metró'], RAIL: ['Train', 'Vonat'], SUBURBAN_RAILWAY: ['HÉV', 'HÉV'],
    FERRY: ['Boat', 'Hajó'], COACH: ['Coach', 'Busz'], CABLE_CAR: ['Cog railway', 'Fogaskerekű'],
    FUNICULAR: ['Funicular', 'Sikló'], GONDOLA: ['Chairlift', 'Libegő']
  };

  // --- Collect the replies (one, or IDX_0..IDX_n in polling-URL order)
  var replies = [];
  if (input && typeof input === 'object' && input.IDX_0 !== undefined) {
    Object.keys(input).filter(function (k) { return /^IDX_\d+$/.test(k); })
      .sort(function (a, b) { return parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10); })
      .forEach(function (k) { replies.push(input[k]); });
  } else {
    replies.push(input);
  }

  var merged = {};          // key -> group
  var order = [];
  var nowSec = 0, okCount = 0, firstError = null, anyStopsKnown = false;
  var badStops = [];

  replies.forEach(function (r, idx) {
    if (isFiller(r)) return;
    var data = r && r.data;
    var ok = r && typeof r === 'object' && (r.code === 200 || r.status === 'OK') && data;
    if (!ok) {
      if (!firstError) firstError = errorInfo(r);
      if (r && r.code === 404) badStops.push(idx + 1);
      return;
    }
    okCount++;
    nowSec = Math.max(nowSec, Math.floor((r.currentTime || Date.now()) / 1000));
    var refs = data.references || {};
    var routes = refs.routes || {}, stops = refs.stops || {}, alerts = refs.alerts || {}, trips = refs.trips || {};
    if (Object.keys(stops).length) anyStopsKnown = true;

    // Normalise both reply shapes into departure groups.
    var groupsIn = [], loose = [];
    if (data.entry && Array.isArray(data.entry.stopTimes)) {
      data.entry.stopTimes.forEach(function (st) {
        if (!st.stopId) st.stopId = data.entry.stopId;
        loose.push(st);
      });
    }
    (Array.isArray(data.list) ? data.list : []).forEach(function (item) {
      if (item && item.routeId && Array.isArray(item.stopTimes)) groupsIn.push(item);
      else if (item && Array.isArray(item.stopTimes)) {
        item.stopTimes.forEach(function (st) { if (!st.stopId) st.stopId = item.stopId; loose.push(st); });
      }
    });
    var byKey = {};
    loose.forEach(function (st) {
      var trip = trips[st.tripId] || {};
      var routeId = trip.routeId || st.routeId || '';
      var head = st.stopHeadsign || trip.tripHeadsign || '';
      var k = routeId + '|' + head;
      if (!byKey[k]) { byKey[k] = { routeId: routeId, headsign: head, stopTimes: [] }; groupsIn.push(byKey[k]); }
      byKey[k].stopTimes.push(st);
    });

    function alertText(id, lang) {
      var a = id && alerts[id];
      if (!a || !a.header) return '';
      var t = a.header.translations || {};
      return String(t[lang] || t.hu || t.en || a.header.someTranslation || '');
    }

    groupsIn.forEach(function (g) {
      var route = routes[g.routeId] || {};
      var line = String(route.shortName || route.iconDisplayText || '?');
      var type = String(route.type || 'BUS');
      var labels = TYPES[type] || [type, type];
      if (type === 'RAIL' && /^H\d/i.test(line)) labels = ['HÉV', 'HÉV'];   // BKK marks HÉV lines as RAIL
      var headsign = String(g.headsign || '').replace(/►|▶|→/g, '›').replace(/\s{2,}/g, ' ');
      var stopId = null, alertId = null;

      (g.stopTimes || []).forEach(function (st) {
        var sched = st.departureTime || st.arrivalTime;
        var pred = st.predictedDepartureTime || st.predictedArrivalTime;
        var ts = pred || sched;
        if (!ts) return;
        stopId = stopId || st.stopId;
        if (!alertId && st.alertIds && st.alertIds.length) alertId = st.alertIds[0];
        var stopName = String((stops[st.stopId || stopId] || {}).name || '');
        var key = line + '|' + headsign + '|' + stopName;
        var grp = merged[key];
        if (!grp) {
          // "4-6" style combined lines should match a search for 4 or 6.
          var parts = line.toUpperCase().split(/[-\/ ]+/).filter(Boolean);
          grp = merged[key] = {
            line: line,
            line_uc: line.toUpperCase(),
            line_keys: '|' + [line.toUpperCase()].concat(parts).join('|') + '|',
            type: type, type_en: labels[0], type_hu: labels[1],
            headsign: headsign,
            headsign_lc: headsign.toLowerCase(),
            headsign_plain: plain(headsign),
            stop: stopName,
            alert: false, alert_en: '', alert_hu: '',
            seen: {}, deps: []
          };
          order.push(key);
        }
        if (alertId && !grp.alert) {
          grp.alert = true; grp.alert_en = alertText(alertId, 'en'); grp.alert_hu = alertText(alertId, 'hu');
        }
        var trip = st.tripId || (String(ts) + key);
        if (grp.seen[trip]) return;              // same trip from a repeated polling line
        grp.seen[trip] = true;
        grp.deps.push({
          ts: ts,
          time: hhmm(ts),
          sched_time: hhmm(sched || ts),
          delay: (pred && sched) ? Math.round((pred - sched) / 60) : 0,
          realtime: !!pred && st.predictionScheduled !== true,
          uncertain: !!st.uncertain,
          canceled: st.canceled === true,
          accessible: !!st.wheelchairAccessible
        });
      });
    });
  });

  if (!okCount) {
    var e = firstError || { code: 'none', field: '' };
    return { error: true, error_code: e.code, error_field: e.field };
  }

  var groups = order.map(function (k) {
    var g = merged[k];
    g.deps = g.deps.filter(function (d) { return d.ts >= nowSec - 60; })
      .sort(function (a, b) { return a.ts - b.ts; }).slice(0, 8);
    delete g.seen;
    g.first_ts = g.deps.length ? g.deps[0].ts : 0;
    return g;
  }).filter(function (g) { return g.deps.length; });
  groups.sort(function (a, b) { return a.first_ts - b.first_ts; });

  return {
    as_of: hhmm(nowSec),
    fetched_ts: nowSec,
    no_stops: groups.length === 0 && !anyStopsKnown,
    bad_stops: badStops.join(', '),
    groups: groups
  };
}
