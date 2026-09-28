'use strict';

// Zuivere functies (geen netwerk, geen Homey) zodat alles testbaar is.
// Datums zijn altijd 'YYYY-MM-DD' strings in de lokale tijdzone van de Homey.

const COLORS = ['white', 'yellow', 'blue', 'green', 'orange'];

const WORDS = {
  WIT: 'white',
  GEEL: 'yellow',
  BLAUW: 'blue',
  GROEN: 'green',
  ORANJE: 'orange',
  VOEDINGSAFVAL: 'orange',
};

const DAY_KEYS = { dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6 };

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function toUtc(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(date, n) {
  return new Date(toUtc(date) + n * 86400000).toISOString().slice(0, 10);
}

function weekday(date) {
  return new Date(toUtc(date)).getUTCDay();
}

function daysBetween(from, to) {
  return Math.round((toUtc(to) - toUtc(from)) / 86400000);
}

// Lokale datum en minuten sinds middernacht in een tijdzone (bv. 'Europe/Brussels').
function localNow(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = type => parts.find(p => p.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

// Bouwt het schema van de buitenzetkalender.
//   weekly  – kleur -> weekdagen (0 = zondag) waarop de zak buiten moet
//   dates   – kleur -> exacte datums (groen: om de 2 weken, uit `SacsVerts`)
//   windows – weekdag -> { from, to } tijdvenster om buiten te zetten
//
// `columns` komt uit de kalenderafbeelding (lib/calendarImage.js) en is de volledige bron: dagen, zakken
// (ook oranje) en uren. Zonder afbeelding valt het schema terug op de tekst van het antwoord; die geeft de
// ophaaldag (vaak een dag na het buitenzetten) en mist soms zakken, dus dat is enkel een noodoplossing.
function parseCalendar(raw, columns = null) {
  if (!raw || typeof raw !== 'object' || !raw.desc_ramassage) {
    throw new Error('Onverwacht kalenderantwoord van ARP-GAN');
  }

  const dates = {};
  const sacs = Array.isArray(raw.SacsVerts) ? raw.SacsVerts.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  if (sacs.length) dates.green = [...sacs].sort();

  const weekly = {};
  const windows = {};
  const fromImage = Array.isArray(columns) && columns.some(col => col.colors.length);

  const addWeekly = (color, day) => {
    // Groen wordt maar om de 2 weken opgehaald: dan zijn de exacte datums leidend.
    if (color === 'green' && dates.green) return;
    weekly[color] = [...new Set([...(weekly[color] || []), day])].sort();
  };

  if (fromImage) {
    for (const col of columns) {
      for (const color of col.colors) addWeekly(color, col.weekday);
      if (col.window) windows[col.weekday] = col.window;
    }
  } else {
    for (const [key, day] of Object.entries(DAY_KEYS)) {
      const text = raw.desc_ramassage[key];
      if (!text) continue;

      const listed = /zakken\s+(.+?)\s+buiten/i.exec(text);
      const words = (listed ? listed[1] : text).toUpperCase().match(/[A-Z]+/g) || [];
      for (const word of words) if (WORDS[word]) addWeekly(WORDS[word], day);

      const window = /(\d{1,2}:\d{2})\s+en\s+(\d{1,2}:\d{2})/.exec(text);
      if (window) windows[day] = { from: window[1], to: window[2] };
    }
  }

  return { label: raw.rue || '', source: fromImage ? 'image' : 'text', weekly, dates, windows };
}

function isPickupDay(schedule, color, date) {
  if (schedule.dates[color]) return schedule.dates[color].includes(date);
  return (schedule.weekly[color] || []).includes(weekday(date));
}

// Het buitenzetvenster van die dag is al voorbij?
function windowEnded(schedule, date, minutes) {
  const window = schedule.windows[weekday(date)];
  return Boolean(window) && minutes >= toMinutes(window.to);
}

// Eerstvolgende datum (vandaag inbegrepen) voor één kleur, of null. Met `minutes` (lokale tijd nu)
// telt vandaag niet meer mee als het venster om buiten te zetten al voorbij is.
function nextPickup(schedule, color, today, minutes = null) {
  const skip = date => minutes !== null && date === today && windowEnded(schedule, date, minutes);
  let date = null;
  if (schedule.dates[color]) {
    date = schedule.dates[color].find(d => d >= today && !skip(d)) || null;
  } else if ((schedule.weekly[color] || []).length) {
    for (let i = 0; i < 9 && !date; i++) {
      const candidate = addDays(today, i);
      if (isPickupDay(schedule, color, candidate) && !skip(candidate)) date = candidate;
    }
  }
  if (!date) return null;
  return { date, daysUntil: daysBetween(today, date), window: schedule.windows[weekday(date)] || null };
}

function colorsOn(schedule, date) {
  return COLORS.filter(color => isPickupDay(schedule, color, date));
}

// Welke herinneringen zijn nu aan de beurt? `fired` bevat sleutels van reeds verstuurde herinneringen.
// Een herinnering blijft een uur na het ingestelde tijdstip geldig (bv. na een herstart van de Homey).
function dueReminders(schedule, local, settings, fired = []) {
  const wanted = COLORS.filter(color => settings[`notify_${color}`] !== false);
  const result = [];

  const check = (when, date, timeSetting) => {
    const [h, m] = String(timeSetting).split(':').map(Number);
    if (!Number.isInteger(h) || !Number.isInteger(m)) return;
    const target = h * 60 + m;
    if (local.minutes < target || local.minutes >= target + 60) return;
    const key = `${date}|${when}`;
    if (fired.includes(key)) return;
    // Een melding "vandaag buitenzetten" heeft geen zin meer als het venster al voorbij is.
    if (when === 'today' && windowEnded(schedule, date, local.minutes)) return;
    const colors = colorsOn(schedule, date).filter(c => wanted.includes(c));
    if (colors.length) result.push({ key, when, date, colors, window: schedule.windows[weekday(date)] || null });
  };

  if (settings.notify_same_day !== false) check('today', local.date, settings.notify_same_day_time || '17:00');
  if (settings.notify_evening_before) {
    check('tomorrow', addDays(local.date, 1), settings.notify_evening_before_time || '20:00');
  }
  return result;
}

// Mag er nu buiten gezet worden? (vandaag een zak van die kleur én binnen het uur-venster)
function isWindowOpen(schedule, color, local) {
  const colors = colorsOn(schedule, local.date).filter(c => color === 'any' || c === color);
  const window = schedule.windows[weekday(local.date)];
  if (!colors.length || !window) return false;
  return local.minutes >= toMinutes(window.from) && local.minutes < toMinutes(window.to);
}

// Begint het buitenzetvenster van vandaag nu? Blijft een half uur geldig (bv. na een herstart).
function dueWindowOpen(schedule, local, fired = []) {
  const window = schedule.windows[weekday(local.date)];
  const colors = colorsOn(schedule, local.date);
  if (!window || !colors.length) return null;
  const start = toMinutes(window.from);
  const key = `${local.date}|open`;
  if (local.minutes < start || local.minutes >= start + 30 || fired.includes(key)) return null;
  return { key, date: local.date, colors, window };
}

module.exports = {
  COLORS,
  addDays,
  weekday,
  localNow,
  parseCalendar,
  nextPickup,
  colorsOn,
  isPickupDay,
  isWindowOpen,
  dueReminders,
  dueWindowOpen,
  toMinutes,
};
