# Wyldwolf Axis — GM Table Tool

A buildless web tool for one GM running **The Exorcism of Mikko**, a D&D-5e-compatible
adventure set in **The Axis Saga: War of Silence** (Wyldwolf Games / Badwolf Studios).
One ongoing campaign, saved in this browser; the party and the GM's state each export to
their own file so a campaign can move machines or be backed up.

Live: https://sortilege-inc.github.io/wyldwolf-axis/

## Running it

Static files, no build step to view it (only to regenerate `data/data.js`):

```bash
python3 -m http.server 8934
```

then open `http://localhost:8934/`.

## The page

At 900px and wider the main area is a **tile layout**: rows or columns of panels, nested
one level, at most three per group, resizable by dragging the gutters. The default is
three columns — Adventure Tracker · Scene / Encounter · (Inspector over Rules Glossary).
The sidebar switches presets and opens a tree editor; each tile's header has a picker to
swap what it shows. The ☰ button collapses the sidebar (remembered per browser). Any panel not on screen opens in a drawer from the sidebar. Below
900px it falls back to one panel at a time.

| Panel | What it is |
|---|---|
| **Adventure Tracker** | Progress, GM-state export/import, and the scene list by phase (Arrival / Investigation / The Ritual / Epilogue, 11 scenes) — tick scenes done, drag rows to reorder, drop a row onto another (or use ⇥ / ⇤) to nest it as a sub-scene up to three deep; the order is shared so the table and players page the same way; "Restore source order" puts the book's back. |
| **Scene / Encounter** | The current scene: read-aloud text, checks, clues, opponents, objectives, resolutions, a done checkbox and GM notes. **Run Encounter** turns it into the combat panel: initiative, rounds and turns, per-instance HP, conditions with durations, an active-effects sidebar, attack rolls and spell text from stat blocks, and a creature search over all 335 adversaries to add more. |
| **Inspector** | Whatever was last selected — a combatant, an opponent, a location, a party member, or any catalog entry — with live HP/conditions for combatants. |
| **Party** | Characters imported from D&D Beyond — by share link through the Worker, or from the sheet PDF D&D Beyond exports (**Import PDF**; parsed in the browser, nothing uploaded) — or built in the **Create character** wizard from the corpus (SRD species, backgrounds, classes and feats plus the Axis subclasses and items; point buy / standard array / manual scores; any level to 20, with class and subclass features, ASIs or feats, prepared spells and slots from the progression tables; "Edit build / level up" reopens it) — and their sheets as played: HP and temp HP, death saves, inspiration, conditions, spell slots and class resources as clickable pips, item charges and quantities, short/long rest, roll buttons for checks, saves, skills, attacks, spells (consuming a slot), and companions/familiars/wild shapes that can be summoned into the running encounter as their own combatants. Party-file export/import. |
| **NPCs** | The named cast — profile box(es) plus a stat block where the book prints one. |
| **Adversaries / Spells / Items / Subclasses / Artifacts / Rules Glossary** | The merged corpus, searchable; Axis content extends the SRD, Mikko extends Axis. |
| **Lore** | The adventure's narrative and the Axis preview, verbatim, by heading. |

Every window of the tool shares one localStorage state and one `BroadcastChannel`, so a
change in one is live in the others.

## The table (VTT)

**Open table (VTT)** in the sidebar opens `vtt.html`: the current scene's map with a
grid, the encounter's combatants as tokens, effects and fog. It follows the GM's scene
unless pinned. Tokens *are* the combat instances — HP rings, bloodied/dead state and
condition pips come from the encounter, and the right-click menu writes damage,
healing, conditions, hidden and size back through the same state, so the encounter
panel updates as you go. Clicking a token selects it in the Inspector, and vice versa.

- **Grid**: show / snap / cell size / offset — the calibration for a map that wasn't
  drawn on a known grid. The infirmary still ships at 64px cells on its 2560px WebP.
- **Set map**: any image URL; put files under `assets/maps/`. Sizes are read from the
  image.
