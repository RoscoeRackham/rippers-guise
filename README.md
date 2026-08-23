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

## Hunter Weapon — free two-form swap (FDN-8 Stage 8a)

The Hunter Weapon leans on Project FU's native transforming `customWeapon`
(`system.isTransforming` / `activeForm` / `secondaryForm`). This module adds the
campaign layer: an `isHunterWeapon` mark, material/origin fields, and a **free**
melee⇄ranged form swap that does **not** consume the Equipment Action and is
limited to **once per turn** in combat.

Mark a weapon and swap its form from a Macro (hotbar):

```js
const api = game.modules.get('rippers-guise').api;
const actor = canvas.tokens.controlled[0]?.actor ?? game.user.character;
// one-time: flag your transforming custom weapon as the Hunter Weapon
// await api.setHunterWeapon(actor.items.getName('Silverpoint'), { material: 'silver', origin: 'A Butcher\'s prosthetic' });

// the free once-per-turn two-form swap:
await api.swapHunterWeaponForm(actor);
```

`api.swapActiveForm(weapon)` swaps a specific weapon; `api.swapHunterWeaponForm(actor)`
finds the actor's equipped (or first) transforming Hunter Weapon and swaps it.

## Hoplosphere sockets (FDN-8 Stage 8b)

PFU already slots hoplospheres into custom weapons; this module adds the campaign
socket-count-by-level rule (**one socket per five levels to six at thirty; the
Hunter Weapon gains one more at 40 and 50 → eight by fifty**) and the **two-Immunity
cap**. Slotting a sphere that would exceed the level capacity or the cap is refused.

Audit any weapon from a macro:

```js
const api = game.modules.get('rippers-guise').api;
const w = actor.items.getName('Silverpoint');
console.log(api.checkHoplosphereSockets(w, actor));
// -> { capacity, used, free, seated, overSockets, immunities, overImmunityCap, ok }
```

## Heroic slots (FDN-8 Stage 8c)

PFU heroic Items carry no slot accounting; this adds the four canon slots —
**creation · level40 · level50 · earned** — pointing at owned heroic Items:

- `level40` / `level50` unlock only at character level 40 / 50,
- the **creation** slot refuses `creation_banned` heroics,
- **dormancy**: the creation heroic sleeps while a guise is worn; level40/50 and
  earned stay always-live (character-owned).

```js
const api = game.modules.get('rippers-guise').api;
await api.assignHeroicSlot(actor, 'creation', actor.items.getName('Brave'));
await api.assignHeroicSlot(actor, 'earned',   someHeroicItem);
console.log(api.getHeroicSlots(actor)); // { creation, level40, level50, earned:[...] }
```

## Hunter Weapon banes (HW1, ratified)

The Hunter Weapon's **material is its bane key** — the canon engine reads
`wpn_material = any(foe.banes)` and applies the existing bane effect (2× damage
vs soldier/PC, +2 Pressure vs elite/champion). Set it with `setHunterWeapon`:

```js
await api.setHunterWeapon(weapon, { material: 'silver' });   // -> bane key 'silver' (beast/lycanthrope)
// cold_iron · consecrated · wood map the same way; cursed has no default:
await api.setHunterWeapon(weapon, { material: 'cursed', baneKey: 'the_hollow_king' }); // GM-authored
api.hunterWeaponBaneKey(weapon); // -> the resolved bane key
```

## Benefit-pick pool (Case B, `GUISES-core-rules.md` §1)

Austin's ruleset: **classes grant no innate benefits** — not the character's own
classes, not guise-worn ones. Every benefit comes from the character's **two
creation picks** (permanent, unbuyable). This module is the source of truth for
those picks and makes the mechanically-live ones real.

The pool (`api.BENEFIT_POOL`), verbatim from §1:

- **Stat picks** (uncontested — any number of characters): `hp10` (+10 HP),
  `mp10` (+10 MP), `hpmp5` (+5 HP and +5 MP), `ip4` (+4 IP).
- **Capability picks** (contested — one character in the party): `projects`,
  `rituals` (Ritualism universal + one named contested discipline),
  `see_you_later`, `unexpected_ally`, `personal_vehicle`, and `familiar`
  (**trades both picks**).

**Proficiency is universal** (`GUISES-core-rules.md` §3) — there are no
martial/armor/shield picks; "martial" is only a tag on equipment.

```js
const api = game.modules.get('rippers-guise').api;
await api.setBenefitPicks(actor, { picks: ['hp10', 'ip4'] });                 // stat picks
await api.setBenefitPicks(actor, { picks: ['rituals', 'mp10'], ritualDiscipline: 'Elementalism' });
api.getBenefitPicks(actor);      // { picks:[...], ritualDiscipline:'...' }
api.benefitPickSummary(actor);   // 'Rituals (Ritualism + Elementalism) · +10 MP'
```

- Stat picks land on `system.resources.{hp,mp,ip}.bonus` via a single on-actor
  **"Benefit Picks"** ActiveEffect (rebuilt idempotently on every set).
  Capability picks are display / honor-system (contested-overlap is enforced at
  the table, not cross-actor in code).
- **Always-live**: the picks are the character's, never a mask's — dormancy never
  touches them; the effect persists through bind and dismiss.
- The record is a per-character flag singleton (`flags.rippers-guise.benefitPicks`).

**Ritual disciplines (three routes, display-only).** PFU does not gate ritual
casting on any actor field (a ritual is a `ritual` Item; casting is a check on
it), so ritual-granting is tracked for display / the contested-discipline rule /
the Guise Builder — not as a mechanical gate. `api.characterRitualDisciplines(actor)`
aggregates all three canon routes: (a) the `rituals` benefit pick (Ritualism +
the named discipline), (b) a ritual-granting **class skill**, and (c) a granting
**keystone** — where (b)/(c) carry `flags.<ns>.grantsRitual = "<discipline>"` (or
an array). The class-level ritualism boolean is inert and stays neutralized by the
compendium delta; the grant lives on the skill/keystone that actually confers it.
Projects follow the same shape: `api.characterCanInitiateProjects(actor)` ORs the
`projects` pick with any Item carrying `flags.<ns>.grantsProject === true`.

**Companion compendium delta (ships together):** because a class Item's benefit
booleans are its own intrinsic data (not ActiveEffect changes the guard can see),
the class-side reconciliation lives in **rippers-compendium** — its generator sets
every class's benefit booleans to `false` (printed values kept as a display-only
`flags.rippers-compendium.printedBenefits` catalog) so the pool is the sole source
and PFU doesn't double-count. Neutralization and this engine **must ship in the
same drop** — neutralizing class benefits without the pool live would strip every
character's HP/MP/IP. For legacy actors imported before the delta,
`api.stripClassBenefits(actor)` neutralizes their own class Items' booleans.
