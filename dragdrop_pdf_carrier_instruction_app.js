/**
 * Drag‑and‑drop PDF → Autofill form → Save to DB (single‑file demo)
 * ---------------------------------------------------------------
 * Stack: Node.js + Express + Multer (upload) + pdf-parse (text extract) + SQLite
 * Purpose: Users drop a carrier notification PDF; server parses key fields,
 *          shows an editable form for confirmation, and saves to a shipments table.
 *
 * Quick start:
 *   1) npm init -y
 *   2) npm i express multer pdf-parse better-sqlite3 nanoid dayjs
 *   3) node dragdrop-pdf-carrier-instruction-app.js
 *   4) Open http://localhost:3000
 *
 * Notes:
 *  - Parser is tailored to the Kronos PDF layout you provided. Adjust regex in parseFieldsFromText()
 *    for other layouts.
 *  - This is a minimal all‑in‑one file for easy testing. For production, split into routes/modules,
 *    add auth, validation, HTTPS, S3/GCS storage, and schema migrations.
 */

const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const dayjs = require('dayjs');

// ---------------------- DB SETUP ----------------------
const db = new Database('shipments.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  shipment_no TEXT,
  order_no TEXT,
  delivery_no TEXT,
  loading_date TEXT,
  scheduled_delivery_date TEXT,
  shipping_point TEXT,
  shipping_city TEXT,
  shipping_country TEXT,
  way_of_forwarding TEXT,
  delivery_terms TEXT,
  shipper_company TEXT,
  shipper_address TEXT,
  shipper_contact_name TEXT,
  shipper_phone TEXT,
  shipper_email TEXT,
  consignee_company TEXT,
  consignee_address TEXT,
  consignee_city TEXT,
  consignee_postal TEXT,
  consignee_country TEXT,
  consignee_vat TEXT,
  customer_no TEXT,
  customer_po TEXT,
  notify_company TEXT,
  notify_address TEXT,
  notify_city TEXT,
  notify_postal TEXT,
  notify_country TEXT,
  notify_email TEXT,
  notify_phone TEXT,
  notify_vat TEXT,
  marks_text TEXT,
  order_label TEXT,
  total_net_kg REAL,
  total_pkgs INTEGER,
  total_gross_kg REAL
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL,
  description TEXT,
  type TEXT,
  net_kg REAL,
  pkgs INTEGER,
  gross_kg REAL,
  packaging TEXT,
  pallets INTEGER,
  FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
);
`);

const insertShipment = db.prepare(`INSERT INTO shipments (
  id, created_at, shipment_no, order_no, delivery_no, loading_date, scheduled_delivery_date,
  shipping_point, shipping_city, shipping_country, way_of_forwarding, delivery_terms,
  shipper_company, shipper_address, shipper_contact_name, shipper_phone, shipper_email,
  consignee_company, consignee_address, consignee_city, consignee_postal, consignee_country,
  consignee_vat, customer_no, customer_po, notify_company, notify_address, notify_city,
  notify_postal, notify_country, notify_email, notify_phone, notify_vat, marks_text,
  order_label, total_net_kg, total_pkgs, total_gross_kg
) VALUES (@id, @created_at, @shipment_no, @order_no, @delivery_no, @loading_date, @scheduled_delivery_date,
  @shipping_point, @shipping_city, @shipping_country, @way_of_forwarding, @delivery_terms,
  @shipper_company, @shipper_address, @shipper_contact_name, @shipper_phone, @shipper_email,
  @consignee_company, @consignee_address, @consignee_city, @consignee_postal, @consignee_country,
  @consignee_vat, @customer_no, @customer_po, @notify_company, @notify_address, @notify_city,
  @notify_postal, @notify_country, @notify_email, @notify_phone, @notify_vat, @marks_text,
  @order_label, @total_net_kg, @total_pkgs, @total_gross_kg
)`);

const insertItem = db.prepare(`INSERT INTO items (
  id, shipment_id, description, type, net_kg, pkgs, gross_kg, packaging, pallets
) VALUES (@id, @shipment_id, @description, @type, @net_kg, @pkgs, @gross_kg, @packaging, @pallets)`);

const listShipments = db.prepare(`
  SELECT s.*, COUNT(i.id) as item_count
  FROM shipments s LEFT JOIN items i ON i.shipment_id = s.id
  GROUP BY s.id
  ORDER BY datetime(s.created_at) DESC
