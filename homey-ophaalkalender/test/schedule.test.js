'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseCalendar,
  nextPickup,
  colorsOn,
  dueReminders,
  dueWindowOpen,
  isWindowOpen,
  localNow,
  addDays,
} = require('../lib/schedule');
const { analyzeImage } = require('../lib/calendarImage');
const { describe, reminderText, windowOpenText, bagList } = require('../lib/text');

const dir = path.join(__dirname, 'fixtures');
const json = name => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
const image = name => analyzeImage(fs.readFileSync(path.join(dir, `${name}.png`)));
const calendar = name => parseCalendar(json(name), image(name));

// 2026-09-28 is een maandag.
const MON = '2026-09-28';

test('afbeelding Thiernessestraat: zondag wit+blauw, woensdag geel+wit, maandagochtend oranje+groen', () => {
  const days = image('thiernessestraat').filter(c => c.colors.length);
  assert.deepStrictEqual(days, [
    { weekday: 1, colors: ['green', 'orange'], window: { from: '05:00', to: '12:00' } },
    { weekday: 3, colors: ['white', 'yellow'], window: { from: '18:00', to: '24:00' } },
    { weekday: 0, colors: ['white', 'blue'], window: { from: '18:00', to: '24:00' } },
  ]);
});

test('afbeelding Molenbeek: uren 18:00–20:00; Nieuwstraat: vier zakken op woensdag', () => {
  const molenbeek = image('molenbeek').filter(c => c.colors.length);
  assert.deepStrictEqual(molenbeek.map(c => [c.weekday, c.colors.length, c.window]), [
    [1, 2, { from: '18:00', to: '20:00' }],
    [4, 4, { from: '18:00', to: '20:00' }],
  ]);
  const nieuwstraat = image('nieuwstraat').filter(c => c.colors.length);
  assert.deepStrictEqual(nieuwstraat[0].colors, ['white', 'yellow', 'green', 'orange']);
});

test('analyzeImage weigert iets dat geen kalenderafbeelding is', () => {
  assert.throws(() => analyzeImage(Buffer.from('dit is geen png dit is geen png dit')), /PNG/);
});

test('schema Thiernessestraat uit de afbeelding (bron: image)', () => {
  const s = calendar('thiernessestraat');
  assert.strictEqual(s.source, 'image');
  assert.deepStrictEqual(s.weekly.orange, [1]);
  assert.deepStrictEqual(s.weekly.white, [0, 3]);
  assert.deepStrictEqual(s.weekly.yellow, [3]);
  assert.deepStrictEqual(s.weekly.blue, [0]);
  assert.strictEqual(s.weekly.green, undefined, 'groen volgt de exacte datums');
  assert.strictEqual(s.dates.green[0], '2026-09-28');
});

test('volgende buitenzetten: vandaag telt niet meer mee als het venster voorbij is', () => {
  const s = calendar('thiernessestraat');
  // Maandag 08:00: oranje en groen mogen nog buiten (05:00–12:00)
  assert.strictEqual(nextPickup(s, 'orange', MON, 8 * 60).date, MON);
  assert.strictEqual(nextPickup(s, 'green', MON, 8 * 60).date, MON);
  // Maandag 13:00: venster voorbij, volgende week
  assert.strictEqual(nextPickup(s, 'orange', MON, 13 * 60).date, '2026-10-05');
  assert.strictEqual(nextPickup(s, 'green', MON, 13 * 60).date, '2026-10-12');
  // wit: eerstvolgende is woensdag 30 sep 18:00–24:00
  const white = nextPickup(s, 'white', MON, 13 * 60);
  assert.strictEqual(white.date, '2026-09-30');
  assert.deepStrictEqual(white.window, { from: '18:00', to: '24:00' });
  assert.strictEqual(nextPickup(s, 'blue', MON, 13 * 60).date, '2026-10-04');
  assert.strictEqual(nextPickup(s, 'yellow', MON, 13 * 60).date, '2026-09-30');
});

test('oranje bij Nieuwstraat en Molenbeek', () => {
  assert.strictEqual(nextPickup(calendar('nieuwstraat'), 'orange', MON, 0).date, '2026-09-30'); // woensdag
  assert.strictEqual(nextPickup(calendar('molenbeek'), 'orange', MON, 0).date, '2026-10-01'); // donderdag
});

test('isWindowOpen: alleen op de dag en binnen het uur-venster', () => {
  const s = calendar('thiernessestraat');
  const wed = '2026-09-30';
  assert.strictEqual(isWindowOpen(s, 'white', { date: wed, minutes: 17 * 60 + 59 }), false);
  assert.strictEqual(isWindowOpen(s, 'white', { date: wed, minutes: 18 * 60 }), true);
  assert.strictEqual(isWindowOpen(s, 'white', { date: wed, minutes: 23 * 60 + 59 }), true);
  assert.strictEqual(isWindowOpen(s, 'blue', { date: wed, minutes: 19 * 60 }), false, 'blauw staat niet op woensdag');
  assert.strictEqual(isWindowOpen(s, 'any', { date: wed, minutes: 19 * 60 }), true);
  assert.strictEqual(isWindowOpen(s, 'orange', { date: MON, minutes: 8 * 60 }), true);
  assert.strictEqual(isWindowOpen(s, 'orange', { date: MON, minutes: 12 * 60 }), false);
});

