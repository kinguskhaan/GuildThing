# Peer-export (P2P-data i den vanliga exporten) — plan

## Vad som redan är byggt (addon-sidan)

`GT.ExportCurrentCharacter()` (Core.lua) inkluderar nu en `peers`-array
utöver den egna karaktären — allt spelaren känner till om ANDRA via
P2P-mesh:et (`GuildThingDB.P2PData`, byggt av `P2PSync.lua`s
broadcast/gossip-flöden, se `P2PSync.lua` för fullständig algoritm).

```json
{
  "name": "Tankkingen", "realm": "Spineshatter", "class": "WARRIOR",
  "professions": { "Enchanting": [{ "name": "...", "itemID": null, "spellID": 27984 }] },
  "peers": [
    {
      "name": "Orcrimmar", "realm": "Spineshatter", "class": "WARRIOR",
      "professions": { "Enchanting": [{ "name": "...", "itemID": null, "spellID": 27984 }] }
    }
  ]
}
```

Varje `peers[i]`-objekt har EXAKT samma form som toppnivå-objektet
(`name`/`realm`/`class`/`professions`) — validerbart med samma
`wowImportSchema` som redan finns i `src/server/api/routers/guild.ts`,
bara loopat.

**Hur `peers[i].professions` byggs:** P2P-cachen sparar bara platta
receptnamn per person (`recipeNames`, en mängd), ingen profession eller
spellID/itemID. Addon-sidan slår upp varje namn i den bundlade katalogen
(`Data/Recipes.lua`) för att återskapa `{profession, kind, id}` och
matcha exportformatet. Namn utan katalogträff (borde inte hända) hoppas
tyst över. Peers utan några lösbara recept alls tas inte med i arrayen.

**Testat lokalt** (fristående Lua-simulering, inte i spelet): bygger
korrekt JSON, spellID slås upp rätt, olösbara namn hoppas över tyst.
Inte testat mot en riktig andra spelare i spelet än.

## Vad som behöver byggas (webbsidan)

`wowImportSchema`/`importCharacter` (guild.ts) tar redan emot
`class` — den delen av gamla `EXPORT_PLAN.md`s punkt 1 var redan
löst. Kvar är bara peer-delen.

### Det svåra: `GuildCharacter` är scopead per inloggad användare

```prisma
model GuildCharacter {
  guildId  String
  userId   String   // <- ägaren, den som importerade
  name     String
  realm    String
  @@unique([guildId, userId, name, realm])
}
```

`importCharacter` gör `upsert` på `{guildId, userId, name, realm}` —
alltså **spelare A:s egen inloggning**. Om vi rakt av loopar
`peers`-arrayen genom samma mutation, skapas en `GuildCharacter`-rad
för "Orcrimmar" ägd av spelare A:s konto — en HELT SEPARAT rad från
Orcrimmars EGEN `GuildCharacter`-rad (ägd av Orcrimmars konto, om/när
hen själv exporterar). Två spelare som båda råkar känna till Orcrimmar
via P2P skulle skapa ÄNNU fler dubbletter. Resultatet: Orcrimmars
"riktiga" profil (den hen själv äger) blandas aldrig ihop med det andra
säger sig veta om henne — data fragmenteras istället för att
centraliseras.

**Det här är en produktbeslutsfråga, inte bara en implementationsdetalj
— flaggar den hellre än gissar.**

### Alternativ

**A. Separat lagring, läs-tids-merge (rekommenderas)**

Ny modell, t.ex. `PeerReportedCharacter` (eller en `source`-kolumn på
en ny tabell) — `{guildId, reportedByUserId, name, realm, class,
professions/recipes, reportedAt}`. Skriver ALDRIG in i den riktiga
`GuildCharacter`/`Profession`. Vid visning (roster, crafters-lookup):
slå ihop "riktig export" + "peer-rapporterat" per (name, realm), med
riktig export som alltid vinnande källa om båda finns.

- Fördel: ingen risk att en spelares peer-data av misstag skriver över
  eller krockar med nån annans riktiga, självrapporterade profil.
  Ingen möjlighet att en illvillig/felaktig export förstör nåns data.
- Nackdel: kräver en union-query vid varje roster/crafters-lookup
  istället för en ren tabell-läsning.

**B. Merge rakt in i `GuildCharacter`, oavsett vem som skickade in det**

Släpp `userId` ur unique-nyckeln för peer-skrivningar (matcha bara på
`guildId+name+realm`), skriv in direkt. Enklare läs-sida, men öppnar
för att vem som helst i gillet kan skriva över en annan spelares
profil via peer-export — även av misstag (stale P2P-cache, gammal
data som skrivs över nyare).

- Fördel: enklast att implementera och läsa.
- Nackdel: dataintegritet — ingen skyddar en spelares egen export från
  att skrivas över av nån annans (potentiellt inaktuella) peer-data.

**Rekommendation:** A. Peer-data är per definition andrahandsinformation
(kan vara inaktuell, kommer inte direkt från personen själv) — bör
aldrig kunna skriva över nåns egen, förstahandsrapporterade profil.

### Konkreta steg (oavsett A/B)

1. Lägg till `peers: z.array(wowImportSchema).optional()` i
   `wowImportSchema` (eller en variant utan `class` som required — peer-
   data kan sakna klass om `payload.c` aldrig satts, se `P2PSync.lua`).
2. I `importCharacter`-mutationen: loopa `input.character.peers ?? []`
   efter den befintliga egna-karaktären-logiken.
3. Bestäm A eller B, bygg tabellen/skrivningen därefter.
4. Om A: uppdatera roster/crafters-queries att union:a de två källorna.
5. Städ/staleness: peer-rapporterad data kan bli inaktuell (personen
   själv exporterar aldrig, eller lämnar gillet). Överväg samma
   staleness-mönster `EXPORT_PLAN.md` redan föreslår för guild-data
   generellt — kanske ännu viktigare här eftersom källan är indirekt.

## Öppna frågor till dig

- A eller B (eller nåt annat)?
- Ska peer-rapporterad data synas annorlunda i UI:t (t.ex. "rapporterat
  av gillmedlem, inte självexporterat") eller osynligt sammanslaget?
- Cap på antal peers per export, eller storlek på strängen överlag,
  om nån känner till väldigt många (litar just nu bara på att addonets
  230-tecken-chunk-gräns för P2P-sync håller ner cachens storlek
  naturligt — inget explicit tak i exporten själv).
