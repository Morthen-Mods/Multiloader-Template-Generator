# Vorschlag: neue Aufteilung der Einstellungen

> Umgesetzt. Dieses Dokument hält fest, warum die Aufteilung so aussieht, wie sie aussieht.

Stand heute: 40 Bedienelemente plus zwei Dateiauswahlen in sechs Kacheln, verteilt auf drei Spalten.
Der Vorschlag bleibt bei sechs Kacheln, schneidet sie aber anders zu. Das Kachel-Design selbst ändert
sich nicht, nur die Zuordnung.

## Was heute stört

**Jeder Loader steht in drei verschiedenen Kacheln.** Am Beispiel Fabric:

| Was | Wo heute |
| --- | --- |
| Auswahl „Fabric“ | Kachel *Loaders & features*, Spalte 3 |
| Fabric Loader, Fabric API | Kachel *Minecraft & loader versions*, Spalte 2 |
| Mod Menu und dessen Version | Kachel *Loaders & features*, Spalte 3 (inzwischen ohne Schalter, siehe unten) |
| Fabric Loom | Kachel *Build tooling*, Spalte 3 |

Für Forge und NeoForge gilt dasselbe Muster. Wer Fabric abwählt, muss an drei Stellen schauen, was
dadurch verschwunden ist.

**Die Veröffentlichung ist zweigeteilt.** Schalter und Projekt-IDs stehen in Spalte 1, die Version des
zuständigen Gradle-Plugins in Spalte 3.

**Die Kachel *Loaders & features* vermischt zwei Entscheidungen.** Für welche Loader gebaut wird und was
im Projekt landet, hat nichts miteinander zu tun.

**Die Lesereihenfolge widerspricht der Entscheidungsreihenfolge.** Man liest links beginnend die Identität,
obwohl Minecraft-Version und Loader alles Weitere bestimmen und in den Spalten 2 und 3 stehen.

**Die Kacheln sind ungleich schwer.** 10, 5, 6, 0, 10 und 9 Bedienelemente.

## Das Prinzip

Gruppieren nach dem Gegenstand der Entscheidung, nicht nach der Art des Bedienelements.
Alles, was zu einem Loader gehört, steht beim Loader. Alles, was zur Veröffentlichung gehört, steht bei
der Veröffentlichung. Was man selten anfasst, steht am Ende und nicht dazwischen.

## Der Vorschlag

### Spalte 1 — Der Mod

**Kachel „Mod“** — unverändert wie heute, ergänzt um die beiden Bilder
```
Mod name          Mod ID
Author            Version
Description
License           Maven group
Base package
Class prefix      Project name
Icon              Banner
```
Die einzige Änderung an dieser Kachel ist die letzte Zeile. Icon und Banner gehören zur Außenwirkung des
Mods wie Name und Beschreibung und brauchen dafür keine eigene Kachel.

### Spalte 2 — Zielplattform

**Kachel „Minecraft“**
```
Minecraft version     NeoForm
[ ] Include snapshots
```
Die Java-Version steht hier nicht mehr, sie ergibt sich aus der Minecraft-Version.

**Kachel „Loader“** — Auswahl und die zugehörigen Versionen in einer Kachel
```
[ Fabric ]   [ Forge ]   [ NeoForge ]

Fabric        Loader          API
Forge         Forge version
NeoForge      NeoForge version
```
Mod Menu hat weder Schalter noch Versionsauswahl: Es kommt mit Fabric mit, sobald es für die gewählte
Minecraft-Version einen Build gibt, und dann immer in der neuesten verfügbaren Version.

Jeder Block erscheint nur, wenn der Loader ausgewählt ist. Ist kein Build verfügbar, steht der Hinweis
direkt beim Block statt wie heute in einer anderen Spalte.

**Kachel „Projektinhalt“** — jeder Schalter erklärt sich selbst, statt den Text nur im Tooltip zu führen
```
[ ] Common Datagen      [ ] Mixins
[ ] Test Mod            [ ] Gametests
[ ] Common runs
```

### Spalte 3 — Ausgabe

**Kachel „Veröffentlichung“** — vollständig
```
[ ] Mod publishing
Modrinth project ID     CurseForge project ID
Source repository URL
Issue tracker URL
```
Die beiden URLs bekommen je eine eigene Zeile, damit lange Links lesbar bleiben. Das zuständige
Gradle-Plugin hat keine Auswahl mehr: Es kommt wie Mod Menu immer in seiner neuesten Version.

**Kachel „Build-Werkzeuge“**
```
Gradle              Gradle JVM args
[ ] Gradle daemon
Multiloader plugin  ModDevGradle
Fabric Loom         ForgeGradle
Foojay resolver
```

## Was sich dadurch ändert

- Fabric steht an einer Stelle statt an dreien, Forge und NeoForge ebenso.
- Die Veröffentlichung ist vollständig in einer Kachel.
- Die Kachel *Mod* bleibt, wie sie ist, und nimmt die Bilder mit auf. Deren eigene Kachel entfällt.
- Der Projektinhalt steht in Spalte 2 direkt unter den Loadern, weil er beschreibt, was diese bekommen.
  Damit tragen alle drei Spalten ähnlich viel, und die Werkzeug-Kachel bleibt dauerhaft offen.
- Ab etwa 1680x1050 passt alles ohne Scrollen. Auf kleineren Bildschirmen scrollt die betroffene Spalte
  für sich. Abstände und Schriftgrößen bleiben dabei bewusst unverändert: Verdichtete Elemente sehen
  schlechter aus als eine Bildlaufleiste.

## Offene Entscheidungen

**Gehören Fabric Loom und ForgeGradle zum Loader oder zu den Werkzeugen?**
Der Vorschlag lässt sie bei den Werkzeugen, weil sie zusammen mit den übrigen Plugin-Versionen entweder
ignoriert oder gemeinsam angepasst werden. Die Alternative wäre, sie in den jeweiligen Loader-Block zu
ziehen, was die Kopplung noch deutlicher macht, die Loader-Kachel aber mit Fortgeschrittenem belastet.

**Soll die Minecraft-Auswahl die volle Kachelbreite bekommen?**
Sie ist die folgenreichste Einstellung der Seite. Über die ganze Breite wirkt sie wie eine Überschrift
für alles Weitere, verbraucht aber mehr Platz als der kurze Versionstext benötigt.
