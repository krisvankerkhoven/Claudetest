"""Configuratie laden uit config.yaml, met env-var overrides voor secrets."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class Station:
    name: str
    url: str
    fuels: list[str] = field(default_factory=list)


@dataclass
class Config:
    stations: list[Station]
    homey_webhook_url: str
    storage_path: Path


def load_config(path: str | Path = "config.yaml") -> Config:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(
            f"{path} niet gevonden. Kopieer config.example.yaml naar {path} en vul aan."
        )

    with path.open(encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    stations = [
        Station(name=s["name"], url=s["url"], fuels=s.get("fuels") or [])
        for s in raw.get("stations", [])
    ]
    if not stations:
        raise ValueError(f"Geen tankstations geconfigureerd in {path}.")

    # HOMEY_WEBHOOK_URL (env/secret) heeft voorrang op config.yaml zodat de URL
    # nooit in de repo hoeft te staan (bv. GitHub Actions secret).
    webhook_url = os.environ.get("HOMEY_WEBHOOK_URL") or raw.get("homey", {}).get(
        "webhook_url", ""
    )

    storage_path = Path(raw.get("storage", {}).get("path", "data/prices.json"))

    return Config(
        stations=stations, homey_webhook_url=webhook_url, storage_path=storage_path
    )
