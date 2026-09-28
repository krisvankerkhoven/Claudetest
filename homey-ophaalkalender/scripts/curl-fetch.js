'use strict';

// Alleen voor tests in een sandbox waar Node's fetch niet door de proxy geraakt (curl wel).
// Op een echte Homey gebruikt de app gewoon het ingebouwde fetch.
const { execFile } = require('node:child_process');

module.exports = function curlFetch(url, options = {}) {
  const args = ['-sS', '-m', '30', '-w', '\n%{http_code}'];
  if (options.method === 'POST') {
    args.push('-X', 'POST');
    for (const [k, v] of options.body) args.push('-F', `${k}=${v}`);
  }
  args.push(url);
  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: 20e6, encoding: 'buffer' }, (err, stdout) => {
      if (err) return reject(err);
      const i = stdout.lastIndexOf(10);
      const status = Number(stdout.subarray(i + 1).toString());
      const body = stdout.subarray(0, i);
      resolve({
        ok: status >= 200 && status < 300,
        status,
        text: async () => body.toString('utf8'),
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
      });
    });
  });
};
