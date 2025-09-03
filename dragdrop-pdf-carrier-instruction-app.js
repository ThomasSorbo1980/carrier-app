/**
 * Carrier Notification Letter
 * PDF → Autofill form → Save to SQLite
 * Extraction pipeline: pdf-parse + pdftotext -layout + Tesseract OCR
 */

// ====== REQUIRES ======
const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const dayjs = require("dayjs");
const Database = require("better-sqlite3");
const { nanoid } = require("nanoid");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const crypto = require("crypto");

// ====== DB INIT (MUST come before any db.prepare calls) ======
const DB_PATH = process.env.SQLITE_DB_PATH || "shipments.db";
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
try { db.pragma("journal_mode = WAL"); } catch (_) {}

// ====== TABLES ======
db.prepare(`
  CREATE TABLE IF NOT EXISTS shipments (
    id TEXT PRIMARY KEY,
    created_at TEXT,
    your_partner TEXT,
    shipper_phone TEXT,
    shipper_email TEXT,
    shipment_no TEXT,
    order_no TEXT,
    delivery_no TEXT,
    loading_date TEXT,
    scheduled_delivery_date TEXT,
    po_no TEXT,
    order_label TEXT,
    shipping_street TEXT,
    shipping_postal TEXT,
    shipping_city TEXT,
    shipping_country TEXT,
    way_of_forwarding TEXT,
    delivery_terms TEXT,
    carrier_to TEXT,
    consignee_address TEXT,
    customer_no TEXT,
    customer_po TEXT,
    customer_contact TEXT,
    customer_phone TEXT,
    customer_email TEXT,
    notify1_address TEXT,
    notify1_email TEXT,
    notify1_phone TEXT,
    notify2_address TEXT,
    notify2_email TEXT,
    notify2_phone TEXT,
    total_net_kg REAL,
    total_gross_kg REAL,
    total_pkgs INTEGER,
    bl_remarks TEXT,
    hs_code TEXT,
    signature_name TEXT,
    signature_date TEXT
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    shipment_id TEXT,
    product_name TEXT,
    net_kg REAL,
    gross_kg REAL,
    pkgs INTEGER,
    packaging TEXT,
    pallets INTEGER,
    FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS cache (
    hash TEXT PRIMARY KEY,
    text TEXT,
    parsed TEXT,
    created_at TEXT
  )
`).run();

// ====== AUTO-MIGRATIONS ======
function ensureColumns(table, cols) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  const namesLC = new Set(existing.map(r => String(r.name).toLowerCase()));
  for (const [name, type] of Object.entries(cols)) {
    const want = String(name).toLowerCase();
    if (!namesLC.has(want)) {
      try {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
        namesLC.add(want);
      } catch (e) {
        if (!/duplicate column name/i.test(String(e))) throw e;
      }
    }
  }
}
ensureColumns("shipments", {
  order_label: "TEXT",
  shipping_street: "TEXT",
  shipping_postal: "TEXT",
  shipping_city: "TEXT",
  shipping_country: "TEXT",
  notify1_email: "TEXT",
  notify1_phone: "TEXT",
  notify2_email: "TEXT",
  notify2_phone: "TEXT"
});
ensureColumns("items", { packaging: "TEXT", pallets: "INTEGER" });

// ---------- App ----------
const app = express();
app.use(express.json({ limit: "8mb" }));
const upload = multer({ storage: multer.memoryStorage() });

