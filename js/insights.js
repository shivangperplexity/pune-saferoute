/* SafeRoute Pune — insights page: hotspot ranking, association rules, risk checker and OLAP explorer. */
(function () {
  "use strict";
  const SR = (window.SR = window.SR || {});
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v != null) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : String(k));
    return e;
  };
  const fmt = (n) => Number(n).toLocaleString("en-IN");

  // plain-language versions of the mined items
  function say(item) {
    const [k, v] = item.split("=");
    const M = {
      "Road=Highway": "on highways", "Road=Arterial": "on main roads", "Road=Collector": "on link roads", "Road=Local": "on local streets",
      "Light=Dark - unlit": "on unlit roads at night", "Light=Dark - lit": "on lit roads at night", "Light=Daylight": "in daylight", "Light=Dusk/Dawn": "at dusk or dawn",
      "Location=Bridge/Slope": "on bridges and slopes", "Location=Junction": "at junctions", "Location=Mid-block": "between junctions",
      "Day=Weekend": "on weekends", "Day=Weekday": "on weekdays",
    };
    if (M[item]) return M[item];
    if (k === "Time") return v.replace(/ \(.*\)/, "").toLowerCase() === "night" ? "late at night (9 pm – 6 am)" : "in the " + v.replace(/ \(.*\)/, "").toLowerCase() + ` (${v.match(/\((.*)\)/)[1]} h)`;
    if (k === "Vehicle") return { "Two-wheeler": "two-wheelers", Pedestrian: "pedestrians", "Truck/Tempo": "trucks", Car: "cars", Bus: "buses", Bicycle: "cyclists", "Auto-rickshaw": "autos" }[v] || v;
    if (k === "Cause") return v.toLowerCase();
    if (k === "Weather") return v === "Clear" ? "in clear weather" : "in " + v.toLowerCase();
    if (k === "Season") return "in " + v.toLowerCase();
    return v;
  }
  function sentence(ifs) {
    const subj = ifs.filter((x) => x.startsWith("Vehicle=")).map(say);
    const cause = ifs.filter((x) => x.startsWith("Cause=")).map(say);
    const rest = ifs.filter((x) => !x.startsWith("Vehicle=") && !x.startsWith("Cause=")).map(say);
    let s = subj.length ? subj[0][0].toUpperCase() + subj[0].slice(1) : "Crashes";
    if (cause.length) s += (subj.length ? " " : " caused by ") + (subj.length ? "with " : "") + cause.join(", ");
    if (rest.length) s += " " + rest.join(", ");
    return s;
  }

  const Insights = {
    rows: [],
    init(ins, rows, onShowHotspot) {
      this.ins = ins; this.rows = rows; this.onShowHotspot = onShowHotspot;
      this.tiles(); this.hotTable(); this.rules(); this.checker(); this.olapInit();
      document.querySelectorAll("#insTabs button").forEach((b) => b.addEventListener("click", () => this.tab(b.dataset.tab)));
    },
    tab(t) {
      document.querySelectorAll("#insTabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
      for (const id of ["hot", "rules", "olap"]) $("tab-" + id).hidden = id !== t;
    },
    tiles() {
      const p = this.ins.preprocessing, d = this.ins.dbscan;
      const T = [
        [fmt(p.records), "crashes (2019–2023)"], [fmt(p.killed), "people killed"], [fmt(p.injured), "people injured"],
        [d.clusters, "hotspots found"], [`${d.official_detected} of ${d.official_spots}`, "police black spots matched"],
      ];
      $("tiles").replaceChildren(...T.map(([b, s]) => el("div", null, el("b", null, b), el("span", null, s))));
    },
    hotTable() {
      const t = $("hotTable");
      const head = el("tr", null, ["#", "Hotspot", "Risk", "Crashes", "Fatal", "Deaths", "Worst time", "Main cause", "Mostly", ""].map((h, i) => el("th", { class: i >= 3 && i <= 5 ? "n" : "" }, h)));
      const body = this.ins.hotspots.map((h) => el("tr", null,
        el("td", null, h.rank), el("td", null, el("b", null, h.name), el("br"), el("small", { class: "muted" }, h.road)),
        el("td", null, el("span", { class: "tier t-" + h.tier }, h.tier)),
        el("td", { class: "n" }, h.accidents), el("td", { class: "n" }, h.fatal), el("td", { class: "n" }, h.killed),
        el("td", null, h.peak_time.replace(/ \(.*\)/, "")), el("td", null, h.top_cause), el("td", null, h.top_vehicle),
        el("td", null, el("button", { class: "link", onclick: () => this.onShowHotspot(h) }, "Show on map")),
      ));
      t.replaceChildren(el("thead", null, head), el("tbody", null, body));
    },
    rules() {
      const avg = this.ins.preprocessing.fatal / this.ins.preprocessing.records;
      $("fatalRules").replaceChildren(...this.ins.apriori.fatal_rules.slice(0, 9).map((r) => el("li", null,
        el("p", null, sentence(r.if)),
        el("small", null, `${Math.round(r.confidence * 100)}% of these crashes were fatal (average ${Math.round(avg * 100)}%) · ${r.count} cases`),
        el("div", { class: "x" }, r.lift.toFixed(1) + "×", el("small", null, "deadlier")),
      )));
      $("otherRules").replaceChildren(...this.ins.apriori.other_rules.slice(0, 6).map((r) => el("li", null,
        el("p", null, sentence(r.if) + " → often ", el("b", null, say(r.then))),
        el("small", null, `${Math.round(r.confidence * 100)}% of the time · ${r.count} cases`),
        el("div", { class: "x" }, r.lift.toFixed(1) + "×"),
      )));
    },
    checker() {
      const nb = this.ins.naive_bayes;
      const labels = { road_type: "Road", time_band: "Time", light: "Light", weather: "Weather", vehicle: "Vehicle" };
      const defaults = { road_type: "Highway", time_band: "Night (21-6)", light: "Dark - unlit", weather: "Clear", vehicle: "Two-wheeler" };
      const box = $("checker");
      const sels = {};
      for (const f of nb.features) {
        const s = el("select", { onchange: () => upd() }, Object.keys(nb.model.cpt[f]).map((v) => el("option", { value: v }, v)));
        s.value = defaults[f];
        sels[f] = s;
        box.append(el("label", null, labels[f], s));
      }
      const upd = () => {
        const c = {};
        for (const f in sels) c[f] = sels[f].value;
        const p = SR.Risk.fatalRisk(c);
        $("chkFill").style.width = Math.round(p * 100) + "%";
        $("chkFill").style.background = SR.riskColor(p);
        $("chkVal").textContent = Math.round(p * 100) + "%";
      };
      upd();
    },

    // -------------------------------------------------------------- OLAP explorer
    DIMS: {
      year: { label: "Year", drill: "month" }, month: { label: "Month", parent: "year" },
      time_band: { label: "Time of day", drill: "hour" }, hour: { label: "Hour", parent: "time_band" },
      road_type: { label: "Road type", drill: "road" }, road: { label: "Road", parent: "road_type" },
      severity: { label: "Severity" }, vehicle: { label: "Vehicle" }, cause: { label: "Cause" },
      weather: { label: "Weather" }, light: { label: "Light" }, season: { label: "Season" }, weekday: { label: "Day of week" }, location: { label: "Location" },
    },
    ORDER: {
      time_band: ["Morning (6-10)", "Midday (10-16)", "Evening (16-21)", "Night (21-6)"],
      severity: ["Fatal", "Grievous", "Minor"], season: ["Summer", "Monsoon", "Winter"],
      weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], road_type: ["Highway", "Arterial", "Collector", "Local"],
    },
    olapInit() {
      this.o = { rows: "year", cols: "severity", measure: "count", filters: {}, drillPath: [] };
      const dims = Object.entries(this.DIMS).filter(([k, d]) => !d.parent);
      const fill = (sel, none) => {
        sel.replaceChildren(...(none ? [el("option", { value: "" }, "— none —")] : []), ...dims.map(([k, d]) => el("option", { value: k }, d.label)));
      };
      fill($("oRows")); fill($("oCols"), true);
      $("oRows").value = "year"; $("oCols").value = "severity";
      $("oRows").onchange = () => { this.o.rows = $("oRows").value; this.o.drillPath = []; this.olap(); };
      $("oCols").onchange = () => { this.o.cols = $("oCols").value; this.olap(); };
      $("oMeasure").onchange = () => { this.o.measure = $("oMeasure").value; this.olap(); };
      $("oPivot").onclick = () => {
        if (!this.o.cols) return;
        [this.o.rows, this.o.cols] = [this.o.cols, this.o.rows]; this.o.drillPath = [];
        $("oRows").value = this.o.rows; $("oCols").value = this.o.cols; this.olap();
      };
      $("oUp").onclick = () => this.rollUp();
      // slice / dice filters
      const F = $("oFilters");
      for (const f of ["year", "season", "severity", "vehicle"]) {
        const vals = this.values(f);
        const grp = el("div", { class: "grp" }, el("span", null, this.DIMS[f].label + ":"));
        for (const v of vals) {
          const b = el("button", { onclick: () => {
            const set = (this.o.filters[f] = this.o.filters[f] || new Set());
            set.has(v) ? set.delete(v) : set.add(v);
            b.classList.toggle("on", set.has(v));
            this.olap();
          } }, v);
          grp.append(b);
        }
        F.append(grp);
      }
      this.olap();
    },
    values(dim) {
      const s = [...new Set(this.rows.map((r) => r[dim]))];
      const o = this.ORDER[dim];
      if (o) return o.filter((x) => s.includes(x));
      if (dim === "month" || dim === "hour" || dim === "year") return s.sort((a, b) => a - b);
      return s.sort();
    },
    rollUp() {
      const last = this.o.drillPath.pop();
      if (last) { this.o.rows = last.dim; }
      this.olap();
    },
    drill(val) {
      const d = this.DIMS[this.o.rows];
      if (!d.drill) return;
      this.o.drillPath.push({ dim: this.o.rows, val });
      this.o.rows = d.drill;
      this.olap();
    },
    olap() {
      const o = this.o;
      let data = this.rows.filter((r) => Object.entries(o.filters).every(([f, set]) => !set.size || set.has(r[f])));
      for (const p of o.drillPath) data = data.filter((r) => String(r[p.dim]) === String(p.val));
      const rowVals = [...new Set(data.map((r) => r[o.rows]))];
      const ord = this.ORDER[o.rows];
      rowVals.sort(ord ? (a, b) => ord.indexOf(a) - ord.indexOf(b) : (o.rows === "road" ? undefined : (a, b) => (isNaN(a) ? String(a).localeCompare(b) : a - b)));
      const colVals = o.cols ? this.values(o.cols).filter((v) => data.some((r) => r[o.cols] === v)) : [];
      const cell = (rs) => {
        if (o.measure === "count") return rs.length;
        if (o.measure === "fatal") return rs.filter((r) => r.severity === "Fatal").length;
        if (o.measure === "killed") return rs.reduce((a, r) => a + +r.killed, 0);
        return rs.length ? Math.round((rs.filter((r) => r.severity === "Fatal").length / rs.length) * 100) : 0;
      };
      const groups = new Map();
      for (const r of data) {
        const k = r[o.rows];
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      let rows = rowVals.map((v) => ({ v, rs: groups.get(v) }));
      if (o.rows === "road") rows = rows.sort((a, b) => b.rs.length - a.rs.length).slice(0, 25);
      const all = rows.flatMap((x) => (o.cols ? colVals.map((c) => cell(x.rs.filter((r) => r[o.cols] === c))) : [cell(x.rs)]));
      const max = Math.max(1, ...all);
      const shade = (n) => `background: rgba(217, 48, 37, ${(0.06 + 0.5 * (n / max)).toFixed(3)})`;
      const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const label = (dim, v) => (dim === "month" ? MONTHS[v] : dim === "hour" ? `${String(v).padStart(2, "0")}:00` : v);
      const canDrill = !!this.DIMS[o.rows].drill;
      const head = el("tr", null, el("th", null, this.DIMS[o.rows].label), ...(o.cols ? colVals.map((c) => el("th", { class: "n" }, label(o.cols, c))) : []), el("th", { class: "n" }, o.cols ? "Total" : $("oMeasure").selectedOptions[0].text));
      const body = rows.map((x) => {
        const cells = o.cols ? colVals.map((c) => { const n = cell(x.rs.filter((r) => r[o.cols] === c)); return el("td", { class: "cell", style: shade(n) }, n); }) : [];
        const tot = cell(x.rs);
        return el("tr", null,
          el("td", { class: "h" }, canDrill ? el("button", { onclick: () => this.drill(x.v), title: "Drill down" }, label(o.rows, x.v), " ›") : label(o.rows, x.v)),
          ...cells, el("td", { class: "cell", style: o.cols ? "" : shade(tot) }, tot));
      });
      const totals = el("tr", { class: "total" }, el("td", null, "Total"), ...(o.cols ? colVals.map((c) => el("td", { class: "cell" }, cell(data.filter((r) => r[o.cols] === c)))) : []), el("td", { class: "cell" }, cell(data)));
      $("oTable").replaceChildren(el("thead", null, head), el("tbody", null, body, totals));
      $("oUp").disabled = !o.drillPath.length;
      $("oCrumbs").textContent = o.drillPath.length ? "Drilled into: " + o.drillPath.map((p) => `${this.DIMS[p.dim].label} = ${label(p.dim, p.val)}`).join(" › ") : "";
    },
  };

  SR.Insights = Insights;
})();
