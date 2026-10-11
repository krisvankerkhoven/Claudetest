"""Stuurt een kledingadvies naar Homey voor de opgegeven locatie.

Homey start dit script (via workflow_dispatch) met je huidige locatie en met
de vraag of Gus die dag met de fiets naar school gaat (agenda-item "Kris Gus
brengen" of "Kristien Gus brengen"). Het resultaat gaat als WhatsApp-bericht
via een Homey webhook.
"""
from __future__ import annotations

import argparse
import logging
import os
from datetime import datetime, timezone

from tankprijzen import homey

from .advies import dagadvies, fietsadvies_gus
from .weer import geocode, uurweer, venster

log = logging.getLogger(__name__)

SCHOOL_UREN = (8, 9)
DAG_UREN = (8, 18)


def bouw_bericht(plaats_naam: str, dag, school, gus_fiets: bool) -> str:
    regels = [f"{plaats_naam}: " + dagadvies(dag)[0]] + dagadvies(dag)[1:]
    if gus_fiets:
        regels += fietsadvies_gus(school)
    return "\n".join(regels)


def run(location: str, gus_fiets: bool, dry_run: bool) -> int:
    webhook_url = os.environ.get("HOMEY_KLEDING_WEBHOOK_URL", "")
    plaats = geocode(location)
    log.info("Plaats: %s (%s) %.4f,%.4f", plaats.naam, plaats.land_code, plaats.lat, plaats.lon)
    hourly = uurweer(plaats)
    bericht = bouw_bericht(
        plaats.naam, venster(hourly, *DAG_UREN), venster(hourly, *SCHOOL_UREN), gus_fiets
    )
    log.info("Bericht:\n%s", bericht)

    payload = {
        "message": bericht,
        "place": plaats.naam,
        "country": plaats.land_code,
        "gus_bike": gus_fiets,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    if dry_run:
        log.info("Dry-run, geen webhook verstuurd.")
    elif webhook_url:
        homey.send(webhook_url, payload)
        log.info("Homey webhook verstuurd.")
    else:
        log.warning("Geen HOMEY_KLEDING_WEBHOOK_URL ingesteld, resultaat enkel gelogd.")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--location", required=True)
    parser.add_argument("--gus-fiets", default="false", help="true of false")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    raise SystemExit(run(args.location, args.gus_fiets.lower() == "true", args.dry_run))


if __name__ == "__main__":
    main()
