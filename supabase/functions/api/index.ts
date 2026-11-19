// supabase/functions/api/index.ts
// FUNCTION NAME (type this exactly in Supabase): api
// Settings: turn Verify JWT OFF.
// Test: https://jjiiuwhybqagorygfarh.supabase.co/functions/v1/api/health
// This one file is complete: it already contains the shared helper code. Paste all of it.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { Hono } from "jsr:@hono/hono@4.6.5";
import { z, ZodSchema } from "npm:zod@3.23.8";

export const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Service-role client: bypasses RLS. Only ever used on the server, after we have checked who the caller is.
export const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret: ${name}`);
  return v;
}

export async function notify(
  userId: string, kind: string, title: string, body: string, data: Record<string, unknown> = {},
) {
  await admin.from("notifications").insert({ user_id: userId, kind, title, body, data, pushed_at: new Date().toISOString() });
  await sendPush(userId, title, body, data); // best effort: never blocks or fails the action
}

// Web push. Needs secrets VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (a mailto: address). Skipped when not set.
async function sendPush(userId: string, title: string, body: string, data: Record<string, unknown>) {
  try {
    const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
    if (!pub || !priv) return;
    const { data: subs } = await admin.from("push_subscriptions").select("endpoint, p256dh, auth").eq("user_id", userId);
    if (!subs?.length) return;
    const webpush = (await import("npm:web-push@3.6.7")).default;
    webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") ?? "mailto:support@ememart.com", pub, priv);
    const payload = JSON.stringify({ title, body, data });
    await Promise.all(subs.map(async (s: any) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      }
    }));
  } catch (e) { console.error("push failed", e); }
}

export async function audit(actor: string | null, action: string, target: string, detail: unknown = {}) {
  await admin.from("audit_log").insert({ actor_id: actor, action, target, detail });
}

const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(): Promise<CryptoKey> {
  // ENCRYPTION_KEY = base64 of 32 random bytes:  openssl rand -base64 32
  return crypto.subtle.importKey("raw", unb64(env("ENCRYPTION_KEY")), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), enc.encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return b64(out);
}

export async function decrypt(token: string): Promise<string> {
  const raw = unb64(token);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await aesKey(), raw.slice(12));
  return new TextDecoder().decode(pt);
}

async function pbkdf2(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: 100_000 }, k, 256));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${b64(salt)}$${b64(await pbkdf2(pin, salt))}`;
}

export async function verifyPinHash(pin: string, stored: string): Promise<boolean> {
  const [, salt, hash] = stored.split("$");
  return timingSafeEqual(b64(await pbkdf2(pin, unb64(salt))), hash);
}

