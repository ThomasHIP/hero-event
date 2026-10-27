import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const origins = new Set([
  "https://hero-event.pages.dev",
  "https://therice-event.pages.dev",
  "http://localhost:8000",
  "http://localhost:8788"
]);

const clean = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[c]!));

function cors(origin: string | null) {
  const allow = origin && origins.has(origin) ? origin : "https://hero-event.pages.dev";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "vary": "Origin"
  };
}

function reply(origin: string | null, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(origin),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function sendEmail(
  key: string,
  from: string,
  to: string,
  subject: string,
  html: string,
  text: string,
  idempotencyKey: string
) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify({ from, to: [to], subject, html, text })
  });
  if (!response.ok) throw new Error((await response.text()).slice(0, 1000));
}

function confirmationMail(name: string, balance: number, visitorCount: number, activationUrl: string) {
  const subject = "My HERO | The Rice Event — ลงทะเบียนสำเร็จ / Registration Confirmed";
  const html = `<!doctype html><html lang="th"><body style="margin:0;background:#f6f8fb;font-family:Arial,'Noto Sans Thai',sans-serif;color:#17314a">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border:1px solid #e1e7ee">
    <tr><td style="padding:22px 28px;background:#0b2c4c;color:#fff"><div style="font-size:27px;font-weight:900"><span style="color:#57a3ff">My</span> <span style="color:#ef4f9a">HERO</span></div><div style="font-size:15px;margin-top:4px;opacity:.9">The Rice Event</div></td></tr>
    <tr><td style="padding:30px 28px">
      <h1 style="margin:0 0 18px;font-size:26px">ลงทะเบียนสำเร็จแล้วกับ My HERO</h1>
      <p style="font-size:17px;line-height:1.7">คุณ <strong>${esc(name)}</strong><br>ลงทะเบียนเพื่อไปงานที่ The Rice<br><strong>วันอังคารที่ 22 ถึง พุธที่ 23 ธันวาคม พ.ศ. 2569</strong></p>
      <div style="margin:22px 0;padding:20px;background:#fff5fa;border-left:5px solid #ef4f9a">
        <div style="font-size:14px;color:#6d7f90">HERO Points ของคุณ</div>
        <div style="font-size:42px;font-weight:900;color:#236fda">${balance.toLocaleString("en-US")} คะแนน</div>
        <div style="font-size:14px;line-height:1.6">ใช้เป็นส่วนลดซื้อประกัน พ.ร.บ. กับ HERO Insure</div>
      </div>
      <p style="font-size:14px;color:#6d7f90">ขณะนี้มีผู้ลงทะเบียนเข้าร่วมงานแล้ว <strong>${visitorCount}</strong> คน</p>
      <p style="margin:24px 0 10px">
        <a href="${esc(activationUrl)}" style="display:inline-block;background:#ef4f9a;color:#fff;text-decoration:none;padding:14px 20px;font-weight:800;margin-right:8px;margin-bottom:8px">เปิดใช้งาน My HERO / ตั้งรหัสผ่าน</a>
        <a href="https://heroinsure.successconnection.co.th/pages/policy-expiry.html?reader=ai&source=hero-event#purchase" style="display:inline-block;background:#2868d8;color:#fff;text-decoration:none;padding:14px 20px;font-weight:800;margin-bottom:8px">ซื้อประกัน พ.ร.บ.</a>
      </p>
      <p style="font-size:13px;line-height:1.7;color:#60778a"><strong>My HERO</strong> คือบัญชีสมาชิกหลักของคุณสำหรับ HERO Points สิทธิ์ และบริการ HERO ที่เชื่อมต่อ</p><p style="font-size:11px;line-height:1.6;color:#93a1ad">My HERO Member Services · Success Connection Co., Ltd.</p>
    </td></tr>
  </table></td></tr></table></body></html>`;

  const text = `My HERO | The Rice Event\n\nลงทะเบียนสำเร็จแล้วกับ My HERO\nคุณ ${name}\nวันอังคารที่ 22 ถึง พุธที่ 23 ธันวาคม พ.ศ. 2569\n\nHERO Points: ${balance} คะแนน\nใช้เป็นส่วนลดซื้อประกัน พ.ร.บ. กับ HERO Insure\n\nผู้ลงทะเบียนแล้ว: ${visitorCount} คน\n\nเปิดใช้งาน My HERO / ตั้งรหัสผ่าน: ${activationUrl}\nซื้อประกัน พ.ร.บ.: https://heroinsure.successconnection.co.th/pages/policy-expiry.html?reader=ai&source=hero-event#purchase\n`;
  return { subject, html, text };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (origin && !origins.has(origin)) return reply(origin, 403, { success: false, error: "Origin not allowed." });

  const url = Deno.env.get("SUPABASE_URL");
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  const service =
    (secretKeys ? Object.values(JSON.parse(secretKeys) as Record<string, string>)[0] : undefined) ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !service) return reply(origin, 500, { success: false, error: "Backend configuration is incomplete." });

  const db = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  if (req.method === "GET") {
    const requestUrl = new URL(req.url);
    const action = requestUrl.searchParams.get("action") || "status";

    if (action === "count") {
      const eventCode = clean(requestUrl.searchParams.get("event_code"), 80).toLowerCase();
      if (!eventCode) return reply(origin, 400, { success:false, error:"Event code is required." });
      const { count, error } = await db
        .from("hero_event_registrations")
        .select("id", { count: "exact", head: true })
        .eq("event_code", eventCode);
      if (error) return reply(origin, 500, { success:false, error:"Visitor count unavailable." });
      return reply(origin, 200, { success:true, visitor_count: count || 0 });
    }

    if (action === "points") {
      const token = clean(requestUrl.searchParams.get("token"), 200);
      if (!token) return reply(origin, 400, { success:false, error:"Private points link is invalid." });
      const tokenHash = await sha256(token);

      const { data: reg, error: regError } = await db
        .from("hero_event_registrations")
        .select("id, member_id, full_name, event_code, event_name, created_at")
        .eq("points_view_token_hash", tokenHash)
        .maybeSingle();

      if (regError || !reg) return reply(origin, 404, { success:false, error:"Private points link was not found." });

      const { data: account, error: accountError } = await db
        .from("hero_credit_accounts")
        .select("current_balance")
        .eq("member_id", reg.member_id)
        .maybeSingle();

      if (accountError) return reply(origin, 500, { success:false, error:"Points are temporarily unavailable." });

      return reply(origin, 200, {
        success:true,
        full_name: reg.full_name,
        event_name: reg.event_name,
        hero_credit_balance: Number(account?.current_balance || 0),
        registered_at: reg.created_at
      });
    }

    return reply(origin, 200, {
      ok: true,
      service: "HERO Event registration",
      emailConfigured: Boolean(Deno.env.get("RESEND_API_KEY"))
    });
  }

  if (req.method !== "POST") return reply(origin, 405, { success: false, error: "Method not allowed." });

  try {
    const raw = await req.json();
    if (clean(raw.website_confirm, 60)) return reply(origin, 200, { success: true });

    const eventCode = clean(raw.event_code, 80).toLowerCase();
    const eventName = clean(raw.event_name, 160);
    const fullName = clean(raw.full_name, 160);
    const mobile = clean(raw.mobile, 40);
    const email = clean(raw.email, 254).toLowerCase();
    const source = clean(raw.source, 30) || "event_link";
    const campaignCode = clean(raw.campaign_code, 80) || "HERO_EVENT_WELCOME_200";
    const pdpaConsent = raw.pdpa_consent === true;

    if (!eventCode || !eventName || !fullName || !mobile || !email || !pdpaConsent) {
      return reply(origin, 400, {
        success: false,
        error: "Please complete name, mobile, email and privacy consent."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply(origin, 400, { success: false, error: "Please enter a valid email address." });
    }

    const { data, error } = await db.rpc("register_hero_event_guest", {
      p_event_code: eventCode,
      p_event_name: eventName,
      p_full_name: fullName,
      p_mobile: mobile,
      p_email: email,
      p_pdpa_consent: pdpaConsent,
      p_source: source,
      p_campaign_code: campaignCode,
      p_metadata: {
        channel: "hero_event",
        user_agent: clean(req.headers.get("user-agent"), 300)
      }
    });

    if (error) {
      console.error("HERO event registration failed", error);
      const message = error.message || "";
      if (message.includes("INVALID_MOBILE")) return reply(origin, 400, { success: false, error: "Please enter a valid mobile number." });
      if (message.includes("INVALID_EMAIL")) return reply(origin, 400, { success: false, error: "Please enter a valid email address." });
      if (message.includes("PDPA_CONSENT_REQUIRED")) return reply(origin, 400, { success: false, error: "Privacy consent is required." });
      return reply(origin, 500, { success: false, error: "Registration could not be completed. Please try again." });
    }

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return reply(origin, 500, { success: false, error: "Registration response was incomplete." });

    if (row.already_registered || !row.registration_id) {
      return reply(origin, 200, {
        success: true,
        already_registered: true,
        duplicate_registration: true,
        confirmation_sent: false,
        welcome_awarded: false,
        hero_credit_balance: Number(row.hero_credit_balance || 0),
        visitor_count: null,
        my_hero_url: "https://my-hero.pages.dev/"
      });
    }

    const token = randomToken();
    const tokenHash = await sha256(token);
    const { error: tokenError } = await db
      .from("hero_event_registrations")
      .update({
        points_view_token_hash: tokenHash,
        points_view_token_created_at: new Date().toISOString()
      })
      .eq("id", row.registration_id);
    if (tokenError) throw tokenError;

    const { count, error: countError } = await db
      .from("hero_event_registrations")
      .select("id", { count: "exact", head: true })
      .eq("event_code", eventCode);
    if (countError) throw countError;
    const visitorCount = count || 0;

    const pointsUrl = `https://hero-event.pages.dev/the-rice/?points=${encodeURIComponent(token)}`;

    const activationToken = randomToken();
    const activationTokenHash = await sha256(activationToken);
    const activationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { error: activationInsertError } = await db
      .from("myhero_account_activations")
      .insert({
        member_id: row.member_id,
        email,
        token_hash: activationTokenHash,
        expires_at: activationExpiresAt
      });
    if (activationInsertError) throw activationInsertError;

    const activationUrl = `https://heroinsure.successconnection.co.th/pages/activate.html?activate=${encodeURIComponent(activationToken)}`;

    const resend = Deno.env.get("RESEND_API_KEY");
    const from = "My HERO | The Rice Event <notifications@vela.rest>";
    let confirmationSent = false;

    if (resend) {
      try {
        const mail = confirmationMail(fullName, Number(row.hero_credit_balance || 0), visitorCount, activationUrl);
        await sendEmail(
          resend,
          from,
          email,
          mail.subject,
          mail.html,
          mail.text,
          `hero-event:${row.registration_id}:${tokenHash.slice(0,12)}`
        );
        confirmationSent = true;
      } catch (emailError) {
        console.error("HERO Event confirmation email failed", emailError);
      }
    } else {
      console.error("RESEND_API_KEY is not configured");
    }

    return reply(origin, 201, {
      success: true,
      registration_id: row.registration_id,
      registration_name: fullName,
      hero_id_linked: true,
      hero_credit_balance: Number(row.hero_credit_balance || 0),
      welcome_awarded: Boolean(row.welcome_awarded),
      already_registered: Boolean(row.already_registered),
      visitor_count: visitorCount,
      confirmation_sent: confirmationSent,
      points_url: pointsUrl,
      dashboard_url: "https://heroinsure.successconnection.co.th/pages/dashboard.html"
    });
  } catch (error) {
    console.error(error);
    return reply(origin, 500, { success: false, error: "Registration could not be completed. Please try again." });
  }
});