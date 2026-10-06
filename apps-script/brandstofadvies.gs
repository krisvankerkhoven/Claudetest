/**
 * Brandstofprijzen-nieuwsbrief -> Homey "nu tanken / wachten"-advies.
 *
 * Doorzoekt Gmail op nieuwe mails van de "Energieprijzen.vlaanderen"
 * nieuwsbrief (info@elektriciteitsprijzen.com), laat Claude de
 * prijsinfo uit de mailtekst structureren (robuust tegen wisselende
 * formulering, in tegenstelling tot vaste regex-patronen), en stuurt
 * per vermelde brandstofwijziging een webhook naar een eigen Homey-flow.
 *
 * Dit script draait in Google Apps Script, gebonden aan je bestaand
 * Gmail-account (geen apart mailadres nodig) — niet in GitHub Actions,
 * want de nieuwsbrief komt enkel via e-mail binnen, niet van een
 * website die via HTTP te benaderen is.
 *
 * SETUP
 * 1. Ga naar https://script.google.com -> Nieuw project.
 * 2. Vervang de inhoud van Code.gs door dit bestand.
 * 3. Project Settings (tandwiel) -> Script Properties -> voeg toe:
 *      ANTHROPIC_API_KEY   = je eigen Anthropic API-key (console.anthropic.com)
 *      HOMEY_WEBHOOK_URL   = https://webhook.homey.app/<jouw-homey-id>/brandstofadvies
 * 4. Open de functie "installTrigger" in de editor, selecteer ze in het
 *    dropdown-menu bovenaan, en klik "Uitvoeren". De eerste keer vraagt
 *    Google om toestemming (Gmail lezen/labelen, externe verzoeken) —
 *    dat is je eigen script in je eigen account, dus dat is normaal.
 *    Dit zet een tijdgestuurde trigger die "checkNewsletter" elke
 *    12 uur uitvoert. Claude wordt enkel aangeroepen als er effectief
 *    een nieuwe, nog niet verwerkte mail gevonden wordt — bij niets
 *    nieuws stopt het script meteen, zonder API-kosten.
 * 5. In Homey: maak een nieuwe "Webhook ontvangen"-trigger met
 *    event-naam "brandstofadvies", en 8 "Lees Tag als JSON en selecteer
 *    pad..."-kaarten voor: fuel, direction, new_price, current_price,
 *    change_cents_per_liter, effective_date, advice, received_at
 *    (zie README.md voor het volledige overzicht met tag-types).
 */

// newer_than: voorkomt dat oude, inmiddels achterhaalde prijsadviezen nog
// verwerkt worden (het advies "tank nu, prijs stijgt morgen" is na een paar
// dagen zinloos). MAX_THREADS_PER_RUN is een extra veiligheidsgrens tegen
// een opeenstapeling van Homey-meldingen in één run (bv. na een backlog).
const SENDER_FILTER = 'from:info@elektriciteitsprijzen.com newer_than:3d';
const MAX_THREADS_PER_RUN = 5;
const PROCESSED_LABEL = 'Homey-verwerkt';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkNewsletter') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkNewsletter').timeBased().everyHours(12).create();
}

function checkNewsletter() {
  const label = getOrCreateLabel_(PROCESSED_LABEL);
  const threads = GmailApp.search(
    SENDER_FILTER + ' -label:"' + PROCESSED_LABEL + '"',
    0,
    MAX_THREADS_PER_RUN
  );

  threads.forEach(function (thread) {
    let allOk = true;
    thread.getMessages().forEach(function (message) {
      try {
        processMessage_(message);
      } catch (err) {
        allOk = false;
        console.error('Fout bij verwerken bericht: ' + err);
      }
    });
    // Enkel labelen (= niet opnieuw verwerken) als alles lukte. Bij een
    // tijdelijke fout (bv. Claude API down) blijft de thread onverwerkt
    // en wordt ze bij de volgende run automatisch opnieuw geprobeerd.
    if (allOk) thread.addLabel(label);
  });
}