export async function hmacSha512Hex(secret: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
  return [...sig].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Sandbox by default. For live set the secret SQUAD_BASE_URL=https://api-d.squadco.com
const base = () => Deno.env.get("SQUAD_BASE_URL") ?? "https://sandbox-api-d.squadco.com";

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base() + path, {
    method,
    headers: { Authorization: `Bearer ${env("SQUAD_SECRET_KEY")}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  return { httpStatus: res.status, data };
}

/** Hosted checkout for wallet funding. amount in kobo. */
export async function initiatePayment(p: {
  ref: string; email: string; amountKobo: number; name?: string; callbackUrl?: string;
}) {
  const r = await call("POST", "/transaction/initiate", {
    email: p.email, amount: p.amountKobo, currency: "NGN", initiate_type: "inline",
    transaction_ref: p.ref, customer_name: p.name, callback_url: p.callbackUrl,
    payment_channels: ["card", "bank", "transfer", "ussd"],
  });
  const url = r.data?.data?.checkout_url as string | undefined;
  if (!url) throw new Error(`Squad initiate failed (${r.httpStatus}): ${r.data?.message ?? "no message"}`);
  return url;
}

/** Ask Squad directly whether a payment really succeeded (never trust the webhook body alone). */
export async function verifyPayment(ref: string): Promise<{ success: boolean; amountKobo: number }> {
  const r = await call("GET", `/transaction/verify/${encodeURIComponent(ref)}`);
  const d = r.data?.data;
  const ok = r.httpStatus === 200 && String(d?.transaction_status ?? "").toLowerCase() === "success";
  return { success: ok, amountKobo: Number(d?.transaction_amount ?? d?.amount ?? 0) };
}

export async function lookupAccount(bankCode: string, accountNumber: string) {
  const r = await call("POST", "/payout/account/lookup", { bank_code: bankCode, account_number: accountNumber });
  const name = r.data?.data?.account_name as string | undefined;
  if (!name) throw new Error("Account not found");
  return name;
}

export const transferRef = (withdrawalId: string) =>
  `${env("SQUAD_MERCHANT_ID")}_${withdrawalId.replaceAll("-", "")}`; // reference must start with merchant id

export async function transfer(p: {
  ref: string; amountKobo: number; bankCode: string; accountNumber: string; accountName: string; remark: string;
}) {
  return call("POST", "/payout/transfer", {
    transaction_reference: p.ref, amount: String(p.amountKobo), bank_code: p.bankCode,
    account_number: p.accountNumber, account_name: p.accountName, currency_id: "NGN", remark: p.remark,
  });
}

export const requeryTransfer = (ref: string) => call("POST", "/payout/requery", { transaction_reference: ref });

/** HMAC-SHA512 signature check. Squad's docs are unclear whether the raw text or re-serialised JSON is signed,
 *  so accept a match on either. */
export async function validWebhookSignature(rawBody: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const got = header.trim().toLowerCase();
  const secret = env("SQUAD_SECRET_KEY");
  if (timingSafeEqual((await hmacSha512Hex(secret, rawBody)).toLowerCase(), got)) return true;
  try {
    return timingSafeEqual((await hmacSha512Hex(secret, JSON.stringify(JSON.parse(rawBody)))).toLowerCase(), got);
  } catch { return false; }
}

export type Profile = {
  id: string; full_name: string; email: string | null; phone: string | null; role: string;
  verified: boolean; status: string; pin_hash: string | null; pin_failed: number;
  pin_locked_until: string | null; tier: string; country: string;
};
export type AppEnv = { Variables: { uid: string; email: string | null; profile: Profile; adminRole: string } };
export const newRouter = () => new Hono<AppEnv>();

export async function parseBody<T>(c: { req: { json: () => Promise<unknown> } }, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new HttpError(400, "Invalid JSON body"); }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

export async function getSetting<T = any>(key: string): Promise<T> {
  const { data, error } = await admin.from("app_settings").select("value").eq("key", key).single();
  if (error || !data) throw new HttpError(500, `Missing setting ${key}`);
  return data.value as T;
}

/** Checks the transaction PIN with lockout (5 wrong tries -> 15 minutes). */
export async function checkPin(p: Profile, pin: string) {
  if (p.pin_locked_until && new Date(p.pin_locked_until) > new Date()) {
    throw new HttpError(423, "PIN locked. Try again later.");
  }
  if (!p.pin_hash) throw new HttpError(400, "Set a transaction PIN first");
  if (await verifyPinHash(pin, p.pin_hash)) {
    if (p.pin_failed) await admin.from("profiles").update({ pin_failed: 0, pin_locked_until: null }).eq("id", p.id);
    return;
  }
  const failed = p.pin_failed + 1;
  await admin.from("profiles").update({
    pin_failed: failed % 5 === 0 ? 0 : failed,
    pin_locked_until: failed % 5 === 0 ? new Date(Date.now() + 15 * 60_000).toISOString() : null,
  }).eq("id", p.id);
  throw new HttpError(401, "Wrong PIN");
}

/** Sum of ledger amounts for a user in the last 24h for the given kinds. */
export async function last24hSum(uid: string, kinds: string[]): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data } = await admin.from("ledger_entries").select("amount_kobo")
    .eq("user_id", uid).in("kind", kinds).gte("created_at", since);
  return (data ?? []).reduce((s: number, r: any) => s + Number(r.amount_kobo), 0);
}

export const pinSchema = z.string().regex(/^\d{4,6}$/, "PIN must be 4-6 digits");

export const me = newRouter();

me.get("/me", async (c) => {
  const p = c.get("profile");
  const [{ data: wallet }, { data: adm }, { data: pend }] = await Promise.all([
    admin.from("wallets").select("balance_kobo").eq("user_id", p.id).single(),
    admin.from("admin_users").select("role").eq("user_id", p.id).maybeSingle(),
    admin.from("role_applications").select("role").eq("user_id", p.id).eq("status", "pending").maybeSingle(),
  ]);
  const { pin_hash, pin_failed, pin_locked_until, ...safe } = p;
  return c.json({ profile: safe, has_pin: !!pin_hash, balance_kobo: wallet?.balance_kobo ?? 0, admin_role: adm?.role ?? null, pending_role: pend?.role ?? null });
});

me.post("/me/pin", async (c) => {
  const p = c.get("profile");
  const { pin, old_pin } = await parseBody(c, z.object({ pin: pinSchema, old_pin: pinSchema.optional() }));
  if (p.pin_hash) {
    if (!old_pin) throw new HttpError(400, "old_pin required to change PIN");
    await checkPin(p, old_pin);
  }
  await admin.from("profiles").update({ pin_hash: await hashPin(pin), pin_failed: 0, pin_locked_until: null }).eq("id", p.id);
  return c.json({ ok: true });
});

// ----- delete my account -----
// Blocks while money or orders are still open, then wipes personal data and closes the login.
me.post("/me/delete", async (c) => {
  const p = c.get("profile");
  const b = await parseBody(c, z.object({ confirm: z.literal("DELETE"), pin: pinSchema.optional() }));
  if (p.pin_hash) {
    if (!b.pin) throw new HttpError(400, "Enter your transaction PIN to delete your account");
    await checkPin(p, b.pin);
  }
  const { data: adm } = await admin.from("admin_users").select("user_id").eq("user_id", p.id).maybeSingle();
  if (adm) throw new HttpError(409, "Admin accounts must be removed from the admin team first");

  const { data: w } = await admin.from("wallets").select("balance_kobo").eq("user_id", p.id).maybeSingle();
  if (Number(w?.balance_kobo ?? 0) > 0) throw new HttpError(409, "Withdraw your wallet balance before deleting your account");

  const { count: openOrders } = await admin.from("orders").select("id", { count: "exact", head: true })
    .or(`buyer_id.eq.${p.id},seller_id.eq.${p.id}`).in("status", ["held", "delivered", "disputed"]);
  if (openOrders) throw new HttpError(409, "You still have orders in progress. Finish or cancel them first");

  const { count: openBookings } = await admin.from("bookings").select("id", { count: "exact", head: true })
    .or(`buyer_id.eq.${p.id},vendor_id.eq.${p.id}`).in("status", ["requested", "accepted"]);
  if (openBookings) throw new HttpError(409, "You still have open bookings. Finish or cancel them first");

  const { count: openWd } = await admin.from("withdrawals").select("id", { count: "exact", head: true })
    .eq("user_id", p.id).eq("status", "pending");
  if (openWd) throw new HttpError(409, "A withdrawal is still processing. Try again once it completes");

  // files first (photos, avatar, ID documents), then the database rows, then the login
  for (const bucket of ["post-images", "avatars", "kyc-docs"]) {
    const { data: files } = await admin.storage.from(bucket).list(p.id, { limit: 1000 });
    const paths = (files ?? []).map((f) => `${p.id}/${f.name}`);
    if (paths.length) await admin.storage.from(bucket).remove(paths);
  }
  const { error } = await admin.rpc("delete_account_data", { p_uid: p.id });
  if (error) throw new HttpError(500, "Could not delete the account: " + error.message);
  const { error: authErr } = await admin.auth.admin.updateUserById(p.id, {
    email: `deleted-${p.id}@deleted.invalid`, ban_duration: "876000h", user_metadata: {},
  });
  if (authErr) throw new HttpError(500, "Account data was removed but the login could not be closed: " + authErr.message);
  await audit(p.id, "account.deleted", p.id, {});
  return c.json({ ok: true });
});

// Switch account type. The first switch is instant; every later switch needs admin approval.
me.post("/me/role", async (c) => {
  const p = c.get("profile");
  const b = await parseBody(c, z.object({ role: z.enum(["buyer", "vendor", "artisan", "rider"]), details: z.record(z.unknown()).default({}) }));
  if (p.role === b.role) throw new HttpError(409, "You are already on this account type");
  const { data: adm } = await admin.from("admin_users").select("user_id").eq("user_id", p.id).maybeSingle();
  if (adm) throw new HttpError(409, "Admin accounts cannot switch type");
  if ((p.role_changes ?? 0) === 0) {
    await admin.from("profiles").update({ role: b.role, role_changes: 1 }).eq("id", p.id);
    return c.json({ approved: true, role: b.role });
  }
  const { data: open } = await admin.from("role_applications").select("id").eq("user_id", p.id).eq("status", "pending").maybeSingle();
  if (open) throw new HttpError(409, "You already have a request waiting for approval");
  const { error } = await admin.from("role_applications").insert({ user_id: p.id, role: b.role, details: b.details });
  if (error) throw new HttpError(400, error.message);
  return c.json({ pending: true, role: b.role }, 201);
});

// Verification (CAC / NIN / license). Admin reviews manually.
me.post("/verification", async (c) => {
  const p = c.get("profile");
  const b = await parseBody(c, z.object({
    kind: z.enum(["cac", "nin", "license"]),
    document_number: z.string().min(5).max(40),
    document_path: z.string().optional(),   // path in the private kyc-docs bucket: "<uid>/file.jpg"
    selfie_path: z.string().optional(),
  }));
  for (const path of [b.document_path, b.selfie_path]) {
    if (path && !path.startsWith(p.id + "/")) throw new HttpError(400, "File must be in your own folder");
  }
  if (b.kind === "nin" && !/^\d{11}$/.test(b.document_number)) throw new HttpError(400, "NIN must be 11 digits");
  const { data: pending } = await admin.from("verification_requests").select("id")
    .eq("user_id", p.id).eq("status", "pending").maybeSingle();
  if (pending) throw new HttpError(409, "A verification request is already pending");
  const { data, error } = await admin.from("verification_requests").insert({
    user_id: p.id, kind: b.kind, document_number_encrypted: await encrypt(b.document_number),
    document_path: b.document_path, selfie_path: b.selfie_path,
  }).select("id").single();
  if (error) throw new HttpError(400, error.message);
  await audit(p.id, "verification.submitted", data.id, { kind: b.kind });
  return c.json({ id: data.id }, 201);
});

me.get("/verification", async (c) => {
  const { data } = await admin.from("verification_requests")
    .select("id, kind, status, reject_reason, created_at, reviewed_at")
    .eq("user_id", c.get("uid")).order("created_at", { ascending: false });
  return c.json({ requests: data ?? [] });
});

// Mark all notifications read
me.post("/notifications/read-all", async (c) => {
  await admin.from("notifications").update({ read_at: new Date().toISOString() })
    .eq("user_id", c.get("uid")).is("read_at", null);
  return c.json({ ok: true });
});

// Web-push subscription from the PWA
me.post("/push/subscribe", async (c) => {
  const b = await parseBody(c, z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }));
  await admin.from("push_subscriptions").upsert({ user_id: c.get("uid"), endpoint: b.endpoint, keys: b.keys }, { onConflict: "endpoint" });
  return c.json({ ok: true });
});

// Nigerian bank list for withdrawals. Squad has no "list banks" endpoint; this is the table of
// 6-digit NIP bank codes from Squad's Transfer API documentation (docs.squadco.com/Transfer-API/transfer-apis).
// If Squad adds banks, add a line here and redeploy. Popular banks are listed first.
export const BANKS: { code: string; name: string }[] = [
  { code: "000013", name: "GTBank Plc" },
  { code: "000014", name: "Access Bank" },
  { code: "000015", name: "Zenith Bank Plc" },
  { code: "000004", name: "United Bank for Africa" },
  { code: "000016", name: "First Bank of Nigeria" },
  { code: "100004", name: "Opay Digital Services LTD" },
  { code: "100033", name: "PalmPay Limited" },
  { code: "090267", name: "Kuda Microfinance Bank" },
  { code: "090405", name: "Moniepoint Microfinance Bank" },
  { code: "000012", name: "StanbicIBTC Bank" },
  { code: "000003", name: "FCMB" },
  { code: "000007", name: "Fidelity Bank" },
  { code: "000017", name: "Wema Bank" },
  { code: "000001", name: "Sterling Bank" },
  { code: "000008", name: "Polaris Bank" },
  { code: "000018", name: "Union Bank" },
  { code: "000023", name: "Providus Bank" },
  { code: "000010", name: "Ecobank Bank" },
  { code: "000011", name: "Unity Bank" },
  { code: "000006", name: "JAIZ Bank" },
  { code: "090551", name: "FairMoney Microfinance Bank" },
  { code: "090110", name: "VFD MFB" },
  { code: "110005", name: "3line Card Management Limited" },
  { code: "120001", name: "9Payment Service Bank" },
  { code: "050005", name: "AAA Finance" },
  { code: "090270", name: "AB Microfinance Bank" },
  { code: "070010", name: "Abbey Mortgage Bank" },
  { code: "090260", name: "Above Only Microfinance Bank" },
  { code: "090197", name: "ABU Microfinance Bank" },
  { code: "090545", name: "Abulesoro Microfinance Bank" },
  { code: "090202", name: "Accelerex Network Limited" },
  { code: "100052", name: "Access Yello" },
  { code: "100013", name: "AccessMobile" },
  { code: "090134", name: "Accion Microfinance Bank" },
  { code: "090483", name: "Ada Microfinance Bank" },
  { code: "090160", name: "Addosser Microfinance Bank" },
  { code: "090268", name: "Adeyemi College Staff Microfinance Bank" },
  { code: "090155", name: "Advans La Fayette Microfinance Bank" },
  { code: "090292", name: "Afekhafe Microfinance Bank" },
  { code: "090518", name: "Afemai Microfinance Bank" },
  { code: "100028", name: "AG Mortgage Bank" },
  { code: "090608", name: "Akpo Microfinance Bank" },
  { code: "090531", name: "Aku Microfinance Bank" },
  { code: "090561", name: "Akuchuckwu Microfinance Bank" },
  { code: "070025", name: "Akwa Savings & Loans Limited" },
  { code: "090133", name: "AL-Barakah Microfinance Bank" },
  { code: "090277", name: "Al-Hayat Microfinance Bank" },
  { code: "090259", name: "Alekun Microfinance Bank" },
  { code: "090297", name: "Alert Microfinance Bank" },
  { code: "090131", name: "Allworkers Microfinance Bank" },
  { code: "090548", name: "Ally Microfinance Bank" },
  { code: "090169", name: "Alpha Kapital Microfinance Bank" },
  { code: "090489", name: "Alvana Microfinance Bank" },
  { code: "090394", name: "Amac Microfinance Bank" },
  { code: "090180", name: "Amju Unique Microfinance Bank" },
  { code: "090116", name: "AMML MFB" },
  { code: "090610", name: "Amoye Microfinance Bank" },
  { code: "090529", name: "Ampersand Microfinance Bank" },
  { code: "090476", name: "Anchorage Microfinance Bank" },
  { code: "090469", name: "Aniocha Microfinance bank" },
  { code: "090143", name: "Apeks Microfinance Bank" },
  { code: "090376", name: "Apple Microfinance Bank" },
  { code: "090307", name: "Aramoko Microfinance Bank" },
  { code: "090282", name: "Arise Microfinance Bank" },
  { code: "090001", name: "ASOSavings & Loans" },
  { code: "090544", name: "Aspire Microfinance Bank" },
  { code: "090287", name: "AssetMatrix Microfinance Bank" },
  { code: "090473", name: "Assets Microfinance Bank" },
  { code: "090172", name: "Astrapolaris Microfinance Bank" },
  { code: "090264", name: "Auchi Microfinance Bank" },
  { code: "090600", name: "Ave Maria Microfinance Bank" },
  { code: "090540", name: "Aztec Microfinance Bank" },
  { code: "090188", name: "Baines Credit Microfinance Bank" },
  { code: "090563", name: "Balera Microfinance Bank" },
  { code: "090181", name: "Balogun Fulani Microfinance Bank" },
  { code: "090326", name: "Balogun Gambari Microfinance Bank" },
  { code: "090581", name: "Banc Corp MFB" },
  { code: "090127", name: "BC Kash Microfinance Bank" },
  { code: "090615", name: "Beststar MFB" },
  { code: "090336", name: "BIPC Microfinance Bank" },
  { code: "090555", name: "BishopGate Microfinance Bank" },
  { code: "090538", name: "BluePrint Investments Microfinance Bank" },
  { code: "090117", name: "Boctrust Microfinance Bank" },
  { code: "090444", name: "BOI Microfinance Bank" },
  { code: "090494", name: "Boji MFB" },
  { code: "090395", name: "Borgu Microfinance Bank" },
  { code: "090176", name: "Bosak Microfinance Bank" },
  { code: "090148", name: "Bowen Microfinance Bank" },
  { code: "050006", name: "Branch International Financial Services" },
  { code: "070015", name: "Brent Mortgage Bank" },
  { code: "090293", name: "Brethren Microfinance Bank" },
  { code: "090393", name: "Bridgeway Microfinance Bank" },
  { code: "090308", name: "Brightway Microfinance Bank" },
  { code: "090568", name: "Broadview Microfinance Bank" },
  { code: "090406", name: "Business Support Microfinance Bank" },
  { code: "090472", name: "Caretaker Microfinance Bank" },
  { code: "090634", name: "Cashbridge Microfinance Bank" },
  { code: "090360", name: "CashConnect Microfinance Bank" },
  { code: "090562", name: "Cedar Microfinance Bank" },
  { code: "100005", name: "Cellulant" },
  { code: "090154", name: "CEMCS Microfinance Bank" },
  { code: "090470", name: "Changan RTS Microfinance Bank" },
  { code: "090523", name: "Chase Microfinance Bank" },
  { code: "090141", name: "Chikum Microfinance Bank" },
  { code: "090490", name: "Chukwunenye MFB" },
  { code: "090480", name: "Cintrust Microfinance Bank" },
  { code: "090144", name: "CIT Microfinance Bank" },
  { code: "000009", name: "Citi Bank" },
  { code: "090254", name: "Coalcamp Microfinance Bank" },
  { code: "090374", name: "Coastline Microfinance Bank" },
  { code: "090530", name: "Confidence MFB" },
  { code: "090380", name: "Conpro Microfinance Bank" },
  { code: "090553", name: "Consistent Trust Microfinance Bank" },
  { code: "090130", name: "Consumer Microfinance Bank" },
  { code: "100032", name: "Contec Global Infotech Limited (NowNow)" },
  { code: "070021", name: "Coop Mortgage Bank" },
  { code: "090365", name: "Corestep Microfinance Bank" },
  { code: "060001", name: "Coronation Merchant Bank" },
  { code: "070006", name: "Covenant MFB" },
  { code: "090159", name: "Credit Afrique Microfinance Bank" },
  { code: "090611", name: "Creditville MFB" },
  { code: "090526", name: "Crescent Microfinance Bank" },
  { code: "110017", name: "Crowdforce" },
  { code: "110014", name: "Cyberspace Limited" },
  { code: "090391", name: "Davodani Microfinance Bank" },
  { code: "090167", name: "Daylight Microfinance Bank" },
  { code: "070023", name: "Delta Trust Microfinance Bank" },
  { code: "000005", name: "Diamond Bank" },
  { code: "050013", name: "Dignity Finance" },
  { code: "090156", name: "e-Barcs Microfinance Bank" },
  { code: "090294", name: "Eagle Flight Microfinance Bank" },
  { code: "100021", name: "Eartholeum" },
  { code: "100008", name: "Ecobank Xpress Account" },
  { code: "100030", name: "EcoMobile" },
  { code: "090310", name: "EdFin Microfinance Bank" },
  { code: "090556", name: "Egwafin Microfinance Bank" },
  { code: "090389", name: "EK-Reliable Microfinance Bank" },
  { code: "090097", name: "Ekondo MFB" },
  { code: "090273", name: "Emeralds Microfinance Bank" },
  { code: "090114", name: "Empire trust MFB" },
  { code: "050012", name: "Enco Finance" },
  { code: "090539", name: "Enrich Microfinance Bank" },
  { code: "000019", name: "Enterprise Bank" },
  { code: "090189", name: "Esan Microfinance Bank" },
  { code: "090166", name: "Eso-E Microfinance Bank" },
  { code: "090982", name: "Ethica MFB" },
  { code: "100006", name: "eTranzact" },
  { code: "090304", name: "Evangel Microfinance Bank" },
  { code: "090332", name: "Evergreen Microfinance Bank" },
  { code: "090572", name: "EWT Microfinance Bank" },
  { code: "090541", name: "Excellent Microfinance Bank" },
  { code: "090328", name: "Eyowo" },
  { code: "050009", name: "Fast Credit" },
  { code: "090179", name: "FAST Microfinance Bank" },
  { code: "090107", name: "FBN Mortgages Limited" },
  { code: "100014", name: "FBNMobile" },
  { code: "060002", name: "FBNQUEST Merchant Bank" },
  { code: "090409", name: "FCMB BETA" },
  { code: "100031", name: "FCMB Easy Account" },
  { code: "090290", name: "FCT Microfinance Bank" },
  { code: "090398", name: "Federal Polytechnic Nekede Microfinance Bank" },
  { code: "090318", name: "Federal University Dutse Microfinance Bank" },
  { code: "090482", name: "Fedeth Microfinance Bank" },
  { code: "090298", name: "FedPoly Nasarawa Microfinance Bank" },
  { code: "100001", name: "FET" },
  { code: "050002", name: "FEWCHORE FINANCE COMPANY LIMITED" },
  { code: "090153", name: "FFS Microfinance Bank" },
  { code: "070026", name: "FHA Mortgage Bank" },
  { code: "100019", name: "Fidelity Mobile" },
  { code: "090126", name: "Fidfund Microfinance Bank" },
  { code: "090507", name: "FIMS MFB" },
  { code: "090111", name: "FinaTrust Microfinance Bank" },
  { code: "090366", name: "Firmus Microfinance Bank" },
  { code: "110004", name: "First Apple Limited" },
  { code: "070014", name: "First Generation Mortgage Bank" },
  { code: "090575", name: "First Midas Microfinance Bank" },
  { code: "090285", name: "First Option Microfinance Bank" },
  { code: "090164", name: "First Royal Microfinance Bank" },
  { code: "090614", name: "Flourish MFB" },
  { code: "110002", name: "Flutterwave Technology Solutions Limited" },
  { code: "070002", name: "Fortis Microfinance Bank" },
  { code: "100016", name: "FortisMobile" },
  { code: "400001", name: "FSDH Merchant Bank" },
  { code: "090145", name: "Fullrange Microfinance Bank" },
  { code: "050010", name: "Fundquest Financial Services Limited" },
  { code: "090158", name: "Futo Microfinance Bank" },
  { code: "090591", name: "Gabsyn Microfinance Bank Limited" },
  { code: "090168", name: "Gashua Microfinance Bank" },
  { code: "070009", name: "Gateway Mortgage Bank" },
  { code: "090579", name: "Gbede Microfinance Bank" },
  { code: "090475", name: "Giant Stride Microfinance Bank" },
  { code: "090411", name: "Giginya Microfinance bank" },
  { code: "090186", name: "Girei Microfinance Bank" },
  { code: "000027", name: "Globus Bank" },
  { code: "090278", name: "Glory Microfinance Bank" },
  { code: "090408", name: "GMB Microfinance Bank" },
  { code: "090574", name: "GOLDMAN MFB" },
  { code: "100022", name: "GoMoney" },
  { code: "090467", name: "Good Neighbours Microfinance Bank" },
  { code: "090495", name: "Goodnews Microfinance Bank" },
  { code: "090122", name: "Gowans Microfinance Bank" },
  { code: "090550", name: "Green Energy Microfinance Bank" },
  { code: "090178", name: "GreenBank Microfinance Bank" },
  { code: "090269", name: "Greenville Microfinance Bank" },
  { code: "060004", name: "Greenwich Merchant Bank" },
  { code: "090195", name: "Grooming Microfinance Bank" },
  { code: "090385", name: "GTI Microfinance Bank" },
  { code: "100009", name: "GTMobile" },
  { code: "090147", name: "Hackman Microfinance Bank" },
  { code: "070017", name: "Haggai Mortgage Bank Limited" },
  { code: "090291", name: "Halal Credit Microfinance Bank" },
  { code: "090121", name: "Hasal Microfinance Bank" },
  { code: "090363", name: "Headway Microfinance Bank" },
  { code: "100017", name: "Hedonmark" },
  { code: "000020", name: "Heritage" },
  { code: "090175", name: "HighStreet Microfinance Bank" },
  { code: "070024", name: "Homebase Mortgage Bank" },
  { code: "120002", name: "HopePSB" },
  { code: "090598", name: "IBA Microfinance Bank" },
  { code: "090118", name: "IBILE Microfinance Bank" },
  { code: "090532", name: "IBOLO Microfinance Bank" },
  { code: "090519", name: "Iboma Fadama Microfinance Bank" },
  { code: "090488", name: "Ibu-Aje Microfinance Bank" },
  { code: "090546", name: "Ijebu-Ife Microfinance Bank" },
  { code: "090324", name: "Ikenne Microfinance Bank" },
  { code: "090279", name: "Ikire Microfinance Bank" },
  { code: "090536", name: "Ikoyi-Osun Microfinance Bank" },
  { code: "090571", name: "Ilaro Poly Microfinance Bank" },
  { code: "090370", name: "Ilisan Microfinance Bank" },
  { code: "090258", name: "Imo State Microfinance Bank" },
  { code: "100024", name: "Imperial Homes Mortgage Bank" },
  { code: "090157", name: "Infinity Microfinance Bank" },
  { code: "070016", name: "Infinity Trust Mortgage Bank" },
  { code: "100029", name: "Innovectives Kesh" },
  { code: "100027", name: "Intellifin" },
  { code: "090386", name: "Interland Microfinance Bank" },
  { code: "110003", name: "Interswitch Limited" },
  { code: "090149", name: "IRL Microfinance Bank" },
  { code: "090377", name: "Isaleoyo Microfinance Bank" },
  { code: "090584", name: "Island Microfinance Bank" },
  { code: "090578", name: "Iwade MFB Ltd" },
  { code: "090543", name: "Iwoama Microfinance Bank" },
  { code: "090570", name: "Iyamoye Microfinance Bank" },
  { code: "090337", name: "Iyeru Okin Microfinance Bank" },
  { code: "090620", name: "Iyin Ekiti MFB" },
  { code: "090352", name: "Jessefield Microfinance Bank" },
  { code: "090003", name: "Jubilee-Life Mortgage Bank" },
  { code: "090320", name: "KadPoly Microfinance Bank" },
  { code: "090554", name: "Kayvee Microfinance Bank" },
  { code: "090549", name: "KC Microfinance Bank" },
  { code: "090191", name: "KCMB Microfinance Bank" },
  { code: "100036", name: "Kegow (Chamsmobile)" },
  { code: "090602", name: "Kenechukwu Microfinance Bank" },
  { code: "000002", name: "Keystone Bank" },
  { code: "090299", name: "Kontagora Microfinance Bank" },
  { code: "070012", name: "Lagos Building Investment Company" },
  { code: "090177", name: "Lapo Microfinance Bank" },
  { code: "090271", name: "Lavender Microfinance Bank" },
  { code: "090372", name: "Legend Microfinance Bank" },
  { code: "090557", name: "Lifegate Microfinance Bank" },
  { code: "090477", name: "Light MFB" },
  { code: "090537", name: "Lobrem Microfinance Bank" },
  { code: "000029", name: "Lotus Bank" },
  { code: "090265", name: "Lovonus Microfinance Bank" },
  { code: "100035", name: "M36" },
  { code: "090623", name: "MAB Allianz MFB" },
  { code: "090603", name: "Macrod MFB" },
  { code: "090323", name: "Mainland Microfinance Bank" },
  { code: "090171", name: "Mainstreet Microfinance Bank" },
  { code: "090465", name: "Maintrust Microfinance Bank" },
  { code: "090174", name: "Malachy Microfinance Bank" },
  { code: "090410", name: "Maritime Microfinance Bank" },
  { code: "090321", name: "MayFair Microfinance Bank" },
  { code: "070019", name: "MayFresh Mortgage Bank" },
  { code: "090612", name: "Medef Microfinance Bank" },
  { code: "090280", name: "Megapraise Microfinance Bank" },
  { code: "090589", name: "Mercury MFB" },
  { code: "090528", name: "Mgbidi Microfinance Bank" },
  { code: "090587", name: "Microbiz MFB" },
  { code: "090136", name: "Microcred Microfinance Bank" },
  { code: "090192", name: "Midland Microfinance Bank" },
  { code: "090281", name: "MintFinex Microfinance Bank" },
  { code: "090455", name: "Mkobo Microfinance Bank" },
  { code: "100011", name: "Mkudi" },
  { code: "090362", name: "Molusi Microfinance Bank" },
  { code: "120003", name: "MoMo PSB" },
  { code: "090129", name: "Money Trust Microfinance Bank" },
  { code: "100020", name: "MoneyBox" },
  { code: "090448", name: "Moyofade Microfinance Bank" },
  { code: "090190", name: "Mutual Benefits Microfinance Bank" },
  { code: "090151", name: "Mutual Trust Microfinance Bank" },
  { code: "090152", name: "Nagarta Microfinance Bank" },
  { code: "090349", name: "Nassarawa Microfinance Bank" },
  { code: "090263", name: "Navy Microfinance Bank" },
  { code: "090128", name: "Ndiorah Microfinance Bank" },
  { code: "090329", name: "Neptune Microfinance Bank" },
  { code: "090205", name: "New Dawn Microfinance Bank" },
  { code: "090378", name: "New Golden Pastures Microfinance Bank" },
  { code: "090108", name: "New Prudential Bank" },
  { code: "090505", name: "Nigerian Prisons Microfinance Bank" },
  { code: "999999", name: "NIP Virtual Bank" },
  { code: "090194", name: "NIRSAL Microfinance Bank" },
  { code: "090535", name: "Nkpolu-Ust MFB" },
  { code: "090283", name: "Nnew Women Microfinance Bank" },
  { code: "090645", name: "Nombank MFB" },
  { code: "060003", name: "Nova Merchant Bank" },
  { code: "070001", name: "NPF MicroFinance Bank" },
  { code: "090491", name: "Nsuk MFB" },
  { code: "090516", name: "Numo Microfinance Bank" },
  { code: "090364", name: "Nuture Microfinance Bank" },
  { code: "090399", name: "Nwannegadi Microfinance Bank" },
  { code: "090345", name: "OAU Microfinance Bank" },
  { code: "090333", name: "Oche Microfinance Bank" },
  { code: "090576", name: "Octopus Microfinance Bank" },
  { code: "090119", name: "Ohafia Microfinance Bank" },
  { code: "090527", name: "Ojokoro Microfinance Bank" },
  { code: "090565", name: "Oke-Aro Oredegbe Microfinance Bank" },
  { code: "090161", name: "Okpoga Microfinance Bank" },
  { code: "090566", name: "Okuku Microfinance Bank" },
  { code: "090272", name: "Olabisi Onabanjo University Microfinance Bank" },
  { code: "090468", name: "OLOFIN OWENA Microfinance Bank" },
  { code: "090404", name: "Olowolagba Microfinance Bank" },
  { code: "090471", name: "Oluchukwu Microfinance Bank" },
  { code: "090295", name: "Omiye Microfinance Bank" },
  { code: "070007", name: "Omoluabi savings and loans" },
  { code: "100026", name: "One Finance" },
  { code: "000036", name: "Optimus Bank" },
  { code: "090492", name: "Oraukwu MFB" },
  { code: "090588", name: "Orisun MFB" },
  { code: "090567", name: "Orokam Microfinance Bank" },
  { code: "090396", name: "Oscotech Microfinance Bank" },
  { code: "090580", name: "Otech Microfinance Bank" },
  { code: "090542", name: "Otuo Microfinance Bank" },
  { code: "100002", name: "Paga" },
  { code: "070008", name: "Page Financials" },
  { code: "100003", name: "Parkway-ReadyCash" },
  { code: "090004", name: "Parralex Microfinance bank" },
  { code: "090317", name: "PatrickGold Microfinance Bank" },
  { code: "110001", name: "PayAttitude Online" },
  { code: "110006", name: "Paystack Payment Limited" },
  { code: "090137", name: "PecanTrust Microfinance Bank" },
  { code: "090196", name: "Pennywise Microfinance Bank" },
  { code: "090135", name: "Personal Trust Microfinance Bank" },
  { code: "090165", name: "Petra Microfinance Bank" },
  { code: "090289", name: "Pillar Microfinance Bank" },
  { code: "070013", name: "Platinum Mortgage Bank" },
  { code: "090534", name: "Polybadan Microfinance Bank" },
  { code: "090296", name: "Polyunwana Microfinance Bank" },
  { code: "090412", name: "Preeminent Microfinance Bank" },
  { code: "000031", name: "Premium Trust Bank" },
  { code: "090274", name: "Prestige Microfinance Bank" },
  { code: "090499", name: "Pristine Divitis Microfinance Bank" },
  { code: "090503", name: "Projects Microfinance Bank" },
  { code: "110032", name: "Prophius" },
  { code: "090303", name: "Purplemoney Microfinance Bank" },
  { code: "090569", name: "Qube Microfinance Bank" },
  { code: "090261", name: "Quickfund Microfinance Bank" },
  { code: "000024", name: "Rand Merchant Bank" },
  { code: "090496", name: "Randalpha Microfinance Bank" },
  { code: "090616", name: "Rayyan MFB" },
  { code: "070011", name: "Refuge Mortgage Bank" },
  { code: "090125", name: "Regent Microfinance Bank" },
  { code: "090463", name: "Rehoboth Microfinance Bank" },
  { code: "090173", name: "Reliance Microfinance Bank" },
  { code: "090198", name: "RenMoney Microfinance Bank" },
  { code: "090322", name: "Rephidim Microfinance Bank" },
  { code: "090132", name: "Richway Microfinance Bank" },
  { code: "090515", name: "RIMA Growth Pathway Microfinance Bank" },
  { code: "090547", name: "Rockshield Microfinance Bank" },
  { code: "090138", name: "Royal Exchange Microfinance Bank" },
  { code: "090286", name: "Safe Haven Microfinance Bank" },
  { code: "090006", name: "SafeTrust" },
  { code: "090140", name: "Sagamu Microfinance Bank" },
  { code: "050003", name: "SageGrey Finance Limited" },
  { code: "090513", name: "SEAP Microfinance Bank" },
  { code: "090112", name: "Seed Capital Microfinance Bank" },
  { code: "090369", name: "Seedvest Microfinance Bank" },
  { code: "090502", name: "Shalom Microfinance Bank" },
  { code: "090401", name: "Shepherd Trust Microfinance Bank" },
  { code: "090559", name: "Shield Microfinance Bank" },
  { code: "090558", name: "Shongom Microfinance Bank" },
  { code: "000034", name: "Signature Bank" },
  { code: "120004", name: "SmartCash PSB" },
  { code: "090573", name: "Snow MFB" },
  { code: "090506", name: "Solid Allianze MFB" },
  { code: "090524", name: "Solidrock microfinance Bank" },
  { code: "090325", name: "Sparkle" },
  { code: "100007", name: "Stanbic IBTC @ease wallet" },
  { code: "000021", name: "Standard Chartered" },
  { code: "090162", name: "Stanford Microfinance Bank" },
  { code: "090583", name: "Stateside Microfinance Bank" },
  { code: "090262", name: "Stellas Microfinance Bank" },
  { code: "090305", name: "Sulspap Microfinance Bank" },
  { code: "000022", name: "Suntrust Bank" },
  { code: "090564", name: "Supreme Microfinance Bank" },
  { code: "100023", name: "TagPay" },
  { code: "000026", name: "Taj Bank" },
  { code: "080002", name: "Taj_Pinspay" },
  { code: "090560", name: "Tanadi Microfinance Bank" },
  { code: "090593", name: "Tasued Microfinance Bank" },
  { code: "090115", name: "TCF MFB" },
  { code: "110007", name: "Teamapt Limited" },
  { code: "100010", name: "TeasyMobile" },
  { code: "050007", name: "Tekla Finance Limited" },
  { code: "090373", name: "Think Finance Microfinance Bank" },
  { code: "000025", name: "Titan Trust Bank" },
  { code: "100039", name: "TitanPaystack" },
  { code: "090146", name: "Trident Microfinance Bank" },
  { code: "090525", name: "TripleA Microfinance Bank" },
  { code: "090327", name: "Trust Microfinance Bank" },
  { code: "090005", name: "Trustbond Mortgage Bank" },
  { code: "090276", name: "Trustfund Microfinance Bank" },
  { code: "090315", name: "U & C Microfinance Bank" },
  { code: "090403", name: "UDA Microfinance Bank" },
  { code: "090517", name: "Uhuru Microfinance Bank" },
  { code: "090609", name: "Ummah Microfinance Bank" },
  { code: "090331", name: "UNAAB Microfinance Bank" },
  { code: "090266", name: "Uniben Microfinance Bank" },
  { code: "090193", name: "Unical Microfinance Bank" },
  { code: "090464", name: "Unimaid Microfinance Bank" },
  { code: "090338", name: "UniUyo Microfinance Bank" },
  { code: "090251", name: "UNN MFB" },
  { code: "110015", name: "Vas2nets Limited" },
  { code: "090474", name: "Verdant Microfinance Bank" },
  { code: "090123", name: "Verite Microfinance Bank" },
  { code: "090150", name: "Virtue Microfinance Bank" },
  { code: "090139", name: "Visa Microfinance Bank" },
  { code: "100012", name: "VTNetworks" },
  { code: "090950", name: "Waya Microfinance Bank" },
  { code: "090120", name: "Wetland Microfinance Bank" },
  { code: "090124", name: "Xslnce Microfinance Bank" },
  { code: "090466", name: "YCT Microfinance Bank" },
  { code: "090142", name: "Yes Microfinance Bank" },
  { code: "090252", name: "Yobe Microfinance Bank" },
  { code: "100034", name: "Zenith Eazy Wallet" },
  { code: "100018", name: "ZenithMobile" },
  { code: "090504", name: "Zikora Microfinance Bank" },
  { code: "100025", name: "Zinternet Nigera Limited" },
];

export const wallet = newRouter();

const tierOf = (verified: boolean) => (verified ? "verified" : "unverified");

wallet.get("/wallet", async (c) => {
  const p = c.get("profile");
  const [{ data: w }, { data: entries }, limits] = await Promise.all([
    admin.from("wallets").select("balance_kobo").eq("user_id", p.id).single(),
    admin.from("ledger_entries").select("id, amount_kobo, balance_after, kind, ref, created_at")
      .eq("user_id", p.id).order("id", { ascending: false }).limit(50),
    getSetting("wallet_limits"),
  ]);
  return c.json({ balance_kobo: w?.balance_kobo ?? 0, limits: limits[tierOf(p.verified)], entries: entries ?? [] });
});

wallet.post("/wallet/fund", async (c) => {
  const p = c.get("profile");
  if (p.country !== "NG") throw new HttpError(403, "Wallet funding is only available in Nigeria for now");
  const { amount_kobo } = await parseBody(c, z.object({ amount_kobo: z.number().int().min(10_000).max(100_000_000) }));
  const lim = (await getSetting("wallet_limits"))[tierOf(p.verified)];
  const { data: w } = await admin.from("wallets").select("balance_kobo").eq("user_id", p.id).single();
  if (Number(w?.balance_kobo ?? 0) + amount_kobo > lim.max_balance) throw new HttpError(400, "This would exceed your maximum wallet balance. Verify your account to raise it.");
  if ((await last24hSum(p.id, ["funding"])) + amount_kobo > lim.daily_funding) throw new HttpError(400, "Daily funding limit reached");
  const email = p.email ?? c.get("email");
  if (!email) throw new HttpError(400, "An email address is required to fund your wallet");
  const ref = `EMEFUND${Date.now()}${crypto.randomUUID().slice(0, 8)}`.toUpperCase();
  await admin.from("funding_intents").insert({ ref, user_id: p.id, amount_kobo });
  const checkout_url = await initiatePayment({
    ref, email, amountKobo: amount_kobo, name: p.full_name, callbackUrl: Deno.env.get("PAYMENT_CALLBACK_URL"),
  });
  return c.json({ ref, checkout_url });
});

wallet.get("/wallet/banks", (c) => c.json({ banks: BANKS }));
wallet.get("/wallet/withdrawals", async (c) => {
  const p = c.get("profile");
  const { data } = await admin.from("withdrawals").select("id, amount_kobo, bank_code, account_number, account_name, status, created_at").eq("user_id", p.id).order("created_at", { ascending: false }).limit(50);
  const bank = new Map(BANKS.map((b: any) => [b.code, b.name]));
  return c.json({ withdrawals: (data ?? []).map((w: any) => ({ ...w, bank_name: bank.get(w.bank_code) ?? "Bank", account_number: "******" + String(w.account_number).slice(-4) })) });
});

wallet.post("/wallet/lookup", async (c) => {
  const b = await parseBody(c, z.object({ bank_code: z.string().regex(/^\d{6}$/), account_number: z.string().regex(/^\d{10}$/) }));
  try { return c.json({ account_name: await lookupAccount(b.bank_code, b.account_number) }); }
  catch { throw new HttpError(404, "Account not found"); }
});

wallet.post("/wallet/withdraw", async (c) => {
  const p = c.get("profile");
  if (p.country !== "NG") throw new HttpError(403, "Withdrawals are only available in Nigeria for now");
  const b = await parseBody(c, z.object({
    amount_kobo: z.number().int().min(10_000), bank_code: z.string().regex(/^\d{6}$/),
    account_number: z.string().regex(/^\d{10}$/), pin: pinSchema,
  }));
  await checkPin(p, b.pin);
  const lim = (await getSetting("wallet_limits"))[tierOf(p.verified)];
  const netOut = -(await last24hSum(p.id, ["withdrawal", "withdrawal_reversal"]));
  if (netOut + b.amount_kobo > lim.daily_withdrawal) throw new HttpError(400, "Daily withdrawal limit reached");

  let accountName: string;
  try { accountName = await lookupAccount(b.bank_code, b.account_number); }
  catch { throw new HttpError(400, "Could not verify that bank account"); }

  const { data: wd, error: wdErr } = await admin.from("withdrawals").insert({
    user_id: p.id, amount_kobo: b.amount_kobo, bank_code: b.bank_code,
    account_number: b.account_number, account_name: accountName,
  }).select("id").single();
  if (wdErr) throw new HttpError(500, wdErr.message);

  // Debit FIRST (rejects if balance is too low), then send the money.
  const { error: debitErr } = await admin.rpc("ledger_post", {
    p_user: p.id, p_amount: -b.amount_kobo, p_kind: "withdrawal", p_ref: wd.id, p_idem: `wd:${wd.id}`,
  });
  if (debitErr) {
    await admin.from("withdrawals").update({ status: "failed" }).eq("id", wd.id);
    throw new HttpError(400, "Insufficient balance");
  }

  const ref = transferRef(wd.id);
  await admin.from("withdrawals").update({ squad_ref: ref }).eq("id", wd.id);
  let status: "success" | "failed" | "pending" = "pending";
  try {
    const r = await transfer({ ref, amountKobo: b.amount_kobo, bankCode: b.bank_code, accountNumber: b.account_number, accountName, remark: `Ememart withdrawal ${wd.id.slice(0, 8)}` });
    const code = Number(r.data?.status ?? r.httpStatus);
    if (code === 200) status = "success";
    else if ([400, 412, 422].includes(code)) status = "failed";   // definite failure
    // anything else (424 timeout, network) stays pending; the jobs function re-queries it
  } catch { /* stays pending */ }

  if (status === "failed") {
    await admin.rpc("ledger_post", { p_user: p.id, p_amount: b.amount_kobo, p_kind: "withdrawal_reversal", p_ref: wd.id, p_idem: `wdrev:${wd.id}` });
  }
  await admin.from("withdrawals").update({ status }).eq("id", wd.id);
  await audit(p.id, "wallet.withdraw", wd.id, { status, amount: b.amount_kobo });
  if (status === "failed") throw new HttpError(502, "Transfer failed. Your money was returned to your wallet.");
  return c.json({ id: wd.id, status });
});

export const orders = newRouter();

async function placeFor(buyer: string, post: any, qty: number, amountKobo: number, extraSnapshot: Record<string, unknown> = {}, extra: { delivery_fee_kobo?: number; address?: string; note?: string } = {}) {
  if (post.author_id === buyer) throw new HttpError(400, "You cannot buy your own item");
  const { count } = await admin.from("orders").select("id", { count: "exact", head: true }).eq("buyer_id", buyer);
  const { data: seller } = await admin.from("profiles").select("full_name, status").eq("id", post.author_id).single();
  if (seller?.status !== "active") throw new HttpError(400, "This seller is unavailable");
  const snapshot = {
    title: post.title, description: post.description, price_kobo: post.price_kobo, quantity: qty,
    type: post.type, image: post.images?.[0] ?? null, seller_name: seller.full_name, ...extraSnapshot,
  };
  const { data, error } = await admin.rpc("place_order", {
    p_buyer: buyer, p_seller: post.author_id, p_post: post.id, p_snapshot: snapshot,
    p_amount: amountKobo, p_first_order: (count ?? 0) === 0,
  });
  if (error) throw new HttpError(400, error.message.includes("check") ? "Insufficient wallet balance" : error.message);
  await admin.from("orders").update({
    quantity: qty, delivery_fee_kobo: extra.delivery_fee_kobo ?? 0, delivery_address: extra.address ?? null, note: extra.note ?? null,
  }).eq("id", data as string);
  if (post.extra && post.extra.qty !== undefined) await admin.rpc("decrement_post_qty", { p_post: post.id, p_n: qty });
  return data as string;
}

async function visiblePost(id: string) {
  const { data } = await admin.from("posts").select("*").eq("id", id).maybeSingle();
  if (!data || (data.expires_at && new Date(data.expires_at) <= new Date())) throw new HttpError(404, "Post not found or expired");
  if (data.closes_at && new Date(data.closes_at) <= new Date()) throw new HttpError(400, "This food post is closed. Message the Partner to ask for a new meal.");
  if (!data.price_kobo) throw new HttpError(400, "This post has no price");
  return data;
}

orders.post("/orders", async (c) => {
  const p = c.get("profile");
  const b = await parseBody(c, z.object({
    post_id: z.string().uuid(), quantity: z.number().int().min(1).max(100).default(1), pin: pinSchema,
    delivery_fee_kobo: z.number().int().min(0).max(200_000).default(0),
    address: z.string().min(3).max(300), note: z.string().max(500).optional(),
  }));
  await checkPin(p, b.pin);
  const post = await visiblePost(b.post_id);
  if (post.type === "booking") throw new HttpError(400, "Use /bookings for pre-orders");
  if (post.extra && post.extra.qty !== undefined && Number(post.extra.qty) < b.quantity) throw new HttpError(400, "Not enough portions left");
  const unit = post.extra?.flashSale && post.extra?.flashPrice ? Math.round(Number(post.extra.flashPrice) * 100) : Number(post.price_kobo);
  const id = await placeFor(p.id, post, b.quantity, unit * b.quantity + b.delivery_fee_kobo, { delivery_fee_kobo: b.delivery_fee_kobo },
    { delivery_fee_kobo: b.delivery_fee_kobo, address: b.address, note: b.note });
  const { data: bal } = await admin.from("wallets").select("balance_kobo").eq("user_id", p.id).single();
  await notify(post.author_id, "new_order", "New order", `${p.full_name || "A buyer"} ordered "${post.title}".`, { order: id });
  return c.json({ id, balance_kobo: bal?.balance_kobo ?? 0 }, 201);
});

orders.get("/orders", async (c) => {
  const uid = c.get("uid");
  const { data } = await admin.from("orders").select("*").or(`buyer_id.eq.${uid},seller_id.eq.${uid}`).order("created_at", { ascending: false }).limit(100);
  const ids = [...new Set((data ?? []).flatMap((o: any) => [o.buyer_id, o.seller_id]))];
  const { data: profs } = ids.length ? await admin.from("public_profiles").select("id, full_name, area").in("id", ids) : { data: [] };
  const name = new Map((profs ?? []).map((p: any) => [p.id, p]));
  const out = (data ?? []).map((o: any) => ({ ...o, buyer_name: name.get(o.buyer_id)?.full_name ?? "", seller_name: name.get(o.seller_id)?.full_name ?? "" }));
  return c.json({ orders: out });
});

async function myOrder(id: string, uid: string) {
  const { data } = await admin.from("orders").select("*").eq("id", id).maybeSingle();
  if (!data || (data.buyer_id !== uid && data.seller_id !== uid)) throw new HttpError(404, "Order not found");
  return data;
}

// Seller says the item/service was delivered; starts the auto-release timer
orders.post("/orders/:id/deliver", async (c) => {
  const o = await myOrder(c.req.param("id"), c.get("uid"));
  if (o.seller_id !== c.get("uid")) throw new HttpError(403, "Only the seller can mark delivery");
  if (o.status !== "held") throw new HttpError(400, `Order is ${o.status}`);
  const hours = (await getSetting("escrow")).auto_release_hours as number;
  await admin.from("orders").update({
    status: "delivered", delivered_at: new Date().toISOString(),
    auto_release_at: new Date(Date.now() + hours * 3600_000).toISOString(),
  }).eq("id", o.id);
  await notify(o.buyer_id, "order_delivered", "Order delivered?", `Confirm to release payment, or it releases automatically in ${hours} hours. Open a dispute if there is a problem.`, { order: o.id });
  return c.json({ ok: true });
});

// Buyer confirms: money goes to seller
orders.post("/orders/:id/confirm", async (c) => {
  const o = await myOrder(c.req.param("id"), c.get("uid"));
  if (o.buyer_id !== c.get("uid")) throw new HttpError(403, "Only the buyer can confirm");
  if (!["held", "delivered"].includes(o.status)) throw new HttpError(400, `Order is ${o.status}`);
  const { error } = await admin.rpc("release_order", { p_order: o.id });
  if (error) throw new HttpError(500, error.message);
  return c.json({ ok: true });
});

// Seller cancels: buyer is fully refunded
orders.post("/orders/:id/cancel", async (c) => {
  const o = await myOrder(c.req.param("id"), c.get("uid"));
  if (o.seller_id !== c.get("uid")) throw new HttpError(403, "Only the seller can cancel");
  if (o.status !== "held") throw new HttpError(400, `Order is ${o.status}`);
  const { error } = await admin.rpc("refund_order", { p_order: o.id });
  if (error) throw new HttpError(500, error.message);
  await notify(o.buyer_id, "order_cancelled", "Order cancelled", "The seller cancelled. You have been refunded.", { order: o.id });
  return c.json({ ok: true });
});

orders.post("/orders/:id/dispute", async (c) => {
  const uid = c.get("uid");
  const o = await myOrder(c.req.param("id"), uid);
  const b = await parseBody(c, z.object({ reason: z.string().min(10).max(2000) }));
  if (!["held", "delivered"].includes(o.status)) throw new HttpError(400, `Order is ${o.status}`);
  const { data, error } = await admin.from("disputes").insert({ order_id: o.id, opened_by: uid, reason: b.reason }).select("id").single();
  if (error) throw new HttpError(400, error.message);
  await admin.from("orders").update({ status: "disputed", auto_release_at: null }).eq("id", o.id);
  await notify(uid === o.buyer_id ? o.seller_id : o.buyer_id, "dispute_opened", "A dispute was opened", "Support will review. You can add evidence.", { dispute: data.id, order: o.id });
  await audit(uid, "dispute.opened", data.id);
  return c.json({ id: data.id }, 201);
});

orders.post("/disputes/:id/evidence", async (c) => {
  const uid = c.get("uid");
  const b = await parseBody(c, z.object({ path: z.string(), note: z.string().max(1000).optional() }));
  if (!b.path.startsWith(uid + "/")) throw new HttpError(400, "File must be in your own folder");
  const { data: d } = await admin.from("disputes").select("id, status, order_id").eq("id", c.req.param("id")).maybeSingle();
  if (!d) throw new HttpError(404, "Dispute not found");
  await myOrder(d.order_id, uid); // must be a party
  if (!["open", "under_review"].includes(d.status)) throw new HttpError(400, "Dispute is closed");
  await admin.from("dispute_evidence").insert({ dispute_id: d.id, uploaded_by: uid, path: b.path, note: b.note });
  return c.json({ ok: true }, 201);
});

// ---------- pre-order bookings ----------
orders.post("/bookings", async (c) => {
  const p = c.get("profile");
  const b = await parseBody(c, z.object({
    post_id: z.string().uuid(), event_at: z.string().datetime(), quantity: z.number().int().min(1).max(10000),
    pay: z.enum(["deposit", "full"]).default("deposit"), note: z.string().max(1000).optional(), pin: pinSchema,
  }));
  await checkPin(p, b.pin);
  const post = await visiblePost(b.post_id);
  if (post.type !== "booking") throw new HttpError(400, "This post does not take bookings");
  const when = new Date(b.event_at);
  const leadHours = Number(post.booking_meta?.lead_hours ?? 24);
  if (when.getTime() < Date.now() + leadHours * 3600_000) throw new HttpError(400, `Book at least ${leadHours} hours ahead`);
  if (b.quantity < Number(post.booking_meta?.min_qty ?? 1)) throw new HttpError(400, "Quantity is below the vendor's minimum");
  const total = Number(post.price_kobo) * b.quantity;
  const depositPct = Math.min(100, Math.max(0, Number(post.booking_meta?.deposit_pct ?? 30)));
  const deposit = b.pay === "full" ? total : Math.max(1, Math.floor((total * depositPct) / 100));
  const orderId = await placeFor(p.id, post, b.quantity, deposit, { booking: true, total_kobo: total, event_at: b.event_at });
  const { data, error } = await admin.from("bookings").insert({
    post_id: post.id, vendor_snapshot: { title: post.title, price_kobo: post.price_kobo },
    buyer_id: p.id, vendor_id: post.author_id, event_at: b.event_at, quantity: b.quantity,
    total_kobo: total, deposit_kobo: deposit, note: b.note, order_id: orderId,
  }).select("id").single();
  if (error) throw new HttpError(500, error.message);
  await notify(post.author_id, "booking_request", "New booking request", `${p.full_name || "A buyer"} wants "${post.title}" on ${when.toDateString()}.`, { booking: data.id });
  return c.json({ id: data.id, order_id: orderId, deposit_kobo: deposit, total_kobo: total }, 201);
});

orders.get("/bookings", async (c) => {
  const uid = c.get("uid");
  const { data } = await admin.from("bookings").select("*").or(`buyer_id.eq.${uid},vendor_id.eq.${uid}`).order("event_at", { ascending: false }).limit(100);
  return c.json({ bookings: data ?? [] });
});

orders.post("/bookings/:id/respond", async (c) => {
  const uid = c.get("uid");
  const { accept } = await parseBody(c, z.object({ accept: z.boolean() }));
  const { data: bk } = await admin.from("bookings").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!bk || bk.vendor_id !== uid) throw new HttpError(404, "Booking not found");
  if (bk.status !== "requested") throw new HttpError(400, `Booking is ${bk.status}`);
  if (accept) {
    await admin.from("bookings").update({ status: "accepted" }).eq("id", bk.id);
  } else {
    await admin.rpc("refund_order", { p_order: bk.order_id });
    await admin.from("bookings").update({ status: "declined" }).eq("id", bk.id);
  }
  await notify(bk.buyer_id, accept ? "booking_accepted" : "booking_declined", accept ? "Booking accepted" : "Booking declined", accept ? "Your deposit is held safely until the order is fulfilled." : "The vendor declined. You have been refunded.", { booking: bk.id });
  return c.json({ ok: true });
});

// Vendor marks the booking fulfilled -> buyer confirms (or auto-release after the window)
orders.post("/bookings/:id/fulfil", async (c) => {
  const uid = c.get("uid");
  const { data: bk } = await admin.from("bookings").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!bk || bk.vendor_id !== uid) throw new HttpError(404, "Booking not found");
  if (bk.status !== "accepted") throw new HttpError(400, `Booking is ${bk.status}`);
  const hours = (await getSetting("escrow")).auto_release_hours as number;
  await admin.from("orders").update({
    status: "delivered", delivered_at: new Date().toISOString(),
    auto_release_at: new Date(Date.now() + hours * 3600_000).toISOString(),
  }).eq("id", bk.order_id).eq("status", "held");
  await admin.from("bookings").update({ status: "fulfilled" }).eq("id", bk.id);
  await notify(bk.buyer_id, "order_delivered", "Booking fulfilled?", "Confirm to release the payment, or open a dispute.", { order: bk.order_id });
  return c.json({ ok: true });
});

export const market = newRouter();
const PLATFORM = "00000000-0000-0000-0000-000000000001";

market.post("/boosts", async (c) => {
  const p = c.get("profile");
  const b = await parseBody(c, z.object({ post_id: z.string().uuid(), hours: z.number().int(), pin: pinSchema }));
  await checkPin(p, b.pin);
  const prices = await getSetting<Record<string, number>>("boost_prices");
  const base = prices[String(b.hours)];
  const price = base && (p.tier === "pro" || p.tier === "premium") ? Math.floor(base / 2) : base;
  if (!price) throw new HttpError(400, `Choose one of: ${Object.keys(prices).join(", ")} hours`);
  const { data: post } = await admin.from("posts").select("id, author_id, promoted_until").eq("id", b.post_id).maybeSingle();
  if (!post || post.author_id !== p.id) throw new HttpError(404, "Post not found");
  const id = crypto.randomUUID();
  const { error } = await admin.rpc("ledger_post", { p_user: p.id, p_amount: -price, p_kind: "boost", p_ref: post.id, p_idem: `boost:${id}` });
  if (error) throw new HttpError(400, "Insufficient wallet balance");
  await admin.rpc("ledger_post", { p_user: PLATFORM, p_amount: price, p_kind: "boost", p_ref: post.id, p_idem: `boost-in:${id}` });
  const start = post.promoted_until && new Date(post.promoted_until) > new Date() ? new Date(post.promoted_until) : new Date();
  const ends = new Date(start.getTime() + b.hours * 3600_000);
  await admin.from("boosts").insert({ post_id: post.id, user_id: p.id, hours: b.hours, price_kobo: price, starts_at: start.toISOString(), ends_at: ends.toISOString() });
  await admin.from("posts").update({ promoted_until: ends.toISOString() }).eq("id", post.id);
  return c.json({ promoted_until: ends.toISOString() });
});

// Vendor tier, paid monthly from the wallet
market.post("/tier", async (c) => {
  const p = c.get("profile");
  const b = await parseBody(c, z.object({ tier: z.enum(["free", "pro", "premium"]), pin: pinSchema }));
  if (b.tier === "free") {
    await admin.from("profiles").update({ tier: "free", tier_expires_at: null }).eq("id", p.id);
    return c.json({ tier: "free" });
  }
  await checkPin(p, b.pin);
  const price = (await getSetting<Record<string, number>>("vendor_tiers"))[b.tier];
  const id = crypto.randomUUID();
  const { error } = await admin.rpc("ledger_post", { p_user: p.id, p_amount: -price, p_kind: "tier", p_ref: b.tier, p_idem: `tier:${id}` });
  if (error) throw new HttpError(400, "Insufficient wallet balance");
  await admin.rpc("ledger_post", { p_user: PLATFORM, p_amount: price, p_kind: "tier", p_ref: b.tier, p_idem: `tier-in:${id}` });
  const expires = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
  await admin.from("profiles").update({ tier: b.tier, tier_expires_at: expires }).eq("id", p.id);
  return c.json({ tier: b.tier, expires_at: expires });
});

export const adminRoutes = newRouter();

type Role = "super_admin" | "verification_reviewer" | "support" | "finance";
const PERMS: Record<string, Role[]> = {
  verification: ["super_admin", "verification_reviewer"],
  disputes: ["super_admin", "support"],
  users: ["super_admin", "support", "verification_reviewer"],
  finance: ["super_admin", "finance"],
  super: ["super_admin"],
  broadcast: ["super_admin", "support"],
};

// Every /admin/* request must come from someone in admin_users with a suitable role.
adminRoutes.use("/admin/*", async (c, next) => {
  const { data } = await admin.from("admin_users").select("role").eq("user_id", c.get("uid")).maybeSingle();
  if (!data) throw new HttpError(403, "Not an admin");
  c.set("adminRole", data.role);
  await next();
});
function need(c: any, area: keyof typeof PERMS) {
  const role = c.get("adminRole") as Role;
  if (!PERMS[area].includes(role)) throw new HttpError(403, "Your admin role cannot do this");
  return role;
}

// ----- broadcasts (scrolling notice shown to everyone in the app) -----
adminRoutes.get("/admin/broadcasts", async (c) => {
  need(c, "broadcast");
  const { data } = await admin.from("broadcasts").select("*").order("created_at", { ascending: false }).limit(50);
  return c.json({ broadcasts: data ?? [] });
});
adminRoutes.post("/admin/broadcasts", async (c) => {
  need(c, "broadcast");
  const b = await parseBody(c, z.object({
    message: z.string().trim().min(3).max(400),
    audience: z.enum(["all", "buyer", "vendor", "rider", "artisan"]).default("all"),
    hours: z.number().int().min(1).max(168).default(24),
  }));
  const { data, error } = await admin.from("broadcasts").insert({
    message: b.message, audience: b.audience, created_by: c.get("uid"),
    ends_at: new Date(Date.now() + b.hours * 3600_000).toISOString(),
  }).select("id").single();
  if (error) throw new HttpError(400, error.message);
  await audit(c.get("uid"), "broadcast.sent", data.id, { audience: b.audience, hours: b.hours });
  return c.json({ id: data.id }, 201);
});
adminRoutes.delete("/admin/broadcasts/:id", async (c) => {
  need(c, "broadcast");
  await admin.from("broadcasts").update({ active: false }).eq("id", c.req.param("id"));
  await audit(c.get("uid"), "broadcast.stopped", c.req.param("id"), {});
  return c.json({ ok: true });
});

// ----- verification -----
adminRoutes.get("/admin/verifications", async (c) => {
  need(c, "verification");
  const status = c.req.query("status") ?? "pending";
  const { data } = await admin.from("verification_requests")
    .select("id, kind, status, document_path, selfie_path, created_at, user_id, profiles(full_name, phone, email, role)")
    .eq("status", status).order("created_at").limit(100);
  const out = [];
  for (const r of data ?? []) {
    const sign = async (p: string | null) =>
      p ? (await admin.storage.from("kyc-docs").createSignedUrl(p, 600)).data?.signedUrl ?? null : null; // 10 min links
    out.push({
      ...r, document_url: await sign(r.document_path), selfie_url: await sign(r.selfie_path),
      document_number: await (async () => {
        const { data: full } = await admin.from("verification_requests").select("document_number_encrypted").eq("id", r.id).single();
        return full?.document_number_encrypted ? await decrypt(full.document_number_encrypted) : null;
      })(),
    });
  }
  return c.json({ requests: out });
});

adminRoutes.post("/admin/verifications/:id/review", async (c) => {
  const role = need(c, "verification");
  const b = await parseBody(c, z.object({ approve: z.boolean(), reason: z.string().max(500).optional(), valid_days: z.number().int().min(1).optional() }));
  if (!b.approve && !b.reason) throw new HttpError(400, "A reason is required when rejecting");
  const { data: r } = await admin.from("verification_requests").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!r || r.status !== "pending") throw new HttpError(404, "No pending request");
  const now = new Date().toISOString();
  await admin.from("verification_requests").update({
    status: b.approve ? "approved" : "rejected", reviewer_id: c.get("uid"), reviewed_at: now, reject_reason: b.reason ?? null,
    expires_at: b.approve && b.valid_days ? new Date(Date.now() + b.valid_days * 86400_000).toISOString() : null,
  }).eq("id", r.id);
  if (b.approve) await admin.from("profiles").update({ verified: true, verified_kind: r.kind, verified_at: now }).eq("id", r.user_id);
  await notify(r.user_id, b.approve ? "verified" : "verification_rejected",
    b.approve ? "You are verified" : "Verification not approved",
    b.approve ? "Your blue tick is now live and your limits are higher." : `Reason: ${b.reason}`, {});
  await audit(c.get("uid"), b.approve ? "verification.approved" : "verification.rejected", r.id, { role, reason: b.reason });
  return c.json({ ok: true });
});

adminRoutes.post("/admin/users/:id/revoke-verification", async (c) => {
  need(c, "verification");
  const { reason } = await parseBody(c, z.object({ reason: z.string().min(3).max(500) }));
  const id = c.req.param("id");
  await admin.from("profiles").update({ verified: false, verified_kind: null, verified_at: null }).eq("id", id);
  await admin.from("verification_requests").update({ status: "revoked" }).eq("user_id", id).eq("status", "approved");
  // open food posts lose their "leave open" privilege: 8h countdown from now
  await admin.from("posts").update({ retention: "delete_24h", next_reminder_at: null, closes_at: new Date(Date.now() + 8 * 3600_000).toISOString(), expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(), warn4_sent: false, warn6_sent: false })
    .eq("author_id", id).eq("type", "food").eq("retention", "open");
  await notify(id, "verification_revoked", "Verification removed", reason, {});
  await audit(c.get("uid"), "verification.revoked", id, { reason });
  return c.json({ ok: true });
});

// ----- rider / artisan applications -----
adminRoutes.get("/admin/role-applications", async (c) => {
  need(c, "verification");
  const { data } = await admin.from("role_applications").select("*, profiles(full_name, phone)").eq("status", "pending").order("created_at").limit(100);
  return c.json({ applications: data ?? [] });
});
adminRoutes.post("/admin/role-applications/:id/review", async (c) => {
  need(c, "verification");
  const b = await parseBody(c, z.object({ approve: z.boolean(), reason: z.string().max(500).optional() }));
  const { data: a } = await admin.from("role_applications").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!a || a.status !== "pending") throw new HttpError(404, "No pending application");
  await admin.from("role_applications").update({ status: b.approve ? "approved" : "rejected", reviewer_id: c.get("uid"), reviewed_at: new Date().toISOString(), reject_reason: b.reason ?? null }).eq("id", a.id);
  if (b.approve) await admin.from("profiles").update({ role: a.role, role_changes: 2 }).eq("id", a.user_id);
  await notify(a.user_id, "role_application", b.approve ? "Application approved" : "Application declined", b.approve ? `You are now a ${a.role}.` : (b.reason ?? ""), {});
  await audit(c.get("uid"), "role_application.review", a.id, { approve: b.approve });
  return c.json({ ok: true });
});

// ----- disputes -----
adminRoutes.get("/admin/disputes", async (c) => {
  need(c, "disputes");
  const { data } = await admin.from("disputes").select("*, orders(*), dispute_evidence(*)").in("status", ["open", "under_review"]).order("created_at").limit(100);
  const out = [];
  for (const d of data ?? []) {
    const ev = [];
    for (const e of d.dispute_evidence ?? []) {
      ev.push({ ...e, url: (await admin.storage.from("dispute-evidence").createSignedUrl(e.path, 600)).data?.signedUrl ?? null });
    }
    out.push({ ...d, dispute_evidence: ev });
  }
  return c.json({ disputes: out });
});

adminRoutes.post("/admin/disputes/:id/resolve", async (c) => {
  need(c, "disputes");
  const b = await parseBody(c, z.object({ outcome: z.enum(["buyer", "seller"]), note: z.string().min(3).max(2000) }));
  const { data: d } = await admin.from("disputes").select("*, orders(*)").eq("id", c.req.param("id")).maybeSingle();
  if (!d || !["open", "under_review"].includes(d.status)) throw new HttpError(404, "No open dispute");
  const rpc = b.outcome === "buyer" ? "refund_order" : "release_order";
  // release_order only accepts held/delivered, so put the order back before releasing
  if (b.outcome === "seller") await admin.from("orders").update({ status: "delivered" }).eq("id", d.order_id);
  const { error } = await admin.rpc(rpc, { p_order: d.order_id });
  if (error) throw new HttpError(500, error.message);
  await admin.from("disputes").update({
    status: b.outcome === "buyer" ? "resolved_buyer" : "resolved_seller", resolver_id: c.get("uid"),
    resolution_note: b.note, resolved_at: new Date().toISOString(),
  }).eq("id", d.id);
  for (const u of [d.orders.buyer_id, d.orders.seller_id]) {
    await notify(u, "dispute_resolved", "Dispute resolved", `Decision in favour of the ${b.outcome}. ${b.note}`, { dispute: d.id });
  }
  await audit(c.get("uid"), "dispute.resolved", d.id, { outcome: b.outcome });
  return c.json({ ok: true });
});

// ----- users -----
adminRoutes.get("/admin/users", async (c) => {
  need(c, "users");
  const q = (c.req.query("q") ?? "").replace(/[%,()]/g, "").trim();
  let query = admin.from("profiles").select("id, full_name, phone, email, role, verified, status, tier, created_at").order("created_at", { ascending: false }).limit(50);
  if (q) query = query.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`);
  const { data } = await query;
  return c.json({ users: data ?? [] });
});
adminRoutes.post("/admin/users/:id/status", async (c) => {
  need(c, "users");
  const b = await parseBody(c, z.object({ status: z.enum(["active", "suspended"]), reason: z.string().max(500).optional() }));
  await admin.from("profiles").update({ status: b.status, suspended_reason: b.reason ?? null }).eq("id", c.req.param("id"));
  await notify(c.req.param("id"), "account_status", b.status === "suspended" ? "Account suspended" : "Account restored", b.reason ?? "", {});
  await audit(c.get("uid"), `user.${b.status}`, c.req.param("id"), { reason: b.reason });
  return c.json({ ok: true });
});

