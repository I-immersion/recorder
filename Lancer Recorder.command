#!/bin/bash
# LUMIIA Podcast Recorder — lanceur double-clic
# Place ce fichier où tu veux (Bureau, Dock, Applications…) et double-clique dessus.

# Aller dans le dossier de l'app (chemin absolu, ne dépend pas du dossier courant)
cd "/Users/emmanuelexbrayat/Dropbox/DB LUMIIA 2025/Outils APP Claude/Recorder" || {
  osascript -e 'display dialog "Dossier Recorder introuvable. Vérifie le chemin dans le fichier .command." buttons {"OK"} default button "OK" with icon stop'
  exit 1
}

# Lancer l'app
npm start

# Quand l'app se ferme, on laisse 2 secondes pour voir d'éventuels messages, puis on ferme
echo ""
echo "L'app s'est fermée. Cette fenêtre Terminal va se fermer dans 3 secondes…"
sleep 3
osascript -e 'tell application "Terminal" to close (every window whose name contains "Lancer Recorder")' &
exit 0
