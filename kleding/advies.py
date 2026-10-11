"""Vertaalt het weer naar een kledingadvies (vaste regels, geen AI)."""
from __future__ import annotations

from .weer import Venster


def _laag(gevoel: float) -> str:
    if gevoel < 0:
        return "Winterjas, dikke trui of fleece, thermisch ondergoed, muts, sjaal en handschoenen."
    if gevoel < 6:
        return "Warme jas, trui, muts en handschoenen."
    if gevoel < 12:
        return "Gewone jas met een trui eronder. Handschoenen zijn handig bij wind."
    if gevoel < 17:
        return "Lichte jas of vest met een lange mouw."
    if gevoel < 22:
        return "T-shirt met een licht vest of overhemd bij de hand."
    return "Luchtige zomerkledij. Zonnebril en zonnecrème niet vergeten."


def _regen(v: Venster) -> str | None:
    if v.regen_mm >= 2 or v.regenkans >= 70:
        return f"Regenjas of poncho mee ({v.regenkans}% kans, {v.regen_mm} mm). Waterdichte schoenen."
    if v.regenkans >= 40:
        return f"Pak een regenjas of paraplu mee ({v.regenkans}% kans)."
    return None


def _wind(v: Venster) -> str | None:
    if v.windstoten_max >= 60:
        return f"Stormachtig, windstoten tot {v.windstoten_max:.0f} km/u. Winddichte jas en liever geen paraplu."
    if v.wind_max >= 30:
        return f"Winderig ({v.wind_max:.0f} km/u). Kies een winddichte buitenlaag."
    return None


def dagadvies(v: Venster) -> list[str]:
    regels = [f"Gevoelstemperatuur {v.gevoel_min:.0f} tot {v.gevoel_max:.0f} graden "
              f"(echt {v.temp_min:.0f} tot {v.temp_max:.0f})."]
    regels.append(_laag(v.gevoel_min if v.gevoel_max - v.gevoel_min < 8 else (v.gevoel_min + v.gevoel_max) / 2))
    if v.gevoel_max - v.gevoel_min >= 8:
        regels.append("Groot verschil tussen ochtend en middag. Kleed je in lagen.")
    for extra in (_regen(v), _wind(v)):
        if extra:
            regels.append(extra)
    return regels


def fietsadvies_gus(school: Venster) -> list[str]:
    """Extra advies voor een driejarige achterop de fiets.

    Een kind dat stilzit op de bagagedrager koelt sneller af dan de fietser en
    krijgt de rijwind vol op zich. Daarom rekenen we met een lagere
    gevoelstemperatuur dan de fietser.
    """
    gus = school.gevoel_min - 4 - (2 if school.wind_max >= 25 else 0)
    regels = [f"Gus achterop: reken op gevoelstemperatuur {gus:.0f} graden voor hem "
              f"({school.gevoel_min:.0f} voor jou)."]
    if gus < 3:
        regels.append("Gus: thermisch ondergoed, dikke trui, winterjas of skipak, muts onder de helm, "
                      "dikke handschoenen of wanten, nekwarmer en warme schoenen.")
    elif gus < 9:
        regels.append("Gus: dikke trui of fleece onder een warme jas, muts onder de helm, "
                      "handschoenen en een nekwarmer.")
    elif gus < 15:
        regels.append("Gus: trui of fleece onder een jas, dunne muts onder de helm en handschoenen.")
    else:
        regels.append("Gus: t-shirt met een licht vest. Zonnepet of zonnecrème bij zon.")
    if school.regen_mm >= 0.5 or school.regenkans >= 40:
        regels.append("Gus: regenpak of regenbroek en regenjas, waterdichte laarsjes. "
                      "Regenhoes of poncho over het zitje.")
    if school.wind_max >= 30:
        regels.append("Gus: winddichte buitenlaag is belangrijker dan een extra trui. "
                      "Check of zijn nek en handen goed afgedekt zijn.")
    regels.append("Warmtetest: voel in zijn nek. Koud of klam betekent een laag erbij.")
    return regels
