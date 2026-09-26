# Tankstation prijsupdates → Homey

Volgt de brandstofprijzen van geconfigureerde tankstations op en stuurt bij
elke wijziging een notificatie naar een Homey Cloud webhook-flow.

## Werking

1. `tankprijzen/scraper.py` haalt de prijzen op van elke geconfigureerde
   tankstation-URL (eerst via een gewone HTTP-request, en als de pagina de
   prijzen via JavaScript inlaadt automatisch via een headless browser).
2. `tankprijzen/storage.py` vergelijkt met de vorige meting
   (`data/prices.json`) en bepaalt wat er gewijzigd is.
3. Bij een wijziging stuurt `tankprijzen/homey.py` een POST-request naar je
   Homey webhook-URL.
4. `.github/workflows/check-prices.yml` draait dit script elke 30 minuten via
   GitHub Actions — er is geen eigen server nodig.

## Setup

### 1. Homey: webhook-flow aanmaken

1. Installeer in Homey de officiële **Webhooks**-app (Athom), als die nog niet
   actief is.
2. Maak een nieuwe flow met als **trigger**: "Webhooks ontvangen" (When: a
   webhook is triggered).
3. Definieer de volgende tags in de trigger, zodat je ze verderop in de flow
   (bv. in een pushbericht of een variabele-update) kan gebruiken:
   - `station` (tekst)
   - `fuel` (tekst)
   - `price` (getal)
   - `previous_price` (getal)
   - `currency` (tekst)
   - `changed_at` (tekst — ISO 8601-tijdstip in UTC waarop de wijziging
     gedetecteerd werd, bv. `2026-09-26T14:32:00+00:00`)
4. Homey genereert een webhook-ID. De volledige URL is:
   `https://webhooks.athom.com/webhook/<jouw-id>/`

### 2. Repository configureren

1. Kopieer `config.example.yaml` naar `config.yaml` en vul de tankstations
   in die je wil opvolgen (URL + optioneel welke brandstoffen).
2. Voeg de webhook-URL uit stap 1 toe als **GitHub Actions secret**:
   - Repo → Settings → Secrets and variables → Actions → New repository
     secret
   - Naam: `HOMEY_WEBHOOK_URL`
   - Waarde: de volledige webhook-URL

   `config.yaml` zelf staat in `.gitignore` en wordt dus niet gecommit — de
   GitHub Actions workflow gebruikt sowieso `config.example.yaml` als basis
   en leest de webhook-URL uit het secret, niet uit `config.yaml`.

### 3. Lokaal testen

```bash
pip install -r requirements.txt
playwright install chromium   # eenmalig, alleen nodig als de statische parser niets vindt
cp config.example.yaml config.yaml
python -m tankprijzen.main --dry-run -v
```

`--dry-run` toont de opgehaalde prijzen en gedetecteerde wijzigingen zonder
Homey te notificeren of `data/prices.json` bij te werken.

### 4. Selectors verifiëren

De prijs-parser (`tankprijzen/scraper.py`) is geschreven om zonder vaste
CSS-selectors te werken (hij zoekt brandstofnamen en koppelt ze aan het
dichtstbijzijnde prijsgetal), zodat hij bestand is tegen kleine
site-wijzigingen. Als `--dry-run` geen of verkeerde prijzen toont voor jouw
tankstation:

1. Bekijk de pagina-bron (rechtsklik → "Paginabron weergeven", of de
   gerenderde HTML als de prijzen via JavaScript laden).
2. Pas zo nodig `FUEL_ALIASES` in `scraper.py` aan (andere spelling van
   "Diesel", "Euro 95", ...).
3. Werkt de generieke aanpak niet voor een bepaalde site, voeg dan een
   site-specifieke functie toe in `scraper.py` (bv. op basis van een
   concrete CSS-klasse) en roep die aan vanuit `fetch_prices()`.

## Extra tankstations toevoegen

Voeg gewoon een extra item toe onder `stations:` in `config.yaml`:

```yaml
stations:
  - name: "DATS24 Dilbeek"
    url: "https://dats24.be/nl/particulier/sdp/tankstation-dilbeek_118"
    fuels: []
  - name: "Shell Express Anderlecht"
    url: "https://carbu.com/belgie/index.php/station/shell-express/anderlecht/1070/2112"
    fuels: [euro95]
  - name: "Een ander station"
    url: "https://..."
    fuels: [diesel, euro95]
```

En hetzelfde in `config.example.yaml`, zodat de GitHub Actions-run ze ook
oppikt.

## Check-frequentie aanpassen

Pas de `cron`-regel aan in `.github/workflows/check-prices.yml`. GitHub
Actions ondersteunt geen interval korter dan enkele minuten, en de effectieve
frequentie kan iets lager liggen bij drukte op GitHub's schedulers.
