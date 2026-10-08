/* SafeRoute Pune — offline road graph + routing (A*) built from OpenStreetMap data. */
(function () {
  "use strict";
  const SR = (window.SR = window.SR || {});
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;

  function hav(la1, lo1, la2, lo2) {
    const a = Math.sin(rad(la2 - la1) / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(rad(lo2 - lo1) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function bearing(la1, lo1, la2, lo2) {
    const y = Math.sin(rad(lo2 - lo1)) * Math.cos(rad(la2));
    const x = Math.cos(rad(la1)) * Math.sin(rad(la2)) - Math.sin(rad(la1)) * Math.cos(rad(la2)) * Math.cos(rad(lo2 - lo1));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  // typical riding speed (km/h) per road class — capped by the legal limit
  const TYPICAL = [70, 55, 40, 35, 30, 25, 20, 15];
  const CLASS_NAMES = ["Expressway", "Highway", "Main road", "Main road", "Link road", "Minor road", "Street", "Lane"];

  class MinHeap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v;
      let i = k.length;
      k.push(key); v.push(val);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (k[p] <= key) break;
        k[i] = k[p]; v[i] = v[p]; i = p;
      }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v;
      const top = v[0];
      const lk = k.pop(), lv = v.pop();
      if (k.length) {
        let i = 0;
        const n = k.length;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lk) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
  }

  class Graph {
    constructor(G) {
      const q = G.q;
      const nV = G.v.length / 2, nE = G.e.length / 7;
      this.nV = nV; this.nE = nE; this.names = G.names; this.classes = G.classes;
      this.lat = new Float64Array(nV); this.lon = new Float64Array(nV);
      for (let i = 0; i < nV; i++) { this.lat[i] = G.v[2 * i] / q; this.lon[i] = G.v[2 * i + 1] / q; }
      const ea = (this.ea = new Int32Array(nE)), eb = (this.eb = new Int32Array(nE));
      const elen = (this.elen = new Float32Array(nE)), ecls = (this.ecls = new Uint8Array(nE));
      const elim = (this.elim = new Uint8Array(nE)), ename = (this.ename = new Int32Array(nE)), eow = (this.eow = new Int8Array(nE));
      this.geom = G.g; this.q = q;
      const deg = new Int32Array(nV + 1);
      for (let i = 0; i < nE; i++) {
        const o = 7 * i, E = G.e;
        ea[i] = E[o]; eb[i] = E[o + 1]; elen[i] = E[o + 2]; ecls[i] = E[o + 3]; elim[i] = E[o + 4]; ename[i] = E[o + 5]; eow[i] = E[o + 6];
        if (eow[i] !== -1) deg[ea[i]]++;
        if (eow[i] !== 1) deg[eb[i]]++;
      }
      const start = (this.adjStart = new Int32Array(nV + 1));
      for (let i = 0; i < nV; i++) start[i + 1] = start[i] + deg[i];
      const fill = start.slice(0, nV);
      this.adjEdge = new Int32Array(start[nV]);
      this.adjDir = new Int8Array(start[nV]);
      for (let i = 0; i < nE; i++) {
        if (eow[i] !== -1) { const p = fill[ea[i]]++; this.adjEdge[p] = i; this.adjDir[p] = 1; }
        if (eow[i] !== 1) { const p = fill[eb[i]]++; this.adjEdge[p] = i; this.adjDir[p] = -1; }
      }
      // grid index of routable vertices for snapping
      this.cell = 0.004;
      this.grid = new Map();
      for (let i = 0; i < nV; i++) {
        if (start[i + 1] === start[i]) continue;
        const key = Math.floor(this.lat[i] / this.cell) * 100000 + Math.floor(this.lon[i] / this.cell);
        let a = this.grid.get(key);
        if (!a) this.grid.set(key, (a = []));
        a.push(i);
      }
      this.penalty = new Float32Array(nE); // set by risk module (hotspot factor)
      this.bounds = [[18.42, 73.72], [18.70, 74.02]];
    }

    edgePoints(i, dir) {
      const pts = [[this.lat[this.ea[i]], this.lon[this.ea[i]]]];
      const g = this.geom[i], q = this.q;
      let la = Math.round(pts[0][0] * q), lo = Math.round(pts[0][1] * q);
      for (let j = 0; j < g.length; j += 2) { la += g[j]; lo += g[j + 1]; pts.push([la / q, lo / q]); }
      pts.push([this.lat[this.eb[i]], this.lon[this.eb[i]]]);
      return dir === -1 ? pts.reverse() : pts;
    }

    nearestVertex(la, lo, maxM = 2500) {
      let best = -1, bd = Infinity;
      const ci = Math.floor(la / this.cell), cj = Math.floor(lo / this.cell);
      for (let ring = 0; ring <= 6; ring++) {
        for (let di = -ring; di <= ring; di++) for (let dj = -ring; dj <= ring; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
          const a = this.grid.get((ci + di) * 100000 + (cj + dj));
          if (!a) continue;
          for (const v of a) {
            const d = hav(la, lo, this.lat[v], this.lon[v]);
            if (d < bd) { bd = d; best = v; }
          }
        }
        if (best >= 0 && ring >= 1 && bd < ring * this.cell * 100000) break;
      }
      return bd <= maxM ? { v: best, dist: bd } : null;
    }

    inBounds(la, lo) {
      return la > this.bounds[0][0] && la < this.bounds[1][0] && lo > this.bounds[0][1] && lo < this.bounds[1][1];
    }

    edgeTime(i) {
      const v = Math.min(this.elim[i], TYPICAL[this.ecls[i]]) / 3.6;
      return this.elen[i] / v;
    }

    /** A* search. mode: "fast" (minimum time) or "safe" (time weighted by hotspot risk) */
    nearVertices(la, lo, k = 6, maxM = 220) {
      const ci = Math.floor(la / this.cell), cj = Math.floor(lo / this.cell);
      const c = [];
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const a = this.grid.get((ci + di) * 100000 + (cj + dj));
        if (a) for (const v of a) { const d = hav(la, lo, this.lat[v], this.lon[v]); if (d <= maxM) c.push({ v, dist: d }); }
      }
      c.sort((x, y) => x.dist - y.dist);
      if (c.length) return c.slice(0, k);
      const n = this.nearestVertex(la, lo);
      return n ? [n] : [];
    }

    /** A* search from several snapped start vertices to several snapped end vertices.
        mode: "fast" (minimum time) or "safe" (time weighted by hotspot risk) */
    route(from, to, mode = "fast") {
      const S = this.nearVertices(from[0], from[1]);
      const T = this.nearVertices(to[0], to[1]);
      if (!S.length || !T.length) return { error: "Point is outside the Pune road map." };
      const n = this.nV, ACCESS = 4; // m/s to reach the road from the clicked point
      const g = new Float64Array(n).fill(Infinity);
      const prevE = new Int32Array(n).fill(-1);
      const prevD = new Int8Array(n);
      const closed = new Uint8Array(n);
      const vmax = 75 / 3.6;
      const h = (v) => hav(this.lat[v], this.lon[v], to[0], to[1]) / vmax;
      const heap = new MinHeap();
      for (const s of S) { g[s.v] = s.dist / ACCESS; heap.push(g[s.v] + h(s.v), s.v); }
      const tExtra = new Map(T.map((t) => [t.v, t.dist / ACCESS]));
      let best = Infinity, bestV = -1, expanded = 0;
      while (heap.size) {
        if (heap.k[0] >= best) break;
        const u = heap.pop();
        if (closed[u]) continue;
        closed[u] = 1; expanded++;
        if (tExtra.has(u) && g[u] + tExtra.get(u) < best) { best = g[u] + tExtra.get(u); bestV = u; }
        for (let p = this.adjStart[u]; p < this.adjStart[u + 1]; p++) {
          const e = this.adjEdge[p], d = this.adjDir[p];
          const w = d === 1 ? this.eb[e] : this.ea[e];
          if (closed[w]) continue;
          let c = this.edgeTime(e);
          if (mode === "safe") c *= 1 + this.penalty[e];
          const ng = g[u] + c;
          if (ng < g[w]) { g[w] = ng; prevE[w] = e; prevD[w] = d; heap.push(ng + h(w), w); }
        }
      }
      if (bestV < 0) return { error: "No road connection found between these points." };
      const path = [];
      for (let v = bestV; prevE[v] !== -1; ) {
        const e = prevE[v], d = prevD[v];
        path.push([e, d]);
        v = d === 1 ? this.ea[e] : this.eb[e];
      }
      path.reverse();
      if (!path.length) return { error: "Start and destination are too close." };
      const r = this.buildRoute(path, from, to);
      r.expanded = expanded; r.mode = mode;
      return r;
    }

    buildRoute(path, from, to) {
      const pts = [], segLim = [], segCls = [], segName = [], segEdge = [];
      let time = 0;
      for (const [e, d] of path) {
        const p = this.edgePoints(e, d);
        const startIdx = pts.length ? 1 : 0;
        for (let k = startIdx; k < p.length; k++) {
          if (pts.length) { segLim.push(this.elim[e]); segCls.push(this.ecls[e]); segName.push(this.ename[e]); segEdge.push(e); }
          pts.push(p[k]);
        }
        time += this.edgeTime(e);
      }
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
      const route = { pts, cum, segLim, segCls, segName, segEdge, distance: cum[cum.length - 1], duration: time, from, to };
      route.steps = this.instructions(route);
      return route;
    }

    roadName(segIdx, route) {
      const n = this.names[route.segName[segIdx]];
      return n || CLASS_NAMES[route.segCls[segIdx]].toLowerCase();
    }

    instructions(route) {
      const { pts, cum, segName } = route;
      const steps = [];
      if (pts.length < 2) return steps;
      const nm = (i) => this.names[segName[i]] || "";
      const headingAt = (i, back) => {
        // bearing over ~25 m to smooth OSM geometry noise
        let j = i;
        if (back) { while (j > 0 && cum[i] - cum[j] < 25) j--; return bearing(pts[j][0], pts[j][1], pts[i][0], pts[i][1]); }
        while (j < pts.length - 1 && cum[j] - cum[i] < 25) j++;
        return bearing(pts[i][0], pts[i][1], pts[j][0], pts[j][1]);
      };
      steps.push({ type: "depart", text: `Head ${compass(headingAt(0, false))} on ${this.roadName(0, route)}`, at: 0, idx: 0 });
      for (let i = 1; i < pts.length - 1; i++) {
        const a = nm(i - 1), b = nm(i);
        const d = ((headingAt(i, false) - headingAt(i, true) + 540) % 360) - 180;
        const ad = Math.abs(d);
        const named = a !== b && b !== "";
        if (a === b && a !== "") continue; // a bend on the same road is not a turn
        if (!(named && ad > 12) && ad < 50) continue;
        if (!named && ad < 50) continue;
        // ignore tiny wiggles too close to the previous step
        if (steps.length && cum[i] - steps[steps.length - 1].at < 30 && ad < 100) continue;
        let type, verb;
        if (ad < 25) { type = "straight"; verb = "Continue"; }
        else if (ad < 60) { type = d < 0 ? "slight-left" : "slight-right"; verb = d < 0 ? "Keep left" : "Keep right"; }
        else if (ad < 145) { type = d < 0 ? "left" : "right"; verb = d < 0 ? "Turn left" : "Turn right"; }
        else { type = "uturn"; verb = "Make a U-turn"; }
        const onto = b ? ` onto ${b}` : "";
        steps.push({ type, text: verb + onto, at: cum[i], idx: i });
      }
      steps.push({ type: "arrive", text: "You have arrived", at: cum[cum.length - 1], idx: pts.length - 1 });
      // drop zig-zag artefacts of dual-carriageway mapping (two opposite turns a few metres apart)
      const out = [];
      for (let k = 0; k < steps.length; k++) {
        const s = steps[k], n = steps[k + 1];
        if (n && n.type !== "arrive" && s.type !== "depart" && n.at - s.at < 60 &&
            ((s.type === "uturn" && n.type === "uturn") || (s.type.endsWith("left") && n.type.endsWith("right")) || (s.type.endsWith("right") && n.type.endsWith("left")))) {
          k++; continue;
        }
        out.push(s);
      }
      return out;
    }
  }

  function compass(b) {
    return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(b / 45) % 8];
  }

  SR.Graph = Graph;
  SR.geo = { hav, bearing, compass, CLASS_NAMES, TYPICAL };
  SR.MinHeap = MinHeap;
})();
