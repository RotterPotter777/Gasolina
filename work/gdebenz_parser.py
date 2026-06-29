#!/usr/bin/env python3
"""
Parser for gdebenz.ru station data.

The site exposes public JSON endpoints used by its map:
  /api/stations?lat1=...&lon1=...&lat2=...&lon2=...
  /api/nearby?lat=...&lon=...&radius_km=20

This script collects stations by bounding boxes, deduplicates them, and writes
CSV + JSON files. Status enrichment is optional because it requires extra calls.
"""

from __future__ import annotations

import argparse
import csv
import json
import ssl
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


BASE_URL = "https://gdebenz.ru"
GEOCODER_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client"
USER_AGENT = "Mozilla/5.0 (compatible; gdebenz-parser/1.0)"

STATUS_LABELS = {
    "no": "нет бензина",
    "queue": "есть бензин но очередь",
    "yes": "есть бензин",
    "low": "мало бензина",
    "unknown": "нет данных",
    "none": "нет данных",
    "": "",
}

FUEL_COLUMNS = ["92", "95", "98", "100", "ДТ"]


@dataclass(frozen=True)
class AreaPreset:
    region: str
    district: str
    area: str
    bbox: tuple[float, float, float, float]  # lat1, lon1, lat2, lon2


PRESETS: dict[str, AreaPreset] = {
    "moscow": AreaPreset(
        region="Москва",
        district="Москва",
        area="Москва",
        bbox=(55.489, 37.319, 55.958, 37.945),
    ),
    "moscow-oblast": AreaPreset(
        region="Московская область",
        district="",
        area="Московская область",
        bbox=(54.25, 35.15, 56.96, 40.21),
    ),
    "podolsk": AreaPreset(
        region="Московская область",
        district="Городской округ Подольск",
        area="Подольск",
        bbox=(55.30, 37.25, 55.60, 37.82),
    ),
}


CSV_FIELDS = [
    "region",
    "district",
    "station_name",
    "brand",
    "lat",
    "lon",
    "osm_id",
    "status",
    "status_code",
    "fuels_now",
    "92",
    "95",
    "98",
    "100",
    "ДТ",
    "confirmations",
    "realCount",
    "last_at",
]


def json_get(url: str, insecure_ssl: bool, retries: int = 3) -> Any:
    last_error: Exception | None = None
    context = ssl._create_unverified_context() if insecure_ssl else None

    for attempt in range(1, retries + 1):
        try:
            request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urlopen(request, timeout=20, context=context) as response:
                return json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt == retries:
                break
            time.sleep(0.7 * attempt)

    raise RuntimeError(f"Cannot fetch {url}: {last_error}") from last_error


class Progress:
    def __init__(self, label: str, total: int) -> None:
        self.label = label
        self.total = max(total, 1)
        self.started = time.monotonic()
        self.current = 0

    def update(self, current: int, note: str = "") -> None:
        self.current = current
        done = min(max(current / self.total, 0), 1)
        width = 28
        filled = int(width * done)
        bar = "#" * filled + "." * (width - filled)
        elapsed = time.monotonic() - self.started
        suffix = f" · {note}" if note else ""
        print(
            f"\r{self.label:<13} [{bar}] {current:>5}/{self.total:<5} {done:>6.1%} · {elapsed:>5.1f}s{suffix}",
            end="",
            flush=True,
        )

    def finish(self, note: str = "") -> None:
        self.update(self.total, note)
        print()


def api_get(path: str, params: dict[str, Any], insecure_ssl: bool, retries: int = 3) -> Any:
    return json_get(f"{BASE_URL}{path}?{urlencode(params)}", insecure_ssl, retries)


def geocoder_get(lat: float, lon: float, insecure_ssl: bool) -> dict[str, Any]:
    params = {
        "latitude": f"{lat:.6f}",
        "longitude": f"{lon:.6f}",
        "localityLanguage": "ru",
    }
    payload = json_get(f"{GEOCODER_URL}?{urlencode(params)}", insecure_ssl)
    return payload if isinstance(payload, dict) else {}


def frange(start: float, stop: float, step: float) -> list[float]:
    values: list[float] = []
    current = start
    while current < stop:
        values.append(round(current, 6))
        current += step
    values.append(stop)
    return values


