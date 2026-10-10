"""Gezondheidscheck van alle Vivino-afhankelijkheden, met dezelfde code als productie.
Gebruik: python -m wijnlog.check [--no-login] [--dump-sample]

Schrijft data/check_report.json met enkel structuur (sleutels, types, tellers), geen waarden.
--dump-sample schrijft daarnaast data/check_sample.json met het eerste ruwe rating-item, MET waarden.
Controleer dat bestand zelf voor je het deelt. Exitcode 0 = alles werkt, 1 = iets faalt.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import requests

from . import config, sync
from .sources import configured_sources
from .sources.base import SourceError


def shape(o, depth=0):
    if isinstance(o, dict):
        return {k: (shape(v, depth + 1) if depth < 2 else type(v).__name__) for k, v in list(o.items())[:20]}
    if isinstance(o, list):
        return [f"list[{len(o)}]"] + ([shape(o[0], depth + 1)] if o else [])
    return type(o).__name__


def check_search() -> list[dict]:
    out = []
    for src in configured_sources():
        t0 = time.time()
        r = {"source": src.name, "ok": False}
        try:
            hits = src.search("chateau margaux", 2015, 5)
            r.update(ok=bool(hits), hits=len(hits), with_score=sum(h.score is not None for h in hits),
                     with_id=sum(bool(h.vivino_id) for h in hits),
                     top_has_vintage=bool(hits and hits[0].vintage))
            if not hits:
                r["error"] = "0 resultaten"
        except SourceError as e:
            r["error"] = str(e)
        r["seconds"] = round(time.time() - t0, 1)
        out.append(r)
    return out


def check_account(dump_sample: bool, data_dir: Path) -> dict:
    rep = {"login": False, "user_id": False, "endpoints": []}
    s = sync._session()
    try:
        sync.login(s)
        rep["login"] = True
        uid = sync.user_id(s)
        rep["user_id"] = True
    except (sync.SyncError, requests.RequestException) as e:
        rep["error"] = str(e)
        return rep
    for tpl in sync.ENDPOINTS:
        time.sleep(sync.PAUSE)
        e = {"endpoint": tpl, "ok": False}
        try:
            r = s.get(sync.BASE + tpl.format(uid=uid), params={"page": 1, "per_page": 10}, timeout=25)
            e["http"] = r.status_code
            if "json" in r.headers.get("content-type", ""):
                payload = r.json()
                items = sync._items(payload)
                parsed = [sync.parse_item(i) for i in items]
                good = [p for p in parsed if p]
                e.update(ok=bool(good), items=len(items), parsed_ok=len(good),
                         with_date=sum(bool(p["date"]) for p in good), with_vintage=sum(p["vintage"] is not None for p in good),
                         with_wine_id=sum(bool(p["vivino_id"]) for p in good),
                         top_level=shape(payload), first_item=shape(items[0]) if items else None)
                if items and not good:
                    e["error"] = "items gevonden maar parse_item herkent geen rating/naam: mapping aanpassen"
                if dump_sample and items:
                    (data_dir / "check_sample.json").write_text(json.dumps(items[0], indent=2, ensure_ascii=False))
        except (requests.RequestException, ValueError) as ex:
            e["error"] = type(ex).__name__
        rep["endpoints"].append(e)
    return rep


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-login", action="store_true")
    ap.add_argument("--dump-sample", action="store_true")
    a = ap.parse_args(argv)
    data_dir = Path(config.get("DB_PATH", "data/wijnlog.db")).parent
    data_dir.mkdir(parents=True, exist_ok=True)
    report = {"search": check_search()}
    if not a.no_login:
        report["account"] = check_account(a.dump_sample, data_dir)
    (data_dir / "check_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))

    ok = any(s["ok"] for s in report["search"])
    print("ZOEKEN")
    for s in report["search"]:
        print(f"  [{'OK  ' if s['ok'] else 'FAIL'}] {s['source']}: {s.get('hits', 0)} hits, "
              f"{s.get('with_score', 0)} met score, {s['seconds']}s {s.get('error', '')}")
    if "account" in report:
        acc = report["account"]
        print("ACCOUNT")
        print(f"  [{'OK  ' if acc['login'] else 'FAIL'}] login  [{'OK  ' if acc['user_id'] else 'FAIL'}] user-id {acc.get('error', '')}")
        for e in acc["endpoints"]:
            print(f"  [{'OK  ' if e['ok'] else 'FAIL'}] {e['endpoint']}: HTTP {e.get('http')}, "
                  f"{e.get('parsed_ok', 0)}/{e.get('items', 0)} items geparsed {e.get('error', '')}")
        ok = ok and any(e["ok"] for e in acc["endpoints"])
    print(f"\nRapport: {data_dir / 'check_report.json'}  (alleen structuur, geen waarden)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
