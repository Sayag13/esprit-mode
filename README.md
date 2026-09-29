# Esprit Mode — v0.8.4

Rôles :
- admin : Élie, back-office complet
- manager : Michelle, gestion commerciale et communication
- seller : vendeuses, saisie des achats uniquement

La communication est préparée dans l'espace Michelle. Les connecteurs SMS/e-mail/WhatsApp/réseaux sociaux devront être raccordés avant l'envoi réel.

## Données persistantes

La version 0.7.2 peut utiliser PostgreSQL via la variable d'environnement `DATABASE_URL`. Lorsqu'elle est présente, toutes les données de l'application sont conservées dans une base PostgreSQL distante. Sans cette variable, l'application conserve le mode fichier local pour les tests.

Pour Render Free, un PostgreSQL Render gratuit est possible mais expire après 30 jours. Pour une base gratuite durable, utiliser un fournisseur PostgreSQL externe compatible, puis renseigner sa chaîne `DATABASE_URL` dans Render.


### Réseaux sociaux cliente
- Instagram : https://www.instagram.com/channel/AbaNU8DS6tgq9Eq6/
- Facebook : https://www.facebook.com/share/v/1Dn4Wx3Ww8/
- Threads : non utilisé.