// ----- finance -----
adminRoutes.get("/admin/finance/summary", async (c) => {
  need(c, "finance");
  const [{ data: wallets }, { count: pendingWd }, { count: openDisputes }] = await Promise.all([
    admin.from("wallets").select("user_id, balance_kobo"),
    admin.from("withdrawals").select("id", { count: "exact", head: true }).eq("status", "pending"),
    admin.from("disputes").select("id", { count: "exact", head: true }).in("status", ["open", "under_review"]),
  ]);
  const sum = (f: (w: any) => boolean) => (wallets ?? []).filter(f).reduce((s: number, w: any) => s + Number(w.balance_kobo), 0);
  return c.json({
    user_balances_kobo: sum((w) => !w.user_id.startsWith("00000000-0000-0000-0000-00000000000")),
    escrow_held_kobo: sum((w) => w.user_id === "00000000-0000-0000-0000-000000000002"),
    platform_fees_kobo: sum((w) => w.user_id === "00000000-0000-0000-0000-000000000001"),
    pending_withdrawals: pendingWd ?? 0, open_disputes: openDisputes ?? 0,
  });
});
adminRoutes.get("/admin/finance/withdrawals", async (c) => {
  need(c, "finance");
  const { data } = await admin.from("withdrawals").select("*").order("created_at", { ascending: false }).limit(100);
  return c.json({ withdrawals: data ?? [] });
});

