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

class ImageError extends Error {}

// Minimale PNG-decoder (8 bit RGB/RGBA, niet-interlaced); leest enkel de eerste `maxRows` rijen.
function decodePng(buf, maxRows) {
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
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const out = Buffer.alloc(rows * stride);
  for (let y = 0; y < rows; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y ? out[dst - stride + x] : 0;
      const c = x >= bpp && y ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
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
      out[dst + x] = v & 255;
    }
  }
  return {
    width,
    height,
    pixel: (x, y) => {
      const i = (y * width + x) * bpp;
      return [out[i], out[i + 1], out[i + 2]];
    },
  };
}

const near = (p, c, tol = 6) => Math.abs(p[0] - c[0]) <= tol && Math.abs(p[1] - c[1]) <= tol && Math.abs(p[2] - c[2]) <= tol;
const isDark = p => p[0] < 90 && p[1] < 90 && p[2] < 120;
const hhmm = hours => `${String(Math.floor(hours)).padStart(2, '0')}:${hours % 1 ? '30' : '00'}`;

// Het klokje is een 12-uurs wijzerplaat: uur h staat op h*30° met de klok mee vanaf boven.
// De groene taart loopt van het begin- tot het einduur. Ochtend (< 6 u) of avond (>= 6 u -> +12).
function readClock(img, x0, x1, S) {
  const yMid = Math.round(LAYOUT.clockRow * S);
  const band = Math.max(2, Math.round(3 * S));
  let minX = Infinity;
  let maxX = -1;
  for (let y = yMid - band; y <= yMid + band; y++) {
    for (let x = x0; x < x1; x++) {
      if (isDark(img.pixel(x, y))) {
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
    const p = img.pixel(Math.round(cx + ring * Math.sin(t)), Math.round(yMid - ring * Math.cos(t)));
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
function analyzeImage(buf) {
  const S0 = 2000;
  // Eerst enkel de header lezen voor de schaal, dan rijen tot onder het klokje (straal ~65).
  const width = buf.readUInt32BE(16);
  const S = width / S0;
  const maxRows = Math.round((LAYOUT.clockRow + 70) * S);
  const img = decodePng(buf, maxRows);
  if (Math.abs(img.width / img.height - 3425 / 2596) > 0.02) throw new ImageError('Onverwachte afbeeldingsverhouding');

  const colWidth = ((LAYOUT.right - LAYOUT.left) / 7) * S;
  const minPixels = LAYOUT.minBagPixels * S * S;
  const columns = [];

  for (let c = 0; c < 7; c++) {
    const x0 = Math.round(LAYOUT.left * S + c * colWidth);
    const x1 = Math.round(x0 + colWidth);
    const counts = {};
    for (let y = Math.round(LAYOUT.bagsTop * S); y < Math.round(LAYOUT.bagsBottom * S); y++) {
      for (let x = x0; x < x1; x++) {
        const p = img.pixel(x, y);
        for (const [name, color] of Object.entries(BAG_COLORS)) if (near(p, color)) counts[name] = (counts[name] || 0) + 1;
      }
    }
    const colors = COLOR_ORDER.filter(name => counts[name] > minPixels);
    columns.push({ weekday: COLUMN_WEEKDAYS[c], colors, window: colors.length ? readClock(img, x0, x1, S) : null });
  }

  if (!columns.some(col => col.colors.length)) throw new ImageError('Geen zakken herkend in de kalenderafbeelding');
  return columns;
}

module.exports = { analyzeImage, ImageError };