def iter_tiles(
    bbox: tuple[float, float, float, float],
    step_lat: float,
    step_lon: float,
) -> list[tuple[float, float, float, float]]:
    lat1, lon1, lat2, lon2 = bbox
    south, north = sorted((lat1, lat2))
    west, east = sorted((lon1, lon2))
    lat_edges = frange(south, north, step_lat)
    lon_edges = frange(west, east, step_lon)

    tiles = []
    for lat_idx in range(len(lat_edges) - 1):
        for lon_idx in range(len(lon_edges) - 1):
            tiles.append(
                (
                    lat_edges[lat_idx],
                    lon_edges[lon_idx],
                    lat_edges[lat_idx + 1],
                    lon_edges[lon_idx + 1],
                )
            )
    return tiles


def station_key(station: dict[str, Any]) -> str:
    osm_id = str(station.get("osm_id") or "").strip()
    if osm_id:
        return osm_id
    lat = station.get("lat")
    lon = station.get("lon")
    name = station.get("name") or station.get("brand") or ""
    return f"{lat:.6f}:{lon:.6f}:{name}" if isinstance(lat, float) and isinstance(lon, float) else repr(station)


def split_fuels(fuels_now: str) -> dict[str, str]:
    text = (fuels_now or "").upper().replace("АИ-", "").replace("ДИЗЕЛЬ", "ДТ")
    result = {fuel: "" for fuel in FUEL_COLUMNS}
    for fuel in FUEL_COLUMNS:
        if fuel in text:
            result[fuel] = "1"
    return result


def normalize_station(station: dict[str, Any], area: AreaPreset) -> dict[str, Any]:
    status_code = station.get("status") or ""
    fuels_now = station.get("fuels_now") or ""
    station_name = station.get("name") or station.get("brand") or "Заправка"
    return {
        "region": area.region,
        "district": area.district,
        "area": area.area,
        "station_name": station_name,
        "brand": station_name,
        "lat": station.get("lat"),
        "lon": station.get("lon"),
        "address": station.get("addr") or station.get("address") or "",
        "osm_id": station.get("osm_id") or "",
        "status": STATUS_LABELS.get(status_code, status_code),
        "status_code": status_code,
        "fuels_now": fuels_now,
        **split_fuels(fuels_now),
        "confirmations": station.get("confirmations") or "",
        "realCount": station.get("realCount") or "",
        "last_at": station.get("last_at") or "",
    }


def collect_stations(
    area: AreaPreset,
    step_lat: float,
    step_lon: float,
    delay: float,
    insecure_ssl: bool,
) -> list[dict[str, Any]]:
    stations: dict[str, dict[str, Any]] = {}
    tiles = iter_tiles(area.bbox, step_lat, step_lon)
    progress = Progress(f"collect {area.area}", len(tiles))

    for index, (lat1, lon1, lat2, lon2) in enumerate(tiles, start=1):
        payload = api_get(
            "/api/stations",
            {
                "lat1": f"{lat1:.6f}",
                "lon1": f"{lon1:.6f}",
                "lat2": f"{lat2:.6f}",
                "lon2": f"{lon2:.6f}",
            },
            insecure_ssl,
        )
        if not isinstance(payload, list):
            raise RuntimeError(f"Unexpected /api/stations response: {payload!r}")

        for station in payload:
            if isinstance(station, dict):
                stations[station_key(station)] = normalize_station(station, area)

        progress.update(index, f"stations={len(stations)}")
        if delay:
            time.sleep(delay)

    progress.finish(f"stations={len(stations)}")
    return sorted(stations.values(), key=lambda item: (str(item["station_name"]), float(item["lat"] or 0)))


def apply_station_update(station: dict[str, Any], update: dict[str, Any]) -> None:
    status_code = update.get("status") or station.get("status_code") or ""
    fuels_now = update.get("fuels_now") or station.get("fuels_now") or ""
    station["status_code"] = status_code
    station["status"] = STATUS_LABELS.get(status_code, status_code)
    station["fuels_now"] = fuels_now
    station.update(split_fuels(fuels_now))
    station["confirmations"] = update.get("confirmations") or station.get("confirmations") or ""
    station["last_at"] = update.get("last_at") or update.get("created_at") or station.get("last_at") or ""


