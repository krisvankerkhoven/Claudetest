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

// Vertaalt het antwoord van GetCalendarWeb.aspx naar een schema:
//   weekly  – kleur -> weekdagen (0 = zondag) waarop de zak buiten moet
//   dates   – kleur -> exacte datums (groen: om de 2 weken, uit `SacsVerts`)
//   windows – weekdag -> { from, to } tijdvenster om buiten te zetten
function parseCalendar(raw) {
  if (!raw || typeof raw !== 'object' || !raw.desc_ramassage) {
    throw new Error('Onverwacht kalenderantwoord van ARP-GAN');
  }

  const dates = {};
  const sacs = Array.isArray(raw.SacsVerts) ? raw.SacsVerts.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  if (sacs.length) dates.green = [...sacs].sort();

  const weekly = {};
  const windows = {};
  for (const [key, day] of Object.entries(DAY_KEYS)) {
    const text = raw.desc_ramassage[key];
    if (!text) continue;

    const listed = /zakken\s+(.+?)\s+buiten/i.exec(text);
    const words = (listed ? listed[1] : text).toUpperCase().match(/[A-Z]+/g) || [];
    for (const word of words) {
      const color = WORDS[word];
      if (!color) continue;
      // Groen staat soms ook in de weekdagtekst, maar wordt maar om de 2 weken opgehaald:
      // dan zijn de exacte datums leidend.
      if (color === 'green' && dates.green) continue;
      weekly[color] = [...new Set([...(weekly[color] || []), day])].sort();
    }

    const window = /(\d{1,2}:\d{2})\s+en\s+(\d{1,2}:\d{2})/.exec(text);
    if (window) windows[day] = { from: window[1], to: window[2] };
  }

  return { label: raw.rue || '', weekly, dates, windows };
}

function isPickupDay(schedule, color, date) {
  if (schedule.dates[color]) return schedule.dates[color].includes(date);
  return (schedule.weekly[color] || []).includes(weekday(date));
}

// Eerstvolgende datum (vandaag inbegrepen) voor één kleur, of null.
function nextPickup(schedule, color, today) {
  let date = null;
  if (schedule.dates[color]) {
    date = schedule.dates[color].find(d => d >= today) || null;
  } else if ((schedule.weekly[color] || []).length) {
    for (let i = 0; i < 8 && !date; i++) {
      const candidate = addDays(today, i);
      if (isPickupDay(schedule, color, candidate)) date = candidate;
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
    const colors = colorsOn(schedule, date).filter(c => wanted.includes(c));
    if (colors.length) result.push({ key, when, date, colors, window: schedule.windows[weekday(date)] || null });
  };

  if (settings.notify_same_day !== false) check('today', local.date, settings.notify_same_day_time || '17:00');
  if (settings.notify_evening_before) {
    check('tomorrow', addDays(local.date, 1), settings.notify_evening_before_time || '20:00');
  }
  return result;
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
  dueReminders,
};
