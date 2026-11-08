"""Goedkoopste tankstation in Frankrijk via de officiële Franse open data.

Bron: data.economie.gouv.fr, dataset "prix-des-carburants-en-france-flux-instantane-v2"
(prix-carburants.gouv.fr, bijna realtime). Anders dan carbu.com (België) werkt
deze bron met coördinaten, dus het adres wordt eerst omgezet via de Franse
adresdienst api-adresse.data.gouv.fr (gratis, zonder sleutel).

Het resultaat wordt als NearbyStation teruggegeven, zodat find_cheapest en de
rest van de flow (webhook naar Homey) hetzelfde blijven als voor België.
"""
from __future__ import annotations

import math
import re

import requests

from .nearby import USER_AGENT, NearbyStation

DATASET_URL = (
    "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/"
    "prix-des-carburants-en-france-flux-instantane-v2/records"
)
ADDRESS_URL = "https://api-adresse.data.gouv.fr/search/"

_FRANCE_WORDS = ("france", "frankrijk", "frankreich", "francia")


def looks_french(text: str) -> bool:
    """Herkent een Frans adres: landnaam, of een vijfcijferige postcode zonder Belgische/Nederlandse vorm."""
    lowered = text.lower()
    if any(word in lowered for word in ("belgi", "belgique", "belgium", "nederland", "germany", "deutschland")):
        return False
    if any(word in lowered for word in _FRANCE_WORDS):
        return True
    return bool(re.search(r"(?<!\d)\d{5}(?!\d)", text))


def geocode(text: str) -> tuple[float, float, str]:
    """Zet een adres om naar (lat, lon, label) via api-adresse.data.gouv.fr."""
    # De adresdienst begrijpt de landnaam niet, die halen we weg.
    query = re.sub(r",?\s*(france|frankrijk|frankreich)\s*$", "", text, flags=re.I).strip()
    response = requests.get(
        ADDRESS_URL,
        params={"q": query, "limit": 1},
        headers={"User-Agent": USER_AGENT},
        timeout=15,
    )
    response.raise_for_status()
    features = response.json().get("features", [])
    if not features:
        raise ValueError(f"Geen Frans adres gevonden voor '{text}'")
    feature = features[0]
    lon, lat = feature["geometry"]["coordinates"]
    return lat, lon, feature["properties"].get("label", query)


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def fetch_france(
    fuel: str, lat: float, lon: float, radius_km: float
) -> list[NearbyStation]:
    """Haalt de stations binnen `radius_km` met een prijs voor `fuel`, goedkoopste eerst."""
    # Altijd E10 (in Frankrijk de standaard benzine); `fuel` wordt genegeerd.
    price_field = "e10_prix"

    response = requests.get(
        DATASET_URL,
        params={
            "where": (
                f"within_distance(geom, geom'POINT({lon} {lat})', {radius_km}km) "
                f"AND {price_field} > 0"
            ),
            "order_by": price_field,
            "limit": 100,
        },
        headers={"User-Agent": USER_AGENT},
        timeout=20,
    )
    response.raise_for_status()

    stations: list[NearbyStation] = []
    for row in response.json().get("results", []):
        price = row.get(price_field)
        geom = row.get("geom") or {}
        if not price or price <= 0 or "lat" not in geom or "lon" not in geom:
            continue
        city = (row.get("ville") or "").strip().title()
        street = (row.get("adresse") or "").strip().title()
        postcode = str(row.get("cp") or "").strip()
        stations.append(
            NearbyStation(
                id=str(row.get("id", "")),
                name=f"Tankstation {city}".strip(),
                municipality=city,
                address=", ".join(p for p in (street, f"{postcode} {city}".strip()) if p),
                price=float(price),
                distance_km=_haversine_km(lat, lon, geom["lat"], geom["lon"]),
                url="",
            )
        )
    return stations
