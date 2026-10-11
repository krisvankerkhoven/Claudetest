"""Vertaalt het weer naar een kort kledingadvies (vaste regels, geen AI)."""
from __future__ import annotations

from .weer import Venster


def _bereik(laag: float, hoog: float) -> str:
    if round(laag) == round(hoog):
        return f"{laag:.0f}"
    return f"{laag:.0f} tot {hoog:.0f}"


def _kleding(gevoel: float) -> str:
    if gevoel < 0:
        return "Winterjas, muts en handschoenen"
    if gevoel < 6:
        return "Warme jas, muts en handschoenen"
    if gevoel < 12:
        return "Jas met een trui eronder"
    if gevoel < 17:
        return "Lichte jas of vest"
    if gevoel < 22:
        return "T-shirt, vest bij de hand"
    return "Luchtige kleren"


def _extra(v: Venster) -> list[str]:
    extra = []
    if v.regen_mm >= 2 or v.regenkans >= 70:
        extra.append("regenjas")
    elif v.regenkans >= 40:
        extra.append("regenjas of paraplu mee")
    if v.windstoten_max >= 60:
        extra.append("winddichte jas, storm")
    elif v.wind_max >= 30:
        extra.append("winddicht")
    return extra


def dagadvies(v: Venster) -> list[str]:
    gevoel = v.gevoel_min if v.gevoel_max - v.gevoel_min < 8 else (v.gevoel_min + v.gevoel_max) / 2
    kop = f"{_bereik(v.gevoel_min, v.gevoel_max)}°"
    if v.regenkans >= 40:
        kop += f", regen {v.regenkans}%"
    regel = ", ".join([_kleding(gevoel)] + _extra(v)) + "."
    regels = [kop, regel]
    if v.gevoel_max - v.gevoel_min >= 8:
        regels.append("Kleed je in lagen, groot verschil tussen ochtend en middag.")
    return regels


def fietsadvies_gus(school: Venster) -> list[str]:
    """Kort advies voor een driejarige achterop de fiets.

    Een kind dat stilzit koelt sneller af dan de fietser. We rekenen daarom met
    een lagere gevoelstemperatuur voor Gus.
    """
    gus = school.gevoel_min - 4 - (2 if school.wind_max >= 25 else 0)
    if gus < 3:
        kleding = "warme jas, trui, muts, handschoenen"
    elif gus < 9:
        kleding = "trui onder een warme jas, muts, handschoenen"
    elif gus < 15:
        kleding = "trui onder een jas, dunne muts"
    else:
        kleding = "t-shirt, vest bij de hand"
    if school.regen_mm >= 0.5 or school.regenkans >= 40:
        kleding += ", regenpak en laarsjes"
    return [f"Gus (fiets): {kleding}."]
