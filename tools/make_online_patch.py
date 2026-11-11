"""Build patches/online_mailbox.json: the game's Multi Battle becomes an Online Arena run by the web page.

  python tools/make_online_patch.py <rom.nds>

Multi Battle exchanges 128-byte packets through a small transport layer in overlay 9 (send, is
received, clear, peer count, disconnected). This patch rewires that layer to a mailbox in RAM, and
skips the DS Wireless (WH) set-up of the host scene ("Accepting challenges"). The web page
(web/public/online.js) relays the packets through the server. Both players pick the host scene;
the server tells each page its role, and the game takes it once the peer is connected.

Mailbox at 0x02179C60 (dead code of the skipped WH init, reloaded with overlay 9):
  +0x00 "WEBMBOX1"   magic the page looks for
  +0x08 role         page writes 1 = host, 2 = guest; copied to 0x02112D5C on connection
  +0x0C out state    game sets 1 when its send buffer (0x0219A340) holds a packet; page sets 2 once
                     relayed, and the game's next send call then completes
  +0x10 in state     page writes a packet into the receive buffer (0x0219A3C0) then sets 1; the
                     game clears it when it has read the packet
  +0x14 connected    page sets 1 when the opponent is there
  +0x18 disconnected page sets 1 when the opponent left
  +0x1C seen         game sets 1 when it saw the packet; a clear only drops a packet it saw (the
                     exchange's start clears the receive flag, and the opponent may be faster)
  +0x20 seed         page writes the match's seed (from the server); once the teams are exchanged,
                     right before the battle loads, both games reseed their random generator
                     (ARM9 0x020426C8) with it, so both DS compute the same battle
  +0x24 command      game writes (sequence << 8) | kind, the sequence going up by one per command:
                     1 create a room, 2 join a room, 3 ranked match, 4 cancel (back on the menu)
  +0x28 code         the room code (6 digits) of the last create or join
  +0x2C offer        page writes a fresh 6-digit code; Create Room takes it (and clears it)
  +0x30 message      page writes the text id (txt_list) of the error screen before it sets
                     disconnected (a refusal, the server out of reach...); 0 = "A communication error
                     has occurred." (1411). The error screen takes it and clears it.

The menu (overlay 9's net scene, a state machine of 48 states: functions at 0x021918F0, menu
descriptors at 0x02191EF0) skips the mode select and opens on the Nintendo Wi-Fi Connection
screen, redrawn as the Online Arena (tools/make_online_menu_art.py):
  Create Room   -> the Display Friend Code screen shows the room code until the opponent is there
  Join Room     -> the Enter Code keypad takes the 6 digits -> wait for the opponent
  Ranked Match  -> wait for the opponent
Waiting is the DS Wireless host scene ("Accept Challenge", state 38). Back on the menu, the game
posts "cancel". The Nintendo WFC, Friend Manager and DS Wireless menus can no longer be reached.
The keypad (ui/keyboard.nxr, 128 parts the game draws as 3D quads every frame) only shows the digit,
Del, arrow and Ent keys: the blank letter keys are hidden while it is open. Drawing them all slows
the browser's emulator (melonDS in WebAssembly) from 60 to about 36 frames a second. The picture of
the keys that make_keyboard_mod.py adds (part 128) is hidden too, and the keys unmarked, so the
keypad's keys are drawn one by one again.
Needs keystone-engine (pip install keystone-engine).
"""
import json
import os
import struct
import sys

from keystone import KS_ARCH_ARM, KS_MODE_ARM, Ks

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nds_tool import code_region  # noqa: E402

