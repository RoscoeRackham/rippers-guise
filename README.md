# rippers-guise

The **Guise** — the mask / identity a character wears — as a **first-class Project FU
classFeature**, on the Arcanist's **Arcanum** pattern. Foundry **v13**. Original campaign
content; layers on Project FU; ships **no** Project FU / Fabula Ultima content.

## What it does

A character can hold several guises. **Binding** one makes it the single active guise
(dismissing any other); clicking the active guise **dismisses** it. Each guise's stat
deltas ride its own embedded ActiveEffects, which Project FU transfers to the actor **only
while that guise is bound** — so a swap moves the deltas. Exactly one guise is active at a
time, the way an Arcanist has one Arcanum merged.

- **Registers** a `guise` classFeature on FU's module-open registry
  (`CONFIG.FU.classFeatureRegistry.register('rippers-guise', 'guise', …)`) — **no system fork**.
- **Bind / dismiss** = click the guise on the character sheet (`roll()`), the same path FU
  already wires for rollable class features. A chat card notes the swap.
- **Active state** is stored in `actor.flags['rippers-guise'].activeGuise`. (Arcanum uses the
  FU actor field `system.equipped.arcanum`; a module can't add `equipped.guise` to the actor
  schema, so we use a module flag. `setFlag` triggers `prepareData`, which re-evaluates
  `transferEffects()` and re-applies the active guise's deltas.)
- **Deltas** are authored as embedded ActiveEffects on each guise Item (the FU idiom), gated
  by `GuiseDataModel.transferEffects()` → applied only while bound.

### API / macros

`game.modules.get('rippers-guise').api` exposes `setActiveGuise(actor, itemId)`,
`getActiveGuise(actor)`, and `clearActiveGuise(actor)` for macros or other modules.

## Pack

| Pack | Type | Contents |
|---|---|---|
| **Rippers Guises** (`guises`) | Item (`classFeature`) | Starter guises (`featureType: rippers-guise.guise`) with a persona (identity/role/notes) and one embedded delta each — Inspector Grange (+1 Accuracy), Dr. Ravensworth (+1 to Open Checks), The Ragged Man (+1 Defense). |

## Innate benefit pool guard (Austin canon)

A guise **must never** apply anything in the class **innate benefit pool** — that comes
from CLASSES (the compendium's TRUE-with-note benefits), not from a mask:

- HP / MP / IP (`system.resources.{hp,mp,ip}.*`)
- martial proficiencies (melee / ranged / armor / shields)
- ritual access
- Projects

Guises may only modify things **outside** the pool — attributes, accuracy / magic / damage
bonuses, defenses (DEF / MDEF), affinities, initiative, and so on. The module **enforces
this at the document layer**: any innate-pool change on a guise effect is stripped on
create/update (compendium drop, effect add, effect edit), so it never persists and never
applies — **even for player-authored guises**. A guise whose only change is illegal simply
applies nothing. (FU applies effects via native `changes` with no per-change hook for
standard modes, so stripping at the data layer is the robust guard.) `console.debug` reports
what was stripped. `game.modules.get('rippers-guise').api.sanitizeActorGuises(actor)` cleans
any guise saved before the guard existed.

These starters exercise the mechanism with three delta kinds. A campaign's real guises are
per-character personas the players author on the guise sheet (or add to `GUISES` in
`tools/build-guises.mjs`).

## ⚠ First-load verification owed

This module was authored against the Project FU **v13 source** and mirrors the shipped
Arcanum classFeature exactly; the compendium round-trips through `npm run pack`. It has **not**
been loaded in a live Foundry from here (none available in the build environment). On first
load in Austin's v13 world, confirm: (1) the guise sheet opens and edits identity/role/notes;
(2) clicking a guise binds it and posts the chat card; (3) binding applies the delta on the
sheet and **dismissing / swapping removes it** (this is the flag-drives-`transferEffects`
re-application — the one behaviour that can only be confirmed live). If (3) does not
re-apply on a flag change, the fallback is to drive the swap from a macro that also calls
`actor.update({})` (or toggles the effect's `disabled`) to force re-preparation — the API is
already in place.

## Build

```
npm install                    # once — @foundryvtt/foundryvtt-cli
node tools/build-guises.mjs    # regenerate src/packs/guises from the GUISES list
npm run pack                   # compile src/packs/<pack> -> packs/<pack> (LevelDB)
npm run unpack                 # reverse
```

## Install (personal table)

```
https://github.com/RoscoeRackham/rippers-guise/releases/latest/download/module.json
```

Enable in your Project FU v13 world (with the `projectfu` system active). Drag a guise onto
a character; click it to bind.