def enrich_status(stations: list[dict[str, Any]], delay: float, insecure_ssl: bool, workers: int) -> None:
    def fetch_one(station: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
        lat = station.get("lat")
        lon = station.get("lon")
        osm_id = str(station.get("osm_id") or "")
        if lat is None or lon is None or not osm_id:
            return osm_id, None

        payload = api_get(
            "/api/nearby",
            {"lat": f"{float(lat):.6f}", "lon": f"{float(lon):.6f}", "radius_km": "1"},
            insecure_ssl,
        )
        nearby = payload.get("stations", []) if isinstance(payload, dict) else []
        match = next((item for item in nearby if str(item.get("osm_id")) == osm_id), None)
        if delay:
            time.sleep(delay)
        return osm_id, match

    by_id = {str(station.get("osm_id")): station for station in stations}
    progress = Progress("status", len(stations))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(fetch_one, station) for station in stations]
        for index, future in enumerate(as_completed(futures), start=1):
            osm_id, match = future.result()
            if match and osm_id in by_id:
                apply_station_update(by_id[osm_id], match)
            progress.update(index)
    progress.finish()


def parse_site_time(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def enrich_real_count(stations: list[dict[str, Any]], delay: float, insecure_ssl: bool, workers: int) -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

    def fetch_one(station: dict[str, Any]) -> tuple[str, int]:
        osm_id = str(station.get("osm_id") or "")
        if not osm_id:
            return osm_id, 0
        payload = api_get("/api/comments/" + osm_id + "/recent", {"limit": "100"}, insecure_ssl)
        comments = payload if isinstance(payload, list) else []
        real_count = 0
        for comment in comments:
            if not isinstance(comment, dict):
                continue
            created_at = parse_site_time(comment.get("created_at") or "")
            if created_at and created_at >= cutoff:
                real_count += 1
        if delay:
            time.sleep(delay)
        return osm_id, real_count

    by_id = {str(station.get("osm_id")): station for station in stations}
    progress = Progress("realCount", len(stations))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(fetch_one, station) for station in stations]
        for index, future in enumerate(as_completed(futures), start=1):
            osm_id, real_count = future.result()
            if osm_id in by_id:
                by_id[osm_id]["realCount"] = real_count
            progress.update(index)
    progress.finish()


def extract_district(payload: dict[str, Any]) -> tuple[str, str]:
    subdivision = payload.get("principalSubdivision") or ""
    if subdivision == "Москва":
        return "Москва", "Москва"

    administrative = payload.get("localityInfo", {}).get("administrative", [])
    for item in reversed(administrative):
        if not isinstance(item, dict):
            continue
        name = item.get("name") or ""
        if "городской округ" in name.lower():
            return subdivision or "Московская область", name[0].upper() + name[1:]

    city = payload.get("city") or ""
    if "городской округ" in city.lower():
        return subdivision or "Московская область", city[0].upper() + city[1:]
    return subdivision or "", city


def enrich_districts(
    stations: list[dict[str, Any]],
    delay: float,
    insecure_ssl: bool,
    workers: int,
    cache_path: Path,
) -> None:
    if cache_path.exists():
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
    else:
        cache = {}

    def cache_key(station: dict[str, Any]) -> str:
        return f"{float(station['lat']):.4f},{float(station['lon']):.4f}"

    missing = []
    for station in stations:
        if station.get("lat") is None or station.get("lon") is None:
            continue
        key = cache_key(station)
        if key not in cache:
            missing.append((key, float(station["lat"]), float(station["lon"])))

    def fetch_one(item: tuple[str, float, float]) -> tuple[str, dict[str, str]]:
        key, lat, lon = item
        payload = geocoder_get(lat, lon, insecure_ssl)
        region, district = extract_district(payload)
        if delay:
            time.sleep(delay)
        return key, {"region": region, "district": district}

    if missing:
        progress = Progress("district", len(missing))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [executor.submit(fetch_one, item) for item in missing]
            for index, future in enumerate(as_completed(futures), start=1):
                key, value = future.result()
                cache[key] = value
                if index % 25 == 0 or index == len(missing):
                    cache_path.parent.mkdir(parents=True, exist_ok=True)
                    cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
                progress.update(index)
        progress.finish()
    else:
        print("district      cache hit")

    for station in stations:
        if station.get("lat") is None or station.get("lon") is None:
            continue
        value = cache.get(cache_key(station), {})
        region = value.get("region") or station.get("region") or ""
        district = value.get("district") or station.get("district") or ""
        if region:
            station["region"] = region
        if district:
            station["district"] = district


