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
  await admin.from("notifications").insert({ user_id: userId, kind, title, body, data });
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
  const [{ data: wallet }, { data: adm }] = await Promise.all([
    admin.from("wallets").select("balance_kobo").eq("user_id", p.id).single(),
    admin.from("admin_users").select("role").eq("user_id", p.id).maybeSingle(),
  ]);
  const { pin_hash, pin_failed, pin_locked_until, ...safe } = p;
  return c.json({ profile: safe, has_pin: !!pin_hash, balance_kobo: wallet?.balance_kobo ?? 0, admin_role: adm?.role ?? null });
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

me.post("/me/role-application", async (c) => {
  const p = c.get("profile");
  const b = await parseBody(c, z.object({ role: z.enum(["rider", "artisan"]), details: z.record(z.unknown()).default({}) }));
  const { data: open } = await admin.from("role_applications").select("id")
    .eq("user_id", p.id).eq("role", b.role).eq("status", "pending").maybeSingle();
  if (open) throw new HttpError(409, "You already have a pending application");
  const { data, error } = await admin.from("role_applications").insert({ user_id: p.id, role: b.role, details: b.details }).select("id").single();
  if (error) throw new HttpError(400, error.message);
  return c.json({ id: data.id }, 201);
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

wallet.post("/wallet/lookup", async (c) => {
  const b = await parseBody(c, z.object({ bank_code: z.string().min(3).max(8), account_number: z.string().regex(/^\d{10}$/) }));
  try { return c.json({ account_name: await lookupAccount(b.bank_code, b.account_number) }); }
  catch { throw new HttpError(404, "Account not found"); }
});

wallet.post("/wallet/withdraw", async (c) => {
  const p = c.get("profile");
  if (p.country !== "NG") throw new HttpError(403, "Withdrawals are only available in Nigeria for now");
  const b = await parseBody(c, z.object({
    amount_kobo: z.number().int().min(10_000), bank_code: z.string().min(3).max(8),
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
  const price = prices[String(b.hours)];
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
  // open food posts lose their "leave open" privilege: 24h countdown from now
  await admin.from("posts").update({ retention: "delete_24h", next_reminder_at: null, expires_at: new Date(Date.now() + 24 * 3600_000).toISOString() })
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
  if (b.approve) await admin.from("profiles").update({ role: a.role }).eq("id", a.user_id);
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
app.route("/", adminRoutes);

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err); // visible in Supabase function logs; never leaked to the client
  return c.json({ error: "Something went wrong" }, 500);
});
app.notFound((c) => c.json({ error: "Not found" }, 404));

Deno.serve(app.fetch);
