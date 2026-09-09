# Plan: tile layout, cross-window sync, VTT

Decision log for the third feature block. Owner decisions are marked
**(owner)**; everything else is a method call made while building and is
reported here for audit.

## Scope (settled 2026-09-08)

1. **Tile layout** for the main page. Layout tree `{dir: row|col, children}`;
   leaves are panels from a registry. Constraints: at most 3 children at the
   root, groups nest exactly one level, a group cannot contain a group.
   Default: `row[tracker, scene, col[inspector, glossary]]` **(owner)**.
   Editor: named presets plus a simple tree editor (dropdowns, add/remove),
   no drag-and-drop **(owner)**. Below ~900px the page falls back to the
   single-panel nav that exists today.
2. **Cross-window sync**: `BroadcastChannel` on top of the localStorage state
   that already exists; same browser, same machine. Transport is swappable so
   a server can be added later without touching panels. A **player view**
   window (no GM information, fog/visibility layer) is in scope now
   **(owner)**; cross-device sync is not.
3. **VTT window** (`vtt.html`): SVG with `viewBox` pan/zoom. Layers:
   background image, grid, fog, effects, tokens. Tokens bind to combat
   instances by `instanceId`, so HP/bloodied/dead/conditions come from the
   encounter state — there is no second HP system. Grid is calibrated per map
   in the UI (cell size + offset, live overlay) **(owner)**; default guess is
   96px cells on the 4K infirmary still. Token art defaults to a themed
   initials disc; per-token images later.
4. **Effects**: AoE templates (circle/cone/line/square, sized in cells),
   pings, and right-click on a token to apply conditions/damage from the map,
   syncing back to the encounter panel **(owner)**.

Order: layout → bus → VTT → effects. One commit each; each verified in the
browser by the main session, not by a delegated agent's report.

## Sessions (settled 2026-09-09)

Players get a room-code URL, claim a character, and play from their own
device. Needs one stateful backend: a Durable Object in the existing Worker.

**Players may edit (owner):** HP, temp HP, death saves, inspiration,
conditions, their own notes, spell slots, class resources and item charges,
inventory quantities. **Players may not edit:** race, class, background,
feats, ability scores, features — anything D&D Beyond decides. **Players may
(owner):** move their own token; trigger actions, bonus actions and
reactions for their character and for their companion / familiar / summon.

Design:
- **A. Mapper + live resources** (client only). `mapCharacter` keeps
  activation type, attack bonus, damage dice, save DCs, `limitedUse`
  counters, spell slots / pact magic, item charges, `creatures[]` as
  companions, death saves, temp HP, inspiration, currencies. Live state on
  the party member gains slot/resource usage, temp HP, death saves,
  inspiration, player notes (separate from GM notes), inventory deltas.
  Sheet: pips, roll buttons, short/long rest, summon companion → combat
  instance (`sourceKind: 'companion'`, `owner: memberId`).
- **B. Worker: `SessionRoom` Durable Object.** `POST /session` → `{ code,
  gmToken }`; `GET /session/:code/ws?token=…` WebSocket. Doc = the shared
  slice only (party, combat, maps). Ops carry the State function name and
  args; the DO validates by role, applies, persists (SQLite), broadcasts.
  Player sockets get a filtered view: no GM notes, no hidden tokens, no
  instance notes; ops that touch those aren't forwarded. Idle sessions
  expire by alarm after 14 days.
- **C. Client session mode.** State mutators become named ops through one
  `commit()`; with a session live they also go over the socket; incoming
  ops apply without re-sending. GM: Start session → code + link. Player:
  `play.html?s=CODE` → claim → sheet; `vtt.html?view=player&s=CODE` over
  the socket. Rolls are bus events shown in the GM's roll log and on the
  table.

