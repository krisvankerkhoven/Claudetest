'use strict';

const Homey = require('homey');
const arp = require('../../lib/arp');
const { COLORS, parseCalendar, nextPickup, colorsOn, dueReminders, localNow, addDays } = require('../../lib/schedule');
const text = require('../../lib/text');

const REFRESH_MS = 12 * 60 * 60 * 1000;
const TICK_MS = 60 * 1000;
const STALE_MS = 3 * 24 * 60 * 60 * 1000;
const FIRED_KEEP = 20;

module.exports = class AddressDevice extends Homey.Device {
  async onInit() {
    this.schedule = null;
    this.lastDate = null;

    // Laatst gekende kalender: werkt ook als ARP-GAN of het internet even weg is.
    const cached = this.getStoreValue('calendar');
    if (cached) {
      try {
        this.schedule = parseCalendar(cached);
      } catch (err) {
        this.error('Opgeslagen kalender is onbruikbaar', err.message);
      }
    }

    await this.setSettings({ address: this.addressLabel() }).catch(this.error);
    this.refreshTimer = this.homey.setInterval(() => this.refresh().catch(this.error), REFRESH_MS);
    this.tickTimer = this.homey.setInterval(() => this.tick().catch(this.error), TICK_MS);

    await this.tick().catch(this.error);
    this.refresh().catch(this.error);
  }

  async onDeleted() {
    this.homey.clearInterval(this.refreshTimer);
    this.homey.clearInterval(this.tickTimer);
  }

  async onSettings({ newSettings }) {
    // Herbereken na het opslaan van de instellingen.
    this.homey.setTimeout(() => this.tick().catch(this.error), 500);
  }

  addressLabel() {
    const { street, number, zip, city } = this.getStore();
    return `${street} ${number}, ${zip} ${city}`;
  }

  lang() {
    return this.homey.i18n.getLanguage() === 'nl' ? 'nl' : 'en';
  }

  local() {
    return localNow(new Date(), this.homey.clock.getTimezone());
  }

  // Haalt de kalender op bij ARP-GAN.
  async refresh() {
    try {
      const { street, number, zip, city, adid } = this.getStore();
      const raw = await arp.getCalendar({ street, number, zip, city, adid });
      this.schedule = parseCalendar(raw);
      await this.setStoreValue('calendar', raw);
      await this.setStoreValue('lastSuccess', Date.now());
      await this.setSettings({ last_update: new Date().toLocaleString('nl-BE', { timeZone: this.homey.clock.getTimezone() }) });
      await this.unsetWarning().catch(() => {});
      await this.setAvailable().catch(() => {});
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
    const { date } = this.local();

    const nexts = {};
    for (const color of COLORS) {
      nexts[color] = nextPickup(this.schedule, color, date);
      await this.setCapabilityValue(`pickup_${color}`, text.describe(nexts[color], lang)).catch(this.error);
    }

    const upcoming = Object.entries(nexts).filter(([, n]) => n);
    let summary = text.t(lang).noPickup;
    if (upcoming.length) {
      const first = upcoming.reduce((a, [, n]) => (n.date < a ? n.date : a), upcoming[0][1].date);
      const colors = upcoming.filter(([, n]) => n.date === first).map(([c]) => c);
      const next = nexts[colors[0]];
      summary = `${text.relative(next, lang)}: ${text.bagList(colors, lang)}`;
    }
    await this.setCapabilityValue('pickup_next', summary).catch(this.error);
    this.lastDate = date;
  }

  // Elke minuut: dagwissel verwerken en herinneringen versturen.
  async tick() {
    if (!this.schedule) return;
    const local = this.local();
    if (local.date !== this.lastDate) await this.updateCapabilities();

    const fired = this.getStoreValue('fired') || [];
    const due = dueReminders(this.schedule, local, this.getSettings(), fired);
    for (const reminder of due) {
      await this.sendReminder(reminder);
      fired.push(reminder.key);
      await this.setStoreValue('fired', fired.slice(-FIRED_KEEP));
    }
  }

  async sendReminder(reminder) {
    const lang = this.lang();
    const message = text.reminderText(reminder, lang);
    this.log('Herinnering:', message);

    await this.homey.notifications.createNotification({ excerpt: `${this.getName()}: ${message}` }).catch(this.error);

    const tokens = {
      bags: text.bagList(reminder.colors, lang),
      text: message,
      date: reminder.date,
      from: reminder.window ? reminder.window.from : '',
      to: reminder.window ? reminder.window.to : '',
    };
    await this.driver.reminderCard
      .trigger(this, tokens, { when: reminder.when, colors: reminder.colors })
      .catch(this.error);
  }

  // Voor de flow-conditie: moet deze zak vandaag/morgen buiten?
  isPickup(when, color) {
    if (!this.schedule) return false;
    const { date } = this.local();
    const colors = colorsOn(this.schedule, when === 'tomorrow' ? addDays(date, 1) : date);
    return color === 'any' ? colors.length > 0 : colors.includes(color);
  }
};
