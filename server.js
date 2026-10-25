"use strict";
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const EXPECTED = Number(process.env.EXPECTED_ATTENDANCE || 600);
const MATCH_TEXT = process.env.MATCH_TEXT || "Kronekamp Skeid – Stjørdals-Blink 31.10.2026";
const KASPER_SECRET = process.env.KASPER_SECRET;

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL mangler."); process.exit(1); }
if (!ADMIN_PASSWORD) { console.error("ADMIN_PASSWORD mangler."); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pledges (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('bedrift','privat')),
      name TEXT NOT NULL,
      orgnr TEXT,
      contact TEXT,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      zip TEXT NOT NULL,
      city TEXT NOT NULL,
      kroner NUMERIC(10,2) NOT NULL,
      per INTEGER NOT NULL,
      cap INTEGER,
      anon BOOLEAN NOT NULL DEFAULT FALSE,
      consent_at TIMESTAMPTZ NOT NULL,
      logo BYTEA,
      logo_mime TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB
    );
    ALTER TABLE pledges ADD COLUMN IF NOT EXISTS kasper_ref TEXT UNIQUE;
    ALTER TABLE pledges ADD COLUMN IF NOT EXISTS cap_kr NUMERIC(10,2);
  `);
}

async function getFinalAttendance() {
  const r = await pool.query("SELECT value FROM settings WHERE key = 'final_attendance'");
  const v = r.rows[0] && r.rows[0].value;
  return v == null ? null : Number(v);
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("X-Frame-Options", "SAMEORIGIN");
  next();
});
app.use(express.json({ limit: "1mb" }));

/* ---------- Helpers ---------- */
const nf0 = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 });
const round2 = (n) => Math.round(n * 100) / 100;
const rateOf = (p) => Number(p.kroner) / Number(p.per);
const billed = (p, att) => (p.cap ? Math.min(att, Number(p.cap)) : att);
const capKrOf = (p) => (p.cap_kr == null ? null : Number(p.cap_kr));
const amountAt = (p, att) => {
  const a = rateOf(p) * billed(p, att), max = capKrOf(p);
  return round2(max == null ? a : Math.min(a, max));
};
const capText = (p) => (p.cap ? `, maks ${nf0.format(p.cap)} tilskuere` : capKrOf(p) != null ? `, maks ${nf0.format(capKrOf(p))} kr` : "");
const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isInt = (n) => Number.isInteger(n);

function parseLogo(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:(image\/(?:png|webp|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw new Error("Logoen har et ukjent format.");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 400 * 1024) throw new Error("Logoen er for stor.");
  const png = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  const webp = buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";
  if (!(png || jpg || webp)) throw new Error("Logoen er ikke et gyldig bilde.");
  return { buf, mime: png ? "image/png" : jpg ? "image/jpeg" : "image/webp" };
}

function validate(body) {
  const type = body.type === "bedrift" ? "bedrift" : body.type === "privat" ? "privat" : null;
  const b = type === "bedrift";
  const p = {
    type,
    name: str(body.name, 120),
    orgnr: b ? str(body.orgnr, 20).replace(/\s/g, "") : null,
    contact: b ? str(body.contact, 120) : null,
    email: str(body.email, 160),
    phone: str(body.phone, 30),
    address: str(body.address, 160),
    zip: str(body.zip, 4),
    city: str(body.city, 80),
    kroner: Number(body.kroner),
    per: 1, // always kroner per single spectator
    cap: body.cap === null || body.cap === "" || body.cap === undefined ? null : Number(body.cap),
    cap_kr: body.capKr === null || body.capKr === "" || body.capKr === undefined ? null : Number(body.capKr),
    anon: body.anon === true,
  };
  const errs = [];
  if (!type) errs.push("type bidragsyter");
  if (!p.name) errs.push(b ? "firmanavn" : "navn");
  if (b && !/^\d{9}$/.test(p.orgnr || "")) errs.push("organisasjonsnummer med 9 siffer");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) errs.push("gyldig e-post");
  if (p.phone.replace(/\D/g, "").length < 8) errs.push("mobilnummer");
  if (!p.address) errs.push("adresse");
  if (!/^\d{4}$/.test(p.zip)) errs.push("postnummer med 4 siffer");
  if (!p.city) errs.push("poststed");
  if (!(p.kroner > 0 && p.kroner <= 100000)) errs.push("kronebeløp");
  if (p.cap !== null && !(isInt(p.cap) && p.cap >= 1 && p.cap <= 100000)) errs.push("tak som helt tall");
  if (p.cap_kr !== null && !(isInt(p.cap_kr) && p.cap_kr >= 1 && p.cap_kr <= 10000000)) errs.push("tak i kroner som helt tall");
  if (p.cap !== null && p.cap_kr !== null) errs.push("bare ett tak");
  if (body.consent !== true) errs.push("samtykke til faktura");
  return { p, errs };
}

/* Simple in-memory rate limit for registrations */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), windowMs = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > 6;
}

/* ---------- Public API ---------- */
app.get("/api/public", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id, type, name, kroner, per, cap, cap_kr, anon, (logo IS NOT NULL) AS has_logo FROM pledges ORDER BY id"
    );
    const finalAttendance = await getFinalAttendance();
    res.set("Cache-Control", "no-store");
    res.json({
      expected: EXPECTED,
      finalAttendance,
      pledges: r.rows.map((p) => ({
        id: p.id,
        type: p.type,
        anon: p.anon,
        name: p.anon ? null : p.name,
        kroner: Number(p.kroner),
        per: p.per,
        cap: p.cap,
        capKr: capKrOf(p),
        logo: p.type === "bedrift" && !p.anon && p.has_logo ? `/logo/${p.id}` : null,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kunne ikke hente data." });
  }
});

app.get("/logo/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!isInt(id)) return res.sendStatus(404);
  try {
    const r = await pool.query("SELECT logo, logo_mime, anon, type FROM pledges WHERE id = $1", [id]);
    const row = r.rows[0];
    if (!row || !row.logo || row.anon || row.type !== "bedrift") return res.sendStatus(404);
    res.set("Content-Type", row.logo_mime);
    res.set("Cache-Control", "public, max-age=300");
    res.set("Content-Security-Policy", "default-src 'none'");
    res.send(row.logo);
  } catch (e) {
    res.sendStatus(500);
  }
});

app.post("/api/pledges", async (req, res) => {
  if (str(req.body.website)) return res.json({ ok: true }); // honeypot
  if (rateLimited(req.ip)) return res.status(429).json({ error: "For mange registreringer på kort tid. Prøv igjen om litt." });
  if ((await getFinalAttendance()) !== null) return res.status(409).json({ error: "Påmeldingen er stengt." });
  const { p, errs } = validate(req.body || {});
  if (errs.length) return res.status(400).json({ error: "Fyll inn: " + errs.join(", ") + "." });
  let logo = null;
  try { logo = p.type === "bedrift" ? parseLogo(req.body.logo) : null; }
  catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    await pool.query(
      `INSERT INTO pledges (type,name,orgnr,contact,email,phone,address,zip,city,kroner,per,cap,cap_kr,anon,consent_at,logo,logo_mime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15,$16)`,
      [p.type, p.name, p.orgnr, p.contact, p.email, p.phone, p.address, p.zip, p.city, p.kroner, p.per, p.cap, p.cap_kr, p.anon,
        logo ? logo.buf : null, logo ? logo.mime : null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Registreringen ble ikke lagret. Prøv igjen." });
  }
});

/* ---------- Kasper sync (Bearer KASPER_SECRET) ----------
   Kasper is the source of truth for pledges registered there and mirrors each
   one here, keyed by its own id (kasper_ref). */
function requireKasper(req, res, next) {
  const h = req.headers.authorization || "";
  if (KASPER_SECRET && h.startsWith("Bearer ") && safeEqual(h.slice(7), KASPER_SECRET)) return next();
  res.status(401).json({ error: "Ugyldig nøkkel." });
}
const KASPER_REF = /^[a-z0-9]{1,64}$/;

app.put("/api/kasper/pledges/:ref", requireKasper, async (req, res) => {
  const ref = req.params.ref;
  if (!KASPER_REF.test(ref)) return res.status(400).json({ error: "Ugyldig id." });
  try {
    if ((await getFinalAttendance()) !== null) return res.status(409).json({ error: "Påmeldingen er stengt." });
    const body = { ...(req.body || {}), consent: true };
    const { p, errs } = validate(body);
    const consentAt = new Date(body.consentAt);
    if (!body.consentAt || isNaN(consentAt)) errs.push("samtykketidspunkt");
    if (errs.length) return res.status(400).json({ error: "Fyll inn: " + errs.join(", ") + "." });
    let logo = null;
    if (p.type === "bedrift") { try { logo = parseLogo(body.logo); } catch (e) { logo = null; } }
    await pool.query(
      `INSERT INTO pledges (type,name,orgnr,contact,email,phone,address,zip,city,kroner,per,cap,cap_kr,anon,consent_at,logo,logo_mime,kasper_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (kasper_ref) DO UPDATE SET type = EXCLUDED.type, name = EXCLUDED.name, orgnr = EXCLUDED.orgnr,
         contact = EXCLUDED.contact, email = EXCLUDED.email, phone = EXCLUDED.phone, address = EXCLUDED.address,
         zip = EXCLUDED.zip, city = EXCLUDED.city, kroner = EXCLUDED.kroner, per = EXCLUDED.per, cap = EXCLUDED.cap,
         cap_kr = EXCLUDED.cap_kr, anon = EXCLUDED.anon, consent_at = EXCLUDED.consent_at,
         logo = EXCLUDED.logo, logo_mime = EXCLUDED.logo_mime`,
      [p.type, p.name, p.orgnr, p.contact, p.email, p.phone, p.address, p.zip, p.city, p.kroner, p.per, p.cap, p.cap_kr, p.anon,
        consentAt, logo ? logo.buf : null, logo ? logo.mime : null, ref]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Bidraget ble ikke lagret." });
  }
});

app.delete("/api/kasper/pledges/:ref", requireKasper, async (req, res) => {
  if (!KASPER_REF.test(req.params.ref)) return res.status(400).json({ error: "Ugyldig id." });
  try {
    const r = await pool.query("DELETE FROM pledges WHERE kasper_ref = $1", [req.params.ref]);
    if (!r.rowCount) return res.status(404).json({ error: "Finnes ikke." });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Bidraget ble ikke slettet." });
  }
});

/* ---------- Admin (Basic Auth) ---------- */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function requireAdmin(req, res, next) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Basic ")) {
    const [u, ...rest] = Buffer.from(h.slice(6), "base64").toString().split(":");
    if (safeEqual(u, ADMIN_USER) && safeEqual(rest.join(":"), ADMIN_PASSWORD)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Kronekamp admin", charset="UTF-8"');
  res.status(401).send("Krever innlogging.");
}

app.get("/admin", requireAdmin, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "admin", "admin.html"));
});

app.get("/admin/api/pledges", requireAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT id,type,name,orgnr,contact,email,phone,address,zip,city,kroner,per,cap,cap_kr,anon,consent_at,created_at,
            (logo IS NOT NULL) AS has_logo, (kasper_ref IS NOT NULL) AS from_kasper FROM pledges ORDER BY id`
  );
  res.set("Cache-Control", "no-store");
  res.json({
    expected: EXPECTED,
    finalAttendance: await getFinalAttendance(),
    pledges: r.rows.map(({ cap_kr, ...p }) => ({ ...p, kroner: Number(p.kroner), capKr: capKrOf({ cap_kr }) })),
  });
});

