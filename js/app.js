/* SafeRoute Pune — app wiring: map, search, routing, layers, navigation and insights. */
(function () {
  "use strict";
  const SR = window.SR;
  const $ = (id) => document.getElementById(id);
  const { hav } = SR.geo;
  const BASE = (document.querySelector('meta[name="sr-base"]') || {}).content || "";
  const PUNE = [18.5204, 73.8567];

  const state = { graph: null, from: null, to: null, mode: "fast", route: null, alt: null, nav: null, places: [], roads: [], accidents: [] };
  SR.riskColor = (p) => (p < 0.28 ? "#0f9d58" : p < 0.36 ? "#e8890c" : p < 0.5 ? "#e0561f" : "#d93025");
  let toastTimer;
  SR.toast = (msg, ms = 3500) => {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
  };

  // ---------------------------------------------------------------- map
  const map = L.map("map", { zoomControl: false, preferCanvas: true, minZoom: 10, maxBounds: [[18.2, 73.4], [18.95, 74.3]] }).setView(PUNE, 12);
  L.control.zoom({ position: "topright" }).addTo(map);
  const tiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd", maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  // if the tile server is unreachable, draw our own basemap from the road graph
  let tileErrors = 0, tileOk = 0, fallback = null;
  tiles.on("tileload", () => tileOk++);
  tiles.on("tileerror", () => { if (++tileErrors >= 6 && tileOk === 0 && state.graph && !fallback) drawFallbackBase(); });
  setTimeout(() => { if (tileOk === 0 && state.graph && !fallback) drawFallbackBase(); }, 6000);
  const renderer = L.canvas({ padding: 0.3 });
  const hotLayer = L.layerGroup().addTo(map);
  const crashLayer = L.layerGroup();
  const routeLayer = L.layerGroup().addTo(map);
  let fromMk = null, toMk = null;

  function drawFallbackBase() {
    const g = state.graph;
    map.getContainer().style.background = "#f2efe9";
    fallback = L.layerGroup();
    const W = { 0: 5, 1: 5, 2: 4, 3: 3.5, 4: 2.6, 5: 2, 6: 1.4, 7: 1 };
    const C = { 0: "#f6b26b", 1: "#f9cb7a", 2: "#fde7a6", 3: "#ffffff", 4: "#ffffff", 5: "#ffffff", 6: "#ffffff", 7: "#ffffff" };
    const lines = {};
    for (let i = 0; i < g.nE; i++) {
      const c = g.ecls[i];
      (lines[c] = lines[c] || []).push(g.edgePoints(i, 1));
    }
    for (const c of [7, 6, 5, 4, 3, 2, 1, 0]) {
      if (!lines[c]) continue;
      L.polyline(lines[c], { renderer, color: "#c9c4ba", weight: W[c] + 1.6, interactive: false }).addTo(fallback);
      L.polyline(lines[c], { renderer, color: C[c], weight: W[c], interactive: false }).addTo(fallback);
    }
    fallback.addTo(map);
    fallback.eachLayer((l) => l.bringToBack && l.bringToBack());
    tiles.remove();
    map.attributionControl.addAttribution("Basemap drawn from OpenStreetMap road data");
  }

  // ---------------------------------------------------------------- loading
  function progress(p, text) { $("loadBar").style.width = Math.round(p * 100) + "%"; if (text) $("loadText").textContent = text; }
  async function fetchJSON(url, onProg) {
    const res = await fetch(BASE + url);
    if (!res.ok) throw new Error(url + " " + res.status);
    if (!onProg || !res.body || !res.headers.get("content-length")) return res.json();
    const total = +res.headers.get("content-length");
    const reader = res.body.getReader();
    const chunks = []; let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onProg(Math.min(1, got / total)); }
    return JSON.parse(new TextDecoder().decode(await new Blob(chunks).arrayBuffer()));
  }
  function parseCSV(text) {
    const out = []; let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n") { row.push(f); out.push(row); row = []; f = ""; }
      else if (c !== "\r") f += c;
    }
    if (f || row.length) { row.push(f); out.push(row); }
    const head = out.shift();
    return out.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }
  const tband = (h) => (h >= 6 && h < 10 ? "Morning (6-10)" : h >= 10 && h < 16 ? "Midday (10-16)" : h >= 16 && h < 21 ? "Evening (16-21)" : "Night (21-6)");
  const season = (m) => ([6, 7, 8, 9].includes(m) ? "Monsoon" : [10, 11, 12, 1, 2].includes(m) ? "Winter" : "Summer");

  async function load() {
    try {
      progress(0.05, "Loading Pune road map…");
      const [G, insights, places, csv] = await Promise.all([
        fetchJSON("data/graph.json", (p) => progress(0.05 + p * 0.75)),
        fetchJSON("data/insights.json"),
        fetchJSON("data/places.json"),
        fetch(BASE + "data/accidents.csv").then((r) => r.text()),
      ]);
      progress(0.85, "Building road network…");
      await new Promise((r) => setTimeout(r, 20));
      state.graph = new SR.Graph(G);
      SR.Risk.init(insights, state.graph);
      state.insights = insights;
      state.places = places.map(([name, lat, lon, kind]) => ({ name, lat, lon, kind: kind.replace(/_/g, " ") }));
      state.roads = roadIndex(state.graph);
      state.accidents = parseCSV(csv).map((r) => ({ ...r, hour: +r.hour, month: +r.month, year: +r.year, time_band: tband(+r.hour), season: season(+r.month) }));
      drawHotspots();
      SR.Insights.init(insights, state.accidents, showHotspot);
      $("loading").hidden = true;
      if (tileOk === 0 && tileErrors > 0) drawFallbackBase();
      readHash();
    } catch (e) {
      console.error(e);
      $("loadText").textContent = "Could not load map data. Check your connection and reload.";
    }
  }

  function roadIndex(g) {
    // one search entry per named road (point at the middle of its longest piece)
    const best = new Map();
    for (let i = 0; i < g.nE; i++) {
      const n = g.names[g.ename[i]];
      if (!n || g.ecls[i] > 5) continue;
      const b = best.get(n);
      if (!b || g.elen[i] > b.len) best.set(n, { len: g.elen[i], e: i });
    }
    return [...best].map(([name, { e }]) => {
      const p = g.edgePoints(e, 1); const m = p[Math.floor(p.length / 2)];
      return { name, lat: m[0], lon: m[1], kind: "road" };
    });
  }

  // ---------------------------------------------------------------- hotspots / crash layers
  const TIER_COLOR = { High: "#d93025", Medium: "#e8890c", Low: "#d4a106" };
  function hotPopup(h) {
    return `<div class="pop"><span class="tier t-${h.tier}">${h.tier} risk · #${h.rank}</span><h4>${h.name}</h4>
      <div><b>${h.accidents}</b> crashes · <b>${h.fatal}</b> fatal · <b>${h.killed}</b> deaths (2019–23)</div>
      <div class="row">Worst: ${h.peak_time.replace(/ \(.*\)/, "").toLowerCase()} · ${h.top_cause.toLowerCase()} · mostly ${h.top_vehicle.toLowerCase()}s</div>
      <div class="row">Speed limit cut here: −${h.limit_cut} km/h (more at night / in rain)</div></div>`;
  }
  function drawHotspots() {
    hotLayer.clearLayers();
    for (const h of SR.Risk.hotspots) {
      const c = TIER_COLOR[h.tier];
      L.circle([h.lat, h.lon], { radius: h.radius_m, color: c, weight: 2, fillColor: c, fillOpacity: 0.18, renderer }).bindPopup(hotPopup(h)).addTo(hotLayer);
      if (h.tier === "High") L.marker([h.lat, h.lon], { interactive: false, icon: L.divIcon({ className: "", html: `<div class="hs-label">⚠ ${h.name.replace(/ \(.*\)/, "").split(",")[0]}</div>`, iconAnchor: [-8, 10] }) }).addTo(hotLayer);
    }
    const SC = { Fatal: "#b3261e", Grievous: "#e8890c", Minor: "#7b8f86" };
    for (const r of state.accidents) {
      L.circleMarker([+r.lat, +r.lon], { radius: r.severity === "Fatal" ? 3.2 : 2.4, stroke: false, fillColor: SC[r.severity], fillOpacity: 0.65, renderer, interactive: false }).addTo(crashLayer);
    }
  }
  $("layHot").onchange = (e) => (e.target.checked ? hotLayer.addTo(map) : hotLayer.remove());
  $("layCrash").onchange = (e) => (e.target.checked ? crashLayer.addTo(map) : crashLayer.remove());
  function showHotspot(h) {
    closeInsights();
    $("layHot").checked = true; hotLayer.addTo(map);
    map.setView([h.lat, h.lon], 16);
    L.popup().setLatLng([h.lat, h.lon]).setContent(hotPopup(h)).openOn(map);
  }

  // ---------------------------------------------------------------- search
  let active = null, sugg = [], sel = -1, timer = null, photonCtl = null;
  function norm(s) { return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); }
  function localSearch(q) {
    const n = norm(q);
    if (n.length < 2) return [];
    const words = n.split(" ");
    const score = (x) => {
      const t = norm(x.name);
      if (!words.every((w) => t.includes(w))) return -1;
      return (t.startsWith(n) ? 30 : 0) + (t === n ? 50 : 0) + ({ suburb: 12, neighbourhood: 10, locality: 10, station: 14, college: 8, university: 8, mall: 8, airport: 40, "bus station": 6, road: 5 }[x.kind] || 0) - t.length / 20;
    };
    return [...state.places, ...state.roads].map((x) => [score(x), x]).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).slice(0, 7).map(([, x]) => x);
  }
  async function photon(q) {
    // online fallback for addresses not in the offline index
    try {
      photonCtl && photonCtl.abort();
      photonCtl = new AbortController();
      const u = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lat=18.52&lon=73.86&bbox=73.72,18.42,74.02,18.70`;
      const r = await fetch(u, { signal: photonCtl.signal });
      const j = await r.json();
      return j.features.map((f) => ({ name: [f.properties.name, f.properties.street, f.properties.district || f.properties.city].filter(Boolean).join(", "), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], kind: f.properties.osm_value || "place" }))
        .filter((x) => x.name && state.graph.inBounds(x.lat, x.lon));
    } catch (e) { return []; }
  }
  function renderSuggest() {
    const ul = $("suggest");
    ul.replaceChildren(...sugg.map((x, i) => {
      const li = document.createElement("li");
      li.className = i === sel ? "on" : "";
      const s = document.createElement("span"); s.textContent = x.name;
      const k = document.createElement("small"); k.textContent = x.kind;
      li.append(s, k);
      li.onmousedown = (e) => { e.preventDefault(); choose(x); };
      return li;
    }));
    ul.hidden = !sugg.length;
  }
  function onInput(e) {
    active = e.target.id === "fromInput" ? "from" : "to";
    const q = e.target.value;
    sugg = state.graph ? localSearch(q) : []; sel = -1; renderSuggest();
    clearTimeout(timer);
    if (q.trim().length >= 3 && state.graph) timer = setTimeout(async () => {
      const more = await photon(q);
      if ((active === "from" ? $("fromInput") : $("toInput")).value !== q) return;
      const seen = new Set(sugg.map((x) => norm(x.name)));
      sugg = sugg.concat(more.filter((x) => !seen.has(norm(x.name)))).slice(0, 9);
      renderSuggest();
    }, 350);
  }
  for (const id of ["fromInput", "toInput"]) {
    const inp = $(id);
    inp.addEventListener("input", onInput);
    inp.addEventListener("focus", (e) => { active = id === "fromInput" ? "from" : "to"; if (e.target.value) onInput(e); });
    inp.addEventListener("blur", () => setTimeout(() => ($("suggest").hidden = true), 120));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { sel = Math.min(sugg.length - 1, sel + 1); renderSuggest(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); renderSuggest(); e.preventDefault(); }
      else if (e.key === "Enter" && sugg.length) { choose(sugg[Math.max(0, sel)]); e.preventDefault(); }
    });
  }
  function choose(x) {
    setPoint(active, [x.lat, x.lon], x.name);
    $("suggest").hidden = true;
    (active === "from" ? $("fromInput") : $("toInput")).blur();
  }
  function nearestName(la, lo) {
    let best = null, bd = Infinity;
    for (const p of state.places) { const d = hav(la, lo, p.lat, p.lon); if (d < bd) { bd = d; best = p; } }
    return best && bd < 1500 ? `Near ${best.name}` : `${la.toFixed(5)}, ${lo.toFixed(5)}`;
  }
  function setPoint(which, ll, name) {
    if (!state.graph) return;
    if (!state.graph.inBounds(ll[0], ll[1])) { SR.toast("That point is outside the Pune area covered by SafeRoute."); return; }
    state[which] = ll;
    $(which === "from" ? "fromInput" : "toInput").value = name || nearestName(ll[0], ll[1]);
    const icon = L.divIcon({ className: "", html: `<div class="pin ${which}"></div>`, iconSize: [22, 22], iconAnchor: [11, 22] });
    if (which === "from") { fromMk && fromMk.remove(); fromMk = L.marker(ll, { icon, draggable: true }).addTo(map).on("dragend", (e) => setPoint("from", [e.target.getLatLng().lat, e.target.getLatLng().lng])); }
    else { toMk && toMk.remove(); toMk = L.marker(ll, { icon, draggable: true }).addTo(map).on("dragend", (e) => setPoint("to", [e.target.getLatLng().lat, e.target.getLatLng().lng])); }
    if (state.from && state.to) computeRoute(true);
    else map.panTo(ll);
  }
  map.on("click", (e) => {
    if (state.nav) return;
    const ll = [e.latlng.lat, e.latlng.lng];
    if (!state.from) setPoint("from", ll);
    else setPoint("to", ll);
  });
  $("btnSwap").onclick = () => {
    if (!state.from && !state.to) return;
    const f = state.from, t = state.to, fn = $("fromInput").value, tn = $("toInput").value;
    state.from = null; state.to = null;
    fromMk && fromMk.remove(); toMk && toMk.remove(); fromMk = toMk = null;
    if (t) setPoint("from", t, tn);
    if (f) setPoint("to", f, fn);
  };
  $("btnLocate").onclick = () => {
    if (!("geolocation" in navigator)) return SR.toast("Location is not available on this device.");
    SR.toast("Finding your location…");
    navigator.geolocation.getCurrentPosition((p) => {
      const ll = [p.coords.latitude, p.coords.longitude];
      if (!state.graph.inBounds(ll[0], ll[1])) {
        SR.toast("You are outside Pune, so the start is set to Pune Railway Station. Use the bike simulator to try a ride.", 6000);
        setPoint("from", [18.5285, 73.8740], "Pune Railway Station");
      } else setPoint("from", ll, "My location");
    }, () => SR.toast("Could not get your location. Allow location access, or tap the map to set a start."), { enableHighAccuracy: true, timeout: 12000 });
  };

  // ---------------------------------------------------------------- conditions
  document.querySelectorAll("#modeSeg button").forEach((b) => (b.onclick = () => {
    document.querySelectorAll("#modeSeg button").forEach((x) => x.classList.toggle("on", x === b));
    state.mode = b.dataset.mode; if (state.from && state.to) computeRoute(false);
  }));
  $("selTime").onchange = (e) => { SR.Risk.conditions.night = e.target.value === "auto" ? null : e.target.value === "night"; if (state.route) computeRoute(false); };
  $("selWeather").onchange = (e) => { SR.Risk.conditions.weather = e.target.value; $("weatherNote").textContent = ""; if (state.route) computeRoute(false); };
  // live Pune weather (optional): pre-select Rain / Fog when it is raining or foggy now
  fetch("https://api.open-meteo.com/v1/forecast?latitude=18.52&longitude=73.86&current=weather_code,precipitation,is_day&timezone=Asia%2FKolkata")
    .then((r) => r.json()).then((j) => {
      const c = j.current || {}; const code = c.weather_code;
      const w = (code >= 51 && code <= 67) || (code >= 80 && code <= 99) || c.precipitation > 0.1 ? "Rain" : code === 45 || code === 48 ? "Mist/Fog" : "Clear";
      SR.Risk.conditions.weather = w; $("selWeather").value = w;
      $("weatherNote").textContent = `Live Pune weather: ${w === "Mist/Fog" ? "fog" : w.toLowerCase()}${w !== "Clear" ? " — limits are lowered" : ""}.`;
    }).catch(() => {});

  // ---------------------------------------------------------------- routing
  function computeRoute(fit) {
    const g = state.graph;
    const r = g.route(state.from, state.to, state.mode);
    if (r.error) { SR.toast(r.error); return; }
    SR.Risk.analyseRoute(r, g);
    // compare with the other route type
    const other = g.route(state.from, state.to, state.mode === "fast" ? "safe" : "fast");
    if (!other.error) SR.Risk.analyseRoute(other, g);
    state.route = r; state.alt = other.error ? null : other;
    drawRoute(r, fit);
    showResult(r);
    $("intro").hidden = true;
    writeHash();
  }
  function drawRoute(r, fit) {
    routeLayer.clearLayers();
    if (state.alt && state.alt.distance && Math.abs(state.alt.distance - r.distance) > 30) {
      L.polyline(state.alt.pts, { color: "#7c8a84", weight: 5, opacity: 0.45, dashArray: "2 8" }).addTo(routeLayer);
    }
    L.polyline(r.pts, { color: "#0d47a1", weight: 9, opacity: 0.35 }).addTo(routeLayer);
    L.polyline(r.pts, { color: state.mode === "safe" ? "#0f9d58" : "#1f6feb", weight: 6 }).addTo(routeLayer);
    // red overlay where the route crosses a hotspot
    for (const h of r.hotspots) {
      const seg = [];
      for (let i = 0; i < r.pts.length; i++) if (r.cum[i] >= h.from - 1 && r.cum[i] <= h.to + 1) seg.push(r.pts[i]);
      if (seg.length > 1) L.polyline(seg, { color: "#d93025", weight: 7 }).addTo(routeLayer);
    }
    if (fit) map.fitBounds(L.latLngBounds(r.pts), { paddingTopLeft: [window.innerWidth > 760 ? 410 : 20, 40], paddingBottomRight: [40, window.innerWidth > 760 ? 40 : window.innerHeight * 0.5] });
  }
  function riskLevel(p) { return p < 0.28 ? ["Low", "lvl-low"] : p < 0.36 ? ["Moderate", "lvl-mid"] : ["High", "lvl-high"]; }
  function showResult(r) {
    $("result").hidden = false;
    $("rTime").textContent = SR.fmt.time(r.duration);
    $("rDist").textContent = SR.fmt.dist(r.distance);
    $("rSpots").textContent = r.hotspots.length;
    const [lvl, cls] = riskLevel(r.fatalRisk);
    $("riskFill").style.width = Math.min(100, Math.round(r.fatalRisk * 180)) + "%";
    $("riskFill").style.background = SR.riskColor(r.fatalRisk);
    $("riskLabel").textContent = lvl; $("riskLabel").className = cls;
    $("riskBar").title = `If a crash happens on this route now, about ${Math.round(r.fatalRisk * 100)}% chance it is fatal (two-wheeler, current time and weather).`;
    const alt = state.alt, note = $("altNote");
    if (alt && alt.hotspots.length !== r.hotspots.length) {
      const fewer = alt.hotspots.length < r.hotspots.length;
      note.hidden = false;
      note.textContent = state.mode === "fast"
        ? (fewer ? `Safest route avoids ${r.hotspots.length - alt.hotspots.length} hotspot${r.hotspots.length - alt.hotspots.length > 1 ? "s" : ""} for +${Math.max(1, Math.round((alt.duration - r.duration) / 60))} min.` : "")
        : `Avoids ${alt.hotspots.length - r.hotspots.length} hotspot${alt.hotspots.length - r.hotspots.length > 1 ? "s" : ""} compared with the fastest route (+${Math.max(1, Math.round((r.duration - alt.duration) / 60))} min).`;
      if (!note.textContent) note.hidden = true;
    } else note.hidden = true;
    const zl = $("zoneList");
    zl.textContent = "";
    if (!r.hotspots.length) {
      const li = document.createElement("li"); li.className = "none"; li.textContent = "No accident hotspots on this route. Normal speed limits apply.";
      zl.append(li);
    }
    for (const h of r.hotspots) {
      const z = h.zone;
      const segIdx = r.cum.findIndex((c) => c >= h.from);
      const base = r.segLim[Math.min(r.segLim.length - 1, Math.max(0, segIdx))];
      const eff = SR.Risk.effectiveLimit(base, z).limit;
      const li = document.createElement("li");
      li.innerHTML = `<i class="tier" style="background:${TIER_COLOR[z.tier]}"></i><b></b><small></small><div class="drop"><em>${eff}</em>was ${base}</div>`;
      li.querySelector("b").textContent = z.name;
      li.querySelector("small").textContent = `${(h.from / 1000).toFixed(1)} km in · ${z.accidents} crashes, ${z.killed} deaths · ${z.tier} risk`;
      li.onclick = () => showHotspot(z);
      zl.append(li);
    }
    const ol = $("stepList");
    ol.replaceChildren(...r.steps.map((s) => { const li = document.createElement("li"); li.textContent = s.text + " "; const sm = document.createElement("small"); sm.textContent = s.type === "depart" ? "" : `(${SR.fmt.dist(s.at)})`; li.append(sm); return li; }));
    $("panel").classList.remove("collapsed");
  }

  // ---------------------------------------------------------------- navigation
  function startNav(mode) {
    if (!state.route) return;
    if (state.nav) state.nav.stop();
    if (mode === "gps") {
      // real GPS only makes sense in Pune: if the start is not near the user, re-route from the GPS fix
      SR.toast("Starting GPS navigation — keep this screen on.");
    }
    $("panel").hidden = true; $("mapTools").hidden = true;
    const s = new SR.NavSession({
      map, graph: state.graph, route: state.route, mode,
      onEnd: () => { state.nav = null; $("panel").hidden = false; $("mapTools").hidden = false; },
      onReroute: (ll) => { state.from = ll; const r = state.graph.route(ll, state.to, state.mode); if (!r.error) { SR.Risk.analyseRoute(r, state.graph); state.route = r; s.route = r; s.s = 0; drawRoute(r, false); } },
    });
    state.nav = s;
    s.start();
    // simulator controls
    $("throttle").value = 0; $("throttleVal").textContent = 0; s.target = 0;
    $("btnAuto").setAttribute("aria-pressed", "false");
  }
  $("btnNav").onclick = () => startNav("gps");
  $("btnSim").onclick = () => startNav("sim");
  $("btnStop").onclick = () => state.nav && state.nav.stop();
  $("throttle").oninput = (e) => { if (state.nav) { state.nav.target = +e.target.value; state.nav.auto = false; $("btnAuto").setAttribute("aria-pressed", "false"); } $("throttleVal").textContent = e.target.value; };
  const brake = (on) => { if (state.nav) state.nav.brake = on; $("btnBrake").classList.toggle("on", on); };
  $("btnBrake").addEventListener("pointerdown", () => brake(true));
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => $("btnBrake").addEventListener(ev, () => brake(false)));
  $("btnAuto").onclick = () => { if (!state.nav) return; state.nav.auto = !state.nav.auto; $("btnAuto").setAttribute("aria-pressed", String(state.nav.auto)); };
  document.querySelectorAll("#speedSeg button").forEach((b) => (b.onclick = () => {
    document.querySelectorAll("#speedSeg button").forEach((x) => x.classList.toggle("on", x === b));
    if (state.nav) state.nav.mult = +b.dataset.x;
  }));
  $("btnMute").onclick = () => { SR.Voice.muted = !SR.Voice.muted; $("btnMute").textContent = SR.Voice.muted ? "🔇" : "🔊"; if (SR.Voice.muted) try { speechSynthesis.cancel(); } catch (e) {} };
  document.addEventListener("keydown", (e) => {
    if (!state.nav || state.nav.mode !== "sim" || e.target.tagName === "INPUT" && e.target.type !== "range") return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const t = Math.max(0, Math.min(100, +$("throttle").value + (e.key === "ArrowUp" ? 5 : -5)));
      $("throttle").value = t; $("throttle").dispatchEvent(new Event("input")); e.preventDefault();
    } else if (e.key === " ") { brake(true); e.preventDefault(); }
  });
  document.addEventListener("keyup", (e) => { if (e.key === " ") brake(false); });
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => (b.closest(".modal").hidden = true)));

  // ---------------------------------------------------------------- insights page
  $("btnInsights").onclick = () => { $("insights").hidden = false; };
  function closeInsights() { $("insights").hidden = true; }
  $("btnBack").onclick = closeInsights;

  // ---------------------------------------------------------------- demos + deep links
  const DEMOS = {
    katraj: [[18.4520, 73.8575], "Katraj", [18.4890, 73.7975], "Warje"],
    hinjewadi: [[18.5005, 73.8580], "Swargate", [18.5913, 73.7389], "Hinjewadi Phase 1"],
    airport: [[18.5309, 73.8475], "Shivajinagar", [18.5810, 73.9195], "Pune Airport"],
  };
  document.querySelectorAll("[data-demo]").forEach((b) => (b.onclick = () => {
    if (!state.graph) return;
    const d = DEMOS[b.dataset.demo];
    state.from = state.to = null;
    setPoint("from", d[0], d[1]); setPoint("to", d[2], d[3]);
  }));
  function writeHash() {
    if (!state.from || !state.to) return;
    const f = (p) => p.map((x) => x.toFixed(5)).join(",");
    history.replaceState(null, "", `#from=${f(state.from)}&to=${f(state.to)}&mode=${state.mode}`);
  }
  function readHash() {
    const m = location.hash.match(/from=([\d.]+),([\d.]+)&to=([\d.]+),([\d.]+)(?:&mode=(\w+))?/);
    if (!m) return;
    if (m[5] === "safe") document.querySelector('#modeSeg [data-mode="safe"]').click();
    state.mode = m[5] || "fast";
    setPoint("from", [+m[1], +m[2]]); setPoint("to", [+m[3], +m[4]]);
  }

  // mobile: tap the brand bar to collapse / expand the sheet
  document.querySelector(".brand").addEventListener("click", (e) => {
    if (window.innerWidth <= 760 && !e.target.closest("button")) $("panel").classList.toggle("collapsed");
  });

  SR.app = { state, map, computeRoute, setPoint, startNav };
  load();
})();
