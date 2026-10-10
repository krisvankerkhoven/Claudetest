"""Apify en RapidAPI: betaalde fallbacks. Actor/host zijn configureerbaar omdat die per aanbieder verschillen.
Respons wordt tolerant gemapt via veldaliassen; pas ALIASES aan als jouw actor andere namen gebruikt."""
import json

import requests

from .. import config
from .base import SourceError, WineHit

ALIASES = {
    "name": ("name", "wine_name", "wineName", "title"),
    "producer": ("winery", "producer", "winery_name", "wineryName", "brand"),
    "vintage": ("year", "vintage"),
    "score": ("rating", "ratings_average", "average_rating", "averageRating", "score"),
    "ratings": ("ratings_count", "ratingsCount", "reviews", "num_ratings"),
    "id": ("wine_id", "wineId", "vivino_id", "id"),
    "url": ("url", "link"),
}


def _pick(d: dict, field: str):
    for k in ALIASES[field]:
        v = d.get(k)
        if isinstance(v, dict):  # bv. winery: {"name": ...}
            v = v.get("name")
        if v not in (None, ""):
            return v
    return None


def _num(v, cast):
    try:
        return cast(str(v).replace(",", ".")) if v is not None else None
    except ValueError:
        return None


def _to_hits(items) -> list[WineHit]:
    hits = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict) or not _pick(it, "name"):
            continue
        hits.append(WineHit(
            name=str(_pick(it, "name")), producer=str(_pick(it, "producer") or ""),
            vintage=_num(_pick(it, "vintage"), int), score=_num(_pick(it, "score"), float),
            ratings=_num(_pick(it, "ratings"), int),
            vivino_id=str(_pick(it, "id")) if _pick(it, "id") else None, url=_pick(it, "url")))
    return hits


class ApifySource:
    name = "apify"

    def search(self, query, vintage=None, limit=5):
        token, actor = config.get("APIFY_TOKEN"), config.get("APIFY_ACTOR")
        if not (token and actor):
            raise SourceError("apify niet geconfigureerd")
        q = f"{query} {vintage}" if vintage else query
        body = json.loads(config.get("APIFY_INPUT", '{"search": "{query}"}').replace("{query}", q.replace('"', "")))
        try:
            r = requests.post(f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items",
                              params={"token": token}, json=body, timeout=120)
            r.raise_for_status()
            return _to_hits(r.json())[:limit]
        except (requests.RequestException, ValueError) as e:
            raise SourceError(f"apify: {e}") from e


class RapidApiSource:
    name = "rapidapi"

    def search(self, query, vintage=None, limit=5):
        key, host = config.get("RAPIDAPI_KEY"), config.get("RAPIDAPI_HOST")
        if not (key and host):
            raise SourceError("rapidapi niet geconfigureerd")
        q = f"{query} {vintage}" if vintage else query
        try:
            r = requests.get(f"https://{host}{config.get('RAPIDAPI_PATH', '/search')}",
                             params={config.get("RAPIDAPI_QUERY_PARAM", "q"): q},
                             headers={"x-rapidapi-key": key, "x-rapidapi-host": host}, timeout=30)
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict):  # veelvoorkomende wrappers
                data = next((data[k] for k in ("results", "data", "wines", "items") if isinstance(data.get(k), list)), [])
            return _to_hits(data)[:limit]
        except (requests.RequestException, ValueError) as e:
            raise SourceError(f"rapidapi: {e}") from e