// ----- admin team (super admin only) -----
adminRoutes.post("/admin/team", async (c) => {
  need(c, "super");
  const b = await parseBody(c, z.object({ user_id: z.string().uuid(), role: z.enum(["super_admin", "verification_reviewer", "support", "finance"]).nullable() }));
  if (b.role) await admin.from("admin_users").upsert({ user_id: b.user_id, role: b.role });
  else await admin.from("admin_users").delete().eq("user_id", b.user_id);
  await audit(c.get("uid"), "admin.team", b.user_id, { role: b.role });
  return c.json({ ok: true });
});
adminRoutes.get("/admin/audit", async (c) => {
  need(c, "super");
  const { data } = await admin.from("audit_log").select("*").order("id", { ascending: false }).limit(200);
  return c.json({ entries: data ?? [] });
});

// supabase/functions/api/partners.ts
// Ratings (one per completed order), partner rating stats, rider delivery jobs, my disputes, push subscriptions.

export const partners = newRouter();

// ---------- ratings ----------
// Only the customer of a delivered/released order can rate, once per order, never themselves.
partners.post("/orders/:id/review", async (c) => {
  const uid = c.get("uid");
  const b = await parseBody(c, z.object({ stars: z.number().int().min(1).max(5), comment: z.string().trim().min(3, "Please write a short comment").max(500) }));
  const { data: o } = await admin.from("orders").select("id, buyer_id, seller_id, post_id, status").eq("id", c.req.param("id")).maybeSingle();
  if (!o || o.buyer_id !== uid) throw new HttpError(404, "Order not found");
  if (!["delivered", "released"].includes(o.status)) throw new HttpError(400, "You can rate after the order is delivered");
  if (o.seller_id === uid) throw new HttpError(400, "You cannot rate yourself");
  const { error } = await admin.from("reviews").insert({
    order_id: o.id, partner_id: o.seller_id, customer_id: uid, post_id: o.post_id, stars: b.stars, comment: b.comment || null,
  });
  if (error) throw new HttpError(400, error.code === "23505" ? "This order has already been rated" : error.message);
  await notify(o.seller_id, "new_rating", "New rating", `You received a ${b.stars}-star rating.`, { order: o.id });
  return c.json({ ok: true }, 201);
});

