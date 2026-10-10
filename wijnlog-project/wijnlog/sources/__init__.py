"""Eén ingang: lookup() probeert de bronnen uit SCORE_SOURCES in volgorde."""
import logging

from .. import config
from .base import ScoreSource, SourceError, WineHit
from .generic import ApifySource, RapidApiSource
from .vivino import VivinoSource

REGISTRY = {"vivino": VivinoSource, "apify": ApifySource, "rapidapi": RapidApiSource}
log = logging.getLogger(__name__)


def configured_sources() -> list[ScoreSource]:
    return [REGISTRY[n]() for n in config.get_list("SCORE_SOURCES") if n in REGISTRY] or [VivinoSource()]


def lookup(query: str, vintage: int | None = None, limit: int = 5, sources=None) -> tuple[list[WineHit], str, list[str]]:
    """Geeft (hits, bronnaam, foutmeldingen). Een bron zonder resultaat telt als mislukt en geeft door."""
    errors = []
    for src in sources or configured_sources():
        try:
            hits = src.search(query, vintage, limit)
            if hits:
                return hits, src.name, errors
            errors.append(f"{src.name}: geen resultaat")
        except SourceError as e:
            log.warning("bron %s faalde: %s", src.name, e)
            errors.append(str(e))
    return [], "", errors
