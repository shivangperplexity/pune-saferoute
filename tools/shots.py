"""Capture SafeRoute screenshots (used for the project report).
Usage: python3 tools/shots.py https://pune-saferoute.vercel.app screenshots/"""
import asyncio, os, sys
from playwright.async_api import async_playwright

URL = sys.argv[1].rstrip("/") + "/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "screenshots"
os.makedirs(OUT, exist_ok=True)


async def settle(pg, ms=2500):
    try:
        await pg.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass
    await pg.wait_for_timeout(ms)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 880}, timezone_id="Asia/Kolkata",
                                  geolocation={"latitude": 18.4520, "longitude": 73.8575}, permissions=["geolocation"])
        pg = await ctx.new_page()
        log = []
        pg.on("pageerror", lambda e: log.append("pageerror " + str(e)))
        await pg.goto(URL)
        await pg.wait_for_selector("#loading", state="hidden", timeout=90000)
        await pg.select_option("#selWeather", "Clear")
        await pg.select_option("#selTime", "day")
        await settle(pg)
        await pg.screenshot(path=f"{OUT}/01_home.png")
        await pg.click("[data-demo=katraj]")
        await pg.wait_for_selector("#result:not([hidden])")
        await settle(pg)
        await pg.screenshot(path=f"{OUT}/02_route_fastest.png")
        await pg.click("#modeSeg [data-mode=safe]")
        await settle(pg, 1500)
        await pg.screenshot(path=f"{OUT}/03_route_safest.png")
        await pg.click("#modeSeg [data-mode=fast]")
        await pg.click("details.steps-box summary")
        await pg.wait_for_timeout(500)
        await pg.evaluate("document.getElementById('result').scrollTop = 10000")
        await pg.screenshot(path=f"{OUT}/04_directions.png")
        await pg.select_option("#selTime", "night")
        await pg.select_option("#selWeather", "Rain")
        await settle(pg, 1200)
        await pg.evaluate("document.getElementById('result').scrollTop = 0")
        await pg.screenshot(path=f"{OUT}/05_night_rain_limits.png")
        await pg.select_option("#selTime", "day")
        await pg.select_option("#selWeather", "Clear")
        await pg.wait_for_timeout(600)

        # bike simulator: approach Navale Bridge too fast
        await pg.click("#btnSim")
        await pg.wait_for_timeout(1000)
        await pg.click("#speedSeg [data-x='8']")
        await pg.fill("#throttle", "70"); await pg.dispatch_event("#throttle", "input")
        shots = {"ahead": False, "in": False}
        for _ in range(400):
            await pg.wait_for_timeout(250)
            st = await pg.evaluate("() => { const w = document.getElementById('warn'); return w.hidden ? '' : w.className + '|' + document.getElementById('warnTitle').textContent }")
            if not shots["ahead"] and "Hotspot in" in st and "Navale" in st:
                await pg.click("#speedSeg [data-x='1']"); await settle(pg, 1200)
                await pg.screenshot(path=f"{OUT}/06_sim_hotspot_ahead.png"); shots["ahead"] = True
                await pg.click("#speedSeg [data-x='3']")
            if shots["ahead"] and not shots["in"] and "hotspot: Navale" in st:
                await pg.click("#speedSeg [data-x='1']"); await settle(pg, 1200)
                await pg.screenshot(path=f"{OUT}/07_sim_in_hotspot_overspeed.png"); shots["in"] = True
                break
        await pg.click("#btnAuto")
        await pg.click("#speedSeg [data-x='8']")
        await pg.wait_for_timeout(5000)
        await pg.click("#speedSeg [data-x='1']"); await settle(pg, 1200)
        await pg.screenshot(path=f"{OUT}/08_sim_autoride.png")
        await pg.click("#speedSeg [data-x='8']")
        for _ in range(600):
            await pg.wait_for_timeout(500)
            if not await pg.evaluate("document.getElementById('tripModal').hidden"):
                break
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=f"{OUT}/09_trip_summary.png")
        await pg.click("#tripModal [data-close]")

        # layers
        await pg.check("#layCrash")
        await pg.evaluate("void SR.app.map.setView([18.50, 73.86], 12)")
        await settle(pg)
        await pg.screenshot(path=f"{OUT}/10_crash_points.png")
        await pg.uncheck("#layCrash")
        await pg.evaluate("void SR.app.map.setView([18.4601, 73.8232], 16)")
        await settle(pg)
        await pg.click("#btnInsights"); await pg.wait_for_timeout(300)
        await pg.click("#hotTable .link >> nth=0"); await settle(pg)
        await pg.screenshot(path=f"{OUT}/11_hotspot_popup.png")

        # insights
        await pg.click("#btnInsights"); await pg.wait_for_timeout(600)
        await pg.screenshot(path=f"{OUT}/12_insights_hotspots.png")
        await pg.click("#insTabs [data-tab=rules]"); await pg.wait_for_timeout(500)
        await pg.screenshot(path=f"{OUT}/13_insights_rules.png")
        await pg.click("#insTabs [data-tab=olap]"); await pg.wait_for_timeout(500)
        await pg.screenshot(path=f"{OUT}/14_olap_year_severity.png")
        await pg.click("#oTable td.h button >> nth=4"); await pg.wait_for_timeout(400)
        await pg.screenshot(path=f"{OUT}/15_olap_drilldown.png")
        await pg.click("#oUp"); await pg.select_option("#oRows", "time_band"); await pg.select_option("#oCols", "road_type")
        await pg.select_option("#oMeasure", "rate"); await pg.wait_for_timeout(400)
        await pg.screenshot(path=f"{OUT}/16_olap_pivot_rate.png")
        await pg.click("#btnBack")

        # mobile
        m = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                                timezone_id="Asia/Kolkata", geolocation={"latitude": 18.5309, "longitude": 73.8475}, permissions=["geolocation"])
        mp = await m.new_page()
        await mp.goto(URL + "#from=18.53090,73.84750&to=18.58100,73.91950&mode=fast")
        await mp.wait_for_selector("#result:not([hidden])", timeout=90000)
        await settle(mp)
        await mp.screenshot(path=f"{OUT}/17_mobile_route.png")
        await mp.click("#btnNav"); await mp.wait_for_timeout(1500)
        for la, lo in [(18.53110, 73.84790), (18.53150, 73.84850), (18.53190, 73.84920)]:
            await m.set_geolocation({"latitude": la, "longitude": lo}); await mp.wait_for_timeout(1300)
        await settle(mp, 1500)
        await mp.screenshot(path=f"{OUT}/18_mobile_gps.png")
        print("log:", log)
        await b.close()

asyncio.run(main())
