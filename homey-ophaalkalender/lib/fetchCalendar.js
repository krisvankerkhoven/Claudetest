'use strict';

const arp = require('./arp');
const { analyzeImage } = require('./calendarImage');

// Haalt het kalenderantwoord én de kalenderafbeelding op. De afbeelding is de volledige bron; lukt het
// lezen ervan niet (bv. een nieuw sjabloon), dan blijft `columns` null en gebruikt de app de tekst.
async function fetchCalendar(address) {
  const raw = await arp.getCalendar(address);
  let columns = null;
  let imageError = null;
  try {
    const url = String(raw.img_ramassage || '').trim();
    if (!url) throw new Error('Geen kalenderafbeelding in het antwoord');
    columns = analyzeImage(await arp.getImage(url));
  } catch (err) {
    imageError = err.message;
  }
  return { raw, columns, imageError };
}

module.exports = { fetchCalendar };
