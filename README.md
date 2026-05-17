# LUMIIA Podcast Recorder

Enregistreur podcast multi-pistes piloté en OSC depuis Chataigne. Application Electron desktop pour Mac (compatible Linux/Windows).

## Installation (une fois)

```bash
cd lumiia-podcast
npm install
```

L'installation télécharge Electron (~250 Mo) et le binaire ffmpeg correspondant à ta plateforme. Prend 2-3 minutes la première fois.

## Lancement

```bash
npm start
```

## Premier démarrage — configuration

1. **Autoriser l'accès au microphone** quand macOS le demande (sinon les noms d'interfaces audio n'apparaissent pas).
2. **Sélectionner ton interface audio** : la Behringer Wing apparaîtra comme `Wing` ou `BEHRINGER WING` selon la version du driver.
3. **Choisir le nombre de paires stéréo** à enregistrer (1, 2, 4 ou 8). Pour 4 micros podcast classique → 4 paires (8 canaux).
4. **Définir le dossier de sortie**. Par défaut : `~/Podcasts/LUMIIA/`.
5. **Ports OSC** :
   - IN (Chataigne → app) : `7777` par défaut
   - OUT (app → Chataigne) : `127.0.0.1:7000` par défaut

La configuration est sauvegardée. Bouton "Configuration" dans la top bar pour la modifier plus tard.

## Utilisation

### Manuel
- **Bouton REC** (ou barre espace) → démarre une session
- **Bouton STOP** → sauvegarde et termine
- **Bouton PAUSE** → met en pause sans terminer la session
- **Touche M** → pose un marker au moment courant
- **Touche Entrée** dans le champ marker → ajoute le marker avec note

### Via Chataigne (OSC IN sur port 7777)

| Adresse | Argument | Action |
|---|---|---|
| `/podcast/rec` | (optionnel) titre string | Démarre l'enregistrement |
| `/podcast/stop` | — | Stoppe et sauvegarde |
| `/podcast/pause` | — | Pause / reprise (toggle) |
| `/podcast/marker` | (optionnel) note string | Pose un marker |
| `/podcast/new` | (optionnel) titre string | Stop + nouvelle session immédiate |

### OSC OUT envoyés (vers 127.0.0.1:7000 par défaut)

| Adresse | Type | Fréquence |
|---|---|---|
| `/podcast/state` | string : `idle` / `recording` / `paused` | À chaque changement |
| `/podcast/level/{N}` | float 0.0–1.0 (peak max de la paire N) | 10 Hz |
| `/podcast/duration` | int (secondes écoulées) | 10 Hz |
| `/podcast/marker` | string timeStr, string note | À chaque marker |

Utilisable côté Chataigne pour piloter des LEDs DMX (rouge = recording, jaune = paused), des indicateurs de niveau, ou synchroniser un compteur sur scène.

## Fichiers produits

Chaque session crée un dossier `~/Podcasts/LUMIIA/2026-05-15_19h30_<titre>/` contenant :

```
master_stereo.wav     # paire 1-2, 48 kHz 24-bit PCM
master_stereo.mp3     # même paire en MP3 320 kbps (généré à l'arrêt)
track_1-2.wav         # paire 1 brute
track_3-4.wav         # paire 2 brute
track_5-6.wav         # paire 3 brute
track_7-8.wav         # paire 4 brute
markers.txt           # markers tabulés : timestamp \t note
session.json          # métadonnées complètes
```

Le MP3 master se génère en arrière-plan après le STOP. Notification "Master MP3 généré" quand c'est prêt.

## Raccourcis clavier

| Touche | Action |
|---|---|
| `Espace` | REC si idle, PAUSE si recording |
| `M` | Marker rapide (sans note) |
| `Entrée` (dans champ marker) | Marker avec note |

## Notes techniques

- **Sample rate** : 48 kHz fixe (standard podcast/broadcast)
- **Bit depth WAV** : 24-bit (qualité studio)
- **Multi-canaux Wing** : l'app demande à l'OS `channelCount` égal au nombre de canaux (paires × 2). Si l'interface fournit moins, l'app s'adapte automatiquement et notifie.
- **Aucun traitement appliqué** : `echoCancellation`, `noiseSuppression`, `autoGainControl` désactivés. Signal Wing récupéré tel quel.
- **Écriture streamée** : les fichiers WAV sont écrits au fur et à mesure (pas de buffer mémoire). Tu peux enregistrer des sessions de plusieurs heures sans craindre la RAM.
- **Pause** : les samples ne sont pas écrits pendant la pause, le timer s'arrête, mais la session reste ouverte. STOP pour vraiment terminer.

## Partage client (v2)

Module à venir : upload du MP3 master vers un serveur (Scaleway Object Storage / RPi local / VPS) + génération d'un lien signé + envoi mail au client via Mailjet. Décision sur le backend à prendre dans une session dédiée.

## Dépendances

- `electron@28` — runtime desktop
- `node-osc@9` — serveur et client OSC UDP
- `ffmpeg-static@5` — binaire ffmpeg embarqué pour conversion WAV → MP3

Aucune dépendance native qui demande de compiler. `npm install` fonctionne sur Mac M1/M2/M3 sans config spéciale.
