"""Bijhouden van laatst gekende prijzen zodat we wijzigingen kunnen detecteren."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class PriceChange:
    station: str
    fuel: str
    old_price: float | None
    new_price: float
    changed_at: str
    currency: str = "EUR"


class PriceStore:
    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, dict[str, dict]] = {}
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8"))

    def diff_and_update(
        self, station: str, prices: dict[str, float], now: str | None = None
    ) -> list[PriceChange]:
        now = now or _now_iso()
        station_prices = self.data.setdefault(station, {})
        changes: list[PriceChange] = []

        for fuel, new_price in prices.items():
            entry = station_prices.get(fuel)
            old_price = entry["price"] if entry else None
            if old_price != new_price:
                changes.append(
                    PriceChange(
                        station=station,
                        fuel=fuel,
                        old_price=old_price,
                        new_price=new_price,
                        changed_at=now,
                    )
                )
                station_prices[fuel] = {"price": new_price, "changed_at": now}

        return changes

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(self.data, indent=2, sort_keys=True), encoding="utf-8"
        )
