# Brusselse Ophaalkalender (Homey-app)

Toont per adres in het Brussels Gewest de eerstvolgende datum waarop de **witte, gele, blauwe, groene en oranje zak** buiten moet, en stuurt een Homey-notificatie.

Bron: dezelfde publieke aanroepen als het formulier op
<https://www.arp-gan.be/nl/kalender-buitenzetten-van-de-zakken> (`formsv2.arp-gan.eu`).

## Wat je krijgt

- **Elk adres = één apparaat.** Voeg zoveel adressen toe als je wil (thuis, ouders, tweede verblijf). Zoeken op straatnaam (min. 3 letters), dan huisnummer.
- **Per apparaat** zes tegels: volgende ophaling per kleur (`ma 5 okt (over 7 d)`, `Vandaag`, `Morgen`, of `Geen ophaling`) en een samenvatting `Volgende ophaling`.
- **Vernieuwt zich zelf** elke 12 uur en bij het opstarten. De laatste kalender wordt bewaard: als ARP-GAN of het internet even weg is, blijft alles werken. Na 3 dagen zonder succes toont het apparaat een waarschuwing.
- **Notificaties** (instelbaar per apparaat): op de dag zelf (standaard 17:00) en/of de avond ervoor (standaard 20:00), en per kleur aan of uit. De tekst bevat het tijdvenster, bv. *Vandaag buitenzetten: witte, blauwe en groene zakken (18:00–24:00)*.

### Flow-kaarten

| Type | Kaart |
|---|---|
| Trigger | **Het is tijd om een zak buiten te zetten** – kies zak (of elke zak) en vandaag/morgen. Tokens: `bags`, `text`, `date`, `from`, `to` |
| Voorwaarde | **Zak moet buiten** – zak + vandaag/morgen |
| Actie | **Kalender vernieuwen** |

Met de trigger en het token `text` stuur je dezelfde melding naar een speaker (TTS), WhatsApp of een dashboard.

## Hoe de data wordt gelezen

| Kleur | Bron in het antwoord van ARP-GAN |
|---|---|
| Wit, geel, blauw | Wekelijks schema per weekdag (`desc_ramassage`) |
| Groen | Exacte datums om de 2 weken (`SacsVerts`) |
| Oranje | `VOEDINGSAFVAL` in de weekdagtekst, enkel in wijken met voedingsafvalophaling |

De datums zijn de datums waarop je de zakken **buiten zet** (de kalender heet "buitenzetten van de zakken"). Het tijdvenster komt uit dezelfde tekst.

**Let op:** de kalender vermeldt geen feestdagverschuivingen. Rond feestdagen kan de ophaaldag afwijken; controleer dan de website van Net Brussel.

Het voorbeeldbeeld (`img_ramassage`) in het antwoord wordt bewust genegeerd: het is voor elk adres hetzelfde vaste plaatje en klopt niet met de tekst.

## Installeren en testen

```bash
npm i -g homey
homey login
homey app run        # op je eigen Homey testen (stub app.json wordt herbouwd uit .homeycompose)
homey app install    # blijvend installeren
```

`app.json` wordt gegenereerd uit `.homeycompose/`; pas alleen die map aan.

```bash
npm test                                  # unit- en device-tests (geen Homey nodig)
node scripts/live-check.js "Nieuwstraat" 10   # rooktest tegen de echte server
homey app validate --level publish
```

Zit je in een omgeving waar Node's `fetch` niet door een proxy komt maar curl wel, gebruik dan `LIVE_VIA_CURL=1 node scripts/live-check.js …`.

## Structuur

```
lib/arp.js          API-client (straten, huisnummers, adres-id, kalender)
lib/schedule.js     parser + berekening volgende ophaling + herinneringen (zuiver, getest)
lib/text.js         NL/EN teksten
drivers/address/    driver (koppelen, flow-kaarten) + device (verversen, tikker, notificaties)
test/               fixtures = echte API-antwoorden voor 3 Brusselse adressen
```
