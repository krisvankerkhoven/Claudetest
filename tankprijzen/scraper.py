"""Haalt brandstofprijzen van een tankstation-pagina.

De exacte opmaak van tankstation-websites verschilt per merk en kan wijzigen.
Om niet afhankelijk te zijn van één specifieke CSS-selector werkt dit op drie
niveaus, van goedkoop naar duur:

1. JSON-LD (schema.org Product/Offer) in <script type="application/ld+json">,
   als de site dat aanbiedt.
2. Label/prijs-koppeling in de statische HTML: zoek gekende brandstofnamen
   (Diesel, Euro 95, ...) en de dichtstbijzijnde prijs (bv. "1,769") in
   dezelfde container.
3. Als de statische HTML niets oplevert (veel prijzenpagina's laden de
   prijzen via JavaScript), wordt de pagina gerenderd met Playwright
   (headless Chromium) en wordt stap 2 herhaald op de gerenderde HTML.

LET OP: dit is geschreven zonder de pagina live te kunnen inspecteren
(netwerktoegang naar dats24.be was geblokkeerd in de ontwikkelomgeving).
Draai `python -m tankprijzen.main --dry-run` en controleer of de juiste
brandstoffen/prijzen eruit komen; zo niet, pas FUEL_ALIASES of de selectors
hieronder aan op basis van de echte pagina-bron.
"""
from __future__ import annotations

import json
import logging
import re

import requests
from bs4 import BeautifulSoup

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (compatible; TankprijzenBot/1.0; "
    "+https://github.com/krisvankerkhoven/claudetest)"
)

# Normalisatienaam -> mogelijke tekstvarianten op de website (kleine letters).
FUEL_ALIASES: dict[str, list[str]] = {
    "diesel": ["diesel", "gasoil", "b7"],
    "premium_diesel": ["excellium diesel", "premium diesel", "v-power diesel"],
    "euro95": ["euro 95", "euro95", "e10"],
    "euro98": ["euro 98", "euro98", "excellium 98", "v-power"],
    "lpg": ["lpg", "autogas"],
    "adblue": ["adblue"],
}

PRICE_RE = re.compile(r"(\d{1,2}[.,]\d{2,3})\s*(?:€|eur)?")


def _normalize_fuel(label: str) -> str | None:
    label_lc = label.strip().lower()
    for canonical, aliases in FUEL_ALIASES.items():
        if any(alias in label_lc for alias in aliases):
            return canonical
    return None


def _parse_price(text: str) -> float | None:
    match = PRICE_RE.search(text)
    if not match:
        return None
    return float(match.group(1).replace(",", "."))


def _from_json_ld(soup: BeautifulSoup) -> dict[str, float]:
    prices: dict[str, float] = {}
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
        except (json.JSONDecodeError, TypeError):
            continue

        items = data if isinstance(data, list) else [data]
        for item in items:
            offers = item.get("offers") if isinstance(item, dict) else None
            if not offers:
                continue
            offers = offers if isinstance(offers, list) else [offers]
            for offer in offers:
                name = item.get("name", "")
                price = offer.get("price")
                fuel = _normalize_fuel(name)
                if fuel and price is not None:
                    try:
                        prices[fuel] = float(price)
                    except (TypeError, ValueError):
                        pass
    return prices


def _from_label_price_pairs(soup: BeautifulSoup) -> dict[str, float]:
    prices: dict[str, float] = {}

    # Zoek elk tekst-element dat een brandstofnaam bevat, en kijk in de
    # omliggende container (parent, tot 3 niveaus omhoog) naar een prijspatroon.
    for node in soup.find_all(string=True):
        fuel = _normalize_fuel(str(node))
        if not fuel or fuel in prices:
            continue

        container = node.parent
        for _ in range(3):
            if container is None:
                break
            price = _parse_price(container.get_text(" ", strip=True))
            if price is not None:
                prices[fuel] = price
                break
            container = container.parent

    return prices


def _parse_html(html: str) -> dict[str, float]:
    soup = BeautifulSoup(html, "html.parser")

    prices = _from_json_ld(soup)
    if prices:
        return prices

    return _from_label_price_pairs(soup)


def _fetch_static(url: str) -> str:
    response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=15)
    response.raise_for_status()
    return response.text


def _fetch_rendered(url: str) -> str:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(user_agent=USER_AGENT)
            page.goto(url, wait_until="networkidle", timeout=30_000)
            html = page.content()
        finally:
            browser.close()
    return html


def fetch_prices(url: str) -> dict[str, float]:
    """Geeft {brandstof: prijs} terug voor de gegeven tankstation-URL."""
    html = _fetch_static(url)
    prices = _parse_html(html)
    if prices:
        return prices

    log.info("Geen prijzen in statische HTML voor %s, probeer gerenderde pagina.", url)
    html = _fetch_rendered(url)
    return _parse_html(html)