// Orders I can still rate (delivered/released and not yet rated), for the reminder
partners.get("/reviews/pending", async (c) => {
  const uid = c.get("uid");
  const { data: os } = await admin.from("orders").select("id, seller_id, post_id, item_snapshot").eq("buyer_id", uid).in("status", ["delivered", "released"]).limit(50);
  const ids = (os ?? []).map((o: any) => o.id);
  const { data: done } = ids.length ? await admin.from("reviews").select("order_id").in("order_id", ids) : { data: [] };
  const rated = new Set((done ?? []).map((r: any) => r.order_id));
  return c.json({ pending: (os ?? []).filter((o: any) => !rated.has(o.id)) });
});

// Everyone's true rating (average, count, 5..1 breakdown, completed orders)
partners.get("/partners/stats", async (c) => {
  const { data } = await admin.from("partner_stats").select("*");
  const stats: Record<string, unknown> = {};
  for (const r of data ?? []) {
    stats[r.partner_id] = { avg: Number(r.avg_stars), count: r.ratings, orders: r.completed_orders, dist: [0, r.s1, r.s2, r.s3, r.s4, r.s5] };
  }
  return c.json({ stats });
});

partners.get("/partners/:id/reviews", async (c) => {
  const { data } = await admin.from("reviews").select("id, stars, comment, reply, reply_at, created_at, customer_id, post_id").eq("partner_id", c.req.param("id")).order("created_at", { ascending: false }).limit(50);
  const ids = [...new Set((data ?? []).map((r: any) => r.customer_id))];
  const { data: profs } = ids.length ? await admin.from("public_profiles").select("id, full_name").in("id", ids) : { data: [] };
  const name = new Map((profs ?? []).map((p: any) => [p.id, p.full_name]));
  return c.json({ reviews: (data ?? []).map((r: any) => ({ ...r, customer_name: name.get(r.customer_id) ?? "Customer" })) });
});

