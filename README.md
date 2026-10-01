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
   Homey webhook-URL, met de volledige payload als JSON-tekst in de
   query-parameter `tag` (zie stap 1 hieronder — dat is hoe Homey's
   webhook-trigger data verwacht).
4. `.github/workflows/check-prices.yml` draait dit script elk uur via
   GitHub Actions — er is geen eigen server nodig. (GitHub's cron-scheduler
   houdt kortere intervallen niet strikt aan, vandaar elk uur i.p.v. elke
   30 min.)

## Setup

### 1. Homey: webhook-flow aanmaken

Homey's ingebouwde **"Webhook ontvangen"**-trigger (onderdeel van de
Logic-app) werkt anders dan je zou verwachten: hij geeft niet automatisch
meerdere tags door. Hij geeft de flow precies **één ruwe tekst-tag**,
gevuld vanuit een query-parameter die letterlijk `tag` heet (dus
`...?tag=<waarde>` — niet een JSON-body, en niet losse
`station=...&price=...`-parameters). Om daar de 6 afzonderlijke velden uit
te halen, splits je die ene tag verderop in de flow.

1. Maak een nieuwe flow met als **trigger**: "Webhook ontvangen". De URL
   heeft de vorm `https://webhook.homey.app/<jouw-homey-id>/<event-naam>`
   (bv. `.../benzine`) — het laatste stukje kies je zelf als naam voor
   deze trigger. `tankprijzen/homey.py` stuurt hier automatisch de
   volledige payload naartoe als JSON-tekst in de `tag`-parameter; je
   hoeft dus niets aan de URL zelf te wijzigen.
2. Installeer de community-app **Better Logic** (nodig voor de
   JSON-parsing-kaarten hieronder) via de Homey App Store.
3. Voeg in het "Dan..."-gedeelte van de flow 6 keer de kaart **"Lees Tag
   als JSON en selecteer pad ... als Tekst-tag / Nummer-tag"** toe (onder
   Logic/Better Logic). Elke kaart neemt de ruwe `Tag` van de trigger als
   invoer, en het **Pad**-veld is telkens gewoon de veldnaam (geen `.` of
   `$` nodig, het zijn platte top-level JSON-velden):

   | Veld | Tag-type | Pad |
   |---|---|---|
   | `station` | Tekst-tag | `station` |
   | `fuel` | Tekst-tag | `fuel` |
   | `price` | Nummer-tag | `price` |
   | `previous_price` | Nummer-tag | `previous_price` |
   | `currency` | Tekst-tag | `currency` |
   | `changed_at` | Tekst-tag | `changed_at` |

4. Gebruik de zo verkregen tags (elke kaart geeft een eigen `Resultaat`-tag)
   verderop in de flow, bv. om een apparaat bij te werken of een
   pushbericht te sturen: `{{station}}: {{fuel}} nu €{{price}}`.
5. **Sla de flow op en zet ze aan.** Test niet enkel via de "Test"-knop op
   de trigger-kaart (die laat je een waarde manueel intypen en test dus
   niet of een echte binnenkomende call de flow bereikt) — stuur ook
   minstens één keer een echte call, bv.:
   ```bash
   curl -G "https://webhook.homey.app/<jouw-homey-id>/<event-naam>" \
     --data-urlencode 'tag={"station":"Test","fuel":"euro95","price":1.75,"previous_price":1.73,"currency":"EUR","changed_at":"2026-01-01T10:00:00+00:00"}'
   ```

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
    fuels: [euro95]
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

## Goedkoopste tankstation in de buurt

Naast de prijswijzigingen-tracker hierboven (voor specifieke, vooraf gekozen
stations) is er een aparte, onafhankelijke module die dagelijks het
**goedkoopste** E10-station binnen een straal van je adres opzoekt, met
uitsluiting van bepaalde gemeenten.

### Werking

`tankprijzen/nearby.py` haalt via carbu.com's gebiedsoverzicht (niet één
vaste stations-URL, maar een lijst van àlle stations rond een gemeente) alle
stations op met hun prijs, gemeente en afstand tot het zoekcentrum
(carbu.com berekent die afstand zelf, als attribuut per station — geen
eigen geo-berekening nodig). `tankprijzen/nearby_main.py` filtert op straal
en uitgesloten gemeenten, kiest de goedkoopste, en stuurt — enkel bij
wijziging t.o.v. de vorige check — een Homey-melding.

Het zoekcentrum is een gemeente/postcode (in `config.yaml` onder `nearby:`),
geen exact adres: carbu.com kent enkel gemeente-niveau zoekopdrachten. Voor
Thiernessestraat 12, 1070 Brussel is dat ingesteld als "Anderlecht"/"1070".
De afstand per station is dus de afstand tot het centrum van die gemeente,
niet tot je exacte huisnummer — voor een straal van 10km een ruim
voldoende benadering.

### Setup

