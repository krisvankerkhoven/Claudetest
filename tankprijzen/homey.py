"""Stuurt prijswijzigingen door naar een Homey Cloud webhook-flow."""
from __future__ import annotations

import logging

import requests

from .storage import PriceChange

log = logging.getLogger(__name__)


def notify(webhook_url: str, change: PriceChange, timeout: float = 10.0) -> None:
    """POST de wijziging naar de Homey webhook-trigger.

    De tags hieronder ("station", "fuel", "price", "previous_price", "currency")
    moeten overeenkomen met de tags die je in de Homey-flow-trigger "Webhooks
    ontvangen" hebt gedefinieerd.
    """
    payload = {
        "station": change.station,
        "fuel": change.fuel,
        "price": change.new_price,
        "previous_price": change.old_price if change.old_price is not None else change.new_price,
        "currency": change.currency,
    }

    response = requests.post(webhook_url, json=payload, timeout=timeout)
    response.raise_for_status()
    log.info(
        "Homey webhook verstuurd: %s %s -> %.3f", change.station, change.fuel, change.new_price
    )
