# SOS Dev

> Quand l'IA ne suffit plus, un développeur te rejoint depuis ton terminal.

Projet CADEV 2026. Le concept complet est dans [`docs/sos-dev-concept-v2.pdf`](docs/sos-dev-concept-v2.pdf).

## Structure

| Dossier | Rôle | État |
| --- | --- | --- |
| `shared/` | Code commun : masquage des secrets, lecture des traces d'erreur, détection de la techno, format de la demande (Zod) | Étape 1 |
| `cli/` | La commande `sos` : lance ton programme, capture l'erreur, masque les secrets, affiche l'aperçu, puis fait le pont avec la salle SOS | Étapes 1 et 4 |
| `server/` | API NestJS + PostgreSQL : connexion GitHub, demandes, fiches, Radar et salle SOS temps réel (WebSocket `/ws`) | Étapes 2 à 4 |
| `web/` | Interface web (Vite + React) : le Radar des aidants et la salle SOS (CodeMirror + Yjs) | Étapes 3 et 4 |
| `examples/demo/` | Petit programme qui plante, avec de faux secrets, pour la démo | |
| `scripts/audit-licenses.mjs` | Audit des licences (règlement, article 6) | |

## Démarrage

Node.js 20 ou plus.

```bash
npm install
npm run build
```

Essayer la commande `sos` sur le programme de démo :

```bash
cd examples/demo
node ../../cli/dist/index.js npm start
```

Pour avoir la commande `sos` partout : `npm link -w cli`, puis `sos npm start` dans n'importe quel projet.

### Lancer le serveur (étape 2)

```bash
npm run db:up                         # PostgreSQL (+ pgvector) via Docker
cp server/.env.example server/.env    # puis ajuste si besoin
npm run build && npm run server       # API sur http://localhost:4000
```

