# Passer à la v1.3.0

Rien ne change pour ce qui est déjà en place : le dépôt, Render, la base Neon, les données, les comptes et les mots de passe restent les mêmes.

## 1. Envoyer les fichiers sur GitHub
1. Décompressez **esprit-mode-v1.3.0.zip**.
2. Allez sur github.com/Sayag13/esprit-mode, puis **Add file** et **Upload files**.
3. Faites glisser tout le contenu du dossier, y compris le dossier `public`.
4. Écrivez le message `Version 1.3.0`, puis cliquez sur **Commit changes**.
5. Vérifiez sur https://esprit-mode.onrender.com/health : vous devez lire `"version":"1.3.0"`.

## 2. Les options (Administration, puis « Options »)
Au départ, **tout est désactivé**. Vous cochez ce que vous décidez d'utiliser, puis vous cliquez sur **Enregistrer les options**. Vous pouvez décocher à tout moment.

- **Anniversaires**
  - Michelle choisit le nombre de points pour chaque cliente : dans « Clientes & communication », carte « Anniversaires à venir », ou à la caisse sur la fiche. Le bonus ne peut être offert qu'une fois par an.
  - Le nombre indiqué dans les options (20) n'est qu'une proposition.
  - Vous décidez si les vendeuses peuvent offrir le bonus elles aussi.
  - Vous pouvez aussi rendre le bonus et l'e-mail d'anniversaire automatiques.
- **E-mails automatiques** : un e-mail « carte pleine » quand le bon est créé, et un rappel avant l'expiration d'un bon.
- **Niveaux** : Essentielle, Élégante, Icône, selon le total des achats. Les noms et les seuils se modifient.
- **Bonus de bienvenue** et **journée spéciale** (points × 2, par exemple).
- **Sauvegarde hebdomadaire** envoyée par e-mail (clientes et achats en fichier CSV).

## 3. Les nouveautés toujours disponibles
- **Caisse** : le bouton « Scanner la carte » lit le QR code de la cliente, et la date de naissance peut être notée à l'inscription.
- **Campagnes** : le choix « À qui ? » permet de cibler toutes les clientes, les inactives, celles qui sont proches du bon, celles qui ont un bon en cours, les anniversaires du mois ou une boutique.
- **Administration** :
  - **Affiche A5** à imprimer, avec le QR code d'inscription ;
  - **import des clientes** d'un fichier Excel enregistré en CSV, avec un aperçu avant de confirmer.
- **Carte à tampons** : comme sur la carte papier (le premier tampon apparaît dès 5 € d'achat), les nouveaux tampons « esprit mode » apparaissent avec un effet de coup de tampon quand la cliente ouvre sa carte après un achat (et en caisse juste après l'achat).
- **Qui sommes-nous ?** : la présentation d'esprit mode figure sur la page d'accueil et sur la carte des clientes.
- **Conditions d'utilisation** : nouvelles CGU en 7 articles, règles du programme, politique de confidentialité complète (RGPD) et rubrique Contact.
- **Mentions légales** : E.M.S 26, RCS Créteil 502 111 495, siège, directeur de la publication et hébergeur.

## 4. Nouveautés de la v1.2
- **Soldes et promotions** : en caisse, la case « Dont articles soldés ou en promotion » retire ce montant du calcul des points (ou cochez « Tout l'achat est soldé »).
- **Chèques cadeaux et avoirs** (menu « Chèques cadeaux ») :
  - créer un chèque cadeau (n° 0001, 0002…) ou un avoir (n° A-0001…) avec montant, fin de validité, « pour », « de la part de » ou « motif » ;
  - l'envoyer par e-mail, SMS ou WhatsApp, ou l'imprimer : l'acheteuse peut transférer le lien à la personne à qui elle l'offre ;
  - l'encaisser : taper le numéro ou scanner son QR code, puis « Déduire » (en une ou plusieurs fois) ;
  - seules Michelle et l'administration peuvent annuler un chèque ; export CSV dans Administration.
- **Conditions** : points hors soldes et promotions, aucun remboursement (avoir), règles des chèques cadeaux et avoirs.
- **Photo de la vitrine** : en haut de la page d'accueil, dans « Qui sommes-nous ? » sur la carte des clientes, et sur les chèques cadeaux.
- **Signature des chèques cadeaux** : Administration → « Signature des chèques cadeaux » → choisir la photo de la signature → Enregistrer. Stockée uniquement dans la base de données, jamais dans GitHub.
- **Affiche A4 « Carte de fidélité »** : Administration → « Affiche et import » → Ouvrir / imprimer ou Télécharger (PDF avec les vrais QR codes).
- **Aperçu de l'application** : Administration → « L'application vue par vos clientes » (page d'accueil et carte d'exemple, dans deux téléphones).
- **Retrouver ma carte** : si l'icône ou le lien ne trouve plus la carte, la cliente tape son numéro, reçoit un code par e-mail et sa carte s'ouvre ; l'icône l'ouvre ensuite directement.
