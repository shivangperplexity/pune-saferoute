# SafeRoute Pune

SafeRoute Pune is a navigation website for Pune that knows where accidents happen.

- **Directions:** type a destination and get turn-by-turn directions (Fastest or Safest route).
- **Speed limits:** every road shows its speed limit. On accident hotspots the limit drops, and it drops more at night and in rain or fog.
- **Warnings:** you get a voice and on-screen warning before every hotspot, and when you go over the limit.
- **Bike simulator:** practise a route on a simulated bike. You control the throttle, brake and auto-ride, at 1×, 3× or 8× speed, and get a safety score at the end.
- **Insights:** see the hotspot ranking, risky-condition rules, a "how deadly is this situation?" checker, and a pivot-table (OLAP) explorer.

Everything runs in the browser. The Pune road network is bundled with the site, so routing works even if the map tiles fail to load.

**Live:** https://pune-saferoute.vercel.app

## Data-mining parts (DMA syllabus)

| Technique | Where it is used |
|---|---|
| **Pre-processing** | Derived attributes (time band, season, weekend), integrity checks, and transactions for Apriori (`tools/mine.py`) |
| **Clustering: DBSCAN** (haversine, eps = 200 m, minPts = 15) | Finds accident hotspots. Each hotspot is ranked by a severity index (fatal × 5 + grievous × 3 + minor). 24 hotspots were found, matching 24 of 25 police black spots. |
| **Association rules: Apriori** (min support 2 %) | Finds which conditions make a crash deadlier. For example, two-wheelers on unlit highways at night are fatal in 67 % of crashes, 2.1× the average (lift). |
| **Classification: Naive Bayes** | Predicts the chance that a crash is fatal for a given road, time, light, weather and vehicle. Used by the route risk meter and the situation checker. |
| **OLAP** | A cube over year›month, time›hour, road type›road, severity, vehicle, cause, weather and more. Supports roll-up, drill-down, slice/dice filters and pivot. |
| **Graph search: A\*** | Fastest route by travel time. The Safest route adds a penalty for edges inside hotspots. |

## Data

- **Roads and places:** © OpenStreetMap contributors (ODbL).
  - Downloaded with the Overpass API by the GitHub Action `.github/workflows/osm-data.yml`.
  - Compacted by `tools/build_graph.py` into 91k junctions and 112k road segments, with road class, name, one-way and speed limit.
  - Speed limits come from OSM `maxspeed` tags where present. Otherwise they are urban defaults by road class.
- **Accidents (`data/accidents.csv`, 3,936 records, 2019–2023):**
  - Pune has no public record-level crash file with coordinates. `tools/make_accidents.py` therefore builds a calibrated dataset, with every record placed on a real OSM road.
  - It is based on the Pune police/PMC black-spot lists (21 spots and 19 spots), the Navale Bridge figures (257 accidents and 115 deaths in five years), Pune's 2021 total (741 accidents, 255 deaths) and MoRTH *Road Accidents in India 2022* shares for time of day, vehicle, cause and weather.

## Run locally

```bash
python3 -m http.server 8000      # then open http://localhost:8000
```

To rebuild the data:

```bash
python3 tools/make_accidents.py data/graph.json data/accidents.csv
python3 tools/mine.py data        # writes data/insights.json
```

## Files

| Path | Purpose |
|---|---|
| `index.html`, `css/app.css` | The page layout and styles |
| `js/graph.js` | Road graph, nearest-road snapping, A\* routing, turn-by-turn steps |
| `js/risk.js` | Hotspot zones, risk-aware speed limits, Naive Bayes risk |
| `js/nav.js` | GPS navigation and bike simulator, voice warnings, trip score |
| `js/insights.js` | Hotspot table, rules, risk checker, OLAP explorer |
| `js/app.js` | Map, search, layers and UI wiring |
| `tools/` | Data pipeline (OSM graph, accident dataset, mining) |
