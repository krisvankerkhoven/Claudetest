'use strict';

// Client voor de publieke endpoints achter https://www.arp-gan.be/nl/kalender-buitenzetten-van-de-zakken
// (dezelfde aanroepen als het officiële kalenderformulier doet).

const STREET_URL = 'https://formsv2.arp-gan.eu/StreetEngine/GetAdress.aspx';
const CALENDAR_URL = 'https://formsv2.arp-gan.eu/GetCalendarv5/GetCalendarWeb.aspx';
const TIMEOUT_MS = 20000;
const HEADERS = { 'User-Agent': 'HomeyOphaalkalender/1.0', Accept: 'application/json' };

class ArpError extends Error {}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, headers: HEADERS, signal: controller.signal });
    if (!res.ok) throw new ArpError(`ARP-GAN antwoordde met HTTP ${res.status}`);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new ArpError('Onverwacht antwoord van ARP-GAN (geen JSON)');
    }
    if (json && !Array.isArray(json) && json.Exception) {
      throw new ArpError(`ARP-GAN meldt een fout: ${json.Exception}`);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new ArpError('ARP-GAN reageert niet (timeout)');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function streetQuery(params) {
  return `${STREET_URL}?${new URLSearchParams({ Lang: 'nl', ...params })}`;
}

// Minstens 3 letters van de straatnaam. Geeft [{ street, zip, city }] voor heel het Brussels gewest.
async function searchStreets(term) {
  const rue = String(term || '').trim();
  if (rue.length < 3) return [];
  const list = await request(streetQuery({ rue, operation: 'SEARCH' }));
  return (Array.isArray(list) ? list : []).map(s => ({ street: s.Street, zip: s.Zip, city: s.City }));
}

async function getHouseNumbers({ street, zip }) {
  const list = await request(streetQuery({ rue: street, zip, operation: 'ADRESS_NUMBER_RANGE' }));
  return Array.isArray(list) ? list.map(String) : [];
}

// Zet straat + nummer om naar het adres-id dat de kalender nodig heeft.
async function validateAddress({ street, number, zip }) {
  const list = await request(streetQuery({ rue: street, numero: number, zip, operation: 'VALIDATION' }));
  const first = Array.isArray(list) ? list[0] : null;
  if (!first || first.Statut !== 'OK' || !first.Value || /^F_/.test(first.Value)) {
    throw new ArpError('Dit huisnummer bestaat niet in de opgegeven straat');
  }
  return String(first.Value);
}

// De kalender wordt altijd in het Nederlands opgehaald: de parser leest de Nederlandse kleurnamen.
async function getCalendar({ street, number, zip, city, adid }) {
  const body = new FormData();
  body.append('rue', street);
  body.append('numero', number);
  body.append('zip', zip);
  body.append('commune', city || '');
  body.append('id', adid);
  body.append('Lang', 'nl');
  body.append('operation', 'VALIDATION');
  return request(CALENDAR_URL, { method: 'POST', body });
}

module.exports = { ArpError, searchStreets, getHouseNumbers, validateAddress, getCalendar };
