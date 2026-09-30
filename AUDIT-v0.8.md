# Audit de l'existant (dépôt GitHub Sayag13/esprit-mode, branche main)

Analysé le 30/09/2026 sur le code réellement publié : dernier commit `b36dbed` « Version 0.8.5 – nouvelle icône ». Il fait suite au commit `11cbeb8` (v0.8.3).
Les commits 0.8.4 et 0.8.5 n'ont ajouté que les QR codes Instagram/Facebook et l'icône. La page /health affiche encore « 0.8.3 ».

## Ce qui fonctionne réellement (conservé dans v0.9)

| Domaine | État |
|---|---|
| PostgreSQL Neon via DATABASE_URL, données persistantes | ✅ conservé, même table `app_state`, aucune donnée touchée |
| Rôles admin / manager / seller contrôlés côté serveur | ✅ conservés, mêmes comptes, mêmes identifiants |
| Inscription cliente (4 champs obligatoires, CGU obligatoire, e-mail et SMS séparés) | ✅ |
| Recherche téléphone / nom / e-mail, cliente unique si correspondance exacte | ✅ |
| Création rapide par les vendeuses, e-mail obligatoire, refus des doublons de téléphone | ✅ |
| Achat → points (1 € = 1 point, réglable) | ✅ |
| Fiche Michelle : historique, CA individuel, ajustement de points avec motif | ✅ |
| Carte cliente par lien personnel + QR personnel | ✅ |
| QR d'installation, bouton « Partager l'application », 2 boutiques, téléphone, Instagram/Facebook | ✅ |
| Charte : « esprit mode » en minuscules, anthracite sur fond crème, icône | ✅ inchangée |

## Problèmes trouvés dans le code réel

1. **Critique :** les 4 mots de passe (1326, 0912, 9459, 9447) sont écrits dans `server.js`, et **le dépôt GitHub est public**. N'importe qui peut ouvrir l'espace admin et voir les données des clientes.
2. **Critique :** faille XSS dans admin.html et vente.html. Un « nom » piégé saisi à l'inscription peut voler la session d'Élie.
3. Mots de passe hachés sans sel (SHA-256 de 4 chiffres), aucune limite d'essais, connexion stockée en clair (Basic).
4. Enregistrement en base « sans attendre » : un achat peut s'afficher comme réussi alors que l'écriture a échoué.
5. `loyalty_adjustments` sans compteur d'identifiant : les ajustements reçoivent un identifiant vide.
6. Bouton « Exporter les clientes CSV » cassé : le mot de passe n'est pas envoyé et l'export tombe sur la page de connexion.
7. Les campagnes ne tiennent pas compte des consentements.
8. La cliente peut changer son numéro de téléphone pour celui d'une autre cliente.
9. Récompense par défaut « 100 points = 10 € » : ce n'est pas la règle de la carte papier. Les bons n'ont ni validité ni suivi.
10. Le message de partage contient le lien deux fois.

## Ce que v0.9 corrige (une seule version regroupée)

Tous les points ci-dessus, sans changer d'adresse, de base, de comptes ou de charte :

- **Règle de la carte papier :** 300 points = bon de 30 € valable 1 an, créé automatiquement. Seuil, valeur, validité et conditions sont réglables par Élie. L'ancienne récompense de 10 € est désactivée, son historique conservé.
- **Bons d'achat suivis :** actifs, utilisés, expirés ou annulés. Annulation d'un achat avec trace. Reprise des cartes papier.
- **Grille à tampons** identique à la carte papier, dans l'espace cliente et en caisse.
- **Consentements respectés :** listes d'envoi limitées aux clientes qui ont accepté, lien de désinscription, demande de suppression par la cliente, suppression RGPD par Élie.
- **Journal des actions sensibles** et page « Mon mot de passe ».

## Reste à développer (proposé pour la v1.0, regroupé)

- « Les vidéos de Michelle » et « Offres et nouveautés » dans l'espace cliente, alimentées par Michelle.
- Bonus : anniversaire, inscription, journée spéciale, collection.
- Niveau de fidélité : **règle à décider par Élie**, car la carte papier n'en a pas.
- Boutique notée sur chaque achat, avec statistiques par boutique.
- Export Excel .xlsx (aujourd'hui CSV, qui s'ouvre dans Excel).
- Envoi réel des e-mails et SMS : nécessite un service d'envoi.
- À envisager : base Neon en Europe plutôt qu'aux États-Unis (Ohio), pour le RGPD.