test('dueWindowOpen: begint om 18:00, één keer, geldig een half uur', () => {
  const s = calendar('thiernessestraat');
  const wed = '2026-09-30';
  assert.strictEqual(dueWindowOpen(s, { date: wed, minutes: 17 * 60 + 59 }), null);
  const open = dueWindowOpen(s, { date: wed, minutes: 18 * 60 });
  assert.deepStrictEqual(open.colors, ['white', 'yellow']);
  assert.deepStrictEqual(open.window, { from: '18:00', to: '24:00' });
  assert.strictEqual(dueWindowOpen(s, { date: wed, minutes: 18 * 60 + 5 }, [open.key]), null);
  assert.strictEqual(dueWindowOpen(s, { date: wed, minutes: 18 * 60 + 31 }), null, 'te laat');
  assert.strictEqual(dueWindowOpen(s, { date: '2026-09-29', minutes: 18 * 60 }), null, 'dinsdag: niets');
  const mon = dueWindowOpen(s, { date: MON, minutes: 5 * 60 });
  assert.deepStrictEqual(mon.window, { from: '05:00', to: '12:00' });
});

test('herinnering "vandaag" wordt overgeslagen als het venster al voorbij is', () => {
  const s = calendar('thiernessestraat');
  const settings = { notify_same_day: true, notify_same_day_time: '17:00' };
  assert.strictEqual(dueReminders(s, { date: MON, minutes: 17 * 60 }, settings).length, 0, 'ochtendvenster voorbij');
  const wed = dueReminders(s, { date: '2026-09-30', minutes: 17 * 60 }, settings);
  assert.strictEqual(wed.length, 1);
  assert.deepStrictEqual(wed[0].colors, ['white', 'yellow']);
});

test('herinnering de avond ervoor en kleurfilter', () => {
  const s = calendar('thiernessestraat');
  const settings = {
    notify_same_day: false,
    notify_evening_before: true,
    notify_evening_before_time: '20:00',
    notify_white: false,
  };
  const due = dueReminders(s, { date: '2026-09-29', minutes: 20 * 60 + 1 }, settings);
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].when, 'tomorrow');
  assert.deepStrictEqual(due[0].colors, ['yellow'], 'wit is uitgezet');
  assert.strictEqual(dueReminders(s, { date: '2026-09-29', minutes: 20 * 60 + 1 }, settings, [due[0].key]).length, 0);
});

test('tekst in het Nederlands en Engels', () => {
  const s = calendar('thiernessestraat');
  assert.strictEqual(describe(nextPickup(s, 'white', MON, 13 * 60), 'nl'), 'wo 30 sep 18:00–24:00');
  assert.strictEqual(describe(nextPickup(s, 'orange', MON, 8 * 60), 'nl'), 'Vandaag 05:00–12:00');
  assert.strictEqual(describe(nextPickup(s, 'orange', '2026-10-04', 8 * 60), 'nl'), 'Morgen 05:00–12:00');
  assert.strictEqual(describe(nextPickup(s, 'white', MON, 13 * 60), 'en'), 'Wed 30 Sep 18:00–24:00');
  assert.strictEqual(describe(null, 'nl'), 'Geen ophaling');
  assert.strictEqual(bagList(['white'], 'nl'), 'witte zak');
  assert.strictEqual(bagList(['white', 'yellow', 'blue'], 'nl'), 'witte, gele en blauwe zakken');
  const open = dueWindowOpen(s, { date: '2026-09-30', minutes: 18 * 60 });
  assert.strictEqual(windowOpenText(open, 'nl'), 'Buitenzetten kan nu: witte en gele zakken (18:00–24:00)');
  assert.strictEqual(windowOpenText(open, 'en'), 'You can put out now: white and yellow bags (18:00–24:00)');
  const [r] = dueReminders(s, { date: '2026-09-30', minutes: 17 * 60 }, { notify_same_day: true });
  assert.strictEqual(reminderText(r, 'nl'), 'Vandaag buitenzetten: witte en gele zakken (18:00–24:00)');
});

// --- Terugval op de tekst (als de afbeelding niet leesbaar is) ---

test('zonder afbeelding valt het schema terug op de tekst (bron: text)', () => {
  const s = parseCalendar(json('thiernessestraat'));
  assert.strictEqual(s.source, 'text');
  assert.deepStrictEqual(s.weekly.white, [1, 4]);
  assert.deepStrictEqual(s.weekly.blue, [1]);
  assert.deepStrictEqual(s.weekly.yellow, [4]);
  assert.strictEqual(s.weekly.orange, undefined);
  assert.deepStrictEqual(s.windows[1], { from: '18:00', to: '24:00' });
  assert.strictEqual(nextPickup(s, 'yellow', MON).date, '2026-10-01');
  assert.strictEqual(parseCalendar(json('nieuwstraat')).weekly.orange[0], 4, 'VOEDINGSAFVAL = oranje');
});

test('een afbeelding zonder zakken wordt genegeerd en de tekst gebruikt', () => {
  const s = parseCalendar(json('thiernessestraat'), [{ weekday: 1, colors: [], window: null }]);
  assert.strictEqual(s.source, 'text');
});

test('parseCalendar weigert een onbruikbaar antwoord', () => {
  assert.throws(() => parseCalendar({}), /Onverwacht/);
  assert.throws(() => parseCalendar(null), /Onverwacht/);
});

test('colorsOn en localNow', () => {
  const s = calendar('thiernessestraat');
  assert.deepStrictEqual(colorsOn(s, MON), ['green', 'orange']);
  assert.deepStrictEqual(colorsOn(s, '2026-09-29'), []);
  assert.deepStrictEqual(localNow(new Date('2026-10-24T22:30:00Z'), 'Europe/Brussels'), { date: '2026-10-25', minutes: 30 });
  assert.deepStrictEqual(localNow(new Date('2026-12-01T23:30:00Z'), 'Europe/Brussels'), { date: '2026-12-02', minutes: 30 });
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
});