OVERLAY = 9
MAILBOX = 0x02179C60
ROLE = 0x02112D5C
SEED_HOOK = 0x02179C94   # after the mailbox, still in the dead WH init code (up to 0x02179D64)
RNG_SEED = 0x020426C8
WH_END = 0x0217A114
EXCHANGE_END_CALL = 0x02184788   # team exchange, last step: "bl WH end", then the battle scene
HOOKS = 0x02179CD0       # after the seed hook, still in the dead WH init code (up to 0x02179D48)
CODES = 0x021798B0       # DWC "add a Friend Code" (216 bytes), only called by the code keypad
GET_FRIEND_CODE = 0x02179850   # DWC "my Friend Code", only called by the Display Friend Code screen
STATES = 0x021918F0      # 48 states x 4 x (function, flag): update, enter, exit, draw
MENUS = 0x02191EF0       # 48 states x 11 words: back, text, 3 x (next state, label, help text)
MENU_ENTER = 0x02180250  # state 3 (Nintendo Wi-Fi Connection, now the Online Arena), enter
WAIT_ENTER = 0x02182ED4  # state 38 (DS Wireless host, waiting for the opponent), enter
NEXT_STATE = 0x0217D15C  # (scene, button) -> the descriptor's next state for that button
CODE_UPDATE = 0x02181FBC   # state 23 (Display Friend Code), update
CODE_HOOK = 0x02179D6C   # dead end of WH start parent (patched to return at once), up to 0x02179DDC
KEYS_SET = GET_FRIEND_CODE + 4   # the rest of "my Friend Code" (92 bytes), up to 0x021798AC
KEYPAD_HOOKS = 0x0217CE68  # dead end of the disconnected test (patched to 4 lines), up to 0x0217CEBC
KEYPAD_ENTER = 0x021824A8  # state 25 (Enter Code keypad), enter
KEYPAD_EXIT = 0x02182558   # state 25, exit
# The keyboard (scene + 0xDD4) holds its layout at +0x34, whose first word is the array of parts
# (0x114 bytes each, +0xFC = drawn). The keypad hides the parts of keyboard.nxr in these ranges:
# the Shift, Kana, Alpha, Hira and Space keys with their labels, and the letter keys (all but
# key27-key36, the digits).
HIDDEN_KEYS = [(0, 2), (53, 54), (74, 89), (100, 124), (126, 127)]
ERROR_TEXT = 0x02180EA0  # error screen (state 17, enter), mode 2: its text, "ldr r3, =0x583" (1411)
KEYS_MARK = 0x02179E6C  # dead end of WH wait for a child (patched to 11 lines), up to 0x02179EA4
FIRST_KEY, BOARD = 71, 128   # make_keyboard_mod.py: the keys (71-127, marked) and their picture
CREATE, JOIN, RANKED, CANCEL = 1, 2, 3, 4
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "patches", "online_mailbox.json")

LOAD_MAILBOX = f"ldr r1, mb\n"
POOL = f"mb: .word {MAILBOX:#x}\n"

