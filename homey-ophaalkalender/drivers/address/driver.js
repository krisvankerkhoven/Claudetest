'use strict';

const Homey = require('homey');
const arp = require('../../lib/arp');
const { parseCalendar } = require('../../lib/schedule');
const { fetchCalendar } = require('../../lib/fetchCalendar');

module.exports = class AddressDriver extends Homey.Driver {
  async onInit() {
    this.reminderCard = this.homey.flow.getDeviceTriggerCard('pickup_reminder');
    this.reminderCard.registerRunListener(
      async (args, state) => args.when === state.when && (args.color === 'any' || state.colors.includes(args.color)),
    );

    this.windowOpenCard = this.homey.flow.getDeviceTriggerCard('window_open');
    this.windowOpenCard.registerRunListener(
      async (args, state) => args.color === 'any' || state.colors.includes(args.color),
    );

    this.homey.flow.getConditionCard('pickup_on').registerRunListener(async args => {
      return args.device.isPickup(args.when, args.color);
    });

    this.homey.flow.getConditionCard('window_is_open').registerRunListener(async args => {
      return args.device.isWindowOpen(args.color);
    });

    this.homey.flow.getActionCard('refresh').registerRunListener(async args => {
      await args.device.refresh();
      return true;
    });
  }

  async onPair(session) {
    let selected = null;

    session.setHandler('search', async term => arp.searchStreets(term));

    session.setHandler('numbers', async ({ street, zip }) => arp.getHouseNumbers({ street, zip }));

    // Controleert het adres én de kalender voor de gebruiker verder gaat.
    session.setHandler('select', async ({ street, number, zip, city }) => {
      const adid = await arp.validateAddress({ street, number, zip });
      const { raw, columns } = await fetchCalendar({ street, number, zip, city, adid });
      const schedule = parseCalendar(raw, columns);
      selected = { street, number, zip, city, adid };
      return { label: schedule.label };
    });

    session.setHandler('list_devices', async () => {
      if (!selected) return [];
      const { street, number, zip, city, adid } = selected;
      return [
        {
          name: `${street} ${number}, ${zip} ${city}`,
          data: { id: adid },
          store: { street, number, zip, city, adid },
        },
      ];
    });
  }
};
