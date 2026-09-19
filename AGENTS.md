# AGENTS.md — JellySearch

Jellyfin-Plugin, das die Web-Oberfläche um erweiterte Filter für **Filme** und **Serien** ergänzt:

- Jahres-Bereichsregler (Dual-Thumb) statt einzelner Checkboxen
- Tags als Raster in mehreren Reihen + Tag-Suche
- Tags **ausschließen** (Drei-Zustand: enthalten → ausschließen → aus)
- erreichbar über ein zusätzliches Icon neben dem nativen Filter-Button

## Zielumgebung

- Jellyfin **12.1.0**, `net10.0` (NuGet `Jellyfin.Controller` / `Jellyfin.Model` = 12.1.0)
- Server läuft als Docker-Container `jellyfin` (lscr.io/linuxserver/jellyfin) auf Host `192.168.150.51`
- Plugin-Verzeichnis (Docker-Volume `jellyfin_config`):
  `/var/lib/docker/volumes/jellyfin_config/_data/data/plugins/JellySearch/`
  (Besitzer `1000:100` = `neo:users`)

## Projektstruktur

```
Jellyfin.Plugin.JellySearch/
  Plugin.cs                        BasePlugin, Name/Id/Version, Config-Page
  PluginServiceRegistrator.cs      registriert den IStartupFilter
  WebInjectionStartupFilter.cs     hängt die Middleware vorne in die Pipeline
  IndexHtmlInjectionMiddleware.cs  schreibt index.html in-memory um (kein Disk-Patch)
  JellySearchController.cs         liefert /JellySearch/filters.js + filters.css
  Configuration/
    PluginConfiguration.cs         EnableInjection, DefaultRangeYears
    configPage.html                Dashboard-Konfigseite (embedded)
  Web/
    filters.js                     gesamte Frontend-Logik (vanilla JS, IIFE)
    filters.css                    Styles (immer dunkel)
build.yaml                         Metadaten fürs Plugin-Packaging
Directory.Build.props              Version 1.0.0.0
```

## Wie es funktioniert

1. **Injektion**: Jellyfin Core hat keine offizielle API für Web-UI-Erweiterungen.
   Ein `IStartupFilter` hängt `IndexHtmlInjectionMiddleware` vor die Pipeline.
   Die Middleware puffert nur die Index-Anfrage (`/`, `/index.html`, `/web`),
   entfernt `Accept-Encoding`/`If-None-Match`/`If-Modified-Since` und fügt vor
   `</body>` ein `<link>` + `<script src="../JellySearch/filters.js?v=<ticks>">` ein.
   `?v=` kommt aus der LastWriteTime der Assembly → Cache-Busting nach jedem Build.
   Die Antwort bekommt `no-store`.

2. **Assets**: `JellySearchController` liefert die als EmbeddedResource
   eingebetteten `Web/filters.js` / `Web/filters.css` unter `/JellySearch/...`.

3. **Frontend**:
   - Findet den nativen Filter-Button über `svg[data-testid="FilterAltIcon"]`
     (MUI 6 setzt `data-testid` immer) und fügt daneben den eigenen Button ein.
   - Liest verfügbare Jahre/Tags über `ApiClient.getJSON(getUrl('Items/Filters', …))`
     (Fallback `Items/Filters2`). Liefert u. a. `Years` und `Tags`.
   - Jahre + enthaltene Tags werden in die **nativen** Library-View-Settings
     geschrieben (localStorage-Key `"<viewType> - <topParentId>"`, z. B.
     `movies - 7a21…`). `useLocalStorage` (usehooks-ts) synchronisiert über ein
     `local-storage`-`StorageEvent` → die native Ansicht lädt live neu.
   - `JellySearchNonce` im Settings-Objekt erzwingt einen Refetch, wenn sich nur
     Ausschlüsse ändern (Query-Key der React-Query ändert sich dadurch).
   - **Tag-Ausschluss** ist clientseitig: Ein Hook auf `XMLHttpRequest.prototype`
     ergänzt bei `/Items`-Requests `fields=Tags` und filtert die Antwort
     (Items mit ausgeschlossenem Tag entfernen, `TotalRecordCount` anpassen).
     Ausschlüsse liegen unter `jellysearch-exclude-v1` (`{ "<parentId>": [tags] }`).

