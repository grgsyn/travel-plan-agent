"""生成 15 城演示快照。

- 现有 4 城精选数据保留；
- 新增城市的酒店/景点通过高德 POI 获取名称与坐标；
- 酒店价格为演示估算，航班为演示生成，均不是实时库存；
- 生成后写入 data/mock，供 MockSource 与 coverage 使用。
"""

from __future__ import annotations

import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "mock"
AMAP = "https://restapi.amap.com"

CITIES = {
    "上海": (31.2304, 121.4737, 1),
    "北京": (39.9042, 116.4074, 1),
    "广州": (23.1291, 113.2644, 1),
    "深圳": (22.5431, 114.0579, 1),
    "成都": (30.5728, 104.0668, 2),
    "重庆": (29.5630, 106.5516, 2),
    "西安": (34.3416, 108.9398, 2),
    "杭州": (30.2741, 120.1551, 2),
    "南京": (32.0603, 118.7969, 2),
    "苏州": (31.2989, 120.5853, 2),
    "武汉": (30.5928, 114.3055, 2),
    "长沙": (28.2282, 112.9388, 2),
    "厦门": (24.4798, 118.0894, 3),
    "青岛": (36.0671, 120.3826, 2),
    "昆明": (25.0389, 102.7183, 3),
}

TIER_PRICE = {1: (480, 760), 2: (320, 560), 3: (280, 480)}
HOTEL_TEMPLATE = ["市中心酒店", "地铁站酒店", "商务酒店", "精品酒店", "家庭酒店"]


