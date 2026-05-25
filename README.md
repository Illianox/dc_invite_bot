# Blacklist Invite-System

Discord-Referral-Bot fuer persoenliche Einladungslinks. Das bestehende externe
Plugin bleibt fuer die Rolle `Linked` verantwortlich; dieser Bot liest nur den
aktuellen Discord-Rollenstatus.

## Funktionen

- Privater persoenlicher Invite-Link fuer `Linked`-Mitglieder.
- Private Liste der eigenen aktiven Referrals.
- Oeffentliches Monatsranking, das nur Admins veroeffentlichen oder
  aktualisieren koennen.
- Individuelle Willkommensnachricht fuer eindeutig zugeordnete Einladungen.
- Konservative Invite-Erkennung: unklare Beitritte werden nicht gezaehlt.
- Audit-Historie, Admin-Supportcommands und ausfallsicherer Logversand.

## Voraussetzungen

- Node.js 20 oder neuer sowie npm.
- Fuer den Live-Betrieb MySQL oder MariaDB; fuer erste Discord-Tests kann der
  mitgelieferte Memory-Mock ohne Datenbank genutzt werden.
- Ein Discord-Bot mit aktiviertem privilegierten `Guild Members Intent`.
- IDs fuer den Server, Invite-, Panel-, Ranking-, Welcome- und privaten
  Log-Channel sowie fuer die bereits vom externen Plugin verwaltete Rolle
  `Linked`.

## Discord-Rechte

Pflichtrechte:

- `View Channel`, `Send Messages` und `Embed Links` in den Ausgabechannels.
- `Create Instant Invite` im Invite-Channel.
- `Manage Server` (`Manage Guild`) fuer den Abruf der Invite-Nutzungsstaende.

Der Bot braucht **kein** `Manage Roles`. `Manage Channels` ist in Version
`0.1.0` nicht erforderlich.

## Schnelltest Ohne Datenbank

Erstelle `.env` und lasse `DATA_MODE=memory` gesetzt:

```powershell
Copy-Item .env.example .env
notepad .env
npm run deploy:commands
npm run build
npm start
```

Im Memory-Modus musst du keine `MYSQL_*`-Werte eintragen und `npm run migrate`
nicht ausfuehren. Der Bot arbeitet weiter mit echten Discord-Channels,
echten Invite-Links und der echten Discord-Rolle `Linked`; nur seine
gespeicherten Invite-/Referral-/Ranking-/Logdaten sind Mock-Daten im
Arbeitsspeicher. Nach jedem Neustart gehen sie verloren.

Zum Testen gibst du Testmitgliedern die Rolle `Linked` manuell, falls dein
externes Verknuepfungs-Plugin im Testserver nicht aktiv ist.

## Installation Mit MySQL/MariaDB

```powershell
Copy-Item .env.example .env
npm install
npm run migrate
npm run deploy:commands
npm run build
npm start
```

Setze fuer den Echtbetrieb `DATA_MODE=mysql` und trage vor `migrate`,
`deploy:commands` und `start` alle Datenbankwerte in `.env` ein.
Die Migration erstellt ausschliesslich Bot-eigene Tabellen.
Falls CrossChat-Spielerverknuepfungen in einer separaten Datenbank liegen,
setze z. B. `CROSSCHAT_DATABASE=blacklist` und
`CROSSCHAT_TABLE=crosschat_players`. Der Bot fragt dann
`blacklist.crosschat_players` ab.
Falls die Spielzeit-Tabelle ebenfalls dort liegt, setze
`PLAYTIME_DATABASE=blacklist` und `PLAYTIME_TABLE=lethalquestsascended_stats`.
Der Produktionsbuild startet aus `dist/src/index.js`, da die Testquellen im
gleichen TypeScript-Projekt mitgeprueft werden.

## Commands

| Command | Sichtbarkeit | Funktion |
| --- | --- | --- |
| `/panel publish` | Admin, Antwort privat | Erstellt/aktualisiert das Mitgliederpanel. |
| `/rangliste rangliste:Monatlich/Gesamt` | Admin, Ergebnis oeffentlich | Erstellt oder aktualisiert das oeffentliche Ranking. |
| `/referral inspect` | Admin, privat | Prueft gespeicherte Referral-Historie. |
| `/referral assign` | Admin, privat | Ordnet einen ungeklaerten Fall nachvollziehbar zu. |
| `/referral revoke` | Admin, privat | Widerruft eine falsche aktive Zuordnung. |
| `/system status` | Admin, privat | Zeigt Version, Speicherart, Migration, Speicher- und Syncstatus. |

## Ranking-Konfiguration

Das oeffentliche Ranking kann als Monatsranking oder Gesamtwertung angezeigt
werden. Beim Monatsranking zaehlen nur qualifizierte Referrals des aktuellen
Kalendermonats, also vom ersten Tag des Monats bis vor den ersten Tag des
naechsten Monats. Die Gesamtwertung zaehlt alle qualifizierten Referrals.
Beide Ranglisten haben eigene oeffentliche Nachrichten und ueberschreiben sich
nicht gegenseitig.

Mit `RANKING_DISPLAY_LIMIT` in `.env` stellst du ein, wie viele Plaetze
angezeigt werden, zum Beispiel `3`, `10` oder `25`.

## Willkommensnachrichten

Wenn ein neues Mitglied eindeutig ueber einen verwalteten Invite-Link beitritt,
postet der Bot eine Willkommensnachricht in `WELCOME_CHANNEL_ID` und nennt den
einladenden Member mit einem Dankeschoen. Mit `WELCOME_MESSAGE_ENABLED=false`
kannst du diese Nachrichten abschalten.

## Betrieb Unter Windows

Fuer den Dauerbetrieb kann `npm start` nach erfolgreichem Build als geplante
Aufgabe beim Systemstart ausgefuehrt werden. Der Bot benoetigt dauerhaft
Netzwerkzugang zu Discord und zur Datenbank.

Bei einem Neustart erstellt der Bot eine neue sichere Invite-Baseline. Nicht
eindeutig rekonstruierbare Beitritte erhalten keine automatischen Punkte und
koennen von Admins spaeter ueber die Supportcommands geprueft werden.
