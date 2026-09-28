# ESPRIT MODE — application de fidélité

Version 0.5 — préparation au déploiement de test.

Application PWA Node.js + Express + SQLite, auto-hébergeable.

## Fonctionnalités
- inscription cliente publique
- carte fidélité personnelle
- QR code personnel
- points (1 € = 1 point)
- récompenses
- achats et historique
- comptes boutique
- recherche clientes
- export CSV
- statistiques
- PWA
- endpoint de santé `/health`

## Lancement local
```bash
npm install
ADMIN_PASSWORD='un-mot-de-passe-fort' npm start
```
Puis ouvrir http://localhost:3000

## Déploiement de test
Voir `DEPLOIEMENT-TEST.md` et `render.yaml`.


## Version 0.5
Ajout de la suppression sécurisée d’une cliente depuis l’espace boutique (administrateur), avec suppression de son historique d’achats et de ses récompenses utilisées.
