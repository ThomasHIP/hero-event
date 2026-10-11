const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { stripTypeScriptTypes } = require('node:module');
const { webcrypto, createHash } = require('node:crypto');
const root = path.join(__dirname, '..');
const browserHelper = fs.readFileSync(path.join(root, 'the-rice/booth-pricing.js'), 'utf8').trim();
const serverHelper = fs.readFileSync(path.join(root, 'supabase/functions/hero-event-api/booth-pricing.js'), 'utf8').trim();
function runtime() {
  const context = vm.createContext({ console, crypto: webcrypto, TextEncoder, Request, Response, URL });
  vm.runInContext(browserHelper, context);
  return context;
}
test('payment amounts match the requested booths and remain exact decimal strings', () => {
  const { RiceBoothPricing: pricing } = runtime();
  for (const [code, amount, minor] of [['A-45', '700.45', 70045], ['B-45', '700.45', 70045], ['C-30', '700.30', 70030], ['D-01', '700.01', 70001], ['a1', '700.01', 70001]]) {
    const quote = pricing.quoteBooth(code);
    assert.equal(quote.amount, amount);
    assert.equal(quote.amount_minor, minor);
    assert.equal(quote.event_days, 2);
    assert.equal(quote.daily_rate, '350.00');
  }
  for (const code of ['', 'A-00', 'A-100', 'A-45x', 'A--01', 'A-1.5']) assert.throws(() => pricing.quoteBooth(code));
});
test('frontend and deployed backend use the same price rule', () => assert.equal(browserHelper, serverHelper));
function backend() {
  const context = runtime();
  const state = {
    reservation: { id: 'reservation-test', event_id: 'event-test', status: 'held', registration_id: 'registration-test', booth_id: 'booth-test', booking_reference: 'RICE-A45-TEST', access_token_hash: createHash('sha256').update('test-token').digest('hex'), hold_expires_at: new Date(Date.now() + 600000).toISOString(), booths: { code: 'A45' }, registrations: { email: 'tester@example.invalid', full_name: 'Test' } },
    emails: []
  };
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; }
    eq(key, value) { this.filters.push([key, value]); return this; }
    update(value) { this.patch = value; return this; }
    insert(value) { this.inserted = value; return this; }
    async single() { return this.result(); }
    async maybeSingle() { return this.result(); }
    then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); }
    result() {
      if (this.table === 'events') return { data: { id: 'event-test' }, error: null };
      if (this.table === 'event_settings') return { data: { payment_hours: 48 }, error: null };
      if (this.table === 'reservations') {
        if (!this.filters.every(([key, value]) => state.reservation[key] === value)) return { data: null, error: null };
        if (this.patch) Object.assign(state.reservation, this.patch);
        return { data: { ...state.reservation }, error: null };
      }
      return { data: null, error: null };
    }
  }
  context.createClient = () => ({ from: table => new Query(table) });
  context.Deno = { env: { get: key => key === 'SUPABASE_SECRET_KEYS' ? '{}' : 'test-config' }, serve: handler => { context.handler = handler; } };
  context.fetch = async (url, options) => { state.emails.push(JSON.parse(options.body)); return new Response('{"id":"test-message"}', { status: 200 }); };
  const ts = fs.readFileSync(path.join(root, 'supabase/functions/hero-event-api/index.ts'), 'utf8').replace(/^import .*\n/gm, '');
  vm.runInContext(stripTypeScriptTypes(ts), context);
  return { context, state };
}
test('confirmation uses the reserved booth and ignores client-supplied amount and booth', async () => {
  const { context, state } = backend();
  const response = await context.handler(new Request('https://test.invalid', { method: 'POST', body: JSON.stringify({ action: 'confirm', reservation_id: 'reservation-test', token: 'test-token', no_refund_ack: true, amount: '1.00', booth_code: 'B01' }) }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.payment_quote.booth_code, 'A45');
  assert.equal(result.payment_quote.amount, '700.45');
  assert.equal(state.reservation.amount_due_minor, 70045);
  assert.equal(state.reservation.pricing_snapshot.amount, '700.45');
  assert.match(state.emails[0].html, /700\.45/);
});
test('saved quotes remain fixed and are scoped to The Rice event', () => {
  const { context } = backend();
  const saved = { amount_due_minor: 64500, pricing_snapshot: { amount_minor: 64500, amount: '645.00', booth_code: 'A45', event_days: 3 } };
  assert.equal(context.bookingQuote(saved, 'A45', 'the-rice').amount, '645.00');
  assert.equal(context.bookingQuote(saved, 'A45', 'other-event'), null);
});
test('incorrect booking token cannot confirm or change the price', async () => {
  const { context, state } = backend();
  const response = await context.handler(new Request('https://test.invalid', { method: 'POST', body: JSON.stringify({ action: 'confirm', reservation_id: 'reservation-test', token: 'wrong-token', no_refund_ack: true }) }));
  assert.equal(response.status, 409);
  assert.equal(state.reservation.amount_due_minor, undefined);
  assert.equal(state.emails.length, 0);
});
test('inline page scripts parse and the event no longer advertises three days', () => {
  for (const file of ['the-rice/index.html', 'the-rice/admin.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
    if (file.endsWith('/index.html')) {
      assert.doesNotMatch(html, /งาน 3 วัน|3-DAY EVENT|3 วัน \/ Days/);
      assert.match(html, /paymentSpace.textContent = result.payment_quote.booth_code/);
    }
  }
});
