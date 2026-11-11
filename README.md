# Digimon World Championship (USA) — mod workspace

Romhack workspace. The original ROM stays untouched; mods are rebuilt into a new ROM.

## Layout

| Path | Content |
|---|---|
| `2596 - Digimon World Championship (USA).nds` | Original ROM (do not edit) |
| `tools/nds_tool.py` | Extract the NitroFS files / repack a ROM with replaced files |
| `tools/txt_tool.py` | Dump a `ui/txt/*.dat` text file to JSON and rebuild it |
| `tools/save_tool.py` | Decode a `.sav` to its raw game data and encode it back |
| `tools/sprite_tool.py` | Render Nitro sprites, animations, backgrounds and scene layouts (`.nxr`) to PNG |
| `tools/font_tool.py` | Export a Nitro font (`.NFTR`) as a glyph sheet + metrics |
| `tools/export_starter_assets.py` | Export the starter page's graphics and fonts to `web/game-assets/` |
| `tools/export_site_assets.py` | Export the intro and play pages' graphics (logo, battle grounds, fighter sprites) to `web/game-assets/` |
| `tools/export_admin_assets.py` | Export the admin pages' sprites (Digimon, items, medals) to `web/game-assets/admin/` |
| `tools/export_story_assets.py` | Export the story intro's graphics (battle sprites with their moves, battle grounds, VS screen) to `web/game-assets/story/` |
| `tools/make_dev_team.py` | The Championship final against the developer's team (`patches/dev_team.json` + its name in `text/txt_list_txt.json`) |
| `tools/make_keyboard_mod.py` | Make the text keyboard cheap to draw (`mod/ui/keyboard*` + `patches/fast_keyboard.json`) |
| `tools/make_web_patch.py` | Write the site's patch (`web/public/mod.patch`): the bytes that turn the original ROM into the modded one |
| `tools/make_guide.py` | Build `docs/*.pdf`: every Digimon (sprite, level, attribute, type, base stats), its digivolutions with their requirements, every title match, and the Championship (rules, prizes, the opponent pool of each battle; needs `unicorn`) |
| `patches/*.json` | Code patches (ARM9 / overlays), applied by `nds_tool.py repack` |
| `text/*.json` | Dumped game texts, ready to edit |
| `mod/` | Your modified files, with their NitroFS path (e.g. `mod/ui/txt/txt_list_txt.dat`) |
| `build/` | Rebuilt ROMs |

## Edit texts and rebuild the ROM

```bash
python tools/txt_tool.py build text/txt_list_txt.json mod/ui/txt/txt_list_txt.dat
python tools/nds_tool.py repack "2596 - Digimon World Championship (USA).nds" mod build/digimon_mod.nds patches/agumon_start.json patches/agumon_gift.json patches/skip_intro.json patches/online_mailbox.json patches/fast_keyboard.json patches/dev_team.json patches/no_save_quit.json
```

Code patches (each checks the original bytes before writing):

- `skip_intro.json` — boot straight into the save: no logos, movie, LOGIN / Continue menu or
  "Data loaded." box. Without a save, the normal LOGIN / New Game menu shows.
- `agumon_gift.json` — a new game puts an Agumon in a cage next to the starter DigiEgg.
- `no_save_quit.json` — Save & Quit in the field menu does nothing: on the site it would stop the
  game on "Turn the power OFF and end the game." The site saves the game by itself.
- `agumon_start.json` — the hunting tutorial spawns an Agumon instead of a Koromon.
- `fast_keyboard.json` — the text keyboard (DigiEgg name...) draws one picture of its keys at
  rest instead of 57 keys of 4 sprites each, and only a pressed key on top: 33 → 47 fps in the
  browser's emulator. It goes with the files `tools/make_keyboard_mod.py` writes to `mod/`:

  ```bash
  python tools/make_keyboard_mod.py extracted "2596 - Digimon World Championship (USA).nds" mod
  ```

