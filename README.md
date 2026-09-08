# Wyldwolf Axis — GM Table Tool

A single-page, buildless web tool for one GM running **The Exorcism of Mikko**, a
D&D-5e-compatible adventure set in **The Axis Saga: War of Silence** (Wyldwolf Games /
Badwolf Studios). Unlike a convention multi-table tool, this assumes one ongoing
campaign — progress is just saved in this browser, no table password, no export/import.

## Running it

Static files, no build step to view it (only to regenerate `data/data.js`):

```bash
python3 -m http.server 8934
```

then open `http://localhost:8934/index.html`.

## Tabs

| Tab | What it is |
|---|---|
| **Dashboard** | Adventure progress, quick-nav tiles, themes. |
| **Adventure Tracker** | Mikko's four phases (Arrival / Investigation / The Ritual / Epilogue) and 11 scenes, each with its read-aloud text, description, skill checks, clues, conflict/opponents, objectives and resolutions — a checkbox and a notes field per scene, saved to this browser. |
| **NPCs** | The named cast (Captain Ord, Wynota, the Taylors, Bruce/the Howling Silence) — profile box(es) plus a full stat block where the book prints one. |
| **Adversaries** | Every SRD monster plus the setting's and adventure's own (335 total) as full 5e-style stat blocks, filterable by SRD base / Axis setting / Mikko-original. |
| **Spells / Items / Subclasses / Artifacts / Rules Glossary** | The rest of the merged corpus — Axis setting content extends the SRD base, Mikko content extends that. |
| **Lore** | The adventure's own narrative and the Axis setting preview, verbatim, by heading. |

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
| `build/parse_dsl.py` | Generic tokenizer + recursive-descent tree parser for the DSL's `.actor`/`.arc` grammar (tokenizer rules — string/hash-id/comment handling — follow the canonical `ttrpg_validator.py`). Knows nothing about scenes or NPCs; it just turns any well-formed block into a generic `{form, keyword, name, hash, body/items/value}` tree. |
| `build/extract_supplement.py` | Walks that generic tree to pull the specific shapes out of the Mikko `.actor` (NPC profile boxes + stat blocks + features), `.arc` (locations, FLOW/phases, scenes with checks/clues/objectives/conflict/resolutions, cast), and `.lore` (heading-delimited narrative sections) files — the file kinds the Go synthesist does **not** merge (it only merges `.ttrpg`). |
| `build/build_data.py` | Runs the Go synthesist (`titterpig-synthesist`) to merge all `.ttrpg` across the three layers into one resolved JSON (1,475 flattened DEFs), buckets every one of them by its `EXTENDS` parent into rules/spells/items/adversaries/subclasses/artifacts, and combines that with the supplement JSON into `data/data.js` (`window.AXIS`). |
| `build/verify_data.py` | Content/coverage gate: every resolved DEF must land in exactly one bucket (none dropped, none duplicated), and NPC/scene/location/lore-section counts must match the supplement exactly. |
| `build/build.sh` | Runs synthesist merge → supplement extraction → build → gate → `node --check` on every JS file, in order. Fails loudly (non-zero exit) if anything above disagrees. |

Gate status, from `bash build/build.sh` on 2026-09-08:

```
resolved.json: 1475 def entities, 1 non-def (['actor'])
data.js buckets: rules=331, spells=340, items=453, adversaries=335, subclasses=14, artifacts=2, total=1475
supplement: npcs=15 scenes=11 locations=11 lore_sections=28
verify_data.py: 0 discrepancies
node --check: 9 files parse
build.sh: all gates passed.
```

## Layout

```
index.html              the whole page
assets/css/axis.css      one stylesheet
assets/js/
  state.js               localStorage state (scene ticks + notes), one key
  render.js               DOM helpers + generic stat-block renderer
  catalog.js              generic list/search/detail for rules/spells/items/adversaries/subclasses/artifacts
  npcs.js                 named-cast view (groups profile+statblock rows back into one card per person)
  tracker.js              the adventure tracker — generic over data.adventures[<id>]
  lore.js                 narrative viewer
  dashboard.js            landing page
  app.js                  tabs/router/boot
data/data.js             GENERATED — window.AXIS
build/                   the generator and its gates
```

No framework, no npm. Python 3 + the Go synthesist for the generator; Node is used only
for the advisory syntax check.

## A second adventure module

The app shell (nav, layout, stat-block renderer, rules glossary) is generic — none of
`render.js`, `catalog.js`, or `app.js`'s router mention "Mikko". A second adventure adds:
- a second manifest/merge (or a shared one, if it extends the same base+setting),
- a second `data.adventures.<id>` key in `build_data.py`'s output,
- one more nav row in `app.js` pointing `tracker.render` at that key.

`npcs.js` and `tracker.js` are the only pieces that know Mikko-shaped data at all, and
only because they're passed a specific adventure's data — the functions themselves take
the adventure/NPC list as a parameter.

## Judgment calls (flagged for review)

- **Bucketing rule**: every synthesist DEF is bucketed by its `EXTENDS` parent
  (`Spell`→spells, `Monster`→adversaries, `Magic Item`/`Adventuring Gear`/`Weapon`/`Armor`→items,
  `Subclass`→subclasses, everything else→the Rules Glossary catch-all so nothing is
  silently dropped). A `Magic Item` sourced from a file named `*-artifacts.ttrpg` is
  bucketed as **artifacts** instead of items — that split is a naming-convention
  inference, not something the DSL tags explicitly.
- **NPC grouping**: Wynota, Adam Taylor and Nikki Taylor each have a "before possession"
  profile DEF, a Monster-statblock DEF, and (Wynota only) a second "after" profile DEF
  nested under the statblock's own `PROFILES` block. The NPC view groups these back into
  one card per person using the source's own `linked_to`/nesting relationship — Captain
  Ord and Maya/Bruce/the Howling Silence have no such split.
- **Scene ordering in the tracker**: the source's own `FLOW` block orders phases and,
  within the Investigation phase, leaves its six scenes unordered (the adventure's design
  note says the party visits them in any order) — the tracker preserves that, it does not
  impose an order the source doesn't have.

## Credit

*The Exorcism of Mikko* and *The Axis Saga: War of Silence* are published by Badwolf
Studios / Wyldwolf Games. This is an unofficial GM aid built from the DSL conversion of
the freely available preview material.
