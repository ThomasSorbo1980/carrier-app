/**
 * Carrier Notification PDF → Autofill Form → Save to SQLite (Render with disk)
 */
const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const dayjs = require("dayjs");
const Database = require("better-sqlite3");
const { nanoid } = require("nanoid");
const path = require("path");
const fs = require("fs");

// Use disk path if provided (Render), fallback to local file
const DB_PATH = process.env.SQLITE_DB_PATH || "shipments.db";

// Ensure directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);

// Create tables if not exist
db.prepare(`
  CREATE TABLE IF NOT EXISTS shipments (
    id TEXT PRIMARY KEY,
    created_at TEXT,
    shipment_no TEXT,
    order_no TEXT,
    delivery_no TEXT,
    loading_date TEXT,
    scheduled_delivery_date TEXT,
    shipping_point TEXT,
    way_of_forwarding TEXT,
    delivery_terms TEXT,
    consignee_company TEXT,
    consignee_address TEXT,
    customer_no TEXT,
    customer_po TEXT,
    notify_company TEXT,
    notify_address TEXT,
    marks_text TEXT,
    order_label TEXT,
    total_net_kg REAL,
    total_pkgs INTEGER,
    total_gross_kg REAL
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    shipment_id TEXT,
    description TEXT,
    type TEXT,
    net_kg REAL,
    pkgs INTEGER,
    gross_kg REAL,
    packaging TEXT,
    pallets INTEGER,
    FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
  )
`).run();

const app = express();
app.use(express.json({ limit: "2mb" }));
const upload = multer({ storage: multer.memoryStorage() });

/**
 * --- Simple Parser (adapt to your PDFs) ---
 */
function parseFieldsFromText(text) {
  const shipment_no = (text.match(/Shipment No.:\s*(\d+)/i) || [])[1] || "";
  const order_no = (text.match(/Order No.:\s*(\d+)/i) || [])[1] || "";
  const delivery_no = (text.match(/Delivery No.:\s*(\d+)/i) || [])[1] || "";
  const loading_date = (text.match(/Loading Date:\s*([\d.]+)/i) || [])[1] || "";
  const scheduled_delivery_date = (text.match(/Sched. Delivery Date:\s*([\d.]+)/i) || [])[1] || "";
  const way_of_forwarding = (text.match(/Way of Forwarding:\s*(.+)/i) || [])[1] || "";
  const delivery_terms = (text.match(/Delivery Terms:\s*(.+)/i) || [])[1] || "";
  const consignee_company = (text.match(/Delivery Address:\s*([\s\S]*?)Customer No./i) || [])[1] || "";
  const customer_no = (text.match(/Customer No.:\s*(\S+)/i) || [])[1] || "";
  const customer_po = (text.match(/Customer PO No.:\s*(.+)/i) || [])[1] || "";
  const notify_company = (text.match(/Notify:\s*([\s\S]*?)MARKS/i) || [])[1] || "";
  const marks_text = (text.match(/LABELLING:\s*([\s\S]*?)ORDER/i) || [])[1] || "";
  const order_label = (text.match(/ORDER No ([A-Za-z0-9/-]+)/i) || [])[1] || "";

  const total = text.match(/TOTAL\s*([\d.,]+)\s*KG\s+(\d+)\s+([\d.,]+)\s*KG/i);
  const total_net_kg = total ? parseFloat(total[1].replace(",", ".")) : 0;
  const total_pkgs = total ? parseInt(total[2], 10) : 0;
  const total_gross_kg = total ? parseFloat(total[3].replace(",", ".")) : 0;

  return {
    shipment_no,
    order_no,
    delivery_no,
    loading_date,
    scheduled_delivery_date,
    way_of_forwarding,
    delivery_terms,
    consignee_company,
    consignee_address: consignee_company,
    customer_no,
    customer_po,
    notify_company,
    notify_address: notify_company,
    marks_text,
    order_label,
    total_net_kg,
    total_pkgs,
    total_gross_kg,
    items: [],
  };
}

