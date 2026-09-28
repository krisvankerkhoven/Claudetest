'use strict';

// Test van device.js met een nagebootste Homey-runtime (geen echte Homey nodig).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'thiernessestraat.json'), 'utf8'));

class FakeDevice {
  constructor() {
    this.caps = {};
    this.store = { street: 'Thiernessestraat', number: '12', zip: '1070', city: 'Anderlecht', adid: '2007686' };
    this.settings = {
      notify_same_day: true,
      notify_same_day_time: '17:00',
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
    this.driver = { reminderCard: { trigger: async (dev, tokens, state) => this.triggers.push({ tokens, state }) } };
  }
  log() {}
  error(...a) { this.calls.push(['error', ...a]); }
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
const arp = require('../lib/arp');
const AddressDevice = require('../drivers/address/device');

function freezeTime(iso) {
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [iso])); }
    static now() { return new RealDate(iso).getTime(); }
  };
  return () => { global.Date = RealDate; };
}

test('onInit met cache vult de capabilities en stuurt de herinnering van 17:00 één keer', async () => {
  const restore = freezeTime('2026-09-28T15:00:00Z');
  try {
    arp.getCalendar = async () => fixture;
    const dev = new AddressDevice();
    dev.store.calendar = fixture;
    await dev.onInit();

    assert.strictEqual(dev.caps.pickup_white, 'Vandaag (ma 28 sep)');
    assert.strictEqual(dev.caps.pickup_yellow, 'do 1 okt (over 3 d)');
    assert.strictEqual(dev.caps.pickup_orange, 'Geen ophaling');
    assert.strictEqual(dev.caps.pickup_next, 'Vandaag: witte, blauwe en groene zakken');

    assert.strictEqual(dev.notifications.length, 1);
    assert.match(dev.notifications[0], /Vandaag buitenzetten: witte, blauwe en groene zakken \(18:00–24:00\)/);
    assert.deepStrictEqual(dev.triggers[0].state, { when: 'today', colors: ['white', 'blue', 'green'] });
    assert.strictEqual(dev.triggers[0].tokens.from, '18:00');

    await dev.tick(); // tweede minuut: niet opnieuw versturen
    assert.strictEqual(dev.notifications.length, 1);
    assert.strictEqual(dev.isPickup('today', 'blue'), true);
    assert.strictEqual(dev.isPickup('today', 'yellow'), false);
    assert.strictEqual(dev.isPickup('tomorrow', 'any'), false);
  } finally {
    restore();
  }
});

test('refresh bewaart de kalender en overleeft een mislukte aanvraag met cache', async () => {
  const restore = freezeTime('2026-09-28T09:00:00Z');
  try {
    const dev = new AddressDevice();
    arp.getCalendar = async () => fixture;
    await dev.refresh();
    assert.deepStrictEqual(dev.store.calendar, fixture);
    assert.ok(dev.settings.last_update);

    arp.getCalendar = async () => { throw new Error('offline'); };
    await assert.rejects(() => dev.refresh(), /offline/);
    assert.strictEqual(dev.unavailable, undefined, 'met cache blijft het apparaat beschikbaar');
    assert.strictEqual(dev.caps.pickup_white, 'Vandaag (ma 28 sep)');
  } finally {
    restore();
  }
});

test('zonder cache en zonder internet wordt het apparaat onbeschikbaar gemeld', async () => {
  const dev = new AddressDevice();
  arp.getCalendar = async () => { throw new Error('offline'); };
  await assert.rejects(() => dev.refresh(), /offline/);
  assert.strictEqual(dev.unavailable, 'offline');
});
