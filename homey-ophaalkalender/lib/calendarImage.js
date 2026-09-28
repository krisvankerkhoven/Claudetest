'use strict';

// Leest de kalenderafbeelding (`img_ramassage`) van ARP-GAN. Die afbeelding is de volledige
// "buitenzetkalender": 7 kolommen (maandag..zondag) met gekleurde zakjes en een klokje met het uur.
// De tekst in het JSON-antwoord bevat niet alles (bv. de oranje zak en ochtenduren ontbreken).
//
// Alles staat in een vast sjabloon; coördinaten hieronder zijn voor een afbeelding van 2000 px breed
// en worden geschaald naar de echte breedte.

const zlib = require('node:zlib');

const COLUMN_WEEKDAYS = [1, 2, 3, 4, 5, 6, 0]; // ma..zo (0 = zondag)

const BAG_COLORS = {
  orange: [238, 114, 2],
  yellow: [255, 225, 98],
  white: [244, 241, 236],
  blue: [176, 198, 232],
  green: [168, 210, 164],
};
const COLOR_ORDER = ['white', 'yellow', 'blue', 'green', 'orange']; // vaste volgorde, zoals in de meldingen
const CLOCK_GREEN = BAG_COLORS.green;

const LAYOUT = {
  left: 37,
  right: 1930,
  bagsTop: 290,
  bagsBottom: 520,
  clockRow: 648,
  minBagPixels: 270, // oppervlakte van een zakje (in 2000px-eenheden) minstens nodig om mee te tellen
};

// Verhoog dit getal als de manier van lezen verandert: bewaarde resultaten worden dan opnieuw berekend.
const ANALYZER_VERSION = 1;

class ImageError extends Error {}

// Minimale PNG-lezer (8 bit RGB/RGBA, niet-interlaced) die de afbeelding als stroom uitpakt:
// rij per rij naar `onRow(y, row)`, en stopt na `maxRows`. Zo blijft het geheugengebruik klein
// (een volledige uitgepakte afbeelding van 3425×2596 zou ruim 26 MB kosten, te veel voor een Homey-app).
// `row` wordt hergebruikt; wie hem wil bewaren moet hem kopiëren.
function readPngRows(buf, maxRows, onRow) {
  if (buf.length < 8 || buf.toString('latin1', 1, 4) !== 'PNG') throw new ImageError('Geen PNG-afbeelding');
  let pos = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  const parts = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      if (body[12] !== 0) throw new ImageError('Geïnterlinieerde PNG wordt niet ondersteund');
    } else if (type === 'IDAT') {
      parts.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (!width || bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new ImageError('Onverwacht PNG-formaat');
  }

  const bpp = colorType === 2 ? 3 : 4;
  const stride = width * bpp;
  const rows = Math.min(height, maxRows);
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  let carry = Buffer.alloc(0);
  let y = 0;

  return new Promise((resolve, reject) => {
    const inflate = zlib.createInflate();
    let finished = false;
    const finish = err => {
      if (finished) return;
      finished = true;
      inflate.destroy();
      if (err) reject(err);
      else resolve({ width, height, bpp });
    };

    inflate.on('error', err => finish(new ImageError(`PNG-data onleesbaar: ${err.message}`)));
    inflate.on('end', () => finish(y < rows ? new ImageError('PNG is onvolledig') : null));
    inflate.on('data', chunk => {
      if (finished) return;
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let offset = 0;
      while (!finished && carry.length - offset >= stride + 1 && y < rows) {
        const filter = carry[offset];
        const src = offset + 1;
        for (let x = 0; x < stride; x++) {
          const a = x >= bpp ? cur[x - bpp] : 0;
          const b = prev[x];
          const c = x >= bpp ? prev[x - bpp] : 0;
          let v = carry[src + x];
          if (filter === 1) v += a;
          else if (filter === 2) v += b;
          else if (filter === 3) v += (a + b) >> 1;
          else if (filter === 4) {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          }
          cur[x] = v & 255;
        }
        offset += stride + 1;
        onRow(y, cur);
        y++;
        [prev, cur] = [cur, prev];
      }
      carry = carry.subarray(offset);
      if (y >= rows) finish(null);
    });

    for (const part of parts) inflate.write(part);
    inflate.end();
  });
}

const near = (p, c, tol = 6) => Math.abs(p[0] - c[0]) <= tol && Math.abs(p[1] - c[1]) <= tol && Math.abs(p[2] - c[2]) <= tol;
const isDark = p => p[0] < 90 && p[1] < 90 && p[2] < 120;
const hhmm = hours => `${String(Math.floor(hours)).padStart(2, '0')}:${hours % 1 ? '30' : '00'}`;

