'use strict';

const Homey = require('homey');

module.exports = class WasteCalendarApp extends Homey.App {
  async onInit() {
    this.log('Brusselse Ophaalkalender gestart');
  }
};
