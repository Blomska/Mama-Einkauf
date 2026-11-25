# 🛒 Mama-Einkauf – Familien-Einkaufsliste

Gemeinsame Einkaufsliste für **Marktkauf** und **Aldi Nord** in **59348 Lüdinghausen**.
Ohne Login, mit Echtzeit-Abgleich für die ganze Familie, installierbar als App auf dem Handy.

**Funktionen**

- **Smart-Paste:** `2x Milch, 500g Hackfleisch; Bananen und Brot` wird zu vier Artikeln mit Mengen. Funktioniert auch mit Diktat und mit Text, der aus WhatsApp kopiert wurde.
- **Laden-Auswahl** (Beide / Marktkauf / Aldi) und **Filter-Tabs** mit Zählern.
- **Automatische Kategorien** in Laufweg-Reihenfolge. Korrigierte Kategorien merkt sich die App.
- **„Oft gekauft“:** Die häufigsten Artikel lassen sich mit einem Tipp wieder hinzufügen. Mamas feste Favoriten (`MAMA_FAVORITES` in `config.js`) stehen immer vorne, mit ⭐.
- **Angebote markieren:** Wer im Prospekt etwas entdeckt, tippt auf „🏷️ Angebote markieren“ und wählt den Laden, der Preis ist optional. Das Angebot erscheint für die ganze Familie als farbiges Schild an Favoriten und Listeneinträgen und läuft am Samstagabend automatisch ab.
- **Abhaken mit Animation**, ein einklappbarer Bereich „Im Einkaufswagen“ und **„Abgehakte löschen“** mit Rückgängig.
- **Prospekte direkt in der App:** Der Aldi-Prospekt lässt sich Seite für Seite durchblättern, für diese und die nächste Woche. Dazu kommen alle Aldi-Angebote als durchsuchbare Liste mit Bild und Preis, ein Tipp auf ＋ setzt ein Angebot auf die Liste. Für Marktkauf Nientied gibt es Titelbild, Gültigkeit und den Blätterkatalog.
- **Automatische Angebots-Erkennung:** Steht z. B. Avocado im Aldi-Angebot, bekommen der Favorit „Avocados“ und der Listeneintrag automatisch ein 🏷️-Schild mit Preis.
- **Spracheingabe (🎤)** und **Vorschläge beim Tippen**.
- **Kochbuch (📖):** Rezepte aus den Wochenideen und vom Küchenhelfer mit „⭐ Ins Kochbuch“ dauerhaft speichern – gemeinsam für die Familie, mit automatischen Kategorien, ❤️ Lieblingsrezepten, Suche, Notizen und Portionen-Umrechnung. Eigene Rezepte erzählt man einfach dem Helfer.
- **Kochmodus (👩‍🍳):** Rezept Schritt für Schritt in großer Schrift, Display bleibt an, Timer mit Ton direkt aus den Zeitangaben („20 Minuten backen“). Wischen oder Knöpfe zum Blättern.
- **Rezept aus Foto oder Link (📷):** Kochbuchseite oder Zeitschrift abfotografieren, Link einfügen (z. B. Chefkoch) oder Text einfügen – der Helfer liest das Rezept aus und legt es ins Kochbuch. Auf Android geht das auch über „Teilen“ aus Chefkoch & Co. direkt in die App.
- **„Im Angebot“ im Kochbuch (🏷️):** Zeigt Rezepte aus dem Kochbuch, für die gerade Zutaten bei Aldi oder Marktkauf im Angebot sind, die meisten Treffer zuerst.
- **Familien-Gedächtnis (🧠):** Vorlieben wie „Milch immer 1,5 %“ oder „viel Hähnchen“ merkt sich die App. Startwissen steht in `wissen.js`, Neues lernt der Küchenhelfer im Chat („Soll ich mir das merken?“). Ersetzungen gelten sofort beim Eintragen („Milch“ → „Milch 1,5 %“). Helfer und Wochenrezepte berücksichtigen das Gedächtnis.
- **Display anlassen** (Screen Wake Lock) und **WhatsApp-Teilen**.
- **Offline-fähig:** Was im Funkloch abgehakt wird, gleicht sich später automatisch ab.

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Seitenstruktur |
| `style.css` | Design (Mobile-First, große Touch-Flächen) |
| `app.js` | App-Logik, Firebase-Anbindung, Rendering |
| `categories.js` | Kategorien, Keyword-Wörterbuch, Eingabe-Parser (hier erweitern) |
| `config.js` | **Hier tragen Sie die Firebase-Config ein**, außerdem Listen-Name und Prospekt-Links |
| `manifest.json`, `sw.js`, `icons/` | PWA (Startbildschirm, Offline) |
| `scripts/update-prospekte.mjs` | Holt Prospekte und Angebote nach `data/prospekte.json` |
| `.github/workflows/deploy.yml` | Ruft die Prospekte täglich ab, startet die KI-Auswertung und veröffentlicht die App |
| `scripts/ki-auswertung.mjs` | Gemini: Marktkauf-Produkte aus dem Prospekt + Rezepte der Woche |
| `lib/gemini.mjs` | Gemeinsamer Gemini-Baustein (strukturierte Antworten, automatische Modellwahl) |
| `worker/` + `.github/workflows/chat-helfer.yml` | Küchenhelfer (Chat) als Cloudflare Worker |

