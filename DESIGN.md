# Admin pages design

The admin pages (`/admin/players`, `/admin/player`, `/admin/gifts`, `/admin`) use one sheet,
`web/public/admin.css`. It mixes the feel of Apple's site and materials with the game's colours.
Apple is only an inspiration: no Apple logo, name or copy. The frosted glass is a web approximation
(`backdrop-filter`), not an official Apple material.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--deep` | `#04103a` | Page colour, under `/game-assets/site/play_bg.png` |
| `--cyan` | `#3fd2ff` | The only interactive colour: primary button, links, focus, selection |
| `--gold` | `#ffc531` | What a player earned: bits, rank, totals of the bonus editor |
| `--text` / `--muted` | `#eef6ff` / `#a9c2e4` | Text, secondary text |
| `--ok` / `--err` | `#5fe3a1` / `#ff8f8f` | Online and delivered, errors |
| `--glass` | `rgb(14 40 104 / 0.5)` | Panels, with a 22 px blur and a white top highlight |
| `--well` | `rgb(2 10 38 / 0.48)` | Cards and inputs inside a panel |

Radii: 18 px for panels, 10 px for cards and inputs, 8 px for small tiles, full for pills.
Type: the system stack (SF Pro, Segoe UI Variable), tight tracking on headings.

## Rules

- Game pictures keep their pixels: whole-number zoom (`sprite()` in `admin-common.js`) and
  `image-rendering: pixelated`.
- Every Digimon, item and medal shows its sprite next to its name.
- Actions are pills. A page has one primary (cyan) action at most.
- Labels sit above inputs. No placeholder stands in for a label, except search fields.
- Each list has its loading, empty and error text.
- No em dashes or en dashes in page text. Page text is in English.
- `prefers-reduced-transparency` swaps glass for a solid colour, `prefers-reduced-motion` removes
  transitions. Layouts collapse to one column under 860 px, with no horizontal page scroll.
