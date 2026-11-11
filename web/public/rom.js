// The player's own ROM. The site serves no ROM: the player gives their original game file once.
// It stays in this browser (IndexedDB) and is never uploaded. The mod's patch (/static/mod.patch,
// tools/make_web_patch.py) is applied to it here at every start, so a new version of the mod
// needs no new import.
const MAGIC = "DWCPATCH";
const WRONG_FILE = "This is not the expected file. It must be an unmodified copy of Digimon World Championship (USA): a .nds file, 64 MB or less.";

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

async function loadPatch() {
  const res = await fetch("/static/mod.patch");
  if (!res.ok) throw new Error(`GET /static/mod.patch ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer()), view = new DataView(bytes.buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC || view.getUint32(8, true) !== 1) {
    throw new Error("unknown patch format");
  }
  const records = [];
  let at = 84;
  for (let n = view.getUint32(80, true); n > 0; n--) {
    const length = view.getUint32(at + 4, true);
    records.push({ offset: view.getUint32(at, true), data: bytes.subarray(at + 8, at + 8 + length) });
    at += 8 + length;
  }
  return { size: view.getUint32(12, true), source: hex(bytes.subarray(16, 48)), records };
}

// Original ROM -> modded ROM, in place. Each record is original XOR modded.
function applyPatch(rom, patch) {
  for (const { offset, data } of patch.records) {
    for (let i = 0; i < data.length; i++) rom[offset + i] ^= data[i];
  }
}

// One object store holding the original ROM as a Blob under "original".
function store(mode, work) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("player-rom", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("rom");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("rom", mode), request = work(tx.objectStore("rom"));
      tx.oncomplete = () => { open.result.close(); resolve(request.result); };
      tx.onabort = () => { open.result.close(); reject(tx.error); };
    };
  });
}

// The ROM kept by an earlier visit, or null (none, or storage refused as in a private window).
async function storedRom(patch) {
  try {
    const blob = await store("readonly", (s) => s.get("original"));
    if (!blob) return null;
    const rom = new Uint8Array(await blob.arrayBuffer());
    return await sha256(rom) === patch.source ? rom : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

// The original ROM out of the file the player chose. Throws the message to show otherwise.
async function readOriginal(file, patch) {
  if (file.size > patch.size) throw new Error(WRONG_FILE);
  const rom = new Uint8Array(patch.size).fill(0xff);   // a trimmed copy lost its 0xFF padding
  rom.set(new Uint8Array(await file.arrayBuffer()));
  if (await sha256(rom) !== patch.source) throw new Error(WRONG_FILE);
  return rom;
}

// Shows the import panel until the player gives the right file (button or drop).
function askForRom(patch) {
  const panel = document.getElementById("rom-import"), input = document.getElementById("rom-file");
  const button = document.getElementById("rom-choose"), status = document.getElementById("rom-status");
  const game = document.getElementById("game");
  game.hidden = true;
  panel.hidden = false;
  return new Promise((resolve) => {
    const take = async (file) => {
      if (!file || button.disabled) return;
      button.disabled = true;
      status.className = "hint";
      status.textContent = "Checking the file…";
      try {
        const rom = await readOriginal(file, patch);
        // Kept for the next visits when the browser allows it; without it the panel shows again.
        await store("readwrite", (s) => s.put(new Blob([rom]), "original")).catch(console.error);
        navigator.storage?.persist?.().catch(() => {});
        panel.hidden = true;
        game.hidden = false;
        resolve(rom);
      } catch (err) {
        status.className = "hint error";
        status.textContent = err.message === WRONG_FILE ? WRONG_FILE : "This file could not be read. Try again.";
        if (err.message !== WRONG_FILE) console.error(err);
        button.disabled = false;
        input.value = "";
      }
    };
    button.addEventListener("click", () => input.click());
    input.addEventListener("change", () => take(input.files[0]));
    panel.addEventListener("dragover", (e) => { e.preventDefault(); panel.classList.add("over"); });
    panel.addEventListener("dragleave", () => panel.classList.remove("over"));
    panel.addEventListener("drop", (e) => {
      e.preventDefault();
      panel.classList.remove("over");
      take(e.dataTransfer.files[0]);
    });
  });
}

// The modded ROM as a File called `name`, for the emulator. Asks the player for their original
// ROM first when this browser does not have it.
export async function playerRom(name) {
  const patch = await loadPatch();
  const rom = await storedRom(patch) ?? await askForRom(patch);
  applyPatch(rom, patch);
  return new File([rom], name);
}
