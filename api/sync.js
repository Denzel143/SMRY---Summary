/**
 * Vercel Serverless Function  →  /api/sync   (sinkronisasi cloud ke Vercel Blob, identitas = Firebase Authentication)
 *
 * Persiapan:
 *   1. npm install @vercel/blob@^2.6.1        (tambahkan ke package.json)
 *   2. Vercel → Storage → Create → Blob → pilih akses **Private**, lalu hubungkan ke project ini.
 *      Vercel otomatis mengisi token (di project ini: SMRY_READ_WRITE_TOKEN).
 *
 * Environment Variables:
 *   FIREBASE_PROJECT_ID     Project ID Firebase (Project settings → General). Dipakai untuk memverifikasi token.
 *   FIREBASE_API_KEY        Web API Key Firebase (Project settings → General). Memang publik; dikirim ke klien lewat action "config".
 *   FIREBASE_AUTH_DOMAIN    (opsional) default <FIREBASE_PROJECT_ID>.firebaseapp.com
 *   SMRY_READ_WRITE_TOKEN   Token Blob (nama mengikuti awalan yang dipilih saat store dihubungkan ke project;
 *                           BLOB_READ_WRITE_TOKEN juga dikenali). SMRY_STORE_ID dan SMRY_WEBHOOK_PUBLIC_KEY tidak dipakai.
 *
 * Keamanan: klien (web & Android) TIDAK pernah memegang token Blob. Klien mengirim Firebase ID token
 * (Authorization: Bearer ...). Server memverifikasi tanda tangan token, lalu hanya mengizinkan akses ke
 * folder  u/<Firebase uid>/  milik akun tersebut. Store bersifat private, jadi file tidak bisa dibuka lewat URL.
 *
 * Semua request: POST JSON { action, ... }. Balasan: JSON. 
 *   config                                  (tanpa login) → { firebase: { apiKey, authDomain, projectId } }
 *   manifest                                → { halls: { id: { updatedAt, deleted, photos } } }
 *   get      { id }                         → { hall }
 *   getPhoto { id, n }                      → { data: "data:image/jpeg;base64,..." }
 *   putPhoto { id, n, data }                → { ok }
 *   put      { hall, photos }               → { applied }        (hall = JSON tanpa foto; photos = jumlah foto)
 *   delete   { id, updatedAt }              → { applied }
 */
const crypto = require("crypto");
const { put, get, del } = require("@vercel/blob");

const TOKEN = () => process.env.SMRY_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN || undefined;
const LIMITS = { hallChars: 2_000_000, photoChars: 3_000_000, maxPhotos: 10 };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/* ═════════════════════ Penyimpanan: Vercel Blob (private) ═════════════════════ */

const isNotFound = (e) => e && (e.name === "BlobNotFoundError" || /not.?found/i.test(String(e.message)));
const isPrecondition = (e) => e && (e.name === "BlobPreconditionFailedError" || /precondition/i.test(String(e.message)));

/** Baca blob. Mengembalikan { buf, etag } atau null bila tidak ada. useCache:false = selalu data terbaru. */
async function blobGet(pathname) {
  try {
    const r = await get(pathname, { access: "private", useCache: false, token: TOKEN() });
    if (!r || r.statusCode === 404 || !r.stream) return null;
    return { buf: Buffer.from(await new Response(r.stream).arrayBuffer()), etag: r.blob && r.blob.etag };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw new HttpError(502, "Could not read from Vercel Blob.");
  }
}

/** Tulis (timpa) blob. `ifMatch` = ETag untuk penulisan bersyarat. */
async function blobPut(pathname, body, contentType, ifMatch) {
  try {
    await put(pathname, body, {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType,
      cacheControlMaxAge: 60,
      token: TOKEN(),
      ...(ifMatch ? { ifMatch } : {}),
    });
  } catch (e) {
    if (isPrecondition(e)) throw e;
    throw new HttpError(502, "Could not write to Vercel Blob.");
  }
}

