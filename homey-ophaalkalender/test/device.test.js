'use strict';

// Test van device.js met een nagebootste Homey-runtime (geen echte Homey nodig).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const fixtureDir = path.join(__dirname, 'fixtures');
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'thiernessestraat.json'), 'utf8'));
const columns = require('../lib/calendarImage').analyzeImage(fs.readFileSync(path.join(fixtureDir, 'thiernessestraat.png')));

class FakeDevice {
  constructor() {
    this.caps = {};
    this.store = { street: 'Thiernessestraat', number: '12', zip: '1070', city: 'Anderlecht', adid: '2007686' };
    this.settings = {
      notify_same_day: false,
      notify_same_day_time: '17:00',
      notify_window_open: true,
      notify_evening_before: false,
      notify_evening_before_time: '20:00',
      notify_white: true,
      notify_yellow: true,
      notify_blue: true,
      notify_green: true,
      notify_orange: true,
    };
    this.notifications = [];
    this.triggers = [];
    this.calls = [];
    this.now = new Date('2026-09-28T15:00:00Z'); // 17:00 in Brussel (zomertijd)
    this.homey = {
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: () => 1,
      i18n: { getLanguage: () => 'nl' },
      clock: { getTimezone: () => 'Europe/Brussels' },
      notifications: { createNotification: async n => this.notifications.push(n.excerpt) },
    };
    const record = name => ({ trigger: async (dev, tokens, state) => this.triggers.push({ name, tokens, state }) });
    this.driver = { reminderCard: record('reminder'), windowOpenCard: record('window_open') };
  }
  log() {}
  error = (...a) => { this.calls.push(['error', ...a]); };
  getStore() { return this.store; }
  getStoreValue(k) { return this.store[k]; }
  async setStoreValue(k, v) { this.store[k] = v; }
  getSettings() { return this.settings; }
  async setSettings(s) { Object.assign(this.settings, s); }
  getName() { return 'Thiernessestraat 12'; }
  async setCapabilityValue(id, v) { this.caps[id] = v; }
  async setAvailable() {}
  async setUnavailable(m) { this.unavailable = m; }
  async setWarning() {}
  async unsetWarning() {}
}

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'homey') return { Device: FakeDevice, Driver: class {}, App: class {} };
  return realLoad.call(this, request, ...rest);
};
// Geen echt netwerk: fetchCalendar wordt door een aanpasbare stub vervangen vóór het device geladen wordt.
let fetchImpl = async () => ({ raw: fixture, columns, imageError: null });
require('../lib/fetchCalendar').fetchCalendar = (...args) => fetchImpl(...args);
const AddressDevice = require('../drivers/address/device');

function freezeTime(iso) {
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [iso])); }
    static now() { return new RealDate(iso).getTime(); }
  };
  return () => { global.Date = RealDate; };
}

test.beforeEach(() => { fetchImpl = async () => ({ raw: fixture, columns, imageError: null }); });

test('tegels tonen de dag én het uur; oranje staat er nu bij', async () => {
  const restore = freezeTime('2026-09-28T15:00:00Z'); // maandag 17:00 in Brussel
  try {
    const dev = new AddressDevice();
    dev.store.calendar = fixture;
    dev.store.columns = columns;
    await dev.onInit();

    assert.strictEqual(dev.caps.pickup_white, 'wo 30 sep 18:00–24:00');
    assert.strictEqual(dev.caps.pickup_yellow, 'wo 30 sep 18:00–24:00');
    assert.strictEqual(dev.caps.pickup_blue, 'zo 4 okt 18:00–24:00');
    assert.strictEqual(dev.caps.pickup_green, 'ma 12 okt 05:00–12:00', 'maandagochtend is voorbij');
    assert.strictEqual(dev.caps.pickup_orange, 'ma 5 okt 05:00–12:00');
    assert.strictEqual(dev.caps.pickup_next, 'wo 30 sep: witte en gele zakken');
    assert.strictEqual(dev.notifications.length, 0, 'niets te melden op maandag om 17:00');
    assert.strictEqual(dev.settings.source, 'Kalenderafbeelding ARP-GAN');
  } finally {
    restore();
  }
});