Weapon proficiency is assumed (D&D Beyond doesn't put it on the item);
noted on the sheet as best-effort like AC.

- **A landed** (2026-09-09), verified on the Druid 13 fixture through the
  sheet's own controls: slot pip 4→3; temp HP 5 then Damage 8 → 107→104
  with temp cleared; Produce Flame rolled attack +9 and 1d8 fire onto the
  bus; Wild Shape spent; scimitar rolled +6 / 1d6+1; the Ape summoned into
  the running Infirmary encounter as a companion instance with Fist/Rock
  rollable in play mode; sheet rolls arrive in the play-mode log; long rest
  restored HP, slots and resources. Found on the way: D&D Beyond reports
  class-derived spell slots as `available: 0`; the mapper now falls back to
  the standard table by caster level.

- **B + C landed** (2026-09-09), verified against `wrangler dev` with the
  GM page on localhost and the player on 127.0.0.1 (a separate origin, so
  separate storage — a same-origin tab would have shared the GM's session
  key). Start session → room code and join link; player auto-joined from
  the link, claimed Eeyore, got the sheet with GM notes absent from their
  copy; reload restored both roles. Player slot spend and Produce Flame
  roll reached the GM; a player `setMapState` was refused by the server
  ("not allowed"). GM damage redrew the player's sheet live. Player
  dragged their Ape on their table → GM page and GM table both show (8,5);
  dragging Adam panned instead. Found on the way: ops applied from the
  socket fire `state:changed` with `remote: false`, so panels that only
  redrew on outside changes missed them — the session now emits
  `state:remote` and those panels listen for it. Also an index bug in the
  player rule for summoning (args[3] for a 3-arg op), caught by the Node
  unit test before it reached a browser.

- **Scene list, layout weights, PDF import** (2026-09-09). Scene rows get
  a done checkbox; the default preset is 30/50/20. D&D Beyond PDF import:
  first built as a positioned-text parser calibrated on `pdftotext -bbox`
  (worked in Node on both sample sheets), then found pdf.js's text layer
  holds only the template labels — the values are *widget annotations
  with field names*. Rewrote the parser around that field map; it is
  simpler and exact. Verified in Node (pdfjs-dist harness in the
  scratchpad reads the same annotations the browser does) and in the
  browser through the real File path: Warlock 9 (34 spells, pact 2×L5, DC
  18/+10, attuned items) and Paladin 9 (slots 4/3/2, DC 13/+5, smites
  with saves) both correct; sheet renders with pips, attack buttons,
  corpus spell text; a roll logs. Sample PDFs are git-ignored (they name
  a real player).

- **Nesting, roster cards, inspector sheet, creator** (2026-09-09). Scene
  order entries became `{ h, p }` (a parent link) in depth-first order;
  drops have before/after/into zones, ⇥/⇤ buttons do the same, depth
  capped at 3, moves carry a scene's descendants. Encounter rows became
  cards (kind colour, HP bar, condition-add and the roster editor hidden
  behind buttons). The Inspector shows the full sheet for a character.
  The creator derives a snapshot from choices alone using the corpus's
  progression tables; verified by hand on a Paladin 5 (HP 44, PB 3,
  attacks +6, slots 4/2, DC 12, Valkyr features at 3, Alert at 4) and
  through the wizard's own controls in the browser. Judgement calls:
  origin feat comes from the background as the 2024 rules say; HP uses
  the die's average after level 1; resources are the numeric progression
  columns (short rest for Channel Divinity, Focus Points, Second Wind,
  Action Surge, Bardic Inspiration, Wild Shape; long otherwise); spell
  attack/save/damage are read from the spell text. The SRD progression
  stops at 20, so the wizard does too.

## Panel split

Today's Adventure Tracker is both navigation and the scene page. It becomes:

- `tracker` — adventure overview, progress, phase/scene picker
- `scene` — the current scene's text and Run Encounter
- `inspector` — whatever is selected: a combatant instance, NPC, location,
  item; empty state explains itself
- `glossary` — rules glossary with search

"Current scene" and "current selection" become shared app state and travel
over the bus, so a token click in the VTT selects that combatant in the
Inspector.

## Log

- **Layout + bus landed** (2026-09-08). Verified in-browser at 1400px: default
  preset, per-tile scroll, picker → scene sync, location/opponent/glossary/
  combatant selection into the Inspector, gutter drag persisted as weights,
  preset switch, tree editor, drawer for unmounted panels, narrow fallback.
  Cross-window, two tabs: HP − in A → B's Inspector showed 76/77 (selection
  crossed too); "done" checkbox in B → A's progress, picker dot and scene
  card updated. No reloads.
- **Bug found while verifying, pre-existing:** `Hit Points` is a string in
  the corpus, so the −/+ HP buttons did `"77" + (-1)` → `"77-1"` →
  `Math.max` → NaN for every stat-block-seeded combatant. Both earlier
  smoke tests drove HP through the API with numbers and never pressed the
  button on an NPC row. Fixed at every entry point via `AxisRender.toInt`.
  Lesson kept: verify through the control the GM will use, not the API
  under it.
- **VTT landed** (2026-09-08). Verified with three windows (GM page, table,
  player view): tokens seeded from the running encounter with stat-block
  sizes; drag snapped to cells and persisted; circle/fog-reveal/ping via
  the real tools; right-click Damage 5 → 88→83 in state, on the token, and
  in the GM's combat row and effects sidebar; condition pip on the token;
  token click → GM Inspector; GM scene change → table and player view
  followed; ping from the table → player view. Player view hid the token
  outside the revealed rect, drew fog opaque, dropped HP numbers on NPCs.
  One bug caught: the player toolbar never built (`switchScene` only built
  it for the GM) — fixed.
- **Test note:** End Encounter uses a native `confirm()`; scripted tests
  must stub `window.confirm` or the click silently does nothing.
- NPC stat blocks from the Mikko PDF carry no ability scores; the
  Inspector's "STR —" is the source, not a rendering gap.

## Assets

The infirmary still is 3840×2160 PNG, 9.6 MB. The served asset is a WebP at
2560 wide (~2 MB); the original stays out of the repo. Images are referenced
files, never base64.

## State additions

```
layout:   { dir, children }                         // per-browser, exported
selection:{ kind, id }                              // not persisted
maps:     { [sceneHash]: { image, w, h, grid:{size, ox, oy}, fog:[...],
            tokens:[{ instanceId, x, y, size }], effects:[...] } }
```

`maps` rides in the GM-state export like `combat` does.
