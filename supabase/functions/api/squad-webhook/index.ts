// supabase/functions/squad-webhook/index.ts
// FUNCTION NAME (type this exactly in Supabase): squad-webhook
// Settings: turn Verify JWT OFF (Squad does not send a Supabase login; the HMAC signature is the authentication).
// Squad dashboard webhook URL: https://jjiiuwhybqagorygfarh.supabase.co/functions/v1/squad-webhook
// This one file is complete: it already contains the shared helper code. Paste all of it.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

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

/** Funding fee the Customer pays (set in the admin dashboard). Never more than the amount minus 1 kobo. */
export function fundingFee(cfg: any, kind: "transfer" | "checkout", amountKobo: number): number {
  const c = cfg?.[kind] ?? {};
  let fee = Math.round(amountKobo * (Number(c.percent_bps) || 0) / 10000) + (Number(c.flat_kobo) || 0);
  const cap = Number(c.cap_kobo) || 0;
  if (cap > 0 && fee > cap) fee = cap;
  return Math.max(0, Math.min(fee, amountKobo - 1));
}
export async function getFundingFees() {
  const { data } = await admin.from("app_settings").select("value").eq("key", "funding_fees").maybeSingle();
  return (data?.value ?? {}) as any;
}

/** Static virtual account for one customer. The BVN is sent to Squad and never stored by Ememart. */
export async function createVirtualAccount(p: {
  customerId: string; firstName: string; lastName: string; mobile: string; email?: string | null;
  bvn: string; dob: string; gender: string; address: string;
}) {
  const body: Record<string, unknown> = {
    customer_identifier: p.customerId, first_name: p.firstName, last_name: p.lastName, mobile_num: p.mobile,
    bvn: p.bvn, dob: p.dob, gender: p.gender, address: p.address,
  };
  if (p.email) body.email = p.email;
  const ben = Deno.env.get("SQUAD_BENEFICIARY_ACCOUNT");   // your settlement account, only if Squad asks for it
  if (ben) body.beneficiary_account = ben;
  const r = await call("POST", "/virtual-account", body);
  const d = r.data?.data;
  if (r.httpStatus !== 200 || !d?.virtual_account_number) {
    throw new Error(String(r.data?.message ?? "Could not create the account number"));
  }
  return { accountNumber: String(d.virtual_account_number), bankCode: String(d.bank_code ?? "") };
}

/** Ask Squad for this customer's transactions and find the one named in the webhook (never trust the webhook body alone). */
export async function verifyVaTransaction(customerId: string, ref: string): Promise<{ found: boolean; amountKobo: number }> {
  const r = await call("GET", `/virtual-account/customer/transactions/${encodeURIComponent(customerId)}`);
  const list: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
  const t = list.find((x) => String(x.transaction_reference) === ref && String(x.transaction_indicator ?? "C") === "C");
  if (r.httpStatus !== 200 || !t) return { found: false, amountKobo: 0 };
  return { found: true, amountKobo: Math.round(parseFloat(String(t.principal_amount)) * 100) };
}

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

// Squad calls this when a wallet-funding payment succeeds.
// Deploy WITHOUT JWT verification (Squad has no Supabase login):
//   supabase functions deploy squad-webhook --no-verify-jwt

const reply = (status: number, ref: string, msg: string) =>
  new Response(JSON.stringify({ response_code: status, transaction_reference: ref, response_description: msg }), {
    status, headers: { "Content-Type": "application/json" },
  });

