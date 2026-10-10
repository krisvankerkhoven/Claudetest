"""Berichtlogica, los van WhatsApp. handle_text() geeft de antwoordtekst; lookup is injecteerbaar voor tests."""
import re

from . import db
from .matching import similarity, split_vintage
from .sources import lookup as default_lookup

HELP = ("Commando's:\n"
        "zoek <wijn> [jaar]\n"
        "gedronken <wijn>\n"
        "log <wijn> <score 1-5>\n"
        "Of stuur een foto van een label (log 4,2 als bijschrift om meteen te loggen).")
CMD_RE = re.compile(r"^\s*(zoek|gedronken|log)\b\s*(.*)$", re.I | re.S)
SCORE_END = re.compile(r"(?:^|\s)(\d(?:[.,]\d{1,2})?)\s*$")


def _fmt_score(v):
    return f"{v:.1f}".replace(".", ",") if v is not None else "onbekend"


def _history(con, wine_id: int, limit: int = 6) -> list[str]:
    rows = db.drinks_for(con, wine_id)
    lines = []
    for r in rows[:limit]:
        v = f" {r['vintage']}" if r["vintage"] else ""
        sc = f", jouw score {_fmt_score(r['my_score'])}" if r["my_score"] is not None else ""
        note = f" ({r['note'][:60]})" if r["note"] else ""
        lines.append(f"{r['drunk_on']}{v}{sc}{note}")
    if len(rows) > limit:
        lines.append(f"... en {len(rows) - limit} eerdere")
    return lines


def _label(name: str, producer: str) -> str:
    return f"{producer} {name}".strip() if producer and producer.lower() not in name.lower() else name


def do_search(con, query: str, lookup=default_lookup) -> str:
    q, vintage = split_vintage(query)
    if not q:
        return "Geef een wijn op, bv: zoek Chateau Margaux 2015"
    hits, src, errors = lookup(q, vintage)
    mine = db.find_wines(con, q, limit=1)
    parts = []
    if hits:
        for h in hits[:3]:
            db.upsert_wine(con, h.name, h.producer, h.vivino_id, h.score if h.vintage is None else None, h.ratings)
        top = hits[0]
        wid = db.upsert_wine(con, top.name, top.producer, top.vivino_id)
        if top.score is not None:  # score per jaargang zit in het antwoord; wine-score enkel bewaren zonder jaargang-ruis
            con.execute("UPDATE wines SET vivino_score=?, vivino_ratings=?, score_updated_at=? WHERE id=?",
                        (top.score, top.ratings, db.now(), wid))
        parts.append("\n".join(
            f"{'•' if i else '▶'} {_label(h.name, h.producer)}{f' {h.vintage}' if h.vintage else ''}: "
            f"{_fmt_score(h.score)}" + (f" ({h.ratings} ratings)" if h.ratings else "")
            for i, h in enumerate(hits[:3])))
        parts.append(f"Bron: {src}")
        mine = db.find_wines(con, _label(top.name, top.producer), limit=1) or mine
    else:
        parts.append("Live opzoeken lukte niet (" + "; ".join(errors) + ").")
        if mine:
            w = mine[0]
            parts.append(f"Laatst bekende score: {_label(w['name'], w['producer'])}: {_fmt_score(w['vivino_score'])}"
                         + (f" (op {w['score_updated_at'][:10]})" if w["score_updated_at"] else ""))
    if mine:
        h = _history(con, mine[0]["id"])
        parts.append("Eerder gedronken:\n" + "\n".join(h) if h else "Nog niet gedronken.")
    elif hits:
        parts.append("Nog niet gedronken.")
    return "\n\n".join(parts)


def do_drunk(con, query: str) -> str:
    q, _ = split_vintage(query)
    if not q:
        return "Geef een wijn op, bv: gedronken Margaux"
    wines = [w for w in db.find_wines(con, q, limit=3, threshold=0.5) if db.drinks_for(con, w["id"])]
    if not wines:
        return f"Geen gedronken wijn gevonden voor '{q}'."
    out = []
    for w in wines:
        out.append(f"{_label(w['name'], w['producer'])} (Vivino {_fmt_score(w['vivino_score'])})\n"
                   + "\n".join(_history(con, w["id"])))
    return "\n\n".join(out)


def do_log(con, text: str, lookup=default_lookup, source="whatsapp") -> str:
    m = SCORE_END.search(text)
    if not m:
        return "Geef een score op het einde, bv: log Margaux 2015 4,5"
    score = float(m.group(1).replace(",", "."))
    if not 1 <= score <= 5:
        return "Score moet tussen 1 en 5 liggen."
    q, vintage = split_vintage(text[: m.start()])
    if not q:
        return "Geef een wijn op, bv: log Margaux 2015 4,5"
    hits, src, _ = lookup(q, vintage, 3)
    best = max(hits, key=lambda h: similarity(q, _label(h.name, h.producer)), default=None)
    if best and similarity(q, _label(best.name, best.producer)) >= 0.5:
        name, producer, vid, vscore = best.name, best.producer, best.vivino_id, best.score
        vintage = vintage or best.vintage
    else:  # niet herkend: loggen onder je eigen tekst, zodat niets verloren gaat
        existing = db.find_wines(con, q, limit=1, threshold=0.7)
        name, producer, vid, vscore = (existing[0]["name"], existing[0]["producer"], existing[0]["vivino_id"], None) \
            if existing else (q, "", None, None)
    wid = db.upsert_wine(con, name, producer, vid, vscore)
    new = db.add_drink(con, wid, vintage, None, score, "", source)
    msg = f"{'Gelogd' if new else 'Vandaag al gelogd, bijgewerkt'}: {_label(name, producer)}"
    msg += f" {vintage}" if vintage else ""
    msg += f", jouw score {_fmt_score(score)}"
    if vscore:
        msg += f" (Vivino {_fmt_score(vscore)})"
    if not best:
        msg += "\nNiet herkend op Vivino, bewaard onder je eigen tekst."
    return msg + "\nLet op: dit staat enkel in je wijnlog, niet in je Vivino-account."


def handle_text(con, text: str, lookup=default_lookup) -> str:
    m = CMD_RE.match(text or "")
    if not m:
        return HELP
    cmd, arg = m.group(1).lower(), m.group(2).strip()
    if cmd == "zoek":
        return do_search(con, arg, lookup)
    if cmd == "gedronken":
        return do_drunk(con, arg)
    return do_log(con, arg, lookup)
