'use strict';

const Homey = require('homey');
const { fetchCalendar } = require('../../lib/fetchCalendar');
const {
  COLORS,
  parseCalendar,
  nextPickup,
  colorsOn,
  isWindowOpen,
  dueReminders,
  dueWindowOpen,
  localNow,
  addDays,
} = require('../../lib/schedule');
const text = require('../../lib/text');

const REFRESH_MS = 12 * 60 * 60 * 1000;
const TICK_MS = 60 * 1000;
const STALE_MS = 3 * 24 * 60 * 60 * 1000;
const FIRED_KEEP = 20;

module.exports = class AddressDevice extends Homey.Device {
  async onInit() {
    this.schedule = null;
    this.lastKey = null;

    // Laatst gekende kalender: werkt ook als ARP-GAN of het internet even weg is.
    const raw = this.getStoreValue('calendar');
    if (raw) {
      try {
        this.schedule = parseCalendar(raw, this.getStoreValue('columns'));
      } catch (err) {
        this.error('Opgeslagen kalender is onbruikbaar', err.message);
      }
    }

    await this.setSettings({ address: this.addressLabel(), source: this.sourceLabel() }).catch(this.error);
    this.refreshTimer = this.homey.setInterval(() => this.refresh().catch(this.error), REFRESH_MS);
    this.tickTimer = this.homey.setInterval(() => this.tick().catch(this.error), TICK_MS);

    await this.tick().catch(this.error);
    this.refresh().catch(this.error);
  }

  async onDeleted() {
    this.homey.clearInterval(this.refreshTimer);
    this.homey.clearInterval(this.tickTimer);
  }

  async onSettings() {
    this.homey.setTimeout(() => this.tick().catch(this.error), 500);
  }

  addressLabel() {
    const { street, number, zip, city } = this.getStore();
    return `${street} ${number}, ${zip} ${city}`;
  }

  sourceLabel() {
    if (!this.schedule) return '-';
    return this.schedule.source === 'image' ? 'Kalenderafbeelding ARP-GAN' : 'Tekst ARP-GAN (afbeelding onleesbaar)';
  }

  lang() {
    return this.homey.i18n.getLanguage() === 'nl' ? 'nl' : 'en';
  }

  local() {
    return localNow(new Date(), this.homey.clock.getTimezone());
  }

  // Haalt de kalender op bij ARP-GAN. Twee verversingen tegelijk delen hetzelfde resultaat.
  refresh() {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async doRefresh() {
    try {
      const { street, number, zip, city, adid } = this.getStore();
      const previous = { columns: this.getStoreValue('columns'), meta: this.getStoreValue('columnsMeta') };
      const { raw, columns, meta, imageError } = await fetchCalendar({ street, number, zip, city, adid }, previous);
      this.schedule = parseCalendar(raw, columns);
      await this.setStoreValue('calendar', raw);
      await this.setStoreValue('columns', columns);
      await this.setStoreValue('columnsMeta', meta);
      await this.setStoreValue('lastSuccess', Date.now());
      await this.setSettings({
        last_update: new Date().toLocaleString('nl-BE', { timeZone: this.homey.clock.getTimezone() }),
        source: this.sourceLabel(),
      });
      await this.setAvailable().catch(() => {});
      if (imageError) {
        this.error('Kalenderafbeelding niet gelezen:', imageError);
        await this.setWarning(`Kalenderafbeelding niet leesbaar; tekst gebruikt (${imageError})`).catch(() => {});
      } else {
        await this.unsetWarning().catch(() => {});
      }
      this.lastKey = null;
      await this.updateCapabilities();
    } catch (err) {
      this.error('Kalender vernieuwen mislukt:', err.message);
      if (!this.schedule) {
        await this.setUnavailable(err.message).catch(() => {});
      } else if (Date.now() - (this.getStoreValue('lastSuccess') || 0) > STALE_MS) {
        await this.setWarning(err.message).catch(() => {});
      }
      throw err;
    }
  }

  async updateCapabilities() {
    if (!this.schedule) return;
    const lang = this.lang();
    const { date, minutes } = this.local();

    const nexts = {};
    for (const color of COLORS) {
      nexts[color] = nextPickup(this.schedule, color, date, minutes);
      await this.setCapabilityValue(`pickup_${color}`, text.describe(nexts[color], lang)).catch(this.error);
    }

    const upcoming = Object.entries(nexts).filter(([, n]) => n);
    let summary = text.t(lang).noPickup;
    if (upcoming.length) {
      const first = upcoming.reduce((a, [, n]) => (n.date < a ? n.date : a), upcoming[0][1].date);
      const colors = upcoming.filter(([, n]) => n.date === first).map(([c]) => c);
      summary = `${text.relative(nexts[colors[0]], lang)}: ${text.bagList(colors, lang)}`;
    }
    await this.setCapabilityValue('pickup_next', summary).catch(this.error);
  }

  // Elke minuut: tegels bijwerken (dagwissel of einde van een venster) en meldingen versturen.
  async tick() {
    if (!this.schedule) return;
    const local = this.local();

    // Tegels enkel opnieuw berekenen als de dag of het uur wisselt (vensters eindigen op een heel uur).
    const key = `${local.date}|${Math.floor(local.minutes / 60)}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      await this.updateCapabilities();
    }

    const fired = this.getStoreValue('fired') || [];
    const settings = this.getSettings();
    const lang = this.lang();
    const remember = async k => {
      fired.push(k);
      await this.setStoreValue('fired', fired.slice(-FIRED_KEEP));
    };

    for (const reminder of dueReminders(this.schedule, local, settings, fired)) {
      const message = text.reminderText(reminder, lang);
      await this.notify(message);
      await this.trigger(this.driver.reminderCard, reminder, message, { when: reminder.when, colors: reminder.colors });
      await remember(reminder.key);
    }

    // Het venster om buiten te zetten gaat open (bv. 18:00).
    const open = dueWindowOpen(this.schedule, local, fired);
    if (open) {
      const message = text.windowOpenText(open, lang);
      if (settings.notify_window_open !== false) await this.notify(message);
      await this.trigger(this.driver.windowOpenCard, open, message, { colors: open.colors });
      await remember(open.key);
    }
  }

  async notify(message) {
    this.log('Melding:', message);
    await this.homey.notifications.createNotification({ excerpt: `${this.getName()}: ${message}` }).catch(this.error);
  }

  async trigger(card, event, message, state) {
    const tokens = {
      bags: text.bagList(event.colors, this.lang()),
      text: message,
      date: event.date,
      from: event.window ? event.window.from : '',
      to: event.window ? event.window.to : '',
    };
    await card.trigger(this, tokens, state).catch(this.error);
  }

  // Voor de flow-conditie: staat deze zak vandaag/morgen op de buitenzetkalender?
  isPickup(when, color) {
    if (!this.schedule) return false;
    const { date } = this.local();
    const colors = colorsOn(this.schedule, when === 'tomorrow' ? addDays(date, 1) : date);
    return color === 'any' ? colors.length > 0 : colors.includes(color);
  }

  // Voor de flow-conditie: mag deze zak nu buiten (vandaag én binnen het uur-venster)?
  isWindowOpen(color) {
    return Boolean(this.schedule) && isWindowOpen(this.schedule, color, this.local());
  }
};