app.patch("/admin/api/pledges/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!isInt(id)) return res.sendStatus(404);
  const b = req.body || {};
  if (typeof b.anon === "boolean") await pool.query("UPDATE pledges SET anon = $1 WHERE id = $2", [b.anon, id]);
  if (b.removeLogo === true) await pool.query("UPDATE pledges SET logo = NULL, logo_mime = NULL WHERE id = $1", [id]);
  res.json({ ok: true });
});

app.delete("/admin/api/pledges/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!isInt(id)) return res.sendStatus(404);
  await pool.query("DELETE FROM pledges WHERE id = $1", [id]);
  res.json({ ok: true });
});

app.put("/admin/api/settings", requireAdmin, async (req, res) => {
  const v = req.body && req.body.finalAttendance;
  const val = v === null || v === "" || v === undefined ? null : Number(v);
  if (val !== null && !(isInt(val) && val >= 0)) return res.status(400).json({ error: "Tilskuertallet må være et helt tall." });
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('final_attendance', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(val)]
  );
  res.json({ ok: true });
});

const fmtKr = (n) => { const r = round2(n); return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(".", ","); };
const deal = (p) => `${fmtKr(p.kroner)} kr per ${p.per === 1 ? "tilskuer" : p.per + " tilskuere"}`;
const dec = (n) => round2(n).toFixed(2).replace(".", ",");
const cell = (v) => { const s = String(v == null ? "" : v); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

app.get("/admin/api/export.csv", requireAdmin, async (req, res) => {
  const att = await getFinalAttendance();
  if (att === null) return res.status(409).send("Legg inn offisielt tilskuertall før eksport.");
  const r = await pool.query("SELECT * FROM pledges ORDER BY id");
  const rows = r.rows
    .map((p) => ({ ...p, kroner: Number(p.kroner) }))
    .sort((a, b) => amountAt(b, att) - amountAt(a, att));
  const head = ["Kundetype", "Navn", "Organisasjonsnummer", "Kontaktperson", "E-post", "Mobil", "Adresse", "Postnummer", "Poststed",
    "Avtale", "Tak (tilskuere)", "Tak (kr)", "Tilskuere fakturert", "Kr per tilskuer", "Beløp", "Forfall (dager)", "Samtykke registrert", "Fakturatekst"];
  const lines = [head].concat(rows.map((p) => {
    const n = billed(p, att);
    return [p.type === "bedrift" ? "Bedrift" : "Privatperson", p.name, p.orgnr || "", p.contact || "", p.email, p.phone, p.address, p.zip, p.city,
      deal(p), p.cap || "", capKrOf(p) == null ? "" : dec(capKrOf(p)), n, dec(rateOf(p)), dec(amountAt(p, att)), 14, new Date(p.consent_at).toISOString().slice(0, 10),
      `${MATCH_TEXT}: ${deal(p)}${capText(p)}, ${nf0.format(n)} tilskuere`];
  }));
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", 'attachment; filename="kronekamp-skeid-fakturaliste.csv"');
  res.set("Cache-Control", "no-store");
  res.send("\uFEFF" + lines.map((l) => l.map(cell).join(";")).join("\r\n") + "\r\n");
});

/* ---------- Static ---------- */
app.use(express.static(path.join(__dirname, "public"), { maxAge: "5m" }));

migrate()
  .then(() => app.listen(PORT, () => console.log(`Kronekamp kjører på port ${PORT}`)))
  .catch((e) => { console.error("Klarte ikke å sette opp databasen:", e); process.exit(1); });