async function blobDel(pathname) {
  try { await del(pathname, { token: TOKEN() }); }
  catch (e) { if (!isNotFound(e)) throw new HttpError(502, "Could not delete from Vercel Blob."); }
}

/* ═════════════════════ Verifikasi Firebase ID token ═════════════════════ */

const FIREBASE_JWK = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let keyCache = { at: 0, keys: [] };
async function firebaseKeys(force) {
  const age = Date.now() - keyCache.at;
  if (keyCache.keys.length && (force ? age < 60_000 : age < 3600_000)) return keyCache.keys;
  const r = await fetch(FIREBASE_JWK);
  if (!r.ok) throw new HttpError(502, "Could not load Firebase signing keys.");
  keyCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  return keyCache.keys;
}
const b64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

async function verifyIdToken(token) {
  const projectId = (process.env.FIREBASE_PROJECT_ID || "").trim();
  if (!projectId) throw new HttpError(500, "Server is missing FIREBASE_PROJECT_ID.");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new HttpError(401, "Not signed in.");
  let header, payload;
  try { header = JSON.parse(b64u(parts[0]).toString()); payload = JSON.parse(b64u(parts[1]).toString()); }
  catch { throw new HttpError(401, "Invalid token."); }
  if (header.alg !== "RS256") throw new HttpError(401, "Invalid token.");
  let jwk = (await firebaseKeys(false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await firebaseKeys(true)).find((k) => k.kid === header.kid); // kunci bisa dirotasi
  if (!jwk) throw new HttpError(401, "Unknown signing key. Sign in again.");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), crypto.createPublicKey({ key: jwk, format: "jwk" }), b64u(parts[2]));
  if (!ok) throw new HttpError(401, "Invalid token.");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new HttpError(401, "Invalid token issuer.");
  if (payload.aud !== projectId) throw new HttpError(401, "Token is for a different app.");
  const now = Date.now();
  if (!payload.exp || payload.exp * 1000 < now) throw new HttpError(401, "Session expired. Sign in again.");
  if (!payload.iat || payload.iat * 1000 > now + 60_000) throw new HttpError(401, "Invalid token.");
  if (typeof payload.sub !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.sub)) throw new HttpError(401, "Invalid token.");
  return { sub: payload.sub, email: payload.email || "" };
}

/* ═════════════════════ Logika sinkronisasi ═════════════════════ */