// ---------- my disputes ----------
partners.get("/disputes", async (c) => {
  const uid = c.get("uid");
  const { data: os } = await admin.from("orders").select("id").or(`buyer_id.eq.${uid},seller_id.eq.${uid}`);
  const ids = (os ?? []).map((o: any) => o.id);
  if (!ids.length) return c.json({ disputes: [] });
  const { data } = await admin.from("disputes").select("*, dispute_evidence(id, path, note, created_at), dispute_messages(id, user_id, body, created_at), orders(item_snapshot, amount_kobo, buyer_id, seller_id, status)").in("order_id", ids).order("created_at", { ascending: false });
  const out: any[] = [];
  for (const d of data ?? []) {
    const ev: any[] = [];
    for (const e of (d as any).dispute_evidence ?? []) ev.push({ ...e, url: (await admin.storage.from("dispute-evidence").createSignedUrl(e.path, 3600)).data?.signedUrl ?? null });
    out.push({ ...d, dispute_evidence: ev });
  }
  return c.json({ disputes: out });
});


// ---------- dispute thread: messages, evidence links, withdraw ----------
async function myDispute(id: string, uid: string) {
  const { data: d } = await admin.from("disputes").select("*").eq("id", id).maybeSingle();
  if (!d) throw new HttpError(404, "Dispute not found");
  const { data: o } = await admin.from("orders").select("id, buyer_id, seller_id, status").eq("id", d.order_id).maybeSingle();
  if (!o || (o.buyer_id !== uid && o.seller_id !== uid)) throw new HttpError(404, "Dispute not found");
  return { d, o };
}
partners.post("/disputes/:id/messages", async (c) => {
  const uid = c.get("uid");
  const b = await parseBody(c, z.object({ body: z.string().trim().min(1).max(2000) }));
  const { d, o } = await myDispute(c.req.param("id"), uid);
  if (!["open", "under_review"].includes(d.status)) throw new HttpError(400, "This dispute is closed");
  await admin.from("dispute_messages").insert({ dispute_id: d.id, user_id: uid, body: b.body });
  await notify(uid === o.buyer_id ? o.seller_id : o.buyer_id, "dispute_message", "New message on a dispute", b.body.slice(0, 120), { dispute: d.id, order: o.id });
  return c.json({ ok: true }, 201);
});
partners.post("/disputes/:id/withdraw", async (c) => {
  const uid = c.get("uid");
  const { d, o } = await myDispute(c.req.param("id"), uid);
  if (d.opened_by !== uid) throw new HttpError(403, "Only the person who opened the dispute can withdraw it");
  if (d.status !== "open") throw new HttpError(400, "Support is already reviewing this dispute");
  const hours = ((await getSetting("escrow")).auto_release_hours as number) ?? 48;
  await admin.from("disputes").update({ status: "closed", resolution_note: "Withdrawn by the customer", resolved_at: new Date().toISOString() }).eq("id", d.id);
  await admin.from("orders").update({ status: "delivered", auto_release_at: new Date(Date.now() + hours * 3600_000).toISOString() }).eq("id", o.id);
  await notify(uid === o.buyer_id ? o.seller_id : o.buyer_id, "dispute_withdrawn", "Dispute withdrawn", "The dispute was withdrawn. The order continues as normal.", { dispute: d.id, order: o.id });
  await audit(uid, "dispute.withdrawn", d.id);
  return c.json({ ok: true });
});

