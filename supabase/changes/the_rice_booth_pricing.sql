alter table public.reservations
  add column if not exists amount_due_minor integer check (amount_due_minor > 0),
  add column if not exists pricing_snapshot jsonb check (pricing_snapshot is null or jsonb_typeof(pricing_snapshot) = 'object');
comment on column public.reservations.amount_due_minor is 'Server-calculated amount due in satang, fixed when the booking is confirmed.';
comment on column public.reservations.pricing_snapshot is 'Booking price snapshot: event days, daily rate, base fee and booth-number satang. Existing bookings are not repriced.';
