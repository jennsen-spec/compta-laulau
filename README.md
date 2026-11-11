# 🧾 Compta Laulau

Petite app (web installable sur Android) pour une travailleuse autonome :

1. 📷 Prendre en photo un ticket de caisse ou une facture
2. 🤖 L'app lit la date, le fournisseur, le total, la TPS et la TVQ (via l'API Claude)
3. 🏷️ Elle suggère une catégorie → on approuve, on choisit une existante, ou on en tape une nouvelle
4. 📊 Export Excel (onglet détail + onglet récap par catégorie)
5. 📁 Export ZIP : un PDF par facture, rangé dans un dossier par catégorie, + l'Excel
6. 📤 Sur Android, l'export ouvre le menu « Partager » (Gmail, Drive…) pour l'envoyer à la comptable

## Installer sur le téléphone (Android)

1. Ouvrir le lien GitHub Pages dans **Chrome**
2. Menu ⋮ → **Ajouter à l'écran d'accueil** / **Installer l'application**
3. Ouvrir l'app → ⚙️ → coller la clé API Anthropic (créée sur https://console.anthropic.com)

## Où sont les données ?

Tout reste **sur le téléphone** (IndexedDB du navigateur). Seule la photo est envoyée à l'API Anthropic pour être lue.
⚠️ Si on efface les données de Chrome ou qu'on désinstalle l'app, les factures sont perdues → exporter le ZIP régulièrement.

## Technique

- HTML/CSS/JS sans étape de build, hébergé sur GitHub Pages
- `app.js` : toute la logique (stockage, appel Claude, exports)
- `sw.js` : service worker (installation + fonctionnement hors ligne). Changer `CACHE` à chaque version.
- Librairies via CDN : SDK Anthropic, SheetJS (Excel), jsPDF, JSZip
- Icônes générées par `node tools/make-icons.mjs`

Tester en local : `python3 -m http.server 8765` puis http://localhost:8765