> Solange in `config.js` noch die Platzhalter stehen, läuft die App im **Demo-Modus**. Dann funktioniert alles, die Liste wird aber nur auf dem jeweiligen Gerät gespeichert.

---

## In 4 Schritten live schalten

### 1. Firebase-Projekt anlegen

1. Öffnen Sie <https://console.firebase.google.com>, klicken Sie auf **Projekt hinzufügen** und wählen Sie einen Namen, z. B. `mama-einkauf`. Google Analytics wird nicht gebraucht.
2. Gehen Sie links auf **Build → Firestore Database → Datenbank erstellen**, wählen Sie den Standort **`eur3 (Europe)`** und starten Sie im **Produktionsmodus**.
3. Gehen Sie links auf **Build → Authentication → Jetzt starten → Anmeldemethode → „Anonym“ aktivieren**.
   *Für Ihre Familie gibt es trotzdem **keinen** Login. Die App meldet sich unsichtbar im Hintergrund an. Das schützt die Datenbank vor Fremden.*

### 2. Datenbank-Regeln setzen

Öffnen Sie in Firestore den Reiter **Regeln**, ersetzen Sie den Inhalt durch Folgendes und klicken Sie auf **Veröffentlichen**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /lists/{listId}/items/{itemId} {
      allow read, delete: if request.auth != null;
      allow create, update: if request.auth != null
        && request.resource.data.name is string
        && request.resource.data.name.size() <= 80;
    }
    match /lists/{listId}/offers/{offerId} {
      allow read, delete: if request.auth != null;
      allow create, update: if request.auth != null
        && request.resource.data.store in ['marktkauf', 'aldi'];
    }
    match /lists/{listId}/kochbuch/{recipeId} {
      allow read, delete: if request.auth != null;
      allow create, update: if request.auth != null
        && request.resource.data.titel is string
        && request.resource.data.titel.size() <= 120;
    }
    match /lists/{listId}/wissen/{entryId} {
      allow read, delete: if request.auth != null;
      allow create, update: if request.auth != null
        && (entryId == '_start' || (request.resource.data.text is string
            && request.resource.data.text.size() <= 240));
    }
  }
}
```

### 3. Firebase-Config in `config.js` eintragen

1. Öffnen Sie in Firebase **⚙️ Projekteinstellungen → Allgemein → Meine Apps** und klicken Sie auf das **Web-Symbol `</>`**. Vergeben Sie einen App-Namen. „Firebase Hosting“ wird **nicht** gebraucht.
2. Kopieren Sie die angezeigten Werte in `config.js`:

```js
export const firebaseConfig = {
  apiKey: 'AIza…',
  authDomain: 'mama-einkauf.firebaseapp.com',
  projectId: 'mama-einkauf',
  storageBucket: 'mama-einkauf.appspot.com',
  messagingSenderId: '1234567890',
  appId: '1:1234567890:web:abc123'
};

export const LIST_ID = 'familie-einkauf'; // gleicher Name = gleiche Liste auf allen Geräten
```

*Diese Werte sind kein Geheimnis. Jede Firebase-Web-App zeigt sie im Browser. Den Schutz übernehmen die Regeln aus Schritt 2.*

### 4. Über GitHub Pages veröffentlichen

1. Committen und pushen Sie alle Dateien in das GitHub-Repository.
2. Öffnen Sie auf GitHub **Settings → Pages → Build and deployment** und wählen Sie als *Source* **GitHub Actions**.
3. Der Workflow „Prospekte aktualisieren & veröffentlichen“ läuft bei jedem Push und **zweimal täglich** automatisch. Er holt die aktuellen Prospekte und Angebote und veröffentlicht die App. Von Hand starten können Sie ihn unter **Actions → Workflow → Run workflow**.
4. Die App ist erreichbar unter `https://<ihr-github-name>.github.io/<Repo-Name>/`. **Achten Sie auf die Groß- und Kleinschreibung des Repo-Namens!**
5. Tragen Sie die Domain in Firebase ein: **Authentication → Einstellungen → Autorisierte Domains** → `<ihr-github-name>.github.io`.