// --- Routes ---

// Frontend UI
app.get("/", (_req, res) => {
  res.type("html").send(`
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>Carrier PDF → Form</title>
    <style>
      body { font-family: sans-serif; background:#f5f6f7; padding:20px; }
      .drop { border:2px dashed #999; padding:20px; margin-bottom:20px; cursor:pointer; }
      input, textarea { width:100%; margin:5px 0; padding:6px; }
      button { margin-top:10px; padding:8px 14px; }
    </style>
  </head>
  <body>
    <h1>Carrier Notification: PDF → Structured Form</h1>
    <div class="drop" id="drop">Drop PDF here or click<input id="file" type="file" hidden /></div>
    <div id="status"></div>
    <form id="form"></form>
    <div id="recent"></div>
  <script>
    const drop=document.getElementById("drop"), file=document.getElementById("file");
    drop.addEventListener("click", ()=>file.click());
    drop.addEventListener("dragover", e=>{e.preventDefault();});
    drop.addEventListener("drop", e=>{e.preventDefault(); handle(e.dataTransfer.files);});
    file.addEventListener("change", e=>handle(e.target.files));
    async function handle(files){
      const f=files[0]; if(!f) return;
      const fd=new FormData(); fd.append("file", f);
      const r=await fetch("/api/upload",{method:"POST",body:fd});
      const js=await r.json();
      renderForm(js);
    }
    function renderForm(data){
      const form=document.getElementById("form");
      form.innerHTML="";
      for(const k in data){
        if(k==="items") continue;
        form.innerHTML+=\`<label>\${k}<input name="\${k}" value="\${data[k]||""}"></label>\`;
      }
      form.innerHTML+=\`<button type="button" onclick="save()">Save</button>\`;
    }
    async function save(){
      const fd=new FormData(document.getElementById("form"));
      const obj={}; fd.forEach((v,k)=>obj[k]=v);
      const r=await fetch("/api/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(obj)});
      const js=await r.json();
      document.getElementById("status").textContent="Saved "+js.id;
      loadRecent();
    }
    async function loadRecent(){
      const r=await fetch("/api/shipments"); const js=await r.json();
      let html="<h2>Recent Shipments</h2><ul>";
      js.forEach(s=>{html+=\`<li>\${s.created_at}: \${s.shipment_no||""} (\${s.consignee_company||""})</li>\`;});
      html+="</ul>"; document.getElementById("recent").innerHTML=html;
    }
    loadRecent();
  </script>
  </body>
  </html>
  `);
});

// Upload & parse PDF
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  try {
    const pdfData = await pdfParse(req.file.buffer);
    const parsed = parseFieldsFromText(pdfData.text || "");
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Parse failed" });
  }
});

// Save to DB
app.post("/api/save", (req, res) => {
  try {
    const s = req.body;
    const id = nanoid();
    const created_at = dayjs().toISOString();
    db.prepare(`
      INSERT INTO shipments (
        id, created_at, shipment_no, order_no, delivery_no, loading_date,
        scheduled_delivery_date, shipping_point, way_of_forwarding, delivery_terms,
        consignee_company, consignee_address, customer_no, customer_po,
        notify_company, notify_address, marks_text, order_label,
        total_net_kg, total_pkgs, total_gross_kg
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, created_at, s.shipment_no, s.order_no, s.delivery_no, s.loading_date,
      s.scheduled_delivery_date, s.shipping_point, s.way_of_forwarding, s.delivery_terms,
      s.consignee_company, s.consignee_address, s.customer_no, s.customer_po,
      s.notify_company, s.notify_address, s.marks_text, s.order_label,
      s.total_net_kg, s.total_pkgs, s.total_gross_kg
    );
    res.json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Save failed" });
  }
});

// List shipments
app.get("/api/shipments", (_req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM shipments ORDER BY created_at DESC LIMIT 20").all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "DB failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on :" + PORT));
