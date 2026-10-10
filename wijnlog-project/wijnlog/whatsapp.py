"""Meta WhatsApp Cloud API: handtekening, payload-parsing, verzenden, media."""
import hashlib
import hmac

import requests

from . import config


def verify_signature(body: bytes, header: str | None) -> bool:
    secret = config.get("WA_APP_SECRET")
    if not secret or not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header[7:])


def parse_messages(payload: dict) -> list[dict]:
    out = []
    for entry in payload.get("entry", []):
        for ch in entry.get("changes", []):
            for m in (ch.get("value") or {}).get("messages", []) or []:
                t = m.get("type")
                item = {"id": m.get("id"), "from": m.get("from"), "type": t, "text": "", "media_id": None}
                if t == "text":
                    item["text"] = m["text"]["body"]
                elif t == "image":
                    item["media_id"] = m["image"]["id"]
                    item["text"] = m["image"].get("caption", "")
                out.append(item)
    return out


def _api(path: str) -> str:
    return f"https://graph.facebook.com/{config.get('WA_GRAPH_VERSION', 'v21.0')}/{path}"


def _auth() -> dict:
    return {"Authorization": f"Bearer {config.get('WA_ACCESS_TOKEN')}"}


def send_text(to: str, body: str) -> None:
    r = requests.post(_api(f"{config.get('WA_PHONE_NUMBER_ID')}/messages"), headers=_auth(), timeout=20,
                      json={"messaging_product": "whatsapp", "to": to, "type": "text", "text": {"body": body[:4000]}})
    r.raise_for_status()


def download_media(media_id: str) -> tuple[bytes, str]:
    meta = requests.get(_api(media_id), headers=_auth(), timeout=20)
    meta.raise_for_status()
    info = meta.json()
    r = requests.get(info["url"], headers=_auth(), timeout=30)
    r.raise_for_status()
    return r.content, info.get("mime_type", "image/jpeg")