`);
const getShipment = db.prepare(`SELECT * FROM shipments WHERE id = ?`);
const getItems = db.prepare(`SELECT * FROM items WHERE shipment_id = ?`);

// ---------------------- SERVER SETUP ----------------------
const app = express();
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage() });

// ---------------------- UTIL: PARSING ----------------------
function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function match(re, text, group = 1) {
  const m = re.exec(text);
  return m ? clean(m[group]) : '';
}

function matchAll(re, text) {
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m);
  return out;
}

/**
 * Parse the Kronos/Expeditors carrier notification text.
 * Adjust regexes to fit variants.
 */
function parseFieldsFromText(text) {
  // Normalize for easier regex over page breaks/columns
  const norm = text.replace(/\r/g, '').replace(/[\t\f]+/g, ' ').replace(/ +/g, ' ');

  // Header fields
  const shipment_no = match(/Shipment No\.:\s*(\d+)/i, norm);
  const order_no = match(/Order No\.:\s*(\d+)/i, norm);
  const delivery_no = match(/Delivery No\.:\s*(\d+)/i, norm);
  const loading_date = match(/Loading Date:\s*([0-9]{2}\.[0-9]{2}\.[0-9]{4})/i, norm);
  const scheduled_delivery_date = match(/Sched\. Delivery Date:\s*([0-9]{2}\.[0-9]{2}\.[0-9]{4})/i, norm);
  const way_of_forwarding = match(/Way of Forwarding:\s*([^\n]+?)\s+(Delivery Terms:|PRODUCT)/i, norm);
  const delivery_terms = match(/Delivery Terms:\s*([A-Z]+\s+\S+)/i, norm);

  // Shipper block
  // Expect: KRONOS TITAN GmbH ... Contact: Marina, phone, email
  const shipper_company = 'KRONOS TITAN GmbH';
  const shipper_contact_name = match(/Your Partner:\s*([^\n]+)/i, norm);
  const shipper_phone = match(/Telephone\s*:\s*([^\n]+)/i, norm);
  const shipper_email = match(/Email\s*:\s*([^\s]+)/i, norm);
  // Address lines: "Peschstrasse 5, 51373 Leverkusen" appears near the top
  const shipper_address = match(/KRONOS TITAN GmbH\s*([A-Za-zäöüÄÖÜß\- ]+\d*,\s*\d+\s*[^\n]+)/i, norm) || 'Peschstrasse 5, 51373 Leverkusen';

  // Shipping point (multi-line)
  const shipping_point_block = match(/Shipping Point:\s*([^\n]+(?:\s+[^\n]+){0,4})/i, text);
  // Try to split last line city/country if present
  let shipping_point = clean(shipping_point_block);
  let shipping_city = '';
  let shipping_country = '';
  if (shipping_point) {
    // Example: "KRONOS TITAN GMBH TITANSTRASSE, GEBÄUDE B3 26954 NORDENHAM GERMANY"
    const m = shipping_point.match(/(\d{4,6}\s+[A-ZÄÖÜa-zäöüß\- ]+)\s+([A-ZÄÖÜa-zäöüß\- ]+)$/);
    if (m) {
      shipping_city = clean(m[1]);
      shipping_country = clean(m[2]);
    }
  }

  // Consignee block
  const consignee_company = match(/Delivery Address:\s*\n\s*([^\n]+)/i, text) || match(/Consignee:\s*Buyer\s*\n([\s\S]*?)\n\s*VAT/i, text);
  // Address lines under Delivery Address
  const consignee_address_lines = match(/Delivery Address:\s*[\r\n]+([\s\S]*?)\n\s*Customer No\./i, text);
  let consignee_address = '';
  let consignee_city = '';
  let consignee_postal = '';
  let consignee_country = '';
  if (consignee_address_lines) {
    const lines = consignee_address_lines.split(/\n/).map(l => clean(l)).filter(Boolean);
    // Heuristics: last line has country, previous city/postal
    if (lines.length >= 2) {
      consignee_country = lines[lines.length - 1];
      const cityLine = lines[lines.length - 2];
      const m = cityLine.match(/(\d{3,10})\s+(.+)/);
      if (m) { consignee_postal = m[1]; consignee_city = m[2]; }
      consignee_address = lines.slice(0, -2).join(', ');
    } else {
      consignee_address = lines.join(', ');
    }
  }
  const consignee_vat = match(/VAT No\.?\s*([A-Z]{2}-?\d+)/i, text);
  const customer_no = match(/Customer No\.:\s*(\S+)/i, text);
  const customer_po = match(/Customer PO No\.:\s*([^\n]+)/i, text);

  // Notify party
  const notify_block = match(/Notify:\s*([\s\S]*?)\n\s*MARKS TEXT/i, text);
  let notify_company = '', notify_address = '', notify_city = '', notify_postal = '', notify_country = '', notify_email = '', notify_phone = '', notify_vat = '';
  if (notify_block) {
    const lines = notify_block.split(/\n/).map(l => clean(l)).filter(Boolean);
    notify_company = lines[0] || '';
    // gather remaining address lines until we hit an email/phone/VAT
    const addrLines = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (/@/.test(line) || /Tel\./i.test(line) || /Vat No\./i.test(line)) continue;
      addrLines.push(line);
    }
    // heuristic: last of addrLines is country, previous is city+postal
    if (addrLines.length >= 2) {
      notify_country = addrLines[addrLines.length - 1];
      const cp = addrLines[addrLines.length - 2];
      const m = cp.match(/(\d{3,10})\s+(.+)/);
      if (m) { notify_postal = m[1]; notify_city = m[2]; }
      notify_address = addrLines.slice(0, -2).join(', ');
    } else {
      notify_address = addrLines.join(', ');
    }
    notify_email = (lines.find(l => /@/.test(l)) || '').replace(/^Email:\s*/i, '');
    const telLine = lines.find(l => /Tel\./i.test(l));
    notify_phone = telLine ? telLine.replace(/.*Tel\.:\s*/i, '') : '';
    notify_vat = (lines.find(l => /Vat No\./i.test(l)) || '').replace(/.*Vat No\.:\s*/i, '');
  }

  // Marks & Order label
  const marks_text_block = match(/MARKS TEXT[\s\S]*?LABELLING:\s*([\s\S]*?)\n\s*ORDER/i, text);
  const marks_text = clean(marks_text_block);
  const order_label = match(/ORDER\s*No\s*([A-Za-z0-9\/-]+)/i, text);

  // Totals
  const total_line = match(/TOTAL\s*([0-9\.,]+)\s*KG\s*([0-9]+)\s*([0-9\.,]+)\s*KG/i, text);
  let total_net_kg = 0, total_pkgs = 0, total_gross_kg = 0;
  if (total_line) {
    const m = /TOTAL\s*([0-9\.,]+)\s*KG\s*([0-9]+)\s*([0-9\.,]+)\s*KG/i.exec(text);
    if (m) {
      total_net_kg = parseFloat(m[1].replace(/\./g, '').replace(',', '.')) || 0;
      total_pkgs = parseInt(m[2], 10) || 0;
      total_gross_kg = parseFloat(m[3].replace(/\./g, '').replace(',', '.')) || 0;
    }
  }

  // Items (two lines in sample). We'll look for blocks that look like:
  // TITANIUM DIOXIDE Type 3741 10.000 KG 400 10.340 KG ... next lines with packaging
  const itemMatches = matchAll(/(TITANIUM DIOXIDE[^\n]*?Type\s*\S+)[^\n]*?([0-9\.,]+)\s*KG\s+([0-9]+)\s+([0-9\.,]+)\s*KG[\s\S]*?(\d+\s*Paper Bags.*?|\d+\s*Big Bag.*?)(?:\n(\d+)\s*Pallet)?/gi, text);
  const items = itemMatches.map(m => {
    const desc = clean(m[1]);
    const net = parseFloat(m[2].replace(/\./g, '').replace(',', '.')) || 0;
    const pkgs = parseInt(m[3], 10) || 0;
    const gross = parseFloat(m[4].replace(/\./g, '').replace(',', '.')) || 0;
    const packaging = clean(m[5]);
    const pallets = m[6] ? parseInt(m[6], 10) : null;
    const type = (desc.match(/Type\s*(\S+)/i) || [,''])[1];
    return { description: desc, type, net_kg: net, pkgs, gross_kg: gross, packaging, pallets };
  });

  // Shipping city/country fallback if not parsed
  if (!shipping_city || !shipping_country) {
    const m = match(/Shipping Point:[\s\S]*?(\d{4,6}\s+[^\n]+)\s+([A-Za-z ]{3,})/i, text);
    if (m) {
      const mm = /(\d{4,6})\s+(.+)/.exec(m);
      if (mm) {
        shipping_city = clean(mm[2]);
      }
    }
  }

  return {
    shipment_no,
    order_no,
    delivery_no,
    loading_date,
    scheduled_delivery_date,
    way_of_forwarding: clean(way_of_forwarding),
    delivery_terms: clean(delivery_terms),

    shipper_company,
    shipper_address: clean(shipper_address),
    shipper_contact_name: clean(shipper_contact_name),
    shipper_phone: clean(shipper_phone),
    shipper_email: clean(shipper_email),

    shipping_point: clean(shipping_point),
    shipping_city: clean(shipping_city),
    shipping_country: clean(shipping_country),

    consignee_company: clean(consignee_company),
    consignee_address: clean(consignee_address),
    consignee_city: clean(consignee_city),
    consignee_postal: clean(consignee_postal),
    consignee_country: clean(consignee_country),
    consignee_vat: clean(consignee_vat),
    customer_no: clean(customer_no),
    customer_po: clean(customer_po),

    notify_company: clean(notify_company),
    notify_address: clean(notify_address),
    notify_city: clean(notify_city),
    notify_postal: clean(notify_postal),
    notify_country: clean(notify_country),
    notify_email: clean(notify_email),
    notify_phone: clean(notify_phone),
    notify_vat: clean(notify_vat),

    marks_text: clean(marks_text),
    order_label: clean(order_label),

    total_net_kg,
    total_pkgs,
    total_gross_kg,

    items,
  };
}

// ---------------------- ROUTES ----------------------
app.get('/', (req, res) => {
  res.type('html').send(`
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Carrier PDF → Form</title>
    <style>
      :root { --bg:#0f172a; --card:#111827; --muted:#94a3b8; --ok:#16a34a; --warn:#f59e0b; }
      *{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Helvetica,Arial}
      body{margin:0;background:#0b1220;color:#e5e7eb}
      header{padding:24px 20px;border-bottom:1px solid #1f2937;background:#0f172a}
      main{max-width:1050px;margin:24px auto;padding:0 16px}
      .row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
      .card{background:#111827;border:1px solid #1f2937;border-radius:20px;padding:18px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
      h1{font-size:22px;margin:0 0 6px}
      p{color:#94a3b8;margin:0 0 16px}
      .drop{border:2px dashed #334155;border-radius:18px;padding:24px;text-align:center;transition:.2s}
      .drop.drag{border-color:#60a5fa;background:#0b1b30}
      input[type=file]{display:none}
      button{background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:12px;padding:10px 14px;cursor:pointer}
      button.primary{background:#2563eb;border-color:#2563eb}
      label{display:block;color:#cbd5e1;margin:8px 0 4px}
      input,textarea{width:100%;padding:10px;border-radius:10px;border:1px solid #334155;background:#0b1220;color:#e5e7eb}
      table{width:100%;border-collapse:collapse}
      th,td{border-bottom:1px solid #1f2937;padding:8px;text-align:left}
      .grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
      .grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
      .muted{color:#94a3b8}
      .badge{display:inline-block;padding:4px 8px;border-radius:999px;background:#111827;border:1px solid #334155;color:#cbd5e1;font-size:12px}
      .success{color:#22c55e}
      .error{color:#ef4444}
      footer{opacity:.7;text-align:center;margin:30px 0 10px}
    </style>
  </head>
  <body>
    <header>
      <h1>Carrier Notification: PDF → Structured Form</h1>
      <p class="muted">Drag and drop a carrier notification PDF. We'll parse fields, let you confirm, and save to a table.</p>
    </header>
    <main>
      <div class="row">
        <section class="card">
          <h2 style="margin:0 0 10px">1) Upload</h2>
          <div id="drop" class="drop">
            <p>Drop PDF here (or click to choose)</p>
            <input id="file" type="file" accept="application/pdf" />
            <p class="muted">Only PDF files are supported.</p>
          </div>
          <div id="uploadStatus" class="muted" style="margin-top:10px"></div>
        </section>
        <section class="card">
          <h2 style="margin:0 0 10px">2) Recent Shipments</h2>
          <div id="recent"></div>
        </section>
      </div>

      <section class="card" style="margin-top:18px">
        <h2 style="margin:0 0 10px">3) Parsed Form</h2>
        <p class="muted">Review & edit before saving.</p>
        <form id="parsedForm"></form>
        <div id="saveStatus" style="margin-top:8px"></div>
      </section>

      <footer>
        <span class="badge">Demo app · SQLite local DB</span>
      </footer>
    </main>

    <script>
      const drop = document.getElementById('drop');
      const fileInp = document.getElementById('file');
      const uploadStatus = document.getElementById('uploadStatus');
      const parsedForm = document.getElementById('parsedForm');
      const recentDiv = document.getElementById('recent');
      const saveStatus = document.getElementById('saveStatus');

      const fields = [
        // Shipment
        'shipment_no','order_no','delivery_no','loading_date','scheduled_delivery_date','way_of_forwarding','delivery_terms',
        // Shipper
        'shipper_company','shipper_address','shipper_contact_name','shipper_phone','shipper_email',
        // Shipping point
        'shipping_point','shipping_city','shipping_country',
        // Consignee
        'consignee_company','consignee_address','consignee_city','consignee_postal','consignee_country','consignee_vat','customer_no','customer_po',
        // Notify
        'notify_company','notify_address','notify_city','notify_postal','notify_country','notify_email','notify_phone','notify_vat',
        // Marks / totals
        'marks_text','order_label','total_net_kg','total_pkgs','total_gross_kg'
      ];

      function renderForm(data) {
        parsedForm.innerHTML = '';
        const group = (title, keys) => {
          const wrap = document.createElement('div');
          wrap.innerHTML = `<h3>${title}</h3>`;
          keys.forEach(k => {
            const label = document.createElement('label');
            label.textContent = k.replaceAll('_',' ').replace(/\b\w/g, c => c.toUpperCase());
            const input = document.createElement(k.includes('marks_') ? 'textarea' : 'input');
            input.name = k; input.value = data[k] ?? ''; input.rows = k==='marks_text'?3:1;
            wrap.appendChild(label); wrap.appendChild(input);
          });
          parsedForm.appendChild(wrap);
        };
        group('Shipment', ['shipment_no','order_no','delivery_no','loading_date','scheduled_delivery_date','way_of_forwarding','delivery_terms']);
        group('Shipper', ['shipper_company','shipper_address','shipper_contact_name','shipper_phone','shipper_email']);
        group('Shipping Point', ['shipping_point','shipping_city','shipping_country']);
        group('Consignee', ['consignee_company','consignee_address','consignee_city','consignee_postal','consignee_country','consignee_vat','customer_no','customer_po']);
        group('Notify', ['notify_company','notify_address','notify_city','notify_postal','notify_country','notify_email','notify_phone','notify_vat']);
        group('Marks & Totals', ['marks_text','order_label','total_net_kg','total_pkgs','total_gross_kg']);

        // Items table
        const items = data.items || [];
        const itemsWrap = document.createElement('div');
        itemsWrap.innerHTML = `<h3>Items</h3>`;
        const table = document.createElement('table');
        table.innerHTML = `
          <thead><tr><th>Description</th><th>Type</th><th>Net (kg)</th><th>Pkgs</th><th>Gross (kg)</th><th>Packaging</th><th>Pallets</th></tr></thead>
          <tbody></tbody>
        `;
        const tbody = table.querySelector('tbody');
        items.forEach((it, idx) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><input name="items[${idx}][description]" value="${it.description||''}"></td>
            <td><input name="items[${idx}][type]" value="${it.type||''}"></td>
            <td><input name="items[${idx}][net_kg]" value="${it.net_kg||''}"></td>
            <td><input name="items[${idx}][pkgs]" value="${it.pkgs||''}"></td>
            <td><input name="items[${idx}][gross_kg]" value="${it.gross_kg||''}"></td>
            <td><input name="items[${idx}][packaging]" value="${it.packaging||''}"></td>
            <td><input name="items[${idx}][pallets]" value="${it.pallets??''}"></td>
          `;
          tbody.appendChild(tr);
        });
        itemsWrap.appendChild(table);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'primary';
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save shipment';
        saveBtn.onclick = async () => {
          const formData = new FormData(parsedForm);
          const obj = {};
          fields.forEach(k => obj[k] = formData.get(k));
          // collect items
          obj.items = [];
          const names = [...parsedForm.querySelectorAll('input[name^="items["]')].map(i => i.name);
          const idxs = new Set(names.map(n => /items\[(\d+)\]/.exec(n)[1]));
          idxs.forEach(i => {
            const get = (key) => formData.get(`items[${i}][${key}]`);
            obj.items.push({
              description: get('description')||'',
              type: get('type')||'',
              net_kg: parseFloat(get('net_kg')||0),
              pkgs: parseInt(get('pkgs')||0),
              gross_kg: parseFloat(get('gross_kg')||0),
              packaging: get('packaging')||'',
              pallets: get('pallets')?parseInt(get('pallets')):null,
            });
          });
          const r = await fetch('/api/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(obj)});
          const js = await r.json();
          saveStatus.innerHTML = r.ok ? `<span class="success">Saved! ID: ${js.id}</span>` : `<span class="error">${js.error||'Save failed'}</span>`;
          if (r.ok) loadRecent();
        };
        itemsWrap.appendChild(saveBtn);
        parsedForm.appendChild(itemsWrap);
      }

      async function loadRecent() {
        const r = await fetch('/api/shipments');
        const js = await r.json();
        if (!Array.isArray(js)) { recentDiv.textContent = 'No data'; return; }
        let html = '<table><thead><tr><th>Created</th><th>Shipment No</th><th>Order No</th><th>Consignee</th><th>Items</th><th>Total Net (kg)</th></tr></thead><tbody>';
        js.forEach(row => {
          html += `<tr><td>${row.created_at}</td><td><a href="/shipment/${row.id}">${row.shipment_no||''}</a></td><td>${row.order_no||''}</td><td>${row.consignee_company||''}</td><td>${row.item_count}</td><td>${row.total_net_kg||''}</td></tr>`;
        });
        html += '</tbody></table>';
        recentDiv.innerHTML = html;
      }

      async function handleFiles(files) {
        const f = files[0]; if (!f) return;
        uploadStatus.textContent = 'Uploading & parsing…';
        const fd = new FormData(); fd.append('file', f);
        const r = await fetch('/api/upload', { method:'POST', body: fd });
        const js = await r.json();
        if (r.ok) {
          uploadStatus.innerHTML = '<span class="success">Parsed. Review below.</span>';
          renderForm(js);
        } else {
          uploadStatus.innerHTML = '<span class="error">' + (js.error || 'Parse failed') + '</span>';
        }
      }

      drop.addEventListener('click', () => fileInp.click());
      fileInp.addEventListener('change', e => handleFiles(e.target.files));
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
      drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); handleFiles(e.dataTransfer.files); });

      loadRecent();
    </script>
  </body>
  </html>
  `);
});

// Upload & parse PDF -> JSON fields
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Only PDF supported' });
    const pdfData = await pdfParse(req.file.buffer);
    const fields = parseFieldsFromText(pdfData.text || '');
    res.json(fields);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to parse PDF' });
  }
});

// Save confirmed form to DB
app.post('/api/save', (req, res) => {
  try {
    const body = req.body || {};
    const id = nanoid();
    const created_at = dayjs().toISOString();

    const shipment = {
      id, created_at,
      shipment_no: body.shipment_no || null,
      order_no: body.order_no || null,
      delivery_no: body.delivery_no || null,
      loading_date: body.loading_date || null,
      scheduled_delivery_date: body.scheduled_delivery_date || null,
      shipping_point: body.shipping_point || null,
      shipping_city: body.shipping_city || null,
      shipping_country: body.shipping_country || null,
      way_of_forwarding: body.way_of_forwarding || null,
      delivery_terms: body.delivery_terms || null,
      shipper_company: body.shipper_company || null,
      shipper_address: body.shipper_address || null,
      shipper_contact_name: body.shipper_contact_name || null,
      shipper_phone: body.shipper_phone || null,
      shipper_email: body.shipper_email || null,
      consignee_company: body.consignee_company || null,
      consignee_address: body.consignee_address || null,
      consignee_city: body.consignee_city || null,
      consignee_postal: body.consignee_postal || null,
      consignee_country: body.consignee_country || null,
      consignee_vat: body.consignee_vat || null,
      customer_no: body.customer_no || null,
      customer_po: body.customer_po || null,
      notify_company: body.notify_company || null,
      notify_address: body.notify_address || null,
      notify_city: body.notify_city || null,
      notify_postal: body.notify_postal || null,
      notify_country: body.notify_country || null,
      notify_email: body.notify_email || null,
      notify_phone: body.notify_phone || null,
      notify_vat: body.notify_vat || null,
      marks_text: body.marks_text || null,
      order_label: body.order_label || null,
      total_net_kg: body.total_net_kg ? Number(body.total_net_kg) : null,
      total_pkgs: body.total_pkgs ? Number(body.total_pkgs) : null,
      total_gross_kg: body.total_gross_kg ? Number(body.total_gross_kg) : null,
    };
    const items = Array.isArray(body.items) ? body.items : [];

    const tx = db.transaction(() => {
      insertShipment.run(shipment);
      items.forEach(it => insertItem.run({
        id: nanoid(), shipment_id: id,
        description: it.description || null,
        type: it.type || null,
        net_kg: it.net_kg != null ? Number(it.net_kg) : null,
        pkgs: it.pkgs != null ? Number(it.pkgs) : null,
        gross_kg: it.gross_kg != null ? Number(it.gross_kg) : null,
        packaging: it.packaging || null,
        pallets: it.pallets != null ? Number(it.pallets) : null,
      }));
    });
    tx();

    res.json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save shipment' });
  }
});

// List shipments
app.get('/api/shipments', (req, res) => {
  try {
    res.json(listShipments.all());
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Single shipment details page
app.get('/shipment/:id', (req, res) => {
  const id = req.params.id;
  const s = getShipment.get(id);
  if (!s) return res.status(404).send('Not found');
  const items = getItems.all(id);
  res.type('html').send(`
    <html><head><title>Shipment ${id}</title>
    <style>
      body{font-family:system-ui,Roboto,Inter,Arial;margin:24px;color:#111}
      table{border-collapse:collapse}
      th,td{border:1px solid #ddd;padding:6px 8px}
    </style>
    </head><body>
      <h2>Shipment ${id}</h2>
      <p><b>Shipment No:</b> ${s.shipment_no||''} · <b>Order No:</b> ${s.order_no||''} · <b>Delivery No:</b> ${s.delivery_no||''}</p>
      <p><b>Consignee:</b> ${s.consignee_company||''} · <b>Total Net (kg):</b> ${s.total_net_kg||''}</p>
      <h3>Items</h3>
      <table><thead><tr><th>Description</th><th>Type</th><th>Net</th><th>Pkgs</th><th>Gross</th><th>Packaging</th><th>Pallets</th></tr></thead>
      <tbody>
        ${items.map(i=>`<tr><td>${i.description||''}</td><td>${i.type||''}</td><td>${i.net_kg||''}</td><td>${i.pkgs||''}</td><td>${i.gross_kg||''}</td><td>${i.packaging||''}</td><td>${i.pallets??''}</td></tr>`).join('')}
      </tbody></table>
    </body></html>
  `);
});

// ---------------------- START ----------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PDF → Form app listening on http://localhost:${PORT}`));