FUNCTIONS = [
    (0x02179C50, "WH init (host scene step 0): done at once",
     "mov r0, #1\nbx lr\nnop\nnop\n"),
    (0x02179D64, "WH start parent (host scene step 1): done at once",
     "mov r0, #1\nbx lr\n"),
    (0x02179E40, "WH wait for a child (host scene step 2): done once the page says the peer is "
                 "connected; take the role (1 host, 2 guest) the page wrote",
     LOAD_MAILBOX + "ldr r0, [r1, #0x14]\ncmp r0, #0\nbxeq lr\nldr r2, [r1, #8]\nldr r3, role\n"
     "str r2, [r3]\nmov r0, #1\nbx lr\n" + POOL + f"role: .word {ROLE:#x}\n"),
    (0x0217CD34, "NetSend: post the packet (out = 1), complete once the page relayed it (out = 2)",
     LOAD_MAILBOX + "ldr r0, [r1, #0xc]\ncmp r0, #2\nmoveq r0, #0\nstreq r0, [r1, #0xc]\nmoveq r0, #1\n"
     "bxeq lr\nmov r0, #1\nstr r0, [r1, #0xc]\nmov r0, #0\nbx lr\n" + POOL),
    (0x0217CD8C, "NetClearRecv: in = 0, only once the game saw the packet",
     LOAD_MAILBOX + "ldr r0, [r1, #0x1c]\ncmp r0, #0\nmovne r0, #0\nstrne r0, [r1, #0x10]\n"
     "strne r0, [r1, #0x1c]\nbx lr\n" + POOL),
    (0x0217CDB8, "NetIsReceived: return in, and note the game saw it",
     LOAD_MAILBOX + "ldr r0, [r1, #0x10]\ncmp r0, #0\nmovne r2, #1\nstrne r2, [r1, #0x1c]\nbx lr\n" + POOL),
    (0x0217CE10, "peer count: 1 + connected",
     LOAD_MAILBOX + "ldr r0, [r1, #0x14]\nadd r0, r0, #1\nbx lr\n" + POOL),
    (0x0217CE58, "disconnected test: return disconnected",
     LOAD_MAILBOX + "ldr r0, [r1, #0x18]\nbx lr\n" + POOL),
    (0x0217CEC4, "second disconnected test (WH error states): return disconnected",
     LOAD_MAILBOX + "ldr r0, [r1, #0x18]\nbx lr\n" + POOL),
    (SEED_HOOK, "end of the team exchange: WH end, then reseed the random generator with the seed",
     f"push {{r4, lr}}\nbl {WH_END:#x}\nmov r4, r0\ncmp r4, #1\nbne done\n" + LOAD_MAILBOX
     + f"ldr r0, [r1, #0x20]\ncmp r0, #0\nblne {RNG_SEED:#x}\ndone: mov r0, r4\npop {{r4, pc}}\n" + POOL),
    (EXCHANGE_END_CALL, "team exchange, last step: call the seed hook instead of WH end",
     f"bl {SEED_HOOK:#x}\n"),
]
MAILBOX_INIT = b"WEBMBOX1" + struct.pack("<11I", 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)

# One instruction per line, so a label's address is its block's start + 4 x the lines before it.
POST_CODE = ("ldr r1, mb\nldr r2, [r1, #0x24]\nadd r2, r2, #0x100\nbic r2, r2, #0xff\norr r2, r2, r0\n"
             "str r2, [r1, #0x24]\nbx lr\n")
MENU_CODE = f"push {{r0, lr}}\nmov r0, #{CANCEL}\nbl {HOOKS:#x}\npop {{r0, lr}}\nb {MENU_ENTER:#x}\n"
# Waiting, and the last command is the menu's cancel (no create or join just before): ranked.
WAIT_CODE = (f"ldr r1, mb\nldrb r2, [r1, #0x24]\ncmp r2, #{CANCEL}\nbne {WAIT_ENTER:#x}\n"
             f"push {{r0, lr}}\nmov r0, #{RANKED}\nbl {HOOKS:#x}\npop {{r0, lr}}\nb {WAIT_ENTER:#x}\n")
MENU_HOOK = HOOKS + 4 * POST_CODE.count("\n")
WAIT_HOOK = MENU_HOOK + 4 * MENU_CODE.count("\n")
# Join (r1 = the typed code in ASCII): exactly 6 digits -> code, post join, 1; else 0 (invalid).
JOIN_CODE = ("mov r3, #0\nmov ip, #0\n"
             "next: ldrb r2, [r1], #1\ncmp r2, #0\nbeq end\nsub r2, r2, #0x30\ncmp r2, #9\nmovhi r0, #0\n"
             "bxhi lr\nadd r3, r3, r3, lsl #2\nadd r3, r2, r3, lsl #1\nadd ip, ip, #1\nb next\n"
             "end: cmp ip, #6\nmovne r0, #0\nbxne lr\nldr r1, mb\nstr r3, [r1, #0x28]\n"
             f"push {{lr}}\nmov r0, #{JOIN}\nbl {HOOKS:#x}\nmov r0, #1\npop {{pc}}\n")