const checkId = (id) => { if (typeof id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new HttpError(400, "Invalid id."); return id; };
const checkN = (n) => { if (!Number.isInteger(n) || n < 0 || n >= LIMITS.maxPhotos) throw new HttpError(400, "Invalid photo index."); return n; };
const checkTime = (t) => { if (!Number.isFinite(t) || t <= 0) throw new HttpError(400, "Invalid timestamp."); return Math.round(t); };

async function readManifest(base) {
  const r = await blobGet(base + "manifest.json");
  if (!r) return { m: { v: 1, halls: {} }, etag: null };
  try { const m = JSON.parse(r.buf.toString()); m.halls = m.halls || {}; return { m, etag: r.etag }; }
  catch { return { m: { v: 1, halls: {} }, etag: r.etag }; }
}

/**
 * Ubah manifest dengan aman: baca → ubah → tulis dengan ifMatch(ETag).
 * Jika perangkat lain menulis lebih dulu, ulangi dari awal (maks. 5x).
 * `mutate(m)` mengembalikan false bila tidak ada yang perlu ditulis.
 */
async function updateManifest(base, mutate) {
  for (let i = 0; i < 5; i++) {
    const { m, etag } = await readManifest(base);
    if (mutate(m) === false) return m;
    try { await blobPut(base + "manifest.json", JSON.stringify(m), "application/json", etag); return m; }
    catch (e) { if (!isPrecondition(e)) throw e; }
  }
  throw new HttpError(409, "Cloud is busy. Try again.");
}

async function run(sub, body) {
  const base = `u/${sub}/`;
  switch (body.action) {
    case "manifest": return (await readManifest(base)).m;

    case "get": {
      const r = await blobGet(`${base}halls/${checkId(body.id)}.json`);
      if (!r) throw new HttpError(404, "Study Hall not found in the cloud.");
      return { hall: JSON.parse(r.buf.toString()) };
    }
    case "getPhoto": {
      const r = await blobGet(`${base}photos/${checkId(body.id)}/${checkN(body.n)}.jpg`);
      if (!r) throw new HttpError(404, "Photo not found in the cloud.");
      return { data: "data:image/jpeg;base64," + r.buf.toString("base64") };
    }
    case "putPhoto": {
      const m = typeof body.data === "string" && body.data.length <= LIMITS.photoChars && body.data.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw new HttpError(400, "Photo must be a base64 JPEG data URI.");
      await blobPut(`${base}photos/${checkId(body.id)}/${checkN(body.n)}.jpg`, Buffer.from(m[1], "base64"), "image/jpeg");
      return { ok: true };
    }
    case "put": {
      const hall = body.hall;
      if (!hall || typeof hall !== "object") throw new HttpError(400, "Missing hall.");
      const id = checkId(hall.id), updatedAt = checkTime(hall.updatedAt);
      const photos = Number.isInteger(body.photos) && body.photos >= 0 && body.photos <= LIMITS.maxPhotos ? body.photos : 0;
      const text = JSON.stringify(hall);
      if (text.length > LIMITS.hallChars) throw new HttpError(413, "Study Hall is too large.");
      const { m: before } = await readManifest(base), cur = before.halls[id];
      if (cur && cur.updatedAt > updatedAt) return { applied: false, remote: cur };
      await blobPut(`${base}halls/${id}.json`, text, "application/json");
      await updateManifest(base, (m) => {
        const c = m.halls[id];
        if (c && c.updatedAt > updatedAt) return false; // perangkat lain sudah lebih baru
        m.halls[id] = { updatedAt, deleted: false, photos };
      });
      return { applied: true };
    }
    case "delete": {
      const id = checkId(body.id), updatedAt = checkTime(body.updatedAt);
      const { m: before } = await readManifest(base), cur = before.halls[id];
      if (cur && !cur.deleted && cur.updatedAt > updatedAt) return { applied: false, remote: cur };
      await blobDel(`${base}halls/${id}.json`);
      for (let n = 0; n < Math.max(cur ? cur.photos || 0 : 0, 0) && n < LIMITS.maxPhotos; n++) await blobDel(`${base}photos/${id}/${n}.jpg`);
      await updateManifest(base, (m) => { m.halls[id] = { updatedAt, deleted: true, photos: 0 }; });
      return { applied: true };
    }
    default: throw new HttpError(400, "Unknown action.");
  }
}

async function handler(req, res) {
  const send = (status, obj) => { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(obj)); };
  try {
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); throw new HttpError(405, "Use POST."); }
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { throw new HttpError(400, "Invalid JSON."); } }
    if (!body || typeof body !== "object") throw new HttpError(400, "Invalid request body.");

    if (body.action === "config") {
      const projectId = (process.env.FIREBASE_PROJECT_ID || "").trim(), apiKey = (process.env.FIREBASE_API_KEY || "").trim();
      if (!projectId || !apiKey) throw new HttpError(500, "Server is missing FIREBASE_PROJECT_ID or FIREBASE_API_KEY.");
      const authDomain = (process.env.FIREBASE_AUTH_DOMAIN || "").trim() || `${projectId}.firebaseapp.com`;
      return send(200, { firebase: { apiKey, authDomain, projectId } });
    }
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
    const user = await verifyIdToken(m && m[1]);
    send(200, await run(user.sub, body));
  } catch (e) {
    if (!e.status || e.status >= 500) console.error("[api/sync]", e && e.stack || e);
    send(e.status || 500, { error: e.status ? e.message : "Server error." });
  }
}

module.exports = handler;
module.exports._test = { verifyIdToken };
module.exports.config = { maxDuration: 30 };
