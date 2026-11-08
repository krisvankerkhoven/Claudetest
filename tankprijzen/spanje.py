"""Goedkoopste tankstation in Spanje via de officiële overheidsdata.

Bron: Ministerio para la Transición Ecológica (geoportalgasolineras.es),
REST-dienst "PreciosCarburantes". Eén aanroep levert alle ~12.000 Spaanse
stations met prijzen (dagelijks bijgewerkt, meerdere keren per dag); filteren
op afstand doen we hier zelf. Geen sleutel nodig.

Het adres wordt omgezet via Nominatim (OpenStreetMap), beperkt tot Spanje.
Het resultaat is een lijst NearbyStation, zodat find_cheapest_n en de rest van
de flow hetzelfde blijven als voor de andere landen.

Brandstof: E10 ("Precio Gasolina 95 E10"). Veel Spaanse stations verkopen
alleen E5; dan gebruiken we die prijs ("Precio Gasolina 95 E5").
"""
from __future__ import annotations

import json
import math

import requests

from .nearby import USER_AGENT, NearbyStation

STATIONS_URL = (
    "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/"
    "PreciosCarburantes/EstacionesTerrestres/"
)
GEOCODE_URL = "https://nominatim.openstreetmap.org/search"

E10_FIELD = "Precio Gasolina 95 E10"
E5_FIELD = "Precio Gasolina 95 E5"

_SPAIN_WORDS = ("spain", "españa", "espana", "spanje", "espagne", "spanien")


def looks_spanish(text: str) -> bool:
    """Herkent een Spaans adres aan de landnaam."""
    lowered = text.lower()
    return any(word in lowered for word in _SPAIN_WORDS)


def geocode(text: str) -> tuple[float, float, str]:
    """Zet een adres om naar (lat, lon, label) via Nominatim, beperkt tot Spanje."""
    response = requests.get(
        GEOCODE_URL,
        params={"q": text, "format": "jsonv2", "limit": 1, "countrycodes": "es"},
        headers={"User-Agent": USER_AGENT},
        timeout=15,
    )
    response.raise_for_status()
    items = response.json()
    if not items:
        raise ValueError(f"Geen Spaans adres gevonden voor '{text}'")
    item = items[0]
    return float(item["lat"]), float(item["lon"]), item.get("display_name", text)


def _number(value: str | None) -> float | None:
    """Spaanse getallen hebben een decimale komma ("1,459"); leeg betekent: niet verkocht."""
    if not value:
        return None
    try:
        return float(value.replace(",", "."))
    except ValueError:
        return None


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def fetch_spain(lat: float, lon: float, radius_km: float) -> list[NearbyStation]:
    """Haalt de stations binnen `radius_km` met een E10- of E5-prijs op."""
    response = requests.get(
        STATIONS_URL,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        timeout=90,
    )
    response.raise_for_status()
    # De dienst levert JSON met een BOM, vandaar utf-8-sig.
    data = json.loads(response.content.decode("utf-8-sig"))

    # Grove vierkant als voorfilter, zodat we niet 12.000x een haversine doen.
    dlat = radius_km / 111.0
    dlon = radius_km / (111.0 * max(math.cos(math.radians(lat)), 0.01))

    stations: list[NearbyStation] = []
    for row in data.get("ListaEESSPrecio", []):
        s_lat = _number(row.get("Latitud"))
        s_lon = _number(row.get("Longitud (WGS84)"))
        if s_lat is None or s_lon is None:
            continue
        if abs(s_lat - lat) > dlat or abs(s_lon - lon) > dlon:
            continue
        price = _number(row.get(E10_FIELD)) or _number(row.get(E5_FIELD))
        if not price or price <= 0:
            continue
        distance = _haversine_km(lat, lon, s_lat, s_lon)
        if distance > radius_km:
            continue
        brand = (row.get("Rótulo") or "Tankstation").strip().title()
        town = (row.get("Municipio") or row.get("Localidad") or "").strip().title()
        street = (row.get("Dirección") or "").strip().title()
        postcode = (row.get("C.P.") or "").strip()
        stations.append(
            NearbyStation(
                id=str(row.get("IDEESS", "")),
                name=f"{brand} {town}".strip(),
                municipality=town,
                address=", ".join(p for p in (street, f"{postcode} {town}".strip()) if p),
                price=price,
                distance_km=distance,
                url="",
            )
        )
    return stations
