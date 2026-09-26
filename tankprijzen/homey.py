"""Stuurt prijswijzigingen door naar een Homey Cloud webhook-flow."""
from __future__ import annotations

import json
import logging

import requests

from .storage import PriceChange

log = logging.getLogger(__name__)


def send(webhook_url: str, payload: dict, timeout: float = 10.0) -> None:
    """Stuurt een payload naar een Homey webhook-trigger.

    Homey's "Webhook ontvangen"-trigger (Logic-app) geeft de flow maar één
    ruwe tekst-tag mee, gevuld vanuit een query-parameter die letterlijk
    "tag" heet (niet vanuit de JSON-body en niet vanuit los benoemde
    query-parameters). We coderen de payload dus als JSON-tekst en geven
    die mee als waarde van die ene "tag"-parameter. In de Homey-flow wordt
    die tekst nadien met "Lees Tag als JSON en selecteer pad ..."
    (Better Logic-app) uitgesplitst in de afzonderlijke velden.
    """
    response = requests.post(
        webhook_url, params={"tag": json.dumps(payload)}, timeout=timeout
    )
    response.raise_for_status()


def notify(webhook_url: str, change: PriceChange, timeout: float = 10.0) -> None:
    """Stuurt een prijswijziging naar de Homey webhook-trigger.

    Velden: "station", "fuel", "price", "previous_price", "currency",
    "changed_at".
    """
    payload = {
        "station": change.station,
        "fuel": change.fuel,
        "price": change.new_price,
        "previous_price": change.old_price if change.old_price is not None else change.new_price,
        "currency": change.currency,
        "changed_at": change.changed_at,
    }

    send(webhook_url, payload, timeout=timeout)
    log.info(
        "Homey webhook verstuurd: %s %s -> %.3f", change.station, change.fuel, change.new_price
    )
