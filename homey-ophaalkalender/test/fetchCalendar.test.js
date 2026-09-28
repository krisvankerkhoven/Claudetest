'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const arp = require('../lib/arp');
const { fetchCalendar } = require('../lib/fetchCalendar');

const dir = path.join(__dirname, 'fixtures');
const raw = () => ({ ...JSON.parse(fs.readFileSync(path.join(dir, 'thiernessestraat.json'), 'utf8')), img_ramassage: ' https://formsv2.arp-gan.eu/calendarv5/pdf/x.jpg ' });
const png = fs.readFileSync(path.join(dir, 'thiernessestraat.png'));
const DAY = 24 * 60 * 60 * 1000;
const address = { street: 'Thiernessestraat', number: '12', zip: '1070', city: 'Anderlecht', adid: '2007686' };

function stub({ response = raw(), image = png } = {}) {
  const calls = { images: 0 };
  arp.getCalendar = async () => response;
  arp.getImage = async () => {
    calls.images++;
    if (image instanceof Error) throw image;
    return image;
  };
  return calls;
}

test('leest de afbeelding de eerste keer', async () => {
  const calls = stub();
  const r = await fetchCalendar(address, {}, 1000);
  assert.strictEqual(calls.images, 1);
  assert.strictEqual(r.reused, false);
  assert.strictEqual(r.columns.filter(c => c.colors.length).length, 3);
  assert.deepStrictEqual(r.meta.at, 1000);
});

test('hergebruikt het resultaat zolang het schema gelijk blijft en het jonger is dan 7 dagen', async () => {
  const calls = stub();
  const first = await fetchCalendar(address, {}, 0);
  const again = await fetchCalendar(address, { columns: first.columns, meta: first.meta }, 6 * DAY);
  assert.strictEqual(calls.images, 1, 'afbeelding niet opnieuw gedownload of gelezen');
  assert.strictEqual(again.reused, true);
  assert.deepStrictEqual(again.columns, first.columns);
});

test('leest opnieuw na 7 dagen of als het schema verandert', async () => {
  const calls = stub();
  const first = await fetchCalendar(address, {}, 0);
  const previous = { columns: first.columns, meta: first.meta };

  await fetchCalendar(address, previous, 8 * DAY);
  assert.strictEqual(calls.images, 2, 'te oud');

  const changed = raw();
  changed.desc_ramassage = { ...changed.desc_ramassage, mardi: 'Dinsdag, Zet je zakken GEEL buiten tussen 18:00 en 24:00' };
  stub({ response: changed });
  const calls2 = { images: 0 };
  arp.getImage = async () => { calls2.images++; return png; };
  const r = await fetchCalendar(address, previous, 1 * DAY);
  assert.strictEqual(calls2.images, 1, 'schema veranderd');
  assert.strictEqual(r.reused, false);
});

test('een onleesbare afbeelding geeft columns = null en een foutmelding, geen crash', async () => {
  stub({ image: Buffer.from('geen png, gewoon tekst die lang genoeg is voor de controle') });
  const bad = await fetchCalendar(address, {}, 0);
  assert.strictEqual(bad.columns, null);
  assert.match(bad.imageError, /PNG/);

  stub({ image: new Error('HTTP 404') });
  const missing = await fetchCalendar(address, {}, 0);
  assert.strictEqual(missing.columns, null);
  assert.strictEqual(missing.imageError, 'HTTP 404');

  const noUrl = raw();
  delete noUrl.img_ramassage;
  stub({ response: noUrl });
  assert.match((await fetchCalendar(address, {}, 0)).imageError, /Geen kalenderafbeelding/);
});

test('getImage haalt enkel afbeeldingen van arp-gan.eu op', async () => {
  const real = require('../lib/arp');
  for (const url of ['http://formsv2.arp-gan.eu/a.jpg', 'https://evil.example.com/a.jpg', 'https://arp-gan.eu.evil.com/a.jpg']) {
    // de echte functie is hierboven vervangen; laad hem opnieuw uit een verse module
    delete require.cache[require.resolve('../lib/arp')];
    const fresh = require('../lib/arp');
    await assert.rejects(() => fresh.getImage(url), /Onverwacht adres/);
    Object.assign(real, { getImage: real.getImage });
  }
});
