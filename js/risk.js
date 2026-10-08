/* SafeRoute Pune — accident hotspots, risk-aware speed limits and the crash-severity risk model. */
(function () {
  "use strict";
  const SR = (window.SR = window.SR || {});
  const { hav } = SR.geo;

  const Risk = {
    hotspots: [],
    insights: null,
    conditions: { weather: "Clear", night: null }, // night=null -> follow the clock

    init(insights, graph) {
      this.insights = insights;
      this.hotspots = insights.hotspots;
      // penalty per edge for "safest route": edges whose midpoint lies inside a hotspot zone
      const pen = { High: 8, Medium: 4, Low: 2 };
      for (let i = 0; i < graph.nE; i++) {
        const a = graph.ea[i], b = graph.eb[i];
        const la = (graph.lat[a] + graph.lat[b]) / 2, lo = (graph.lon[a] + graph.lon[b]) / 2;
        for (const h of this.hotspots) {
          if (Math.abs(la - h.lat) > 0.008 || Math.abs(lo - h.lon) > 0.008) continue;
          if (hav(la, lo, h.lat, h.lon) <= h.radius_m) { graph.penalty[i] = Math.max(graph.penalty[i], pen[h.tier]); }
        }
      }
    },

    isNight(date) {
      if (this.conditions.night !== null) return this.conditions.night;
      const h = (date || new Date()).getHours();
      return h >= 21 || h < 6;
    },
    timeBand(date) {
      const h = (date || new Date()).getHours();
      if (this.conditions.night === true) return "Night (21-6)";
      if (h >= 6 && h < 10) return "Morning (6-10)";
      if (h >= 10 && h < 16) return "Midday (10-16)";
      if (h >= 16 && h < 21) return "Evening (16-21)";
      return "Night (21-6)";
    },

    zoneAt(la, lo) {
      let best = null;
      for (const h of this.hotspots) {
        if (Math.abs(la - h.lat) > 0.01 || Math.abs(lo - h.lon) > 0.01) continue;
        const d = hav(la, lo, h.lat, h.lon);
        if (d <= h.radius_m && (!best || h.esi > best.esi)) best = h;
      }
      return best;
    },

    /** Legal limit adjusted for accident risk: cut inside hotspots, more at night / in rain or fog. */
    effectiveLimit(baseLimit, zone, date) {
      let lim = baseLimit;
      const reasons = [];
      const bad = this.conditions.weather === "Rain" || this.conditions.weather === "Mist/Fog";
      if (zone) {
        lim -= zone.limit_cut;
        reasons.push(`accident hotspot (${zone.tier.toLowerCase()} risk)`);
        if (this.isNight(date)) { lim -= 10; reasons.push("night"); }
        if (bad) { lim -= 10; reasons.push(this.conditions.weather.toLowerCase()); }
      } else if (bad) {
        lim -= 10; reasons.push(this.conditions.weather.toLowerCase());
      }
      lim = Math.max(20, Math.round(lim / 5) * 5);
      if (lim > baseLimit) lim = baseLimit;
      return { limit: lim, base: baseLimit, reduced: lim < baseLimit, reasons };
    },

    /** Naive Bayes: probability that a crash under these conditions is fatal. */
    fatalRisk(cond) {
      const nb = this.insights.naive_bayes.model;
      let l1 = Math.log(nb.prior.fatal), l0 = Math.log(1 - nb.prior.fatal);
      for (const f of this.insights.naive_bayes.features) {
        const t = nb.cpt[f][cond[f]];
        if (!t) continue;
        l1 += Math.log(t[0]); l0 += Math.log(t[1]);
      }
      return 1 / (1 + Math.exp(l0 - l1));
    },

    lightFor(roadType, date) {
      const h = (date || new Date()).getHours();
      if (this.conditions.night === true || h >= 19 || h < 6) return roadType === "Highway" ? "Dark - unlit" : "Dark - lit";
      if (h === 18 || h === 6) return "Dusk/Dawn";
      return "Daylight";
    },

    /** analyse a computed route: hotspots crossed, risk score */
    analyseRoute(route, graph) {
      const crossed = new Map();
      const zoneIdx = new Array(route.pts.length - 1);
      for (let i = 0; i < route.pts.length - 1; i++) {
        const la = (route.pts[i][0] + route.pts[i + 1][0]) / 2, lo = (route.pts[i][1] + route.pts[i + 1][1]) / 2;
        const z = this.zoneAt(la, lo);
        zoneIdx[i] = z;
        if (z) {
          const c = crossed.get(z.id) || { zone: z, from: route.cum[i], to: route.cum[i + 1] };
          c.to = route.cum[i + 1];
          crossed.set(z.id, c);
        }
      }
      route.zones = zoneIdx;
      route.hotspots = [...crossed.values()].sort((a, b) => a.from - b.from);
      // worst-case fatal risk along the route for a two-wheeler right now
      const rtOf = (cls) => (cls <= 1 ? "Highway" : cls <= 3 ? "Arterial" : cls <= 5 ? "Collector" : "Local");
      const byType = new Map();
      for (let i = 0; i < route.segCls.length; i++) {
        const t = rtOf(route.segCls[i]);
        byType.set(t, (byType.get(t) || 0) + (route.cum[i + 1] - route.cum[i]));
      }
      const now = new Date();
      let risk = 0;
      for (const [t, len] of byType) {
        const p = this.fatalRisk({ road_type: t, time_band: this.timeBand(now), light: this.lightFor(t, now), weather: this.conditions.weather, vehicle: "Two-wheeler" });
        risk += p * len;
      }
      route.fatalRisk = risk / Math.max(1, route.distance);
      route.roadMix = byType;
      return route;
    },
  };

  SR.Risk = Risk;
})();