// ---------- Helpers ----------
function clean(s) {
  return (s || "")
    .replace(/\u00A0/g, " ")              // NBSP -> space
    .replace(/[‐–—−]/g, "-")              // dashes -> '-'
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/[：]/g, ":")                 // fullwidth colon
    .replace(/\s+[ \t]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
const stripPrefix = s => (s || "").replace(/^[\s:!•._-]+/, "").trim();
const onlyDigits  = s => (s || "").replace(/\D+/g, "");

function validateAndScore(f) {
  let score = 0;
  const warn = [];
  const has = k => f[k] && String(f[k]).trim().length > 0;

  if (has("shipment_no") && /\d{6,}/.test(f.shipment_no)) score += 15; else warn.push("Shipment No missing/short");
  if (has("order_no")    && /\d{6,}/.test(f.order_no))     score += 10;
  if (has("loading_date") && /\d{2}[./-]\d{2}[./-]\d{2,4}/.test(f.loading_date)) score += 8; else warn.push("Loading date missing");
  if (has("scheduled_delivery_date") && /\d{2}[./-]\d{2}[./-]\d{2,4}/.test(f.scheduled_delivery_date)) score += 6;
  if (has("consignee_address") && f.consignee_address.split("\n").length >= 2) score += 15; else warn.push("Consignee address incomplete");
  if (Array.isArray(f.items) && f.items.length > 0) score += 10;
  if (f.total_net_kg && f.total_gross_kg && f.total_gross_kg >= f.total_net_kg) score += 10; else warn.push("Totals inconsistent/missing");
  if (has("hs_code") && /\d{6,8}/.test(f.hs_code)) score += 5;

  score = Math.max(5, Math.min(100, score)); // clamp
  return { score, warnings: warn };
}

function match(re, text, i = 1) { const m = re.exec(text); return m ? clean(m[i]) : ""; }
function matchAll(re, text) { const out = []; let m; while ((m = re.exec(text)) !== null) out.push(m); return out; }
function normalizeEmailSpaces(s) { return (s || "").replace(/@([^\s]+)/g, (_, rest) => '@' + rest.replace(/\s+/g, '')); }
function findEmail(line) {
  const cleaned = normalizeEmailSpaces(line || "");
  // require the address to start with a letter/number (so "-marina..." is rejected)
  const m = cleaned.match(/\b[A-Z0-9][A-Z0-9._%+-]*@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return m ? m[0].replace(/^[.\-_:;]+/, "") : "";
}

// Grab a value that appears AFTER a label (even if it's on the next line)
function grabNear(labelRe, valueRe, text, windowChars = 120) {
  const m = labelRe.exec(text);
  if (!m) return "";
  const start = m.index + m[0].length;
  const seg   = text.slice(start, Math.min(text.length, start + windowChars));
  const mv    = valueRe.exec(seg);
  return mv ? clean(mv[1] ?? mv[0]) : "";
}

// Grab 1–N lines after a label until a stop word appears
function grabBlock(labelRe, stopRes, text, maxLines = 8) {
  const m = labelRe.exec(text);
  if (!m) return "";
  const tail = text.slice(m.index + m[0].length);
  const lines = tail.split("\n").map(l => clean(l));
  const out = [];
  for (const line of lines) {
    if (!line) break; // stop on first blank line
    if (stopRes.some(r => r.test(line))) break;
    out.push(line);
    if (out.length >= maxLines) break;
  }
  return out.join("\n");
}

function parseShippingPoint(block) {
  const res = { street: "", postal: "", city: "", country: "" };
  if (!block) return res;
  const lines = block.split("\n").map(l => clean(l)).filter(Boolean);
  if (!lines.length) return res;
  const last = lines[lines.length - 1], prev = lines[lines.length - 2] || "";
  if (/^[A-Za-zÄÖÜäöüß\s\-]+$/.test(last) && last.length > 2) {
    res.country = last;
    const m = prev.match(/(\d{3,10})\s+(.+)/);
    if (m) { res.postal = m[1]; res.city = m[2]; }
    res.street = lines.slice(0, -2).join(", ");
  } else {
    const m = last.match(/(\d{3,10})\s+(.+)/);
    if (m) { res.postal = m[1]; res.city = m[2]; res.street = lines.slice(0, -1).join(", "); }
    else { res.street = lines.join(", "); }
  }
  for (const k of Object.keys(res)) res[k] = clean(res[k]);
  return res;
}

// Remove unrelated labels/lines from the carrier block
function sanitizeCarrierToBlock(s) {
  if (!s) return "";
  const DROP = /(Your\s*Partner|Telephone|Phone|Email|Shipment\s*No|Order\s*No|Delivery\s*No|Loading\s*Date|Shipping\s*Point|Street|Postal|City|Country|Way\s*of\s*Forwarding|Delivery\s*Terms|Incoterms)/i;
  const out = [];
  for (const raw of s.split("\n")) {
    const line = clean(raw);
    if (!line) {
      if (out.length) break;
      continue;
    }
    if (DROP.test(line)) break;
    out.push(line);
    if (out.length > 8) break;
  }
  return out.join("\n");
}

// Parse values that follow explicit labels inside a section block
function parseLabeledFields(block, labels) {
  const res = {};
  if (!block) return res;
  const lines = block.split("\n").map(l => clean(l));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [key, rex] of Object.entries(labels)) {
      if (rex.test(line)) {
        let val = line.replace(rex, "").replace(/^[\s:.-]+/, "");
        if (!val) {
          let j = i + 1;
          while (j < lines.length && !lines[j]) j++;
          if (j < lines.length) val = lines[j];
        }
        for (const other of Object.values(labels)) {
          val = val.replace(other, "").trim();
        }
        res[key] = clean(val);
      }
    }
  }
  return res;
}

// ---------- Extraction (parallel; OCR with pre-processing) ----------
async function extractTextFromBuffer(pdfBuffer) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carrier-"));
  const pdfPath = path.join(tmp, "input.pdf");
  fs.writeFileSync(pdfPath, pdfBuffer);

  const run = (cmd, args) => new Promise((res) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 }, (err, out) => res(err ? "" : out.toString("utf8")));
  });

  // pdf-parse
  const pPdfParse = (async () => {
    try { const a = await pdfParse(pdfBuffer); return a?.text || ""; } catch { return ""; }
  })();

  // pdftotext -layout
  const pPdftotext = run("pdftotext", ["-layout", "-nopgbrk", "-q", pdfPath, "-"]);

  // OCR (deskew/denoise)
  const pOCR = (async () => {
    try {
      await run("pdftoppm", ["-r", "300", pdfPath, path.join(os.tmpdir(), "pg"), "-png"]);
      const tmpDir = fs.readdirSync(os.tmpdir());
      const pngs = tmpDir.filter(f => /^pg-\d+\.png$/i.test(f)).sort();
      if (!pngs.length) return "";
      let ocrText = "";
      for (const f of pngs) {
        const inP = path.join(os.tmpdir(), f), outP = path.join(os.tmpdir(), "prep-" + f);
        await run("convert", [inP, "-deskew", "40%", "-strip", "-colorspace", "Gray",
                              "-contrast-stretch", "1%x1%", "-brightness-contrast", "10x15",
                              "-sharpen", "0x1", outP]);
        ocrText += "\n" + await run("tesseract", [outP, "stdout", "--psm", "4"]);
      }
      return ocrText;
    } catch { return ""; }
  })();

  const [t1, t2, t3] = await Promise.all([pPdfParse, pPdftotext, pOCR]);
  const candidates = [t1, t2, t3].filter(Boolean);
  if (!candidates.length) return "";

  const best = candidates
    .map(t => ({ t, score: scoreText(t) }))
    .sort((a, b) => b.score - a.score)[0].t;

  return best;
}

