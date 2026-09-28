'use strict';

// Rooktest tegen de echte ARP-GAN-server:  node scripts/live-check.js "Thiernessestraat" 12
if (process.env.LIVE_VIA_CURL) global.fetch = require('./curl-fetch');
const arp = require('../lib/arp');
const { parseCalendar, nextPickup, COLORS, localNow } = require('../lib/schedule');
const text = require('../lib/text');

(async () => {
  const term = process.argv[2] || 'Thiernessestraat';
  const number = process.argv[3] || '12';
  const [hit] = await arp.searchStreets(term);
  if (!hit) throw new Error(`Geen straat gevonden voor "${term}"`);
  const adid = await arp.validateAddress({ street: hit.street, number, zip: hit.zip });
  const raw = await arp.getCalendar({ ...hit, number, adid });
  const schedule = parseCalendar(raw);
  const { date } = localNow(new Date(), 'Europe/Brussels');
  console.log(`${schedule.label} (adres-id ${adid}) – vandaag ${date}`);
  for (const color of COLORS) console.log(`${color.padEnd(7)} ${text.describe(nextPickup(schedule, color, date), 'nl')}`);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
