"""Label-herkenning met een vision-model. Optioneel: zonder ANTHROPIC_API_KEY staat het uit."""
import base64
import json
import re

from . import config

PROMPT = ("Dit is een foto van een wijnlabel. Geef enkel JSON terug: "
          '{"producer": str, "name": str, "vintage": int|null, "confidence": 0..1}. '
          "Producent en cuvée/appellatie zoals op het label. Niets verzinnen: leeg laten als onleesbaar.")


def enabled() -> bool:
    return bool(config.get("ANTHROPIC_API_KEY"))


def extract_label(image: bytes, mime: str, client=None) -> dict | None:
    if client is None:
        import anthropic
        client = anthropic.Anthropic(api_key=config.get("ANTHROPIC_API_KEY"))
    resp = client.messages.create(
        model=config.get("VISION_MODEL", "claude-sonnet-5-5"), max_tokens=300,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": mime,
                                         "data": base64.b64encode(image).decode()}},
            {"type": "text", "text": PROMPT}]}])
    m = re.search(r"\{.*\}", "".join(b.text for b in resp.content if b.type == "text"), re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
    except ValueError:
        return None
    if not (d.get("name") or d.get("producer")):
        return None
    return d