def load(name: str) -> list[dict]:
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def save(name: str, rows: list[dict]) -> None:
    (DATA / name).write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lng1 = map(math.radians, a)
    lat2, lng2 = map(math.radians, b)
    dlat, dlng = lat2 - lat1, lng2 - lng1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def amap_get(path: str, params: dict) -> dict:
    key = os.getenv("AMAP_WEB_KEY", "").strip()
    if not key:
        raise RuntimeError("AMAP_WEB_KEY 未配置")
    query = urllib.parse.urlencode({**params, "key": key})
    req = urllib.request.Request(f"{AMAP}{path}?{query}", headers={"User-Agent": "travel-plan-agent-demo/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"高德 HTTP {exc.code}") from exc
    if str(data.get("status")) != "1":
        raise RuntimeError(f"高德错误：{data.get('info')}")
    return data


def fetch_places(city: str, keywords: str, limit: int = 8) -> list[dict]:
    data = amap_get(
        "/v5/place/text",
        {
            "keywords": keywords,
            "region": city,
            "city_limit": "true",
            "page_size": max(limit, 10),
            "show_fields": "business",
        },
    )
    rows: list[dict] = []
    seen: set[str] = set()
    for row in data.get("pois") or []:
        name = str(row.get("name") or "").strip()
        location = str(row.get("location") or "")
        if not name or "," not in location or name in seen:
            continue
        seen.add(name)
        try:
            lng, lat = (float(part) for part in location.split(",", 1))
        except ValueError:
            continue
        rows.append({"name": name, "lat": lat, "lng": lng, "raw": row})
        if len(rows) >= limit:
            break
    return rows


def hotel_rows(city: str) -> list[dict]:
    center = CITIES[city][:2]
    fetched = fetch_places(city, "酒店", 5)
    tier = CITIES[city][2]
    low, high = TIER_PRICE[tier]
    rows: list[dict] = []
    for idx, item in enumerate(fetched):
        raw = item["raw"]
        business = raw.get("business") if isinstance(raw.get("business"), dict) else {}
        try:
            rating = min(5.0, max(3.0, float(business.get("rating") or 4.3)))
        except (TypeError, ValueError):
            rating = 4.3
        price = int(round(low + (high - low) * (idx / max(1, len(fetched) - 1)) + (rating - 4.2) * 80, -1))
        price = max(180, price)
        rows.append(
            {
                "id": f"demo-hotel-{city}-{idx + 1}",
                "city": city,
                "name": item["name"],
                "district": str(raw.get("adname") or raw.get("address") or "市区").strip()[:20],
                "price_per_night": price,
                "rating": rating,
                "tags": ["演示价格", "演示数据", "酒店"],
                "distance_to_center_km": round(haversine(center, (item["lat"], item["lng"])), 1),
                "lat": item["lat"],
                "lng": item["lng"],
                "room_capacity": 2,
            }
        )
    if not rows:
        raise RuntimeError(f"{city} 未获取到酒店")
    return rows


def poi_rows(city: str) -> list[dict]:
    fetched = fetch_places(city, "景点", 8)
    rows: list[dict] = []
    for idx, item in enumerate(fetched):
        raw = item["raw"]
        type_text = str(raw.get("type") or "")
        tags = [part for part in type_text.split(";") if part]
        tags += ["演示数据", "游览时长待估算"]
        rows.append(
            {
                "id": f"demo-poi-{city}-{idx + 1}",
                "city": city,
                "name": item["name"],
                "category": (type_text.split(";")[-1] or "景点")[:20],
                "open_time": "09:00",
                "close_time": "17:00",
                "closed_days": [],
                "ticket_price": 0,
                "recommended_slot": ["上午", "下午"],
                "tags": tags,
                "lat": item["lat"],
                "lng": item["lng"],
                "indoor": any(word in f"{item['name']}{type_text}" for word in ("博物馆", "纪念", "美术馆", "展览", "寺", "宫", "塔", "剧院", "水族馆", "海洋")),
            }
        )
    if not rows:
        raise RuntimeError(f"{city} 未获取到景点")
    return rows


def weather_rows(city: str) -> list[dict]:
    templates = [
        ("晴", 6, 17, 0.0),
        ("多云", 8, 19, 0.1),
        ("阴", 9, 17, 0.2),
        ("小雨", 8, 14, 0.7),
        ("多云", 7, 18, 0.1),
    ]
    return [
        {"city": city, "condition": c, "temp_low": lo, "temp_high": hi, "rain_prob": rain}
        for c, lo, hi, rain in templates
    ]


def flight_rows(existing: list[dict]) -> list[dict]:
    routes = {(r["dep_city"], r["arr_city"]) for r in existing}
    out = list(existing)
    counter = 1
    for origin, (olat, olng, _) in CITIES.items():
        for dest, (dlat, dlng, _) in CITIES.items():
            if origin == dest or (origin, dest) in routes:
                continue
            distance = haversine((olat, olng), (dlat, dlng))
            duration = max(65, int(round(distance / 700 * 60 + 35)))
            price = max(320, int(round((distance * 0.55 + 220) / 10) * 10))
            for slot, dep in (("早", "07:10"), ("午", "12:20"), ("晚", "17:40")):
                h, m = map(int, dep.split(":"))
                arrive = h * 60 + m + duration
                if arrive >= 23 * 60:
                    continue
                out.append(
                    {
                        "flight_no": f"DM{counter:04d}",
                        "dep_city": origin,
                        "arr_city": dest,
                        "dep_time": dep,
                        "arr_time": f"{arrive // 60:02d}:{arrive % 60:02d}",
                        "duration_min": duration,
                        "price": price + (0 if slot == "早" else 60 if slot == "午" else 120),
                        "seats_left": 9,
                        "demo": True,
                    }
                )
                counter += 1
    return out


def main() -> None:
    # 触发 backend/.env 加载
    import sys

    sys.path.insert(0, str(ROOT))
    from app.settings import _load_env_file

    _load_env_file()

    flights = load("flights.json")
    hotels = load("hotels.json")
    pois = load("pois.json")
    weather = load("weather.json")

    existing_cities = {r.get("city", "成都") for r in hotels} | {r.get("city", "成都") for r in pois}
    new_cities = [c for c in CITIES if c not in existing_cities]
    print("新增城市", new_cities)

    for city in new_cities:
        hotels.extend(hotel_rows(city))
        pois.extend(poi_rows(city))
        weather.extend(weather_rows(city))
        print("完成", city)
        time.sleep(0.2)

    flights = flight_rows(flights)
    save("flights.json", flights)
    save("hotels.json", hotels)
    save("pois.json", pois)
    save("weather.json", weather)

    routes = sorted({(r["dep_city"], r["arr_city"]) for r in flights})
    coverage = {
        "schema_version": 1,
        "updated_at": date.today().isoformat(),
        "source": "demo-generated",
        "note": "航班与酒店价格为演示生成，不是实时库存；景点名称/坐标来自高德 POI。",
        "flights": {"routes": [list(r) for r in routes], "note": "方向敏感；去程和返程都必须存在"},
        "hotels": {"cities": sorted(CITIES), "note": "酒店价格为演示估算"},
        "pois": {"cities": sorted(CITIES), "note": "景点名称/坐标来自高德 POI，开放时间/票价为默认值"},
        "weather": {"cities": sorted(CITIES), "note": "配置 QWEATHER_KEY 时使用和风天气；否则为演示模板"},
    }
    (DATA / "coverage.json").write_text(json.dumps(coverage, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("flights", len(flights), "hotels", len(hotels), "pois", len(pois), "weather", len(weather))


if __name__ == "__main__":
    main()
