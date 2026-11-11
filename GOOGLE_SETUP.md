# Brancher Google Drive (à faire une seule fois, ~10 min)

Le « Client ID » identifie l'app auprès de Google. Tu peux le créer avec **ton** compte Google :
c'est quand même **elle** qui se connecte dans l'app, et les fichiers vont dans **son** Drive.
L'app demande seulement la permission `drive.file` : elle voit uniquement les fichiers qu'elle a créés.

1. Aller sur https://console.cloud.google.com → créer un projet « Compta Laulau ».
2. **API et services → Bibliothèque** → chercher « Google Drive API » → **Activer**.
3. **API et services → Écran de consentement OAuth** (ou « Google Auth Platform ») :
   - Type d'utilisateur : **Externe**
   - Nom de l'app : Compta Laulau, e-mail d'assistance : le tien
   - Accès aux données : ajouter le champ d'application `.../auth/drive.file`
   - Audience → **Utilisateurs test** : ajouter **son adresse Gmail** (et la tienne pour tester)
4. **Identifiants → Créer des identifiants → ID client OAuth** :
   - Type : **Application Web**
   - Origines JavaScript autorisées :
     - `https://jennsen-spec.github.io`
     - `http://localhost:8765` (pour tester sur l'ordi)
   - Créer → copier l'**ID client** (`xxxx.apps.googleusercontent.com`).
5. Me le donner (ou le coller dans `drive.js`, ligne `GOOGLE_CLIENT_ID`), puis pousser sur GitHub.

Dans l'app : ⚙️ → **Connecter mon Google Drive** → elle choisit son compte → accepte.
Google affichera « Google n'a pas validé cette application » : c'est normal pour une app perso,
cliquer **Continuer**.

À savoir : la connexion Google dure ~1 h. Après, un bandeau « toucher pour envoyer » apparaît
et un toucher suffit pour se reconnecter (pas de mot de passe à retaper en général).
