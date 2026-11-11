// Builds a Digimon World Championship .sav (8 KB) from decoded save data. Format documented in
// tools/save_tool.py: "DIGICHMP" header, one record holding an NBLC block. The block is written
// with its single chunk stored (not LZ-compressed), which the game accepts: it still applies the
// inverse Burrows-Wheeler transform, so the data is BWT-encoded here.
const SAVE_SIZE = 0x2000;
const NAME_OFFSETS = [0x00, 0x10];  // tamer name, twice (UTF-16LE, 8 characters max)
const NAME_CHARS = 8;
// Species the starter DigiEgg (Digimon slot 0) hatches into, u16 (checked in melonDS: 0x0F there
// hatches a Poyomon). Baby I species are 0x08-0x13.
const EGG_HATCH_OFFSET = 0x1ea;
export const BABY_SPECIES = { min: 0x08, max: 0x13 };

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function bwt(data) {
  const n = data.length;
  const rows = Array.from({ length: n }, (_, i) => i);
  rows.sort((a, b) => {
    for (let k = 0; k < n; k++) {
      const d = data[(a + k) % n] - data[(b + k) % n];
      if (d !== 0) return d;
    }
    return 0;
  });
  return { last: Uint8Array.from(rows, (r) => data[(r + n - 1) % n]), index: rows.indexOf(0) };
}

// Writes the tamer name (ASCII letters, digits, _ and -: all on the in-game keyboard).
export function setTamerName(raw, name) {
  const out = Uint8Array.from(raw);
  const chars = [...name.slice(0, NAME_CHARS)];
  for (const off of NAME_OFFSETS) {
    for (let i = 0; i < NAME_CHARS; i++) {
      const code = i < chars.length ? chars[i].charCodeAt(0) : 0;
      out[off + i * 2] = code & 0xff;
      out[off + i * 2 + 1] = code >> 8;
    }
  }
  return out;
}

export function setEggHatch(raw, species) {
  if (!(species >= BABY_SPECIES.min && species <= BABY_SPECIES.max)) throw new Error("not a Baby I species");
  const out = Uint8Array.from(raw);
  out[EGG_HATCH_OFFSET] = species;
  out[EGG_HATCH_OFFSET + 1] = 0;
  return out;
}

export function encodeSave(raw) {
  if (raw.length > 0x8000) throw new Error("save data larger than one chunk");
  const { last, index } = bwt(raw);
  const pad = (len) => (len + 3) & ~3;
  const body = new Uint8Array(4 + pad(last.length));
  const bodyView = new DataView(body.buffer);
  bodyView.setUint16(0, last.length, true);   // stored size == chunk size: no LZ
  bodyView.setUint16(2, index, true);
  body.set(last, 4);

  const block = new Uint8Array(0x10 + body.length);
  const blockView = new DataView(block.buffer);
  block.set([0x4e, 0x42, 0x4c, 0x43]);          // "NBLC"
  blockView.setUint32(4, raw.length, true);
  blockView.setUint32(8, body.length, true);
  blockView.setUint32(12, crc32(body), true);
  block.set(body, 0x10);

  const sav = new Uint8Array(SAVE_SIZE).fill(0xff);
  const view = new DataView(sav.buffer);
  sav.set(new TextEncoder().encode("DIGICHMP"));
  view.setUint16(8, 0, true);
  view.setUint16(10, 0xffff, true);
  view.setUint16(12, (block.length ^ 0xfffc) | 1, true);  // current record
  view.setUint16(14, block.length, true);
  sav.set(block, 16);
  return sav;
}
