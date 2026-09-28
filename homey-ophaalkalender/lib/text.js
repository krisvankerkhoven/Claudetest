'use strict';

const { weekday } = require('./schedule');

const TEXT = {
  nl: {
    days: ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'],
    months: ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
    colors: { white: 'witte', yellow: 'gele', blue: 'blauwe', green: 'groene', orange: 'oranje' },
    bag: 'zak',
    bags: 'zakken',
    and: ' en ',
    today: 'Vandaag',
    tomorrow: 'Morgen',
    inDays: n => `over ${n} d`,
    none: 'Geen ophaling',
    setOutToday: 'Vandaag buitenzetten',
    setOutTomorrow: 'Morgen buitenzetten',
    noPickup: 'Geen ophaling gepland',
  },
  en: {
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    colors: { white: 'white', yellow: 'yellow', blue: 'blue', green: 'green', orange: 'orange' },
    bag: 'bag',
    bags: 'bags',
    and: ' and ',
    today: 'Today',
    tomorrow: 'Tomorrow',
    inDays: n => `in ${n} d`,
    none: 'No collection',
    setOutToday: 'Put out today',
    setOutTomorrow: 'Put out tomorrow',
    noPickup: 'No collection planned',
  },
};

const t = lang => TEXT[lang === 'nl' ? 'nl' : 'en'];

function formatDate(date, lang) {
  const s = t(lang);
  const [, m, d] = date.split('-').map(Number);
  return `${s.days[weekday(date)]} ${d} ${s.months[m - 1]}`;
}

// "witte en blauwe zak" / "witte, gele en blauwe zakken"
function bagList(colors, lang) {
  const s = t(lang);
  const names = colors.map(c => s.colors[c]);
  const joined = names.length > 1 ? names.slice(0, -1).join(', ') + s.and + names[names.length - 1] : names[0];
  return `${joined} ${names.length > 1 ? s.bags : s.bag}`;
}

// Waarde voor een capability: "ma 5 okt (over 7 d)", "Morgen (di 29 sep)" of "Geen ophaling".
function describe(next, lang) {
  const s = t(lang);
  if (!next) return s.none;
  const date = formatDate(next.date, lang);
  if (next.daysUntil === 0) return `${s.today} (${date})`;
  if (next.daysUntil === 1) return `${s.tomorrow} (${date})`;
  return `${date} (${s.inDays(next.daysUntil)})`;
}

function relative(next, lang) {
  const s = t(lang);
  if (next.daysUntil === 0) return s.today;
  if (next.daysUntil === 1) return s.tomorrow;
  return formatDate(next.date, lang);
}

function windowText(window) {
  return window ? ` (${window.from}–${window.to})` : '';
}

function reminderText(reminder, lang) {
  const s = t(lang);
  const head = reminder.when === 'today' ? s.setOutToday : s.setOutTomorrow;
  return `${head}: ${bagList(reminder.colors, lang)}${windowText(reminder.window)}`;
}

module.exports = { t, formatDate, bagList, describe, relative, windowText, reminderText };
