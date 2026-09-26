"""Zoekt het goedkoopste tankstation in de buurt via carbu.com's gebiedsoverzicht.

In tegenstelling tot tankprijzen/scraper.py (dat één vaste stations-URL
scrapet) haalt deze module een hele lijst van stations rond een gemeente op.
carbu.com levert elk station als een <div class="stationItem"> met kant-en-
klare data-*-attributen (naam, prijs, gemeente, afstand tot het
zoekcentrum), dus geen aparte HTML-parsing per veld nodig.

De afstand komt van carbu.com zelf en is de afstand tot het centrum van de
opgegeven gemeente (via haar postcode/areacode), niet tot een exact adres —
voor een 10km-straal is dat een nauwkeurige genoeg benadering.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import requests
from bs4 import BeautifulSoup

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (compatible; TankprijzenBot/1.0; "
    "+https://github.com/krisvankerkhoven/claudetest)"
)

# Onze interne brandstofnamen (zie scraper.FUEL_ALIASES) -> carbu.com's URL-code.
CARBU_FUEL_CODES = {
    "euro95": "E10",
    "euro98": "SP98",
    "diesel": "GO",
    "lpg": "GPL",
}


@dataclass
class NearbyStation:
    id: str
    name: str
    municipality: str
    address: str
    price: float
    distance_km: float
    url: str


def resolve_area(location_name: str, postcode: str) -> str:
    """Zoekt carbu.com's interne areacode op voor een gemeente/postcode."""
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
    for item in response.json():
        if item.get("pc") == postcode and item.get("n", "").lower() == location_name.lower():
            return item["ac"]
    raise ValueError(f"Geen carbu.com-areacode gevonden voor {location_name} ({postcode})")


def fetch_nearby(
    fuel: str, location_name: str, postcode: str, area_code: str
) -> list[NearbyStation]:
    """Haalt alle tankstations rond de opgegeven gemeente op, met prijs voor `fuel`."""
    carbu_fuel = CARBU_FUEL_CODES.get(fuel, fuel)
    url = (
        f"https://carbu.com/belgie//liste-stations-service/"
        f"{carbu_fuel}/{location_name}/{postcode}/{area_code}"
    )
    response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=15)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    stations: dict[str, NearbyStation] = {}

    for div in soup.select("div.stationItem[data-id]"):
        station_id = div.get("data-id")
        if not station_id or station_id in stations:
            continue  # elk station komt soms dubbel voor (mobiele/desktop-variant)

        address_html = div.get("data-address", "")
        last_line = address_html.split("<br/>")[-1]
        municipality_match = re.search(r"\d{4}\s*(.+)$", last_line)
        municipality = municipality_match.group(1).strip() if municipality_match else ""

        try:
            price = float(div["data-price"])
            distance_km = float(div["data-distance"])
        except (KeyError, ValueError):
            continue

        stations[station_id] = NearbyStation(
            id=station_id,
            name=div.get("data-name", "").strip(),
            municipality=municipality,
            address=address_html.replace("<br/>", ", "),
            price=price,
            distance_km=distance_km,
            url=div.get("data-link", ""),
        )

    return list(stations.values())


def find_cheapest(
    stations: list[NearbyStation], radius_km: float, excluded_municipalities: list[str]
) -> NearbyStation | None:
    """Geeft het goedkoopste station terug binnen `radius_km`, uitgesloten gemeenten weggelaten."""
    excluded = {m.strip().lower() for m in excluded_municipalities}
    candidates = [
        s
        for s in stations
        if s.distance_km <= radius_km and s.municipality.strip().lower() not in excluded
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda s: s.price)
