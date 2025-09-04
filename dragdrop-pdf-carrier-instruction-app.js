require('dotenv').config();
/**
 * Carrier Notification Letter (with Drafts, Comments, Freeze)
 * - PDF → Draft v1 (server) → Review w/ comments → Freeze → Final shipment
 * - This version adds optional OpenAI JSON extraction/refinement.
 *
 * ENV:
 *   OPENAI_API_KEY=sk-...
 *   USE_OPENAI_EXTRACT=1                 # turn on model-assisted extraction
 *   OPENAI_MODEL=gpt-4o-mini             # optional, defaults to gpt-4o-mini
 *   SQLITE_DB_PATH=shipments.db          # optional
 */

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

// ---------- NEW: OpenAI (optional) ----------
const useOpenAI = !!process.env.USE_OPENAI_EXTRACT && !!process.env.OPENAI_API_KEY;
let OpenAI = null;
if (useOpenAI) {
  try {
    OpenAI = require("openai");
  } catch (e) {
    console.warn("OpenAI client not installed. Run: npm i openai");
  }
}
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ---------- DB ----------
const DB_PATH = process.env.SQLITE_DB_PATH || "shipments.db";
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
try { db.pragma("journal_mode = WAL"); } catch (_){}

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
    vat_no TEXT,
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
    created_at TEXT,
    llm_json TEXT
  )
`).run();

/* Drafts */
db.prepare(`
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    base_hash TEXT,
    version_no INTEGER,
    status TEXT,
    data_json TEXT,
    created_at TEXT,
    updated_at TEXT
  )
`).run();

db.prepare(`
  CREATE UNIQUE INDEX IF NOT EXISTS ix_drafts_hash_ver
  ON drafts (base_hash, version_no)
`).run();

/* Comments */
db.prepare(`
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    draft_id TEXT,
    field_name TEXT,
    message TEXT,
    author TEXT,
    created_at TEXT,
    FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
  )
