---
target: Discord Server Controls layout
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
target_identity: "file:/home/flip/Development/personal/GuildThing/apps/web/src/app/_components/discord-server-controls.tsx"
target_fingerprint: "sha256:da6a22f9ae1488a2fc3cdbd184637619d2bcb6ffd76d33dea1441bd4aa3a0726"
target_path: /home/flip/Development/personal/GuildThing/apps/web/src/app/_components/discord-server-controls.tsx
timestamp: 2026-09-05T10-53-16Z
slug: src-app-components-discord-server-controls-tsx
---
# Kritikrapport — Discord Server Controls (hybridbygget, omgång 2)

Method: dual-agent (A: CritiqueA2 · B: CritiqueB2)

## Design Health Score: 23/40 (föregående 13/40)
| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Systemstatus | 3 | Pulsen animerar även osparade utkast |
| 2 | Verklighetsmatch | 3 | Armory-slugs utan validering |
| 3 | User control | 2 | Delete rule serversidigt 1-klick |
| 4 | Konsistens | 2 | Tre Save-nivåer; stale "Role rules tab"-copy; React Flow tredje språk |
| 5 | Error prevention | 2 | APPLY-dialog ej modal; bulk obekräftat |
| 6 | Recognition | 2 | Ingen TOC på 4177px |
| 7 | Flexibility | 2 | Inga ankare/tangenter |
| 8 | Aesthetic | 3 | Strikt skala, konsekvent pill-grammatik |
| 9 | Error recovery | 2 | Råa meddelanden utan återhämtningsråd |
| 10 | Help | 2 | Bra microcopy; inga slughjälpar |

## Design-specificity
Autentiskt författad: brytare + latches + meningschips + sync-puls i Discord-paneler. Caveat: cyan är en tredje accent vid sidan av blurple.

## Deterministic scan
CLI: 0 fynd på målfilerna (ren). Adjacent: 5 design-system-color + 5 design-system-radius advisories i discord-controls.css. Browser: 58 fynd — 7 text-occlusion FP (detektorns egna overlays), 19 low-contrast (realt: dim-kickers 1.58:1, muted 4.05:1), 10 line-length, 5 clipped-overflow (React Flow), 3 cramped-padding, övriga marginal/FP.

## Priority Issues
- [P0] APPLY-dialogen ej modal (dialog[open] utan showModal) — sidan klickbar under bekräftelse; backdrop-klass död.
- [P0] Farlighetsasymmetri: Delete rule + bulk Mark inactive/Reactivate utan confirm, medan unseal/apply guardas.
- [P1] Osparade regelutkast osynliga (chips renderar draft; navigation tappar allt).
- [P1] Kontrast: when/grant-kickers 1.58:1; muted 4.05:1.
- [P1] Wayfinding saknas (4177px, inga ankare); stale copy; React Flow-canvas klipps vid 1024 + talar tredje språk.

## Strengths
1. Members-by-role-staging: lokal desired state → räknad knapp → diff-dialog → ärlig varning.
2. Schemat som innehåll är produktspecifikt (brytare, latches, meningschips, puls).
3. Ärlig systemstatus: lampor, timestamps, aria, reduced-motion.

## Personas
- Power user: älskar triage-grid + export; "Mark inactive" utan confirm är fartfälla; saknar ankare.
- Förstagång: armory-slugs ogenomträngliga; seal-select onBlur-flakey; inactivity-kontrakt otydligt.
- GM: audit kollapsad sist visar (0); ingen väg från resync/APPLY till loggen; osparade utkast kan försvinna tyst.

## Provocative questions
- Ska farlighetens fysiska storlek spegla konsekvensen?
- Autosparning med undo-log istället för 9 Save-knappar?
- Borde audit log öppna berättelsen istället för att avsluta den?
