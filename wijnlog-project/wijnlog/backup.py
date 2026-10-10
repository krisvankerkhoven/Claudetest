"""Consistente SQLite-kopie + CSV-export, optioneel doorgezet naar externe opslag.
BACKUP_UPLOAD_CMD, bv. "rclone copy {file} gdrive:wijnlog". Gebruik: python -m wijnlog.backup"""
import csv
import logging
import shlex
import sqlite3
import subprocess
from datetime import date
from pathlib import Path

from . import config, db


def run() -> list[Path]:
    out_dir = Path(config.get("BACKUP_DIR", "data/backups"))
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = date.today().isoformat()
    db_file, csv_file = out_dir / f"wijnlog-{stamp}.db", out_dir / f"wijnlog-{stamp}.csv"
    with db.session() as con:
        dst = sqlite3.connect(db_file)
        con.backup(dst)
        dst.close()
        rows = con.execute("""SELECT w.name, w.producer, d.vintage, d.drunk_on, d.my_score, w.vivino_score,
                              w.vivino_id, d.note, d.source FROM drinks d JOIN wines w ON w.id=d.wine_id
                              ORDER BY d.drunk_on DESC""").fetchall()
    with open(csv_file, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["name", "producer", "vintage", "drunk_on", "my_score", "vivino_score", "vivino_id", "note", "source"])
        w.writerows([tuple(r) for r in rows])
    for old in sorted(out_dir.glob("wijnlog-*.db"))[:-30] + sorted(out_dir.glob("wijnlog-*.csv"))[:-30]:
        old.unlink()  # 30 dagen bewaren
    cmd = config.get("BACKUP_UPLOAD_CMD")
    if cmd:
        for f in (db_file, csv_file):
            subprocess.run([a.replace("{file}", str(f)) for a in shlex.split(cmd)], check=True, timeout=300)
    return [db_file, csv_file]


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    for p in run():
        print(p)
