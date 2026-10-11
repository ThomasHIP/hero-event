import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import "./booth-pricing.js";

const boothPricing = (globalThis as any).RiceBoothPricing;
function bookingQuote(reservation: any, boothCode: string, eventSlug: string) {
  if (eventSlug !== "the-rice") return null;
  const saved = reservation?.pricing_snapshot;
  const minor = Number(reservation?.amount_due_minor);
  if (saved && Number.isSafeInteger(minor) && minor > 0) {
    return { ...saved, booth_code: boothCode, amount_minor: minor, amount: boothPricing.formatAmount(minor) };
  }
  return boothPricing.quoteBooth(boothCode);
}
function quoteEmail(quote: any) {
  return quote ? `<p>ระยะเวลางาน / Event duration: <strong>${quote.event_days} วัน / days</strong></p><p>ค่าเช่า / Rental: ${quote.daily_rate} บาท × ${quote.event_days} วัน = ${quote.base_amount} บาท</p><p>เศษสตางค์ตามเลขบูธ / Booth-number satang: ${quote.booth_satang}</p><p>ยอดที่ต้องโอน / Amount due: <strong>${quote.amount} บาท / THB</strong></p>` : "";
}

const allowedOrigins = new Set(["https://hero-event.pages.dev", "http://localhost:8000", "http://127.0.0.1:8000"]);
const jsonHeaders = (origin: string | null) => ({
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://hero-event.pages.dev",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});
const reply = (origin: string | null, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: jsonHeaders(origin) });
const clean = (v: unknown, max = 500) => typeof v === "string" ? v.trim().slice(0, max) : "";
const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const mobileOk = (v: string) => /^[0-9+()\-\s]{8,20}$/.test(v);
const escapeHtml = (v: string) => v.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]!));
const slugify = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "shop";
const tokenHash = async (token: string) => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, "0")).join("");
};
const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
const adminKey = secretKeys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, adminKey!);
const resendKey = Deno.env.get("RESEND_API_KEY")!;
const exhibitorTerms = `<div style="margin-top:22px;padding:14px;background:#f4f7fb;border-radius:12px"><p style="color:#174f9f"><strong>ความเป็นส่วนตัว / Privacy:</strong> ผู้แสดงสินค้าอนุญาตให้เผยแพร่ข้อมูลร้านค้าบนสื่อของงานและหน้าออนไลน์ / The exhibitor authorizes publication of shop information on event and online pages.</p><p style="color:#991f2d;text-decoration:underline"><strong>การยกเลิกและคืนเงิน / Cancellation & Refund:</strong> การจองและการชำระเงินไม่สามารถยกเลิกหรือขอคืนเงินได้ในทุกกรณี / Booking and payment cannot be cancelled or refunded under any circumstances.</p></div>`;

type AdminProfile={id:string;auth_user_id:string;event_id:string|null;role:string;full_name:string;email:string;mobile:string;status:string};
async function getAdmin(req:Request,eventId:string):Promise<AdminProfile|null>{
  const header=req.headers.get("authorization")||"";
  const token=header.startsWith("Bearer ")?header.slice(7):"";
  if(!token)return null;
  const {data:userData,error:userError}=await supabase.auth.getUser(token);
  if(userError||!userData.user)return null;
  const {data:admin}=await supabase.from("event_admins").select("*").eq("auth_user_id",userData.user.id).in("status",["active","invited"]).maybeSingle();
  if(!admin||(admin.role!=="hero_super_admin"&&admin.event_id!==eventId))return null;
  await supabase.from("event_admins").update({last_login_at:new Date().toISOString(),status:"active"}).eq("id",admin.id);
  return admin as AdminProfile;
}
async function evidence(req:Request){
  const ip=req.headers.get("cf-connecting-ip")||req.headers.get("x-forwarded-for")||"";
  return {ip_hash:ip?await tokenHash(ip+":"+(Deno.env.get("CONSENT_HASH_SALT")||"hero-event")):null,user_agent:clean(req.headers.get("user-agent"),500)||null};
}

async function sendEmail(to: string, subject: string, html: string, registrationId?: string, reservationId?: string) {
  let status = "failed";
  let providerId: string | null = null;
  let errorMessage: string | null = null;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "HERO Event <notification@mail.successconnection.co.th>",
        to: [to],
        subject,
        html
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.message || "Email delivery failed");
    status = "sent";
    providerId = result.id || null;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  await supabase.from("email_logs").insert({
    registration_id: registrationId || null,
    reservation_id: reservationId || null,
    recipient: to,
    email_type: subject.includes("Booking") ? "booking" : "registration",
    provider_message_id: providerId,
    status,
    error_message: errorMessage
  });
  return status === "sent";
}

