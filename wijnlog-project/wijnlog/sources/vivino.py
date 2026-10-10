"""Onofficiële Vivino-zoekopdracht (explore-endpoint). Kan zonder waarschuwing breken."""
import requests

from .. import config
from .base import SourceError, WineHit

URL = "https://www.vivino.com/api/explore/explore"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


class VivinoSource:
    name = "vivino"

    def search(self, query, vintage=None, limit=5):
        params = {"country_code": config.get("COUNTRY_CODE", "BE"), "currency_code": "EUR",
                  "q": f"{query} {vintage}" if vintage else query,
                  "min_rating": 1, "order_by": "ratings_count", "order": "desc", "page": 1, "per_page": 25}
        try:
            r = requests.get(URL, params=params, headers={"User-Agent": UA, "Accept": "application/json"}, timeout=20)
        except requests.RequestException as e:
            raise SourceError(f"vivino netwerk: {e}") from e
        if r.status_code != 200 or "json" not in r.headers.get("content-type", ""):
            raise SourceError(f"vivino HTTP {r.status_code}")
        try:
            matches = r.json()["explore_vintage"]["matches"]
        except (KeyError, ValueError) as e:
            raise SourceError("vivino: onverwachte respons") from e
        hits = []
        for m in matches:
            v = m.get("vintage") or {}
            w = v.get("wine") or {}
            st = v.get("statistics") or {}
            year = v.get("year")
            hits.append(WineHit(
                name=w.get("name") or v.get("name", ""),
                producer=(w.get("winery") or {}).get("name", ""),
                vintage=int(year) if str(year).isdigit() else None,
                score=st.get("ratings_average") or None,
                ratings=st.get("ratings_count"),
                vivino_id=str(w["id"]) if w.get("id") else None,
                url=f"https://www.vivino.com/w/{w['id']}" if w.get("id") else None))
        if vintage:  # jaargang eerst; zonder jaargang blijft de populariteitsvolgorde
            hits.sort(key=lambda h: h.vintage != vintage)
        return hits[:limit]
