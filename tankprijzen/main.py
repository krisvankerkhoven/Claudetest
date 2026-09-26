"""Controleert de geconfigureerde tankstations op prijswijzigingen en
stuurt die door naar Homey."""
from __future__ import annotations

import argparse
import logging

from . import homey
from .config import load_config
from .scraper import fetch_prices
from .storage import PriceStore

log = logging.getLogger(__name__)


def run(config_path: str, dry_run: bool) -> int:
    config = load_config(config_path)
    store = PriceStore(config.storage_path)

    if not dry_run and not config.homey_webhook_url:
        log.warning(
            "Geen Homey webhook-URL geconfigureerd (config.yaml of "
            "HOMEY_WEBHOOK_URL). Wijzigingen worden alleen gelogd."
        )

    exit_code = 0
    for station in config.stations:
        try:
            prices = fetch_prices(station.url)
        except Exception:
            log.exception("Kon prijzen niet ophalen voor %s (%s)", station.name, station.url)
            exit_code = 1
            continue

        if station.fuels:
            prices = {f: p for f, p in prices.items() if f in station.fuels}

        if not prices:
            log.warning(
                "Geen brandstofprijzen gevonden op %s. Selectors in "
                "scraper.py moeten waarschijnlijk aangepast worden.",
                station.url,
            )
            exit_code = 1
            continue

        log.info("%s: %s", station.name, prices)

        changes = store.diff_and_update(station.name, prices)
        for change in changes:
            if change.old_price is None:
                log.info(
                    "%s %s: eerste keer gezien op %.3f", change.station, change.fuel, change.new_price
                )
                continue  # geen notificatie bij de allereerste meting

            log.info(
                "%s %s: %.3f -> %.3f", change.station, change.fuel, change.old_price, change.new_price
            )
            if dry_run:
                continue
            if config.homey_webhook_url:
                try:
                    homey.notify(config.homey_webhook_url, change)
                except Exception:
                    log.exception("Homey-notificatie mislukt voor %s %s", change.station, change.fuel)
                    exit_code = 1

    if not dry_run:
        store.save()

    return exit_code


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config.yaml", help="Pad naar config.yaml")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Toon prijzen/wijzigingen zonder Homey te notificeren of state op te slaan",
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