Sans `DATABASE_URL`, le serveur démarre quand même avec un stockage en mémoire (pratique pour tester, tout disparaît à l'arrêt).

Puis, dans un autre terminal :

```bash
sos login --dev awa        # mode démo, sans GitHub
cd examples/demo && sos npm start
```

### Le Radar (étape 3)

```bash
npm run web      # http://localhost:5173 (le serveur doit tourner sur :4000)
```

1. L'aidant se connecte, coche ses technos et clique sur « Me rendre disponible ».
2. Le demandeur lance `sos npm start`. `sos` cherche d'abord des fiches qui ressemblent à l'erreur ; si aucune ne règle le problème, la demande part et le terminal affiche l'avancement en direct.
3. Les aidants de la même techno sont alertés tout de suite, ceux des technos proches après 2 minutes (`SOS_WIDEN_AFTER_SECONDS`), tous les aidants disponibles après 5 minutes (`SOS_PUBLIC_AFTER_SECONDS`, file publique).
4. Le premier qui clique sur « Accepter » prend la demande ; les autres la voient disparaître, et le terminal du demandeur affiche qui arrive. Ctrl+C dans le terminal annule la demande.

Les alertes ne montrent que la techno, la commande et la ligne d'erreur (déjà masquée). Le code n'est visible que dans la salle SOS.

Pour une démo rapide : `SOS_WIDEN_AFTER_SECONDS=10 SOS_PUBLIC_AFTER_SECONDS=20 npm run server`.

### La salle SOS (étape 4)

Quand un aidant accepte, il entre directement dans la salle (`/#/salle/<id>`), et `sos` reste ouvert dans le terminal du demandeur : c'est le pont entre la salle et sa machine. Seuls le demandeur et l'aidant qui a accepté peuvent y entrer.

- **Code partagé en direct** : les fichiers de la demande (déjà masqués) s'ouvrent dans un éditeur partagé (CodeMirror + Yjs). Chaque frappe est synchronisée.
- **Chat**, depuis le navigateur ou depuis le terminal (une ligne tapée dans `sos` part dans le chat). Le serveur masque à nouveau les secrets de chaque message.
- **Terminal du demandeur en lecture seule** : chaque relance s'affiche dans la salle. `sos` masque les secrets ligne par ligne avant l'envoi, le serveur repasse derrière.
- **« Envoyer mes corrections »** (aidant) : le demandeur voit le diff de chaque fichier modifié dans son terminal et répond `o/n`. Rien n'est écrit sans « o », et seuls les fichiers partagés, à l'intérieur du projet, peuvent l'être. Les lignes non modifiées gardent leurs vraies valeurs : un `[MASQUÉ:…]` n'est jamais écrit sur le disque (une correction qui modifie une ligne contenant un secret masqué est refusée).
- **« Demander une relance »** (aidant) : le terminal demande « Entrée pour lancer, n pour refuser ». Aucun code ne s'exécute sans l'accord du demandeur, et jamais sur le serveur.
- **« Problème résolu »** (ou `/resolu` dans le terminal) : la salle se ferme pour les deux, et le code est effacé du serveur immédiatement. Une annulation, ou l'expiration des 24 h, ferme aussi la salle.

Dans le terminal : `/relance` pour relancer soi-même, `/resolu`, `/quitter` (ou Ctrl+C) pour partir. `SOS_WEB_URL` (défaut `http://localhost:5173`) sert à afficher le lien de la salle dans le terminal.

### Connexion GitHub

`sos login` utilise le « device flow » de GitHub : le terminal affiche un code à saisir sur github.com, aucun mot de passe ne passe par le terminal. Il faut une OAuth App GitHub (Settings → Developer settings → OAuth Apps) avec **Enable Device Flow** coché, et mettre son Client ID dans `GITHUB_CLIENT_ID` (ce n'est pas un secret). Le serveur vérifie le jeton GitHub une fois, ne le garde pas, et donne à `sos` son propre jeton de session (stocké dans `~/.sos/config.json`, lisible par toi seul ; le serveur n'en garde que l'empreinte SHA-256).

Le mode démo (`sos login --dev <pseudo>`) est actif par défaut hors production ; `SOS_DEV_AUTH=0` le coupe.

### API

| Route | Rôle |
| --- | --- |
| `GET /health` | État du serveur |
| `GET /auth/config` | Client ID GitHub et mode démo |
| `POST /auth/github` · `POST /auth/dev` | Connexion, renvoie un jeton de session |
| `POST /auth/logout` · `GET /me` | Déconnexion, compte connecté |
| `POST /requests` | Envoyer une demande (3 par heure maximum) |
| `GET /requests` · `GET /requests/:id` | Mes demandes (le code n'est visible que par son auteur) |
| `POST /requests/:id/close` | Annuler ma demande |
| `GET /solutions/search?q=…&tech=…` | Chercher des fiches (public) |
| WebSocket `/ws` | Radar : `auth`, `disponible`, `pause`, `accepter` (aidant) · `suivre` (demandeur) |
| WebSocket `/ws` | Salle SOS : `rejoindre`, `yjs`, `message`, `resolu` · `proposer`, `relance` (aidant) · `terminal`, `execution`, `reponse`, `reponse-relance` (terminal du demandeur) |

À la réception, le serveur refait le masquage des secrets (au cas où le CLI serait ancien ou contourné), refuse les fichiers sensibles et les chemins hors du projet, et fixe l'effacement du code à 24 h maximum. Une purge tourne toutes les 10 minutes.

## La commande `sos`

```
sos [options] <commande...>
sos login [--dev <pseudo>] [--server <url>]
sos whoami | sos logout | sos send <fichier>

  -a, --add <fichier>  Ajouter un fichier à la demande (répétable)
  -y, --yes            Valider sans poser de question
      --dry-run        Afficher l'aperçu sans rien envoyer
      --json           Afficher la demande au format JSON
      --force          Préparer une demande même si la commande réussit
```

Ce qu'elle fait :

1. Lance la commande et affiche sa sortie en direct.
2. Si la commande plante, récupère les 200 dernières lignes de la sortie, les fichiers cités dans la trace d'erreur, les fichiers de dépendances (`package.json`, `requirements.txt`…) et les fichiers ajoutés avec `--add`. Limite : 10 fichiers, 200 Ko.
3. N'envoie jamais `.env*`, `*.pem`, `*.key`, les clés SSH, `.npmrc`… même avec `--add`. Respecte `.gitignore`.
4. Masque les secrets **sur ta machine** : clés connues (AWS, GitHub, Stripe, IA, Slack, Google, JWT), clés privées, mots de passe dans les URL, en-têtes `Authorization`, affectations du type `password=` ou `API_KEY =`, et les chaînes qui ont l'air aléatoires (calcul d'entropie).
5. Affiche les fiches qui ressemblent à l'erreur (seule la ligne d'erreur masquée est envoyée pour cette recherche). Si l'une règle le problème, rien n'est envoyé.
6. Affiche l'aperçu exact de la demande. Tu peux retirer des fichiers, puis tu valides.

7. Envoie la demande au serveur, puis attend un aidant en direct (`--no-wait` pour ne pas attendre). Si tu n'es pas connecté ou si le serveur est injoignable, elle est gardée dans `~/.sos/demandes/` et tu peux la renvoyer avec `sos send`.
8. Quand un aidant accepte, reste ouvert et relie ton terminal à la salle SOS (corrections validées par `o/n`, relances sur Entrée, chat).

## Vérifications

```bash
npm run typecheck
npm test
npm run build
npm run audit:licenses
```

Les tests PostgreSQL ne tournent que si `TEST_DATABASE_URL` pointe vers une base jetable (le schéma est effacé) : `TEST_DATABASE_URL=postgres://sos:sos@localhost:5432/sos npm test`.

L'intégration continue (`.github/workflows/ci.yml`) lance les mêmes vérifications à chaque push, avec une base PostgreSQL. L'audit parcourt toutes les dépendances, y compris les indirectes, et échoue si une licence GPL, AGPL ou LGPL apparaît.
