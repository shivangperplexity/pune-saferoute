/* SafeRoute Pune — turn-by-turn navigation (real GPS or bike simulator), hotspot warnings, overspeed alerts. */
(function () {
  "use strict";
  const SR = (window.SR = window.SR || {});
  const { hav, bearing } = SR.geo;
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- voice + beep
  const Voice = {
    muted: false,
    say(text) {
      if (this.muted || !("speechSynthesis" in window)) return;
      try {
        const u = new SpeechSynthesisUtterance(text);
        const v = speechSynthesis.getVoices().find((x) => /en[-_]IN/i.test(x.lang)) || speechSynthesis.getVoices().find((x) => /^en/i.test(x.lang));
        if (v) u.voice = v;
        u.rate = 1.02;
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      } catch (e) { /* speech not available */ }
    },
    ctx: null,
    beep(freq = 880, ms = 160, times = 2) {
      if (this.muted) return;
      try {
        this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
        const t0 = this.ctx.currentTime;
        for (let i = 0; i < times; i++) {
          const o = this.ctx.createOscillator(), g = this.ctx.createGain();
          o.type = "square"; o.frequency.value = freq;
          g.gain.setValueAtTime(0.0001, t0 + i * (ms / 1000) * 1.6);
          g.gain.exponentialRampToValueAtTime(0.12, t0 + i * (ms / 1000) * 1.6 + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * (ms / 1000) * 1.6 + ms / 1000);
          o.connect(g).connect(this.ctx.destination);
          o.start(t0 + i * (ms / 1000) * 1.6); o.stop(t0 + i * (ms / 1000) * 1.6 + ms / 1000 + 0.02);
        }
      } catch (e) { /* audio blocked */ }
    },
  };

  const ARROWS = {
    depart: "M22 40V8M22 8l-9 9M22 8l9 9",
    straight: "M22 40V8M22 8l-9 9M22 8l9 9",
    left: "M30 40V22c0-4-3-7-7-7H10M10 15l8-8M10 15l8 8",
    right: "M14 40V22c0-4 3-7 7-7h13M34 15l-8-8M34 15l-8 8",
    "slight-left": "M28 40V24L14 10M14 10v11M14 10h11",
    "slight-right": "M16 40V24L30 10M30 10v11M30 10H19",
    uturn: "M14 40V18a8 8 0 0 1 16 0v10M30 28l-7-7M30 28l7-7",
    arrive: "M22 4c-7 0-12 5-12 12 0 9 12 22 12 22s12-13 12-22c0-7-5-12-12-12zm0 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8z",
  };
  function arrowSvg(type) {
    const d = ARROWS[type] || ARROWS.straight;
    const fill = type === "arrive";
    return `<svg viewBox="0 0 44 44"><path d="${d}" ${fill ? 'fill="#ffc94d"' : 'fill="none" stroke="#ffc94d" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"'}/></svg>`;
  }
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + " km" : Math.max(0, Math.round(m / 10) * 10) + " m");
  const fmtTime = (s) => { const m = Math.max(1, Math.round(s / 60)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };

  // ---------------------------------------------------------------- session
  class NavSession {
    constructor({ map, graph, route, mode, onEnd, onReroute }) {
      Object.assign(this, { map, graph, route, mode, onEnd, onReroute });
      this.s = 0; this.v = 0; this.target = 0; this.brake = false; this.auto = false; this.mult = 1;
      this.warned = new Set(); this.inZone = null; this.lastOver = 0; this.lastStepSaid = -1; this.offCount = 0;
      this.stats = { start: performance.now(), simTime: 0, dist: 0, maxV: 0, overTime: 0, overHotTime: 0, hot: new Set(), samples: 0, sumV: 0 };
      this.running = true;
      this.marker = null;
    }

    start() {
      $("hud").hidden = false;
      $("simCtl").hidden = this.mode !== "sim";
      document.body.classList.add("navigating");
      const p0 = this.route.pts[0];
      const icon = this.mode === "sim"
        ? L.divIcon({ className: "bike-ico", iconSize: [42, 42], iconAnchor: [21, 21], html: '<div class="b"><svg viewBox="0 0 24 24"><circle cx="5.5" cy="16.5" r="3.5" stroke="currentColor" stroke-width="2.2" fill="none"/><circle cx="18.5" cy="16.5" r="3.5" stroke="currentColor" stroke-width="2.2" fill="none"/><path d="M5.5 16.5l4-7h5l4 7M9.5 9.5L8 6H5.5M14.5 9.5l1.5-3.5h2.5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' })
        : L.divIcon({ className: "", iconSize: [20, 20], iconAnchor: [10, 10], html: '<div class="gps-dot"></div>' });
      this.marker = L.marker(p0, { icon, zIndexOffset: 1000, interactive: false }).addTo(this.map);
      this.map.setView(p0, 17, { animate: true });
      this.update(0);
      Voice.say(`Starting ${this.mode === "sim" ? "bike ride simulation" : "navigation"}. ${this.route.steps[0].text}. ` +
        (this.route.hotspots.length ? `There ${this.route.hotspots.length === 1 ? "is one accident hotspot" : "are " + this.route.hotspots.length + " accident hotspots"} on this route.` : "No accident hotspots on this route."));
      if (this.mode === "sim") {
        this.last = performance.now();
        const loop = (t) => {
          if (!this.running) return;
          const dt = Math.min(0.1, (t - this.last) / 1000) * this.mult;
          this.last = t;
          this.physics(dt);
          this.update(dt);
          this.raf = requestAnimationFrame(loop);
        };
        this.raf = requestAnimationFrame(loop);
      } else {
        this.startGps();
      }
    }

    // ------------------------------------------------ simulator physics
    physics(dt) {
      let target = this.target / 3.6;
      if (this.auto) target = this.autoTarget() / 3.6;
      if (this.brake) target = 0;
      const diff = target - this.v;
      const acc = diff > 0 ? Math.min(2.6, diff * 1.2) : Math.max(this.brake ? -7 : -3.5, diff * 1.5);
      this.v = Math.max(0, this.v + acc * dt);
      this.s = Math.min(this.route.distance, this.s + this.v * dt);
      this.stats.simTime += dt;
    }
    autoTarget() {
      // obey the effective limit, and slow down early for a lower limit ahead
      const here = this.limitAt(this.s).limit;
      let t = here;
      for (let ahead = 25; ahead <= 250; ahead += 25) {
        const l = this.limitAt(this.s + ahead).limit;
        const vAllowed = Math.sqrt((l / 3.6) ** 2 + 2 * 2.2 * Math.max(0, ahead - 15)) * 3.6;
        t = Math.min(t, vAllowed);
      }
      const nextStep = this.route.steps.find((st) => st.at > this.s + 3);
      if (nextStep && nextStep.type !== "arrive" && nextStep.type !== "straight") {
        const d = nextStep.at - this.s;
        const turnV = nextStep.type.startsWith("slight") ? 30 : 18;
        t = Math.min(t, Math.sqrt((turnV / 3.6) ** 2 + 2 * 2.2 * Math.max(0, d - 8)) * 3.6);
      }
      const remain = this.route.distance - this.s;
      t = Math.min(t, Math.sqrt(2 * 2.5 * Math.max(0, remain - 5)) * 3.6);
      return Math.max(0, t - 2);
    }

    // ------------------------------------------------ real GPS
    startGps() {
      if (!("geolocation" in navigator)) { SR.toast("This device has no GPS. Try the bike simulator instead."); return; }
      this.watch = navigator.geolocation.watchPosition((pos) => this.onFix(pos), (err) => {
        if (err.code === 1) SR.toast("Location permission denied — allow location access or use the simulator.", 6000);
        else if (!this.lastFix) SR.toast("Waiting for GPS signal…");
      }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
      this.gpsTimer = setInterval(() => this.update(1), 1000);
    }
    onFix(pos) {
      const { latitude: la, longitude: lo, speed } = pos.coords;
      if (!this.graph.inBounds(la, lo)) {
        if (!this.toldOutside) { this.toldOutside = true; SR.toast("You are outside Pune — GPS navigation works inside Pune. Use 'Simulate bike ride' to try the route.", 7000); }
        return;
      }
      const snap = this.project(la, lo);
      const t = pos.timestamp / 1000;
      if (snap.d > 60) {
        this.offCount++;
        if (this.offCount >= 3 && this.onReroute) { this.offCount = 0; Voice.say("Recalculating"); this.onReroute([la, lo]); return; }
      } else this.offCount = 0;
      let v = null;
      if (speed != null && !isNaN(speed)) v = speed;
      else if (this.lastFix) { const dt = t - this.lastFix.t; if (dt >= 0.5) v = hav(la, lo, this.lastFix.la, this.lastFix.lo) / dt; }
      // ignore GPS jumps (anything above 160 km/h) and smooth the rest
      if (v != null && v < 45) this.v = this.v ? this.v * 0.4 + v * 0.6 : v;
      this.lastFix = { la, lo, t };
      this.s = snap.s;
      this.rawPos = [la, lo];
      this.update(0);
    }
    project(la, lo) {
      // nearest point on route near the current position
      const P = this.route.pts, C = this.route.cum;
      let best = { d: Infinity, s: this.s };
      const i0 = Math.max(0, this.idxAt(this.s) - 40), i1 = Math.min(P.length - 1, this.idxAt(this.s) + 200);
      const cos = Math.cos((la * Math.PI) / 180);
      for (let i = i0; i < i1; i++) {
        const ax = P[i][1] * cos, ay = P[i][0], bx = P[i + 1][1] * cos, by = P[i + 1][0];
        const px = lo * cos, py = la;
        const dx = bx - ax, dy = by - ay;
        const tt = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
        const qx = ax + tt * dx, qy = ay + tt * dy;
        const d = hav(la, lo, qy, qx / cos);
        if (d < best.d) best = { d, s: C[i] + tt * (C[i + 1] - C[i]) };
      }
      return best;
    }

    // ------------------------------------------------ helpers along the route
    idxAt(s) {
      const C = this.route.cum;
      let lo = 0, hi = C.length - 1;
      while (lo < hi - 1) { const m = (lo + hi) >> 1; if (C[m] <= s) lo = m; else hi = m; }
      return lo;
    }
    posAt(s) {
      const i = this.idxAt(s), P = this.route.pts, C = this.route.cum;
      if (i >= P.length - 1) return P[P.length - 1];
      const t = (s - C[i]) / Math.max(0.01, C[i + 1] - C[i]);
      return [P[i][0] + t * (P[i + 1][0] - P[i][0]), P[i][1] + t * (P[i + 1][1] - P[i][1])];
    }
    limitAt(s) {
      const i = Math.min(this.idxAt(Math.min(s, this.route.distance - 0.1)), this.route.segLim.length - 1);
      const zone = this.route.zones[i];
      return { ...SR.Risk.effectiveLimit(this.route.segLim[i], zone, this.clock()), zone };
    }
    clock() { return new Date(); }

    // ------------------------------------------------ per-frame update
    update(dt) {
      const r = this.route;
      const pos = this.mode === "gps" && this.rawPos ? this.rawPos : this.posAt(this.s);
      if (this.marker) {
        this.marker.setLatLng(pos);
        if (this.mode === "sim") {
          const a = this.posAt(Math.max(0, this.s - 5)), b = this.posAt(Math.min(r.distance, this.s + 10));
          const hd = bearing(a[0], a[1], b[0], b[1]);
          const el = this.marker.getElement();
          if (el) el.firstChild.style.transform = `rotate(${hd - 90}deg)`;
        }
      }
      if (!this._lastPan || performance.now() - this._lastPan > 250) {
        this._lastPan = performance.now();
        if (!this.map.getBounds().pad(-0.25).contains(pos)) this.map.panTo(pos, { animate: true, duration: 0.4 });
      }

      const kmh = this.v * 3.6;
      const lim = this.limitAt(this.s);
      const over = kmh > lim.limit + 2;
      // stats
      if (dt > 0) {
        this.stats.dist = this.s;
        this.stats.maxV = Math.max(this.stats.maxV, kmh);
        this.stats.samples += dt; this.stats.sumV += kmh * dt;
        if (over) { this.stats.overTime += dt; if (lim.zone) this.stats.overHotTime += dt; }
      }

      // speedometer + limit
      $("speedNum").textContent = Math.round(kmh);
      $("speedArc").style.strokeDasharray = `${Math.min(245, (kmh / 100) * 245)} 327`;
      $("speedo").classList.toggle("over", over);
      $("limitNum").textContent = lim.limit;
      $("limitSign").classList.toggle("reduced", lim.reduced);
      $("limitNote").textContent = lim.reduced ? `Cut from ${lim.base} — ${lim.reasons.join(", ")}` : "";

      // next maneuver
      const step = r.steps.find((st) => st.at > this.s + 3) || r.steps[r.steps.length - 1];
      const toStep = step.at - this.s;
      $("mArrow").innerHTML = arrowSvg(step.type);
      $("mDist").textContent = step.type === "arrive" && toStep < 15 ? "Arrived" : fmtDist(toStep);
      $("mText").textContent = step.text;
      const si = r.steps.indexOf(step);
      if (si !== this.lastStepSaid && toStep < Math.max(60, this.v * 8) && step.type !== "depart") {
        this.lastStepSaid = si;
        Voice.say(step.type === "arrive" ? "You will arrive at your destination shortly" : `In ${fmtDist(Math.max(10, toStep)).replace(" m", " metres").replace(" km", " kilometres")}, ${step.text}`);
      }

      // remaining
      const rem = Math.max(0, r.distance - this.s);
      const remTime = rem / Math.max(1, r.distance) * r.duration;
      $("remain").textContent = fmtDist(rem);
      const eta = new Date(Date.now() + remTime * 1000);
      $("eta").textContent = `${fmtTime(remTime)} · ${eta.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

      // hotspot warnings
      this.checkHotspots(kmh, lim);
      // overspeed alert
      const now = performance.now();
      if (over && now - this.lastOver > 4500) {
        this.lastOver = now;
        Voice.beep(lim.zone ? 990 : 880, 140, 2);
        if (now - (this.lastOverSay || 0) > 12000) { this.lastOverSay = now; Voice.say(`Slow down. Speed limit ${lim.limit}`); }
      }
      if (over && this.inZone === null && this.warnKind !== "ahead") this.showWarn("over", `Over the limit: ${Math.round(kmh)} in a ${lim.limit} zone`, lim.reduced ? `Limit reduced — ${lim.reasons.join(", ")}` : "Ease off the throttle");
      else if (!over && this.warnKind === "over") this.hideWarn();

      if (rem < 8 || (this.mode === "sim" && this.s >= r.distance - 0.5)) this.finish(true);
    }

    checkHotspots(kmh, lim) {
      const r = this.route;
      // currently inside a zone?
      if (lim.zone) {
        this.stats.hot.add(lim.zone.id);
        if (this.inZone !== lim.zone.id) {
          this.inZone = lim.zone.id;
          Voice.beep(660, 180, 3);
          Voice.say(`Entering accident hotspot, ${lim.zone.name}. Speed limit ${lim.limit}.`);
        }
        this.showWarn("in", (kmh > lim.limit + 2 ? "Slow down! " : "") + `Accident hotspot: ${lim.zone.name}`, `${lim.zone.accidents} crashes · ${lim.zone.killed} deaths in 5 years · usually ${lim.zone.top_cause.toLowerCase()} · keep under ${lim.limit} km/h`);
        return;
      }
      if (this.inZone !== null) { this.inZone = null; this.hideWarn(); }
      // upcoming zone within ~500 m
      for (const h of r.hotspots) {
        const d = h.from - this.s;
        if (d > 0 && d < 500) {
          const l = this.limitAt(h.from + 1).limit;
          this.showWarn("ahead", `Hotspot in ${fmtDist(d)}: ${h.zone.name}`, `Limit drops to ${l} km/h · ${h.zone.accidents} crashes here, ${h.zone.fatal} fatal`);
          if (!this.warned.has(h.zone.id)) {
            this.warned.add(h.zone.id);
            Voice.beep(740, 160, 2);
            Voice.say(`Caution. Accident hotspot ahead in ${fmtDist(d).replace(" m", " metres").replace(" km", " kilometres")}, ${h.zone.name}. Slow down to ${l}.`);
          }
          return;
        }
      }
      if (this.warnKind === "ahead") this.hideWarn();
    }

    showWarn(kind, title, text) {
      const w = $("warn");
      this.warnKind = kind;
      w.className = "warn" + (kind === "in" ? " in" : kind === "over" ? " over" : "");
      $("warnTitle").textContent = title;
      $("warnText").textContent = text;
      w.hidden = false;
    }
    hideWarn() { $("warn").hidden = true; this.warnKind = null; }

    finish(arrived) {
      if (!this.running) return;
      this.stop();
      if (!arrived) return;
      Voice.say("You have arrived.");
      const st = this.stats;
      const overPct = st.samples ? (st.overTime / st.samples) * 100 : 0;
      const score = Math.max(0, Math.round(100 - overPct * 1.2 - (st.samples ? (st.overHotTime / st.samples) * 100 * 1.5 : 0)));
      $("tripScore").textContent = score;
      $("tripTitle").textContent = score >= 85 ? "Great, safe ride!" : score >= 60 ? "Trip complete — watch your speed" : "Trip complete — too fast in places";
      const rows = [
        ["Distance", fmtDist(st.dist)],
        ["Riding time", fmtTime(st.samples || (performance.now() - st.start) / 1000)],
        ["Average speed", Math.round(st.samples ? st.sumV / st.samples : 0) + " km/h"],
        ["Top speed", Math.round(st.maxV) + " km/h"],
        ["Time over the limit", `${Math.round(st.overTime)} s (${overPct.toFixed(0)}%)`],
        ["…of that inside hotspots", Math.round(st.overHotTime) + " s"],
        ["Hotspots passed", st.hot.size],
      ];
      const dl = $("tripStats");
      dl.textContent = "";
      for (const [k, v] of rows) { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; dl.append(dt, dd); }
      $("tripModal").hidden = false;
    }

    stop() {
      this.running = false;
      cancelAnimationFrame(this.raf);
      if (this.watch != null) navigator.geolocation.clearWatch(this.watch);
      clearInterval(this.gpsTimer);
      if (this.marker) this.marker.remove();
      $("hud").hidden = true;
      $("warn").hidden = true;
      document.body.classList.remove("navigating");
      try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
      if (this.onEnd) this.onEnd();
    }
  }

  SR.NavSession = NavSession;
  SR.Voice = Voice;
  SR.fmt = { dist: fmtDist, time: fmtTime };
})();
