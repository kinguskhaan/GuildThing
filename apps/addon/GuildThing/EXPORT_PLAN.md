# Guild-wide export/import — plan

Mål: en knapp på hemsidan exporterar vad ALLA guildies kan (recept/spells),
som en komprimerad sträng man klistrar in i addonet. Likt Gargul's
softres.it-import (base64(zlib(json))), men addon<->site är egen kanal så vi
äger båda ändar.

## Format på strängen

`base64(zlib(json))` — samma pipeline som Gargul, men JSON-strukturen är
reverse-indexerad för att hålla strängen liten i stora guilds:

```json
{
  "guild": "GuildName-Realm",
  "exportedAt": 1234567890,
  "characters": [
    { "name": "Tankkingen", "realm": "Spineshatter", "class": "WARRIOR" }
  ],
  "recipes": [
    { "name": "Adamantite Breastplate", "spellId": 29606, "itemId": null, "chars": [0, 3, 7] }
  ]
}
```

`chars` = index in i `characters`-arrayen (inte fulla namn upprepade per
recept). Recipe skrivs en gång oavsett hur många karaktärer som kan den —
stor vinst när t.ex. 10 alchemists delar samma bas-recept.

Komprimering: Node `zlib.deflateSync` (RFC1950/zlib-format) på site-sidan,
`LibDeflate:DecompressZlib` på addon-sidan — standardformat, ingen custom
protokoll behövs.

## Website-sidan (behöver fixas)

1. **Class-fält saknas i DB** — `GuildCharacter`-modellen (prisma/schema.prisma)
   har inget `class`-fält. Addon skickar redan `class` i JSON
   (Core.lua:118), men `wowImportSchema` i `src/server/api/routers/guild.ts`
   (rad 29) tar inte emot det och `importCharacter`-mutationen sparar det
   inte. Detta är en bug oavsett export-featuren — behövs för
   class-färgade tooltip-rader på addon-sidan.
   - Fix: lägg till `class String` i Prisma-schemat + migration, lägg till
     `class: z.string()` i `wowImportSchema`, spara det i
     `importCharacter`-mutationen.

2. **Ny procedure `guild.exportRoster`** i `guild.ts` — bygger
   reverse-index-JSON enligt formatet ovan. Kan återanvända logiken som
   redan finns i `professionRecipes`/`professionsOverview` (de grupperar
   redan crafters-per-recipe på liknande sätt). Komprimera med
   `zlib.deflateSync`, sen base64. Gate:a med samma `checkGuildRole` som
   `roster` gör.

3. **Ny UI-komponent `guild-export-panel.tsx`** — textarea/readonly box som
   visar strängen från `guild.exportRoster` + en copy-to-clipboard-knapp.
   Ingen befintlig fil täcker export-riktningen idag (bara
   `guild-import-form.tsx` finns, och den är för en enskild karaktär åt
   gången).

## Addon-sidan (behöver byggas)

4. **Vendora libs** — LibDeflate.lua + en Base64-lib. Gargul har båda i sin
   `Libs`-mapp (`GL.Base64`, `LibStub:GetLibrary("LibDeflate")`) — kolla om
   de är fristående vendorade filer eller Gargul-egna wrappers innan
   kopiering rakt av. Behöver även en minimal JSON-decoder
   (`GL.JSON`-motsvarighet), typ ~100 rader ren Lua.

5. **Ny fil `GuildData.lua`** — `GT.ImportGuildData(str)`:
   base64 decode → `LibDeflate:DecompressZlib` → JSON decode → validera
   shape → spara i `GuildThingDB.GuildData` (characters-array,
   recipes-reverse-index, exportedAt/importedAt). Bygg lookup-tabeller i
   minnet (spellId/itemId → character-index) för snabb tooltip-slagning,
   samma mönster som Gargul's `MaterializedData.PlayerNamesByItemID`.

6. **UI + tooltip-hook i `UI.lua`** — ny editbox för att klistra in
   guild-exportsträngen (skild från den befintliga export-boxen för egen
   karaktär). Hooka `OnTooltipSetItem`/`OnTooltipSetSpell` → lägg till
   "Craftable by: X, Y, Z"-rader, class-färgat likt Gargul's
   `SoftRes:tooltipLines`. Ev. `/gt who <recept>` som chat-fallback när
   man vill slå upp innan man har föremålet i handen.

7. **`GuildThing.toc`** — uppdatera med nya filer i rätt load-order (libs
   innan consumers): `Libs/LibDeflate.lua`, `Libs/Base64.lua`,
   `Libs/JSON.lua`, `GuildData.lua`, sen `UI.lua`.

## Övrigt att hålla koll på

- **Copy/paste-UX för stora strängar**: WoW har ingen OS-clipboard-API för
  addons — användaren måste select-all + Ctrl+C manuellt i editboxen. En
  hel guilds recept-data kan bli en lång sträng; komprimeringen hjälper
  men UX kan bli klumpig för väldigt stora guilds. Väg in om vi ska
  paginera (t.ex. exportera per profession) om det blir ett problem i
  praktiken.
- **Staleness**: överväg samma mönster som Gargul (auto-clear av
  guild-data efter X timmar) om datat annars riskerar bli inaktuellt utan
  att användaren märker det.

## Task-tracking

Dessa punkter finns även som tasks i sessionens TaskList (#1–#6) för den
som fortsätter i samma Claude Code-session.
