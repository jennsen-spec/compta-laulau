// Compta Laulau — MVP
// Flux : photo → lecture par Claude → vérification + catégorie → sauvegarde locale
// → export Excel (.xlsx) et PDF (un PDF par facture, dans un .zip rangé par catégorie).
// Tout est stocké sur le téléphone (IndexedDB). Rien n'est envoyé ailleurs qu'à l'API Anthropic.

import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm";
import * as drive from "./drive.js";

const APP_VERSION = "0.2.0";
const MODEL = "claude-opus-5-5";

// Catégories de départ, inspirées des dépenses d'un travailleur autonome au Québec.
// Elle peut en ajouter/supprimer librement.
const DEFAULT_CATEGORIES = [
  "Fournitures de bureau",
  "Repas et représentation",
  "Véhicule et essence",
  "Déplacements et stationnement",
  "Téléphone et internet",
  "Logiciels et abonnements",
  "Matériel et équipement",
  "Publicité et marketing",
  "Formation",
  "Honoraires professionnels",
  "Bureau à domicile",
  "Assurances",
  "Frais bancaires",
  "Autre",
];

// ---------- Stockage (IndexedDB) ----------
const db = await new Promise((resolve, reject) => {
  const req = indexedDB.open("compta-laulau", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("expenses", { keyPath: "id" });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function store(mode = "readonly") {
  return db.transaction("expenses", mode).objectStore("expenses");
}
const dbAll = () => new Promise((res, rej) => {
  const r = store().getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const dbPut = (item) => new Promise((res, rej) => {
  const r = store("readwrite").put(item); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
});
const dbDelete = (id) => new Promise((res, rej) => {
  const r = store("readwrite").delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
});

// Réglages simples (clé API, catégories) dans localStorage.
const settings = {
  get apiKey() { return localStorage.getItem("apiKey") || ""; },
  set apiKey(v) { localStorage.setItem("apiKey", v.trim()); },
  get categories() {
    const saved = JSON.parse(localStorage.getItem("categories") || "null");
    return saved || [...DEFAULT_CATEGORIES];
  },
  set categories(list) { localStorage.setItem("categories", JSON.stringify(list)); },
};

// ---------- Utilitaires ----------
const $ = (sel) => document.querySelector(sel);
const money = (n) => (Number(n) || 0).toLocaleString("fr-CA", { style: "currency", currency: "CAD" });

function show(view) {
  for (const v of ["list", "review", "settings"]) $(`#view-${v}`).hidden = v !== view;
  $("#fab").hidden = view !== "list";
}

// Réduit la photo (les photos de téléphone font souvent 5-10 Mo) en JPEG ~1600 px.
// Ça accélère l'envoi à l'API, réduit le coût et la taille des PDF.
async function compressImage(file, maxSide = 1600, quality = 0.82) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  return { dataUrl, width: canvas.width, height: canvas.height };
}

function safeName(s) {
  return (s || "inconnu").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "inconnu";
}
const fileBase = (e) => `${e.date}_${safeName(e.vendor)}_${Number(e.total).toFixed(2)}`;

// ---------- Lecture de la facture par Claude ----------
// On demande une réponse JSON qui respecte un schéma précis (structured outputs).
const RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["date", "vendor", "total", "gst", "qst", "gst_no", "qst_no", "payment", "category", "category_is_new", "confidence"],
  properties: {
    date: { type: "string", description: "Date de la facture au format YYYY-MM-DD" },
    vendor: { type: "string", description: "Nom du commerce ou fournisseur" },
    total: { type: "number", description: "Montant total payé, taxes incluses" },
    gst: { type: "number", description: "Montant TPS/GST (0 si absent)" },
    qst: { type: "number", description: "Montant TVQ/QST (0 si absent)" },
    gst_no: { type: "string", description: "Numéro d'inscription TPS du fournisseur (ex. 123456789RT0001), vide si absent" },
    qst_no: { type: "string", description: "Numéro d'inscription TVQ du fournisseur (ex. 1234567890TQ0001), vide si absent" },
    payment: { type: "string", enum: ["", "Carte de crédit", "Débit", "Comptant", "Virement", "Autre"] },
    category: { type: "string", description: "Catégorie suggérée" },
    category_is_new: { type: "boolean", description: "true si la catégorie n'est pas dans la liste existante" },
    confidence: { type: "string", enum: ["haute", "moyenne", "basse"] },
  },
};

async function readReceipt(dataUrl, categories, vendorHistory) {
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const base64 = dataUrl.split(",")[1];
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `Tu aides une travailleuse autonome au Québec à faire sa comptabilité.
Lis ce ticket de caisse ou cette facture et extrais les informations.

Catégories existantes : ${categories.join(" | ")}
Catégories déjà choisies pour certains fournisseurs : ${JSON.stringify(vendorHistory)}

Règles :
- Choisis de préférence une catégorie existante. Si le fournisseur a déjà une catégorie, réutilise-la.
- Propose une nouvelle catégorie seulement si aucune ne convient vraiment (category_is_new = true).
- Montants en dollars canadiens, nombres décimaux. Mets 0 pour une taxe absente.
- Elle est inscrite aux taxes et récupère la TPS et la TVQ payées : lis ces montants avec soin,
  ainsi que les numéros d'inscription TPS/TVQ du fournisseur s'ils sont imprimés.
- Si l'année n'est pas lisible, suppose l'année en cours (aujourd'hui : ${today}).
- confidence = "basse" si l'image est floue ou si des montants sont incertains.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: {
      effort: "low", // tâche simple : rapide et peu coûteux
      format: { type: "json_schema", schema: RECEIPT_SCHEMA },
    },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
        { type: "text", text: prompt },
      ],
    }],
  });

  if (response.stop_reason === "refusal") throw new Error("La lecture a été refusée par le modèle.");
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Réponse vide.");
  return JSON.parse(text);
}

// ---------- Écran liste ----------
async function renderList() {
  const items = (await dbAll()).sort((a, b) => b.date.localeCompare(a.date));
  const list = $("#list");
  list.innerHTML = "";
  $("#empty").hidden = items.length > 0;

  const total = items.reduce((s, e) => s + Number(e.total), 0);
  $("#summary").textContent = items.length
    ? `${items.length} facture${items.length > 1 ? "s" : ""} · ${money(total)}`
    : "";

  renderSyncBanner(items);

  for (const e of items) {
    const li = document.createElement("li");
    li.innerHTML = `
      <img src="${e.image}" alt="">
      <div class="info">
        <strong></strong>
        <span class="muted"></span>
        <span class="tag"></span>
      </div>
      <div class="amount"></div>`;
    // textContent pour éviter d'injecter du HTML venant de la facture
    li.querySelector("strong").textContent = e.vendor;
    li.querySelector(".muted").textContent = e.date;
    li.querySelector(".tag").textContent = e.category;
    li.querySelector(".amount").textContent = money(e.total) + (drive.isConnected() ? (e.synced ? " ☁️" : " ⏳") : "");
    li.onclick = () => openReview(e);
    list.appendChild(li);
  }
}

// ---------- Écran vérification ----------
let current = null; // dépense en cours d'édition

function fillCategoryList() {
  $("#categories").innerHTML = "";
  for (const c of settings.categories) {
    const o = document.createElement("option"); o.value = c; $("#categories").appendChild(o);
  }
}

function openReview(expense, status = "") {
  current = expense;
  const f = $("#review-form");
  for (const k of ["date", "vendor", "total", "gst", "qst", "gst_no", "qst_no", "payment", "category", "note"]) {
    f.elements[k].value = expense[k] ?? "";
  }
  $("#review-img").src = expense.image;
  $("#review-status").textContent = status;
  $("#category-hint").textContent = expense.categoryHint || "";
  $("#btn-cancel").textContent = expense.saved ? "Supprimer" : "Annuler";
  fillCategoryList();
  show("review");
}

async function onPhoto(file) {
  if (!settings.apiKey) {
    alert("Ajoute d'abord ta clé API dans les réglages ⚙️");
    show("settings");
    return;
  }
  const { dataUrl, width, height } = await compressImage(file);
  const draft = {
    id: crypto.randomUUID(), image: dataUrl, width, height,
    date: new Date().toISOString().slice(0, 10), vendor: "", total: "", gst: "", qst: "",
    payment: "", category: "", note: "", saved: false,
  };
  openReview(draft, "⏳ Lecture de la facture…");
  $("#btn-save").disabled = true;

  try {
    // Historique fournisseur → catégorie, pour que les suggestions apprennent de ses choix.
    const history = {};
    for (const e of await dbAll()) history[e.vendor] = e.category;

    const r = await readReceipt(dataUrl, settings.categories, history);
    Object.assign(draft, {
      date: r.date, vendor: r.vendor, total: r.total,
      gst: r.gst || "", qst: r.qst || "", gst_no: r.gst_no, qst_no: r.qst_no,
      payment: r.payment, category: r.category,
      categoryHint: r.category_is_new
        ? `💡 Nouvelle catégorie suggérée : « ${r.category} ». Garde-la ou choisis-en une existante.`
        : `💡 Catégorie suggérée : « ${r.category} ». Tu peux la changer.`,
    });
    const warn = r.confidence === "basse" ? "⚠️ Photo difficile à lire — vérifie bien les montants." : "✅ Lu ! Vérifie et enregistre.";
    if (current === draft) openReview(draft, warn);
  } catch (err) {
    console.error(err);
    if (current === draft) openReview(draft, `❌ Lecture impossible (${err.message}). Remplis à la main.`);
  } finally {
    $("#btn-save").disabled = false;
  }
}

async function onSave(ev) {
  ev.preventDefault();
  const f = ev.target.elements;
  const category = f.category.value.trim();
  if (current.saved) markYearDirty(current.date.slice(0, 4)); // l'année a pu changer
  Object.assign(current, {
    date: f.date.value, vendor: f.vendor.value.trim(),
    total: Number(f.total.value), gst: Number(f.gst.value) || 0, qst: Number(f.qst.value) || 0,
    gst_no: f.gst_no.value.trim(), qst_no: f.qst_no.value.trim(),
    payment: f.payment.value, category, note: f.note.value.trim(), saved: true, synced: false,
  });
  delete current.categoryHint;
  markYearDirty(current.date.slice(0, 4));

  // Nouvelle catégorie tapée à la main → on l'ajoute à la liste.
  const cats = settings.categories;
  if (!cats.includes(category)) settings.categories = [...cats, category];

  await dbPut(current);
  current = null;
  show("list");
  await renderList();
  syncToDrive();
}

async function onCancel() {
  if (current?.saved && confirm("Supprimer cette facture ?")) {
    if (current.driveId) queueDriveDelete(current.driveId);
    markYearDirty(current.date.slice(0, 4));
    await dbDelete(current.id);
    current = null;
    show("list");
    await renderList();
    syncToDrive();
    return;
  }
  current = null;
  show("list");
  renderList();
}

// ---------- Synchro Google Drive ----------
// Chaque facture enregistrée est marquée synced=false, puis envoyée dès que possible.
// Si Google demande de se reconnecter (jeton expiré au bout d'1 h), un bandeau
// "toucher pour envoyer" apparaît : la fenêtre Google doit être ouverte par un clic.
const readSet = (k) => new Set(JSON.parse(localStorage.getItem(k) || "[]"));
const writeSet = (k, s) => localStorage.setItem(k, JSON.stringify([...s]));
function markYearDirty(year) { const s = readSet("dirtyYears"); s.add(year); writeSet("dirtyYears", s); }
function queueDriveDelete(id) { const s = readSet("driveDeletes"); s.add(id); writeSet("driveDeletes", s); }

let syncing = false;

async function syncToDrive({ interactive = false } = {}) {
  if (!drive.isConfigured() || !drive.isConnected() || syncing) return;
  syncing = true;
  try {
    if (!drive.hasValidToken()) {
      if (!interactive) return; // on attend un clic sur le bandeau
      await drive.connect();
    }
    renderSyncBanner(await dbAll(), "☁️ Envoi sur Drive…");

    for (const id of readSet("driveDeletes")) {
      await drive.deleteFile(id);
      const s = readSet("driveDeletes"); s.delete(id); writeSet("driveDeletes", s);
    }

    for (const e of (await dbAll()).filter((x) => !x.synced)) {
      const info = await drive.syncExpense(e, {
        pdfBlob: buildPdf(e), pdfName: `${fileBase(e)}.pdf`, categoryFolder: e.category,
      });
      Object.assign(e, info, { synced: true });
      await dbPut(e);
    }

    // Excel de chaque année modifiée.
    const all = await dbAll();
    for (const year of readSet("dirtyYears")) {
      await drive.syncYearSheet(year, buildXlsx(all.filter((e) => e.date.startsWith(year))));
      const s = readSet("dirtyYears"); s.delete(year); writeSet("dirtyYears", s);
    }
  } catch (err) {
    console.error(err);
    if (err.message !== "NEED_LOGIN") alert(`Envoi sur Drive impossible : ${err.message}`);
  } finally {
    syncing = false;
    renderList();
  }
}

function renderSyncBanner(items, text) {
  const b = $("#sync-banner");
  if (!drive.isConfigured() || !drive.isConnected()) { b.hidden = true; return; }
  const pending = items.filter((e) => !e.synced).length;
  const dirty = pending || readSet("driveDeletes").size || readSet("dirtyYears").size;
  b.hidden = false;
  b.disabled = Boolean(text) || !dirty;
  b.textContent = text || (dirty
    ? `☁️ ${pending || "Des"} changement${pending > 1 ? "s" : ""} à envoyer sur Drive — toucher pour envoyer`
    : "☁️ Tout est sur Google Drive ✓");
}

// ---------- Exports ----------
function sortedForExport(items) {
  return items.sort((a, b) => a.date.localeCompare(b.date));
}

function buildXlsx(items) {
  const rows = sortedForExport(items).map((e) => ({
    Date: e.date,
    Fournisseur: e.vendor,
    Catégorie: e.category,
    "Total TTC": e.total,
    TPS: e.gst,
    TVQ: e.qst,
    "Montant HT": Math.round((e.total - e.gst - e.qst) * 100) / 100,
    "N° TPS fournisseur": e.gst_no || "",
    "N° TVQ fournisseur": e.qst_no || "",
    Paiement: e.payment,
    Note: e.note,
    "Fichier PDF": `${safeName(e.category)}/${fileBase(e)}.pdf`,
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [12, 28, 26, 12, 10, 10, 12, 18, 18, 16, 24, 50].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, "Dépenses");

  // Onglet récapitulatif par catégorie : pratique pour la comptable.
  const byCat = {};
  for (const e of items) {
    byCat[e.category] ??= { Catégorie: e.category, Nombre: 0, "Total TTC": 0, TPS: 0, TVQ: 0 };
    const c = byCat[e.category];
    c.Nombre++; c["Total TTC"] += e.total; c.TPS += e.gst; c.TVQ += e.qst;
  }
  const recap = Object.values(byCat).map((c) => ({
    ...c, "Total TTC": +c["Total TTC"].toFixed(2), TPS: +c.TPS.toFixed(2), TVQ: +c.TVQ.toFixed(2),
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(recap), "Par catégorie");

  return new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })],
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// Un PDF par facture : la photo, avec une ligne d'info en haut.
function buildPdf(e) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: "mm", format: "letter" });
  const pageW = 215.9, pageH = 279.4, margin = 12;
  pdf.setFontSize(10);
  pdf.text(`${e.date} · ${e.vendor} · ${money(e.total)} · ${e.category}`, margin, margin);
  const maxW = pageW - 2 * margin, maxH = pageH - 2 * margin - 6;
  const ratio = Math.min(maxW / e.width, maxH / e.height);
  pdf.addImage(e.image, "JPEG", margin, margin + 6, e.width * ratio, e.height * ratio);
  return pdf.output("blob");
}

async function buildZip(items) {
  const zip = new JSZip();
  for (const e of items) zip.file(`${safeName(e.category)}/${fileBase(e)}.pdf`, buildPdf(e));
  zip.file("depenses.xlsx", buildXlsx(items));
  return zip.generateAsync({ type: "blob" });
}

// Sur Android, on ouvre le menu "Partager" (Gmail, Drive, WhatsApp…). Sinon, téléchargement.
async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (err) { if (err.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function exportWith(builder, ext) {
  const items = await dbAll();
  if (!items.length) return alert("Rien à exporter pour l'instant.");
  const stamp = new Date().toISOString().slice(0, 10);
  await shareOrDownload(await builder(items), `depenses_${stamp}.${ext}`);
}

// ---------- Réglages ----------
function renderSettings() {
  $("#api-key").value = settings.apiKey;
  const ul = $("#cat-list");
  ul.innerHTML = "";
  for (const c of settings.categories) {
    const li = document.createElement("li");
    li.textContent = c + " ✕";
    li.title = "Retirer";
    li.onclick = () => {
      if (!confirm(`Retirer la catégorie « ${c} » ? (les factures déjà classées ne changent pas)`)) return;
      settings.categories = settings.categories.filter((x) => x !== c);
      renderSettings();
    };
    ul.appendChild(li);
  }
  $("#version").textContent = `Version ${APP_VERSION} · modèle ${MODEL}`;

  const btn = $("#btn-drive");
  if (!drive.isConfigured()) {
    $("#drive-status").textContent = "Google Drive pas encore configuré (Client ID manquant dans drive.js).";
    btn.hidden = true;
  } else if (drive.isConnected()) {
    $("#drive-status").textContent = "✅ Connecté : les factures vont dans « Compta Laulau » sur ton Drive.";
    btn.hidden = false; btn.textContent = "Déconnecter Google Drive"; btn.className = "secondary";
  } else {
    $("#drive-status").textContent = "Pas connecté. Les factures restent seulement sur ce téléphone.";
    btn.hidden = false; btn.textContent = "Connecter mon Google Drive"; btn.className = "";
  }
}

async function onDriveButton() {
  if (drive.isConnected()) {
    if (!confirm("Déconnecter Drive ? (les fichiers déjà envoyés restent sur ton Drive)")) return;
    drive.disconnect();
    renderSettings();
    return;
  }
  try {
    await drive.connect();
    // Première connexion : tout ce qui existe déjà doit partir sur Drive.
    const all = await dbAll();
    for (const e of all) { e.synced = false; await dbPut(e); markYearDirty(e.date.slice(0, 4)); }
    renderSettings();
    syncToDrive();
  } catch (err) {
    alert(`Connexion Google impossible : ${err.message}`);
  }
}

// ---------- Branchements ----------
$("#file").onchange = (ev) => { const f = ev.target.files[0]; ev.target.value = ""; if (f) onPhoto(f); };
$("#review-form").onsubmit = onSave;
$("#btn-cancel").onclick = onCancel;
$("#btn-export-xlsx").onclick = () => exportWith(buildXlsx, "xlsx");
$("#btn-export-zip").onclick = () => exportWith(buildZip, "zip");
$("#btn-settings").onclick = () => { renderSettings(); show("settings"); };
$("#btn-drive").onclick = onDriveButton;
$("#sync-banner").onclick = () => syncToDrive({ interactive: true });
$("#btn-settings-done").onclick = () => { settings.apiKey = $("#api-key").value; show("list"); };

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

show("list");
await renderList();
syncToDrive(); // rattrape ce qui n'est pas parti, si le jeton est encore valide