function processMessage_(message) {
  // LET OP: message.getPlainBody() geeft bij deze nieuwsbrief enkel een korte
  // teaser terug ("bekijk onze voorspellingen") — de echte prijsinfo staat
  // als platte tekst in de HTML-body (geen afbeelding), dus die lezen we
  // hier uit en zetten we om naar leesbare tekst voor Claude.
  let bodyText = htmlToText_(message.getBody());
  if (bodyText.length < 50) {
    // Val terug op de plain-text-versie als de HTML-strip onverwacht leeg/te
    // kort uitkomt (bv. een ander soort mail dan deze nieuwsbrief).
    bodyText = message.getPlainBody();
  }
  const sentDate = message.getDate();

  const updates = extractUpdatesWithClaude_(bodyText, sentDate);

  updates
    .filter(function (u) { return u.direction === 'stijging' || u.direction === 'daling'; })
    .forEach(sendToHomey_);
}

function htmlToText_(html) {
  if (!html) return '';
  let text = html;
  // CSS/MSO-commentaarblokken bevatten geen nuttige info en verdringen de
  // echte inhoud als we ze laten staan.
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // Regeleindes behouden op plaatsen die in de opmaak een nieuwe regel waren.
  text = text.replace(/<(br|\/p|\/div|\/tr|\/h[1-6])\s*\/?>/gi, '\n');
  // Resterende tags weg.
  text = text.replace(/<[^>]+>/g, ' ');
  // Meest voorkomende HTML-entities in deze nieuwsbrief decoderen.
  const entities = {
    '&nbsp;': ' ', '&amp;': '&', '&euro;': '€', '&lt;': '<', '&gt;': '>',
    '&quot;': '"', '&#39;': "'", '&rsquo;': '’',
  };
  text = text.replace(/&nbsp;|&amp;|&euro;|&lt;|&gt;|&quot;|&#39;|&rsquo;/g, function (m) {
    return entities[m];
  });
  // Overtollige witruimte opkuisen.
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function extractUpdatesWithClaude_(bodyText, sentDate) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  const sentDateIso = Utilities.formatDate(sentDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  const systemPrompt = [
    'Je bent een data-extractietool voor een Nederlandstalige nieuwsbrief',
    'over Belgische maximum brandstofprijzen. Haal per genoemde brandstof',
    '(bv. benzine E10, diesel, LPG) de relevante prijsinformatie uit de tekst.',
    '',
    'De mail is verzonden op ' + sentDateIso + '. Los relatieve datums',
    '("morgen", "zaterdag", ...) op naar absolute datums (YYYY-MM-DD)',
    't.o.v. die verzenddatum.',
    '',
    'Antwoord UITSLUITEND met geldige JSON in dit schema, zonder uitleg,',
    'zonder markdown, zonder code-fences:',
    '{"updates":[{"fuel":"euro95|diesel|lpg|...","direction":"stijging|daling|ongewijzigd",',
    '"new_price":number|null,"current_price":number|null,',
    '"change_cents_per_liter":number|null,"effective_date":"YYYY-MM-DD"|null}]}',
    '',
    'Gebruik "euro95" voor Benzine E10/95. Als een brandstof enkel ter',
    'referentie vermeld wordt zonder stijging/daling, gebruik "ongewijzigd".',
  ].join('\n');

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: bodyText }],
    }),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Claude API-fout: ' + response.getContentText());
  }

  const data = JSON.parse(response.getContentText());
  let text = data.content[0].text.trim();
  // Claude antwoordt soms toch in een ```json ... ```-codeblok, ondanks de
  // instructie om dat niet te doen; die backticks strippen we hier weg
  // zodat JSON.parse niet struikelt over het eerste teken.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(text);
  return parsed.updates || [];
}

function sendToHomey_(update) {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty('HOMEY_WEBHOOK_URL');

  const advies = update.direction === 'stijging'
    ? 'Tank nu, de prijs stijgt'
    : 'Wacht indien mogelijk, de prijs daalt';

  const payload = {
    fuel: update.fuel,
    direction: update.direction,
    new_price: update.new_price,
    current_price: update.current_price,
    change_cents_per_liter: update.change_cents_per_liter,
    effective_date: update.effective_date,
    advice: advies,
    received_at: new Date().toISOString(),
  };

  // Homey's "Webhook ontvangen"-trigger verwacht de payload als JSON-tekst
  // in een query-parameter die letterlijk "tag" heet (zie README.md).
  const url = webhookUrl + '?tag=' + encodeURIComponent(JSON.stringify(payload));

  UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true });
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