function scoreText(txt) {
  if (!txt) return 0;
  const keys = ["Shipment", "Order", "Delivery", "Delivery Address", "Notify", "TOTAL", "Way of Forwarding"];
  const keyHits = keys.reduce((n, k) => n + (txt.includes(k) ? 1 : 0), 0);
  const numbers = (txt.match(/\b\d{5,}\b/g) || []).length;
  const dates = (txt.match(/\b\d{2}[./-]\d{2}[./-]\d{2,4}\b/g) || []).length;
  const lenScore = Math.min(20, Math.floor(txt.length / 2000));
  return keyHits * 10 + Math.min(20, numbers) + Math.min(10, dates) + lenScore;
}

// ---------- PARSER ----------
function parseFieldsFromText(textRaw) {
  const full = clean(textRaw).replace(/\r/g, "");
  const norm = full.replace(/[\t\f]+/g, " ");

  // Header block (top only)
  const top = full.slice(0, 2000);
  const anchor = top.search(/Your\s*Partner|Telephone|Email/i);
  const headerBlock = anchor >= 0 ? top.slice(Math.max(0, anchor - 80), anchor + 600) : top.slice(0, 600);

  const your_partner = stripPrefix(grabNear(/Your\s*Partner[.:\-]?/i, /([^\n]+)/i, headerBlock, 100));
  let shipper_phone  = stripPrefix(grabNear(/(?:Telephone|Phone)[.:\-]?/i, /(\+?[0-9][0-9 ()\/\-]+)/i, headerBlock, 120));
  let shipper_email  = findEmail(grabNear(/Email[.:\-]?/i, /([^\n]+)/i, headerBlock, 140)) || "";

  // IDs & Dates
  const grabNum = (lab) => grabNear(lab, /([0-9]{4,}[0-9A-Za-z\-]*)/, full, 120) || "";
  const shipment_no = grabNum(/Shipment\s*No\b/i);
  const order_no    = grabNum(/Order\s*No\b/i);
  const delivery_no = grabNum(/Delivery\s*No\b/i);

  const grabDate = (lab) => grabNear(lab, /([0-9]{2}[.\-\/][0-9]{2}[.\-\/][0-9]{2,4})/, full, 90) || "";
  const loading_date = grabDate(/Loading\s*Date\b/i);

  // handle both "Sched. Delivery Date" and "Scheduled Delivery Date"
  let scheduled_delivery_date =
    grabDate(/Sched\.?(?:uled)?\s*Delivery\s*Date\b/i) ||
    (function(){
      const m = /(Sched\.?(?:uled)?\s*Delivery\s*Date[^\d]{0,30})(\d{2}[.\-\/]\d{2}[.\-\/]\d{2,4})/i.exec(full);
      return m ? m[2] : "";
    })();

  // ---------------- Shipping Point & Way/Terms (labeled section preferred) -----------
  const spOuter = match(/Shipping\s*Point[\s\S]*?(?=\n\s*(?:Consignee|Delivery\s*Address|Notify|Goods\s*Information|B\/L|HS\s*Code|$))/i, full);
  const lp = parseLabeledFields(spOuter, {
    street:  /^\s*Street\b/i,
    postal:  /^\s*Postal\b/i,
    city:    /^\s*City\b/i,
    country: /^\s*Country\b/i,
    wof:     /^\s*Way\s*of\s*Forwarding\b/i,
    terms:   /^\s*(?:Delivery\s*Terms|Incoterms)\b/i
  });

  let shipping_street  = stripPrefix(lp.street  || "");
  let shipping_postal  = stripPrefix(lp.postal  || "");
  let shipping_city    = stripPrefix(lp.city    || "");
  let shipping_country = stripPrefix(lp.country || "");

  if (!shipping_street && !shipping_city) {
    const spBlock = match(/Shipping\s*Point(?:\s*address)?[.:\-]?\s*([\s\S]*?)(?=\n\s*(?:Way of Forwarding|Delivery Terms|PRODUCT|Delivery Address|Consignee|Customer))/i, full);
    const sp = parseShippingPoint(spBlock);
    shipping_street  = shipping_street  || sp.street;
    shipping_postal  = shipping_postal  || sp.postal;
    shipping_city    = shipping_city    || sp.city;
    shipping_country = shipping_country || sp.country;
  }
  // Clean up “Street” that accidentally swallowed "Way of Forwarding"
  shipping_street = (shipping_street || "").replace(/\bWay\s*of\s*Forwarding.*$/i, "").replace(/^[\s:!•\-]+/, "");

  let way_of_forwarding =
    stripPrefix(lp.wof || grabNear(/Way\s*of\s*Forwarding/i, /([^\n]+)/i, full, 140) || match(/Way\s*of\s*Forwarding[.:\-]?\s*([^\n]+)/i, full) || "");
  let delivery_terms =
    stripPrefix(lp.terms || grabNear(/(?:Delivery\s*Terms|Incoterms)/i, /([^\n]+)/i, full, 100) || "");

  // ---------------- Carrier TO (prefer explicit section, then fallback) --------------
  let carrier_to = "";
  const labelCT = /CARRIER\s+NOTIFICATION\s+TO[:\s]*/i.exec(full);
  if (labelCT) {
    carrier_to = sanitizeCarrierToBlock(full.slice(labelCT.index + labelCT[0].length, labelCT.index + 600));
  } else {
    const m = /(Expeditors International GmbH[\s\S]{0,260})/i.exec(full);
    carrier_to = sanitizeCarrierToBlock(m ? m[1] : "");
  }

  // ---------------- Consignee / Delivery Address -------------------------------------
  let consignee_address = "";
  let consignee_block = match(/(?:Delivery\s*Address|Consignee)[.:\-]?\s*([\s\S]*?)\n\s*Customer\s*No/i, full);
  if (!consignee_block) {
    consignee_block = grabBlock(
      /(?:Delivery\s*Address|Consignee)[.:\-]?\s*/i,
      [/Customer\s*No/i, /Notify/i, /Marks/i, /Way of/i, /Shipping\s*Point/i, /Delivery\s*Terms/i],
      full,
      12
    );
  }
  if (consignee_block) {
    let lines = consignee_block.split("\n").map(l => clean(l)).filter(Boolean);
    const BAN = /(^(Buyer|VAT\s*No\.?)$)|KRONOS|Peschstrasse|Leverkusen/i;
    lines = lines.filter(l => !BAN.test(l));
    let addr = lines.join("\n");
    if (/NORDENHAM|LEVERKUSEN|NIEHL|MOLENKOPF/i.test(addr)) {
      const all = matchAll(/(?:Delivery\s*Address|Consignee)[.:\-]?\s*([\s\S]{0,300})/gi, full);
      for (const mm of all) {
        const candidate = clean(mm[1]).split("\n").map(l=>clean(l)).filter(Boolean).join("\n");
        if (!/NORDENHAM|LEVERKUSEN|NIEHL|MOLENKOPF/i.test(candidate) && candidate.length > 10) { addr = candidate; break; }
      }
    }
    consignee_address = clean(addr);
  }

  // ---------------- Customer numbers & contact (explicit fields only) ----------------
  const customer_no = match(/Customer\s*No[.:\-]?\s*([^\n]+)/i, full);
  const customer_po = match(/Customer\s*PO\s*No[.:\-]?\s*([^\n]+)/i, full);

  let customer_contact = stripPrefix(grabNear(/Customer\s*Contact/i, /([^\n]+)/i, full, 120));
  let customer_phone   = stripPrefix(grabNear(/Customer\s*Phone\s*Number/i, /([^\n]+)/i, full, 80));
  let customer_email   = findEmail(grabNear(/Customer\s*Email/i, /([^\n]+)/i, full, 140)) || "";

  // Business rule: never allow KRONOS email in customer email; never copy shipper phone
  if (/@kronosww\.com$/i.test(customer_email)) customer_email = "";
  if (customer_phone && shipper_phone && onlyDigits(customer_phone) === onlyDigits(shipper_phone)) {
    customer_phone = "";
  }

  // ---------------- Marks / B/L / HS Code -------------------------------------------
  const bl_remarks1 = clean(match(/B\/L\s*REMARKS[.:\-]?\s*([\s\S]*?)(?:\n\s*HS\s*CODE|(?:\n\s*MARKS)|\n\s*KRONOS|$)/i, full));
  const bl_express  = match(/PLEASE\s+ISSUE\s+EXPRESS\s+B\/L[^\n]*/i, full);
  const bl_remarks  = bl_remarks1 || bl_express || "";
  const hs_code     = (match(/HS\s*CODE[.:\-]?\s*([0-9 ]{4,})/i, full) || "").replace(/\s+/g, "");

  const order_label = match(/ORDER\s*No[.:\-]?\s*([A-Za-z0-9\/-]+)/i, full);

  // ---------------- Totals & items ---------------------------------------------------
  const t = /TOTAL\s*([0-9\.,]+)\s*KG\s*([0-9]+)\s*([0-9\.,]+)\s*KG/i.exec(full);
  const total_net_kg   = t ? parseFloat(t[1].replace(/\./g, "").replace(",", ".")) : null;
  const total_pkgs     = t ? parseInt(t[2], 10) : null;
  const total_gross_kg = t ? parseFloat(t[3].replace(/\./g, "").replace(",", ".")) : null;

  const itemMatches = matchAll(
    /(TITANIUM DIOXIDE[^\n]*?Type\s*\S+)[^\n]*?([0-9\.,]+)\s*KG\s+([0-9]+)\s+([0-9\.,]+)\s*KG[\s\S]*?(\d+\s*(?:PE-Bags|Paper Bags|Big Bag).*?)(?:\n(\d+)\s*Pallets?)?/gi,
    full
  );
  const items = itemMatches.map(m => {
    const product_name = clean(m[1]);
    const net_kg   = parseFloat(m[2].replace(/\./g, "").replace(",", ".")) || null;
    const pkgs     = parseInt(m[3], 10) || null;
    const gross_kg = parseFloat(m[4].replace(/\./g, "").replace(",", ".")) || null;
    const packaging = clean(m[5]);
    const pallets   = m[6] ? parseInt(m[6], 10) : null;
    return { product_name, net_kg, gross_kg, pkgs, packaging, pallets };
  });

  // ---------------- PO preference & tidy --------------------------------------------
  const po_no_explicit = match(/PO\s*No[.:\-]?\s*([A-Za-z0-9/ -]+)/i, full);
  const po_no = (order_label || po_no_explicit || customer_po || "").trim();

  const _shipment_no = stripPrefix(shipment_no);
  const _order_no    = stripPrefix(order_no);
  const _delivery_no = stripPrefix(delivery_no);
  const _po_no       = stripPrefix(po_no);
  const _customer_no = stripPrefix(customer_no);
  const _customer_po = stripPrefix(customer_po);
  const _order_label = stripPrefix(order_label);

  return {
    your_partner,
    shipper_phone,
    shipper_email,

    shipment_no: _shipment_no,
    order_no: _order_no,
    delivery_no: _delivery_no,
    loading_date,
    scheduled_delivery_date,

    po_no: _po_no,
    order_label: _order_label,

    shipping_street,
    shipping_postal,
    shipping_city,
    shipping_country,

    way_of_forwarding,
    delivery_terms,
    carrier_to,

    consignee_address,
    customer_no: _customer_no,
    customer_po: _customer_po,

    customer_contact,
    customer_phone,
    customer_email,

    notify1_address,
    notify1_email,
    notify1_phone,

    notify2_address,
    notify2_email,
    notify2_phone,

    total_net_kg,
    total_gross_kg,
    total_pkgs,
    bl_remarks,
    hs_code,

    signature_name: "",
    signature_date: dayjs().format("YYYY-MM-DD"),

    items
  };
}