- `dev_team.json` — the Championship final (always the same team) is the developer's team:
  "TheGreatArthur": Apollomon, Dianamon and Machinedramon, each with the best stat of the original
  final team ("Death & Laws") + 300: HP 4980, TP/Atk/Def 516, Wis/Spd 498. The opponent builder is
  rewritten as a loop that builds every other opponent exactly as before (checked on all 546
  of them), with one rule added: a stat value above 26 (the game's ranks stop at 23) is the stat
  itself. Team name and stats are options; then rebuild `txt_list_txt.dat` and the ROM:

  ```bash
  python tools/make_dev_team.py "2596 - Digimon World Championship (USA).nds" --name "TheGreatArthur" --hp 4980 --tp 516 --atk 516 --def 516 --wis 498 --spd 498
  python tools/txt_tool.py build text/txt_list_txt.json mod/ui/txt/txt_list_txt.dat
  ```

Species id = index of the name in `db_txt_list_txt` + 8 (Agumon = 0x22, Koromon = 0x15).

Then open `build/digimon_mod.nds` in an emulator. melonDS 1.1 is installed in
`%USERPROFILE%\emulators\melonDS-1.1`; from PowerShell:

```powershell
& "$env:USERPROFILE\emulators\melonDS-1.1\melonDS.exe" "build\digimon_mod.nds"
```

Text files (`ui/txt/`): `txt_list_txt` (game messages), `db_txt_list_txt` (Digimon database),
`mail_text_txt` (mails), `help_text_txt` (help), `tag` / `_tag` (button names).

In the JSON texts, keep these tokens as they are:

- `{esc:XXXX}` — control code, most likely a text colour (`0002` looks like the default colour)
- `[N]` — value inserted by the game (e.g. `[5]` appears to be the Digimon name)
- `\n` — line break

Whether the fonts (`common/font/*.NFTR`) contain accented characters such as `é` is not checked yet.

## Play in the browser (accounts + cloud saves)

`web/` is the site: account creation, login, the game in the browser (EmulatorJS 4.2.3,
melonDS core) and the game save stored on the server per account. Node >= 24, and `npm install`
in `web/` once. It runs locally as below, or online (see "Put the site online").

```bash
node web/server.js
```

Open http://127.0.0.1:3000, log in, play.

- Login is with Discord, through Supabase (`web/discord-auth.js`): one Discord account = one
  account = one save. Set it up once with `docs/discord_login.md` (Discord app, Supabase project,
  `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `web/.env`). Without them, or with `PASSWORD_LOGIN=1`,
  the old username + password form stays; an old account keeps its save by linking Discord
  ("Link Discord" in the play page's bar). With `PASSWORD_LOGIN=hidden` the page shows Discord
  only and the password form opens at `/?password` (test accounts). New accounts come only from
  Discord whenever Discord is set up.
- The play page has a side panel (`web/social.js`, `web/public/social.js`): a General chat, a
  private chat per friend, friend requests, and the ranked ladder with Discord avatars and names.
  On wide screens the game sits in the middle and the panel on its right.
- The gear in the play page's bar (`web/public/sound-settings.js`) sets the master volume and,
  per part of the game's sound, music, ambience, sound effects and menu sounds. It writes the
  volume of NitroSystem's four sound players in DS RAM (table 0x0210AD84, 0x24 per player,
  volume at +0x20). The battle music is streamed and follows only the master volume. Settings
  stay in the browser (localStorage).
- PvP coins (`web/shop.js`, tables `wallets` and `coin_log`): every online battle won against
  another player, ranked or in a private room, pays 5 coins. Against one same opponent only 5 wins
  a day pay (`COINS_WINS_PER_OPPONENT`), and a win the referee or an admin takes back takes its
  coins back.
- The play page's left panel (`web/public/hub.js`; left of the game on wide screens, under it on
  medium ones) has three tabs and the player's coins:
  - Shop (`web/shop.js`, `web/public/shop.js`, table `shop_items`): Digimon and items by category,
    as a short list; an offer opens with its sprite, its price and, for a Digimon, the stats it
    arrives with. Admins edit the catalogue on `/admin/shop`: add a Digimon (with bonus stats) or an
    item, set the price, a sale in % with an optional end date, a stock, the order, or hide it. A
    purchase takes the coins, counts the stock and queues a gift in one SQL statement; the play
    page brings it through the game's mail like an admin's gift.
  - Events (`web/events.js`, `web/public/events.js`, table `events`), run from `/admin/events`:
    a battle event ranks online wins between its start and end; a contest ranks the best Digimon
    handed over from the bank in one stat (or the total), one per player, optionally limited to a
    level or a species; a collection counts the Digimon handed over. At the end (or "End now") the
    places are paid their coins once; cancelling gives the Digimon handed over back.
  - Bank (`web/bank.js`, `web/public/bank.js`, tables `bank` and `trades`): a Digimon of the
    farm, already in the saved game, leaves the farm for the bank (its RAM record is turned off,
    so the game stops saving it). It is stored once a save shows it gone; a save that still has it
    undoes the deposit, so a Digimon never exists twice. Withdrawing brings it back by mail with its
    exact stats. Players trade by offering one of theirs for another player's Digimon, directly or
    from the public board; accepting swaps the owners in one statement. Its sprite stays on the
    farm until the farm is drawn again, and the deposit completes at the game's end-of-day save.

- Speed: the melonDS core (WebAssembly, no JIT) takes about 15 ms of the 16.7 ms of a frame on
  this PC, even on a quiet screen (91 % of the time in the core, under 1 % in the page's own
  scripts). A heavier scene drops below 60 fps: the picture stutters and the music slows. `/play`
  is served cross-origin isolated (COOP/COEP) so EmulatorJS loads the threaded melonDS core
  (`EJS_threads`) with the DS's 3D drawn on its own thread (`melonds_threaded_renderer`); a browser
  without isolation falls back to the plain core.

- The site serves no ROM. Each player gives their own original ROM to the play page once
  (`web/public/rom.js`): the page checks it is the USA game (SHA-256; a trimmed copy is fine),
  keeps it in the browser (IndexedDB, never uploaded) and applies the mod's patch
  `web/public/mod.patch` to it at every start, so an updated mod needs no new import. After every
  rebuild of the mod, write the patch and the game's tables again:

  ```bash
  python tools/make_web_patch.py "2596 - Digimon World Championship (USA).nds" build/digimon_mod.nds
  node web/game-data.js
  ```

  The patch holds only the bytes that differ, XORed with the original's. `web/game-data.json` has
  the tables the server reads from the ROM (species, stat curves, digivolutions, items, mails,
  cages): a server without a ROM (`ROM_PATH`, default `build/digimon_mod.nds`) loads that file
  instead. Only the referee, a browser on the server's own machine, gets the ROM from the server.
- Accounts, sessions, saves and everything else live in the Supabase Postgres database (schema
  `game`, `web/db/schema.sql`), reached through `DATABASE_URL` in `web/.env` (`web/db.js`, needs
  `npm install` in `web/` once). See `docs/supabase_database.md`. Passwords are hashed (scrypt).
- A new account first watches the story intro, once (`/story`, `web/public/story.js`; the end or
  "Passer l'intro" sets `users.story_seen_at`, then `/starter` opens). On the two DS screens,
  in English and with the game's graphics: the stadium and logo, two Rookies sparring, the King
  of Digimon "TheGreatArthur" and his team (Apollomon, Dianamon, Machinedramon) appearing, then a
  battle demo of the Championship final against WarGreymon, MetalGarurumon and Gallantmon (game
  battle ground, attack / hit / K.O. / victory animations, the battle's VS bottom screen and
  timer), and the DigiEgg. The text types in the game's message window; a click or Enter goes
  on. The pages are `STORY` in `story.js`. Export its graphics once:

  ```bash
  python tools/export_story_assets.py extracted
  ```
- Then the account lands on `/starter`, drawn like the game's two screens with its own
  graphics and fonts: the 12 Baby I Digimon stand on a turning ring (slide, tap or ←/→), and the
  game's message window asks "OK?" then Yes / No. The pick sets the species the DigiEgg hatches
  into (save offset `0x1EA`).
  The server then builds the account's save from `web/starter/starter.raw` (decoded game data,
  account name written as tamer name): it resumes at "Please name your DigiEgg", with the egg and
  the gifted Agumon. The game clock hatches the egg seconds after the training screen opens, so
  the save cannot start later than that prompt.
- The page's graphics and fonts come from the ROM. Export them once, from an extracted ROM, into
  `web/game-assets/` (served to logged-in users only):

  ```bash
  python tools/export_starter_assets.py extracted
  ```
- The intro / login page ("Online Arena") and the play page are drawn with the game's graphics too:
  its logo (cut out along its gold rim and dark outline) over a battle as the game shows it
  (`web/public/intro.js`): two teams of Rookies from famous duos (Agumon/Gabumon, Guilmon/Renamon,
  Patamon/Salamon…) roam one of the game's battle grounds, run at each other, strike up close or
  fire shots in each one's colour, flash white and stagger when hit, get knocked down and get back
  up. No HP bars: the brawl goes on, the camera follows it, and the ground and teams change every
  30 seconds. The moves are the sprites' own animations (stand, run, hit, knocked, the four
  attacks, down, win).
  The starter page uses the play page's bar and frame.
  Export them once more into `web/game-assets/intro/` and `web/game-assets/site/`. The intro shows
  before login, so `intro/` is the only part of `game-assets/` served without an account:

  ```bash
  python tools/export_site_assets.py extracted
  ```
- The admin pages show each Digimon, item and medal with its sprite. Export them once into
  `web/game-assets/admin/` (a ROM with the game's items table, here the modded one):

  ```bash
  python tools/export_admin_assets.py extracted build/digimon_mod.nds
  ```
- The save is restored when the game starts, uploaded every 15 s when it changed, when the tab is
  hidden and on logout.
- Online battles are played from the game itself: Battle → Multi Battle opens the "Online Arena"
  menu (it replaces the Nintendo WFC menu; Friend Roster, Wi-Fi settings and DS Wireless
  Communications are gone):
  - Create Room shows a 6-digit room code (on the old "Display Friend Code" screen) and waits;
  - Join Room takes that code on the game's keypad (a code that is not 6 digits is refused); the
    keypad hides its unused letter keys, whose drawing slowed the browser's emulator to ~36 fps;
  - Ranked Match looks for a random opponent (Elo).
  Return cancels. Both players then pick their Digimon (In-Training II or higher) and press
  Battle. The play page has no match panel: it only relays. `patches/online_mailbox.json` (`tools/make_online_patch.py`) rewires the
  menu, posts the player's choice to a RAM mailbox (command, room code, a code offered by the
  page) and routes the game's Multi Battle packets to it; the page relays them through the
  server (`web/online.js`, `web/public/online.js`). The server gives each match a seed that
  both games load right before the battle, so both compute the same battle.
  When the server refuses (unknown room, ranked ban, server out of reach...), the game's error
  screen says why (texts 1415-1423, chosen by the page from the server's `reason`), and the
  battle's banner reads "Online Arena" instead of "Multi Battle".
  The menu's banner and labels come from `tools/make_online_menu_art.py` (letters cut out of the
  game's own graphics, written to `mod/`), and its texts are in `text/txt_list_txt.json`
  (1378, 1379, 1386, 1396, 1400, 1415-1423) and `text/help_text_txt.json` (157):

  ```bash
  python tools/make_online_menu_art.py extracted mod
  python tools/make_online_patch.py "2596 - Digimon World Championship (USA).nds"
  python tools/txt_tool.py build text/txt_list_txt.json mod/ui/txt/txt_list_txt.dat
  python tools/txt_tool.py build text/help_text_txt.json mod/ui/txt/help_text_txt.dat
  ```
  Each page reads the outcome in the game and reports it (`online_matches`, `ratings` tables).
  Anti-cheat rules (see `docs/anti_cheat_strategy.md`): the server enforces the packet order,
  gives the seed only when the teams are exchanged, settles a reported defeat at once, needs the
  opponent's confirmation for a win, counts leaving during the battle (or no result within
  10 min, `ONLINE_BATTLE_LIMIT_MS`) as a forfeit, logs every match (`online_match_events`) and
  incident (`online_incidents`), and rate limits the online API.
  Saves are checked too (`web/save-check.js`). Each upload is compared with the previous one
  (`save_history`): species, digivolutions from the game's table, and stat gains against the
  time elapsed. A save that breaks the rules is kept but bars the account from ranked play
  (`save_flags`). In ranked play, each Digimon the game sends must be one of the player's saved
  Digimon, unchanged, or the match is cancelled.
  A referee replays disputed ranked matches, a 5 % sample (`REFEREE_SAMPLE`), and any ranked
  match with a Digimon it has not seen yet, once from each side (`web/referee.js`). Each replay
  runs in headless Edge, driven by `web/referee/worker.py` (needs Python, Playwright and Edge;
  `REFEREE=off` leaves the jobs queued). The replay uses the saves kept at battle start, the
  journal's packets and the match seed. A side that relayed a doctored team loses, and so does one
  that reported the wrong result. A changed result has its Elo corrected. The referee also learns
  the full record the game sends for each saved Digimon (`known_records`), and relayed Digimon are
  then checked byte for byte.
  Ranked play is closed to banned accounts, flagged saves and accounts younger than 24 h
  (`RANKED_MIN_AGE_HOURS`). The search pairs the closest ratings (a window that widens while
  players wait). It never pairs two accounts of one browser (`device` cookie) or of one
  non-local IP, and the same two accounts at most 5 times a day (`RANKED_DAILY_PAIR`). Incidents
  add up to a trust score (`web/sanctions.js`): at 30 points (`RANKED_BAN_POINTS`) the account is
  suspended from ranked play and its rating goes back to 1000. The moderators' page `/admin`
  (accounts listed in `ADMIN_USERS`, default `admin`) shows scores, suspicious pairs, flagged
  matches and referee jobs. From it, an admin can ban or unban an account, clear a save flag,
  cancel an account's ranked wins (Elo given back) and rerun the referee.
- Admin pages for players and gifts, styled by `web/public/admin.css` (`DESIGN.md`; analysis in
  `docs/mail_and_save_analysis.md`):
  - `/admin/players` (refreshed every 5 s) lists every account, online ones first: whether it is
    playing right now (the play page reports every 5 s, `web/presence.js`), its team's sprites,
    rank, bits, medals, Elo and pending gifts. A row opens the account's page.
  - `/admin/player?id=N` shows the whole save (`web/save-info.js`): Digimon with sprite, stats and
    AP, bits, rank, Digipedia, play time, in-game date, care items, the cages placed on the farm
    with their occupants, and the 61 medals. It also sends the account a gift: an online player
    gets the mail within seconds once on the farm, an offline one the next time it plays.
  - `/admin/gifts` does the same for any player and keeps a history of all gifts, where a pending
    gift can be cancelled (`web/gifts.js`). A gift is bits, an item with a quantity, one of the
    game's gift mails, or a Digimon with bonus stats: the editor shows base + bonus = total for
    each stat. After the mail closes, the play page adds the bonus to the new Digimon in RAM.
    The save check accepts those stats once (`web/save-check.js`).
  - The gift arrives in the game as a mail from the Digital Arena, the next time the player is
    on the farm with the play page open (`web/public/gifts.js`). It is marked delivered when the
    mail is opened.

### Put the site online

`render.yaml` describes the site as one free web service on Render (render.com), with the same
Supabase database. No ROM goes online: `.gitignore` keeps ROMs, saves, `build/`, `mod/` and
`web/.env` out of the repository.

1. Push this folder to a private GitHub repository.
2. On Render: New > Blueprint, pick the repository. Type the values of `web/.env` for
   `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `ADMIN_DISCORD_IDS`, and the site's
   address (`https://<name>.onrender.com`) for `SITE_URL`.
3. In Supabase, Authentication > URL Configuration: add `https://<name>.onrender.com/auth/callback`
   to the Redirect URLs (`docs/discord_login.md`).

The free service sleeps after about 15 minutes without a visit; the next visit wakes it up in
about a minute. The host runs with `REFEREE=off`: referee jobs stay queued in the database, and a
local server (which has the ROM, Python and Edge) on the same database replays them.
`.claude/launch.json` has `digimon-web-hosted` to try the hosted setup locally (no ROM, port 3001).

Save format (`tools/save_tool.py decode|encode`): "DIGICHMP" header, then one record holding an
NBLC block (CRC32, 32 KB chunks, each LZ10 or stored, then Burrows-Wheeler transformed).

## Other files

Extract every file of the ROM:

```bash
python tools/nds_tool.py extract "2596 - Digimon World Championship (USA).nds" extracted
```

Any extracted file (graphics `.ncgr`/`.nclr`, sound `sound_data.sdat`, …) can be edited with a
dedicated tool and dropped into `mod/` under the same path; `repack` puts it back.
A file that still fits in its original slot is written in place, a bigger one is moved to the
free space at the end of the ROM. Code changes only come from `patches/*.json` (uncompressed
ARM9 and overlays); ARM7 and the secure area are never modified.
