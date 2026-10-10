"""FastAPI-webhook voor de WhatsApp Cloud API. Start: uvicorn wijnlog.app:app --host 127.0.0.1 --port 8000"""
import json
import logging

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Response

from . import commands, config, db, vision, whatsapp

log = logging.getLogger("wijnlog")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
app = FastAPI(title="wijnlog", docs_url=None, redoc_url=None, openapi_url=None)


def process(msg: dict) -> None:
    """Verwerk één bericht en antwoord. Nooit excepties laten ontsnappen zonder terugkoppeling."""
    try:
        with db.session() as con:
            if msg["type"] == "text":
                reply = commands.handle_text(con, msg["text"])
            elif msg["type"] == "image":
                reply = _photo(con, msg)
            else:
                reply = commands.HELP
        whatsapp.send_text(msg["from"], reply)
    except Exception:
        log.exception("verwerking mislukt")
        try:
            whatsapp.send_text(msg["from"], "Er ging iets mis aan mijn kant. Probeer straks opnieuw.")
        except Exception:
            log.exception("foutmelding versturen mislukt")


def _photo(con, msg: dict) -> str:
    if not vision.enabled():
        return "Foto's staan uit (geen ANTHROPIC_API_KEY). Stuur 'zoek <wijn>'."
    img, mime = whatsapp.download_media(msg["media_id"])
    d = vision.extract_label(img, mime)
    if not d:
        return "Ik kon het label niet lezen. Probeer een scherpere foto of typ 'zoek <wijn>'."
    q = f"{d.get('producer') or ''} {d.get('name') or ''} {d.get('vintage') or ''}".strip()
    caption = (msg.get("text") or "").strip()
    if caption.lower().startswith("log"):
        return f"Label: {q}\n" + commands.do_log(con, f"{q} {caption[3:].strip()}")
    return f"Label: {q}\n\n" + commands.do_search(con, q)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/webhook")
def verify(request: Request):
    p = request.query_params
    token = config.get("WA_VERIFY_TOKEN")
    if token and p.get("hub.mode") == "subscribe" and p.get("hub.verify_token") == token:
        return Response(p.get("hub.challenge", ""), media_type="text/plain")
    raise HTTPException(403)


@app.post("/webhook")
async def receive(request: Request, bg: BackgroundTasks):
    body = await request.body()
    if not whatsapp.verify_signature(body, request.headers.get("x-hub-signature-256")):
        raise HTTPException(403, "bad signature")
    allowed = set(config.get_list("WA_ALLOWED_NUMBERS"))
    try:
        msgs = whatsapp.parse_messages(json.loads(body))
    except (ValueError, KeyError, TypeError):
        return {"ok": True}  # onleesbaar: niet laten retryen
    with db.session() as con:
        for m in msgs:
            if m["from"] not in allowed:
                log.warning("bericht van niet-toegelaten nummer genegeerd")
                continue
            if m["id"] and db.seen_before(con, m["id"]):  # Meta herhaalt bij trage 200
                continue
            bg.add_task(process, m)
    return {"ok": True}
