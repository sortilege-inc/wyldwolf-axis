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
swap what it shows. Any panel not on screen opens in a drawer from the sidebar. Below
900px it falls back to one panel at a time.

| Panel | What it is |
|---|---|
| **Adventure Tracker** | Progress, GM-state export/import, and the phase-grouped scene picker (Arrival / Investigation / The Ritual / Epilogue, 11 scenes). |
| **Scene / Encounter** | The current scene: read-aloud text, checks, clues, opponents, objectives, resolutions, a done checkbox and GM notes. **Run Encounter** turns it into the combat panel: initiative, rounds and turns, per-instance HP, conditions with durations, an active-effects sidebar, attack rolls and spell text from stat blocks, and a creature search over all 335 adversaries to add more. |
| **Inspector** | Whatever was last selected — a combatant, an opponent, a location, a party member, or any catalog entry — with live HP/conditions for combatants. |
| **Party** | Characters imported from D&D Beyond share links (one-time snapshot, explicit re-sync) and their sheets as played: HP and temp HP, death saves, inspiration, conditions, spell slots and class resources as clickable pips, item charges and quantities, short/long rest, roll buttons for checks, saves, skills, attacks, spells (consuming a slot), and companions/familiars/wild shapes that can be summoned into the running encounter as their own combatants. Party-file export/import. |
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

## D&D Beyond import

The character API has no CORS headers, so the page can't fetch it directly. `worker/` is
a small Cloudflare Worker that proxies the fetch with CORS scoped to this app's origin;
deploy it per `worker/README.md` and put its URL in `assets/js/ddb-import.js`.

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
index.html                the page
assets/css/axis.css       one stylesheet
assets/maps/              served map images (WebP); originals stay out of the repo
assets/js/
  bus.js                  in-window + cross-window events (BroadcastChannel)
  state.js                one localStorage key: progress, party, overrides, combat, layout
  render.js               DOM helpers, stat-block renderer, entity resolution
  panels.js               panel registry, selection model, Inspector
  layout.js               tile tree: validation, presets, rendering, gutters, editor
  app.js                  shell: tiles vs single-panel mode, sidebar
  tracker.js              Adventure Tracker and Scene panels
  playmode.js             Run Encounter
  sheet.js                the character sheet as played (pips, rolls, rests, companions)
  party.js  ddb-import.js Party panel and the D&D Beyond mapper
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

## Credit

*The Exorcism of Mikko* and *The Axis Saga: War of Silence* are published by Badwolf
Studios / Wyldwolf Games. This is an unofficial GM aid built from the DSL conversion of
the freely available preview material.
