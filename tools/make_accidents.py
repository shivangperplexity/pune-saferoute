"""
Build the SafeRoute Pune accident dataset (2019-2023).

Pune has no public record-level crash file with coordinates, so this script produces
a realistic dataset calibrated to published figures:
  * Pune Police / PMC black-spot lists (21 spots, mypunepulse.com; 19 spots, punekarnews.in, Jan 2022)
  * Navale Bridge stretch: 257 accidents and 115 deaths in five years (punekarnews.in, Nov 2025)
  * Pune city 2021: 741 accidents, 255 deaths (Pune traffic police via punekarnews.in)
  * MoRTH "Road Accidents in India 2022" national shares for time of day, vehicle type,
    cause and weather.
Every record is placed on a real OpenStreetMap road from data/graph.json.

Usage: python3 make_accidents.py data/graph.json data/accidents.csv
"""
import csv, json, math, random, sys
from collections import defaultdict

rng = random.Random(411001)  # Pune PIN code as seed

# name, lat, lon, five-year accidents (reported incl. minor), stretch type
BLACK_SPOTS = [
    ("Navale Bridge", 18.4600, 73.8231, 150, "slope"),
    ("Navale Bridge Selfie Point", 18.4535, 73.8275, 60, "slope"),
    ("New Katraj Tunnel Road", 18.4300, 73.8400, 70, "slope"),
    ("Dari Pul (Narhe)", 18.4445, 73.8366, 45, "bridge"),
    ("Katraj Chowk", 18.4552, 73.8580, 55, "junction"),
    ("Mai Mangeshkar Hospital, Warje", 18.4852, 73.7997, 35, "junction"),
    ("Mutha River Bridge, Warje", 18.4950, 73.7880, 40, "bridge"),
    ("Dukkar Khind", 18.5005, 73.7930, 45, "slope"),
    ("Chandani Chowk", 18.5076, 73.7867, 40, "junction"),
    ("Bhumkar Chowk, Wakad", 18.6054, 73.7522, 50, "junction"),
    ("Nashik Phata", 18.6093, 73.8201, 35, "junction"),
    ("Vaiduwadi Chowk, Hadapsar", 18.5040, 73.9180, 30, "junction"),
    ("Ravidarshan Chowk, Hadapsar", 18.4990, 73.9370, 30, "junction"),
    ("Saswad Road near IBM, Hadapsar", 18.4960, 73.9430, 30, "midblock"),
    ("Phursungi Phata", 18.4890, 73.9560, 35, "junction"),
    ("Palkhi Visava, Wadki", 18.4420, 73.9720, 25, "midblock"),
    ("Kadamwak Vasti, Loni Kalbhor", 18.4930, 73.9990, 35, "midblock"),
    ("Loni Station Chowk", 18.4895, 74.0150, 30, "junction"),
    ("Mundhwa Railway Bridge", 18.5330, 73.9290, 25, "bridge"),
    ("Kharadi Bypass Chowk", 18.5497, 73.9369, 40, "junction"),
    ("Kharadi Jakat Naka", 18.5580, 73.9440, 25, "junction"),
    ("Tata Guard Room, Chandan Nagar", 18.5610, 73.9330, 30, "junction"),
    ("Reliance Mart, Chandan Nagar", 18.5640, 73.9345, 25, "midblock"),
    ("Viman Nagar Chowk", 18.5660, 73.9130, 30, "junction"),
    ("Airport Chowk", 18.5800, 73.9110, 25, "junction"),
]
YEAR_COUNTS = {2019: 820, 2020: 610, 2021: 741, 2022: 860, 2023: 905}  # city total per year
CLASS_RISK = {0: 4.0, 1: 6.0, 2: 4.0, 3: 3.0, 4: 2.0, 5: 1.0, 6: 0.35, 7: 0.1}
ROAD_TYPE = {0: "Highway", 1: "Highway", 2: "Arterial", 3: "Arterial", 4: "Collector", 5: "Collector", 6: "Local", 7: "Local"}


