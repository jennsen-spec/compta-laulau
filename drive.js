// Synchro Google Drive — dans le Drive de la personne connectée (le sien).
// Permission "drive.file" : l'app ne voit QUE les fichiers qu'elle a créés elle-même,
// jamais le reste de son Drive.
//
// Rangement : Mon Drive / Compta Laulau / 2026 / <Catégorie> / <date_fournisseur_montant>.pdf
//             Mon Drive / Compta Laulau / 2026 / depenses-2026.xlsx

// Client ID OAuth "Application Web" créé dans Google Cloud (voir GOOGLE_SETUP.md).
// Ce n'est pas un secret : il peut être public dans le code.
export const GOOGLE_CLIENT_ID = "";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const ROOT_NAME = "Compta Laulau";

let tokenClient = null;

export const isConfigured = () => Boolean(GOOGLE_CLIENT_ID);

// Jeton d'accès (valable ~1 h), gardé dans localStorage pour éviter de redemander à chaque fois.
function savedToken() {
  try {
    const t = JSON.parse(localStorage.getItem("driveToken") || "null");
    return t && t.expires > Date.now() + 60_000 ? t.value : null;
  } catch { return null; }
}
export const isConnected = () => Boolean(localStorage.getItem("driveEverConnected"));
export const hasValidToken = () => Boolean(savedToken());

// Doit être appelé depuis un clic (sinon la fenêtre Google est bloquée).
export function connect() {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) return reject(new Error("Google pas encore chargé, réessaie."));
    tokenClient ??= google.accounts.oauth2.initTokenClient({ client_id: GOOGLE_CLIENT_ID, scope: SCOPE, callback: () => {} });
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error));
      localStorage.setItem("driveToken", JSON.stringify({
        value: resp.access_token, expires: Date.now() + resp.expires_in * 1000,
      }));
      localStorage.setItem("driveEverConnected", "1");
      resolve();
    };
    tokenClient.error_callback = (err) => reject(new Error(err.type || "connexion annulée"));
    // Pas d'écran de consentement si elle a déjà accepté.
    tokenClient.requestAccessToken({ prompt: isConnected() ? "" : "consent" });
  });
}

export function disconnect() {
  const t = savedToken();
  if (t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t);
  localStorage.removeItem("driveToken");
  localStorage.removeItem("driveEverConnected");
  localStorage.removeItem("driveFolders");
}

async function call(url, opts = {}) {
  const token = savedToken();
  if (!token) throw new Error("NEED_LOGIN");
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...opts.headers } });
  if (res.status === 401) { localStorage.removeItem("driveToken"); throw new Error("NEED_LOGIN"); }
  if (!res.ok) throw Object.assign(new Error(`Drive ${res.status}: ${await res.text()}`), { status: res.status });
  return res.status === 204 ? null : res.json();
}

// ---------- Dossiers (avec cache des identifiants) ----------
const folderCache = () => JSON.parse(localStorage.getItem("driveFolders") || "{}");

async function findOrCreateFolder(name, parentId) {
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`;
  const found = await call(`${API}?q=${encodeURIComponent(q)}&fields=files(id)`);
  if (found.files.length) return found.files[0].id;
  const created = await call(`${API}?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  return created.id;
}

// Ex. folderPath(["2026", "Formation"]) → id du dossier Compta Laulau/2026/Formation
async function folderPath(parts) {
  const cache = folderCache();
  let parent = "root";
  const path = [ROOT_NAME, ...parts];
  for (let i = 0; i < path.length; i++) {
    const key = path.slice(0, i + 1).join("/");
    if (!cache[key]) {
      cache[key] = await findOrCreateFolder(path[i], parent);
      localStorage.setItem("driveFolders", JSON.stringify(cache));
    }
    parent = cache[key];
  }
  return parent;
}

// ---------- Fichiers ----------
function multipart(metadata, blob) {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", blob);
  return form;
}

// Crée ou met à jour un fichier. Si fileId est fourni, on remplace le contenu et
// on déplace le fichier si le dossier a changé (ex. changement de catégorie).
async function putFile({ fileId, oldParentId, parentId, name, blob }) {
  if (fileId) {
    const move = oldParentId && oldParentId !== parentId
      ? `&addParents=${parentId}&removeParents=${oldParentId}` : "";
    try {
      return await call(`${UPLOAD}/${fileId}?uploadType=multipart&fields=id${move}`, {
        method: "PATCH", body: multipart({ name }, blob),
      });
    } catch (err) {
      if (err.status !== 404) throw err; // fichier supprimé à la main → on le recrée
    }
  }
  return call(`${UPLOAD}?uploadType=multipart&fields=id`, {
    method: "POST", body: multipart({ name, parents: [parentId] }, blob),
  });
}

// Envoie une dépense (PDF) ; renvoie les infos Drive à mémoriser sur la dépense.
export async function syncExpense(e, { pdfBlob, pdfName, categoryFolder }) {
  const year = e.date.slice(0, 4);
  const run = async () => {
    const parentId = await folderPath([year, categoryFolder]);
    const file = await putFile({ fileId: e.driveId, oldParentId: e.driveParent, parentId, name: pdfName, blob: pdfBlob });
    return { driveId: file.id, driveParent: parentId };
  };
  try { return await run(); }
  catch (err) {
    // Un dossier a pu être supprimé à la main : on vide le cache et on réessaie une fois.
    if (err.status !== 404) throw err;
    localStorage.removeItem("driveFolders");
    return run();
  }
}

// Remplace l'Excel de l'année.
export async function syncYearSheet(year, xlsxBlob) {
  const ids = JSON.parse(localStorage.getItem("driveSheets") || "{}");
  const parentId = await folderPath([year]);
  const file = await putFile({ fileId: ids[year], parentId, name: `depenses-${year}.xlsx`, blob: xlsxBlob });
  ids[year] = file.id;
  localStorage.setItem("driveSheets", JSON.stringify(ids));
}

export async function deleteFile(fileId) {
  try { await call(`${API}/${fileId}`, { method: "DELETE" }); }
  catch (err) { if (err.status !== 404) throw err; }
}
