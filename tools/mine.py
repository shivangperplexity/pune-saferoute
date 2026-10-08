"""
SafeRoute Pune - data mining pipeline.

  1. Pre-processing: derived attributes (time band, season, weekend), integrity checks
  2. Hotspots: DBSCAN (haversine) over crash locations, ranked by a severity index
  3. Risky conditions: Apriori frequent itemsets -> association rules (Severity=Fatal and general)
  4. Risk model: Naive Bayes P(fatal | road type, time band, light, weather, vehicle) for the app's risk meter
  5. OLAP summaries for the report (the website builds its cube live from accidents.csv)

Usage: python3 mine.py data/   -> data/insights.json, prints a summary
"""
import csv, json, math, os, sys, random
from collections import Counter, defaultdict
from itertools import combinations

import numpy as np
from sklearn.cluster import DBSCAN

D = sys.argv[1] if len(sys.argv) > 1 else "data"
rows = list(csv.DictReader(open(os.path.join(D, "accidents.csv"))))
places = json.load(open(os.path.join(D, "places.json")))
spots = json.load(open(os.path.join(D, "accidents_blackspots.json")))
SEV_W = {"Fatal": 5, "Grievous": 3, "Minor": 1}


def time_band(h):
    h = int(h)
    if 6 <= h < 10: return "Morning (6-10)"
    if 10 <= h < 16: return "Midday (10-16)"
    if 16 <= h < 21: return "Evening (16-21)"
    return "Night (21-6)"


def season(m):
    m = int(m)
    return "Monsoon" if m in (6, 7, 8, 9) else ("Winter" if m in (10, 11, 12, 1, 2) else "Summer")


for r in rows:
    r["time_band"] = time_band(r["hour"])
    r["season"] = season(r["month"])
    r["weekend"] = "Weekend" if r["weekday"] in ("Sat", "Sun") else "Weekday"

# ---------------------------------------------------------------- 1. pre-processing report
missing = sum(1 for r in rows for v in r.values() if v in ("", None))
pre = {"records": len(rows), "missing_values": missing, "attributes": len(rows[0]),
       "years": sorted({r["year"] for r in rows}), "fatal": sum(r["severity"] == "Fatal" for r in rows),
       "killed": sum(int(r["killed"]) for r in rows), "injured": sum(int(r["injured"]) for r in rows)}


def hav(a, b):
    R = 6371000.0
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


# ---------------------------------------------------------------- 2. DBSCAN hotspots
X = np.radians(np.array([[float(r["lat"]), float(r["lon"])] for r in rows]))
EPS_M, MIN_PTS = 200, 15
labels = DBSCAN(eps=EPS_M / 6371000.0, min_samples=MIN_PTS, metric="haversine", algorithm="ball_tree").fit_predict(X)
clusters = defaultdict(list)
for r, l in zip(rows, labels):
    if l >= 0:
        clusters[l].append(r)

hot = []
for l, rs in clusters.items():
    lat = sum(float(r["lat"]) for r in rs) / len(rs)
    lon = sum(float(r["lon"]) for r in rs) / len(rs)
    d = sorted(hav((lat, lon), (float(r["lat"]), float(r["lon"]))) for r in rs)
    radius = max(120, min(600, d[int(0.9 * (len(d) - 1))] + 40))
    sev = Counter(r["severity"] for r in rs)
    esi = sum(SEV_W[r["severity"]] for r in rs)
    years = len({r["year"] for r in rs})
    near = min(spots, key=lambda s: hav((lat, lon), (s["lat"], s["lon"])))
    dn = hav((lat, lon), (near["lat"], near["lon"]))
    if dn < 450:
        name, official = near["name"], True
    else:
        p = min(places, key=lambda p: hav((lat, lon), (p[1], p[2])))
        name, official = "Near " + p[0], False
    hot.append({
        "id": int(l), "name": name, "official_blackspot": official, "lat": round(lat, 6), "lon": round(lon, 6),
        "radius_m": round(radius), "accidents": len(rs), "fatal": sev["Fatal"], "grievous": sev["Grievous"], "minor": sev["Minor"],
        "killed": sum(int(r["killed"]) for r in rs), "esi": esi,
        "road": Counter(r["road"] for r in rs).most_common(1)[0][0],
        "road_type": Counter(r["road_type"] for r in rs).most_common(1)[0][0],
        "peak_time": Counter(r["time_band"] for r in rs).most_common(1)[0][0],
        "top_cause": Counter(r["cause"] for r in rs).most_common(1)[0][0],
        "top_vehicle": Counter(r["vehicle"] for r in rs).most_common(1)[0][0],
        "night_share": round(sum(r["time_band"] == "Night (21-6)" for r in rs) / len(rs), 3),
        "years_active": years,
    })