test('om 18:00 gaat het venster open: melding, flow-trigger met uren, en de conditie', async () => {
  const restore = freezeTime('2026-09-30T16:00:00Z'); // woensdag 18:00 in Brussel
  try {
    const dev = new AddressDevice();
    dev.store.calendar = fixture;
    dev.store.columns = columns;
    await dev.onInit();

    assert.strictEqual(dev.notifications.length, 1);
    assert.match(dev.notifications[0], /Buitenzetten kan nu: witte en gele zakken \(18:00–24:00\)/);
    const [event] = dev.triggers;
    assert.strictEqual(event.name, 'window_open');
    assert.deepStrictEqual(event.state.colors, ['white', 'yellow']);
    assert.strictEqual(event.tokens.from, '18:00');
    assert.strictEqual(event.tokens.to, '24:00');
    assert.strictEqual(event.tokens.bags, 'witte en gele zakken');
    assert.strictEqual(dev.caps.pickup_white, 'Vandaag 18:00–24:00');

    await dev.tick(); // volgende minuut: niet opnieuw
    assert.strictEqual(dev.notifications.length, 1);
    assert.strictEqual(dev.triggers.length, 1);

    assert.strictEqual(dev.isWindowOpen('white'), true);
    assert.strictEqual(dev.isWindowOpen('blue'), false);
    assert.strictEqual(dev.isPickup('today', 'yellow'), true);
    assert.strictEqual(dev.isPickup('tomorrow', 'any'), false);
  } finally {
    restore();
  }
});

test('melding bij begin van het venster kan uitgezet worden; de flow-trigger blijft werken', async () => {
  const restore = freezeTime('2026-09-30T16:00:00Z');
  try {
    const dev = new AddressDevice();
    dev.settings.notify_window_open = false;
    dev.store.calendar = fixture;
    dev.store.columns = columns;
    await dev.onInit();
    assert.strictEqual(dev.notifications.length, 0);
    assert.strictEqual(dev.triggers.length, 1);
  } finally {
    restore();
  }
});

test('refresh bewaart kalender + afbeeldingsdata en overleeft een mislukte aanvraag met cache', async () => {
  const restore = freezeTime('2026-09-30T09:00:00Z');
  try {
    const dev = new AddressDevice();
    fetchImpl = async () => ({ raw: fixture, columns, imageError: null });
    await dev.refresh();
    assert.deepStrictEqual(dev.store.calendar, fixture);
    assert.deepStrictEqual(dev.store.columns, columns);
    assert.ok(dev.settings.last_update);

    fetchImpl = async () => { throw new Error('offline'); };
    await assert.rejects(() => dev.refresh(), /offline/);
    assert.strictEqual(dev.unavailable, undefined, 'met cache blijft het apparaat beschikbaar');
    assert.strictEqual(dev.caps.pickup_white, 'Vandaag 18:00–24:00', 'woensdag 11:00: het venster begint vanavond');
  } finally {
    restore();
  }
});

test('afbeelding onleesbaar: terugval op tekst met waarschuwing', async () => {
  const dev = new AddressDevice();
  dev.warning = null;
  dev.setWarning = async m => { dev.warning = m; };
  fetchImpl = async () => ({ raw: fixture, columns: null, imageError: 'Onverwacht PNG-formaat' });
  await dev.refresh();
  assert.strictEqual(dev.settings.source, 'Tekst ARP-GAN (afbeelding onleesbaar)');
  assert.match(dev.warning, /Onverwacht PNG-formaat/);
});

test('zonder cache en zonder internet wordt het apparaat onbeschikbaar gemeld', async () => {
  const dev = new AddressDevice();
  fetchImpl = async () => { throw new Error('offline'); };
  await assert.rejects(() => dev.refresh(), /offline/);
  assert.strictEqual(dev.unavailable, 'offline');
});