`).run();

// auto-migrate (idempotent)
function ensureColumns(table, cols) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  const namesLC = new Set(existing.map(r => String(r.name).toLowerCase()));
  for (const [name, type] of Object.entries(cols)) {
    const want = String(name).toLowerCase();
    if (!namesLC.has(want)) {
      try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run(); }
      catch (e) { if (!/duplicate column name/i.test(String(e))) throw e; }
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
  notify2_phone: "TEXT",
  vat_no: "TEXT"
});
ensureColumns("items", { packaging: "TEXT", pallets: "INTEGER" });

// ---------- App ----------
const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));
const upload = multer({ storage: multer.memoryStorage() });

// ---------- Helpers ----------
function clean(s) {
  return (s || "")
    .replace(/\u00A0/g, " ")
    .replace(/[‐–—−]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/[：]/g, ":")
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

  score = Math.max(5, Math.min(100, score));
  return { score, warnings: warn };
}

function match(re, text, i = 1) { const m = re.exec(text); return m ? clean(m[i]) : ""; }
function matchAll(re, text) { const out = []; let m; while ((m = re.exec(text)) !== null) out.push(m); return out; }
function normalizeEmailSpaces(s) { return (s || "").replace(/@([^\s]+)/g, (_, rest) => '@' + rest.replace(/\s+/g, '')); }
function findEmail(line) {
  const cleaned = normalizeEmailSpaces(line || "");
  const m = cleaned.match(/\b[A-Z0-9][A-Z0-9._%+-]*@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return m ? m[0].replace(/^[.\-_:;]+/, "") : "";
}
function grabNear(labelRe, valueRe, text, windowChars = 120) {
  const m = labelRe.exec(text);
  if (!m) return "";
  const start = m.index + m[0].length;
  const seg   = text.slice(start, Math.min(text.length, start + windowChars));
  const mv    = valueRe.exec(seg);
  return mv ? clean(mv[1] ?? mv[0]) : "";
}
function grabBlock(labelRe, stopRes, text, maxLines = 8) {
  const m = labelRe.exec(text);
  if (!m) return "";
  const tail = text.slice(m.index + m[0].length);
  const lines = tail.split("\n").map(l => clean(l));
  const out = [];
  for (const line of lines) {
    if (!line) break;
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
function sanitizeCarrierToBlock(s) {
  if (!s) return "";
  const DROP = /(Your\s*Partner|Telephone|Phone|Email|Shipment\s*No|Order\s*No|Delivery\s*No|Loading\s*Date|Shipping\s*Point|Street|Postal|City|Country|Way\s*of\s*Forwarding|Delivery\s*Terms|Incoterms)/i;
  const out = [];
  for (const raw of s.split("\n")) {
    const line = clean(raw);
    if (!line) { if (out.length) break; continue; }
    if (DROP.test(line)) break;
    out.push(line);
    if (out.length > 8) break;
  }
  return out.join("\n");
}
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
        for (const other of Object.values(labels)) val = val.replace(other, "").trim();
        res[key] = clean(val);
      }
    }
  }
  return res;
}
function parseNotify(fullText, which = 1) {
  let address = "", email = "", phone = "";
  const stop = [/Notify\s*2/i, /Notify\s*1/i, /Goods\s*Information/i, /B\/L/i, /HS\s*Code/i, /KRONOS/i, /Customer/i, /Order/i, /Shipping\s*Point/i];
  let block = grabBlock(which === 1 ? /Notify\s*1[.:\-]?\s*/i : /Notify\s*2[.:\-]?\s*/i, stop, fullText, 12);
  if (!block) {
    block = which === 1
      ? match(/Notify[.:\-]?\s*([\s\S]*?)(?=\n\s*(?:MARKS\s*TEXT|NOTIFY\s*2|ORDER\s*No|B\/L|HS\s*CODE|KRONOS|$))/i, fullText)
      : match(/NOTIFY\s*2[.:\-]?\s*([\s\S]*?)(?=\n\s*(?:PLEASE\s+ISSUE|B\/L|HS\s*CODE|MARKS|KRONOS|$))/i, fullText);
  }
  if (block) {
    const lines = block.split("\n").map(l => clean(l)).filter(Boolean);
    const addr = [];
    for (const line of lines) {
      const m = findEmail(line);
      if (m) { email = m; continue; }
      if (/Tel\.|Phone|^\+?\d[\d ()/.\-]*$/.test(line)) { phone = line.replace(/^.*?(Tel\.|Phone)\s*:?\s*/i,""); continue; }
      if (/Vat\s*No\./i.test(line)) continue;
      addr.push(line);
    }
    address = addr.join("\n");
  }
  return { address, email, phone };
}

// ---------- Extraction ----------
async function extractTextFromBuffer(pdfBuffer) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carrier-"));
  const pdfPath = path.join(tmp, "input.pdf");
  fs.writeFileSync(pdfPath, pdfBuffer);

  const run = (cmd, args) => new Promise((res) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 }, (err, out) => res(err ? "" : out.toString("utf8")));
  });

  const pPdfParse = (async () => { try { const a = await pdfParse(pdfBuffer); return a?.text || ""; } catch { return ""; } })();
  // prefer bbox-layout (richer structure); keep classic layout as alternate later when we re-run in /api/upload
  const pPdftotext = run("pdftotext", ["-bbox-layout", "-enc", "UTF-8", "-nopgbrk", "-q", pdfPath, "-"]);
  const pOCR = (async () => {
    try {
      const ppmPrefix = path.join(os.tmpdir(), "carrier-" + nanoid());
      await run("pdftoppm", ["-r", "300", pdfPath, ppmPrefix, "-png"]);
      const dir = path.dirname(ppmPrefix);
      const base = path.basename(ppmPrefix);
      const pngs = fs.readdirSync(dir).filter(f => f.startsWith(base) && f.endsWith(".png")).sort();
      if (!pngs.length) return "";
      let ocrText = "";
      for (const f of pngs) {
        const inP = path.join(dir, f), outP = path.join(dir, "prep-" + f);
        await run("convert", [inP, "-deskew", "40%", "-strip", "-colorspace", "Gray",
                              "-contrast-stretch", "1%x1%", "-brightness-contrast", "10x15",
                              "-sharpen", "0x1", "-threshold", "60%", outP]);
        // multi-lang helps (eng+deu common for these docs)
        ocrText += "\n" + await run("tesseract", [outP, "stdout", "--psm", "4", "--oem", "1", "-l", "eng+deu"]);
      }
      return ocrText;
    } catch { return ""; }
  })();

  const [t1, t2, t3] = await Promise.all([pPdfParse, pPdftotext, pOCR]);
  const candidates = [t1, t2, t3].filter(Boolean);
  if (!candidates.length) return "";

  const best = candidates.map(t => ({ t, score: scoreText(t) }))
                         .sort((a, b) => b.score - a.score)[0].t;
  return best;
}
function scoreText(txt) {
  if (!txt) return 0;
  const keys = ["Shipment", "Order", "Delivery", "Delivery Address", "Notify", "TOTAL", "Way of Forwarding", "MARKS"];
  const keyHits = keys.reduce((n, k) => n + (txt.includes(k) ? 1 : 0), 0);
  const numbers = (txt.match(/\b\d{5,}\b/g) || []).length;
  const dates = (txt.match(/\b\d{2}[./-]\d{2}[./-]\d{2,4}\b/g) || []).length;
  const lenScore = Math.min(20, Math.floor(txt.length / 2000));
  return keyHits * 10 + Math.min(20, numbers) + Math.min(10, dates) + lenScore;
}

// ---------- Parser ----------
function parseFieldsFromText(textRaw) {
  const full = clean(textRaw).replace(/\r/g, "");
  const norm = full.replace(/[\t\f]+/g, " ");

  // Header
  const top = full.slice(0, 2000);
  const anchor = top.search(/Your\s*Partner|Telephone|Email/i);
  const headerBlock = anchor >= 0 ? top.slice(Math.max(0, anchor - 80), anchor + 600) : top.slice(0, 600);

  const your_partner = stripPrefix(grabNear(/Your\s*Partner[.:\-]?/i, /([^\n]+)/i, headerBlock, 100));
  let shipper_phone  = stripPrefix(grabNear(/(?:Telephone|Phone)[.:\-]?/i, /(\+?[0-9][0-9 ()\/\-]+)/i, headerBlock, 120));
  let shipper_email  = findEmail(grabNear(/Email[.:\-]?/i, /([^\n]+)/i, headerBlock, 140)) || "";

  // IDs & dates
  const grabNum = (lab) => grabNear(lab, /([0-9]{4,}[0-9A-Za-z\-]*)/, full, 120) || "";
  const shipment_no = grabNum(/Shipment\s*No\b/i);
  const order_no    = grabNum(/Order\s*No\b/i);
  const delivery_no = grabNum(/Delivery\s*No\b/i);

  const grabDate = (lab) => grabNear(lab, /([0-9]{2}[.\-\/][0-9]{2}[.\-\/][0-9]{2,4})/, full, 90) || "";
  const loading_date = grabDate(/Loading\s*Date\b/i);
  let scheduled_delivery_date =
    grabDate(/Sched\.?(?:uled)?\s*Delivery\s*Date\b/i) ||
    (function(){ const m = /(Sched\.?(?:uled)?\s*Delivery\s*Date[^\d]{0,30})(\d{2}[.\-\/]\d{2}[.\-\/]\d{2,4})/i.exec(full); return m ? m[2] : ""; })();

  // Shipping Point / Way / Terms
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
  shipping_street = (shipping_street || "").replace(/\bWay\s*of\s*Forwarding.*$/i, "").replace(/^[\s:!•\-]+/, "");

  let way_of_forwarding =
    stripPrefix(lp.wof || grabNear(/Way\s*of\s*Forwarding/i, /([^\n]+)/i, full, 140) || match(/Way\s*of\s*Forwarding[.:\-]?\s*([^\n]+)/i, full) || "");
  let delivery_terms =
    stripPrefix(lp.terms || grabNear(/(?:Delivery\s*Terms|Incoterms)/i, /([^\n]+)/i, full, 100) || "");

  // Carrier TO
  let carrier_to = "";
  const labelCT = /CARRIER\s+NOTIFICATION\s+TO[:\s]*/i.exec(full);
  if (labelCT) {
    carrier_to = sanitizeCarrierToBlock(full.slice(labelCT.index + labelCT[0].length, labelCT.index + 600));
  } else {
    const m = /(Expeditors International GmbH[\s\S]{0,260})/i.exec(full);
    carrier_to = sanitizeCarrierToBlock(m ? m[1] : "");
  }

  // Consignee
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

  // Customer explicit fields
  const customer_no = match(/Customer\s*No[.:\-]?\s*([^\n]+)/i, full);
  const customer_po = match(/Customer\s*PO\s*No[.:\-]?\s*([^\n]+)/i, full);
  let customer_contact = stripPrefix(grabNear(/Customer\s*Contact/i, /([^\n]+)/i, full, 120));
  let customer_phone   = stripPrefix(grabNear(/Customer\s*Phone\s*Number/i, /([^\n]+)/i, full, 80));
  let customer_email   = findEmail(grabNear(/Customer\s*Email/i, /([^\n]+)/i, full, 140)) || "";

  // Guard
  if (/@kronosww\.com$/i.test(customer_email)) customer_email = "";
  if (customer_phone && shipper_phone && onlyDigits(customer_phone) === onlyDigits(shipper_phone)) {
    customer_phone = "";
  }

  // VAT number
  let vat_no = "";
  const vatM = /\bVAT\s*No\.?\s*[:\-]?\s*([A-Z]{1,3}[- ]?\d[\d\- ]{4,})/i.exec(full);
  if (vatM) vat_no = clean(vatM[1]).replace(/\s+/g, "");

  // Notify
  const n1 = parseNotify(full, 1);
  const n2 = parseNotify(full, 2);
  const notify1_address = n1.address || "";
  const notify1_email   = n1.email   || "";
  const notify1_phone   = n1.phone   || "";
  const notify2_address = n2.address || "";
  const notify2_email   = n2.email   || "";
  const notify2_phone   = n2.phone   || "";

  // MARKS & LABELLING → remarks
  const marksBlock = match(/MARKS?\s*TEXT[.:\-]?\s*([\s\S]*?)(?=\n\s*(?:LABELLING|Notify|NOTIFY|B\/L|HS\s*CODE|Goods|KRONOS|$))/i, full);
  const labellingBlock = match(/LABELLING[.:\-]?\s*([\s\S]*?)(?=\n\s*(?:ORDER\s*No|Notify|NOTIFY|B\/L|HS\s*CODE|KRONOS|$))/i, full);

  const bl_remarks1 = clean(match(/B\/L\s*REMARKS[.:\-]?\s*([\s\S]*?)(?:\n\s*HS\s*CODE|(?:\n\s*MARKS)|\n\s*KRONOS|$)/i, full));
  const bl_express  = match(/PLEASE\s+ISSUE\s+EXPRESS\s+B\/L[^\n]*/i, full);

  const blParts = [];
  if (bl_remarks1) blParts.push(bl_remarks1);
  if (bl_express)  blParts.push(bl_express);
  if (marksBlock)  blParts.push("MARKS TEXT:\n" + clean(marksBlock));
  if (labellingBlock) blParts.push("LABELLING:\n" + clean(labellingBlock));
  const bl_remarks  = blParts.join("\n\n").trim();

  const hs_code     = (match(/HS\s*CODE[.:\-]?\s*([0-9 ]{4,})/i, full) || "").replace(/\s+/g, "");
  const order_label = match(/ORDER\s*No[.:\-]?\s*([A-Za-z0-9\/-]+)/i, full);

  // Totals & items
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
    vat_no,
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

// ---------- NEW: OpenAI JSON schema & reconciliation ----------
const extractionSchema = {
  name: "ShipmentExtraction",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      your_partner: { type: "string" },
      shipper_phone: { type: "string" },
      shipper_email: { type: "string" },
      shipment_no: { type: "string" },
      order_no: { type: "string" },
      delivery_no: { type: "string" },
      loading_date: { type: "string" },
      scheduled_delivery_date: { type: "string" },
      po_no: { type: "string" },
      order_label: { type: "string" },
      shipping_street: { type: "string" },
      shipping_postal: { type: "string" },
      shipping_city: { type: "string" },
      shipping_country: { type: "string" },
      way_of_forwarding: { type: "string" },
      delivery_terms: { type: "string" },
      carrier_to: { type: "string" },
      consignee_address: { type: "string" },
      customer_no: { type: "string" },
      vat_no: { type: "string" },
      customer_po: { type: "string" },
      customer_contact: { type: "string" },
      customer_phone: { type: "string" },
      customer_email: { type: "string" },
      notify1_address: { type: "string" },
      notify1_email: { type: "string" },
      notify1_phone: { type: "string" },
      notify2_address: { type: "string" },
      notify2_email: { type: "string" },
      notify2_phone: { type: "string" },
      total_net_kg: { type: ["number","null"] },
      total_gross_kg: { type: ["number","null"] },
      total_pkgs: { type: ["integer","null"] },
      bl_remarks: { type: "string" },
      hs_code: { type: "string" },
      signature_name: { type: "string" },
      signature_date: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            product_name: { type: "string" },
            net_kg: { type: ["number","null"] },
            gross_kg: { type: ["number","null"] },
            pkgs: { type: ["integer","null"] },
            packaging: { type: ["string","null"] },
            pallets: { type: ["integer","null"] }
          },
          required: ["product_name"]
        }
      },
      evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            field: { type: "string" },
            value: { type: "string" },
            snippet: { type: "string" },
            start: { type: ["integer","null"] },
            end: { type: ["integer","null"] },
            source: { type: "string" }
          },
          required: ["field","value","snippet","source"]
        }
      }
    },
    required: ["items"]
  }
};

async function openaiExtract({ textBest, alternates, seedFields }) {
  if (!useOpenAI || !OpenAI) return { ...seedFields, evidence: [] };

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const MAX = 120_000;
  const best = (textBest || "").slice(0, MAX);
  const p1 = (alternates?.pdfParse || "").slice(0, MAX);
  const p2 = (alternates?.pdftotext || "").slice(0, MAX);
  const p3 = (alternates?.ocr || "").slice(0, MAX);

  const system = [
    "You extract shipping fields from noisy PDFs.",
    "Return STRICT JSON that matches the provided JSON Schema.",
    "Prefer exact substrings; do not invent values.",
    "Normalize dates to dd.mm.yyyy if possible; else yyyy-mm-dd.",
    "Leave a field empty if uncertain; do not guess.",
    "Provide evidence snippets for fields you populate."
  ].join(" ");

  const user = [
    "PRIMARY TEXT:\n<<<", best, ">>>",
    p1 ? "\n\nALT pdf-parse:\n<<<" + p1 + ">>>" : "",
    p2 ? "\n\nALT pdftotext:\n<<<" + p2 + ">>>" : "",
    p3 ? "\n\nALT ocr:\n<<<" + p3 + ">>>" : "",
    "\n\nSEED FIELDS (regex parser output; you may correct):\n",
    JSON.stringify(seedFields, null, 2)
  ].join("");

  const resp = await client.responses.create({
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    response_format: {
      type: "json_schema",
      json_schema: extractionSchema
    }
  });

  const out = resp.output_json ?? (() => {
    try { return JSON.parse(resp.output_text || "{}"); } catch { return {}; }
  })();

  // Merge: keep seed defaults, prefer LLM non-empty values
  const { evidence = [], ...llmFields } = out || {};
  const final = { ...seedFields };
  for (const [k, v] of Object.entries(llmFields)) {
    if (k === "items") {
      if (Array.isArray(v) && v.length) final.items = v;
      continue;
    }
    if (v === null) continue;
    if (typeof v === "string") {
      if (v.trim()) final[k] = v;
    } else {
      final[k] = v;
    }
  }
  return { ...final, evidence: Array.isArray(evidence) ? evidence : [] };
}

// ---------- UI ----------
app.get("/", (_req, res) => {
// ---------- UI (drop-in replacement) ----------
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Shipping Instruction</title>
<style>
  :root { --border:#E5E7EB; --bg:#F8FAFC; --card:#FFFFFF; --muted:#6B7280; --pri:#2563EB; --danger:#b91c1c; --ok:#065f46; }
  *{box-sizing:border-box;font-family:system-ui,Segoe UI,Inter,Roboto,Arial}
  body{margin:0;background:var(--bg);color:#0f172a}
  .container{max-width:980px;margin:28px auto;padding:0 16px}
  h1{font-size:28px;text-align:center;margin:0 0 18px}
  h2{font-size:16px;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid var(--border)}
  .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}
  .grid4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:16px}
  label{display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;margin:8px 0 4px}
  input,textarea{width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);background:#fff}
  textarea{min-height:70px}
  .muted{color:var(--muted)}
  .btn{display:inline-block;text-decoration:none;text-align:center;background:var(--pri);color:#fff;border:none;border-radius:8px;padding:10px 12px;cursor:pointer}
  .btn[disabled]{opacity:.6;cursor:not-allowed}
  .btn-link{color:#2563EB;background:transparent;border:none;cursor:pointer;padding:0;margin:8px 0}
  .drop{border:2px dashed #cbd5e1;border-radius:10px;padding:12px;text-align:center;cursor:pointer}
  .status{margin-top:8px;font-size:13px}
  .status.ok{color:var(--ok)}
  .status.err{color:var(--danger)}
  .badge{display:inline-block;font-size:11px;background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:999px;padding:2px 8px}
  .cm{border:1px solid #cbd5e1;border-radius:6px;font-size:11px;padding:2px 6px;background:#f8fafc;cursor:pointer}
  .cm:hover{background:#eef2ff}
  .count{font-size:11px;color:#6b7280}
  .toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .product{background:#F9FAFB;border:1px solid var(--border);border-radius:8px;padding:12px;margin:8px 0}
  .product header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .list table{width:100%;border-collapse:collapse}
  .list th,.list td{border-bottom:1px solid var(--border);padding:8px;text-align:left;font-size:14px}
</style>
</head>
<body>
<div class="container">
  <h1>Shipping Instruction <span id="draftBadge" class="badge" style="display:none"></span></h1>

  <!-- Import & Create draft -->
  <div class="card">
    <div class="grid2">
      <div>
        <div class="muted">Drop your PDF to auto-fill a Draft v1:</div>
        <div id="drop" class="drop" style="margin-top:8px">Drop PDF here or click<input id="file" type="file" accept="application/pdf" hidden/></div>
        <div id="status" class="muted status"></div>
      </div>
      <div>
        <div class="muted">Confidence & checks will appear here after upload.</div>
      </div>
    </div>
  </div>

  <!-- 1. Shipper (Exporter) -->
  <div class="card">
    <h2>1. Shipper (Exporter)</h2>
    <div class="grid2">
      <div>
        <label>Company name <button class="cm" data-field="your_partner">💬</button> <span class="count" id="cnt_your_partner"></span></label>
        <input id="shipper_company" placeholder="Company name"/>
      </div>
      <div>
        <label>Contact person <button class="cm" data-field="shipper_contact">💬</button> <span class="count" id="cnt_shipper_contact"></span></label>
        <input id="shipper_contact" placeholder="Full name"/>
      </div>
    </div>
    <label>Address</label>
    <textarea id="shipper_address" placeholder="Street, Postal, City, Country"></textarea>
    <div class="grid2">
      <div>
        <label>Email / Phone <button class="cm" data-field="shipper_email">💬</button> <span class="count" id="cnt_shipper_email"></span></label>
        <input id="shipper_email" placeholder="email@company.com"/>
      </div>
      <div>
        <label>&nbsp;</label>
        <input id="shipper_phone" placeholder="+.. ... ..."/>
      </div>
    </div>
    <div class="grid2">
      <div>
        <label>VAT / EORI / Tax ID <button class="cm" data-field="vat_no">💬</button> <span class="count" id="cnt_vat_no"></span></label>
        <input id="vat_no" placeholder="EL-094158104"/>
      </div>
      <div></div>
    </div>
  </div>

  <!-- 2. Consignee -->
  <div class="card">
    <h2>2. Consignee</h2>
    <div class="grid2">
      <div>
        <label>Company name <button class="cm" data-field="consignee_address">💬</button> <span class="count" id="cnt_consignee_address"></span></label>
        <input id="consignee_company" placeholder="Company name"/>
      </div>
      <div>
        <label>Contact person <button class="cm" data-field="customer_contact">💬</button> <span class="count" id="cnt_customer_contact"></span></label>
        <input id="customer_contact" placeholder="Full name"/>
      </div>
    </div>
    <label>Address</label>
    <textarea id="consignee_address" placeholder="Street, Postal, City, Country"></textarea>
    <div class="grid2">
      <div>
        <label>Email / Phone <button class="cm" data-field="customer_email">💬</button> <span class="count" id="cnt_customer_email"></span></label>
        <input id="customer_email" placeholder="email@company.com"/>
      </div>
      <div>
        <label>&nbsp;</label>
        <input id="customer_phone" placeholder="+.. ... ..."/>
      </div>
    </div>
    <div class="grid2">
      <div>
        <label>Importer tax ID (if required)</label>
        <input id="importer_tax_id" placeholder=""/>
      </div>
      <div>
        <label>Customer No. <button class="cm" data-field="customer_no">💬</button> <span class="count" id="cnt_customer_no"></span></label>
        <input id="customer_no" placeholder=""/>
      </div>
    </div>
  </div>

  <!-- 3. Notify Party -->
  <div class="card">
    <h2>3. Notify Party (if different)</h2>
    <div class="grid2">
      <div>
        <label>Company name</label>
        <input id="notify_company" placeholder="Company name"/>
      </div>
      <div>
        <label>Contact person</label>
        <input id="notify_contact" placeholder="Full name"/>
      </div>
    </div>
    <label>Address <button class="cm" data-field="notify1_address">💬</button> <span class="count" id="cnt_notify1_address"></span></label>
    <textarea id="notify1_address" placeholder="Street, Postal, City, Country"></textarea>
    <div class="grid2">
      <div>
        <label>Email / Phone <button class="cm" data-field="notify1_email">💬</button> <span class="count" id="cnt_notify1_email"></span></label>
        <input id="notify1_email" placeholder="email@company.com"/>
      </div>
      <div>
        <label>&nbsp;</label>
        <input id="notify1_phone" placeholder="+.. ... ..."/>
      </div>
    </div>
  </div>

  <!-- 4. Shipment References -->
  <div class="card">
    <h2>4. Shipment References</h2>
    <div class="grid2">
      <div>
        <label>Shipment No. <button class="cm" data-field="shipment_no">💬</button> <span class="count" id="cnt_shipment_no"></span></label>
        <input id="shipment_no"/>
      </div>
      <div>
        <label>Customer Order / PO No. <button class="cm" data-field="po_no">💬</button> <span class="count" id="cnt_po_no"></span></label>
        <input id="po_no"/>
      </div>
    </div>
    <div class="grid2">
      <div>
        <label>Delivery No(s). <button class="cm" data-field="delivery_no">💬</button> <span class="count" id="cnt_delivery_no"></span></label>
        <input id="delivery_no"/>
      </div>
      <div>
        <label>Customer No. (if applicable) <button class="cm" data-field="customer_no">💬</button></label>
        <input id="customer_no_ref"/>
      </div>
    </div>
  </div>

  <!-- 5. Shipment Details -->
  <div class="card">
    <h2>5. Shipment Details</h2>
    <div class="grid2">
      <div>
        <label>Shipping Point (factory/warehouse)</label>
        <textarea id="shipping_point_text" placeholder="Titanstrasse, Gebäude B3&#10;26954 Nordenham&#10;Germany"></textarea>
      </div>
      <div>
        <div class="grid2">
          <div>
            <label>Port of Loading (POL)</label>
            <input id="pol"/>
          </div>
          <div>
            <label>Port of Discharge (POD)</label>
            <input id="pod"/>
          </div>
        </div>
        <label style="margin-top:8px">Delivery Terms (Incoterm + location) <button class="cm" data-field="delivery_terms">💬</button> <span class="count" id="cnt_delivery_terms"></span></label>
        <input id="delivery_terms" placeholder="DAP Athens, GR"/>
        <label style="margin-top:8px">Way of Forwarding <button class="cm" data-field="way_of_forwarding">💬</button> <span class="count" id="cnt_way_of_forwarding"></span></label>
        <input id="way_of_forwarding" placeholder="SEA / FCL"/>
      </div>
    </div>
    <div class="grid2" style="margin-top:8px">
      <div>
        <label>Loading Date <button class="cm" data-field="loading_date">💬</button> <span class="count" id="cnt_loading_date"></span></label>
        <input id="loading_date" placeholder="dd.mm.yyyy"/>
      </div>
      <div>
        <label>Scheduled Delivery Date <button class="cm" data-field="scheduled_delivery_date">💬</button> <span class="count" id="cnt_scheduled_delivery_date"></span></label>
        <input id="scheduled_delivery_date" placeholder="dd.mm.yyyy"/>
      </div>
    </div>
    <label style="margin-top:8px">Final Delivery Address</label>
    <textarea id="final_delivery_address" placeholder="If different from consignee"></textarea>
  </div>

  <!-- 6. Cargo Details -->
  <div class="card" id="goodsCard">
    <h2>6. Cargo Details</h2>
    <div id="products"></div>
    <button class="btn-link" type="button" id="addProduct">+ Add Product</button>
    <div class="grid3" style="margin-top:8px">
      <div>
        <label>HS Code <button class="cm" data-field="hs_code">💬</button> <span class="count" id="cnt_hs_code"></span></label>
        <input id="hs_code"/>
      </div>
      <div>
        <label>Net weight (kg)</label>
        <input id="total_net_kg" placeholder="e.g. 24000"/>
      </div>
      <div>
        <label>Gross weight (kg)</label>
        <input id="total_gross_kg" placeholder="e.g. 24500"/>
      </div>
    </div>
    <div class="grid2" style="margin-top:8px">
      <div>
        <label>Volume (CBM)</label>
        <input id="volume_cbm" placeholder="e.g. 28.0"/>
      </div>
      <div>
        <label>Special handling instructions</label>
        <input id="special_handling" placeholder="e.g. Keep dry"/>
      </div>
    </div>
  </div>

  <!-- 7. Marks & Numbers -->
  <div class="card">
    <h2>7. Marks & Numbers</h2>
    <label>Carton/pallet marks</label>
    <textarea id="marks_text" placeholder="Carton/pallet marks"></textarea>
    <label style="margin-top:8px">Labelling text (if applicable)</label>
    <textarea id="labelling_text" placeholder="Labelling text"></textarea>
  </div>

  <!-- 8. Bill of Lading Instructions -->
  <div class="card">
    <h2>8. Bill of Lading Instructions</h2>
    <div class="grid3">
      <div>
        <label>B/L type (Original / Express / Seaway)</label>
        <input id="bl_type" placeholder="e.g. Express"/>
      </div>
      <div>
        <label>Number of originals required</label>
        <input id="bl_originals" placeholder="e.g. 0"/>
      </div>
      <div>
        <label>Remarks <button class="cm" data-field="bl_remarks">💬</button> <span class="count" id="cnt_bl_remarks"></span></label>
        <input id="bl_remarks" placeholder="B/L remarks"/>
      </div>
    </div>
  </div>

  <!-- 9. Contacts for Coordination -->
  <div class="card">
    <h2>9. Contacts for Coordination</h2>
    <div class="grid2">
      <div>
        <label>Forwarder contact (if known)</label>
        <textarea id="forwarder_contact" placeholder="Company / person / email / phone"></textarea>
      </div>
      <div>
        <label>Buyer/agent contact at destination</label>
        <textarea id="destination_contact" placeholder="Company / person / email / phone"></textarea>
      </div>
    </div>
  </div>

  <!-- Signature -->
  <div class="card">
    <div class="grid2">
      <div>
        <div class="muted">Sincerely,</div>
        <label>Your Name <button class="cm" data-field="signature_name">💬</button> <span class="count" id="cnt_signature_name"></span></label>
        <input id="signature_name" placeholder="Authorized Signature"/>
      </div>
      <div>
        <label>Date <button class="cm" data-field="signature_date">💬</button> <span class="count" id="cnt_signature_date"></span></label>
        <input id="signature_date"/>
      </div>
    </div>
  </div>

  <!-- Actions -->
  <div class="card">
    <div class="toolbar">
      <button class="btn" type="button" id="saveDraftBtn" disabled>Save Draft</button>
      <button class="btn" type="button" id="freezeBtn" disabled>Freeze & Submit</button>
      <a class="btn" href="/api/shipments.csv">Download CSV</a>
      <a class="btn" href="/api/health" target="_blank" rel="noopener">Health</a>
    </div>
    <div id="saveStatus" class="status"></div>
  </div>

  <!-- Past -->
  <div class="card list">
    <div class="muted" style="margin-bottom:8px">Past Notifications</div>
    <div id="recent"></div>
  </div>
</div>

<script>
window.addEventListener('error', function(e){
  var s = document.getElementById('saveStatus');
  if (s) { s.textContent = 'Script error: ' + e.message; s.className = 'status err'; }
  console.error('Global error:', e.error || e.message);
});

var $ = function(sel){ return document.querySelector(sel); };
var statusEl = $("#status");
var prodWrap = $("#products");
var saveStatus = $("#saveStatus");
var draftBadge = $("#draftBadge");
var currentDraftId = null;
var currentVersionNo = null;

function makeProductCard(idx, data){
  data = data || {};
  var div = document.createElement('div');
  div.className = 'product';
  var html = ''
    + '<header>'
    +   '<strong>Product ' + (idx+1) + '</strong>'
    +   '<button class="btn-link" type="button">Remove Product</button>'
    + '</header>'
    + '<label>Product description (commercial name + grade/type)</label>'
    + '<input name="product_name" value="' + (data.product_name||'') + '">'
    + '<div class="grid3">'
    +   '<div><label>Net Weight (KG)</label><input name="net_kg" value="' + (data.net_kg||'') + '"></div>'
    +   '<div><label>Gross Weight (KG)</label><input name="gross_kg" value="' + (data.gross_kg||'') + '"></div>'
    +   '<div><label>No. Packages</label><input name="pkgs" value="' + (data.pkgs||'') + '"></div>'
    + '</div>'
    + '<div class="grid2" style="margin-top:8px">'
    +   '<div><label>Packaging details</label><input name="packaging" value="' + (data.packaging||'') + '"></div>'
    +   '<div><label>Pallets</label><input name="pallets" value="' + (data.pallets||'') + '"></div>'
    + '</div>';
  div.innerHTML = html;
  div.querySelector('button').onclick = function(){
    div.remove();
    var hs = prodWrap.querySelectorAll('.product header strong');
    for (var i=0;i<hs.length;i++){ hs[i].textContent = 'Product ' + (i+1); }
  };
  return div;
}
function addProduct(data){ prodWrap.appendChild(makeProductCard(prodWrap.children.length, data)); }

var drop = $("#drop"), file = $("#file");
drop.addEventListener("click", function(){ file.click(); });
drop.addEventListener("dragover", function(e){ e.preventDefault(); });
drop.addEventListener("drop", function(e){ e.preventDefault(); handleFiles(e.dataTransfer.files); });
file.addEventListener("change", function(e){ handleFiles(e.target.files); });

async function handleFiles(files){
  var f = files[0]; if (!f) return;
  statusEl.textContent = "Uploading & extracting…";
  statusEl.className = "status";
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
      statusEl.className = "status err";
      console.error("Upload error response:", js.raw || js);
      return;
    }

    currentDraftId = js.draft_id || null;
    currentVersionNo = js.version_no || 1;
    if (currentDraftId) {
      draftBadge.style.display = "inline-block";
      draftBadge.textContent = "Draft v" + currentVersionNo + " (" + currentDraftId.slice(0,6) + "…)";
      document.getElementById("saveDraftBtn").disabled = false;
      document.getElementById("freezeBtn").disabled = false;
      await refreshCommentCounts();
    }

    var conf = (typeof js.confidence === "number") ? (" (confidence " + Math.round(js.confidence) + "%)") : "";
    var warn = (js.warnings && js.warnings.length) ? " — Check: " + js.warnings.join("; ") : "";
    statusEl.textContent = "Draft created" + conf + ". Review the form." + warn;
    statusEl.className = "status ok";

    fillForm(js);

    if (Array.isArray(js.evidence)) {
      const byField = {};
      js.evidence.forEach(e => { (byField[e.field] ||= []).push(e); });
      Object.keys(byField).forEach(field => {
        const badge = document.getElementById("cnt_" + field);
        if (!badge) return;
        badge.title = byField[field].map(x => "[" + x.source + "] " + x.snippet).join("\\n\\n");
        badge.textContent = (badge.textContent ? badge.textContent + " · " : "") + byField[field].length + " evidence";
      });
    }
  } catch (err) {
    statusEl.textContent = "Network/timeout: " + err.message;
    statusEl.className = "status err";
    console.error(err);
  }
}

function setVal(id, val){ var el = document.getElementById(id); if(el) el.value = val || ""; }

function fillForm(d){
  // Shipper
  setVal("shipper_company", d.your_partner);
  setVal("shipper_contact", (d.extras && d.extras.shipper_contact) || "");
  setVal("shipper_address", (d.extras && d.extras.shipper_address) || "");
  setVal("shipper_email", d.shipper_email);
  setVal("shipper_phone", d.shipper_phone);
  setVal("vat_no", d.vat_no);

  // Consignee
  setVal("consignee_company", (d.extras && d.extras.consignee_company) || "");
  setVal("customer_contact", d.customer_contact);
  setVal("consignee_address", d.consignee_address);
  setVal("customer_email", d.customer_email);
  setVal("customer_phone", d.customer_phone);
  setVal("importer_tax_id", (d.extras && d.extras.importer_tax_id) || "");
  setVal("customer_no", d.customer_no);

  // Notify
  setVal("notify_company", (d.extras && d.extras.notify_company) || "");
  setVal("notify_contact", (d.extras && d.extras.notify_contact) || "");
  setVal("notify1_address", d.notify1_address);
  setVal("notify1_email", d.notify1_email);
  setVal("notify1_phone", d.notify1_phone);

  // References
  setVal("shipment_no", d.shipment_no);
  setVal("po_no", d.po_no || d.order_label);
  setVal("delivery_no", d.delivery_no);
  setVal("customer_no_ref", d.customer_no);

  // Shipment details
  const spCombined = [d.shipping_street, d.shipping_postal && (d.shipping_postal + " " + (d.shipping_city||"")), d.shipping_country].filter(Boolean).join("\\n");
  setVal("shipping_point_text", spCombined);
  setVal("pol", (d.extras && d.extras.pol) || "");
  setVal("pod", (d.extras && d.extras.pod) || "");
  setVal("delivery_terms", d.delivery_terms);
  setVal("way_of_forwarding", d.way_of_forwarding);
  setVal("loading_date", d.loading_date);
  setVal("scheduled_delivery_date", d.scheduled_delivery_date);
  setVal("final_delivery_address", (d.extras && d.extras.final_delivery_address) || "");

  // Cargo details
  setVal("hs_code", d.hs_code);
  setVal("total_net_kg", d.total_net_kg);
  setVal("total_gross_kg", d.total_gross_kg);
  setVal("volume_cbm", (d.extras && d.extras.volume_cbm) || "");
  setVal("special_handling", (d.extras && d.extras.special_handling) || "");

  // Marks & Numbers
  setVal("marks_text", (d.extras && d.extras.marks_text) || "");
  setVal("labelling_text", (d.extras && d.extras.labelling_text) || "");

  // B/L
  setVal("bl_type", (d.extras && d.extras.bl_type) || "");
  setVal("bl_originals", (d.extras && d.extras.bl_originals) || "");
  setVal("bl_remarks", d.bl_remarks);

  // Contacts
  setVal("forwarder_contact", (d.extras && d.extras.forwarder_contact) || "");
  setVal("destination_contact", (d.extras && d.extras.destination_contact) || "");

  // Signature
  setVal("signature_name", d.signature_name);
  setVal("signature_date", d.signature_date || new Date().toISOString().slice(0,10));

  // Items
  prodWrap.innerHTML = "";
  var items = (d.items && d.items.length) ? d.items : [{}];
  for (var i=0;i<items.length;i++) addProduct(items[i]);

  loadRecent();
}

// Add product
document.getElementById("addProduct").addEventListener("click", function(){ addProduct({}); });

// Save Draft
document.getElementById("saveDraftBtn").addEventListener("click", async function(){
  if (!currentDraftId) { saveStatus.textContent = "No draft to save"; saveStatus.className = "status err"; return; }
  const body = collectForm();
  try {
    const r = await fetch("/api/draft/" + currentDraftId + "/save", {
      method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body)
    });
    const js = await r.json();
    if (!r.ok) throw new Error(js.error || ("Save failed (" + r.status + ")"));
    saveStatus.textContent = "Draft saved.";
    saveStatus.className = "status ok";
  } catch(e) {
    saveStatus.textContent = "Save error: " + e.message;
    saveStatus.className = "status err";
  }
});

// Freeze & Submit
document.getElementById("freezeBtn").addEventListener("click", async function(){
  if (!currentDraftId) { saveStatus.textContent = "No draft to freeze"; saveStatus.className = "status err"; return; }
  saveStatus.textContent = "Freezing draft…";
  saveStatus.className = "status";
  try {
    const body = collectForm();
    await fetch("/api/draft/" + currentDraftId + "/save", {
      method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body)
    });

    const r = await fetch("/api/draft/" + currentDraftId + "/freeze", { method:"POST" });
    const js = await r.json();
    if (!r.ok) throw new Error(js.error || ("Freeze failed (" + r.status + ")"));
    saveStatus.textContent = "Frozen. Shipment saved (ID: " + js.shipment_id + ").";
    saveStatus.className = "status ok";
    loadRecent();
  } catch(e) {
    saveStatus.textContent = "Freeze error: " + e.message;
    saveStatus.className = "status err";
  }
});

function collectForm(){
  // Combine shipping point into structured fields if user edited the textarea (best-effort)
  var sp = ($("#shipping_point_text").value||"").split(/\\n+/);
  var spStreet = sp[0]||"", spPostal="", spCity="", spCountry="";
  if (sp[1]) {
    var m = sp[1].match(/(\\d{3,10})\\s+(.+)/);
    if (m) { spPostal = m[1]; spCity = m[2]; }
  }
  if (sp[2]) spCountry = sp[2];

  // Build extras without breaking existing DB schema
  var extras = {
    shipper_company: $("#shipper_company").value,
    shipper_contact: $("#shipper_contact").value,
    shipper_address: $("#shipper_address").value,
    consignee_company: $("#consignee_company").value,
    importer_tax_id: $("#importer_tax_id").value,
    notify_company: $("#notify_company").value,
    notify_contact: $("#notify_contact").value,
    pol: $("#pol").value,
    pod: $("#pod").value,
    final_delivery_address: $("#final_delivery_address").value,
    volume_cbm: $("#volume_cbm").value,
    special_handling: $("#special_handling").value,
    marks_text: $("#marks_text").value,
    labelling_text: $("#labelling_text").value,
    bl_type: $("#bl_type").value,
    bl_originals: $("#bl_originals").value,
    forwarder_contact: $("#forwarder_contact").value,
    destination_contact: $("#destination_contact").value
  };

  // Merge marks/labelling into bl_remarks preview (non-destructive)
  var blExtra = "";
  if (extras.marks_text) blExtra += (blExtra ? "\\n\\n" : "") + "MARKS:\\n" + extras.marks_text;
  if (extras.labelling_text) blExtra += (blExtra ? "\\n\\n" : "") + "LABELLING:\\n" + extras.labelling_text;
  var blCombined = ($("#bl_remarks").value||"").trim();
  if (blExtra) blCombined = (blCombined ? (blCombined + "\\n\\n") : "") + blExtra;

  return {
    // existing fields (server/DB know these)
    your_partner: $("#shipper_company").value || $("#your_partner")?.value || "",
    shipper_phone: $("#shipper_phone").value,
    shipper_email: $("#shipper_email").value,

    shipment_no: $("#shipment_no").value,
    order_no: $("#po_no").value, // keep mapping
    delivery_no: $("#delivery_no").value,
    loading_date: $("#loading_date").value,
    scheduled_delivery_date: $("#scheduled_delivery_date").value,
    po_no: $("#po_no").value,
    order_label: $("#po_no").value,

    shipping_street: spStreet,
    shipping_postal: spPostal,
    shipping_city: spCity,
    shipping_country: spCountry,

    way_of_forwarding: $("#way_of_forwarding").value,
    delivery_terms: $("#delivery_terms").value,

    consignee_address: $("#consignee_address").value,
    customer_no: $("#customer_no").value,
    vat_no: $("#vat_no").value,
    customer_po: $("#po_no").value,
    customer_contact: $("#customer_contact").value,
    customer_phone: $("#customer_phone").value,
    customer_email: $("#customer_email").value,

    notify1_address: $("#notify1_address").value,
    notify1_email: $("#notify1_email").value,
    notify1_phone: $("#notify1_phone").value,
    notify2_address: "",
    notify2_email: "",
    notify2_phone: "",

    total_net_kg: parseFloat($("#total_net_kg").value || 0) || null,
    total_gross_kg: parseFloat($("#total_gross_kg").value || 0) || null,
    total_pkgs: null,
    bl_remarks: blCombined,
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
    }),

    // NEW: keep non-DB fields safely
    extras: extras
  };
}

// Comments
document.addEventListener("click", async function(e){
  const btn = e.target.closest(".cm");
  if (!btn) return;
  if (!currentDraftId) { alert("Drop a PDF first to create a draft."); return; }
  const field = btn.getAttribute("data-field");
  const msg = prompt("Add a comment for “" + field + "”:");
  if (!msg) return;
  try {
    const r = await fetch("/api/draft/" + currentDraftId + "/comment", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ field_name: field, message: msg, author: "" })
    });
    if (!r.ok) throw new Error((await r.json()).error || "Comment failed");
    await refreshCommentCounts();
  } catch(err) {
    alert("Failed to add comment: " + err.message);
  }
});

async function refreshCommentCounts(){
  if (!currentDraftId) return;
  const r = await fetch("/api/draft/" + currentDraftId);
  if (!r.ok) return;
  const js = await r.json();
  const counts = {};
  (js.comments || []).forEach(c => { counts[c.field_name] = (counts[c.field_name] || 0) + 1; });
  document.querySelectorAll(".count").forEach(el => el.textContent = "");
  Object.keys(counts).forEach(k => {
    var el = document.getElementById("cnt_" + k);
    if (el) el.textContent = counts[k] + " comment" + (counts[k] > 1 ? "s" : "");
  });
}

async function loadRecent(){
  try {
    const r = await fetch("/api/shipments");
    const rows = await r.json();
    let h = '<table><thead><tr><th>Created</th><th>Shipment</th><th>Order</th><th>Consignee</th><th>Total Net (kg)</th><th></th></tr></thead><tbody>';
    (rows||[]).forEach(s => {
      const consignee = ((s.consignee_address||'').split('\\n')[0]||'');
      h += '<tr>'
        + '<td>' + s.created_at + '</td>'
        + '<td>' + (s.shipment_no||'') + '</td>'
        + '<td>' + (s.order_no||'') + '</td>'
        + '<td>' + consignee + '</td>'
        + '<td>' + (s.total_net_kg||'') + '</td>'
        + '<td><a href="/api/shipment/' + s.id + '" target="_blank" rel="noopener">View</a></td>'
        + '</tr>';
    });
    h += '</tbody></table>';
    document.querySelector('#recent').innerHTML = h;
  } catch (e) {
    document.querySelector('#recent').innerHTML = '<div class="status err">Failed to load history</div>';
    console.error(e);
  }
}

// defaults
document.getElementById("signature_date").value = new Date().toISOString().slice(0,10);
loadRecent();
</script>
</body></html>`);
});