async function releaseExpired(eventId: string) {
  const now = new Date().toISOString();
  const { data: held } = await supabase.from("reservations").select("id,booth_id")
    .eq("event_id", eventId).eq("status", "held").lt("hold_expires_at", now);
  for (const row of held || []) {
    await supabase.from("reservations").update({ status: "expired", updated_at: now }).eq("id", row.id);
    await supabase.from("booths").update({ status: "available", exhibitor_name: null, category: null, products: null, business_description: null, business_link: null, updated_at: now }).eq("id", row.booth_id).eq("status", "held");
  }
  const { data: overdue } = await supabase.from("reservations").select("id,booth_id")
    .eq("event_id", eventId).eq("status", "awaiting_payment").lt("payment_due_at", now);
  for (const row of overdue || []) {
    await supabase.from("reservations").update({ status: "expired", updated_at: now }).eq("id", row.id);
    await supabase.from("booths").update({ status: "available", exhibitor_name: null, category: null, products: null, business_description: null, business_link: null, updated_at: now }).eq("id", row.booth_id).eq("status", "awaiting_payment");
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: jsonHeaders(origin) });
  if (req.method !== "POST") return reply(origin, { error: "Method not allowed" }, 405);
  if (origin && !allowedOrigins.has(origin)) return reply(origin, { error: "Origin not allowed" }, 403);

  try {
    const body = await req.json();
    const action = clean(body.action, 40);
    const eventSlug = clean(body.event_slug,80)||"the-rice";
    const { data: event, error: eventError } = await supabase.from("events").select("id,name_th,name_en,total_spaces").eq("slug", eventSlug).eq("is_active", true).single();
    if (eventError || !event) return reply(origin, { error: "Event unavailable" }, 503);

    if (action === "quote") {
      if (eventSlug !== "the-rice") return reply(origin,{error:"Booth pricing is not configured for this event."},400);
      try { return reply(origin,{payment_quote:boothPricing.quoteBooth(clean(body.booth_code,10))}); }
      catch { return reply(origin,{error:"Invalid booth code."},400); }
    }

    if(action==="event_sales_inquiry"){
      const packages:Record<string,{name:string;amount:number;booths:number;coupons:number}>={
        starter:{name:"Starter",amount:9900,booths:100,coupons:100},
        growth:{name:"Growth",amount:19900,booths:200,coupons:200},
        pro:{name:"Pro",amount:49000,booths:500,coupons:500}
      };
      const packageCode=clean(body.package_code,20),selected=packages[packageCode];
      const eventName=clean(body.event_name,160),eventType=clean(body.event_type,100),venue=clean(body.venue,200),province=clean(body.province,100);
      const companyName=clean(body.company_name,160),contactName=clean(body.contact_name,120),mobile=clean(body.mobile,30),email=clean(body.email,200).toLowerCase(),lineId=clean(body.line_id,100),notes=clean(body.notes,1500);
      const preferredAction=clean(body.preferred_action,30),expectedBooths=Number(body.expected_booths),startDate=clean(body.start_date,10)||null,endDate=clean(body.end_date,10)||null;
      if(!selected)return reply(origin,{error:"กรุณาเลือกแพ็กเกจระบบ / Please select a system package.",field:"package_code"},400);if(eventName.length<2)return reply(origin,{error:"กรุณากรอกชื่องาน / Please enter the event name.",field:"event_name"},400);if(eventType.length<2)return reply(origin,{error:"กรุณาเลือกประเภทงาน / Please select the event type.",field:"event_type"},400);if(!province)return reply(origin,{error:"กรุณากรอกจังหวัด / Please enter the province.",field:"province"},400);if(contactName.length<2)return reply(origin,{error:"กรุณากรอกชื่อผู้ติดต่อ / Please enter the contact name.",field:"contact_name"},400);if(!mobileOk(mobile))return reply(origin,{error:"กรุณากรอกหมายเลขโทรศัพท์ให้ถูกต้อง / Please enter a valid mobile number.",field:"mobile"},400);if(!emailOk(email))return reply(origin,{error:"กรุณากรอกอีเมลให้ถูกต้อง / Please enter a valid email address.",field:"email"},400);if(!Number.isInteger(expectedBooths)||expectedBooths<1)return reply(origin,{error:"กรุณากรอกจำนวนบูธอย่างน้อย 1 บูธ / Please enter at least one expected booth.",field:"expected_booths"},400);if(!["contact_back","pay_now"].includes(preferredAction))return reply(origin,{error:"กรุณาเลือกขั้นตอนถัดไป / Please select the next step.",field:"preferred_action"},400);
      if(startDate&&endDate&&endDate<startDate)return reply(origin,{error:"The event end date cannot be before the start date."},400);
      const reference="HE-"+new Date().toISOString().slice(2,10).replaceAll("-","")+"-"+crypto.randomUUID().slice(0,6).toUpperCase();
      const {data:inquiry,error:inquiryError}=await supabase.from("hero_event_sales_inquiries").insert({
        inquiry_reference:reference,package_code:packageCode,package_name:selected.name,package_amount:selected.amount,booth_limit:selected.booths,visitor_coupon_count:selected.coupons,
        event_name:eventName,event_type:eventType,venue:venue||null,province,start_date:startDate,end_date:endDate,expected_booths:expectedBooths,
        company_name:companyName||null,contact_name:contactName,mobile,email,line_id:lineId||null,notes:notes||null,preferred_action:preferredAction
      }).select("id").single();
      if(inquiryError)throw inquiryError;
      const actionText=preferredAction==="pay_now"?"ขอชำระทันที / Pay Now":"ขอให้ติดต่อกลับ / Contact Back";
      const inclusions=`<ul><li>Managed event implementation</li><li>Event FastPage and Google Maps</li><li>Live booth/floor plan for up to ${selected.booths} booths</li><li>Registration, booking, payment-status and organizer dashboard</li><li>HERO FastPage for each exhibitor</li><li>200 HERO Credits per verified exhibitor</li><li>${selected.coupons} visitor coupons, value 200 Baht each</li></ul>`;
      await sendEmail(email,`HERO Event — Enquiry ${reference}`,`<div style="font-family:Arial,sans-serif;max-width:600px"><img src="https://hero-event.pages.dev/the-rice/hero-event-logo.jpg" width="230" alt="HERO Event"><h2>ได้รับข้อมูลการจัดงานแล้ว / Event Request Received</h2><p>เลขที่ / Reference: <b>${reference}</b></p><p>แพ็กเกจ / Package: <b>${selected.name} — ฿${selected.amount.toLocaleString()}</b></p><p>งาน / Event: <b>${escapeHtml(eventName)}</b></p><p>ตัวเลือก / Next step: <b>${actionText}</b></p>${inclusions}<p>HERO Event will contact you with the implementation or secure payment instruction.</p></div>`);
      await sendEmail("thomasheroetm@gmail.com",`New HERO Event Lead — ${reference}`,`<div style="font-family:Arial,sans-serif"><h2>New HERO Event enquiry</h2><p><b>${reference}</b> · ${selected.name} · ฿${selected.amount.toLocaleString()}</p><p>${escapeHtml(eventName)} · ${escapeHtml(province)} · ${expectedBooths} booths</p><p>${escapeHtml(contactName)} · ${escapeHtml(mobile)} · ${escapeHtml(email)}</p><p>${actionText}</p></div>`);
      return reply(origin,{success:true,inquiry_id:inquiry.id,reference,package:selected,payment_ready:false,next_step:preferredAction==="pay_now"?"HERO Event will send a secure payment link after confirming the event details.":"HERO Event will contact you."});
    }

    if(action==="admin_login"){
      const email=clean(body.email,200).toLowerCase(),password=clean(body.password,200);
      const publicKey=req.headers.get("apikey")||Deno.env.get("SUPABASE_ANON_KEY")||"";
      const authClient=createClient(Deno.env.get("SUPABASE_URL")!,publicKey);
      const {data,error}=await authClient.auth.signInWithPassword({email,password});
      if(error||!data.session)return reply(origin,{error:"Invalid email or password."},401);
      const {data:profile}=await supabase.from("event_admins").select("id,event_id,role,full_name,email,mobile,status").eq("auth_user_id",data.user.id).in("status",["active","invited"]).maybeSingle();
      if(!profile||(profile.role!=="hero_super_admin"&&profile.event_id!==event.id))return reply(origin,{error:"No active HERO Event administrator access."},403);
      if(profile.status==="invited"){
        await supabase.from("event_admins").update({status:"active",last_login_at:new Date().toISOString()}).eq("id",profile.id);
        profile.status="active";
      }
      return reply(origin,{access_token:data.session.access_token,refresh_token:data.session.refresh_token,expires_at:data.session.expires_at,profile});
    }

    if(action==="admin_bootstrap"){
      const {count}=await supabase.from("event_admins").select("id",{count:"exact",head:true}).eq("event_id",event.id);
      if((count||0)>0)return reply(origin,{error:"The first administrator account already exists."},409);
      const passcode=clean(body.passcode,200),hash=await tokenHash(passcode);
      const {data:legacy}=await supabase.from("hero_event_admin_access").select("id").eq("event_id",event.id).eq("password_hash",hash).eq("is_active",true).maybeSingle();
      if(!legacy)return reply(origin,{error:"Invalid setup passcode."},401);
      const fullName=clean(body.full_name,120),email=clean(body.email,200).toLowerCase(),mobile=clean(body.mobile,30),password=clean(body.password,200);
      if(fullName.length<2||!emailOk(email)||!mobileOk(mobile)||password.length<10)return reply(origin,{error:"Valid name, email, mobile and a password of at least 10 characters are required."},400);
      const {data:created,error:createError}=await supabase.auth.admin.createUser({email,password,email_confirm:true});
      if(createError||!created.user)return reply(origin,{error:createError?.message||"Unable to create administrator."},400);
      const {data:profile,error:profileError}=await supabase.from("event_admins").insert({auth_user_id:created.user.id,event_id:event.id,role:"hero_super_admin",full_name:fullName,email,mobile,status:"active"}).select("*").single();
      if(profileError){await supabase.auth.admin.deleteUser(created.user.id);throw profileError;}
      await supabase.from("hero_event_admin_access").update({is_active:false}).eq("id",legacy.id);
      await supabase.from("audit_logs").insert({event_id:event.id,actor_admin_id:profile.id,actor_label:fullName,action:"first_admin_created",entity_type:"event_admin",entity_id:profile.id});
      return reply(origin,{success:true});
    }

    if(action==="owner_otp_verify"){
      const email=clean(body.email,200).toLowerCase(),otp=clean(body.otp,6),password=clean(body.password,200);
      if(!emailOk(email)||!/^\d{6}$/.test(otp)||password.length<10)return reply(origin,{error:"Valid email, 6-digit OTP and a password of at least 10 characters are required."},400);
      const {data:reqRow}=await supabase.from("owner_onboarding_otps").select("*").eq("event_id",event.id).eq("email",email).eq("status","pending").order("created_at",{ascending:false}).limit(1).maybeSingle();
      if(!reqRow)return reply(origin,{error:"No active owner invitation was found for this email."},404);
      if(new Date(reqRow.expires_at)<=new Date()){
        await supabase.from("owner_onboarding_otps").update({status:"expired"}).eq("id",reqRow.id);
        return reply(origin,{error:"This OTP has expired. Ask HERO Event to send a new code."},410);
      }
      if(reqRow.failed_attempts>=reqRow.max_attempts)return reply(origin,{error:"Maximum OTP attempts reached. Ask HERO Event to send a new code."},429);
      const expected=await tokenHash(`${event.id}:${email}:${otp}`);
      if(expected!==reqRow.otp_hash){
        const attempts=reqRow.failed_attempts+1;
        await supabase.from("owner_onboarding_otps").update({failed_attempts:attempts,status:attempts>=5?"cancelled":"pending"}).eq("id",reqRow.id);
        return reply(origin,{error:attempts>=5?"Maximum OTP attempts reached. Ask HERO Event to send a new code.":`Incorrect OTP. ${5-attempts} attempts remaining.`},401);
      }
      const {count:owners}=await supabase.from("event_admins").select("id",{count:"exact",head:true}).eq("event_id",event.id).eq("role","organizer_owner").in("status",["active","invited"]);
      if((owners||0)>0)return reply(origin,{error:"This event already has an Organizer Owner."},409);
      const {data:existingAdmin}=await supabase.from("event_admins").select("role,status").eq("email",email).maybeSingle();
      if(existingAdmin?.role==="hero_super_admin")return reply(origin,{error:"อีเมลนี้เป็นบัญชี HERO Event Super Admin อยู่แล้ว กรุณากด Organizer Sign In และใช้รหัสผ่านเดิม ไม่ต้องใช้ OTP / This email is already the HERO Event Super Admin. Use Organizer Sign In with your existing password; OTP activation is not required."},409);
      if(existingAdmin)return reply(origin,{error:"อีเมลนี้มีบัญชีผู้ดูแลงานอยู่แล้ว กรุณาเข้าสู่ระบบด้วยรหัสผ่านเดิม / This email already has an event administrator account. Please sign in with the existing password."},409);
      const {data:created,error:createError}=await supabase.auth.admin.createUser({email,password,email_confirm:true});
      if(createError||!created.user)return reply(origin,{error:createError?.message||"Unable to create owner account."},400);
      const {data:profile,error:profileError}=await supabase.from("event_admins").insert({auth_user_id:created.user.id,event_id:event.id,role:"organizer_owner",full_name:reqRow.full_name,email,mobile:reqRow.mobile,status:"active",invited_by:reqRow.issued_by_admin_id}).select("*").single();
      if(profileError){await supabase.auth.admin.deleteUser(created.user.id);throw profileError;}
      await supabase.from("owner_onboarding_otps").update({status:"verified",verified_at:new Date().toISOString(),otp_hash:await tokenHash(crypto.randomUUID())}).eq("id",reqRow.id);
      await supabase.from("audit_logs").insert({event_id:event.id,actor_admin_id:profile.id,actor_label:reqRow.full_name,action:"organizer_owner_activated",entity_type:"event_admin",entity_id:profile.id,evidence:{invitation_id:reqRow.id}});
      return reply(origin,{success:true,message:"Organizer Owner account created."});
    }

    if(action==="invite_get"){
      const hash=await tokenHash(clean(body.token,200));
      const {data:invite}=await supabase.from("exhibitor_invites").select("id,email,prefill,status,expires_at").eq("event_id",event.id).eq("token_hash",hash).in("status",["sent","opened"]).maybeSingle();
      if(!invite||new Date(invite.expires_at)<=new Date())return reply(origin,{error:"Invitation is invalid or expired."},410);
      if(invite.status==="sent")await supabase.from("exhibitor_invites").update({status:"opened"}).eq("id",invite.id);
      return reply(origin,{invite:{email:invite.email,prefill:invite.prefill}});
    }

    if (action === "shop") {
      const boothCode = clean(body.booth_code, 10).toUpperCase();
      const { data: booth } = await supabase.from("booths")
        .select("code,sector_code,sector_name,status,exhibitor_name,category,products,business_description,business_link,logo_path,shop_slug")
        .eq("event_id", event.id).eq("code", boothCode).maybeSingle();
      if (!booth || booth.status === "available" || booth.status === "held") return reply(origin, { error: "Shop page unavailable." }, 404);
      const logo_url = booth.logo_path ? `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/hero-event-shop-assets/${booth.logo_path}` : null;
      return reply(origin, { shop: { ...booth, logo_url } });
    }

    if(["admin_list","admin_review","admin_logo","admin_users","admin_invite","admin_settings","admin_audit","admin_exception","admin_invite_exhibitor","admin_floor_plan","super_admin_events","super_admin_send_owner_otp"].includes(action)){
      const access=await getAdmin(req,event.id);
      if(!access)return reply(origin,{error:"Administrator sign-in required."},401);

      if(action==="super_admin_events"){
        if(access.role!=="hero_super_admin")return reply(origin,{error:"HERO Super Admin authority required."},403);
        const {data:events}=await supabase.from("events").select("id,slug,name_th,name_en,is_active,total_spaces").order("created_at",{ascending:false});
        return reply(origin,{events:events||[]});
      }
      if(action==="super_admin_send_owner_otp"){
        if(access.role!=="hero_super_admin")return reply(origin,{error:"HERO Super Admin authority required."},403);
        const targetEventId=clean(body.event_id,80),fullName=clean(body.full_name,120),email=clean(body.email,200).toLowerCase(),mobile=clean(body.mobile,30);
        if(!targetEventId||fullName.length<2||!emailOk(email)||!mobileOk(mobile))return reply(origin,{error:"Valid event, owner name, email and mobile are required."},400);
        const {data:targetEvent}=await supabase.from("events").select("id,slug,name_th,name_en").eq("id",targetEventId).eq("is_active",true).maybeSingle();
        if(!targetEvent)return reply(origin,{error:"Active event not found."},404);
        const {count:owners}=await supabase.from("event_admins").select("id",{count:"exact",head:true}).eq("event_id",targetEventId).eq("role","organizer_owner").in("status",["active","invited"]);
        if((owners||0)>0)return reply(origin,{error:"This event already has an Organizer Owner."},409);
        const {data:recent}=await supabase.from("owner_onboarding_otps").select("created_at").eq("event_id",targetEventId).eq("email",email).eq("status","pending").order("created_at",{ascending:false}).limit(1).maybeSingle();
        if(recent&&Date.now()-new Date(recent.created_at).getTime()<60000)return reply(origin,{error:"Please wait 60 seconds before resending an OTP."},429);
        await supabase.from("owner_onboarding_otps").update({status:"cancelled"}).eq("event_id",targetEventId).eq("email",email).eq("status","pending");
        const otp=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");
        const expiresAt=new Date(Date.now()+15*60*1000).toISOString();
        const {data:otpRow,error:otpError}=await supabase.from("owner_onboarding_otps").insert({event_id:targetEventId,full_name:fullName,email,mobile,otp_hash:await tokenHash(`${targetEventId}:${email}:${otp}`),expires_at:expiresAt,issued_by_admin_id:access.id}).select("id").single();
        if(otpError)throw otpError;
        const eventName=targetEvent.name_en||targetEvent.name_th||"HERO Event";
        const sent=await sendEmail(email,"HERO Event Owner Verification Code",`<div style="font-family:Arial,sans-serif;max-width:560px"><img src="https://hero-event.pages.dev/the-rice/hero-event-logo.jpg" width="230" alt="HERO Event" style="display:block;max-width:70%;height:auto;margin:0 0 22px"><div style="font-size:24px;font-weight:800;margin:0 0 18px"><span style="color:#e93091">HERO</span> <span style="color:#25a9ef">Event</span></div><p>Hello ${fullName},</p><p>You have been appointed as the Organizer Owner for <b>${eventName}</b>.</p><p>Your verification code is:</p><div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#2467dd">${otp}</div><p>This code expires in 15 minutes and can be used once.</p><p>Open: <a href="https://hero-event.pages.dev/the-rice/admin?owner=activate&event=${encodeURIComponent(targetEvent.slug)}">Create Owner Account</a></p><hr><p>คุณได้รับแต่งตั้งเป็นเจ้าของระบบจัดงาน รหัสยืนยันมีอายุ 15 นาทีและใช้ได้ครั้งเดียว</p></div>`);
        await supabase.from("owner_onboarding_otps").update({status:sent?"pending":"delivery_failed",sent_at:sent?new Date().toISOString():null}).eq("id",otpRow.id);
        await supabase.from("audit_logs").insert({event_id:targetEventId,actor_admin_id:access.id,actor_label:access.full_name,action:sent?"owner_otp_sent":"owner_otp_delivery_failed",entity_type:"owner_onboarding_otp",entity_id:otpRow.id,evidence:{email,mobile,expires_at:expiresAt}});
        if(!sent)return reply(origin,{error:"The invitation was recorded, but the email could not be delivered."},502);
        return reply(origin,{success:true,masked_email:email.replace(/^(.{2}).*(@.*)$/,"$1***$2"),expires_at:expiresAt});
      }

      if(action==="admin_users"){
        if(!["hero_super_admin","organizer_owner"].includes(access.role))return reply(origin,{error:"Owner authority required."},403);
        const {data:admins}=await supabase.from("event_admins").select("id,role,full_name,email,mobile,status,created_at,last_login_at").eq("event_id",event.id).order("created_at");
        return reply(origin,{admins:admins||[]});
      }
      if(action==="admin_invite"){
        if(!["hero_super_admin","organizer_owner"].includes(access.role))return reply(origin,{error:"Owner authority required."},403);
        const email=clean(body.email,200).toLowerCase(),fullName=clean(body.full_name,120),mobile=clean(body.mobile,30),role=clean(body.role,30);
        if(!emailOk(email)||fullName.length<2||!mobileOk(mobile)||!["organizer_owner","event_admin","payment_admin","viewer"].includes(role))return reply(origin,{error:"Valid administrator details and role are required."},400);
        const {data:invited,error}=await supabase.auth.admin.inviteUserByEmail(email,{redirectTo:"https://hero-event.pages.dev/admin/"});
        if(error||!invited.user)return reply(origin,{error:error?.message||"Unable to invite administrator."},400);
        const {data:profile,error:insertError}=await supabase.from("event_admins").upsert({auth_user_id:invited.user.id,event_id:event.id,role,full_name:fullName,email,mobile,status:"invited",invited_by:access.id},{onConflict:"auth_user_id"}).select().single();
        if(insertError)throw insertError;
        await supabase.from("audit_logs").insert({event_id:event.id,actor_admin_id:access.id,actor_label:access.full_name,action:"admin_invited",entity_type:"event_admin",entity_id:profile.id,metadata:{email,role,mobile}});
        return reply(origin,{admin:profile});
      }
      if(action==="admin_settings"){
        if(body.mode==="get"){const {data:settings}=await supabase.from("event_settings").select("*").eq("event_id",event.id).single();return reply(origin,{settings});}
        if(!["hero_super_admin","organizer_owner","event_admin"].includes(access.role))return reply(origin,{error:"Event Admin authority required."},403);
        const patch:any={updated_at:new Date().toISOString()};
        if(body.hold_minutes!==undefined)patch.hold_minutes=Math.max(1,Math.min(120,Number(body.hold_minutes)||15));
        if(body.payment_hours!==undefined)patch.payment_hours=Math.max(1,Math.min(720,Number(body.payment_hours)||48));
        if(["organizer_bank","hero_pay"].includes(body.payment_mode))patch.payment_mode=body.payment_mode;
        const {data:settings,error}=await supabase.from("event_settings").update(patch).eq("event_id",event.id).select().single();if(error)throw error;
        await supabase.from("audit_logs").insert({event_id:event.id,actor_admin_id:access.id,actor_label:access.full_name,action:"event_settings_updated",entity_type:"event",entity_id:event.id,metadata:patch});
        return reply(origin,{settings});
      }
      if(action==="admin_audit"){const {data:logs}=await supabase.from("audit_logs").select("*").eq("event_id",event.id).order("created_at",{ascending:false}).limit(200);return reply(origin,{logs:logs||[]});}
      if(action==="admin_exception"){
        if(!["hero_super_admin","organizer_owner","event_admin","payment_admin"].includes(access.role))return reply(origin,{error:"Payment authority required."},403);
        if(body.mode==="resolve"){const {data:item,error}=await supabase.from("payment_exception_cases").update({status:"resolved",resolution_note:clean(body.resolution_note,1000)||null,resolved_by_admin_id:access.id,resolved_at:new Date().toISOString()}).eq("id",clean(body.id,80)).eq("event_id",event.id).select().single();if(error)throw error;return reply(origin,{item});}
        const type=clean(body.exception_type,40);
        if(!["duplicate","underpayment","overpayment","wrong_booking","late_payment","unreadable_slip","other"].includes(type))return reply(origin,{error:"Invalid exception type."},400);
        const {data:item,error}=await supabase.from("payment_exception_cases").insert({event_id:event.id,payment_id:body.payment_id||null,reservation_id:body.reservation_id||null,exception_type:type,expected_amount:body.expected_amount||null,received_amount:body.received_amount||null,resolution_note:clean(body.resolution_note,1000)||null,created_by_admin_id:access.id}).select().single();if(error)throw error;
        return reply(origin,{item});
      }
      if(action==="admin_invite_exhibitor"){
        if(!["hero_super_admin","organizer_owner","event_admin"].includes(access.role))return reply(origin,{error:"Event Admin authority required."},403);
        const email=clean(body.email,200).toLowerCase();if(!emailOk(email))return reply(origin,{error:"Valid exhibitor email required."},400);
        const token=crypto.randomUUID()+crypto.randomUUID();
        const prefill={full_name:clean(body.full_name,120),mobile:clean(body.mobile,30),business_name:clean(body.business_name,160),category:clean(body.category,160),products:clean(body.products,1500),business_description:clean(body.business_description,2500),business_link:clean(body.business_link,500),desired_booth:clean(body.booth_code,10).toUpperCase()};
        const {data:invite,error}=await supabase.from("exhibitor_invites").insert({event_id:event.id,email,token_hash:await tokenHash(token),prefill,created_by_admin_id:access.id}).select("id,expires_at").single();if(error)throw error;
        const link=`https://hero-event.pages.dev/the-rice/?invite=${encodeURIComponent(token)}`;
        const sent=await sendEmail(email,"The Rice Event — Exhibitor Invitation",`<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto"><h2>คำเชิญผู้แสดงสินค้า / Exhibitor Invitation</h2><p>กรุณาตรวจสอบข้อมูลที่กรอกไว้ ยอมรับเงื่อนไขทั้งสองข้อ แล้วจึงดำเนินการจอง / Please review the prefilled information, accept both consent conditions, and complete the booking.</p><p><a href="${link}">เปิดแบบลงทะเบียน / Open registration</a></p>${exhibitorTerms}</div>`);
        await supabase.from("audit_logs").insert({event_id:event.id,actor_admin_id:access.id,actor_label:access.full_name,action:"exhibitor_invited",entity_type:"exhibitor_invite",entity_id:invite.id,metadata:{email,desired_booth:prefill.desired_booth,email_sent:sent}});
        return reply(origin,{link,email_sent:sent,expires_at:invite.expires_at});
      }
      if(action==="admin_floor_plan"){
        if(!["hero_super_admin","organizer_owner","event_admin"].includes(access.role))return reply(origin,{error:"Event Admin authority required."},403);
        if(body.mode==="list"){const {data:versions}=await supabase.from("floor_plan_versions").select("*").eq("event_id",event.id).order("version_number",{ascending:false});return reply(origin,{versions:versions||[]});}
        const {data:last}=await supabase.from("floor_plan_versions").select("version_number").eq("event_id",event.id).order("version_number",{ascending:false}).limit(1).maybeSingle();
        const status=body.publish===true?"published":"draft";if(status==="published")await supabase.from("floor_plan_versions").update({status:"archived"}).eq("event_id",event.id).eq("status","published");
        const {data:version,error}=await supabase.from("floor_plan_versions").insert({event_id:event.id,version_number:(last?.version_number||0)+1,status,layout:body.layout||{},change_note:clean(body.change_note,500)||null,created_by_admin_id:access.id,published_by_admin_id:status==="published"?access.id:null,published_at:status==="published"?new Date().toISOString():null}).select().single();if(error)throw error;
        await supabase.from("audit_logs").insert({event_id:event.id,actor_admin_id:access.id,actor_label:access.full_name,action:status==="published"?"floor_plan_published":"floor_plan_draft_created",entity_type:"floor_plan",entity_id:version.id,metadata:{version_number:version.version_number}});
        return reply(origin,{version});
      }

      if (action === "admin_list") {
        const { data: rows, error } = await supabase.from("payments")
          .select("id,status,method,amount,slip_path,submitted_at,reviewed_at,review_note,reservations!inner(id,status,booking_reference,payment_due_at,amount_due_minor,pricing_snapshot,registration_id,booth_id,event_id,registrations(full_name,email,mobile,business_name,category,products,business_description,logo_path,shop_slug),booths(code,sector_code,sector_name,status,logo_path,shop_slug))")
          .eq("reservations.event_id",event.id).order("submitted_at",{ascending:false});
        if (error) throw error;
        const payments = [];
        for (const row of rows || []) {
          const signed = row.slip_path ? await supabase.storage.from("hero-event-payment-slips").createSignedUrl(row.slip_path,600) : {data:null};
          const booking = Array.isArray(row.reservations) ? row.reservations[0] : row.reservations;
          const amountMinor = Number(booking?.amount_due_minor);
          const expectedAmount = booking?.amount_due_minor != null && Number.isSafeInteger(amountMinor) && amountMinor > 0 ? boothPricing.formatAmount(amountMinor) : null;
          payments.push({...row,expected_amount:expectedAmount,slip_url:signed.data?.signedUrl || null});
        }
        const [{data: boothRows},{count: exhibitors},{count: visitors}] = await Promise.all([
          supabase.from("booths").select("status").eq("event_id",event.id),
          supabase.from("registrations").select("id",{count:"exact",head:true}).eq("event_id",event.id).eq("role","exhibitor"),
          supabase.from("registrations").select("id",{count:"exact",head:true}).eq("event_id",event.id).eq("role","visitor")
        ]);
        const stats={total:boothRows?.length||0,available:0,held:0,awaiting_payment:0,paid:0,pending_slips:payments.filter((x:any)=>x.status==="submitted").length,exhibitors:exhibitors||0,visitors:visitors||0};
        for(const b of boothRows||[]) (stats as any)[b.status]=((stats as any)[b.status]||0)+1;
        return reply(origin,{payments,stats});
      }

      if (action === "admin_logo") {
        if(!["hero_super_admin","organizer_owner","event_admin"].includes(access.role))return reply(origin,{error:"Event management authority required."},403);
        const boothCode=clean(body.booth_code,10).toUpperCase();
        const mime=clean(body.mime_type,80);
        const base64=clean(body.file_base64,4000000);
        if (!["image/jpeg","image/png","image/webp"].includes(mime)||!base64) return reply(origin,{error:"Invalid shop logo."},400);
        const bytes=Uint8Array.from(atob(base64),x=>x.charCodeAt(0));
        if(bytes.byteLength>2097152) return reply(origin,{error:"Logo must be 2 MB or smaller."},413);
        const ext=mime==="image/png"?"png":mime==="image/webp"?"webp":"jpg";
        const path=`${event.id}/${boothCode.toLowerCase()}-${crypto.randomUUID()}.${ext}`;
        const uploaded=await supabase.storage.from("hero-event-shop-assets").upload(path,bytes,{contentType:mime,upsert:false});
        if(uploaded.error) throw uploaded.error;
        const {data: booth}=await supabase.from("booths").select("id,exhibitor_name").eq("event_id",event.id).eq("code",boothCode).maybeSingle();
        if(!booth) return reply(origin,{error:"Booth not found."},404);
        await supabase.from("booths").update({logo_path:path,shop_slug:slugify(booth.exhibitor_name||boothCode),updated_at:new Date().toISOString()}).eq("id",booth.id);
        const {data: reservation}=await supabase.from("reservations").select("registration_id").eq("booth_id",booth.id).in("status",["awaiting_payment","payment_submitted","paid"]).order("created_at",{ascending:false}).limit(1).maybeSingle();
        if(reservation) await supabase.from("registrations").update({logo_path:path,shop_slug:slugify(booth.exhibitor_name||boothCode)}).eq("id",reservation.registration_id);
        return reply(origin,{success:true,logo_url:`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/hero-event-shop-assets/${path}`});
      }

      if(!["hero_super_admin","organizer_owner","event_admin","payment_admin"].includes(access.role))return reply(origin,{error:"Payment authority required."},403);
      const paymentId=clean(body.payment_id,80);
      const decision=clean(body.decision,20);
      const note=clean(body.note,500)||null;
      if(!["approve","reject"].includes(decision)) return reply(origin,{error:"Invalid review decision."},400);
      const {data: payment}=await supabase.from("payments")
        .select("id,status,reservation_id,reservations(id,status,booking_reference,amount_due_minor,pricing_snapshot,registration_id,booth_id,registrations(full_name,email,business_name),booths(code))")
        .eq("id",paymentId).maybeSingle();
      if(!payment||payment.status!=="submitted") return reply(origin,{error:"Payment is no longer awaiting review."},409);
      const reservation=Array.isArray(payment.reservations)?payment.reservations[0]:payment.reservations;
      if(!reservation) return reply(origin,{error:"Booking not found."},404);
      const reg=Array.isArray(reservation.registrations)?reservation.registrations[0]:reservation.registrations;
      const booth=Array.isArray(reservation.booths)?reservation.booths[0]:reservation.booths;
      const paymentQuote=reservation.pricing_snapshot?bookingQuote(reservation,booth.code,eventSlug):null;
      const now=new Date().toISOString();
      if(decision==="approve"){
        await supabase.from("payments").update({status:"approved",reviewed_at:now,reviewed_by:access.full_name,review_note:note}).eq("id",payment.id);
        await supabase.from("audit_logs").insert({event_id:event.id,actor_admin_id:access.id,actor_label:access.full_name,action:"payment_approved",entity_type:"payment",entity_id:payment.id,old_status:"submitted",new_status:"approved",reason:note,metadata:{booking_reference:reservation.booking_reference,booth_code:booth.code}});
        await supabase.from("reservations").update({status:"paid",updated_at:now}).eq("id",reservation.id);
        await supabase.from("booths").update({status:"paid",updated_at:now}).eq("id",reservation.booth_id);
        const award=await supabase.from("hero_credit_awards").insert({registration_id:reservation.registration_id,normalized_email:String(reg.email).toLowerCase(),amount:200,reason:"hero_event_verified_exhibitor"});
        const creditsAwarded=!award.error;
        const shopUrl=`https://hero-event.pages.dev/the-rice/shop/?booth=${encodeURIComponent(booth.code)}`;
        const sent=await sendEmail(reg.email,"The Rice Event — Payment Confirmed & Booth Secured",`<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto"><img src="https://hero-event.pages.dev/the-rice/hero-event-logo.jpg" width="230" alt="HERO Event" style="display:block;max-width:70%;height:auto;margin:0 0 22px"><h3>ยืนยันการชำระเงินและพื้นที่แล้ว / Payment Confirmed — Booth Secured</h3><p>พื้นที่ / Space: <strong>${escapeHtml(booth.code)}</strong></p><p>เลขที่การจอง / Reference: <strong>${escapeHtml(reservation.booking_reference)}</strong></p>${quoteEmail(paymentQuote)}<p>บัญชีนี้ได้รับ HERO Credits จากงานนี้แล้ว ${creditsAwarded?"200 เครดิต":"(ได้รับเครดิตก่อนหน้านี้แล้ว)"} / This account receives HERO Credits once per event participant.</p><p><a href="${shopUrl}">ดูหน้าร้าน / View Shop Page</a></p>${exhibitorTerms}</div>`,reservation.registration_id,reservation.id);
        return reply(origin,{success:true,status:"paid",credits_awarded:creditsAwarded,email_sent:sent,shop_url:shopUrl});
      }
      if(!note)return reply(origin,{error:"A rejection reason is required for the audit history."},400);
      await supabase.from("payments").update({status:"rejected",reviewed_at:now,reviewed_by:access.full_name,review_note:note}).eq("id",payment.id);
      await supabase.from("audit_logs").insert({event_id:event.id,actor_admin_id:access.id,actor_label:access.full_name,action:"payment_rejected",entity_type:"payment",entity_id:payment.id,old_status:"submitted",new_status:"rejected",reason:note,metadata:{booking_reference:reservation.booking_reference,booth_code:booth.code}});
      await supabase.from("reservations").update({status:"awaiting_payment",updated_at:now}).eq("id",reservation.id);
      await supabase.from("booths").update({status:"awaiting_payment",updated_at:now}).eq("id",reservation.booth_id);
      const sent=await sendEmail(reg.email,"The Rice Event — Payment Slip Needs Correction",`<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto"><img src="https://hero-event.pages.dev/the-rice/hero-event-logo.jpg" width="230" alt="HERO Event"><h3>กรุณาส่งหลักฐานใหม่ / Please Submit a New Payment Slip</h3><p>พื้นที่ / Space: <strong>${escapeHtml(booth.code)}</strong></p><p>${escapeHtml(note||"Please check the payment details and upload a new slip.")}</p><p><a href="https://hero-event.pages.dev/the-rice/">Open booking page</a></p>${exhibitorTerms}</div>`,reservation.registration_id,reservation.id);
      return reply(origin,{success:true,status:"awaiting_payment",email_sent:sent});
    }

    if (action === "state") {
      await releaseExpired(event.id);
      const [{ data: booths }, { count: visitors }] = await Promise.all([
        supabase.from("booths").select("code,sector_code,sector_name,status,exhibitor_name,category,products,business_description,business_link,logo_path,shop_slug").eq("event_id", event.id).order("code"),
        supabase.from("registrations").select("id", { count: "exact", head: true }).eq("event_id", event.id).eq("role", "visitor")
      ]);
      return reply(origin, { booths: booths || [], visitor_count: visitors || 0 });
    }

    if (action === "register") {
      const role = clean(body.role, 20);
      const fullName = clean(body.full_name, 120);
      const mobile = clean(body.mobile, 30);
      const email = clean(body.email, 200).toLowerCase();
      if (!["visitor","exhibitor"].includes(role) || fullName.length < 2 || !mobileOk(mobile) || !emailOk(email)) {
        return reply(origin, { error: "Please complete a valid name, mobile number and email." }, 400);
      }
      const record: Record<string, unknown> = {
        event_id: event.id, role, full_name: fullName, mobile, email,
        osk_batch: clean(body.osk_batch, 20) || null
      };
      if (role === "exhibitor") {
        if (body.publish_consent !== true || body.no_refund_ack !== true) return reply(origin,{error:"Both exhibitor consent checkboxes are required."},400);
        record.publish_consent_at = new Date().toISOString();
        record.no_refund_ack_at = new Date().toISOString();
        record.business_name = clean(body.business_name, 160);
        record.category = clean(body.category, 160);
        record.products = clean(body.products, 1500);
        record.business_description = clean(body.business_description, 2500);
        record.presence_type = clean(body.presence_type, 20);
        record.business_link = clean(body.business_link, 500) || null;
        if (!record.business_name || !record.category || !record.products || !record.business_description || !["profile","link","fastpage"].includes(String(record.presence_type))) {
          return reply(origin, { error: "Please complete all required exhibitor information." }, 400);
        }
        if (record.business_link) {
          try { const u = new URL(String(record.business_link)); if (!["http:","https:"].includes(u.protocol)) throw new Error(); }
          catch { return reply(origin, { error: "Please enter a valid business link." }, 400); }
        }
      }
      if (role === "exhibitor") record.shop_slug = slugify(String(record.business_name));
      const { data: registration, error } = await supabase.from("registrations").insert(record).select("id").single();
      if (error) throw error;
      if(role==="exhibitor"){
        const ev=await evidence(req);
        await supabase.from("consent_evidence").insert([
          {event_id:event.id,registration_id:registration.id,consent_type:"privacy_publication",...ev,evidence:{source:"registration_form"}},
          {event_id:event.id,registration_id:registration.id,consent_type:"booking_no_refund",...ev,evidence:{source:"registration_form"}}
        ]);
        const inviteToken=clean(body.invite_token,200);
        if(inviteToken)await supabase.from("exhibitor_invites").update({status:"completed",completed_at:new Date().toISOString()}).eq("event_id",event.id).eq("token_hash",await tokenHash(inviteToken)).in("status",["sent","opened"]);
      }
      if (role === "exhibitor" && body.logo_base64) {
        const logoMime=clean(body.logo_mime,80);
        const logoBase64=clean(body.logo_base64,4000000);
        if (!["image/jpeg","image/png","image/webp"].includes(logoMime)) return reply(origin,{error:"Shop logo must be JPG, PNG or WebP."},400);
        const logoBytes=Uint8Array.from(atob(logoBase64),x=>x.charCodeAt(0));
        if(logoBytes.byteLength>2097152) return reply(origin,{error:"Shop logo must be 2 MB or smaller."},413);
        const ext=logoMime==="image/png"?"png":logoMime==="image/webp"?"webp":"jpg";
        const logoPath=`${event.id}/registration-${registration.id}-${crypto.randomUUID()}.${ext}`;
        const logoUpload=await supabase.storage.from("hero-event-shop-assets").upload(logoPath,logoBytes,{contentType:logoMime,upsert:false});
        if(logoUpload.error) throw logoUpload.error;
        await supabase.from("registrations").update({logo_path:logoPath}).eq("id",registration.id);
      }
      const safeName = escapeHtml(fullName);
      const subject = role === "visitor" ? "The Rice Event — Registration Confirmed" : "The Rice Event — Exhibitor Registration Received";
      const benefit = role === "visitor" ? "<p><strong>สิทธิพิเศษ:</strong> รับ 200 HERO Credits สำหรับใช้ซื้อประกัน พ.ร.บ. กับ HERO Insure</p><p><strong>Benefit:</strong> 200 HERO Credits toward PRB Insurance.</p>" : "<p>You may now return to the floor plan and select an available booth.</p>";
      const sent = await sendEmail(email, subject, `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto"><img src="https://hero-event.pages.dev/the-rice/hero-event-logo.jpg" width="230" alt="HERO Event" style="display:block;max-width:70%;height:auto;margin:0 0 22px"><h3>The Rice Event</h3><p>สวัสดี / Hello ${safeName},</p><p>ลงทะเบียนเรียบร้อยแล้ว / Your registration is confirmed.</p>${benefit}<p><a href="https://hero-event.pages.dev/the-rice/">Open The Rice Event</a></p>${role === "exhibitor" ? exhibitorTerms : ""}</div>`, registration.id);
      return reply(origin, { registration_id: registration.id, email_sent: sent });
    }

    if (action === "hold") {
      const registrationId=clean(body.registration_id,80),boothCode=clean(body.booth_code,10).toUpperCase();
      const {data:registration}=await supabase.from("registrations").select("*").eq("id",registrationId).eq("event_id",event.id).eq("role","exhibitor").single();
      if(!registration)return reply(origin,{error:"Exhibitor registration not found."},404);
      await releaseExpired(event.id);
      const token=crypto.randomUUID()+crypto.randomUUID(),ref=`RICE-${boothCode}-${Date.now().toString().slice(-6)}`;
      const {data:settings}=await supabase.from("event_settings").select("hold_minutes").eq("event_id",event.id).maybeSingle();
      const {data:claimed,error}=await supabase.rpc("claim_booth_fifo",{p_event_id:event.id,p_registration_id:registration.id,p_booth_code:boothCode,p_booking_reference:ref,p_access_token_hash:await tokenHash(token),p_hold_minutes:settings?.hold_minutes||15,p_request_source:"public",p_created_by_admin_id:null});
      if(error){if(String(error.message).includes("BOOTH_UNAVAILABLE"))return reply(origin,{error:"This booth is no longer available. The first completed request receives it (FIFO)."},409);throw error;}
      const row=claimed?.[0];if(!row)return reply(origin,{error:"This booth is no longer available."},409);
      const paymentQuote = bookingQuote(null,boothCode,eventSlug);
      return reply(origin,{reservation_id:row.reservation_id,token,booking_reference:ref,hold_expires_at:row.hold_expires_at,fifo_sequence:row.fifo_sequence,fifo:true,payment_quote:paymentQuote});
    }

    if (action === "confirm") {
      if (body.no_refund_ack !== true) return reply(origin,{error:"Please acknowledge the no-cancellation and no-refund condition."},400);
      const reservationId = clean(body.reservation_id, 80);
      const token = clean(body.token, 200);
      const hash = await tokenHash(token);
      const { data: reservation } = await supabase.from("reservations").select("*,registrations(email,full_name),booths(code)").eq("id", reservationId).eq("event_id",event.id).eq("access_token_hash", hash).single();
      if (!reservation || reservation.status !== "held") return reply(origin, { error: "Reservation is unavailable." }, 409);
      if (new Date(reservation.hold_expires_at) <= new Date()) {
        await releaseExpired(event.id);
        return reply(origin, { error: "The 15-minute reservation has expired." }, 410);
      }
      const {data:eventSettings}=await supabase.from("event_settings").select("payment_hours").eq("event_id",event.id).maybeSingle();
      const due=new Date(Date.now()+(eventSettings?.payment_hours||48)*60*60*1000);
      const booth = Array.isArray(reservation.booths) ? reservation.booths[0] : reservation.booths;
      const paymentQuote = bookingQuote(reservation,booth.code,eventSlug);
      const pricingFields = paymentQuote ? {amount_due_minor:paymentQuote.amount_minor,pricing_snapshot:paymentQuote} : {};
      const { error } = await supabase.from("reservations").update({ status: "awaiting_payment", payment_due_at: due.toISOString(), no_refund_ack_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...pricingFields }).eq("id", reservation.id).eq("status", "held");
      if (error) throw error;
      const bookingEvidence=await evidence(req);
      await supabase.from("consent_evidence").insert({event_id:event.id,registration_id:reservation.registration_id,reservation_id:reservation.id,consent_type:"booking_no_refund",...bookingEvidence,evidence:{source:"booking_confirmation"}});
      await supabase.from("booths").update({ status: "awaiting_payment", updated_at: new Date().toISOString() }).eq("id", reservation.booth_id);
      const reg = Array.isArray(reservation.registrations) ? reservation.registrations[0] : reservation.registrations;
      const sent = await sendEmail(reg.email, "The Rice Event — Booking Confirmed", `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto"><img src="https://hero-event.pages.dev/the-rice/hero-event-logo.jpg" width="230" alt="HERO Event" style="display:block;max-width:70%;height:auto;margin:0 0 22px"><h3>ยืนยันการจองแล้ว / Booking Confirmed</h3><p>พื้นที่ / Space: <strong>${escapeHtml(booth.code)}</strong></p><p>เลขที่การจอง / Reference: <strong>${escapeHtml(reservation.booking_reference)}</strong></p>${quoteEmail(paymentQuote)}<p>กรุณาชำระเงินภายใน 48 ชั่วโมง / Please complete payment within 48 hours.</p><p style="color:#a61d2d"><strong>เมื่อชำระเงินแล้ว ไม่สามารถยกเลิกและไม่คืนเงินทุกกรณี / Once paid, the booking is non-cancellable and non-refundable under all circumstances.</strong></p><p>กำหนดชำระ / Due: ${due.toLocaleString("en-GB", {timeZone:"Asia/Bangkok"})}</p><p><a href="https://hero-event.pages.dev/the-rice/">Open booking page</a></p>${exhibitorTerms}</div>`, reservation.registration_id, reservation.id);
      return reply(origin, { booking_reference: reservation.booking_reference, payment_due_at: due.toISOString(), email_sent: sent, payment_quote: paymentQuote });
    }

    if (action === "payment") {
      if (body.no_refund_ack !== true) return reply(origin,{error:"Please acknowledge the no-cancellation and no-refund condition."},400);
      const reservationId = clean(body.reservation_id, 80);
      const token = clean(body.token, 200);
      const method = clean(body.method, 20);
      const fileName = clean(body.file_name, 160).replace(/[^a-zA-Z0-9._-]/g, "_");
      const mime = clean(body.mime_type, 80);
      const base64 = clean(body.file_base64, 8000000);
      if (!["bank","promptpay"].includes(method) || !fileName || !["image/jpeg","image/png","image/webp","application/pdf"].includes(mime) || !base64) {
        return reply(origin, { error: "Invalid payment submission." }, 400);
      }
      const hash = await tokenHash(token);
      const { data: reservation } = await supabase.from("reservations").select("id,status,registration_id,booking_reference,booth_id,amount_due_minor,pricing_snapshot,registrations(email),booths(code)").eq("id", reservationId).eq("event_id",event.id).eq("access_token_hash", hash).single();
      if (!reservation || reservation.status !== "awaiting_payment") return reply(origin, { error: "Booking is not awaiting payment." }, 409);
      const paymentQuote = bookingQuote(reservation,(Array.isArray(reservation.booths)?reservation.booths[0]:reservation.booths).code,eventSlug);
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      if (bytes.byteLength > 5242880) return reply(origin, { error: "File must be 5 MB or smaller." }, 413);
      const path = `${event.id}/${reservation.id}/${crypto.randomUUID()}-${fileName}`;
      const { error: uploadError } = await supabase.storage.from("hero-event-payment-slips").upload(path, bytes, { contentType: mime, upsert: false });
      if (uploadError) throw uploadError;
      const {data:paymentRow,error:paymentError}=await supabase.from("payments").insert({reservation_id:reservation.id,method,slip_path:path,no_refund_ack_at:new Date().toISOString(),...(paymentQuote?{expected_amount:paymentQuote.amount,payer_reference:reservation.booking_reference}:{})}).select("id").single();
      if(paymentError)throw paymentError;
      const paymentEvidence=await evidence(req);
      await supabase.from("consent_evidence").insert({event_id:event.id,registration_id:reservation.registration_id,reservation_id:reservation.id,consent_type:"payment_no_refund",...paymentEvidence,evidence:{source:"before_payment",payment_id:paymentRow.id}});
      await supabase.from("reservations").update({ status: "payment_submitted", payment_method: method, updated_at: new Date().toISOString() }).eq("id", reservation.id);
      const reg = Array.isArray(reservation.registrations) ? reservation.registrations[0] : reservation.registrations;
      const booth = Array.isArray(reservation.booths) ? reservation.booths[0] : reservation.booths;

      const sent = await sendEmail(reg.email, "The Rice Event — Payment Slip Received", `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto"><img src="https://hero-event.pages.dev/the-rice/hero-event-logo.jpg" width="230" alt="HERO Event" style="display:block;max-width:70%;height:auto;margin:0 0 22px"><h3>ได้รับหลักฐานการชำระเงินแล้ว / Payment Slip Received</h3><p>พื้นที่ / Space: <strong>${escapeHtml(booth.code)}</strong></p><p>เลขที่การจอง / Reference: <strong>${escapeHtml(reservation.booking_reference)}</strong></p>${quoteEmail(paymentQuote)}<p>ผู้จัดงานกำลังตรวจสอบหลักฐาน / The organizer will verify your payment.</p>${exhibitorTerms}</div>`, reservation.registration_id, reservation.id);
      return reply(origin, { success: true, email_sent: sent });
    }

    return reply(origin, { error: "Unknown action" }, 400);
  } catch (error) {
    console.error(error);
    return reply(origin, { error: "Unable to complete the request. Please try again." }, 500);
  }
});
