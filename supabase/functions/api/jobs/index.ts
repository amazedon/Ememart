// supabase/functions/jobs/index.ts
// FUNCTION NAME (type this exactly in Supabase): jobs
// Settings: turn Verify JWT OFF (it is protected by the x-cron-secret header instead).
// Called every 5 minutes by the schedule SQL in DEPLOY.md.
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


// Housekeeping that SQL alone cannot do. Called every 5 minutes by pg_cron (see DEPLOY.md).
//   supabase functions deploy jobs --no-verify-jwt     (protected by the x-cron-secret header instead)

async function drainStorageQueue() {
  const { data } = await admin.from("storage_delete_queue").select("id, bucket, path").order("id").limit(500);
  if (!data?.length) return 0;
  const byBucket = new Map<string, { ids: number[]; paths: string[] }>();
  for (const r of data) {
    const b = byBucket.get(r.bucket) ?? { ids: [], paths: [] };
    b.ids.push(r.id); b.paths.push(r.path); byBucket.set(r.bucket, b);
  }
  let removed = 0;
  for (const [bucket, b] of byBucket) {
    const { error } = await admin.storage.from(bucket).remove(b.paths);
    if (error) { console.error("storage remove failed", bucket, error.message); continue; } // retried next run
    await admin.from("storage_delete_queue").delete().in("id", b.ids);
    removed += b.ids.length;
  }
  return removed;
}

// Withdrawals left "pending" (timeout / network error): ask Squad what happened.
async function reconcileWithdrawals() {
  const olderThan = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data } = await admin.from("withdrawals").select("*").eq("status", "pending").lte("created_at", olderThan).limit(50);
  let done = 0;
  for (const w of data ?? []) {
    if (!w.squad_ref) continue;
    try {
      const r = await requeryTransfer(w.squad_ref);
      const code = Number(r.data?.status ?? r.httpStatus);
      const desc = String(r.data?.data?.response_description ?? r.data?.message ?? "").toLowerCase();
      const ageMin = (Date.now() - new Date(w.created_at).getTime()) / 60_000;
      if (code === 200 && desc.includes("success")) {
        await admin.from("withdrawals").update({ status: "success" }).eq("id", w.id); done++;
      } else if (code === 412 || (code === 404 && ageMin > 30)) {   // reversed / never reached the bank
        await admin.rpc("ledger_post", { p_user: w.user_id, p_amount: Number(w.amount_kobo), p_kind: "withdrawal_reversal", p_ref: w.id, p_idem: `wdrev:${w.id}` });
        await admin.from("withdrawals").update({ status: "failed" }).eq("id", w.id);
        await audit(null, "withdrawal.auto_reversed", w.id, { code }); done++;
      }
      // anything else: still unknown, try again next run. Finance can see it in /admin/finance/withdrawals
    } catch (e) { console.error("requery failed", w.id, e); }
  }
  return done;
}

async function expireTiers() {
  const { data } = await admin.from("profiles").update({ tier: "free", tier_expires_at: null })
    .neq("tier", "free").lte("tier_expires_at", new Date().toISOString()).select("id");
  return data?.length ?? 0;
}

Deno.serve(async (req) => {
  const given = req.headers.get("x-cron-secret") ?? "";
  if (!timingSafeEqual(given, env("CRON_SECRET"))) return new Response("Forbidden", { status: 403 });
  const result = {
    storage_removed: await drainStorageQueue(),
    withdrawals_settled: await reconcileWithdrawals(),
    tiers_expired: await expireTiers(),
  };
  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
});