def write_outputs(stations: list[dict[str, Any]], output_dir: Path, stem: str) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    csv_path = output_dir / f"{stem}.csv"
    json_path = output_dir / f"{stem}.json"

    with csv_path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(stations)

    with json_path.open("w", encoding="utf-8") as file:
        json.dump([{field: station.get(field, "") for field in CSV_FIELDS} for station in stations], file, ensure_ascii=False, indent=2)

    return csv_path, json_path


def build_areas(args: argparse.Namespace) -> tuple[str, list[AreaPreset]]:
    if args.all:
        return "unified", [PRESETS["moscow-oblast"]]

    if args.preset:
        preset = PRESETS[args.preset]
        return args.preset, [preset]

    if not args.bbox:
        raise SystemExit("Use --all, --preset or --bbox lat1 lon1 lat2 lon2")

    area = AreaPreset(
        region=args.region,
        district=args.district,
        area=args.area or args.district or args.region or "custom",
        bbox=tuple(args.bbox),
    )
    return "custom", [area]


def merge_stations(groups: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for stations in groups:
        for station in stations:
            key = str(station.get("osm_id") or station_key(station))
            if key not in merged:
                merged[key] = station
                continue
            current = merged[key]
            for field in CSV_FIELDS:
                if not current.get(field) and station.get(field):
                    current[field] = station[field]
    return sorted(merged.values(), key=lambda item: (str(item["region"]), str(item["district"]), str(item["station_name"])))


def filter_target_regions(stations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for station in stations:
        if station.get("region") != "Московская область":
            continue
        result.append(station)
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect gdebenz.ru stations to CSV/JSON.")
    parser.add_argument("--all", action="store_true", help="Build one Moscow oblast file.")
    parser.add_argument("--preset", choices=sorted(PRESETS), help="Known area preset.")
    parser.add_argument("--bbox", nargs=4, type=float, metavar=("LAT1", "LON1", "LAT2", "LON2"))
    parser.add_argument("--region", default="")
    parser.add_argument("--district", default="")
    parser.add_argument("--area", default="")
    parser.add_argument("--step-lat", type=float, default=0.35, help="Tile height in degrees.")
    parser.add_argument("--step-lon", type=float, default=0.50, help="Tile width in degrees.")
    parser.add_argument("--delay", type=float, default=0.0, help="Pause between requests.")
    parser.add_argument("--with-status", action="store_true", help="Enrich every station via /api/nearby.")
    parser.add_argument("--with-real-count", action="store_true", help="Count driver marks for the last 24 hours.")
    parser.add_argument("--with-districts", action="store_true", help="Fill region and city district by reverse geocoder.")
    parser.add_argument("--workers", type=int, default=24, help="Parallel workers for enrichment.")
    parser.add_argument("--district-cache", type=Path, default=Path("work/district_cache.json"))
    parser.add_argument(
        "--insecure-ssl",
        action="store_true",
        help="Disable TLS certificate verification if local Python cannot find root certificates.",
    )
    parser.add_argument("--output-dir", type=Path, default=Path("outputs"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    stem, areas = build_areas(args)

    if args.step_lat <= 0 or args.step_lon <= 0:
        raise SystemExit("--step-lat and --step-lon must be positive")
    if args.delay < 0:
        raise SystemExit("--delay cannot be negative")

    if args.workers <= 0:
        raise SystemExit("--workers must be positive")

    groups = [
        collect_stations(area, args.step_lat, args.step_lon, args.delay, args.insecure_ssl)
        for area in areas
    ]
    stations = merge_stations(groups)
    if args.with_status:
        enrich_status(stations, args.delay, args.insecure_ssl, args.workers)
    if args.with_real_count:
        enrich_real_count(stations, args.delay, args.insecure_ssl, args.workers)
    if args.with_districts:
        enrich_districts(stations, args.delay, args.insecure_ssl, args.workers, args.district_cache)
    if args.all:
        stations = filter_target_regions(stations)

    suffix_parts = []
    if args.with_status:
        suffix_parts.append("status")
    if args.with_real_count:
        suffix_parts.append("realcount")
    if args.with_districts:
        suffix_parts.append("districts")
    suffix = "_" + "_".join(suffix_parts) if suffix_parts else ""
    csv_path, json_path = write_outputs(stations, args.output_dir, f"gdebenz_{stem}{suffix}")

    print(f"Done: {len(stations)} stations")
    print(f"CSV:  {csv_path}")
    print(f"JSON: {json_path}")


if __name__ == "__main__":
    main()
