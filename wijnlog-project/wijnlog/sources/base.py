"""Vaste interface voor scorebronnen. Een bron geeft kandidaten terug, beste eerst."""
from dataclasses import dataclass
from typing import Protocol


@dataclass
class WineHit:
    name: str
    producer: str = ""
    vintage: int | None = None
    score: float | None = None
    ratings: int | None = None
    vivino_id: str | None = None
    url: str | None = None


class SourceError(Exception):
    pass


class ScoreSource(Protocol):
    name: str

    def search(self, query: str, vintage: int | None = None, limit: int = 5) -> list[WineHit]:
        """Raise SourceError bij blokkade/kapotte respons, zodat de volgende bron het kan proberen."""
        ...
