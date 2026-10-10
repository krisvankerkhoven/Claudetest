"""SQLite-opslag. Twee tabellen: wines (identiteit + Vivino-score) en drinks (jouw proefmomenten)."""
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path

from . import config
from .matching import similarity, wine_key

SCHEMA = """
CREATE TABLE IF NOT EXISTS wines (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,            -- genormaliseerde producent+naam
    name TEXT NOT NULL,
    producer TEXT NOT NULL DEFAULT '',
    vivino_id TEXT,                      -- wine id
    vivino_score REAL,
    vivino_ratings INTEGER,
    score_updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_wines_vivino ON wines(vivino_id);
CREATE TABLE IF NOT EXISTS drinks (
    id INTEGER PRIMARY KEY,
    wine_id INTEGER NOT NULL REFERENCES wines(id),
    vintage INTEGER NOT NULL DEFAULT 0,  -- 0 = onbekend / NV
    drunk_on TEXT NOT NULL,              -- ISO-datum
    my_score REAL,
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,                -- sync | csv | whatsapp
    created_at TEXT NOT NULL,
    UNIQUE (wine_id, vintage, drunk_on)
);
CREATE TABLE IF NOT EXISTS seen_messages (id TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: str | None = None) -> sqlite3.Connection:
    path = path or config.get("DB_PATH", "data/wijnlog.db")
    if path != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=30, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    return con


@contextmanager
def session(path: str | None = None):
    con = connect(path)
    try:
        yield con
        con.commit()
    finally:
        con.close()


def upsert_wine(con, name: str, producer: str = "", vivino_id=None, score=None, ratings=None) -> int:
    key = wine_key(name, producer)
    row = None
    if vivino_id:
        row = con.execute("SELECT id FROM wines WHERE vivino_id=?", (str(vivino_id),)).fetchone()
    if not row:
        row = con.execute("SELECT id FROM wines WHERE key=?", (key,)).fetchone()
    if row:
        wid = row["id"]
        if vivino_id:
            con.execute("UPDATE wines SET vivino_id=COALESCE(vivino_id, ?) WHERE id=?", (str(vivino_id), wid))
        if score is not None:
            con.execute("UPDATE wines SET vivino_score=?, vivino_ratings=?, score_updated_at=? WHERE id=?",
                        (score, ratings, now(), wid))
        return wid
    cur = con.execute(
        "INSERT INTO wines(key,name,producer,vivino_id,vivino_score,vivino_ratings,score_updated_at) VALUES (?,?,?,?,?,?,?)",
        (key, name, producer, str(vivino_id) if vivino_id else None, score, ratings, now() if score is not None else None))
    return cur.lastrowid


def add_drink(con, wine_id: int, vintage: int | None, drunk_on: str | None, my_score, note: str, source: str) -> bool:
    """True als nieuw, False als dubbel (zelfde wijn, jaargang, datum). Bij dubbel: lege score/notitie aanvullen."""
    drunk_on = drunk_on or date.today().isoformat()
    cur = con.execute(
        "INSERT OR IGNORE INTO drinks(wine_id,vintage,drunk_on,my_score,note,source,created_at) VALUES (?,?,?,?,?,?,?)",
        (wine_id, vintage or 0, drunk_on, my_score, note or "", source, now()))
    if cur.rowcount:
        return True
    con.execute(
        "UPDATE drinks SET my_score=COALESCE(my_score, ?), note=CASE WHEN note='' THEN ? ELSE note END "
        "WHERE wine_id=? AND vintage=? AND drunk_on=?", (my_score, note or "", wine_id, vintage or 0, drunk_on))
    return False


def find_wines(con, query: str, limit: int = 5, threshold: float = 0.55):
    rows = con.execute("SELECT * FROM wines").fetchall()
    scored = sorted(((similarity(query, f"{r['producer']} {r['name']}"), r) for r in rows), key=lambda x: -x[0])
    return [r for s, r in scored[:limit] if s >= threshold]


def drinks_for(con, wine_id: int):
    return con.execute("SELECT * FROM drinks WHERE wine_id=? ORDER BY drunk_on DESC", (wine_id,)).fetchall()


def seen_before(con, msg_id: str) -> bool:
    return con.execute("INSERT OR IGNORE INTO seen_messages VALUES (?,?)", (msg_id, now())).rowcount == 0


def get_meta(con, k: str):
    r = con.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return r["v"] if r else None


def set_meta(con, k: str, v: str):
    con.execute("INSERT INTO meta VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))