- **Tools**: Ping (rings in every window), Circle, Cone (5e proportions), Line, Square.
  Click an effect to select it, Delete or right-click to remove.
- **Fog**: turn on, drag Reveal rectangles, Reset. Tokens outside a revealed area don't
  exist in the player view.
- **Open player view** opens `vtt.html?view=player`: no controls, fog opaque, hidden and
  fogged tokens not drawn, HP numbers only on party tokens. Put it on the TV.

Map state (image, grid, tokens, effects, fog) lives per scene in GM state and travels
with the GM-state export.

## Sessions — players on their own devices

**Start session** in the sidebar creates a room and shows a code and a join link
(`play.html?s=CODE`). A player opens it on their phone, claims one of the party's
characters, and gets their sheet: they can spend slots and resources, take damage and
heal, apply conditions, roll checks, saves, attacks and spells, rest, summon a companion,
and move their own tokens on the table (`vtt.html?view=player`, opened from the play
page). Everything they do shows up live on the GM's page and table; everything the GM
does to their character shows up live on theirs. They cannot change anything D&D Beyond
decides — race, class, feats, scores, features — and they never receive GM notes, hidden
tokens, or unrevealed fog.

How it works: every shared change is a named op (`assets/js/ops.js`) applied identically
in the browser and in a `SessionRoom` Durable Object that holds the session's document,
validates each op by role, and fans it out over WebSockets. One window per browser holds
the socket; the other windows (the table) ride the same in-browser bus as before. No
session → nothing leaves the browser, exactly as before. No accounts: the join link plus
a claim is the whole identity, like a room code, and the GM can release a claim.

The Worker in `worker/` also proxies the D&D Beyond character API (no CORS headers on
their side). One deploy per `worker/README.md`, then set its URL in `assets/js/config.js`;
served from localhost the app talks to `wrangler dev` automatically.

## Where the content comes from

Three layers, each `EXTENDS` the one before:

1. **D&D 5.5e SRD** — `titterpig-dsl-dnd5.5e/0.4`
2. **Wyldwolf Axis Preview** (setting) — `titterpig-dsl-dnd5e-3rdparty/wyldwolf/5.5/axis-preview`
3. **The Exorcism of Mikko** (adventure) — `titterpig-dsl-dnd5e-3rdparty/wyldwolf/5.5/axis-mikko`

**Nothing here is hand-transcribed.** `data/data.js` is generated; regenerate rather
than patch it.

```bash
bash build/build.sh
```

| Script | What it does |
|---|---|
| `build/parse_dsl.py` | Generic tokenizer + recursive-descent tree parser for the DSL's `.actor`/`.arc` grammar (tokenizer rules follow the canonical `ttrpg_validator.py`). Knows nothing about scenes or NPCs. |
| `build/extract_supplement.py` | Walks that tree to pull NPC profiles/stat blocks/features (`.actor`), locations/FLOW/phases/scenes/cast (`.arc`), and heading-delimited narrative (`.lore`) — the file kinds the Go synthesist does **not** merge. |
| `build/build_data.py` | Runs `titterpig-synthesist` to merge every `.ttrpg` across the three layers into one resolved JSON (1,475 flattened DEFs), buckets each by its `EXTENDS` parent, and combines that with the supplement into `data/data.js` (`window.AXIS`). |
| `build/verify_data.py` | Gate: every resolved DEF lands in exactly one bucket, and NPC/scene/location/lore counts match the supplement exactly. |
| `build/build.sh` | merge → extract → build → gate → `node --check`, failing loudly on any disagreement. |

Gate status, from `bash build/build.sh` on 2026-09-08:

```
resolved.json: 1475 def entities, 1 non-def (['actor'])
data.js buckets: rules=331, spells=340, items=453, adversaries=335, subclasses=14, artifacts=2, total=1475
supplement: npcs=15 scenes=11 locations=11 lore_sections=28
verify_data.py: 0 discrepancies
```