// ---------- UI ----------
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Carrier Notification Letter</title>
<style>
  :root { --border:#E5E7EB; --bg:#F8FAFC; --card:#FFFFFF; --muted:#6B7280; --pri:#2563EB; }
  *{box-sizing:border-box;font-family:system-ui,Segoe UI,Inter,Roboto,Arial}
  body{margin:0;background:var(--bg);color:#0f172a}
  .container{max-width:900px;margin:28px auto;padding:0 16px}
  h1{font-size:28px;text-align:center;margin:0 0 18px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  label{display:block;font-size:12px;color:#374151;margin:8px 0 4px}
  input,textarea{width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);background:#fff}
  textarea{min-height:70px}
  .section-title{font-weight:600;border-bottom:1px solid var(--border);padding-bottom:6px;margin:6px 0 12px}
  .muted{color:var(--muted)}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .row4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:16px}
  .btn{background:var(--pri);color:#fff;border:none;border-radius:8px;padding:12px 14px;cursor:pointer}
  .btn-link{color:#2563EB;background:transparent;border:none;cursor:pointer;padding:0;margin:8px 0}
  .drop{border:2px dashed #cbd5e1;border-radius:10px;padding:12px;text-align:center;cursor:pointer}
  .product{background:#F9FAFB;border:1px solid var(--border);border-radius:8px;padding:12px;margin:8px 0}
  .product header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .footer-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:center}
  .list table{width:100%;border-collapse:collapse}
  .list th,.list td{border-bottom:1px solid var(--border);padding:8px;text-align:left;font-size:14px}
</style>
</head>
<body>
<div class="container">
  <h1>Carrier Notification Letter</h1>

  <div class="card">
    <div class="grid2">
      <div>
        <div class="section-title">KRONOS TITAN GmbH</div>
        <div class="muted">Peschstrasse 5, 51373 Leverkusen</div>
        <div class="muted" style="margin-top:8px">Drag & drop a carrier notification PDF to autofill:</div>
        <div id="drop" class="drop" style="margin-top:8px">Drop PDF here or click<input id="file" type="file" accept="application/pdf" hidden/></div>
        <div id="status" class="muted" style="margin-top:8px"></div>
      </div>
      <div>
        <div class="section-title">CARRIER NOTIFICATION TO:</div>
        <textarea id="carrier_to" placeholder="Expeditors International GmbH&#10;Mönchhofallee 10&#10;65479 RAUNHEIM&#10;GERMANY"></textarea>
      </div>
    </div>

    <div class="row">
      <div><label>Your Partner</label><input id="your_partner"/></div>
      <div><label>Telephone</label><input id="shipper_phone"/></div>
    </div>
    <div class="row">
      <div><label>Email</label><input id="shipper_email"/></div>
      <div></div>
    </div>

    <div class="row">
      <div><label>Shipment No.</label><input id="shipment_no"/></div>
      <div><label>Order No.</label><input id="order_no"/></div>
    </div>
    <div class="row">
      <div><label>Delivery No.</label><input id="delivery_no"/></div>
      <div></div>
    </div>
    <div class="row">
      <div><label>Loading Date</label><input id="loading_date" placeholder="dd.mm.yyyy"/></div>
      <div><label>Sched. Delivery Date</label><input id="scheduled_delivery_date" placeholder="dd.mm.yyyy"/></div>
    </div>
    <div class="row">
      <div><label>PO No.</label><input id="po_no"/></div>
      <div><label>Order Label</label><input id="order_label"/></div>
    </div>

    <div class="section-title" style="margin-top:8px">Shipping Point</div>
    <div class="row4">
      <div><label>Street</label><input id="shipping_street" placeholder="Titanstrasse, Gebäude B3"/></div>
      <div><label>Postal</label><input id="shipping_postal" placeholder="26954"/></div>
      <div><label>City</label><input id="shipping_city" placeholder="Nordenham"/></div>
      <div><label>Country</label><input id="shipping_country" placeholder="Germany"/></div>
    </div>

    <div class="row" style="margin-top:8px">
      <div><label>Way of Forwarding</label><input id="way_of_forwarding"/></div>
      <div><label>Delivery Terms</label><input id="delivery_terms"/></div>
    </div>
  </div>

  <div class="card">
    <div class="section-title">Consignee</div>
    <textarea id="consignee_address" placeholder="Enter Consignee address"></textarea>
    <div class="row">
      <div><label>Customer No.</label><input id="customer_no"/></div>
      <div><label>Customer PO No.</label><input id="customer_po"/></div>
    </div>
    <div class="row">
      <div><label>Customer Contact</label><input id="customer_contact"/></div>
      <div><label>Customer Phone Number</label><input id="customer_phone"/></div>
    </div>
    <div class="row">
      <div><label>Customer Email</label><input id="customer_email"/></div>
      <div></div>
    </div>
  </div>

  <div class="card">
    <div class="section-title">Notify Parties</div>
    <div class="row">
      <div>
        <label>Notify 1 (Address)</label>
        <textarea id="notify1_address" placeholder="Enter Notify Party 1 address"></textarea>
        <div class="row">
          <div><label>Notify 1 Email</label><input id="notify1_email" placeholder="name@domain.com"/></div>
          <div><label>Notify 1 Phone</label><input id="notify1_phone" placeholder="+30 ..."/></div>
        </div>
      </div>
      <div>
        <label>Notify 2 (Address)</label>
        <textarea id="notify2_address" placeholder="Enter Notify Party 2 address"></textarea>
        <div class="row">
          <div><label>Notify 2 Email</label><input id="notify2_email" placeholder=""/></div>
          <div><label>Notify 2 Phone</label><input id="notify2_phone" placeholder=""/></div>
        </div>
      </div>
    </div>
  </div>

  <div class="card" id="goodsCard">
    <div class="section-title">Goods Information</div>
    <div id="products"></div>
    <button class="btn-link" type="button" id="addProduct">+ Add Product</button>
  </div>

  <div class="card">
    <div class="section-title">B/L Remarks & Instructions</div>
    <textarea id="bl_remarks"></textarea>
    <label style="margin-top:8px">HS Code</label>
    <input id="hs_code"/>
  </div>

  <div class="card">
    <div class="footer-row">
      <div>
        <div class="muted">Sincerely,</div>
        <label>Your Name</label>
        <input id="signature_name" placeholder="Authorized Signature"/>
      </div>
      <div>
        <label>Date</label>
        <input id="signature_date"/>
      </div>
    </div>
  </div>

  <div class="card">
    <button class="btn" type="button" id="submitBtn">Submit Notification</button>
  </div>

  <div class="card list">
    <div class="section-title">Past Notifications</div>
    <div id="recent"></div>
  </div>
</div>

<script>
var $ = function(sel){ return document.querySelector(sel); };
var statusEl = $("#status");
var prodWrap = $("#products");

// product card
function makeProductCard(idx, data){
  data = data || {};
  var div = document.createElement('div');
  div.className = 'product';
  var html = ''
    + '<header>'
    +   '<strong>Product ' + (idx+1) + '</strong>'
    +   '<button class="btn-link" type="button">Remove Product</button>'
    + '</header>'
    + '<label>Product Name</label>'
    + '<input name="product_name" value="' + (data.product_name||'') + '">'
    + '<div class="row">'
    +   '<div><label>Net Weight (KG)</label><input name="net_kg" value="' + (data.net_kg||'') + '"></div>'
    +   '<div><label>Gross Weight (KG)</label><input name="gross_kg" value="' + (data.gross_kg||'') + '"></div>'
    + '</div>'
    + '<div class="row">'
    +   '<div><label>No. Packages</label><input name="pkgs" value="' + (data.pkgs||'') + '"></div>'
    +   '<div><label>Packaging</label><input name="packaging" value="' + (data.packaging||'') + '"></div>'
    + '</div>'
    + '<div class="row">'
    +   '<div><label>Pallets</label><input name="pallets" value="' + (data.pallets||'') + '"></div>'
    +   '<div></div>'
    + '</div>';
  div.innerHTML = html;
  div.querySelector('button').onclick = function(){ div.remove(); renumberProducts(); };
  return div;
}
function renumberProducts(){
  var hs = prodWrap.querySelectorAll('.product header strong');
  for (var i=0;i<hs.length;i++){ hs[i].textContent = 'Product ' + (i+1); }
}
function addProduct(data){ prodWrap.appendChild(makeProductCard(prodWrap.children.length, data)); }

// upload handlers
var drop = $("#drop"), file = $("#file");
drop.addEventListener("click", function(){ file.click(); });
drop.addEventListener("dragover", function(e){ e.preventDefault(); });
drop.addEventListener("drop", function(e){ e.preventDefault(); handleFiles(e.dataTransfer.files); });
file.addEventListener("change", function(e){ handleFiles(e.target.files); });

// upload (nocache=1 while iterating)
async function handleFiles(files){
  var f = files[0]; if (!f) return;
  statusEl.textContent = "Uploading & extracting…";
  try {
    var fd = new FormData();
    fd.append("file", f);

    var ctrl = new AbortController();
    var to = setTimeout(function(){ ctrl.abort(); }, 180000);

    var r = await fetch("/api/upload?nocache=1", { method: "POST", body: fd, signal: ctrl.signal });
    clearTimeout(to);

    var raw = await r.text();
    var js;
    try { js = JSON.parse(raw); } catch(e){ js = { error: "Non-JSON response", raw: raw }; }

    if (!r.ok) {
      statusEl.textContent = js.error || ("Upload failed (" + r.status + ")");
      console.error("Upload error response:", js.raw || js);
      return;
    }

    var conf = (typeof js.confidence === "number") ? (" (confidence " + Math.round(js.confidence) + "%)") : "";
    var warn = (js.warnings && js.warnings.length) ? " — Check: " + js.warnings.join("; ") : "";
    statusEl.textContent = "Parsed" + conf + ". Review the form." + warn;

    fillForm(js);
  } catch (err) {
    statusEl.textContent = "Network/timeout: " + err.message;
    console.error(err);
  }
}

function setVal(id, val){ var el = document.getElementById(id); if(el) el.value = val || ""; }

function fillForm(d){
  setVal("carrier_to", d.carrier_to);
  setVal("your_partner", d.your_partner);
  setVal("shipper_phone", d.shipper_phone);
  setVal("shipper_email", d.shipper_email);

  setVal("shipment_no", d.shipment_no);
  setVal("order_no", d.order_no);
  setVal("delivery_no", d.delivery_no);
  setVal("loading_date", d.loading_date);
  setVal("scheduled_delivery_date", d.scheduled_delivery_date);
  setVal("po_no", d.po_no);
  setVal("order_label", d.order_label);

  setVal("shipping_street", d.shipping_street);
  setVal("shipping_postal", d.shipping_postal);
  setVal("shipping_city", d.shipping_city);
  setVal("shipping_country", d.shipping_country);

  setVal("way_of_forwarding", d.way_of_forwarding);
  setVal("delivery_terms", d.delivery_terms);

  setVal("consignee_address", d.consignee_address);
  setVal("customer_no", d.customer_no);
  setVal("customer_po", d.customer_po);
  setVal("customer_contact", d.customer_contact);
  setVal("customer_phone", d.customer_phone);
  setVal("customer_email", d.customer_email);

  setVal("notify1_address", d.notify1_address);
  setVal("notify1_email", d.notify1_email);
  setVal("notify1_phone", d.notify1_phone);
  setVal("notify2_address", d.notify2_address);
  setVal("notify2_email", d.notify2_email);
  setVal("notify2_phone", d.notify2_phone);

  setVal("bl_remarks", d.bl_remarks);
  setVal("hs_code", d.hs_code);
  setVal("signature_name", d.signature_name);
  setVal("signature_date", d.signature_date || new Date().toISOString().slice(0,10));

  prodWrap.innerHTML = "";
  var items = (d.items && d.items.length) ? d.items : [{},{}];
  for (var i=0;i<items.length;i++) addProduct(items[i]);
  loadRecent();
}

document.getElementById("addProduct").onclick = function(){ addProduct({}); };
document.getElementById("submitBtn").onclick = async function(){
  var body = {
    carrier_to: $("#carrier_to").value,
    your_partner: $("#your_partner").value,
    shipper_phone: $("#shipper_phone").value,
    shipper_email: $("#shipper_email").value,

    shipment_no: $("#shipment_no").value,
    order_no: $("#order_no").value,
    delivery_no: $("#delivery_no").value,
    loading_date: $("#loading_date").value,
    scheduled_delivery_date: $("#scheduled_delivery_date").value,
    po_no: $("#po_no").value,
    order_label: $("#order_label").value,

    shipping_street: $("#shipping_street").value,
    shipping_postal: $("#shipping_postal").value,
    shipping_city: $("#shipping_city").value,
    shipping_country: $("#shipping_country").value,

    way_of_forwarding: $("#way_of_forwarding").value,
    delivery_terms: $("#delivery_terms").value,

    consignee_address: $("#consignee_address").value,
    customer_no: $("#customer_no").value,
    customer_po: $("#customer_po").value,
    customer_contact: $("#customer_contact").value,
    customer_phone: $("#customer_phone").value,
    customer_email: $("#customer_email").value,

    notify1_address: $("#notify1_address").value,
    notify1_email: $("#notify1_email").value,
    notify1_phone: $("#notify1_phone").value,
    notify2_address: $("#notify2_address").value,
    notify2_email: $("#notify2_email").value,
    notify2_phone: $("#notify2_phone").value,

    bl_remarks: $("#bl_remarks").value,
    hs_code: $("#hs_code").value,
    signature_name: $("#signature_name").value,
    signature_date: $("#signature_date").value,

    items: [].map.call(prodWrap.querySelectorAll(".product"), function(div){
      return {
        product_name: div.querySelector('input[name="product_name"]').value,
        net_kg: parseFloat(div.querySelector('input[name="net_kg"]').value || 0) || null,
        gross_kg: parseFloat(div.querySelector('input[name="gross_kg"]').value || 0) || null,
        pkgs: parseInt(div.querySelector('input[name="pkgs"]').value || 0) || null,
        packaging: div.querySelector('input[name="packaging"]').value || null,
        pallets: parseInt(div.querySelector('input[name="pallets"]').value || 0) || null
      };
    })
  };

  var r = await fetch("/api/save", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  var js = await r.json();
  statusEl.textContent = r.ok ? ("Saved. ID: " + js.id) : (js.error || "Save failed");
  if (r.ok) loadRecent();
};

async function loadRecent(){
  var r = await fetch("/api/shipments");
  var rows = await r.json();
  var h = '<table><thead><tr><th>Created</th><th>Shipment</th><th>Order</th><th>Consignee</th><th>Total Net (kg)</th></tr></thead><tbody>';
  (rows||[]).forEach(function(s){
    h += '<tr><td>' + s.created_at + '</td><td>' + (s.shipment_no||'') + '</td><td>' + (s.order_no||'') + '</td><td>' + ((s.consignee_address||'').split('\\n')[0]||'') + '</td><td>' + (s.total_net_kg||'') + '</td></tr>';
  });
  h += '</tbody></table>';
  document.querySelector('#recent').innerHTML = h;
}
document.getElementById("signature_date").value = new Date().toISOString().slice(0,10);
</script>
</body></html>`);
});

// ---------- API ----------
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const noCache = String(req.query.nocache || "") === "1";
    const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

    if (!noCache) {
      const cached = db.prepare("SELECT parsed FROM cache WHERE hash = ?").get(hash);
      if (cached?.parsed) {
        const parsed = JSON.parse(cached.parsed);
        return res.json(parsed);
      }
    }

    const text = await extractTextFromBuffer(req.file.buffer);
    if (!text || !text.trim()) {
      return res.status(422).json({ error: "Unable to extract text (try /api/debug-text to inspect raw text)" });
    }

    const fields = parseFieldsFromText(text);
    const { score, warnings } = validateAndScore(fields);
    fields.confidence = score;
    fields.warnings = warnings;

    if (!noCache) {
      db.prepare("INSERT OR REPLACE INTO cache (hash, text, parsed, created_at) VALUES (?, ?, ?, ?)")
        .run(hash, text, JSON.stringify(fields), new Date().toISOString());
    }

    res.json(fields);
  } catch (err) {
    console.error("Upload failed:", err);
    res.status(500).json({ error: "Server error: " + (err.message || "unknown") });
  }
});

// Debug endpoint
app.post("/api/debug-text", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const txt = await extractTextFromBuffer(req.file.buffer);
    res.type("text/plain").send(txt || "(no text extracted)");
  } catch (e) {
    res.status(500).json({ error: "debug failed" });
  }
});

app.post("/api/save", (req, res) => {
  const s = req.body || {};
  const id = nanoid();
  const created_at = dayjs().toISOString();
  try {
    db.prepare(`
      INSERT INTO shipments (
        id, created_at, your_partner, shipper_phone, shipper_email,
        shipment_no, order_no, delivery_no, loading_date, scheduled_delivery_date,
        po_no, order_label,
        shipping_street, shipping_postal, shipping_city, shipping_country,
        way_of_forwarding, delivery_terms, carrier_to, consignee_address,
        customer_no, customer_po, customer_contact, customer_phone, customer_email,
        notify1_address, notify1_email, notify1_phone, notify2_address, notify2_email, notify2_phone,
        total_net_kg, total_gross_kg, total_pkgs,
        bl_remarks, hs_code, signature_name, signature_date
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, created_at, s.your_partner, s.shipper_phone, s.shipper_email,
      s.shipment_no, s.order_no, s.delivery_no, s.loading_date, s.scheduled_delivery_date,
      s.po_no, s.order_label,
      s.shipping_street, s.shipping_postal, s.shipping_city, s.shipping_country,
      s.way_of_forwarding, s.delivery_terms, s.carrier_to, s.consignee_address,
      s.customer_no, s.customer_po, s.customer_contact, s.customer_phone, s.customer_email,
      s.notify1_address, s.notify1_email, s.notify1_phone, s.notify2_address, s.notify2_email, s.notify2_phone,
      s.total_net_kg ?? null, s.total_gross_kg ?? null, s.total_pkgs ?? null,
      s.bl_remarks, s.hs_code, s.signature_name, s.signature_date
    );

    const insItem = db.prepare(`
      INSERT INTO items (id, shipment_id, product_name, net_kg, gross_kg, pkgs, packaging, pallets)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    (Array.isArray(s.items) ? s.items : []).forEach(it => {
      insItem.run(nanoid(), id,
        it.product_name || null,
        it.net_kg ?? null,
        it.gross_kg ?? null,
        it.pkgs ?? null,
        it.packaging || null,
        it.pallets ?? null
      );
    });

    res.json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Save failed" });
  }
});

app.get("/api/shipments", (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.shipment_id = s.id) as item_count
      FROM shipments s
      ORDER BY datetime(s.created_at) DESC
      LIMIT 100
    `).all();
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB failed" });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on :" + PORT));
