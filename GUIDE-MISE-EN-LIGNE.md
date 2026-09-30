# Passer de v0.8 à v0.9 : ce que vous devez faire

Ce qui est déjà en place **ne change pas** : dépôt GitHub, service Render, adresse https://esprit-mode.onrender.com, base Neon, clientes, achats, comptes et identifiants (admin, mimi, elodiev, elodier).

Il y a **4 actions**, dans cet ordre. Durée : environ 20 minutes.

---

## Action 1 : vérifier le mot de passe administrateur dans Render (3 min)

Pourquoi : les anciens codes à 4 chiffres étaient lisibles par tout le monde sur GitHub. La v0.9 les désactive. Le compte **admin** prendra comme mot de passe la valeur de la variable `ADMIN_PASSWORD`, qui existe déjà dans votre configuration Render.

1. Ouvrez **dashboard.render.com**, puis le service **esprit-mode**, puis **Environment** dans le menu de gauche.
2. Regardez la ligne `ADMIN_PASSWORD` et cliquez sur l'œil pour voir sa valeur :
   - elle existe et fait **10 caractères ou plus** : notez-la, c'est votre futur mot de passe admin. Ne touchez à rien ;
   - elle fait moins de 10 caractères, ou elle n'existe pas : cliquez sur **Edit** (ou **Add Environment Variable**) et saisissez un mot de passe d'au moins 10 caractères, par exemple `Printemps-Alfort-2026!`. Notez-le, puis cliquez sur **Save Changes**.

Si la variable manque, la v0.9 refuse de démarrer. Dans ce cas, Render garde automatiquement l'ancienne version en ligne : rien ne casse.

## Action 2 : envoyer les fichiers v0.9 sur GitHub (10 min)

1. Décompressez **esprit-mode-v0.9.zip** : clic droit, puis « Extraire tout ».
2. Ouvrez **github.com/Sayag13/esprit-mode**.
3. Cliquez sur **Add file**, puis **Upload files**.
4. Faites glisser **tout le contenu** du dossier décompressé :
   - les fichiers `server.js`, `package.json`, `render.yaml`, `README.md`, `AUDIT-v0.8.md`, `GUIDE-MISE-EN-LIGNE.md` ;
   - **le dossier `public` entier**.

   Les fichiers qui portent le même nom sont remplacés. Les autres (`DEPLOIEMENT-TEST.md`, `public/icons`) restent intacts.
5. En bas, dans « Commit changes », écrivez **Version 0.9 – sécurité, bons d'achat, RGPD**, puis cliquez sur **Commit changes**.

## Action 3 : laisser Render déployer, puis vérifier (5 min)

1. Render déploie tout seul. Dans **Events**, attendez « Deploy live » (2 à 4 minutes).
   Si rien ne bouge au bout de 2 minutes : **Manual Deploy**, puis **Deploy latest commit**.
2. Ouvrez https://esprit-mode.onrender.com/health. Vous devez lire `"version":"0.9.0"` et `"storage":"postgres"`.
3. Si le déploiement échoue, ouvrez **Logs** et copiez-moi la ligne qui commence par « ERREUR ».

## Action 4 : donner un nouveau mot de passe à Michelle et aux vendeuses (5 min)

Leurs comptes existent toujours : seul leur ancien code est désactivé.

1. Ouvrez https://esprit-mode.onrender.com/login.html
   - Identifiant : **admin**
   - Mot de passe : celui de l'action 1
2. Dans **Administration**, rubrique **Équipe et accès**, trois comptes affichent « mot de passe à définir » : mimi, elodiev, elodier.
3. Pour chacun : **Nouveau mot de passe**, puis saisissez-en un de 8 caractères minimum, puis OK. Notez-le et donnez-le à la personne.
4. Chacune pourra ensuite le changer elle-même dans « Mon mot de passe ».

---

## Vérification rapide (facultative, 3 min)

Avec la cliente de test ÉLIE SAYAG (0613220753), qui a 100 points :

1. Dans **Caisse**, tapez 0613220753. Seule ÉLIE SAYAG apparaît. Cliquez sur **Choisir**.
2. Saisissez **200**, puis **Valider**. Vous devez voir « +200 points » et « **Carte pleine !** Bon d'achat de 30 € créé ». Le nouveau solde est 0.
3. Pour annuler ce test, allez dans **Clientes & communication**, ouvrez la fiche d'ÉLIE SAYAG, annulez d'abord le bon (« Annuler (rendre les points) »), puis l'achat.

## Recommandé ensuite (pas urgent)

- Passer le dépôt GitHub en **privé**. Vérifiez d'abord avec moi que Render y aura toujours accès.
