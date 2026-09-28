'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parseCalendar, nextPickup, colorsOn, dueReminders, localNow, addDays } = require('../lib/schedule');
const { describe, reminderText, bagList } = require('../lib/text');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));

// 2026-09-28 is een maandag.
const TODAY = '2026-09-28';

test('Thiernessestraat 12: wit + blauw op maandag, geel + wit op donderdag, groen volgens datums', () => {
  const s = parseCalendar(fixture('thiernessestraat'));
  assert.deepStrictEqual(s.weekly.white, [1, 4]);
  assert.deepStrictEqual(s.weekly.blue, [1]);
  assert.deepStrictEqual(s.weekly.yellow, [4]);
  assert.strictEqual(s.weekly.orange, undefined);
  assert.strictEqual(s.weekly.green, undefined);
  assert.deepStrictEqual(s.windows[1], { from: '18:00', to: '24:00' });

  assert.strictEqual(nextPickup(s, 'white', TODAY).date, '2026-09-28');
  assert.strictEqual(nextPickup(s, 'yellow', TODAY).date, '2026-10-01');
  assert.strictEqual(nextPickup(s, 'blue', '2026-09-29').date, '2026-10-05');
  assert.strictEqual(nextPickup(s, 'green', '2026-09-29').date, '2026-10-12');
  assert.strictEqual(nextPickup(s, 'orange', TODAY), null);
});

test('groen volgt de exacte datums en niet de weekdag', () => {
  const s = parseCalendar(fixture('nieuwstraat'));
  // 2026-10-07 is een woensdag, terwijl de weekdagtekst donderdag zegt.
  assert.strictEqual(nextPickup(s, 'green', TODAY).date, '2026-10-07');
  assert.strictEqual(s.weekly.green, undefined);
  assert.ok(s.weekly.orange.includes(4), 'VOEDINGSAFVAL wordt oranje');
});

test('oranje (voedingsafval) wordt herkend', () => {
  const s = parseCalendar(fixture('molenbeek'));
  assert.deepStrictEqual(s.weekly.orange, [4]);
  assert.strictEqual(nextPickup(s, 'orange', TODAY).date, '2026-10-01');
});

test('colorsOn geeft alle kleuren van een dag', () => {
  const s = parseCalendar(fixture('thiernessestraat'));
  assert.deepStrictEqual(colorsOn(s, '2026-09-28'), ['white', 'blue', 'green']);
  assert.deepStrictEqual(colorsOn(s, '2026-09-29'), []);
});

test('nextPickup telt vandaag mee en daysUntil klopt', () => {
  const s = parseCalendar(fixture('thiernessestraat'));
  const n = nextPickup(s, 'yellow', TODAY);
  assert.strictEqual(n.daysUntil, 3);
  assert.deepStrictEqual(n.window, { from: '18:00', to: '24:00' });
});

test('parseCalendar weigert een onbruikbaar antwoord', () => {
  assert.throws(() => parseCalendar({}), /Onverwacht/);
  assert.throws(() => parseCalendar(null), /Onverwacht/);
});

test('herinneringen: dezelfde dag om 17:00, één keer', () => {
  const s = parseCalendar(fixture('thiernessestraat'));
  const settings = { notify_same_day: true, notify_same_day_time: '17:00', notify_evening_before: false };
  assert.strictEqual(dueReminders(s, { date: TODAY, minutes: 16 * 60 + 59 }, settings).length, 0);

  const due = dueReminders(s, { date: TODAY, minutes: 17 * 60 }, settings);
  assert.strictEqual(due.length, 1);
  assert.deepStrictEqual(due[0].colors, ['white', 'blue', 'green']);
  assert.strictEqual(due[0].key, '2026-09-28|today');

  assert.strictEqual(dueReminders(s, { date: TODAY, minutes: 17 * 60 + 5 }, settings, [due[0].key]).length, 0);
  assert.strictEqual(dueReminders(s, { date: TODAY, minutes: 18 * 60 + 1 }, settings).length, 0, 'te laat: overslaan');
});

test('herinnering de avond ervoor en kleurfilter', () => {
  const s = parseCalendar(fixture('thiernessestraat'));
  const settings = {
    notify_same_day: false,
    notify_evening_before: true,
    notify_evening_before_time: '20:00',
    notify_white: false,
  };
  const due = dueReminders(s, { date: '2026-09-27', minutes: 20 * 60 + 1 }, settings);
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].when, 'tomorrow');
  assert.deepStrictEqual(due[0].colors, ['blue', 'green'], 'wit is uitgezet');
});

test('geen herinnering op een dag zonder ophaling', () => {
  const s = parseCalendar(fixture('thiernessestraat'));
  assert.strictEqual(dueReminders(s, { date: '2026-09-29', minutes: 17 * 60 }, { notify_same_day: true }).length, 0);
});

test('tekst in het Nederlands en Engels', () => {
  const s = parseCalendar(fixture('thiernessestraat'));
  assert.strictEqual(describe(nextPickup(s, 'yellow', TODAY), 'nl'), 'do 1 okt (over 3 d)');
  assert.strictEqual(describe(nextPickup(s, 'white', TODAY), 'nl'), 'Vandaag (ma 28 sep)');
  assert.strictEqual(describe(nextPickup(s, 'blue', '2026-09-29'), 'nl'), 'ma 5 okt (over 6 d)');
  assert.strictEqual(describe(null, 'nl'), 'Geen ophaling');
  assert.strictEqual(describe(nextPickup(s, 'yellow', TODAY), 'en'), 'Thu 1 Oct (in 3 d)');
  assert.strictEqual(bagList(['white'], 'nl'), 'witte zak');
  assert.strictEqual(bagList(['white', 'yellow', 'blue'], 'nl'), 'witte, gele en blauwe zakken');

  const [r] = dueReminders(s, { date: TODAY, minutes: 17 * 60 }, { notify_same_day: true });
  assert.strictEqual(reminderText(r, 'nl'), 'Vandaag buitenzetten: witte, blauwe en groene zakken (18:00–24:00)');
});

test('localNow gebruikt de tijdzone (zomer- en wintertijd)', () => {
  // 2026-10-24 22:30 UTC = 2026-10-25 00:30 in Brussel (zomertijd, UTC+2)
  assert.deepStrictEqual(localNow(new Date('2026-10-24T22:30:00Z'), 'Europe/Brussels'), {
    date: '2026-10-25',
    minutes: 30,
  });
  // 2026-12-01 23:30 UTC = 2026-12-02 00:30 in Brussel (wintertijd, UTC+1)
  assert.deepStrictEqual(localNow(new Date('2026-12-01T23:30:00Z'), 'Europe/Brussels'), {
    date: '2026-12-02',
    minutes: 30,
  });
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
});
