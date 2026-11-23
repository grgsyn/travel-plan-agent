"""演示数据覆盖检查：避免缺航线/酒店时静默生成不可执行方案。"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .models import TripBrief
from .settings import AppSettings

COVERAGE_PATH = Path(__file__).resolve().parents[1] / "data" / "mock" / "coverage.json"


def _load() -> dict:
    return json.loads(COVERAGE_PATH.read_text(encoding="utf-8"))


def _is_amap_live() -> bool:
    return bool(os.getenv("AMAP_WEB_KEY", "").strip())


def _is_qweather_live() -> bool:
    return bool(os.getenv("QWEATHER_KEY", "").strip())


def check_coverage(brief: TripBrief, cfg: AppSettings) -> list[str]:
    """返回阻塞项；空列表表示可以进入规划。

    http 数据源由外部服务自行保证覆盖，不套用本地 mock 清单。
    """
    if cfg.datasource.kind == "http":
        return []

    data = _load()
    problems: list[str] = []

    routes = {tuple(route) for route in (data.get("flights", {}).get("routes") or [])}
    if (brief.origin, brief.destination) not in routes:
        problems.append(
            f"暂无 {brief.origin} → {brief.destination} 的演示航班"
            "（当前 mock 只覆盖部分城市对）"
        )

    if brief.days > 1 and brief.destination not in (data.get("hotels", {}).get("cities") or []):
        problems.append(f"暂无 {brief.destination} 的演示酒店")

    if not _is_amap_live() and brief.destination not in (data.get("pois", {}).get("cities") or []):
        problems.append(f"暂无 {brief.destination} 的演示景点")

    if not _is_qweather_live() and brief.destination not in (data.get("weather", {}).get("cities") or []):
        problems.append(f"暂无 {brief.destination} 的演示天气")

    return problems


def coverage_summary() -> dict:
    """给设置页/调试使用的只读覆盖摘要。"""
    data = _load()
    return {
        "updated_at": data.get("updated_at"),
        "source": data.get("source"),
        "flight_routes": data.get("flights", {}).get("routes") or [],
        "hotel_cities": data.get("hotels", {}).get("cities") or [],
        "poi_cities": data.get("pois", {}).get("cities") or [],
        "weather_cities": data.get("weather", {}).get("cities") or [],
        "amap_live": _is_amap_live(),
        "qweather_live": _is_qweather_live(),
    }
