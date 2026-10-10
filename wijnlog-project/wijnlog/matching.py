"""Normalisatie en fuzzy matching van wijnnamen."""
import re
import unicodedata
from difflib import SequenceMatcher

VINTAGE_RE = re.compile(r"\b(19[5-9]\d|20[0-4]\d)\b")
STOP = {"de", "du", "la", "le", "les", "des", "the", "of", "et", "and", "chateau", "château", "domaine", "cuvee", "cuvée"}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower()).strip()


def tokens(s: str) -> set[str]:
    return {t for t in norm(s).split() if t not in STOP and not VINTAGE_RE.fullmatch(t)}


def split_vintage(q: str) -> tuple[str, int | None]:
    m = VINTAGE_RE.search(q)
    if not m:
        return q.strip(), None
    return re.sub(r"\s+", " ", (q[: m.start()] + q[m.end():])).strip(), int(m.group(1))


def similarity(a: str, b: str) -> float:
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    overlap = len(ta & tb) / min(len(ta), len(tb))
    ratio = SequenceMatcher(None, norm(a), norm(b)).ratio()
    return 0.7 * overlap + 0.3 * ratio


def wine_key(name: str, producer: str = "") -> str:
    return norm(f"{producer} {name}")