// A customer paid into their own account number (static virtual account).
async function handleVirtual(evt: any, ref: string) {
  if (String(evt.transaction_indicator ?? "C") !== "C") return reply(200, ref, "Ignored");
  if (evt.meta?.freeze_transaction_ref) return reply(200, ref, "Frozen transaction, not credited");
  const acct = String(evt.virtual_account_number ?? "");
  const { data: va } = await admin.from("virtual_accounts").select("user_id").eq("account_number", acct).maybeSingle();
  if (!va) {
    await admin.from("squad_events").update({ processed: true }).eq("event_ref", ref);
    return reply(200, ref, "Not an Ememart account");
  }
  const v = await verifyVaTransaction(String(evt.customer_identifier ?? `EME_${va.user_id}`), ref);
  if (!v.found || v.amountKobo <= 0) return reply(500, ref, "Could not confirm payment yet");   // Squad will retry
  const { error } = await admin.rpc("ledger_post", {
    p_user: va.user_id, p_amount: v.amountKobo, p_kind: "funding", p_ref: ref, p_idem: `vafund:${ref}`,
  });
  if (error) { console.error(error); return reply(500, ref, "Credit failed"); }
  const fee = fundingFee(await getFundingFees(), "transfer", v.amountKobo);
  if (fee > 0) {
    const fe = await admin.rpc("ledger_post", { p_user: va.user_id, p_amount: -fee, p_kind: "fee", p_ref: ref, p_idem: `vafee:${ref}` });
    if (fe.error) { console.error(fe.error); return reply(500, ref, "Fee failed"); }   // Squad retries; the credit above is not repeated
  }
  await admin.from("squad_events").update({ processed: true }).eq("event_ref", ref);
  const naira = (k: number) => "₦" + (k / 100).toLocaleString();
  await notify(va.user_id, "wallet_funded", "Wallet funded", fee > 0
    ? `${naira(v.amountKobo)} received by bank transfer. Funding fee ${naira(fee)}. ${naira(v.amountKobo - fee)} added to your wallet.`
    : `${naira(v.amountKobo)} has been added by bank transfer.`, { ref });
  return reply(200, ref, "Success");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await req.text();                       // signature is over the raw body, so read it as text first
  const sig = req.headers.get("x-squad-encrypted-body") ?? req.headers.get("x-squad-signature");
  if (!(await validWebhookSignature(raw, sig))) return new Response("Invalid signature", { status: 401 });

  let evt: any;
  try { evt = JSON.parse(raw); } catch { return reply(400, "", "Bad JSON"); }
  const ref: string = evt.TransactionRef ?? evt.Body?.transaction_ref ?? evt.transaction_reference ?? "";
  if (!ref) return reply(400, "", "No reference");
  if (evt.Event && evt.Event !== "charge_successful") return reply(200, ref, "Ignored"); // only funding events matter

  // Idempotency: one row per reference
  const ins = await admin.from("squad_events").insert({ event_ref: ref, event_type: evt.Event ?? "unknown", payload: evt });
  if (ins.error) {
    const { data: ex } = await admin.from("squad_events").select("processed").eq("event_ref", ref).maybeSingle();
    if (ex?.processed) return reply(200, ref, "Already processed");
  }

  if (evt.virtual_account_number || String(evt.channel ?? "") === "virtual-account") return await handleVirtual(evt, ref);
  const { data: intent } = await admin.from("funding_intents").select("*").eq("ref", ref).maybeSingle();
  if (!intent) return reply(200, ref, "Not a wallet funding payment");
  if (intent.status === "success") return reply(200, ref, "Already processed");

  // Never trust the webhook body alone: ask Squad whether this payment really succeeded.
  const v = await verifyPayment(ref);
  if (!v.success) return reply(500, ref, "Could not confirm payment yet"); // Squad will retry
  if (v.amountKobo && v.amountKobo !== Number(intent.amount_kobo)) {
    await admin.from("funding_intents").update({ status: "failed" }).eq("ref", ref);
    console.error("Amount mismatch", ref, v.amountKobo, intent.amount_kobo);
    return reply(200, ref, "Amount mismatch flagged for review");
  }

  const { error } = await admin.rpc("ledger_post", {
    p_user: intent.user_id, p_amount: Number(intent.amount_kobo), p_kind: "funding", p_ref: ref, p_idem: `fund:${ref}`,
  });
  if (error) { console.error(error); return reply(500, ref, "Credit failed"); }
  const fee = Number(intent.fee_kobo ?? 0);
  if (fee > 0) {
    const fe = await admin.rpc("ledger_post", { p_user: intent.user_id, p_amount: -fee, p_kind: "fee", p_ref: ref, p_idem: `fundfee:${ref}` });
    if (fe.error) { console.error(fe.error); return reply(500, ref, "Fee failed"); }
  }
  await admin.from("funding_intents").update({ status: "success" }).eq("ref", ref);
  await admin.from("squad_events").update({ processed: true }).eq("event_ref", ref);
  const nr = (k: number) => "₦" + (k / 100).toLocaleString();
  await notify(intent.user_id, "wallet_funded", "Wallet funded", fee > 0
    ? `${nr(Number(intent.amount_kobo))} paid. Funding fee ${nr(fee)}. ${nr(Number(intent.amount_kobo) - fee)} added to your wallet.`
    : `${nr(Number(intent.amount_kobo))} has been added.`, { ref });
  return reply(200, ref, "Success");
});
