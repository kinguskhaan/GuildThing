---
target: Discord Server Controls layout
total_score: 13
max_score: 40
na_heuristics: 
p0_count: 3
p1_count: 2
target_identity: "file:/home/flip/Development/personal/GuildThing/apps/web/src/app/_components/discord-server-controls.tsx"
target_fingerprint: "sha256:da09059e39daafc6d8bd58fb2341947539b0677cfb75fbca2cc7e7a7bd7ccaa6"
target_path: /home/flip/Development/personal/GuildThing/apps/web/src/app/_components/discord-server-controls.tsx
timestamp: 2026-09-05T10-22-21Z
slug: src-app-components-discord-server-controls-tsx
---
# Kritikrapport — Discord Server Controls (Cabinet Schematic-bygget)

**Method: dual-agent (A: CritiqueA · B: CritiqueB)**

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Systemstatus synlighet | 1 | SAVING i 8px; filterrollen namngs inte; CHECK utan utväg |
| 2 | Match mot verkligheten | 2 | junction/sealed/tape-metaforerna förklaras aldrig |
| 3 | User control | 1 | Ingen rule-delete, label-redigering eller undo |
| 4 | Konsistens | 1 | Två spar-kontrakt: blur vs instant i samma panel |
| 5 | Error prevention | 1 | APPLY + unseal utan bekräftelse |
| 6 | Recognition | 2 | Matrix-celler utan kolumnrubriker |
| 7 | Flexibility | 2 | Matrix/audit .slice(0,3) — veckans triage omöjlig |
| 8 | Aesthetic | 2 | Världen landar, men 27 kontroller utan hierarki |
| 9 | Error recovery | 1 | Inga onError-ytor på mutationer |
| 10 | Help & documentation | 0 | Noll förklarande text |
| **Total** | | **13/40** | **Brott (Under construction)** |

## Design-specificity
Autentiserad för produkten, inte kategori-rutbytbar: Power & Interlocks-brytaren, SEALED-latchar, ⊕-mutex-notation, regler som satser, sync-pulsen. Specificiteten sitter i vokabulären, inte i lösningarna — junction är statisk text, R2-preview en chip-dublett, och 6 gamla flikars funktionalitet finns ingenstans.

## Deterministic scan (Assessment B)
CLI: 3 advisories (design-system-color: rgba(159,212,245,.3), rgba(255,176,0,.07), rgba(53,224,138,.06) — sannolika FP: alpha-tinter av redan använda nyanser). Browser: 59 fynd — 39 undersized-ui-text (6–10px), 8 dark-glow, 6 tiny-text (9px), 3 text-overflow (matrix-rader +56px), 2 text-occlusion ("+ seal a role" 100% täckt), 1 overused-font (geist 44%, marginal).

## Priority Issues
- [P0] Typografi- och target-kollaps: 6–9px kärntext, toggle 46×16, celler 20×13. Fix: 12px golv, 44px targets.
- [P0] Ö-effekten: fast 1024×640-ram i fluid Discord-skal; h1-hierarki inverterad; horisontell scroll + vit body vid 1024px. Fix: fluid i skalet, ärva Discord-tokens.
- [P0] Försvunnen funktionalitet: 5/6 flikar oportade; "+ add channel grant" död; rule-delete/label saknas; protected/mutex read-only; matrix 3 medlemmar; audit 3 rader.
- [P1] Högrisk utan checkpoints: APPLY utan diff/confirm/undo; unseal 1-klick; inga onError; kill switch-konsekvens i sr-only.
- [P1] Inkonsistenta spar-kontrakt: blur vs instant; SAVING 8px; inga kolumnrubriker; filterrollen onamngiven.

## Persona red flags
- Förstagångsanvändare: metaforer avkodas aldrig; Enter sparar osynligt; död knapp; CHECK utan utväg; 6–8px oläsligt.
- GM: unseal 1-klick utan confirm; APPLY bulk utan bekräftelse; protected/mutex read-only.
- Power user: matrix/audit kapade på 3; alla flikar borta; selects utan caret-affordance.

## Strengths
1. Funktionell färggrammatik: held=phosphor, staged-add=grön, staged-remove=röd, sealed=dimmad streckad; amber reserverad för interlocks.
2. Regler som läsbara satser + condition→junction→grant-graf.
3. Sealed-konceptet: ärlighet om vad syncen äger.

## Questions to consider
- Överlever schemat 25 regler?
- Slår meningen "Members with rank Initiate get @guildie" JUNCTION → GRANT ALL?
- Tar världen över sidebaren en dag, eller blir sidan ett museum i en Discord-app?
