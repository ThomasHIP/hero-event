(function (root) {
  'use strict';
  const EVENT_DAYS = 2;
  const DAILY_RATE_MINOR = 35000;
  function formatAmount(amountMinor) {
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error('Invalid payment amount');
    return Math.floor(amountMinor / 100) + '.' + String(amountMinor % 100).padStart(2, '0');
  }
  function quoteBooth(value) {
    const match = /^([A-Z])-?(\d{1,2})$/.exec(String(value || '').trim().toUpperCase());
    const number = match ? Number(match[2]) : 0;
    if (!match || number < 1 || number > 99) throw new Error('Invalid booth code');
    const baseMinor = EVENT_DAYS * DAILY_RATE_MINOR;
    return {
      pricing_version: 'rice-2days-350-booth-satang-v1',
      booth_code: match[1] + String(number).padStart(2, '0'),
      event_days: EVENT_DAYS,
      daily_rate: formatAmount(DAILY_RATE_MINOR),
      base_amount: formatAmount(baseMinor),
      booth_satang: number,
      amount_minor: baseMinor + number,
      amount: formatAmount(baseMinor + number),
      currency: 'THB'
    };
  }
  root.RiceBoothPricing = Object.freeze({ EVENT_DAYS, DAILY_RATE_MINOR, formatAmount, quoteBooth });
})(globalThis);
