"""Sync van eigen Vivino-ratings (onofficieel). Gebruik: python -m wijnlog.sync [--force]

Faalt zacht: bij login- of endpointproblemen eindigt het met een duidelijke melding en exitcode 2.
Back-up-route is dan `python -m wijnlog.import_csv <export.csv>`.
"""
import argparse
import logging
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

from . import config, db

BASE = "https://www.vivino.com"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
# Kandidaat-endpoints, in volgorde; het eerste dat JSON met items geeft wint. Pas aan na `probe_vivino.py`.
ENDPOINTS = ["/api/users/{uid}/reviews", "/api/users/{uid}/user_vintages", "/api/users/{uid}/activity_stream"]
PAGE_SIZE, MAX_PAGES, PAUSE = 25, 40, 3.0
log = logging.getLogger("sync")


class SyncError(Exception):
    pass


def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept": "application/json, text/plain, */*", "Accept-Language": "en"})
    return s


def login(s: requests.Session) -> None:
    cookie = config.get("VIVINO_COOKIE")
    if cookie:
        s.headers["Cookie"] = cookie
        return
    email, pw = config.get("VIVINO_EMAIL"), config.get("VIVINO_PASSWORD")
    if not (email and pw):
        raise SyncError("Geen VIVINO_EMAIL/VIVINO_PASSWORD of VIVINO_COOKIE in .env")
    headers = {"Content-Type": "application/json", "Origin": BASE, "Referer": BASE + "/"}
    home = s.get(BASE + "/", timeout=25)
    m = (re.search(r'name="csrf-token"\s+content="([^"]+)"', home.text)
         or re.search(r'content="([^"]+)"\s+name="csrf-token"', home.text))
    if m:
        headers["X-CSRF-Token"] = m.group(1)
    time.sleep(PAUSE)
    r = s.post(BASE + "/api/login", json={"email": email, "password": pw}, headers=headers, timeout=25)
    if r.status_code != 200:
        raise SyncError(f"Login mislukt (HTTP {r.status_code}). Bot-bescherming of gewijzigde API? "
                        "Zet een browsercookie in VIVINO_COOKIE of gebruik de CSV-import.")
    s.headers.update({k: v for k, v in headers.items() if k == "X-CSRF-Token"})


def user_id(s: requests.Session) -> str:
    r = s.get(BASE + "/api/users/me", timeout=25)
    try:
        uid = r.json().get("id")
    except ValueError:
        uid = None
    if r.status_code != 200 or not uid:
        raise SyncError(f"Kon gebruikers-id niet ophalen (HTTP {r.status_code}). Sessie ongeldig?")
    return str(uid)


def _items(payload) -> list:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for k in ("reviews", "user_vintages", "activities", "items", "data"):
            if isinstance(payload.get(k), list):
                return payload[k]
    return []


def fetch_all(s: requests.Session, uid: str) -> list[dict]:
    for tpl in ENDPOINTS:
        out, ok = [], False
        for page in range(1, MAX_PAGES + 1):
            time.sleep(PAUSE)
            r = s.get(BASE + tpl.format(uid=uid), params={"page": page, "per_page": PAGE_SIZE}, timeout=25)
            if r.status_code != 200 or "json" not in r.headers.get("content-type", ""):
                log.warning("%s pagina %d: HTTP %s", tpl, page, r.status_code)
                break
            items = _items(r.json())
            ok = True
            if not items:
                break
            out.extend(items)
            if len(items) < PAGE_SIZE:
                break
        if ok and out:
            log.info("endpoint %s: %d items", tpl, len(out))
            return out
    raise SyncError("Geen enkel ratings-endpoint gaf bruikbare data. API gewijzigd? Gebruik de CSV-import.")


def parse_item(it: dict) -> dict | None:
    """Tolerant: ondersteunt review-, user_vintage- en activity-vormen. None als geen rating."""
    it = it.get("review") or it.get("activity") or it
    vint = it.get("vintage") or {}
    wine = vint.get("wine") or it.get("wine") or {}
    winery = wine.get("winery") or {}
    name = wine.get("name") or vint.get("name")
    rating = it.get("rating") or (it.get("user_rating") or {}).get("rating")
    if not name or not rating:
        return None
    year = vint.get("year") or it.get("year")
    when = it.get("created_at") or it.get("updated_at") or it.get("rated_at") or ""
    return {
        "name": name, "producer": winery.get("name", ""), "vivino_id": wine.get("id"),
        "vintage": int(year) if str(year).isdigit() else None,
        "score": float(rating), "date": when[:10] if re.match(r"\d{4}-\d{2}-\d{2}", when) else None,
        "note": it.get("note") or "", "avg": (vint.get("statistics") or {}).get("ratings_average"),
    }


def store(con, items: list[dict]) -> tuple[int, int]:
    new = dup = 0
    for it in items:
        p = parse_item(it)
        if not p or not p["date"]:
            continue
        wid = db.upsert_wine(con, p["name"], p["producer"], p["vivino_id"], p["avg"] or None)
        if db.add_drink(con, wid, p["vintage"], p["date"], p["score"], p["note"], "sync"):
            new += 1
        else:
            dup += 1
    return new, dup


def run(force: bool = False) -> int:
    with db.session() as con:
        last = db.get_meta(con, "last_sync")
        min_h = float(config.get("SYNC_MIN_INTERVAL_HOURS", "6"))
        if last and not force and datetime.now(timezone.utc) - datetime.fromisoformat(last) < timedelta(hours=min_h):
            log.info("Laatste sync was %s, minimum interval %sh. Gebruik --force om te negeren.", last, min_h)
            return 0
        db.set_meta(con, "last_sync", db.now())  # ook bij falen: voorkomt hameren op een kapotte login
        con.commit()
        s = _session()
        try:
            login(s)
            items = fetch_all(s, user_id(s))
        except (SyncError, requests.RequestException) as e:
            log.error("%s", e)
            return 2
        new, dup = store(con, items)
        log.info("Sync klaar: %d nieuw, %d reeds bekend", new, dup)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    sys.exit(run(ap.parse_args().force))
