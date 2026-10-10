# wijnlog

Persoonlijke wijnlog met Vivino-scores, bediend via WhatsApp. SQLite als opslag, FastAPI als webhook.

## Status van de Vivino-endpoints

**Niet getest tegen een echt account.** De build-omgeving kon `vivino.com` niet bereiken. Alles is getest met mocks (11 tests, `pytest`), niet live. Draai eerst `python -m wijnlog.check` op de machine waar de sync gaat lopen (test met de productiecode: zoeken, login, ratings, parsing; rapport in `data/check_report.json` met enkel structuur). `--dump-sample` bewaart ook het eerste ruwe item, met waarden. `probe_vivino.py` is de losse, eenvoudige variant. Wat faalt, pas je aan in `wijnlog/sync.py` (`ENDPOINTS`, `login`) of `wijnlog/sources/vivino.py`. De endpointnamen komen uit geheugen en zijn onbevestigd.

## Architectuur

| Onderdeel | Bestand | Taak |
|---|---|---|
| Opslag | `db.py` | `wines` (identiteit, Vivino-score) en `drinks` (wijn, jaargang, datum, jouw score, notitie). Uniek op (wijn, jaargang, datum). |
| Sync | `sync.py` | Login, ratings ophalen, ontdubbelen. Interval-guard (`SYNC_MIN_INTERVAL_HOURS`), 3 s pauze per request, max 40 pagina's. |
| CSV-import | `import_csv.py` | Officiële Vivino-export, tolerante kolomherkenning, idempotent. |
| Scorebron | `sources/` | Interface `ScoreSource.search()`. Implementaties: `vivino`, `apify`, `rapidapi`. Volgorde via `SCORE_SOURCES`. |
| WhatsApp | `app.py`, `whatsapp.py`, `commands.py` | Webhook, handtekeningcontrole, nummer-allowlist, dedupe op bericht-id. |
| Foto's | `vision.py` | Labelherkenning (Claude vision), optioneel. |
| Back-up | `backup.py` | Dagelijkse SQLite-kopie + CSV, 30 dagen, optioneel upload-commando (bv. rclone). |

## WhatsApp-route: A, Meta Cloud API

Gekozen omdat het de enige officiële en ban-veilige route is die blijvend werkt. Jij stuurt altijd eerst, dus vrije tekst binnen het 24-uurvenster volstaat, zonder templates. B (Twilio sandbox) is enkel een test, C (Baileys/whatsapp-web.js) niet gebruiken.

Setup:
1. developers.facebook.com: app van type Business, product WhatsApp toevoegen, Meta-businessaccount koppelen.
2. Testnummer volgt automatisch. Voor productie: eigen nummer registreren dat niet in de gewone WhatsApp-app staat. Zet jouw privénummer als ontvanger (en in `WA_ALLOWED_NUMBERS`, zonder `+`).
3. Noteer `WA_PHONE_NUMBER_ID`, maak een permanent System User-token (`WA_ACCESS_TOKEN`) en kopieer het App Secret (`WA_APP_SECRET`).
4. Webhook: callback `https://<jouw-url>/webhook`, verify token = `WA_VERIFY_TOKEN`, abonneer op veld `messages`.

## Hosting: kleine VPS (aanbevolen)

Home Assistant past slecht: een publieke webhook vraagt uptime en een stabiele tunnel, en een add-on-update mag de logging niet onderbreken. Een VPS van 3 à 5 euro per maand volstaat.

```
sudo useradd -r -m wijnlog && sudo mkdir -p /opt/wijnlog && sudo chown wijnlog /opt/wijnlog
cd /opt/wijnlog && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env && chmod 600 .env     # invullen
sudo cp deploy/wijnlog.service /etc/systemd/system/ && sudo systemctl enable --now wijnlog
crontab -u wijnlog deploy/crontab.example
```

Publieke https: Cloudflare Tunnel (`cloudflared tunnel --url http://127.0.0.1:8000`, of een benoemde tunnel) of Caddy (`deploy/Caddyfile.example`). Houd `--workers 1`: SQLite en de dedupe zijn daarop afgestemd.

## Gebruik

WhatsApp:
- `zoek Chateau Margaux 2015`: live score (top 3) plus jouw eerdere keren.
- `gedronken margaux`: enkel uit je log, met data en scores.
- `log Margaux 2015 4,5`: bewaart vandaag met jouw score. Dit schrijft **niet** naar Vivino.
- Foto van label: zoekt de wijn. Met bijschrift `log 4,2` logt hij meteen.

CLI:
```
python -m wijnlog.sync [--force]
python -m wijnlog.import_csv export.csv
python -m wijnlog.backup
python -m wijnlog.check
python -m pytest
```

Bij login-problemen: kopieer je ingelogde browsercookie naar `VIVINO_COOKIE`. Valt alles uit, dan is de maandelijkse CSV-export je vangnet.

Datums in CSV worden als dd/mm/jjjj gelezen bij dubbelzinnige notatie. Controleer dit bij de eerste import.

## Bekende risico's

1. **Vivino kan alles breken of blokkeren**: geen API, geen garantie. Login, ratings en zoeken zijn onofficieel en zitten achter bot-bescherming. Mitigatie: fallbackbronnen, cookie-login, CSV-import.
2. **Accountblokkade bij te vaak pollen**: guard van 6 uur, 3 runs per dag in cron. De guard telt ook mislukte pogingen, zodat een kapotte login niet blijft hameren.
3. **Vivino-ToS**: scrapen en automatisch inloggen zijn niet toegestaan. Eigen risico.
4. **Apify/RapidAPI-mapping is een gok**: actor, host en veldnamen verschillen per aanbieder. Pas `APIFY_*`, `RAPIDAPI_*` en `ALIASES` in `sources/generic.py` aan na een eerste test. Betaald per call.
5. **Wijnidentiteit**: ontdubbelen werkt op genormaliseerde naam of Vivino-id. Verschillende schrijfwijzen kunnen dubbele wijnen geven; sync-datums (UTC) kunnen een dag afwijken van de datum die je via WhatsApp logt, waardoor dezelfde fles tweemaal voorkomt.
6. **Eenrichting**: WhatsApp-logs komen niet in Vivino. Kom je ze later via sync tegen, dan zijn het aparte regels.
7. **Foutieve labelherkenning**: het vision-model kan een wijn verkeerd lezen. Het antwoord toont altijd wat gelezen is.
8. **Geheimen**: alleen in `.env` (`chmod 600`). De allowlist en de HMAC-controle beschermen de webhook. Tokens nooit in logs plakken.
9. **Back-up**: zonder `BACKUP_UPLOAD_CMD` staat de back-up op dezelfde VPS. Stel een externe bestemming in, anders is "extern bewaard" niet waar.
10. **Meta**: tokens verlopen als je geen System User gebruikt; een nummer dat in de gewone app staat kan niet op de Cloud API.
