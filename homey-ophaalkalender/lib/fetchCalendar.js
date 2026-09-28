'use strict';

const arp = require('./arp');
const { analyzeImage, ANALYZER_VERSION } = require('./calendarImage');

const IMAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Handtekening van het schema in het antwoord: verandert die niet, dan is ook de afbeelding hetzelfde.
function signature(raw) {
  return JSON.stringify([ANALYZER_VERSION, raw.desc_ramassage, Array.isArray(raw.SacsVerts) ? raw.SacsVerts.length : 0]);
}

// Haalt het kalenderantwoord op en leest de kalenderafbeelding. De afbeelding is de volledige bron;
// lukt het lezen niet (bv. een nieuw sjabloon), dan blijft `columns` null en gebruikt de app de tekst.
//
// De afbeelding is 3425×2596 pixels en kost geheugen en rekentijd om te lezen. Omdat ze zelden verandert,
// wordt een eerder resultaat (`previous`: { columns, meta }) hergebruikt zolang het schema in de tekst
// gelijk blijft en het resultaat jonger is dan 7 dagen.
async function fetchCalendar(address, previous = {}, now = Date.now()) {
  const raw = await arp.getCalendar(address);
  const sig = signature(raw);
  const meta = previous.meta;

  if (previous.columns && meta && meta.signature === sig && now - meta.at < IMAGE_MAX_AGE_MS) {
    return { raw, columns: previous.columns, meta, imageError: null, reused: true };
  }

  try {
    const url = String(raw.img_ramassage || '').trim();
    if (!url) throw new Error('Geen kalenderafbeelding in het antwoord');
    const columns = await analyzeImage(await arp.getImage(url));
    return { raw, columns, meta: { signature: sig, at: now }, imageError: null, reused: false };
  } catch (err) {
    return { raw, columns: null, meta: null, imageError: err.message, reused: false };
  }
}

module.exports = { fetchCalendar };
