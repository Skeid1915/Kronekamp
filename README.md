# Kronekamp: Skeid – Stjørdals-Blink

Nettside der bedrifter og supportere registrerer seg selv med et beløp per tilskuer.
Forsiden oppdateres automatisk, og administrasjonen gir fakturaliste (CSV) til Tripletex.

## Slik legger du den ut på Railway

1. Legg mappen i et nytt GitHub-repo (eller kjør `railway up` fra mappen med Railway CLI).
2. I Railway: lag et nytt prosjekt og velg «Deploy from GitHub repo».
3. Legg til en PostgreSQL-database i samme prosjekt.
4. Åpne tjenesten (ikke databasen), gå til Variables og legg inn:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (referanse til databasen)
   - `ADMIN_PASSWORD` = et sterkt passord du velger selv
5. Under Settings → Networking: trykk «Generate Domain» for å få en offentlig adresse.
   Vil dere bruke f.eks. kronekamp.skeid.no, legger dere inn et eget domene der og en CNAME hos domeneleverandøren.

Tabellene opprettes automatisk ved første oppstart.

## Bruk

- Forsiden: `https://<domenet>/`
- Administrasjon: `https://<domenet>/admin` (brukernavn `admin`, passord = `ADMIN_PASSWORD`)

Etter kampen legger du inn det offisielle tilskuertallet i administrasjonen.
Da stenges påmeldingen, forsiden viser resultatet, og «Last ned fakturaliste» blir aktiv.

## Valgfrie variabler

| Variabel | Standard | Forklaring |
|---|---|---|
| `EXPECTED_ATTENDANCE` | 600 | Forventet tilskuertall for estimatet på forsiden |
| `ADMIN_USER` | admin | Brukernavn til administrasjonen |
| `MATCH_TEXT` | Kronekamp Skeid – Stjørdals-Blink 31.10.2026 | Starten på fakturateksten i CSV |
| `PGSSL` | (av) | Sett til `true` hvis databasen krever SSL (ikke nødvendig på Railways interne nett) |

## Kjøre lokalt

```
npm install
DATABASE_URL=postgres://bruker:passord@localhost/kronekamp ADMIN_PASSWORD=test npm start
```
