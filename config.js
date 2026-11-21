/**
 * config.js – ZENTRALE KONFIGURATION
 * ------------------------------------------------------------------
 * 1) Firebase-Config aus der Firebase-Konsole hier einfügen
 *    (Projekteinstellungen → Allgemein → "Meine Apps" → Web-App → Config).
 * 2) Solange hier Platzhalter stehen, läuft die App im DEMO-MODUS:
 *    Alles funktioniert, wird aber nur lokal auf diesem Gerät gespeichert.
 *
 * Hinweis: Diese Werte sind KEIN Geheimnis – sie stehen bei jeder
 * Firebase-Web-App im Browser. Geschützt wird die Datenbank über die
 * Firestore-Regeln (siehe README.md).
 * ------------------------------------------------------------------
 */

export const firebaseConfig = {
  apiKey: 'DEIN_API_KEY',
  authDomain: 'DEIN_PROJEKT.firebaseapp.com',
  projectId: 'DEIN_PROJEKT',
  storageBucket: 'DEIN_PROJEKT.appspot.com',
  messagingSenderId: '000000000000',
  appId: 'DEINE_APP_ID'
};

/**
 * Name der gemeinsamen Liste. Alle Geräte mit derselben ID sehen
 * dieselbe Einkaufsliste. Gern etwas Eindeutiges wählen,
 * z. B. 'familie-mueller-2026'.
 */
export const LIST_ID = 'familie-einkauf';

/**
 * Unsichtbare anonyme Anmeldung bei Firebase (kein Login-Bildschirm!).
 * Empfohlen, damit die Datenbank-Regeln Fremdzugriffe blocken können.
 * In Firebase → Authentication → Anmeldemethode → "Anonym" aktivieren.
 */
export const USE_ANONYMOUS_AUTH = true;

/** Prospekt-Links (öffnen in neuem Tab). */
export const OFFER_LINKS = {
  marktkauf: 'https://www.kaufda.de/Luedinghausen/Marktkauf/p-r60',
  aldi: 'https://www.kaufda.de/Luedinghausen/ALDI-Nord/p-r43'
};

/** Hilfsfunktion: Ist Firebase eingerichtet? */
export function isFirebaseConfigured() {
  const c = firebaseConfig;
  return Boolean(
    c && c.apiKey && c.projectId && c.appId &&
    !/^DEIN/.test(c.apiKey) && !/^DEIN/.test(c.projectId) && !/^DEIN/.test(c.appId)
  );
}