def load_graph(path):
    G = json.load(open(path))
    q = G["q"]
    V = G["v"]
    verts = [(V[i] / q, V[i + 1] / q) for i in range(0, len(V), 2)]
    E = G["e"]
    edges = []
    deg = defaultdict(int)
    for k in range(0, len(E), 7):
        a, b, L, cls, lim, nm, ow = E[k:k + 7]
        gi = k // 7
        pts = [verts[a]]
        la, lo = V[2 * a], V[2 * a + 1]
        g = G["g"][gi]
        for j in range(0, len(g), 2):
            la += g[j]; lo += g[j + 1]
            pts.append((la / q, lo / q))
        pts.append(verts[b])
        edges.append({"a": a, "b": b, "len": L, "cls": cls, "lim": lim, "name": G["names"][nm], "pts": pts})
        deg[a] += 1; deg[b] += 1
    return verts, edges, deg


def hav(a, b):
    R = 6371000.0
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


class SegIndex:
    """grid index over road segments for nearest-road snapping"""
    def __init__(self, edges, maxcls=7, cell=0.004):
        self.cell = cell
        self.grid = defaultdict(list)
        for ei, e in enumerate(edges):
            if e["cls"] > maxcls:
                continue
            p = e["pts"]
            for s in range(len(p) - 1):
                la, lo = (p[s][0] + p[s + 1][0]) / 2, (p[s][1] + p[s + 1][1]) / 2
                self.grid[(int(la / cell), int(lo / cell))].append((ei, s))
        self.edges = edges

    def nearest(self, pt, rings=2):
        best = (1e18, None, None, None)
        ci, cj = int(pt[0] / self.cell), int(pt[1] / self.cell)
        coslat = math.cos(math.radians(pt[0]))
        for di in range(-rings, rings + 1):
            for dj in range(-rings, rings + 1):
                for ei, s in self.grid.get((ci + di, cj + dj), ()):
                    p = self.edges[ei]["pts"]
                    ax, ay = p[s][1] * coslat, p[s][0]
                    bx, by = p[s + 1][1] * coslat, p[s + 1][0]
                    px, py = pt[1] * coslat, pt[0]
                    dx, dy = bx - ax, by - ay
                    t = 0 if dx == dy == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
                    qx, qy = ax + t * dx, ay + t * dy
                    d = (qx - px) ** 2 + (qy - py) ** 2
                    if d < best[0]:
                        best = (d, ei, (qy, qx / coslat), s)
        if best[1] is None:
            return None
        return best[1], best[2], hav(pt, best[2])


def pick(weights):
    r = rng.random() * sum(weights.values())
    for k, w in weights.items():
        r -= w
        if r <= 0:
            return k
    return k


def hour_sample(night_bias=1.0):
    # MoRTH 2022 shares by 3-hour band (00-03 ... 21-24)
    bands = {0: 5.5, 3: 4.5, 6: 9.0, 9: 13.0, 12: 15.5, 15: 17.5, 18: 21.0, 21: 14.0}
    for b in (0, 3, 21):
        bands[b] *= night_bias
    b = pick(bands)
    return b + rng.randrange(3), rng.randrange(60)


