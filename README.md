# Pixel War ISMIN — Prêt pour l'infrastructure MINITEL (Coolify / Isadora)

Application web **Pixel War** (type *r/place*) temps réel, **zéro dépendance npm**, pensée pour PC et smartphone, **100% réglable en direct**, et adaptée dès le départ aux contraintes exactes de l'infra **MINITEL** (`minitel.dev`).

---

## Adaptations spécifiques à l'infrastructure MINITEL

| Contrainte MINITEL | Adaptation intégrée |
|---|---|
| **Tout le trafic entrant passe par le VPS (`100.110.19.122`) → Sakura (`10.163.0.10`)** : toutes les requêtes partagent la même IP | **Aucune limitation de débit ni cooldown par IP** (y compris sur le login admin). Identification par cookie signé `HttpOnly` (`pw_cid`) ou par compte **Authentik** (`X-Authentik-Uid`). Garde-fou empêchant tout ban d'IP. |
| **TLS terminé par Caddy sur Sakura → HTTP vers Traefik sur Isadora (`10.163.1.250:80`)** | L'application écoute en **HTTP pur sur le port interne `3000`**, détecte `X-Forwarded-Proto: https` pour poser des cookies `Secure` (indispensable sur `.dev` HSTS), et fait passer les WebSockets sur `/ws` (port 443 public, **zéro port supplémentaire sur le VPS ou `lib/flows.nix`**). |
| **UniFi sur Isadora (port 8080 interdit, pas de port publié sur l'hôte)** | Aucun port publié sur l'hôte, port interne `3000`, `cap_drop: [ALL]`, `no-new-privileges:true`, utilisateur non-root `node`, plafonds **`512 Mo RAM / 1 vCPU`**. |
| **Politique d'images Docker (§4.1)** | Image de base `node:22-alpine` **épinglée par empreinte `@sha256:...`**, jamais `latest`. |
| **Domaine wildcard `*.<asso>.minitel.dev`** | Aucune modification DNS, aucune modification Caddy, aucune modification pare-feu nécessaire pour un déploiement public. |

---

## Déploiement rapide sur Coolify (2 minutes)

### Étape 1 — Pousser le projet sur Git
Poussez ce dépôt sur GitHub (par ex. dans l'orga `Minitel-Ismin`). **Ne commitez jamais de fichier `.env` avec de vrais secrets.**

### Étape 2 — Créer la ressource dans `https://coolify.minitel.dev`
1. Connectez-vous sur `https://coolify.minitel.dev` (compte groupe `admins-infra`).
2. Cliquez sur **New Resource** → **Public / Private Repository** → sélectionnez ce dépôt.
3. **Serveur cible** : sélectionnez **`isadora`** (`10.163.1.250`) — *jamais `localhost` (Sakura)*.
4. **Build Pack** : `Dockerfile` *(ou `Docker Compose` si vous préférez utiliser `docker-compose.yml` directement)*.

### Étape 3 — Configurer le domaine, le stockage et les secrets
1. **Domains** (dans *Configuration → General*) :
   ```text
   http://pixelwar.<asso>.minitel.dev
   ```
   > ⚠️ **Mettez bien `http://` (pas `https://`) dans Coolify !**  
   > Remplacez `<asso>` par une asso autorisée par le vhost générique de Sakura (`minitel`, `bda`, `bde`, `arem`, `comif`, `bds`, `illumines`), par ex. `http://pixelwar.bde.minitel.dev` ou `http://pixelwar.minitel.dev`.  
   > Caddy sur Sakura génère automatiquement le certificat Let's Encrypt à la demande (`on_demand_tls`) et sert l'appli en **`https://pixelwar.<asso>.minitel.dev`** (et WebSockets `wss://`).
2. **Ports Exposes** : `3000` *(ne publiez aucun port sur l'hôte)*.
3. **Persistent Storage** (dans *Configuration → Storages*) :
   - Ajoutez un volume monté sur **`/data`** (ou bind mount cible `/srv/asso/<asso>/pixelwar` → `/data` sur Isadora) pour conserver le canvas, les snapshots PNG et l'historique timelapse.
4. **Environment Variables** (dans *Configuration → Environment Variables*) :
   - `ADMIN_PASSWORD` : mot de passe admin (ex. généré avec `openssl rand -base64 18`)
   - `SESSION_SECRET` : secret aléatoire (ex. généré avec `openssl rand -hex 32`)
   - `EVENT_TITLE` : ex. `Pixel War Promo ISMIN`
   - *(optionnel)* `CANVAS_WIDTH=128`, `CANVAS_HEIGHT=128`, `COOLDOWN_MS=5000`, `MAX_CHARGES=1`
5. **Resource Limits** (si Build Pack = `Dockerfile`) : `512M` RAM, `1` CPU.

### Étape 4 — Déployer et ouvrir !
Cliquez sur **Deploy**. Une fois le healthcheck `/health` au vert, ouvrez :
```text
https://pixelwar.<asso>.minitel.dev
```
Cliquez sur **⚙️ Admin** en haut à droite avec votre `ADMIN_PASSWORD` pour ajuster le cooldown, la taille, la palette, les annonces, les snapshots ou l'heure de fin **en direct**.

---

## Optionnel : Activer l'anti-triche par compte Authentik (`forward_auth`)

Par défaut, `https://pixelwar.<asso>.minitel.dev` est **publique** (idéal pour que toute la promo joue immédiatement sans créer de compte).

Si vous préférez **réserver la Pixel War aux comptes Authentik** (groupe `etudiants` ou une asso) pour rendre le cooldown **impossible à contourner en navigation privée** et obtenir le pseudo + les droits admin automatiquement :

1. Dans le dépôt `Minitel-Ismin/Nix_OS_Serv_Config` :
   - Ajoutez une route `forward_auth` dans `lib/routes.nix` pointant vers Isadora `10.163.1.250:80` pour `pixelwar.<asso>.minitel.dev`.
   - Ajoutez le fournisseur Proxy `forward_single` dans `roles/core/authentik/blueprints/minitel-applications.yaml` (lié au groupe `etudiants` + `admins-infra`) et attachez-le à l'avant-poste intégré.
2. Dans **Coolify**, ajoutez ces 3 variables d'environnement sur le conteneur :
   ```env
   TRUST_AUTHENTIK_HEADERS=true
   COOLDOWN_MODE=authentik
   AUTHENTIK_ADMIN_GROUPS=admins-infra,MINITEL
   ```
   - Chaque étudiant est identifié par `X-Authentik-Uid` (1 compte = 1 cooldown, même sur plusieurs appareils).
   - Le pseudo est pré-rempli depuis `X-Authentik-Username`.
   - Les membres des groupes listés dans `AUTHENTIK_ADMIN_GROUPS` sont **automatiquement administrateurs**.

---

## Tests locaux

```bash
# Lancer les tests d'intégration (HTTP, WebSockets, cooldown, proxy HTTPS, Authentik, PNG, snapshots)
npm test

# Démarrer en local sur http://localhost:3000
ADMIN_PASSWORD=test npm start
```
