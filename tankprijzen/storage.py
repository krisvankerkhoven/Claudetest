"""Bijhouden van laatst gekende prijzen zodat we wijzigingen kunnen detecteren."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass
class PriceChange:
    station: str
    fuel: str
    old_price: float | None
    new_price: float
    currency: str = "EUR"


class PriceStore:
    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, dict[str, float]] = {}
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8"))

    def diff_and_update(
        self, station: str, prices: dict[str, float]
    ) -> list[PriceChange]:
        station_prices = self.data.setdefault(station, {})
        changes: list[PriceChange] = []

        for fuel, new_price in prices.items():
            old_price = station_prices.get(fuel)
            if old_price != new_price:
                changes.append(
                    PriceChange(
                        station=station,
                        fuel=fuel,
                        old_price=old_price,
                        new_price=new_price,
                    )
                )
            station_prices[fuel] = new_price

        return changes

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(self.data, indent=2, sort_keys=True), encoding="utf-8"
        )