**Auf dem Handy installieren**

- **Android (Chrome):** Seite öffnen, dann **⋮ → „Zum Startbildschirm hinzufügen“** bzw. „App installieren“.
- **iPhone (Safari):** Seite öffnen, dann **Teilen-Symbol → „Zum Home-Bildschirm“**.

Danach startet die Liste wie eine normale App im Vollbild.

---

## Anpassen & Pflege

- **Neue Begriffe für Kategorien:** Tragen Sie sie in `categories.js` in das passende `keywords`-Array ein, in Kleinbuchstaben. Ein vorangestelltes `=` bedeutet „nur als ganzes Wort“, damit z. B. `=ei` nicht in „Reis“ greift.
- **Prospekt-Links ändern:** Das geht über `OFFER_LINKS` in `config.js`.
- **Mamas Favoriten ändern:** Passen Sie dazu `MAMA_FAVORITES` in `config.js` an.
- **Nach Änderungen am Code:** Zählen Sie in `sw.js` die `CACHE_VERSION` hoch (z. B. `v2`). Die Geräte laden dann beim nächsten Öffnen automatisch die neue Version.
- **Angebote (Zukunft):** Jeder Artikel hat schon die Felder `isOffer` und `offerPrice`. Ist `isOffer: true` gesetzt, zeigt die App ein 🏷️-Angebots-Badge an. Diese Felder kann später ein automatischer Angebots-Feed befüllen.

## Prospekte & Angebote (automatisch)

Der GitHub-Workflow startet `scripts/update-prospekte.mjs`. Das Skript liest diese Quellen aus:

| Quelle | Was |
|---|---|
| `aldi-nord.de/prospekte/aldi-aktuell.html` & `…/aldi-vorschau.html` | Prospektseiten als Bilder (diese und nächste Woche) und PDF-Link |
| `aldi-nord.de/angebote.html` | Alle Aldi-Angebote mit Name, Marke, Preis, Gültigkeit und Bild |
| `edeka-nientied.de/angebote-marktkauf-nientied-luedinghausen/` | Marktkauf: Gültigkeit, Titelbild und Link zum Blätterkatalog |
| `blaetterkatalog.edeka.de/RHEINRUHR/MARKTKAUF_1844/…` | Offizieller EDEKA-Prospekt von Marktkauf Nientied: Alle Seiten werden heruntergeladen und über GitHub Pages ausgeliefert (`data/mk-seiten/`, nicht im Repository) |
| `edeka.de/eh/service/eh/offers?marketId=10008010` | Marktkauf-Angebote als Liste. Wird nur genutzt, wenn EDEKA den automatischen Abruf zulässt, sonst übersprungen |

- Fällt eine Quelle aus, bleiben die zuletzt gespeicherten Daten erhalten.
- Ändern die Shops ihre Webseiten, muss eventuell das Skript angepasst werden. Die App funktioniert in diesem Fall trotzdem weiter, nur ohne neue Prospekte.
- Lokal testen: `node scripts/update-prospekte.mjs` (Node 18+).

## KI-Funktionen: Rezepte, Marktkauf-Produkte & Küchenhelfer (optional)

Alle drei Funktionen nutzen **Google Gemini**. Ohne Einrichtung läuft die App ganz normal weiter. Die KI-Teile bleiben dann einfach leer.

| Funktion | Was passiert | Wo es läuft |
|---|---|---|
| **Marktkauf-Produkte antippen** | Gemini liest einmal pro Woche den Marktkauf-Prospekt und schreibt alle Produkte mit Preis und Seite heraus. Unter jeder Prospektseite kann Mama sie antippen. | GitHub-Workflow (`scripts/ki-auswertung.mjs`) |
| **Rezepte der Woche** | 5 Familienrezepte aus den aktuellen Angeboten. Die Zutaten landen mit einem Tipp auf der Liste. | GitHub-Workflow |
| **Küchenhelfer (Chat)** | Mama fragt z. B. „Dienstag 4 Leute zum Frühstück, was brauche ich?“. Der Helfer schlägt Artikel zum Übernehmen vor. | Cloudflare Worker (`worker/`) |

