"""Zoekt het goedkoopste tankstation rond een opgegeven locatie (op aanvraag).

Anders dan nearby_main.py (vast zoekcentrum uit config.yaml, dagelijks) krijgt
deze module de locatie als argument mee, bv. het adres dat Homey uit je
smartphone haalt ("Wancourstraat 1, 8420 Wenduine, Belgium"). Het resultaat
wordt altijd naar Homey gestuurd (geen "enkel bij wijziging"-logica), want de
vraag komt van jou en niet van een timer.
"""
from __future__ import annotations

import argparse
import logging
import os
import re
from datetime import datetime, timezone

import requests
import yaml

from . import homey
from .nearby import USER_AGENT, fetch_nearby, find_cheapest

log = logging.getLogger(__name__)

DEFAULT_RADIUS_KM = 15


def parse_location(text: str) -> tuple[str, str | None]:
    """Haalt (gemeente, postcode) uit vrije tekst.

    Ondersteunt "Straat 1, 8420 Wenduine, Belgium", "8420 Wenduine",
    "Wenduine 8420" en een kale gemeentenaam ("Wenduine").
    """
    parts = [p.strip() for p in text.split(",") if p.strip()]
    for part in parts:
        match = re.match(r"^(\d{4})\s+(.+)$", part)
        if match:
            return match.group(2).strip(), match.group(1)
        match = re.match(r"^(.+?)\s+(\d{4})$", part)
        if match:
            return match.group(1).strip(), match.group(2)
    if not parts:
        raise ValueError("Lege locatie")
    return parts[0], None


def resolve_area(location_name: str, postcode: str | None) -> tuple[str, str, str]:
    """Zoekt carbu.com's areacode op. Geeft (areacode, gemeente, postcode)."""
    response = requests.get(
        "https://carbu.com//commonFunctions/getlocation/controller.getlocation_JSON.php",
        params={
            "location": location_name,
            "page_limit": 10,
            "minLevel": 5,
            "maxLevel": 6,
            "SHRT": 1,
            "country": "BE",
            "GPSCoordRequired": "true",
            "L": "nl",
        },
        headers={"User-Agent": USER_AGENT},
        timeout=15,
    )
    response.raise_for_status()
    items = response.json()
    if postcode:
        items = [i for i in items if i.get("pc") == postcode] or items
    if not items:
        raise ValueError(f"Geen carbu.com-locatie gevonden voor '{location_name}'")
    best = items[0]
    return best["ac"], best["n"], best["pc"]


def run(location: str, radius_km: float, fuel: str, config_path: str, dry_run: bool) -> int:
    webhook_url = os.environ.get("HOMEY_HERE_WEBHOOK_URL", "")
    if not webhook_url:
        try:
            with open(config_path, encoding="utf-8") as f:
                cfg = (yaml.safe_load(f) or {}).get("here", {})
            webhook_url = cfg.get("homey_webhook_url", "")
        except FileNotFoundError:
            pass

    name, postcode = parse_location(location)
    area_code, municipality, postcode = resolve_area(name, postcode)
    log.info("Zoekcentrum: %s (%s), straal %s km", municipality, postcode, radius_km)

    stations = fetch_nearby(fuel, municipality, postcode, area_code)
    log.info("%d stations gevonden rond %s", len(stations), municipality)

    cheapest = find_cheapest(stations, radius_km, [])
    if cheapest is None:
        log.warning("Geen station gevonden binnen %s km van %s", radius_km, municipality)
        return 1

    log.info(
        "Goedkoopste: %s (%s) - EUR %.3f op %.1f km",
        cheapest.name, cheapest.municipality, cheapest.price, cheapest.distance_km,
    )

    payload = {
        "station": cheapest.name,
        "fuel": fuel,
        "currency": "EUR",
        "municipality": cheapest.municipality,
        "address": cheapest.address,
        "price": cheapest.price,
        "previous_price": cheapest.price,
        "distance_km": round(cheapest.distance_km, 1),
        "origin": f"{municipality} {postcode}",
        "changed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    if dry_run:
        log.info("Dry-run, payload: %s", payload)
    elif webhook_url:
        homey.send(webhook_url, payload)
        log.info("Homey webhook verstuurd.")
    else:
        log.warning("Geen HOMEY_HERE_WEBHOOK_URL ingesteld, resultaat enkel gelogd.")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--location", required=True, help="Adres, 'postcode gemeente' of gemeente")
    parser.add_argument("--radius-km", type=float, default=DEFAULT_RADIUS_KM)
    parser.add_argument("--fuel", default="euro95")
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    raise SystemExit(run(args.location, args.radius_km, args.fuel, args.config, args.dry_run))


if __name__ == "__main__":
    main()
