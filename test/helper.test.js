// Talks to the compiled helper over the native messaging protocol, in dry-run
// mode so nothing is actually opened. Build it first:
//   swiftc -O -o test/.build/helper helper/default-browser-links-helper.swift
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = process.env.DBL_HELPER || path.join(__dirname, '.build', 'helper');

function frame(obj) {
  const body = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function unframe(buf) {
  const out = [];
  for (let i = 0; i + 4 <= buf.length;) {
    const len = buf.readUInt32LE(i);
    out.push(JSON.parse(buf.subarray(i + 4, i + 4 + len)));
    i += 4 + len;
  }
  return out;
}

function run(messages, env = {}) {
  const input = Buffer.concat(messages.map(frame));
  const r = spawnSync(HELPER, [], { input, env: { ...process.env, ...env }, timeout: 10000 });
  assert.equal(r.status, 0, r.stderr.toString());
  return unframe(r.stdout);
}

const skip = !fs.existsSync(HELPER) && `helper not built at ${HELPER}`;

test('ping reports the default browser', { skip }, () => {
  const [reply] = run([{ type: 'ping' }]);
  assert.equal(reply.ok, true);
  assert.equal(reply.version, 1);
  assert.equal(typeof reply.defaultIsHost, 'boolean');
  // The test runner isn't a browser, so it can't be the default one.
  assert.equal(reply.defaultIsHost, false);
  assert.match(reply.defaultBrowser.path, /\.app$/);
  assert.ok(reply.defaultBrowser.name.length > 0);
});

test('open hands web URLs over (dry run)', { skip }, () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbl-')), 'opened.txt');
  const urls = ['https://example.com/a?b=c#d', 'http://example.org/'];
  const replies = run(urls.map((url) => ({ type: 'open', url })), { DBL_DRY_RUN: log });
  assert.deepEqual(replies, [{ ok: true, dryRun: true }, { ok: true, dryRun: true }]);
  assert.equal(fs.readFileSync(log, 'utf8'), urls.join('\n') + '\n');
});

test('open refuses anything but http(s)', { skip }, () => {
  const bad = ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c', 'ftp://x', '', 'not a url', 42, null];
  const replies = run(bad.map((url) => ({ type: 'open', url })), { DBL_DRY_RUN: '/dev/null' });
  for (const r of replies) assert.deepEqual(r, { ok: false, error: 'bad-url' });
  assert.equal(replies.length, bad.length);
});

test('unknown requests get an error, not a crash', { skip }, () => {
  assert.deepEqual(run([{ type: 'nope' }, {}]), [
    { ok: false, error: 'unknown request' },
    { ok: false, error: 'unknown request' },
  ]);
});

test('exits cleanly on malformed or truncated input', { skip }, () => {
  // Not JSON: readMessage returns nil and the loop ends.
  let r = spawnSync(HELPER, [], { input: frame('{oops'), timeout: 5000 });
  assert.equal(r.status, 0);
  // Header promises more bytes than arrive.
  const header = Buffer.alloc(4);
  header.writeUInt32LE(100);
  r = spawnSync(HELPER, [], { input: Buffer.concat([header, Buffer.from('{}')]), timeout: 5000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length, 0);
});