// ---------- API ----------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), db: DB_PATH, openai: !!useOpenAI });
});

/**
 * Upload: extract text → parse → (optional OpenAI refine) → create/find Draft v1
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

    // Extract best text
    const textBest = await extractTextFromBuffer(req.file.buffer);
    if (!textBest || !textBest.trim()) {
      return res.status(422).json({ error: "Unable to extract text" });
    }

    // Build alternates for model reconciliation (classic layout + pdf-parse)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carrier-"));
    const pdfPath = path.join(tmp, "input.pdf"); fs.writeFileSync(pdfPath, req.file.buffer);
    const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 }, (err, out) => res(err ? "" : out.toString("utf8"))));
    const pClassic = run("pdftotext", ["-layout", "-nopgbrk", "-q", pdfPath, "-"]);
    const pParsed  = (async () => { try { const a = await pdfParse(req.file.buffer); return a?.text || ""; } catch { return ""; } })();

    const [altClassic, altParsed] = await Promise.all([pClassic, pParsed]);
    const alternates = { pdfParse: altParsed, pdftotext: altClassic, ocr: "" };

    // Deterministic parse first
    const seedFields = parseFieldsFromText(textBest);

    // Optional OpenAI refinement
    let llmJson = null;
    let finalFields = seedFields;
    let evidence = [];
    if (useOpenAI && OpenAI) {
      try {
        const refined = await openaiExtract({ textBest, alternates, seedFields });
        evidence = Array.isArray(refined.evidence) ? refined.evidence : [];
        delete refined.evidence;
        finalFields = refined;
        llmJson = JSON.stringify({ ...refined, evidence }, null, 2);
      } catch (e) {
        console.error("LLM extraction failed; falling back to regex parse:", e);
      }
    }

    // Score
    const { score, warnings } = validateAndScore(finalFields);
    finalFields.confidence = Math.min(100, score + Math.min(10, Math.floor((evidence.length || 0) / 5)));
    finalFields.warnings = warnings;
    finalFields.evidence = evidence;

    // Create or reuse Draft v1 for this hash
    let draft = db.prepare("SELECT * FROM drafts WHERE base_hash = ? AND version_no = 1").get(hash);
    const now = new Date().toISOString();
    if (!draft) {
      const id = nanoid();
      db.prepare(`INSERT INTO drafts (id, base_hash, version_no, status, data_json, created_at, updated_at)
                  VALUES (?, ?, 1, 'draft', ?, ?, ?)`)
        .run(id, hash, JSON.stringify(finalFields), now, now);
      draft = { id, base_hash: hash, version_no: 1, status: "draft" };
    } else {
      db.prepare(`UPDATE drafts SET data_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(finalFields), now, draft.id);
    }

    // Cache raw parse + LLM json
    db.prepare("INSERT OR REPLACE INTO cache (hash, text, parsed, created_at, llm_json) VALUES (?, ?, ?, ?, ?)")
      .run(hash, textBest, JSON.stringify(seedFields), now, llmJson);

    res.json({ ...finalFields, draft_id: draft.id, version_no: draft.version_no, status: "draft" });
  } catch (err) {
    console.error("Upload failed:", err);
    res.status(500).json({ error: "Server error: " + (err.message || "unknown") });
  }
});

// Debug: see raw extracted text
app.post("/api/debug-text", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const txt = await extractTextFromBuffer(req.file.buffer);
    res.type("text/plain").send(txt || "(no text extracted)");
  } catch (e) {
    res.status(500).json({ error: "debug failed: " + (e.message || "unknown") });
  }
});

// Draft API
app.get("/api/draft/:id", (req, res) => {
  const id = req.params.id;
  const d = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id);
  if (!d) return res.status(404).json({ error: "Draft not found" });
  const comments = db.prepare("SELECT id, field_name, message, author, created_at FROM comments WHERE draft_id = ? ORDER BY datetime(created_at)").all(id);
  res.json({
    id: d.id,
    version_no: d.version_no,
    status: d.status,
    fields: JSON.parse(d.data_json || "{}"),
    comments
  });
});

app.post("/api/draft/:id/save", (req, res) => {
  const id = req.params.id;
  const d = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id);
  if (!d) return res.status(404).json({ error: "Draft not found" });
  if (d.status !== "draft") return res.status(409).json({ error: "Draft is frozen" });
  const data = req.body || {};
  db.prepare("UPDATE drafts SET data_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(data), new Date().toISOString(), id);
  res.json({ ok: true });
});

app.post("/api/draft/:id/comment", (req, res) => {
  const id = req.params.id;
  const d = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id);
  if (!d) return res.status(404).json({ error: "Draft not found" });
  const { field_name, message, author } = req.body || {};
  if (!field_name || !message) return res.status(400).json({ error: "field_name and message are required" });
  db.prepare("INSERT INTO comments (id, draft_id, field_name, message, author, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(nanoid(), id, String(field_name), String(message), (author || "").toString(), new Date().toISOString());
  res.json({ ok: true });
});

/* Freeze draft → create final shipment + items; mark draft frozen */
app.post("/api/draft/:id/freeze", (req, res) => {
  const id = req.params.id;
  const d = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id);
  if (!d) return res.status(404).json({ error: "Draft not found" });
  if (d.status !== "draft") return res.status(409).json({ error: "Already frozen" });

  const s = JSON.parse(d.data_json || "{}");
  const shipment_id = nanoid();
  const created_at = dayjs().toISOString();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO shipments (
        id, created_at, your_partner, shipper_phone, shipper_email,
        shipment_no, order_no, delivery_no, loading_date, scheduled_delivery_date,
        po_no, order_label,
        shipping_street, shipping_postal, shipping_city, shipping_country,
        way_of_forwarding, delivery_terms, carrier_to, consignee_address,
        customer_no, vat_no, customer_po, customer_contact, customer_phone, customer_email,
        notify1_address, notify1_email, notify1_phone, notify2_address, notify2_email, notify2_phone,
        total_net_kg, total_gross_kg, total_pkgs,
        bl_remarks, hs_code, signature_name, signature_date
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      shipment_id, created_at, s.your_partner, s.shipper_phone, s.shipper_email,
      s.shipment_no, s.order_no, s.delivery_no, s.loading_date, s.scheduled_delivery_date,
      s.po_no, s.order_label,
      s.shipping_street, s.shipping_postal, s.shipping_city, s.shipping_country,
      s.way_of_forwarding, s.delivery_terms, s.carrier_to, s.consignee_address,
      s.customer_no, s.vat_no || null, s.customer_po, s.customer_contact, s.customer_phone, s.customer_email,
      s.notify1_address, s.notify1_email, s.notify1_phone, s.notify2_address, s.notify2_email, s.notify2_phone,
      s.total_net_kg ?? null, s.total_gross_kg ?? null, s.total_pkgs ?? null,
      s.bl_remarks, s.hs_code, s.signature_name, s.signature_date
    );

    const insItem = db.prepare(`
      INSERT INTO items (id, shipment_id, product_name, net_kg, gross_kg, pkgs, packaging, pallets)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    (Array.isArray(s.items) ? s.items : []).forEach(it => {
      insItem.run(nanoid(), shipment_id,
        it.product_name || null,
        it.net_kg ?? null,
        it.gross_kg ?? null,
        it.pkgs ?? null,
        it.packaging || null,
        it.pallets ?? null
      );
    });

    db.prepare("UPDATE drafts SET status = 'frozen', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  });
  tx();

  res.json({ ok: true, shipment_id, draft_id: id });
});

// Existing shipment endpoints
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
    res.status(500).json({ error: "DB failed: " + (e.message || "unknown") });
  }
});

app.get("/api/shipment/:id", (req, res) => {
  const id = req.params.id;
  const s = db.prepare("SELECT * FROM shipments WHERE id = ?").get(id);
  if (!s) return res.status(404).json({ error: "Not found" });
  const items = db.prepare("SELECT * FROM items WHERE shipment_id = ? ORDER BY rowid").all(id);
  res.json({ ...s, items });
});

app.get("/api/shipments.csv", (_req, res) => {
  const rows = db.prepare(`
    SELECT created_at, id, shipment_no, order_no, customer_no, po_no, total_net_kg, total_gross_kg, total_pkgs
    FROM shipments
    ORDER BY datetime(created_at) DESC
    LIMIT 100
  `).all();
  const head = "created_at,id,shipment_no,order_no,customer_no,po_no,total_net_kg,total_gross_kg,total_pkgs";
  const csv = [head].concat(
    rows.map(r => [
      r.created_at, r.id, r.shipment_no || "", r.order_no || "", r.customer_no || "", r.po_no || "",
      r.total_net_kg || "", r.total_gross_kg || "", r.total_pkgs || ""
    ].map(v => '"' + String(v).replace(/"/g,'""') + '"').join(","))
  ).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=shipments.csv");
  res.send(csv);
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on :" + PORT + (useOpenAI ? " (OpenAI refine ON)" : " (OpenAI refine OFF)")));
