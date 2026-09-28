# Esprit Mode — déploiement de test gratuit

## Objectif
Obtenir une adresse provisoire `https://...onrender.com` pour tester l'application sur iPhone avant le lancement définitif.

## 1. Préparer un dépôt GitHub
Créer un dépôt privé nommé `esprit-mode` et y envoyer le contenu de ce dossier.

## 2. Créer le service Render
Sur Render : New → Web Service → connecter le dépôt GitHub.
- Runtime : Node
- Build command : `npm install`
- Start command : `npm start`
- Plan : Free

Variables d'environnement :
- `ADMIN_PASSWORD` : choisir un mot de passe administrateur fort.
- `PUBLIC_URL` : laisser vide au premier déploiement si nécessaire, puis mettre l'URL `https://NOM.onrender.com` après création.

## 3. Tester
Ouvrir l'URL Render sur iPhone.
- `/` : accueil / inscription
- `/admin.html` : espace boutique
- `/health` : contrôle technique

Compte initial :
- utilisateur : `admin`
- mot de passe : celui défini dans `ADMIN_PASSWORD`

## Attention — phase de test
Le plan gratuit Render convient au test, mais le service s'arrête après une période d'inactivité et son système de fichiers local est éphémère. SQLite ne doit donc pas être utilisé comme stockage définitif sur ce plan. Pour le lancement réel, migrer la base vers un stockage persistant.
