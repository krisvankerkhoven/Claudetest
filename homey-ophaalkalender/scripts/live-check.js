'use strict';

// Rooktest tegen de echte ARP-GAN-server:  node scripts/live-check.js "Thiernessestraat" 12
if (process.env.LIVE_VIA_CURL) global.fetch = require('./curl-fetch');
const arp = require('../lib/arp');
const { fetchCalendar } = require('../lib/fetchCalendar');
const { parseCalendar, nextPickup, COLORS, localNow } = require('../lib/schedule');
const text = require('../lib/text');

(async () => {
  const term = process.argv[2] || 'Thiernessestraat';
  const number = process.argv[3] || '12';
  const [hit] = await arp.searchStreets(term);
  if (!hit) throw new Error(`Geen straat gevonden voor "${term}"`);
  const adid = await arp.validateAddress({ street: hit.street, number, zip: hit.zip });
  const { raw, columns, imageError } = await fetchCalendar({ ...hit, number, adid });
  const schedule = parseCalendar(raw, columns);
  const { date, minutes } = localNow(new Date(), 'Europe/Brussels');
  console.log(`${schedule.label} (adres-id ${adid}) – nu ${date} ${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`);
  console.log(`bron: ${schedule.source}${imageError ? ` (afbeelding: ${imageError})` : ''}`);
  for (const color of COLORS) console.log(`${color.padEnd(7)} ${text.describe(nextPickup(schedule, color, date, minutes), 'nl')}`);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