## Wichtige technische Fallstricke

- **Hash-Routing**: jellyfin-web nutzt `createHashRouter`. Route **und** Query
  stehen in `location.hash` (`#/movies?topParentId=…`), nicht in `location.search`.
  Immer `getHashLocation()` verwenden.
- **Settings-Key**: exakt `"<viewType> - <topParentId>"` (mit Leerzeichen um den Bindestrich).
- **Filter-Endpunkt**: `/Items/Filters` (Jahre + Tags). `/Filter/QueryFiltersLegacy`
  existiert in v12 nicht mehr (404).
- **Tag-Menge**: Bei großen Bibliotheken gibt es tausende Tags → Raster auf
  `TAG_RENDER_LIMIT` (300) begrenzt, mit Suchfeld und Info-Zeile.
- **Aktive Tags oben**: enthaltene/ausgeschlossene Tags werden immer zuerst
  gerendert (auch wenn sie nicht zur Suche passen), mit Trennlinie.
- **Nur Tab 0**: Der Button erscheint nur in der Hauptansicht von `/movies` und
  `/tv` (`tab` fehlt oder 0).
- **Encoding**: JS/CSS werden als UTF-8 ausgeliefert → Umlaute direkt im Code ok.
- **Dark-Only**: Das Panel ist bewusst immer dunkel (kein Light-Theme-Fallback).

## Build & Deploy

```bash
export PATH="$HOME/.dotnet:$PATH"   # .NET 10 SDK liegt in ~/.dotnet

dotnet publish Jellyfin.Plugin.JellySearch/Jellyfin.Plugin.JellySearch.csproj \
  -c Release -o /tmp/opencode/publish
```

Deploy auf den Server (SSH-Alias `omv`, Docker-Container `jellyfin`):

```bash
scp /tmp/opencode/publish/Jellyfin.Plugin.JellySearch.dll omv:/tmp/jellysearch/
ssh omv 'P=/var/lib/docker/volumes/jellyfin_config/_data/data/plugins/JellySearch; \
  cp /tmp/jellysearch/Jellyfin.Plugin.JellySearch.dll "$P/"; \
  chown -R 1000:100 "$P"; docker restart jellyfin'
```

Nach dem Neustart (~20 s) prüfen:

```bash
curl -s -H 'Accept: text/html' http://192.168.150.51:8096/web/ | grep -o 'filters.js?v=[0-9]*'
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.150.51:8096/JellySearch/filters.js
ssh omv 'docker logs jellyfin --since 2m 2>&1 | grep "Loaded plugin: JellySearch"'
```

> Hinweis: `meta.json` liegt bereits im Plugin-Ordner und muss beim Update normalerweise
> nicht erneut kopiert werden (nur die DLL).

## Tests

- **Server-seitig**: curl (Injektion, Asset-Status, Plugin-Log).
- **Frontend-Logik**: über Playwright im echten UI. Da die App Hash-Routing nutzt,
  reicht eine Hash-Änderung **nicht** für einen Reload — für einen frischen
  Dokument-Load eine Query an die HTML hängen, z. B.
  `http://192.168.150.51:8096/web/?cb=123#/movies?topParentId=<id>&collectionType=Movies`.
- Library-IDs lassen sich im Browser über
  `ApiClient.getJSON(ApiClient.getUrl('UserViews', { userId: ApiClient.getCurrentUserId() }))`
  ermitteln.

## Konventionen

- Frontend: vanilla JS (ES5-kompatibel), IIFE, keine Build-Toolchain, keine externen Libs.
- Keine Kommentare in C#-Standard-XML-Doku hinaus; im JS nur wo nötig.
- Neue UI-Texte auf Deutsch **mit** Umlauten.
- CSS-Klassen immer mit Präfix `jellysearch-`.
