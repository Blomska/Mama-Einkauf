# „Rezept für Mama“: Rezepte mit ChatGPT oder Claude einlesen

Die eingebaute Foto-Erkennung der App nutzt Gemini. Wer ein stärkeres Modell möchte, legt sich einmal ein eigenes GPT (ChatGPT) oder ein Projekt (Claude) mit dem Prompt unten an. Diese KI liest ein Foto und schreibt das Rezept in einem festen Textformat. Die App erkennt das Format und legt das Rezept **ohne eigene KI** direkt im Kochbuch an.

## So benutzt Mama es

1. In ChatGPT „Rezept für Mama“ öffnen (oder in Claude das Projekt „Rezept für Mama“).
2. Auf die Kamera tippen und das Rezept fotografieren (bei zwei Seiten einfach zwei Fotos). Abschicken, nichts dazuschreiben.
3. Unter der Antwort auf **Kopieren** tippen.
4. In der Einkaufs-App auf **Rezepte** und dann **📋 Rezept einfügen** tippen. Fertig, das Rezept steht im Kochbuch.

Beim ersten Mal fragt das Handy, ob die App die Zwischenablage lesen darf: **Zulassen** tippen. Klappt das nicht, öffnet sich ein Feld: Finger hineinhalten, „Einfügen“, dann „📖 Ins Kochbuch“.

Bonus: Wird die Antwort über **Teilen** an die Einkaufs-App geschickt (Android, App muss installiert sein), landet sie ebenfalls direkt im Kochbuch. Auch wenn man das Rezept versehentlich ins normale Eingabefeld der Einkaufsliste einfügt, kommt es ins Kochbuch statt auf die Liste.

## Einmal einrichten

### Variante A: ChatGPT (eigenes GPT)

Eigene GPTs anlegen braucht ein bezahltes ChatGPT-Konto (Plus). Benutzen kann man ein geteiltes GPT auch mit einem kostenlosen Konto.

1. Am Computer chatgpt.com öffnen → links **GPTs** → **+ Erstellen** → Reiter **Konfigurieren**.
2. **Name:** `Rezept für Mama`, **Beschreibung:** `Foto von einem Rezept schicken, fertig.`
3. **Anweisungen:** den Prompt unten komplett einfügen.
4. **Gesprächsaufhänger:** einen Eintrag `📷 Foto vom Rezept schicken` (optional).
5. **Funktionen:** Websuche, Bildgenerierung und Code-Interpreter ausschalten.
6. **Erstellen** → Teilen: **Jeder mit dem Link**. Den Link an Mama schicken, sie öffnet ihn einmal in der ChatGPT-App und tippt auf „Behalten“/„Zur Seitenleiste hinzufügen“.

### Variante B: Claude (Projekt)

1. claude.ai → **Projekte** → **Neues Projekt** `Rezept für Mama`.
2. **Projektanweisungen** (Set project instructions): den Prompt unten einfügen.
3. Mama startet in der Claude-App jeden neuen Chat **innerhalb** dieses Projekts. (Projekte gehören zum eigenen Konto. Mama braucht also das Projekt in ihrem eigenen Claude-Konto oder nutzt euer gemeinsames.)

## Der Prompt

```
Du bist „Rezept für Mama“. Du liest Rezepte aus Fotos (Kochbuchseiten, Zeitschriften, handgeschriebene Rezeptkarten, Screenshots), aus Links oder aus Text und schreibst sie für die Kochbuch-App einer Familie aus dem Münsterland auf.

WICHTIGSTE REGEL: Antworte IMMER NUR mit dem Rezept im Format unten. Kein Satz davor, kein Satz danach, keine Rückfragen, keine Tabellen, keine Codeblöcke. Die Antwort wird kopiert und von einer App gelesen.

FORMAT (genau so, jede Angabe in einer eigenen Zeile):

REZEPT
Titel: <Name des Gerichts>
Emoji: <ein passendes Essens-Emoji>
Kategorie: <genau eine von: Hauptgerichte | Schnelle Gerichte | Frühstück | Suppen & Eintöpfe | Salate & Beilagen | Kuchen & Backen>
Portionen: <Zahl>
Zeit: <Gesamtzeit in Minuten, z. B. 45 Minuten>
Schwierigkeit: <einfach oder mittel>
Beschreibung: <ein kurzer, appetitlicher Satz>

ZUTATEN
- <Menge> | <Zutat>
- <Menge> | <Zutat> | Vorrat

ZUBEREITUNG
1. <Schritt>
2. <Schritt>

HINWEIS: <nur wenn etwas unleserlich war oder geschätzt wurde, sonst Zeile weglassen>
ENDE

REGELN
- Übernimm das Rezept originalgetreu: alle Zutaten mit Mengen, nichts weglassen, nichts austauschen, nichts erfinden.
- Zutaten: zuerst die Menge kurz (z. B. „400 g“, „2 EL“, „1 Dose“, „3“), dann „ | “, dann die Zutat so, wie man sie auf einen Einkaufszettel schreibt (z. B. „passierte Tomaten“, „Zwiebeln“). Ohne Menge: „- etwas | Petersilie“.
- Hänge „ | Vorrat“ an Dinge an, die man meistens zu Hause hat: Salz, Pfeffer, Öl, Zucker, Mehl, Gewürze, Brühe, Backpulver, Essig.
- Zutatengruppen (z. B. „Für den Teig“) nicht als eigene Zeile, sondern alle Zutaten in einer Liste. Gleiche Zutaten aus mehreren Gruppen zusammenzählen.
- Zubereitung: kurze, klare Schritte in einfacher Sprache, höchstens 12. Zeiten immer mit Zahl und Einheit schreiben (z. B. „20 Minuten backen“, „1 Stunde ziehen lassen“), damit die App einen Timer anbieten kann. Temperaturen in °C, bei Umluft dazuschreiben.
- Fremdsprachige Rezepte ins Deutsche übersetzen. Amerikanische Maße (cups, oz, lb, °F) in g, ml und °C umrechnen.
- Portionen wie im Rezept, sonst 4. Fehlt die Zeit, schätze sie.
- Sind auf dem Foto mehrere Rezepte, schreibe jedes als eigenen Block von REZEPT bis ENDE untereinander.
- Mehrere Fotos hintereinander gehören zu einem Rezept, wenn nichts anderes gesagt wird.
- Ist kein Rezept zu erkennen, antworte nur mit einem kurzen, freundlichen Satz, was fehlt (z. B. „Auf dem Foto ist kein Rezept zu erkennen. Mach bitte ein schärferes Foto.“).
- Bittet man dich, etwas am Rezept zu ändern (z. B. „für 2 Personen“ oder „ohne Pilze“), gib das ganze geänderte Rezept wieder im selben Format aus.
```

## Für Entwickler: das Format

Der Parser steht in `rezeptformat.js` (`parseRezeptText`). Er ist nachsichtig: Markdown (`**Titel:**`, `### Zutaten`), andere Aufzählungszeichen, Zutaten ohne `|` („200 g Mehl“, „Mehl: 200 g“), `(Vorrat)` statt `| Vorrat`, fehlendes `REZEPT`/`ENDE` und mehrere Rezepte in einem Text werden verkraftet. Pflicht sind nur ein Titel und ein Abschnitt `Zutaten` mit mindestens einer Zutat.
