'use strict';

// Alleen voor tests in een sandbox waar Node's fetch niet door de proxy geraakt (curl wel).
// Op een echte Homey gebruikt de app gewoon het ingebouwde fetch.
const { execFile } = require('node:child_process');

module.exports = function curlFetch(url, options = {}) {
  const args = ['-sS', '-m', '20', '-w', '\n%{http_code}'];
  if (options.method === 'POST') {
    args.push('-X', 'POST');
    for (const [k, v] of options.body) args.push('-F', `${k}=${v}`);
  }
  args.push(url);
  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: 5e6 }, (err, stdout) => {
      if (err) return reject(err);
      const i = stdout.lastIndexOf('\n');
      const status = Number(stdout.slice(i + 1));
      resolve({ ok: status >= 200 && status < 300, status, text: async () => stdout.slice(0, i) });
    });
  });
};
