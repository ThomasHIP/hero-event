# HERO Event

**Event Booking & Engagement Platform**

HERO Event is a reusable event platform for organizers, exhibitors and visitors. The Rice Building is the first event implementation.

## Initial structure

- Root: HERO Event platform landing page
- the-rice: TheRice-Event booking experience
- Interactive 120-space floor plan
- Visitor and exhibitor registration prototypes
- Booking, pending-payment and paid states
- HERO Insure benefit presentation

## Production roadmap

1. Connect Cloudflare Pages to this repository.
2. Connect Supabase for users, events, exhibitors, visitors, spaces, bookings and payments.
3. Add authentication and PDPA consent records.
4. Add 48-hour payment expiration.
5. Connect HERO PAY and HERO Insure coupon redemption.
6. Add organizer and platform-admin dashboards.

## Cloudflare Pages

- Project name: hero-event
- Production branch: main
- Framework preset: None
- Build command: blank
- Build output directory: /

Every push to main should deploy automatically after Cloudflare is connected.