1. **Nieuwe, aparte Homey-flow**: net als bij de prijstracker een
   "Webhook ontvangen"-trigger, met een eigen event-naam (bv.
   `.../goedkoopste-buurt`), gevolgd door "Lees Tag als JSON en selecteer
   pad..."-kaarten (zie hierboven) voor deze velden:

   | Veld | Tag-type | Pad |
   |---|---|---|
   | `station` | Tekst-tag | `station` |
   | `municipality` | Tekst-tag | `municipality` |
   | `address` | Tekst-tag | `address` |
   | `price` | Nummer-tag | `price` |
   | `distance_km` | Nummer-tag | `distance_km` |
   | `changed_at` | Tekst-tag | `changed_at` |

2. Voeg de webhook-URL toe als GitHub secret **`HOMEY_NEARBY_WEBHOOK_URL`**
   (zelfde manier als `HOMEY_WEBHOOK_URL` hierboven).
3. Pas in `config.yaml` de `nearby:`-sectie aan: `location_name`,
   `postcode`, `radius_km` en `excluded_municipalities`.
4. `.github/workflows/check-nearby.yml` draait dit 1x per dag (06:00 UTC).
   Pas de `cron`-regel aan voor een andere frequentie.

### Lokaal testen

```bash
python -m tankprijzen.nearby_main --dry-run -v
```

## Brandstofadvies uit nieuwsbrief ("nu tanken of wachten")

Derde, onafhankelijke feature: een Google Apps Script (`apps-script/brandstofadvies.gs`)
dat een e-mail-nieuwsbrief over aankomende wettelijke max-prijswijzigingen
opvolgt en op basis daarvan een "nu tanken"/"wacht"-advies naar Homey stuurt.

### Waarom geen Python/GitHub Actions hiervoor?

De twee features hierboven scrapen een website; deze info komt **enkel via
e-mail** binnen (een nieuwsbrief van Energieprijzen.vlaanderen /
info@elektriciteitsprijzen.com) — er is geen publieke pagina om te scrapen.
Daarom draait dit onderdeel als Google Apps Script, gekoppeld aan je eigen
Gmail-account (geen apart mailadres nodig, het script doorzoekt specifiek op
afzender en raakt verder niets in je inbox).

### Werking

1. Elke 12 uur doorzoekt het script Gmail op nieuwe, nog niet verwerkte
   mails van de nieuwsbrief-afzender. Is er niets nieuws, dan stopt het
   script meteen — de Claude API wordt enkel aangeroepen als er
   effectief een nieuwe mail gevonden is.
2. De mailtekst wordt naar de Claude API gestuurd (niet vaste regex-patronen,
   zodat het bestand blijft tegen wisselende formulering in toekomstige
   nieuwsbrieven) met de vraag om de prijsinfo per brandstof te structureren
   naar JSON (brandstof, richting, nieuwe prijs, huidige prijs, wijziging in
   cent/liter, ingangsdatum — relatieve datums zoals "morgen" worden opgelost
   t.o.v. de verzenddatum van de mail).
3. Voor elke vermelde prijswijziging (stijging of daling) stuurt het script
   een webhook naar een eigen Homey-flow, met hetzelfde `tag=`-queryparameter-
   formaat als de andere twee features.
4. De mail-thread wordt gelabeld (`Homey-verwerkt`) zodat ze niet opnieuw
   verwerkt wordt. Bij een tijdelijke fout (bv. Claude API niet bereikbaar)
   blijft de thread ongelabeld en wordt ze bij de volgende run opnieuw
   geprobeerd.

### Setup

1. Maak een Anthropic API-key aan op console.anthropic.com (het script
   gebruikt het Haiku-model — kosten zijn verwaarloosbaar gezien de
   nieuwsbrief onregelmatig en kort is).
2. Ga naar script.google.com → nieuw project → plak de inhoud van
   `apps-script/brandstofadvies.gs`.
3. Project Settings → Script Properties, voeg toe:
   - `ANTHROPIC_API_KEY` — je Anthropic API-key
   - `HOMEY_WEBHOOK_URL` — `https://webhook.homey.app/<jouw-homey-id>/brandstofadvies`
4. Draai de functie `installTrigger` eenmalig vanuit de Apps Script-editor
   (keuzelijst bovenaan → functie selecteren → Uitvoeren). Bij de eerste
   keer vraagt Google om toestemming (Gmail lezen/labelen, externe
   verzoeken) — dat hoort zo, het is je eigen script in je eigen account.
5. Maak in Homey een nieuwe "Webhook ontvangen"-trigger met event-naam
   `brandstofadvies`, en voeg 8 "Lees Tag als JSON en selecteer pad..."-
   kaarten toe:

   | Veld | Tag-type | Pad |
   |---|---|---|
   | `fuel` | Tekst-tag | `fuel` |
   | `direction` | Tekst-tag | `direction` |
   | `new_price` | Nummer-tag | `new_price` |
   | `current_price` | Nummer-tag | `current_price` |
   | `change_cents_per_liter` | Nummer-tag | `change_cents_per_liter` |
   | `effective_date` | Tekst-tag | `effective_date` |
   | `advice` | Tekst-tag | `advice` |
   | `received_at` | Tekst-tag | `received_at` |

6. Gebruik `{{advice}}` (bv. "Tank nu, de prijs stijgt") rechtstreeks in een
   pushbericht, of bouw verdere logica op `direction`/`new_price`.