# Create (r1 = the screen's 14-byte buffer): the page's offer becomes the room code, written as
# 6 ASCII digits; no offer (page not there) -> 0, the screen says so.
CREATE_CODE = ("ldr r2, mb\nldr r3, [r2, #0x2c]\ncmp r3, #0\nmoveq r0, #0\nbxeq lr\nstr r3, [r2, #0x28]\n"
               "mov r0, #0\nstr r0, [r2, #0x2c]\nstrb r0, [r1, #6]!\nmov ip, #6\n"
               "digit: ldr r2, tenth\numull r0, r2, r3, r2\nmov r2, r2, lsr #3\nadd r0, r2, r2, lsl #2\n"
               "sub r0, r3, r0, lsl #1\nadd r0, r0, #0x30\nstrb r0, [r1, #-1]!\nmov r3, r2\nsubs ip, ip, #1\n"
               f"bne digit\npush {{lr}}\nmov r0, #{CREATE}\nbl {HOOKS:#x}\nmov r0, #1\npop {{pc}}\n")
CREATE_HOOK = CODES + 4 * JOIN_CODE.count("\n")
# r0 = scene, r1 = 0 (hide) or 1 (show): the keyboard parts of HIDDEN_KEYS.
KEYS_SET_CODE = ("push {r4, r5}\nadd r0, r0, #0xd00\nldr r0, [r0, #0x108]\nadr r2, ranges\nmov r5, #0x114\n"
                 "range: ldrb r3, [r2], #1\ncmp r3, #0xff\nbeq done\nldrb ip, [r2], #1\n"
                 "part: mla r4, r3, r5, r0\nstrb r1, [r4, #0xfc]\nadd r3, r3, #1\ncmp r3, ip\nble part\nb range\n"
                 f"done: b {KEYS_MARK:#x}\nranges: .byte "
                 + ", ".join(f"{a}, {b}" for a, b in HIDDEN_KEYS) + ", 0xff\n")
# Then (r4 = part 128, the board, after the loop): the keys' depth mark (-0x10001, drawn by the
# board at rest) when shown, plain -0x10000 (drawn one by one) when hidden; the board shown or not.
KEYS_MARK_CODE = (f"mov r3, #{FIRST_KEY}\nmla r4, r3, r5, r0\nmvn r2, #0\nmov r2, r2, lsl #16\nsub r2, r2, r1\n"
                  f"mark: str r2, [r4, #8]\nadd r4, r4, r5\nadd r3, r3, #1\ncmp r3, #{BOARD}\nblt mark\n"
                  "strb r1, [r4, #0xfc]\npop {r4, r5}\nbx lr\n")
# Enter: the original enter, then hide (its result kept); exit: show, then the original exit.
KEYPAD_CODE = (f"push {{r4, lr}}\nmov r4, r0\nbl {KEYPAD_ENTER:#x}\npush {{r0}}\nmov r0, r4\nmov r1, #0\n"
               f"bl {KEYS_SET:#x}\npop {{r0}}\npop {{r4, pc}}\n"
               f"push {{r4, lr}}\nmov r4, r0\nmov r1, #1\nbl {KEYS_SET:#x}\nmov r0, r4\npop {{r4, lr}}\n"
               f"b {KEYPAD_EXIT:#x}\n")
KEYPAD_ENTER_HOOK = KEYPAD_HOOKS
KEYPAD_EXIT_HOOK = KEYPAD_HOOKS + 4 * 9
# The room code screen has no OK button: once the page says the opponent is there, go on to the
# wait (the descriptor's next state, done at once). Disconnected (refused by the server): the wait
# too, which sets the transport to DS Wireless and so goes on to the error screen (state 17) that
# shows the page's message; this screen's transport is still the Wi-Fi Connection's, whose error
# screen shows a DWC error instead.
CODE_SCREEN_CODE = ("push {r4, lr}\nmov r4, r0\nldr r1, mb\nldr r2, [r1, #0x18]\ncmp r2, #0\nbne next\n"
                    "ldr r2, [r1, #0x14]\ncmp r2, #0\nbeq screen\nnext: mov r0, r4\nmov r1, #0\n"
                    f"bl {NEXT_STATE:#x}\npop {{r4, pc}}\n"
                    f"screen: mov r0, r4\npop {{r4, lr}}\nb {CODE_UPDATE:#x}\n")