// ---------- Partner replies to a review ----------
partners.post("/reviews/:id/reply", async (c) => {
  const uid = c.get("uid");
  const b = await parseBody(c, z.object({ reply: z.string().trim().min(2).max(500) }));
  const { data: r } = await admin.from("reviews").select("id, partner_id, customer_id, reply").eq("id", c.req.param("id")).maybeSingle();
  if (!r || r.partner_id !== uid) throw new HttpError(404, "Review not found");
  if (r.reply) throw new HttpError(400, "You already replied to this review");
  await admin.from("reviews").update({ reply: b.reply, reply_at: new Date().toISOString() }).eq("id", r.id);
  await notify(r.customer_id, "review_reply", "A Partner replied to your review", b.reply.slice(0, 120), { review: r.id });
  return c.json({ ok: true });
});

// ---------- rider delivery ----------
async function riderBps(): Promise<number> {
  const { data } = await admin.from("app_settings").select("value").eq("key", "escrow").maybeSingle();
  return Number(data?.value?.rider_fee_bps ?? 1000);
}
function needRider(c: any) {
  if (c.get("profile").role !== "rider") throw new HttpError(403, "Only riders can do this");
}
// Paid orders with a delivery address and no rider yet
partners.get("/rider/jobs", async (c) => {
  needRider(c);
  const { data } = await admin.from("orders").select("id, item_snapshot, delivery_address, delivery_fee_kobo, note, created_at, seller_id")
    .eq("status", "held").is("rider_id", null).not("delivery_address", "is", null).order("created_at", { ascending: false }).limit(50);
  const bps = await riderBps();
  return c.json({ fee_bps: bps, jobs: (data ?? []).map((j: any) => ({ ...j, earn_kobo: j.delivery_fee_kobo - Math.floor(j.delivery_fee_kobo * bps / 10000) })) });
});
partners.get("/rider/mine", async (c) => {
  needRider(c);
  const { data } = await admin.from("orders").select("id, item_snapshot, delivery_address, delivery_fee_kobo, delivery_status, rider_accepted_at, rider_delivered_at, buyer_id, seller_id, status")
    .eq("rider_id", c.get("uid")).order("rider_accepted_at", { ascending: false }).limit(100);
  const bps = await riderBps();
  return c.json({ fee_bps: bps, jobs: (data ?? []).map((j: any) => ({ ...j, earn_kobo: j.delivery_fee_kobo - Math.floor(j.delivery_fee_kobo * bps / 10000) })) });
});
// Rider earnings: paid when the customer confirms (or auto-release), net of EMEMART's rider fee
partners.get("/rider/earnings", async (c) => {
  needRider(c);
  const { data } = await admin.from("ledger_entries").select("amount_kobo, created_at, meta").eq("user_id", c.get("uid")).eq("kind", "escrow_release").order("created_at", { ascending: false }).limit(500);
  const rows = (data ?? []).filter((r: any) => r.meta?.role === "rider");
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const week = Date.now() - 7 * 86400_000;
  const sum = (f: (r: any) => boolean) => rows.filter(f).reduce((s: number, r: any) => s + Number(r.amount_kobo), 0);
  const { count: pending } = await admin.from("orders").select("id", { count: "exact", head: true }).eq("rider_id", c.get("uid")).eq("delivery_status", "delivered").neq("status", "released");
  return c.json({
    today_kobo: sum((r) => new Date(r.created_at) >= day), week_kobo: sum((r) => new Date(r.created_at).getTime() >= week),
    total_kobo: sum(() => true), paid_count: rows.length, awaiting_confirmation: pending ?? 0,
  });
});
// Rider changes their mind before pickup: the job goes back to the pool
partners.post("/rider/jobs/:id/drop", async (c) => {
  needRider(c);
  const { data } = await admin.from("orders").update({ rider_id: null, delivery_status: null, rider_accepted_at: null })
    .eq("id", c.req.param("id")).eq("rider_id", c.get("uid")).eq("delivery_status", "accepted").select("id").maybeSingle();
  if (!data) throw new HttpError(400, "You can only drop a job before pickup");
  return c.json({ ok: true });
});
partners.post("/rider/jobs/:id/accept", async (c) => {
  needRider(c);
  // The "rider_id is null" condition makes this safe when two riders tap at the same time.
  const { data, error } = await admin.from("orders").update({ rider_id: c.get("uid"), delivery_status: "accepted", rider_accepted_at: new Date().toISOString() })
    .eq("id", c.req.param("id")).eq("status", "held").is("rider_id", null).select("id, buyer_id, seller_id").maybeSingle();
  if (error) throw new HttpError(400, error.message);
  if (!data) throw new HttpError(409, "Another rider already took this job");
  await notify(data.buyer_id, "rider_assigned", "Rider on the way", "A rider accepted your delivery.", { order: data.id });
  await notify(data.seller_id, "rider_assigned", "Rider assigned", "A rider will pick up the order.", { order: data.id });
  return c.json({ ok: true });
});
partners.post("/rider/jobs/:id/status", async (c) => {
  needRider(c);
  const b = await parseBody(c, z.object({ status: z.enum(["picked_up", "on_the_way", "delivered"]) }));
  const { data: o } = await admin.from("orders").select("id, buyer_id, seller_id, rider_id").eq("id", c.req.param("id")).maybeSingle();
  if (!o || o.rider_id !== c.get("uid")) throw new HttpError(404, "Job not found");
  const patch: Record<string, unknown> = { delivery_status: b.status };
  if (b.status === "delivered") patch.rider_delivered_at = new Date().toISOString();
  await admin.from("orders").update(patch).eq("id", o.id);
  const text = { picked_up: "Your order was picked up.", on_the_way: "Your rider is on the way.", delivered: "The rider marked your order as delivered. Please confirm in the app." }[b.status];
  await notify(o.buyer_id, "delivery_" + b.status, "Delivery update", text, { order: o.id });
  await audit(c.get("uid"), "rider." + b.status, o.id);
  return c.json({ ok: true });
});


