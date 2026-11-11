"""Referee worker: replays one side of an online match in headless Edge (web/referee.js).

  python worker.py <site url> <match id> <host|guest>     (REFEREE_TOKEN in the environment)

Opens the site's /referee page, which loads the side's save, the opponent's recorded packets and
the match's seed (web/public/referee.js), then goes through the game's menus with the touch screen
to Battle > Multi Battle > DS Wireless Communications > Accept Challenge, picks a Digimon so the
Battle button works, has the page put the recorded team in place and presses Battle. The page
posts the verdict itself; the worker exits once it is done, or fails after a time limit.
Needs Playwright for Python and Microsoft Edge.
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

SITE, MATCH, SIDE = sys.argv[1], sys.argv[2], sys.argv[3]
BATTLE_TIMEOUT_S = 10 * 60

# Touch screen steps (bottom screen pixels, then seconds to wait), from the save's training screen.
BOOT = [((128, 94), 2), ((34, 108), 0.4), ((239, 145), 25)]
TO_MULTI_BATTLE = [((220, 181), 1.5), ((83, 146), 2.5), ("swipe", 1.2), ("swipe", 1.5), ((124, 60), 1.5),
                   ((124, 60), 6), ((128, 114), 3.5), ((128, 114), 10)]   # DS Wireless, Accept Challenge
PICK_DIGIMON = [((48, 128), 2), ((44, 84), 2), ((78, 70), 1), ((203, 95), 2.5), ((207, 177), 2.5)]
BATTLE = (128, 177)


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True,
                                     args=["--autoplay-policy=no-user-gesture-required"])
        context = browser.new_context(viewport={"width": 700, "height": 1100})
        context.add_cookies([{"name": "referee", "value": os.environ["REFEREE_TOKEN"], "url": SITE}])
        page = context.new_page()
        page.goto(f"{SITE}/referee?match={MATCH}&side={SIDE}")
        page.wait_for_function("window.referee && window.referee.ready", timeout=180_000)

        def point(x, y):
            box = page.locator("#game canvas").bounding_box()
            return box["x"] + x * box["width"] / 256, box["y"] + (192 + y) * box["height"] / 384

        def run(steps):
            for step, wait in steps:
                if step == "swipe":
                    page.mouse.move(*point(160, 80))
                    page.mouse.down()
                    for i in range(1, 11):
                        page.mouse.move(*point(160 - 10 * i, 80))
                        time.sleep(0.03)
                    page.mouse.up()
                else:
                    page.mouse.move(*point(*step))
                    page.mouse.down()
                    time.sleep(0.12)
                    page.mouse.up()
                time.sleep(wait)

        time.sleep(25)
        run(BOOT + TO_MULTI_BATTLE + PICK_DIGIMON)
        print(f"referee {MATCH} {SIDE}: team {page.evaluate('window.referee.setTeam()')}", flush=True)
        run([(BATTLE, 1)])
        deadline = time.time() + BATTLE_TIMEOUT_S
        while time.time() < deadline:
            state = page.evaluate("({ phase: window.referee.phase, done: window.referee.done, error: window.referee.error })")
            if state["done"] or state["error"]:
                print(f"referee {MATCH} {SIDE}: {state}", flush=True)
                break
            time.sleep(1)
        else:
            print(f"referee {MATCH} {SIDE}: no result in time ({state['phase']})", flush=True)
        browser.close()


main()