def main(graph_path, out_path):
    verts, edges, deg = load_graph(graph_path)
    major = SegIndex(edges, maxcls=4)
    trunk = SegIndex(edges, maxcls=1)
    BYPASS = {"Navale Bridge", "Navale Bridge Selfie Point", "New Katraj Tunnel Road", "Dari Pul (Narhe)",
              "Mutha River Bridge, Warje", "Dukkar Khind"}  # all on the NH-48 Katraj-Dehu Road bypass
    allroads = SegIndex(edges, maxcls=7)

    # snap the black spots to the nearest major road
    spots = []
    for name, la, lo, n, kind in BLACK_SPOTS:
        hit = (trunk if name in BYPASS else major).nearest((la, lo), rings=3)
        if not hit or hit[2] > 900:
            print("skip", name, hit and round(hit[2]))
            continue
        ei, p, d = hit
        spots.append({"name": name, "lat": p[0], "lon": p[1], "n": n, "kind": kind, "edge": ei})
        print(f"{name:34s} snapped {d:5.0f} m -> {edges[ei]['name'] or '(unnamed)'}")

    # background sampling weights
    cum, tot = [], 0.0
    for e in edges:
        tot += e["len"] * CLASS_RISK[e["cls"]]
        cum.append(tot)

    def sample_edge_point():
        import bisect
        ei = bisect.bisect_left(cum, rng.random() * tot)
        e = edges[ei]
        p = e["pts"]
        s = rng.randrange(len(p) - 1)
        t = rng.random()
        return ei, (p[s][0] + t * (p[s + 1][0] - p[s][0]), p[s][1] + t * (p[s + 1][1] - p[s][1]))

    spot_total = sum(s["n"] for s in spots)
    total = sum(YEAR_COUNTS.values())
    years = []
    for y, c in YEAR_COUNTS.items():
        years += [y] * c
    rng.shuffle(years)

    rows = []
    for i, year in enumerate(years):
        spot = None
        if i < spot_total:
            # allocate black-spot accidents proportionally
            r = rng.random() * spot_total
            for s in spots:
                r -= s["n"]
                if r <= 0:
                    spot = s
                    break
            for _ in range(6):
                dlat = rng.gauss(0, 110) / 111000
                dlon = rng.gauss(0, 110) / (111000 * math.cos(math.radians(spot["lat"])))
                hit = (trunk if spot["name"] in BYPASS else major).nearest((spot["lat"] + dlat, spot["lon"] + dlon))
                if hit and hit[2] < 120:
                    ei, pt, _ = hit
                    break
            else:
                ei, pt = spot["edge"], (spot["lat"], spot["lon"])
        else:
            ei, pt = sample_edge_point()
        e = edges[ei]
        rt = ROAD_TYPE[e["cls"]]
        slope = spot is not None and spot["kind"] == "slope"

        month = pick({1: 8.6, 2: 8.0, 3: 8.4, 4: 8.2, 5: 8.6, 6: 8.8, 7: 9.4, 8: 9.0, 9: 8.6, 10: 7.8, 11: 7.4, 12: 8.2})
        day = rng.randrange(1, 29)
        hr, mi = hour_sample(1.6 if rt == "Highway" else 1.0)
        dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][(year * 365 + month * 31 + day) % 7]

        if month in (6, 7, 8, 9):
            weather = pick({"Clear": 48, "Rain": 38, "Cloudy": 14})
        elif month in (12, 1) and hr < 9:
            weather = pick({"Clear": 70, "Mist/Fog": 22, "Cloudy": 8})
        else:
            weather = pick({"Clear": 86, "Cloudy": 12, "Rain": 2})
        if 7 <= hr < 18:
            light = "Daylight"
        elif hr in (18, 6):
            light = "Dusk/Dawn"
        else:
            light = "Dark - unlit" if (rt == "Highway" or slope or rng.random() < 0.25) else "Dark - lit"

        if rt == "Highway" or slope:
            veh = pick({"Two-wheeler": 34, "Car": 20, "Truck/Tempo": 26, "Bus": 5, "Auto-rickshaw": 3, "Pedestrian": 9, "Bicycle": 3})
        elif rt == "Local":
            veh = pick({"Two-wheeler": 52, "Car": 14, "Truck/Tempo": 3, "Bus": 2, "Auto-rickshaw": 9, "Pedestrian": 16, "Bicycle": 4})
        else:
            veh = pick({"Two-wheeler": 47, "Car": 18, "Truck/Tempo": 9, "Bus": 5, "Auto-rickshaw": 7, "Pedestrian": 11, "Bicycle": 3})

        cause_w = {"Over-speeding": 55, "Rash/careless driving": 14, "Wrong-side driving": 7, "Drunk driving": 3,
                   "Signal jumping": 4, "Brake failure/vehicle defect": 3, "Pothole/road condition": 5, "Mobile phone use": 3, "Other": 6}
        if slope and veh in ("Truck/Tempo", "Bus"):
            cause_w["Brake failure/vehicle defect"] = 45
        if weather == "Rain":
            cause_w["Pothole/road condition"] = 16
        if hr >= 22 or hr < 4:
            cause_w["Drunk driving"] = 12
        if rt == "Arterial" and spot and spot["kind"] == "junction":
            cause_w["Signal jumping"] = 12
        cause = pick(cause_w)

        # severity: logistic model calibrated to roughly 30 % fatal (Pune 2021: 255 deaths / 741 accidents)
        z = -1.7
        z += {"Highway": 0.75, "Arterial": 0.15, "Collector": -0.2, "Local": -0.7}[rt]
        z += {"Daylight": 0, "Dusk/Dawn": 0.25, "Dark - lit": 0.35, "Dark - unlit": 0.9}[light]
        z += {"Two-wheeler": 0.35, "Pedestrian": 0.7, "Bicycle": 0.3, "Car": -0.45, "Bus": -0.3, "Truck/Tempo": 0.1, "Auto-rickshaw": -0.4}[veh]
        z += {"Over-speeding": 0.45, "Drunk driving": 0.8, "Brake failure/vehicle defect": 0.9, "Wrong-side driving": 0.35}.get(cause, -0.2)
        z += 0.5 if slope else 0
        z += -0.15 if weather == "Rain" else 0
        pf = 1 / (1 + math.exp(-z))
        r = rng.random()
        if r < pf:
            sev = "Fatal"
        elif r < pf + (1 - pf) * 0.55:
            sev = "Grievous"
        else:
            sev = "Minor"
        killed = (1 + (rng.random() < 0.12) + (veh in ("Bus", "Truck/Tempo") and rng.random() < 0.15)) if sev == "Fatal" else 0
        injured = (rng.randint(1, 3) if sev != "Minor" else rng.randint(0, 2)) if sev != "Fatal" else rng.randint(0, 2)

        near_junc = deg[e["a"]] >= 3 and hav(pt, verts[e["a"]]) < 40 or deg[e["b"]] >= 3 and hav(pt, verts[e["b"]]) < 40
        loc = "Junction" if near_junc or (spot and spot["kind"] == "junction") else ("Bridge/Slope" if spot and spot["kind"] in ("slope", "bridge") else "Mid-block")

        rows.append({
            "id": f"PN{year}{i:05d}", "date": f"{year}-{month:02d}-{day:02d}", "year": year, "month": month, "weekday": dow,
            "hour": hr, "time": f"{hr:02d}:{mi:02d}", "lat": round(pt[0], 6), "lon": round(pt[1], 6),
            "road": e["name"] or "(unnamed road)", "road_type": rt, "speed_limit": e["lim"], "location": loc,
            "weather": weather, "light": light, "vehicle": veh, "cause": cause, "severity": sev,
            "killed": killed, "injured": injured,
        })

    rows.sort(key=lambda r: (r["date"], r["time"]))
    with open(out_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    fat = sum(r["severity"] == "Fatal" for r in rows)
    print(f"wrote {len(rows)} accidents ({fat} fatal, {sum(r['killed'] for r in rows)} killed) -> {out_path}")
    with open(out_path.replace(".csv", "_blackspots.json"), "w") as f:
        json.dump([{k: s[k] for k in ("name", "lat", "lon", "n", "kind")} for s in spots], f, indent=1)


if __name__ == "__main__":
    main(*sys.argv[1:3])
