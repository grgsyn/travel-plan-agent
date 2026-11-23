"""mock 数据源：从 data/mock/*.json 读取，按接口约定填充查询条件。

数据是多城市静态快照：现有 4 城精选 + 11 城演示生成，共 15 城；演示航班/酒店价格不是实时库存。行里带 `city` 字段的
按城市过滤，没带的默认算成都——这样新增城市不影响已有的成都数据。

刻意保留两个行为，用来驱动真实场景：
- 城市/航线不匹配时返回空列表（对应"飞这条线没有航班"）；
- 文件缺失或结构错误抛 SourceError（对应"数据源挂了"）。
二者在 agent 层必须区别对待。
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

from ..models import Flight, Hotel, POI, WeatherDay
from .base import SourceError

DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "mock"
DEFAULT_CITY = "成都"


def _load(name: str) -> list[dict]:
    path = DATA_DIR / name
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError as e:
        raise SourceError(f"mock 数据文件缺失: {path.name}") from e
    except json.JSONDecodeError as e:
        raise SourceError(f"mock 数据文件损坏: {path.name}: {e}") from e
    if not isinstance(data, list):
        raise SourceError(f"mock 数据格式错误，期望数组: {path.name}")
    return data


def _for_city(name: str, city: str) -> list[dict]:
    """取某城市的行；没有 city 字段的历史数据归到成都。"""
    return [row for row in _load(name) if row.get("city", DEFAULT_CITY) == city]


def _strip_city(row: dict) -> dict:
    return {k: v for k, v in row.items() if k != "city"}


class MockSource:
    def search_flights(self, origin: str, destination: str, dep_date: date) -> list[Flight]:
        out: list[Flight] = []
        for row in _load("flights.json"):
            if row["dep_city"] != origin or row["arr_city"] != destination:
                continue
            try:
                out.append(
                    Flight(
                        flight_no=row["flight_no"],
                        dep_city=row["dep_city"],
                        arr_city=row["arr_city"],
                        dep_date=dep_date,
                        dep_time=row["dep_time"],
                        arr_time=row["arr_time"],
                        duration_min=row["duration_min"],
                        price=row["price"],
                        seats_left=row["seats_left"],
                    )
                )
            except ValueError as e:
                raise SourceError(f"航班数据校验失败 {row.get('flight_no')}: {e}") from e
        return out

    def search_hotels(self, city: str, checkin: date, nights: int) -> list[Hotel]:
        out: list[Hotel] = []
        for row in _for_city("hotels.json", city):
            try:
                out.append(Hotel(**_strip_city(row)))
            except ValueError as e:
                raise SourceError(f"酒店数据校验失败 {row.get('id')}: {e}") from e
        return out

    def list_pois(self, city: str) -> list[POI]:
        out: list[POI] = []
        for row in _for_city("pois.json", city):
            try:
                out.append(POI(**_strip_city(row)))
            except ValueError as e:
                raise SourceError(f"景点数据校验失败 {row.get('id')}: {e}") from e
        return out

    def get_weather(self, city: str, start: date, days: int) -> list[WeatherDay]:
        templates = _for_city("weather.json", city)
        if not templates:
            return []
        out: list[WeatherDay] = []
        for i in range(days):
            tpl = _strip_city(templates[i % len(templates)])
            out.append(WeatherDay(date=start + timedelta(days=i), **tpl))
        return out