// Het klokje is een 12-uurs wijzerplaat: uur h staat op h*30° met de klok mee vanaf boven.
// De groene taart loopt van het begin- tot het einduur. Ochtend (< 6 u) of avond (>= 6 u -> +12).
function readClock(pixel, x0, x1, S) {
  const yMid = Math.round(LAYOUT.clockRow * S);
  const band = Math.max(2, Math.round(3 * S));
  let minX = Infinity;
  let maxX = -1;
  for (let y = yMid - band; y <= yMid + band; y++) {
    for (let x = x0; x < x1; x++) {
      if (isDark(pixel(x, y))) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  if (maxX < 0 || maxX - minX < 60 * S) return null;

  const cx = (minX + maxX) / 2;
  const radius = (maxX - minX) / 2;
  const ring = radius * 0.5;
  const green = [];
  let count = 0;
  for (let d = 0; d < 360; d++) {
    const t = (d * Math.PI) / 180;
    const p = pixel(Math.round(cx + ring * Math.sin(t)), Math.round(yMid - ring * Math.cos(t)));
    green.push(near(p, CLOCK_GREEN, 10));
    if (green[d]) count++;
  }
  if (count < 10 || count > 350) return null;

  const starts = [];
  for (let d = 0; d < 360; d++) if (green[d] && !green[(d + 359) % 360]) starts.push(d);
  if (starts.length !== 1) return null;

  const start12 = Math.round(starts[0] / 15) / 2; // in halve uren
  const length = Math.round(count / 15) / 2;
  const start = start12 < 6 ? start12 : start12 + 12;
  return { from: hhmm(start), to: start + length >= 24 ? '24:00' : hhmm(start + length) };
}

// Geeft per weekdag de zakken (colors) en het buitenzet-uur (window) terug:
//   [{ weekday: 1, colors: ['white', ...], window: { from: '18:00', to: '24:00' } | null }, ...]
// Verwerkt de afbeelding rij per rij: de zakjes worden meteen geteld en enkel de rijen rond het
// klokje worden bewaard (ongeveer 2 MB in plaats van 26 MB).
async function analyzeImage(buf) {
  if (buf.length < 24) throw new ImageError('Geen PNG-afbeelding');
  const S = buf.readUInt32BE(16) / 2000;
  const bagsTop = Math.round(LAYOUT.bagsTop * S);
  const bagsBottom = Math.round(LAYOUT.bagsBottom * S);
  const clockTop = Math.round((LAYOUT.clockRow - 70) * S);
  const clockBottom = Math.round((LAYOUT.clockRow + 70) * S);
  const colWidth = ((LAYOUT.right - LAYOUT.left) / 7) * S;
  const minPixels = LAYOUT.minBagPixels * S * S;
  const bounds = Array.from({ length: 7 }, (_, c) => {
    const x0 = Math.round(LAYOUT.left * S + c * colWidth);
    return [x0, Math.round(x0 + colWidth)];
  });
  const counts = bounds.map(() => ({}));
  const kept = new Map();
  const bpp = buf[25] === 6 ? 4 : 3; // kleurtype uit de PNG-header: 6 = RGBA, anders RGB

  const info = await readPngRows(buf, clockBottom + 1, (y, row) => {
    if (y >= bagsTop && y < bagsBottom) {
      for (let c = 0; c < 7; c++) {
        const [x0, x1] = bounds[c];
        for (let x = x0; x < x1; x++) {
          const i = x * bpp;
          const p = [row[i], row[i + 1], row[i + 2]];
          for (const name of COLOR_ORDER) if (near(p, BAG_COLORS[name])) counts[c][name] = (counts[c][name] || 0) + 1;
        }
      }
    }
    if (y >= clockTop) kept.set(y, Buffer.from(row));
  });
  if (Math.abs(info.width / info.height - 3425 / 2596) > 0.02) throw new ImageError('Onverwachte afbeeldingsverhouding');

  const pixel = (x, y) => {
    const row = kept.get(y);
    const i = x * bpp;
    return row ? [row[i], row[i + 1], row[i + 2]] : [255, 255, 255];
  };

  const columns = bounds.map(([x0, x1], c) => {
    const colors = COLOR_ORDER.filter(name => counts[c][name] > minPixels);
    return { weekday: COLUMN_WEEKDAYS[c], colors, window: colors.length ? readClock(pixel, x0, x1, S) : null };
  });
  if (!columns.some(col => col.colors.length)) throw new ImageError('Geen zakken herkend in de kalenderafbeelding');
  return columns;
}

module.exports = { analyzeImage, ImageError, ANALYZER_VERSION };
