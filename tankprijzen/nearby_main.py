"""Zoekt het goedkoopste tankstation in de buurt en meldt wijzigingen aan Homey."""
from __future__ import annotations

import argparse
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

import yaml

from . import homey
from .nearby import fetch_nearby, find_cheapest, resolve_area

log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def run(config_path: str, dry_run: bool) -> int:
    with open(config_path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    cfg = raw.get("nearby")
    if not cfg:
        log.error("Geen 'nearby'-sectie gevonden in %s", config_path)
        return 1

    webhook_url = os.environ.get("HOMEY_NEARBY_WEBHOOK_URL") or cfg.get(
        "homey_webhook_url", ""
    )
    storage_path = Path(cfg.get("storage_path", "data/nearby.json"))
    location_name = cfg["location_name"]
    postcode = str(cfg["postcode"])
    radius_km = cfg.get("radius_km", 10)
    excluded = cfg.get("excluded_municipalities", [])
    fuel = cfg.get("fuel", "euro95")

    if not dry_run and not webhook_url:
        log.warning(
            "Geen Homey webhook-URL geconfigureerd voor 'nearby' "
            "(HOMEY_NEARBY_WEBHOOK_URL of nearby.homey_webhook_url). "
            "Resultaat wordt alleen gelogd."
        )

    area_code = cfg.get("area_code") or resolve_area(location_name, postcode)
    stations = fetch_nearby(fuel, location_name, postcode, area_code)
    log.info("%d stations gevonden binnen het zoekgebied van %s", len(stations), location_name)

    cheapest = find_cheapest(stations, radius_km, excluded)
    if cheapest is None:
        log.warning(
            "Geen station gevonden binnen %s km van %s (na uitsluiting van %s)",
            radius_km, location_name, excluded,
        )
        return 1

    log.info(
        "Goedkoopste: %s (%s) - €%.3f op %.2f km",
        cheapest.name, cheapest.municipality, cheapest.price, cheapest.distance_km,
    )

    previous: dict = {}
    if storage_path.exists():
        previous = json.loads(storage_path.read_text(encoding="utf-8"))

    changed = (
        previous.get("station_id") != cheapest.id
        or previous.get("price") != cheapest.price
    )

    now = _now_iso()
    if changed:
        log.info("Wijziging t.o.v. vorige check (of eerste run).")
        if not dry_run and webhook_url:
            payload = {
                "station": cheapest.name,
                "fuel": fuel,
                "currency": "EUR",
                "municipality": cheapest.municipality,
                "address": cheapest.address,
                "price": cheapest.price,
                "previous_price": previous.get("price", cheapest.price),
                "distance_km": round(cheapest.distance_km, 2),
                "changed_at": now,
            }
            homey.send(webhook_url, payload)
            log.info("Homey webhook verstuurd voor 'goedkoopste in de buurt'.")
    else:
        log.info("Geen wijziging t.o.v. vorige check, geen Homey-melding verstuurd.")

    if not dry_run:
        storage_path.parent.mkdir(parents=True, exist_ok=True)
        storage_path.write_text(
            json.dumps(
                {
                    "station_id": cheapest.id,
                    "station": cheapest.name,
                    "municipality": cheapest.municipality,
                    "price": cheapest.price,
                    "distance_km": round(cheapest.distance_km, 2),
                    "changed_at": now if changed else previous.get("changed_at", now),
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config.yaml", help="Pad naar config.yaml")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Toon resultaat zonder Homey te notificeren of state op te slaan",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    raise SystemExit(run(args.config, args.dry_run))


if __name__ == "__main__":
    main()
