"""Goedkoopste tankstation in Duitsland via Tankerkönig.

Bron: creativecommons.tankerkoenig.de (officiële Markttransparenzstelle für
Kraftstoffe, realtime). Vereist een gratis API-sleutel
(https://creativecommons.tankerkoenig.de), die als omgevingsvariabele
TANKERKOENIG_API_KEY wordt meegegeven (GitHub secret).

Het adres wordt omgezet via Nominatim (OpenStreetMap), beperkt tot Duitsland.
Het resultaat is een lijst NearbyStation, zodat find_cheapest en de rest van de
flow hetzelfde blijven als voor België en Frankrijk.
"""
from __future__ import annotations

import os

import requests

from .nearby import USER_AGENT, NearbyStation

LIST_URL = "https://creativecommons.tankerkoenig.de/json/list.php"
GEOCODE_URL = "https://nominatim.openstreetmap.org/search"

# Tankerkönig staat maximaal 25 km straal toe.
MAX_RADIUS_KM = 25

_GERMANY_WORDS = ("germany", "deutschland", "duitsland", "allemagne", "alemania")


def looks_german(text: str) -> bool:
    """Herkent een Duits adres aan de landnaam."""
    lowered = text.lower()
    return any(word in lowered for word in _GERMANY_WORDS)


def geocode(text: str) -> tuple[float, float, str]:
    """Zet een adres om naar (lat, lon, label) via Nominatim, beperkt tot Duitsland."""
    response = requests.get(
        GEOCODE_URL,
        params={"q": text, "format": "jsonv2", "limit": 1, "countrycodes": "de"},
        headers={"User-Agent": USER_AGENT},
        timeout=15,
    )
    response.raise_for_status()
    items = response.json()
    if not items:
        raise ValueError(f"Geen Duits adres gevonden voor '{text}'")
    item = items[0]
    return float(item["lat"]), float(item["lon"]), item.get("display_name", text)


def fetch_germany(
    lat: float, lon: float, radius_km: float, api_key: str | None = None
) -> list[NearbyStation]:
    """Haalt de open stations binnen `radius_km` met een E10-prijs op, goedkoopste eerst."""
    api_key = api_key or os.environ.get("TANKERKOENIG_API_KEY", "")
    if not api_key:
        raise RuntimeError(
            "Geen TANKERKOENIG_API_KEY ingesteld (gratis sleutel op "
            "creativecommons.tankerkoenig.de, als GitHub secret toevoegen)"
        )

    response = requests.get(
        LIST_URL,
        params={
            "lat": lat,
            "lng": lon,
            "rad": min(radius_km, MAX_RADIUS_KM),
            "sort": "price",
            "type": "e10",
            "apikey": api_key,
        },
        headers={"User-Agent": USER_AGENT},
        timeout=20,
    )
    response.raise_for_status()
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(f"Tankerkönig-fout: {data.get('message', 'onbekend')}")

    stations: list[NearbyStation] = []
    for row in data.get("stations", []):
        price = row.get("price")
        if not price or price <= 0 or row.get("isOpen") is False:
            continue
        street = " ".join(
            p for p in (row.get("street"), row.get("houseNumber")) if p
        ).strip().title()
        place = (row.get("place") or "").strip().title()
        postcode = str(row.get("postCode") or "").strip()
        name = (row.get("brand") or row.get("name") or "Tankstation").strip().title()
        stations.append(
            NearbyStation(
                id=str(row.get("id", "")),
                name=f"{name} {place}".strip(),
                municipality=place,
                address=", ".join(p for p in (street, f"{postcode} {place}".strip()) if p),
                price=float(price),
                distance_km=float(row.get("dist", 0.0)),
                url="",
                lat=row.get("lat"),
                lon=row.get("lng"),
            )
        )
    return stations
