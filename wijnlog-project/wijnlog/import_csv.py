"""Import van de officiële Vivino-export (CSV). Idempotent. Gebruik: python -m wijnlog.import_csv <bestand.csv> [...]
Kolomnamen worden tolerant herkend (hoofdletterongevoelig, meerdere aliassen)."""
import csv
import logging
import re
import sys
from datetime import datetime

from . import db

COLS = {
    "name": ("wine name", "wine", "name", "wine_name"),
    "producer": ("winery", "producer", "winery name"),
    "vintage": ("vintage", "year"),
    "score": ("your rating", "user rating", "my rating", "rating", "your_rating"),
    "date": ("rating date", "rated at", "scan date", "date", "created at", "created_at", "scan/review date"),
    "note": ("your review", "review", "note", "notes", "comment", "your note"),
    "vivino_id": ("wine id", "wine_id", "vivino id"),
    "avg": ("average rating", "avg rating", "wine rating"),
}
DATE_FMTS = ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%d.%m.%Y")


def parse_date(v: str) -> str | None:
    v = (v or "").strip()
    v = re.sub(r"(\.\d+)?(Z|[+-]\d\d:?\d\d| UTC)$", "", v)
    for f in DATE_FMTS:
        try:
            return datetime.strptime(v, f).date().isoformat()
        except ValueError:
            pass
    return None


def _num(v, cast):
    try:
        return cast(str(v).strip().replace(",", ".")) if str(v).strip() else None
    except ValueError:
        return None


def import_file(con, path: str) -> tuple[int, int, int]:
    new = dup = skipped = 0
    with open(path, newline="", encoding="utf-8-sig") as f:
        sample = f.read(4096)
        f.seek(0)
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t") if sample else csv.excel
        rd = csv.DictReader(f, dialect=dialect)
        header = {(h or "").strip().lower(): h for h in rd.fieldnames or []}
        col = {k: next((header[a] for a in al if a in header), None) for k, al in COLS.items()}
        if not col["name"]:
            raise SystemExit(f"{path}: geen naamkolom gevonden in {list(header)}")
        for row in rd:
            g = lambda k: (row.get(col[k]) or "").strip() if col[k] else ""
            date = parse_date(g("date"))
            if not g("name") or not date:
                skipped += 1
                continue
            score = _num(g("score"), float)
            if score is not None and not 0 < score <= 5:
                score = None
            vint = _num(g("vintage"), int)
            wid = db.upsert_wine(con, g("name"), g("producer"), g("vivino_id") or None, _num(g("avg"), float))
            if db.add_drink(con, wid, vint, date, score, g("note"), "csv"):
                new += 1
            else:
                dup += 1
    return new, dup, skipped


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    with db.session() as con:
        for p in sys.argv[1:]:
            n, d, s = import_file(con, p)
            print(f"{p}: {n} nieuw, {d} dubbel, {s} overgeslagen (geen naam of datum)")