hot.sort(key=lambda h: -h["esi"])
esis = sorted(h["esi"] for h in hot)
t_hi, t_med = esis[int(len(esis) * 0.66)], esis[int(len(esis) * 0.33)]
for i, h in enumerate(hot):
    h["rank"] = i + 1
    h["tier"] = "High" if h["esi"] >= t_hi else ("Medium" if h["esi"] >= t_med else "Low")
    # risk-aware limit cut used by the navigator inside this zone (km/h)
    h["limit_cut"] = {"High": 20, "Medium": 15, "Low": 10}[h["tier"]]
noise = int((labels == -1).sum())
detected = {h["name"] for h in hot if h["official_blackspot"]}
recall = len(detected) / len(spots)

# ---------------------------------------------------------------- 3. Apriori
ATTRS = ["time_band", "light", "weather", "road_type", "location", "vehicle", "cause", "season", "weekend", "severity"]
LABEL = {"time_band": "Time", "light": "Light", "weather": "Weather", "road_type": "Road", "location": "Location",
         "vehicle": "Vehicle", "cause": "Cause", "season": "Season", "weekend": "Day", "severity": "Severity"}
T = [frozenset(f"{LABEL[a]}={r[a]}" for a in ATTRS) for r in rows]
N = len(T)
MIN_SUP = 0.02


def apriori(T, min_sup):
    counts = Counter(i for t in T for i in t)
    L = {frozenset([i]): c for i, c in counts.items() if c / N >= min_sup}
    allL = dict(L)
    k = 2
    while L:
        items = sorted({i for s in L for i in s})
        prev = list(L)
        cands = set()
        for a, b in combinations(prev, 2):
            u = a | b
            if len(u) == k and all(frozenset(c) in L for c in combinations(u, k - 1)):
                # one item per attribute
                if len({x.split("=")[0] for x in u}) == k:
                    cands.add(u)
        cnt = Counter()
        for t in T:
            for c in cands:
                if c <= t:
                    cnt[c] += 1
        L = {c: v for c, v in cnt.items() if v / N >= min_sup}
        allL.update(L)
        k += 1
        if k > 4:
            break
    return allL


freq = apriori(T, MIN_SUP)
rules = []
for s, c in freq.items():
    if len(s) < 2:
        continue
    for cons in s:
        ante = s - {cons}
        conf = c / freq[ante]
        sup_c = freq[frozenset([cons])] / N
        lift = conf / sup_c
        rules.append({"if": sorted(ante), "then": cons, "support": round(c / N, 4), "confidence": round(conf, 3),
                      "lift": round(lift, 2), "count": c})
fatal_rules = sorted([r for r in rules if r["then"] == "Severity=Fatal" and r["confidence"] >= 0.45 and r["lift"] >= 1.3],
                     key=lambda r: (-r["lift"], -r["support"]))
def attrs(r):
    return {x.split("=")[0] for x in r["if"]} | {r["then"].split("=")[0]}
# general "risky condition" patterns; Light<->Time and Light<->Road pairs are excluded (true by definition)
other = [r for r in rules if r["then"].split("=")[0] in ("Cause", "Vehicle", "Location", "Weather")
         and "Severity" not in attrs(r) and not {"Light", "Time"} <= attrs(r) and not {"Season", "Weather"} <= attrs(r)
         and r["lift"] >= 1.4 and r["confidence"] >= 0.3]
other.sort(key=lambda r: (-r["lift"], -r["support"]))


# prune redundant rules (a superset rule must beat its subset's confidence)
def prune(rs, top):
    out = []
    for r in rs:
        if any(set(o["if"]) <= set(r["if"]) and o["then"] == r["then"] and o["confidence"] >= r["confidence"] - 0.02 for o in out):
            continue
        out.append(r)
        if len(out) >= top:
            break
    return out


fatal_rules = prune(fatal_rules, 15)
other = prune(other, 15)

# ---------------------------------------------------------------- 4. Naive Bayes risk model
FEATS = ["road_type", "time_band", "light", "weather", "vehicle"]
random.Random(7).shuffle(idx := list(range(N)))
cut = int(N * 0.8)
train = [rows[i] for i in idx[:cut]]
test = [rows[i] for i in idx[cut:]]