Der gemeinsame Gemini-Baustein liegt in `lib/gemini.mjs`. Standardmodell ist `gemini-3.8-flash`. Kennt Ihr Schlüssel dieses Modell nicht, wird automatisch das neueste verfügbare Flash-Modell gewählt. Ein bestimmtes Modell erzwingen Sie so:
- für Rezepte/Prospekt mit der GitHub-**Variable** `GEMINI_MODEL` (Settings → Secrets and variables → Actions → Variables),
- für den Chat mit einer Variable `GEMINI_MODEL` in `worker/wrangler.toml` unter `[vars]`.

### A. Gemini-Schlüssel besorgen (für alles)
1. Melden Sie sich auf <https://aistudio.google.com> mit einem Google-Konto an.
2. Klicken Sie auf **Get API key → API-Schlüssel erstellen** und kopieren Sie den Schlüssel.
3. Tragen Sie ihn auf GitHub ein: **Repository → Settings → Secrets and variables → Actions → New repository secret**, mit dem Namen `GEMINI_API_KEY`.

Damit funktionieren **Rezepte und Marktkauf-Produkte** ab dem nächsten Workflow-Lauf. Zum Sofort-Testen starten Sie unter **Actions → „Prospekte aktualisieren & veröffentlichen“ → Run workflow**.

### B. Küchenhelfer freischalten (Chat)
Der Chat braucht einen kleinen Server, weil der API-Schlüssel nie in der App stehen darf. Dafür eignet sich ein kostenloser **Cloudflare Worker**:

1. Konto auf <https://dash.cloudflare.com> anlegen (kostenlos).
2. **Konto-ID**: Sie steht im Dashboard rechts unter „Account ID“.
3. **API-Token**: Gehen Sie auf **My Profile → API Tokens → Create Token** und wählen Sie die Vorlage **„Edit Cloudflare Workers“**.
4. Legen Sie auf GitHub drei weitere Secrets an:
   - `CLOUDFLARE_API_TOKEN` (das Token aus Schritt 3)
   - `CLOUDFLARE_ACCOUNT_ID` (die ID aus Schritt 2)
   - `FAMILY_CODE`: ein frei gewählter Familien-Code (z. B. `Lüdi2026`). Mama gibt ihn einmal im Helfer ein, danach merkt sich das Handy ihn. Er schützt vor fremder Nutzung.
5. Starten Sie unter **Actions → „Chat-Helfer veröffentlichen“ → Run workflow**. Im Protokoll steht am Ende die Adresse, z. B. `https://mama-einkauf-helfer.<name>.workers.dev`.
6. Tragen Sie diese Adresse in `config.js` bei `CHAT_URL` ein und committen Sie die Änderung. Fertig!

### Kosten & Datenschutz
- **Kostenloses Kontingent:** Google bietet für Gemini-Flash-Modelle ein kostenloses Kontingent mit Ratenlimits. Für eine Familie reicht das normalerweise: Pro Woche gibt es nur wenige Anfragen für Prospekt und Rezepte, dazu die Chat-Fragen. Die aktuellen Limits stehen auf <https://ai.google.dev/gemini-api/docs/pricing>.
- **Datenschutz:** Im kostenlosen Kontingent darf Google die Eingaben laut seinen Bedingungen zur Verbesserung seiner Produkte verwenden. Geben Sie also nichts Vertrauliches in den Chat ein. Wer das nicht möchte, aktiviert in AI Studio die Abrechnung (bezahltes Kontingent).
- Prospekt- und Rezept-Ergebnisse werden zwischengespeichert. Gemini wird nur gefragt, wenn sich Prospekt oder Angebote ändern.
- Cloudflare Worker: kostenlos (bis 100.000 Anfragen pro Tag).

## Lokal testen

```bash
python3 -m http.server 8000
# → http://localhost:8000 öffnen
```

(Service Worker und Module brauchen einen Webserver. Das direkte Öffnen der `index.html` per Doppelklick funktioniert nicht.)

## Fehlerhilfe

| Anzeige oben | Bedeutung / Lösung |
|---|---|
| 🟣 *Demo-Modus* | Die Config in `config.js` ist noch nicht eingetragen. |
| 🟢 *Live* | Alles in Ordnung. Die Liste ist mit allen Geräten synchron. |
| 🟡 *Offline* | Es gibt kein Netz. Änderungen werden gespeichert und später abgeglichen. |
| 🔴 *Kein Zugriff* | Prüfen Sie, ob die Anmeldung „Anonym“ aktiviert ist (Schritt 1.3) und die Regeln veröffentlicht sind (Schritt 2). |
