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
- **Display anlassen** (Screen Wake Lock), **WhatsApp-Teilen** und **Prospekt-Links** für Lüdinghausen.
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

1. Committen und pushen Sie alle Dateien in das GitHub-Repository, auf den Branch `main`.
2. Öffnen Sie auf GitHub **Settings → Pages → Build and deployment**, wählen Sie als *Source* **Deploy from a branch**, als Branch **`main`** und als Ordner **`/ (root)`** und klicken Sie auf **Save**.
3. Nach 1–2 Minuten ist die App erreichbar unter `https://<ihr-github-name>.github.io/<repo-name>/`.
4. Tragen Sie die Domain in Firebase ein: **Authentication → Einstellungen → Autorisierte Domains → Domain hinzufügen** → `<ihr-github-name>.github.io`.

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