def fit_nb(data):
    prior = Counter(r["severity"] == "Fatal" for r in data)
    cond = {f: defaultdict(Counter) for f in FEATS}
    vals = {f: sorted({r[f] for r in rows}) for f in FEATS}
    for r in data:
        y = r["severity"] == "Fatal"
        for f in FEATS:
            cond[f][y][r[f]] += 1
    model = {"prior": {"fatal": prior[True] / len(data)}, "cpt": {}}
    for f in FEATS:
        model["cpt"][f] = {}
        for v in vals[f]:
            p1 = (cond[f][True][v] + 1) / (prior[True] + len(vals[f]))
            p0 = (cond[f][False][v] + 1) / (prior[False] + len(vals[f]))
            model["cpt"][f][v] = [round(p1, 5), round(p0, 5)]
    return model


def nb_prob(m, r):
    l1 = math.log(m["prior"]["fatal"]); l0 = math.log(1 - m["prior"]["fatal"])
    for f in FEATS:
        p1, p0 = m["cpt"][f][r[f]]
        l1 += math.log(p1); l0 += math.log(p0)
    return 1 / (1 + math.exp(l0 - l1))


nb = fit_nb(train)
probs = [nb_prob(nb, r) for r in test]
ys = [r["severity"] == "Fatal" for r in test]
thr = 0.4
tp = sum(p >= thr and y for p, y in zip(probs, ys)); fp = sum(p >= thr and not y for p, y in zip(probs, ys))
fn = sum(p < thr and y for p, y in zip(probs, ys)); tn = sum(p < thr and not y for p, y in zip(probs, ys))
# AUC
pos = [p for p, y in zip(probs, ys) if y]; neg = [p for p, y in zip(probs, ys) if not y]
auc = sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg))
nb_eval = {"test_size": len(test), "threshold": thr, "accuracy": round((tp + tn) / len(test), 3),
           "precision": round(tp / max(1, tp + fp), 3), "recall": round(tp / max(1, tp + fn), 3), "auc": round(auc, 3),
           "confusion": {"tp": tp, "fp": fp, "fn": fn, "tn": tn}, "baseline_fatal_rate": round(sum(ys) / len(ys), 3)}
nb_full = fit_nb(rows)

# ---------------------------------------------------------------- 5. OLAP summaries
def cube(*dims):
    c = Counter(tuple(r[d] for d in dims) for r in rows)
    return [{"key": list(k), "accidents": v} for k, v in sorted(c.items())]

olap = {
    "by_year": cube("year"),
    "by_time_band": cube("time_band"),
    "by_road_type_severity": cube("road_type", "severity"),
    "by_season_weather": cube("season", "weather"),
    "by_vehicle": cube("vehicle"),
}

out = {"preprocessing": pre,
       "dbscan": {"eps_m": EPS_M, "min_pts": MIN_PTS, "clusters": len(hot), "noise_points": noise,
                  "clustered_share": round(1 - noise / N, 3), "official_spots": len(spots),
                  "official_detected": len(detected), "recall": round(recall, 3)},
       "hotspots": hot,
       "apriori": {"min_support": MIN_SUP, "frequent_itemsets": len(freq), "rules_total": len(rules),
                   "fatal_rules": fatal_rules, "other_rules": other},
       "naive_bayes": {"features": FEATS, "eval": nb_eval, "model": nb_full},
       "olap": olap}
json.dump(out, open(os.path.join(D, "insights.json"), "w"), indent=1)

print(json.dumps(pre))
print("DBSCAN:", json.dumps(out["dbscan"]))
for h in hot[:12]:
    print(f"  #{h['rank']:2d} {h['tier']:6s} {h['name'][:34]:34s} acc={h['accidents']:3d} fatal={h['fatal']:3d} esi={h['esi']:4d} r={h['radius_m']}m {h['peak_time']}")
print("missed official:", sorted({s['name'] for s in spots} - detected))
print("Apriori: itemsets", len(freq), "rules", len(rules))
for r in fatal_rules[:8]:
    print("  ", " & ".join(r["if"]), "=>", r["then"], "sup", r["support"], "conf", r["confidence"], "lift", r["lift"])
for r in other[:6]:
    print("  ", " & ".join(r["if"]), "=>", r["then"], "sup", r["support"], "conf", r["confidence"], "lift", r["lift"])
print("NB:", nb_eval)
