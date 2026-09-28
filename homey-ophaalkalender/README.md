# Brusselse Ophaalkalender (Homey-app)

Toont per adres in het Brussels Gewest de eerstvolgende datum waarop de **witte, gele, blauwe, groene en oranje zak** buiten moet, en stuurt een Homey-notificatie.

Bron: dezelfde publieke aanroepen als het formulier op
<https://www.arp-gan.be/nl/kalender-buitenzetten-van-de-zakken> (`formsv2.arp-gan.eu`).

## Wat je krijgt

- **Elk adres = één apparaat.** Voeg zoveel adressen toe als je wil (thuis, ouders, tweede verblijf). Zoeken op straatnaam (min. 3 letters), dan huisnummer.
- **Per apparaat** zes tegels met een zakpictogram: per kleur de volgende keer dat de zak **buiten moet, met het uur** (`Vandaag 18:00–24:00`, `Morgen 05:00–12:00`, `wo 30 sep 18:00–24:00`, of `Geen ophaling`), plus een samenvatting `Volgende ophaling`. Is het venster van vandaag al voorbij, dan springt de tegel door naar de volgende keer.
- **Vernieuwt zich zelf** elke 12 uur en bij het opstarten. De laatste kalender wordt bewaard: als ARP-GAN of het internet even weg is, blijft alles werken. Na 3 dagen zonder succes toont het apparaat een waarschuwing.
- **Notificaties** (instelbaar per apparaat, per zak aan of uit):
  - zodra buitenzetten mag, dus bij het begin van het uur-venster (standaard aan), bv. *Buitenzetten kan nu: witte en gele zakken (18:00–24:00)*;
  - optioneel op een vast tijdstip op de dag zelf (niet bij ochtendvensters die dan al voorbij zijn);
  - optioneel de avond ervoor (standaard 20:00).

### Flow-kaarten

| Type | Kaart |
|---|---|
| Trigger | **Buitenzetten van zakken mag nu** – gaat af bij het begin van het venster (bv. 18:00). Kies een zak of elke zak. Tokens: `bags`, `text`, `date`, `from` (begin-uur), `to` (eind-uur) |
| Trigger | **Het is tijd om een zak buiten te zetten** – op het tijdstip uit de instellingen, vandaag of morgen |
| Voorwaarde | **Buitenzetten mag nu** – waar vandaag tussen begin- en einduur |
| Voorwaarde | **Zak staat op de buitenzetkalender** – vandaag of morgen |
| Actie | **Kalender vernieuwen** |

Voorbeeld: *Als* "Buitenzetten van de witte zak mag nu" → *dan* stuur een pushbericht met `{{text}}` of laat een speaker `{{bags}}` uitspreken.

## Hoe de data wordt gelezen

Het antwoord van ARP-GAN bevat drie bronnen, en die zijn niet even volledig:

| Bron | Inhoud | Gebruik |
|---|---|---|
| **Kalenderafbeelding** (`img_ramassage`) | Per weekdag de zakken (ook **oranje**) en het **uur** om buiten te zetten. Dit is de officiële buitenzetkalender. | Hoofdbron |
| `SacsVerts` | Exacte datums van de **groene** zak (om de 2 weken) | Groen |
| Tekst (`desc_ramassage`) | Ophaaldag per weekdag; mist zakken en ochtenduren en kan een dag afwijken van het buitenzetten | Enkel als noodoplossing |

De afbeelding wordt door de app zelf gelezen (`lib/calendarImage.js`): het is een vast sjabloon met 7 kolommen, gekleurde zakjes en een klokje. Het klokje is een 12-uurs wijzerplaat; het groene taartpunt loopt van het begin- tot het einduur (bv. 18:00–24:00 of 18:00–20:00). Lukt het lezen niet (bv. bij een nieuw sjabloon), dan gebruikt de app de tekst en toont het apparaat een waarschuwing. Bij *Instellingen → Gegevensbron* zie je welke bron actief is.

**Let op:** de kalender vermeldt geen feestdagverschuivingen. Rond feestdagen kan de dag afwijken; controleer dan de website van Net Brussel.

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
lib/calendarImage.js  leest de kalenderafbeelding (PNG, zonder externe pakketten)
lib/fetchCalendar.js  haalt antwoord + afbeelding op, met terugval op de tekst
lib/schedule.js     schema, volgende keer, uur-venster, herinneringen (zuiver, getest)
lib/text.js         NL/EN teksten
drivers/address/    driver (koppelen, flow-kaarten) + device (verversen, tikker, notificaties)
test/               fixtures = echte API-antwoorden + kalenderafbeeldingen voor 3 Brusselse adressen
```