## Files

```
index.html                the GM's page
vtt.html                  the table (GM view; ?view=player for players and the TV)
play.html                 the player's page: join, claim, sheet
assets/css/axis.css       one stylesheet
assets/maps/              served map images (WebP); originals stay out of the repo
assets/js/
  config.js               where the Worker is
  bus.js                  in-window + cross-window events (BroadcastChannel)
  ops.js                  every shared change as a named op; role rules; player view (also bundled into the Worker)
  state.js                one localStorage key; mutators commit ops
  session.js              the session socket, GM or player role
  render.js               DOM helpers, stat-block renderer, entity resolution
  panels.js               panel registry, selection model, Inspector
  layout.js               tile tree: validation, presets, rendering, gutters, editor
  app.js                  shell: tiles vs single-panel mode, sidebar
  tracker.js              Adventure Tracker and Scene panels
  playmode.js             Run Encounter
  sheet.js                the character sheet as played (pips, rolls, rests, companions)
  creator.js              character creator / level-up wizard over the corpus
  party.js  ddb-import.js Party panel and the D&D Beyond API mapper
  ddb-pdf.js              the D&D Beyond sheet-PDF parser (field map via pdf.js)
  catalog.js  npcs.js  lore.js  dashboard.js
data/data.js              GENERATED — window.AXIS
build/                    the generator and its gates
worker/                   Cloudflare Worker proxy for D&D Beyond (deploy separately)
docs/                     plans and decision logs
```

No framework, no npm for the page. Python 3 + the Go synthesist for the generator; Node
only for the syntax check.

## A second adventure module

Nothing in the shell knows the word "Mikko". `panels.js` takes the first key of
`data.adventures` as the active adventure; a second adventure adds a merge, a second
`data.adventures.<id>` in `build_data.py`'s output, and a way to pick which is active.
`npcs.js` and `tracker.js` are handed a specific adventure's data as parameters.

## Judgment calls (flagged for review)

- **Bucketing rule**: every synthesist DEF is bucketed by its `EXTENDS` parent; a
  `Magic Item` from a file named `*-artifacts.ttrpg` goes to **artifacts** — a
  naming-convention inference, not a DSL tag.
- **NPC grouping**: Wynota, Adam and Nikki Taylor each have a profile DEF and a stat-block
  DEF; the NPC view groups them back into one card per person by the source's own
  `linked_to`/nesting.
- **Scene ordering**: the source's `FLOW` leaves the six Investigation scenes unordered by
  design; the tracker preserves that.
- **Encounter state**: once Run Encounter has seeded instances, they are the live record;
  the per-scene HP override is only the pre-encounter default. Ending an encounter
  discards instance HP/conditions/initiative and keeps party HP.
- **D&D Beyond mapping**: AC/HP/proficiency/attack bonuses are best-effort, not parity
  with D&D Beyond's own calculator — situational modifiers and homebrew aren't modelled,
  and weapon proficiency is assumed (D&D Beyond doesn't put it on the item). Spell slots
  come from the standard table by caster level because the API reports class-derived
  slots as 0.
- **Companions**: every entry in D&D Beyond's `creatures[]` (wild shapes, familiar forms,
  beasts, summons) is offered on the sheet; the character's owner decides which to bring
  into an encounter.
- **PDF import**: D&D Beyond's exported sheet has no AcroForm, but every value is a named
  widget annotation (`STR`, `ST Wisdom`, `Wpn1 AtkBonus`, `spellName12`…), so `ddb-pdf.js`
  reads the field map with pdf.js rather than positioned text. Compared with the API it
  lacks spell text (the sheet shows the corpus's), companions, item descriptions and
  subclass names; limited uses come from what the sheet prints ("10 / Long Rest").

## Credit

*The Exorcism of Mikko* and *The Axis Saga: War of Silence* are published by Badwolf
Studios / Wyldwolf Games. This is an unofficial GM aid built from the DSL conversion of
the freely available preview material.
