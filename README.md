# esprit mode — v1.0.0

Carte de fidélité (PWA) des boutiques esprit mode, Maisons-Alfort. Node.js + Express + PostgreSQL (Neon), hébergée sur Render.

Rôles (contrôlés côté serveur) :
- admin (Élie) : tout, y compris règle de fidélité, équipe, exports, suppressions RGPD ;
- manager (Michelle) : fiches clientes, bons, ajustements avec motif, annulations, campagnes ;
- seller (vendeuses) : caisse (recherche, création de cliente, achat, reprise de carte papier).

Règle par défaut : 1 € = 1 point ; carte pleine à 300 points = bon d'achat de 30 € valable 365 jours, créé automatiquement (réglable dans Administration).

Variables Render : DATABASE_URL (Neon), ADMIN_PASSWORD (10 caractères min.), PUBLIC_URL, TZ=Europe/Paris.
Aucun mot de passe n'est écrit dans le code.

Voir AUDIT-v0.8.md (état des lieux) et GUIDE-MISE-EN-LIGNE.md (passage en v0.9).

v1.0 : offres et vidéos de Michelle affichées sur la carte cliente ; envoi gratuit des e-mails via Brevo (300/jour, variables BREVO_API_KEY et BREVO_SENDER_EMAIL) ; SMS et WhatsApp envoyés une par une depuis le téléphone de Michelle (gratuit) ; boutique notée sur chaque achat ; suppression des campagnes.

## v1.1
Options activables (Administration → Options), toutes désactivées par défaut : bonus anniversaire (points choisis par Michelle), e-mails carte pleine / rappel, niveaux, bonus de bienvenue, journée spéciale, sauvegarde hebdo. Scan QR en caisse, ciblage des campagnes, affiche A5 (/affiche.html), import CSV.

## v1.2
Points hors soldes/promotions (champ en caisse). Chèques cadeaux et avoirs numérotés (/cheques.html, page publique /cheque.html?t=…), encaissement partiel, envoi e-mail, export CSV.