// ---------- order tracking: seller moves the order along ----------
const PREP_STEPS = ["placed", "accepted", "preparing", "ready", "on_the_way"];
partners.post("/orders/:id/progress", async (c) => {
  const uid = c.get("uid");
  const b = await parseBody(c, z.object({ step: z.enum(["accepted", "preparing", "ready", "on_the_way"]) }));
  const { data: o } = await admin.from("orders").select("id, buyer_id, seller_id, rider_id, status, prep_status, prep_log").eq("id", c.req.param("id")).maybeSingle();
  if (!o || o.seller_id !== uid) throw new HttpError(404, "Order not found");
  if (o.status !== "held") throw new HttpError(400, `Order is ${o.status}`);
  const cur = PREP_STEPS.indexOf(o.prep_status ?? "placed"), next = PREP_STEPS.indexOf(b.step);
  if (next <= cur) throw new HttpError(400, "That step is already done");
  if (next > cur + 1) throw new HttpError(400, "Please follow the steps in order");
  if (b.step === "on_the_way" && o.rider_id) throw new HttpError(400, "A rider is assigned and will collect this order");
  const log = Array.isArray(o.prep_log) ? o.prep_log : [];
  log.push({ step: b.step, ts: new Date().toISOString() });
  const patch: Record<string, unknown> = { prep_status: b.step, prep_log: log };
  if (b.step === "on_the_way") patch.delivery_status = "on_the_way";
  await admin.from("orders").update(patch).eq("id", o.id);
  const text: Record<string, string> = {
    accepted: "The Partner accepted your order.", preparing: "Your order is being prepared.",
    ready: "Your order is ready.", on_the_way: "Your order is on the way.",
  };
  await notify(o.buyer_id, "order_" + b.step, "Order update", text[b.step], { order: o.id });
  await audit(uid, "order." + b.step, o.id);
  return c.json({ ok: true, step: b.step });
});

// ---------- push subscriptions ----------
partners.post("/push/subscribe", async (c) => {
  const b = await parseBody(c, z.object({ endpoint: z.string().url(), p256dh: z.string(), auth: z.string() }));
  await admin.from("push_subscriptions").upsert({ user_id: c.get("uid"), endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth }, { onConflict: "endpoint" });
  return c.json({ ok: true }, 201);
});
partners.post("/push/unsubscribe", async (c) => {
  const b = await parseBody(c, z.object({ endpoint: z.string() }));
  await admin.from("push_subscriptions").delete().eq("endpoint", b.endpoint).eq("user_id", c.get("uid"));
  return c.json({ ok: true });
});

// ----- fake reviews: admins can delete a review, never edit a rating -----
adminRoutes.delete("/admin/reviews/:id", async (c) => {
  need(c, "users");
  const { error } = await admin.from("reviews").delete().eq("id", c.req.param("id"));
  if (error) throw new HttpError(400, error.message);
  await audit(c.get("uid"), "review.deleted", c.req.param("id"), {});
  return c.json({ ok: true });
});

const app = new Hono<AppEnv>().basePath("/api");

app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  await next();
  for (const [k, v] of Object.entries(corsHeaders)) c.res.headers.set(k, v);
});

app.get("/health", (c) => c.json({ ok: true }));

// Everything below needs a signed-in, non-suspended user.
app.use("*", async (c, next) => {
  if (c.req.path.endsWith("/health")) return next();
  const token = c.req.header("Authorization")?.replace(/^Bearer /i, "");
  if (!token) throw new HttpError(401, "Not signed in");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Session expired. Sign in again.");
  const { data: profile } = await admin.from("profiles").select("*").eq("id", data.user.id).single();
  if (!profile) throw new HttpError(403, "Profile missing");
  if ((profile as Profile).status !== "active") throw new HttpError(403, "Account suspended");
  c.set("uid", data.user.id);
  c.set("email", data.user.email ?? null);
  c.set("profile", profile as Profile);
  await next();
});

app.route("/", me);
app.route("/", wallet);
app.route("/", orders);
app.route("/", market);
app.route("/", partners);
app.route("/", adminRoutes);

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err); // visible in Supabase function logs; never leaked to the client
  return c.json({ error: "Something went wrong" }, 500);
});
app.notFound((c) => c.json({ error: "Not found" }, 404));

Deno.serve(app.fetch);
