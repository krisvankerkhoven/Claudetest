# Deelkas

Kosten delen met vrienden, zoals Splitwise. Geen account nodig: wie de groepslink heeft, doet mee.

Statische webapp (HTML, CSS, JS, geen build) met Supabase als gedeelde database.

## Lokaal proberen

Open `index.html` in een browser. Zonder configuratie bewaart de app alles in die ene browser.

## Delen met vrienden

1. Maak een gratis project op supabase.com.
2. Voer `supabase/schema.sql` uit in de SQL Editor.
3. Vul `supabaseUrl` en `supabaseAnonKey` (Project settings, API) in `config.js` in.
4. Host de map `deelkas/` als statische site: Cloudflare Pages, Netlify, Vercel of GitHub Pages.
5. Maak een groep en stuur de link (`...#g=<code>`) naar je vrienden.

## Veiligheid

- De tabellen hebben row level security zonder policies. Alles loopt via SQL-functies die de groepscode controleren.
- De groepscode is 20 willekeurige hex-tekens. Wie de link heeft, kan alles lezen en wijzigen. Deel hem enkel met vrienden.
- De `anon` key in `config.js` is publiek bedoeld. Gebruik nooit de `service_role` key.
- Er is geen limiet per IP. Voor publiek gebruik zou je rate limiting en groepsverwijdering toevoegen.

## Afspraken

- Bedragen in cent, alleen euro.
- Een lid met uitgaven kan niet verwijderd worden.
- De pagina ververst elke 6 seconden en na elke wijziging.
