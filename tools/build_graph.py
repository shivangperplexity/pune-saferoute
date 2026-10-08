"""
Build SafeRoute's offline road graph + place index for Pune from OpenStreetMap.

Input : roads.json  (Overpass: highway ways in Pune bbox, `out body; >; out skel qt;`)
        places.json (Overpass: named places / POIs, `out center tags;`)
Output: data/graph.json  - compact routable graph with road class, name, speed limit, geometry
        data/places.json - search index [name, lat, lon, kind]

Usage: python3 build_graph.py roads.json places.json outdir
"""
import json, math, sys, os, re
from collections import defaultdict

CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street"]
# default urban speed limits (km/h) used when OSM has no maxspeed tag
# (Maharashtra / Pune Traffic Police practice: city arterials 50, highways through the city 60-80)
DEFAULT_LIMIT = {"motorway": 80, "trunk": 60, "primary": 50, "secondary": 50, "tertiary": 40,
                 "unclassified": 30, "residential": 30, "living_street": 20}
Q = 1e5  # coordinate quantisation (~1.1 m)


def hav(a, b):
    R = 6371000.0
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def dp(pts, eps=4.0):
    """Douglas-Peucker simplification in metres (local equirectangular)."""
    if len(pts) < 3:
        return pts
    lat0 = math.radians(pts[0][0])
    xy = [(p[1] * 111320 * math.cos(lat0), p[0] * 110540) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = xy[i], xy[j]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy) or 1e-9
        best, bi = 0, -1
        for k in range(i + 1, j):
            d = abs(dy * (xy[k][0] - x1) - dx * (xy[k][1] - y1)) / L
            if d > best:
                best, bi = d, k
        if best > eps:
            keep[bi] = True
            stack += [(i, bi), (bi, j)]
    return [p for p, k in zip(pts, keep) if k]


def parse_speed(v):
    if not v:
        return None
    m = re.match(r"\s*(\d+)", v)
    if not m:
        return None
    s = int(m.group(1))
    if "mph" in v:
        s = round(s * 1.609)
    return s if 5 <= s <= 120 else None


def main(roads_path, places_path, out):
    os.makedirs(out, exist_ok=True)
    raw = json.load(open(roads_path))
    coord = {}
    ways = []
    for el in raw["elements"]:
        if el["type"] == "node":
            coord[el["id"]] = (el["lat"], el["lon"])
        elif el["type"] == "way":
            ways.append(el)
    print("nodes", len(coord), "ways", len(ways))

    use = defaultdict(int)
    for w in ways:
        nd = w["nodes"]
        for n in nd:
            use[n] += 1
        use[nd[0]] += 1
        use[nd[-1]] += 1

    names, name_ix = [], {}
    def nid(s):
        if s not in name_ix:
            name_ix[s] = len(names)
            names.append(s)
        return name_ix[s]
    nid("")

    vid = {}
    verts = []
    def V(n):
        if n not in vid:
            vid[n] = len(verts)
            verts.append(coord[n])
        return vid[n]

    edges = []  # [a, b, lenm, cls, limit, name, oneway, geom(list of (lat,lon) incl ends)]
    stats = defaultdict(float)
    tagged = 0
    for w in ways:
        t = w.get("tags", {})
        hw = t.get("highway", "")
        base = hw.replace("_link", "")
        if base not in CLASSES:
            continue
        cls = CLASSES.index(base)
        lim = parse_speed(t.get("maxspeed"))
        if lim:
            tagged += 1
        else:
            lim = DEFAULT_LIMIT[base] if not hw.endswith("_link") else min(40, DEFAULT_LIMIT[base])
        nm = t.get("name") or t.get("name:en") or t.get("ref") or ""
        ow = t.get("oneway", "no")
        oneway = 1 if ow in ("yes", "true", "1") or t.get("junction") == "roundabout" or base == "motorway" else (-1 if ow == "-1" else 0)
        nd = [n for n in w["nodes"] if n in coord]
        if len(nd) < 2:
            continue
        seg = [nd[0]]
        for n in nd[1:]:
            seg.append(n)
            if use[n] > 1 or n == nd[-1]:
                pts = [coord[x] for x in seg]
                L = sum(hav(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
                if L > 0.5:
                    edges.append([V(seg[0]), V(seg[-1]), L, cls, lim, nid(nm), oneway, dp(pts)])
                    stats[base] += L
                seg = [n]
    print("vertices", len(verts), "edges", len(edges), "maxspeed-tagged ways", tagged)
    print({k: round(v / 1000) for k, v in stats.items()}, "km")

    # keep the largest weakly-connected component
    adj = defaultdict(list)
    for i, e in enumerate(edges):
        adj[e[0]].append(e[1]); adj[e[1]].append(e[0])
    comp = [-1] * len(verts)
    best, bestc = 0, -1
    c = 0
    for s in range(len(verts)):
        if comp[s] != -1:
            continue
        stack, size = [s], 0
        comp[s] = c
        while stack:
            u = stack.pop(); size += 1
            for v in adj[u]:
                if comp[v] == -1:
                    comp[v] = c; stack.append(v)
        if size > best:
            best, bestc = size, c
        c += 1
    keepv = [comp[i] == bestc for i in range(len(verts))]
    remap, nv = {}, []
    for i, k in enumerate(keepv):
        if k:
            remap[i] = len(nv); nv.append(verts[i])
    edges = [e for e in edges if keepv[e[0]] and keepv[e[1]]]
    for e in edges:
        e[0], e[1] = remap[e[0]], remap[e[1]]
    print("largest component:", len(nv), "vertices", len(edges), "edges")

    # compact encoding
    V_out = []
    for la, lo in nv:
        V_out += [round(la * Q), round(lo * Q)]
    E_out = []
    G_out = []
    for a, b, L, cls, lim, nm, ow, geom in edges:
        E_out += [a, b, round(L), cls, lim, nm, ow]
        inner = geom[1:-1]
        prev = (round(geom[0][0] * Q), round(geom[0][1] * Q))
        g = []
        for la, lo in inner:
            q = (round(la * Q), round(lo * Q))
            g += [q[0] - prev[0], q[1] - prev[1]]
            prev = q
        G_out.append(g)
    graph = {"q": Q, "classes": CLASSES, "v": V_out, "e": E_out, "g": G_out, "names": names,
             "source": "OpenStreetMap contributors (ODbL), extracted via Overpass API"}
    with open(os.path.join(out, "graph.json"), "w") as f:
        json.dump(graph, f, separators=(",", ":"))

    # ---- places index
    P = json.load(open(places_path))
    seen, rows = set(), []
    for el in P["elements"]:
        t = el.get("tags", {})
        nm = t.get("name:en") or t.get("name")
        if not nm or not re.search(r"[A-Za-z]", nm):
            continue
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None:
            continue
        kind = t.get("place") or t.get("amenity") or ("station" if t.get("railway") else None) or t.get("shop") or t.get("tourism") or ("airport" if t.get("aeroway") else None) or t.get("leisure") or ("IT park" if t.get("office") else None) or t.get("landuse") or ""
        key = (nm.lower(), round(lat, 3), round(lon, 3))
        if key in seen:
            continue
        seen.add(key)
        rows.append([nm, round(lat, 5), round(lon, 5), kind])
    with open(os.path.join(out, "places.json"), "w") as f:
        json.dump(rows, f, separators=(",", ":"), ensure_ascii=False)
    for fn in ("graph.json", "places.json"):
        p = os.path.join(out, fn)
        print(fn, os.path.getsize(p) // 1024, "KB")
    print("places", len(rows))


if __name__ == "__main__":
    main(*sys.argv[1:4])
