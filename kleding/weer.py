"""Haalt het weer op voor een adres: geocoding via Nominatim, weer via Open-Meteo."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import requests

log = logging.getLogger(__name__)

USER_AGENT = "KledingAdviesBot/1.0 (+https://github.com/krisvankerkhoven/claudetest)"


@dataclass
class Plaats:
    naam: str
    land_code: str
    lat: float
    lon: float


@dataclass
class Venster:
    """Samenvatting van het weer in een tijdsvenster (lokale uren)."""
    temp_min: float
    temp_max: float
    gevoel_min: float
    gevoel_max: float
    regenkans: int
    regen_mm: float
    wind_max: float
    windstoten_max: float


COORDINATEN = re.compile(r"^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$")


def _plaats_uit(item: dict, fallback: str) -> Plaats:
    adr = item.get("address", {})
    naam = (adr.get("village") or adr.get("town") or adr.get("city")
            or adr.get("municipality") or item.get("name") or fallback)
    return Plaats(naam, adr.get("country_code", "").upper(),
                  float(item["lat"]), float(item["lon"]))


def reverse_geocode(lat: float, lon: float) -> Plaats:
    response = requests.get(
        "https://nominatim.openstreetmap.org/reverse",
        params={"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 14,
                "accept-language": "nl"},
        headers={"User-Agent": USER_AGENT},
        timeout=15,
    )
    response.raise_for_status()
    item = response.json()
    if "lat" not in item:
        return Plaats(f"{lat:.3f},{lon:.3f}", "", lat, lon)
    return _plaats_uit(item, f"{lat:.3f},{lon:.3f}")


def geocode(adres: str) -> Plaats:
    """Zet een adres of 'lat,lon' om naar een plaats. Probeert telkens een korter adres."""
    coord = COORDINATEN.match(adres)
    if coord:
        return reverse_geocode(float(coord.group(1)), float(coord.group(2)))
    delen = [d.strip() for d in adres.split(",") if d.strip()]
    if not delen:
        raise ValueError("Lege locatie")
    for start in range(len(delen)):
        query = ", ".join(delen[start:])
        response = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": query, "format": "jsonv2", "addressdetails": 1, "limit": 1,
                    "accept-language": "nl"},
            headers={"User-Agent": USER_AGENT},
            timeout=15,
        )
        response.raise_for_status()
        items = response.json()
        if items:
            return _plaats_uit(items[0], query)
    raise ValueError(f"Locatie niet gevonden: {adres}")


def uurweer(plaats: Plaats) -> dict:
    response = requests.get(
        "https://api.open-meteo.com/v1/forecast",
        params={
            "latitude": plaats.lat,
            "longitude": plaats.lon,
            "hourly": "temperature_2m,apparent_temperature,precipitation_probability,"
                      "precipitation,wind_speed_10m,wind_gusts_10m",
            "wind_speed_unit": "kmh",
            "timezone": "auto",
            "forecast_days": 1,
        },
        timeout=15,
    )
    response.raise_for_status()
    return response.json()["hourly"]


def venster(hourly: dict, van_uur: int, tot_uur: int) -> Venster:
    """Samenvatting voor de uren [van_uur, tot_uur] (lokale tijd, inclusief)."""
    idx = [i for i, t in enumerate(hourly["time"]) if van_uur <= int(t[11:13]) <= tot_uur]
    if not idx:
        raise ValueError("Geen weerdata voor het gevraagde tijdsvenster")

    def waarden(sleutel: str) -> list[float]:
        return [hourly[sleutel][i] for i in idx if hourly[sleutel][i] is not None]

    temp, gevoel = waarden("temperature_2m"), waarden("apparent_temperature")
    return Venster(
        temp_min=min(temp), temp_max=max(temp),
        gevoel_min=min(gevoel), gevoel_max=max(gevoel),
        regenkans=int(max(waarden("precipitation_probability") or [0])),
        regen_mm=round(sum(waarden("precipitation")), 1),
        wind_max=max(waarden("wind_speed_10m")),
        windstoten_max=max(waarden("wind_gusts_10m")),
    )
