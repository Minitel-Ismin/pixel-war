# Pixel War ISMIN — Authentik obligatoire & Infra MINITEL

Application web **Pixel War** (type *r/place*) temps réel, **zéro dépendance npm**, pensée pour PC et smartphone, **100% réglable en direct par les administrateurs**, et verrouillée sur **Authentik MINITEL** (`minitel.dev`).

---

## Sécurité & Contrôle d'accès

- **Authentik obligatoire (`REQUIRE_AUTHENTIK=true` par défaut)** :
  - **Tout** est verrouillé si l'utilisateur n'est pas authentifié via Authentik (`X-Authentik-Uid` / `X-Authentik-Username`) : page web (`401`), API (`401`), export, historique, et **handshake WebSocket `/ws` refusé avant connexion (`401`)**. Seul `/health` reste accessible pour le healthcheck Docker/Coolify.
  - **1 compte Authentik = 1 cooldown** (`COOLDOWN_MODE=authentik`) : impossible de tricher en navigation privée, et **aucune limitation par IP** (compatible avec l'IP unique du VPS `100.110.19.122`).
- **Administration strictement réservée aux admins (`403 Forbidden` pour tous les autres)** :
  - Le bouton **`⚙️ Admin`** et les outils pinceau admin sont **totalement masqués** pour les utilisateurs non-admins.
  - **Aucun mot de passe admin par défaut** : la connexion par mot de passe est désactivée sauf si `ADMIN_PASSWORD` est explicitement renseigné.
  - Sont administrateurs :
    1. Les membres des groupes listés dans `AUTHENTIK_ADMIN_GROUPS` (par défaut **uniquement `admins-infra`**).
    2. Les identifiants listés dans `ADMIN_USERS` (variable Coolify, ex. `arthur,alice`).
    3. **Les utilisateurs ajoutés dynamiquement** dans l'onglet **`👑 Admins`** du panneau Admin (sauvegardés dans `/data/state.json`, prise d'effet immédiate en temps réel via WebSocket).
  - Les droits admin sont re-vérifiés côté serveur sur **chaque requête `/api/admin/*`** et **chaque message WebSocket `place`**.

---

## Déploiement sur l'infrastructure MINITEL

### 1. Brancher Authentik `forward_auth` sur Sakura (`Minitel-Ismin/Nix_OS_Serv_Config`)
Pour que Caddy transmette les en-têtes `X-Authentik-*` à l'application sur Isadora :
1. Dans `lib/routes.nix`, ajoutez une route dédiée avec `auth = "forward_auth"` pointant vers Isadora `10.163.1.250:80` (ex. `pixelwar.<asso>.minitel.dev`).
2. Dans `roles/core/authentik/blueprints/minitel-applications.yaml`, ajoutez un fournisseur Proxy `forward_single` pour `https://pixelwar.<asso>.minitel.dev`, attachez-le à l'avant-poste intégré, et liez-le aux groupes autorisés (ex. `etudiants`, `admins-infra`).

### 2. Déployer le conteneur dans Coolify (`https://coolify.minitel.dev`)
1. **New Resource** → sélectionnez votre dépôt Git → serveur cible **`isadora`** (`10.163.1.250`) → Build Pack **`Dockerfile`** (ou `Docker Compose`).
2. **Domain** (en **`http://`**, Caddy sur Sakura termine le TLS) :
   ```text
   http://pixelwar.<asso>.minitel.dev
   ```
3. **Ports Exposes** : `3000` *(ne publiez aucun port sur l'hôte ; ne jamais utiliser `8080` réservé à UniFi)*.
4. **Persistent Storage** : montez un volume sur **`/data`** (ou `/srv/asso/<asso>/pixelwar` → `/data`).
5. **Environment Variables** :
   - `SESSION_SECRET` : secret aléatoire (`openssl rand -hex 32`)
   - `REQUIRE_AUTHENTIK=true`
   - `TRUST_AUTHENTIK_HEADERS=true`
   - `AUTHENTIK_ADMIN_GROUPS=admins-infra`
   - `ADMIN_USERS=ton_username_authentik` *(optionnel : tes identifiants admin fixes)*
   - `ADMIN_PASSWORD=` *(laisser vide pour désactiver le login par mot de passe)*
   - `COOLDOWN_MODE=authentik`
6. **Resource Limits** : `512M` RAM, `1` CPU → **Deploy** !

### 3. Ajouter d'autres administrateurs en direct
Une fois connecté avec votre compte admin Authentik, ouvrez **⚙️ Admin → onglet `👑 Admins`** :
- Saisissez n'importe quel **identifiant Authentik (`username`)** pour lui donner les droits admin, ou cliquez sur **`+ Promouvoir admin`** dans la liste des utilisateurs connectés.
- Vous pouvez aussi retirer les droits en 1 clic (le retrait prend effet instantanément côté serveur et ferme son panneau admin).

---

## Tests locaux

```bash
# Lancer tous les tests de sécurité et d'intégration
npm test

# Tester en local sans Authentik (dev uniquement !)
REQUIRE_AUTHENTIK=false ADMIN_PASSWORD=dev npm start
```