# The error screen's text (r3; r0 is free, r1 and r2 are kept): the page's message, then cleared.
MESSAGE_CODE = ("ldr ip, mb\nldr r3, [ip, #0x30]\nmov r0, #0\nstr r0, [ip, #0x30]\ncmp r3, #0\n"
                "ldreq r3, default\nbx lr\n")
MESSAGE_HOOK = CODE_HOOK + 4 * CODE_SCREEN_CODE.count("\n")


def menu(back, text, *buttons):
    """A menu descriptor: back state, text id, then up to 3 (next state, label) buttons."""
    words = [back, text]
    for i in range(3):
        nxt, label = buttons[i] if i < len(buttons) else (-1, -1)
        words += [nxt, label, -1]
    return struct.pack("<11i", *words)


ARENA = [
    (HOOKS, "command post (r0 = kind); Online Arena enter: post cancel; wait enter: post ranked unless "
            "a create or join came first", POST_CODE + MENU_CODE + WAIT_CODE + POOL),
    (CODES, "join: the keypad's 6 digits become the room code; create: the page's offer becomes the "
            "room code", JOIN_CODE + CREATE_CODE + POOL + "tenth: .word 0xcccccccd\n"),
    (GET_FRIEND_CODE, "my Friend Code: the room code instead (create)", f"b {CREATE_HOOK:#x}\n"),
    (CODE_HOOK, "room code screen, update: on to the wait once the opponent is there; error screen text: "
                "the page's message", CODE_SCREEN_CODE + MESSAGE_CODE + POOL + "default: .word 0x583\n"),
    (ERROR_TEXT, "error screen, text: the page's message (the hook above)", f"bl {MESSAGE_HOOK:#x}\n"),
    (KEYS_SET, "keypad: hide (r1 = 0) or show (r1 = 1) the keyboard's unused keys", KEYS_SET_CODE),
    (KEYS_MARK, "keypad: the keys drawn one by one (r1 = 0) or by their picture (r1 = 1)", KEYS_MARK_CODE),
    (KEYPAD_HOOKS, "keypad enter: hide the unused keys; exit: show them again", KEYPAD_CODE),
]
DATA = [
    (MENUS + 1 * 44 + 8, "state 1 (loading) opens the Online Arena (state 3), not the mode select",
     struct.pack("<i", 3)),
    (MENUS + 3 * 44, "Online Arena: back leaves the scene (43); Create Room (label 0) -> Display Friend "
                     "Code (23), Join Room (label 1) -> Enter Code (25), Ranked Match (label 17) -> wait (38)",
     menu(43, 1367, (23, 0), (25, 1), (38, 17))),
    (MENUS + 16 * 44, "after cancelling the wait: back to the Online Arena", menu(3, -1, (3, -1))),
    (MENUS + 23 * 44, "Display Friend Code (the room code): opponent there -> wait (38), back -> menu",
     menu(3, 1378, (38, -1))),
    (MENUS + 25 * 44, "Enter Code: a valid code -> wait (38), back -> Online Arena", menu(3, 1379, (38, -1))),
    (STATES + 3 * 32 + 8, "Online Arena, enter: post cancel first", struct.pack("<I", MENU_HOOK)),
    (STATES + 23 * 32, "room code screen, update: the hook above", struct.pack("<I", CODE_HOOK)),
    (STATES + 38 * 32 + 8, "wait for the opponent, enter: post ranked unless a create or join came first",
     struct.pack("<I", WAIT_HOOK)),
    (STATES + 25 * 32 + 8, "Enter Code keypad, enter: the hook above", struct.pack("<I", KEYPAD_ENTER_HOOK)),
    (STATES + 25 * 32 + 16, "Enter Code keypad, exit: the hook above", struct.pack("<I", KEYPAD_EXIT_HOOK)),
]
# Overlay 19 (battle): the title the battle opens with, by mode (G+0xCE0), a sequence of the cells of
# ui/battle_title_obj_sub. Multi Battle (mode 3, only online now) shows sequence 2, frame 3
# ("Multi Battle"); sequence 3, frame 0 is cell 78, "Online Arena" in mod/ui/battle_title_obj_sub.ncgr.
BATTLE = 19
TITLE = [
    (0x02114194, "battle title, Multi Battle: sequence 3 (Online Arena), not 2", "mov r1, #3\n"),
    (0x02114198, "battle title, Multi Battle: frame 0 of the sequence, not 3", "mov r2, #0\n"),
]


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    rom = open(sys.argv[1], "rb").read()
    regions = {ov: code_region(rom, ov) for ov in (OVERLAY, BATTLE)}

    def original(addr, size, overlay=OVERLAY):
        start, ram, _ = regions[overlay]
        return rom[start + addr - ram:start + addr - ram + size].hex()

    ks = Ks(KS_ARCH_ARM, KS_MODE_ARM)
    patches = []
    code = {addr: bytes(ks.asm(asm, addr)[0]) for addr, _, asm in FUNCTIONS + ARENA}
    assert SEED_HOOK + len(code[SEED_HOOK]) <= HOOKS and HOOKS + len(code[HOOKS]) <= 0x02179D48, \
        "the hooks overflow the dead WH init code"
    assert CODE_HOOK + len(code[CODE_HOOK]) <= 0x02179DDC, "the code screen hooks overflow WH start parent"
    assert len(code[CODES]) <= 216, "join and create overflow the DWC add-friend function"
    assert KEYS_SET + len(code[KEYS_SET]) <= 0x021798AC, "the key hiding overflows the DWC my-code function"
    assert KEYPAD_HOOKS + len(code[KEYPAD_HOOKS]) <= 0x0217CEBC, "the keypad hooks overflow the test"
    assert KEYS_MARK + len(code[KEYS_MARK]) <= 0x02179EA4, "the key marks overflow WH wait for a child"
    assert KEYPAD_CODE.count("\n") == 16, "KEYPAD_EXIT_HOOK expects 9 + 7 lines"
    for addr, comment, _ in FUNCTIONS + ARENA:
        patches.append({"overlay": OVERLAY, "address": f"{addr:#010x}", "original": original(addr, len(code[addr])),
                        "replacement": code[addr].hex(), "comment": comment})
    for addr, comment, asm in TITLE:
        data = bytes(ks.asm(asm, addr)[0])
        patches.append({"overlay": BATTLE, "address": f"{addr:#010x}", "original": original(addr, 4, BATTLE),
                        "replacement": data.hex(), "comment": comment})
    for addr, comment, data in DATA:
        patches.append({"overlay": OVERLAY, "address": f"{addr:#010x}", "original": original(addr, len(data)),
                        "replacement": data.hex(), "comment": comment})
    patches.append({"overlay": OVERLAY, "address": f"{MAILBOX:#010x}",
                    "original": original(MAILBOX, len(MAILBOX_INIT)), "replacement": MAILBOX_INIT.hex(),
                    "comment": "mailbox: magic, role = 1, out, in, connected, disconnected, seen, seed, "
                               "command, code, offer, message = 0"})
    doc = {"description": __doc__.split("\n\n")[0] + " " + " ".join(__doc__.split("\n\n")[1].split()),
           "patches": patches}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    print("%d patches -> %s" % (len(patches), os.path.abspath(OUT)))


if __name__ == "__main__":
    main()
