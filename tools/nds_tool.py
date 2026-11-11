"""Extract and repack the NitroFS files of an NDS ROM.

  python tools/nds_tool.py extract <rom.nds> <out dir>
      Writes every file under <out dir> with its NitroFS path.

  python tools/nds_tool.py repack <original.nds> <mod dir> <output.nds> [patch.json ...]
      <mod dir> mirrors NitroFS paths (e.g. <mod dir>/ui/txt/txt_list_txt.dat).
      Each patch.json lists code patches (see patches/): {"overlay": N or null for ARM9,
      "address": RAM address, "original": hex, "replacement": hex}. The original bytes are
      checked before writing, so a patch never applies to the wrong place.
      Each file found there replaces the original. A file that still fits in its
      original slot (up to the next file) is written in place; a bigger file is
      moved to the free space after the used ROM area. The FAT, the used-size
      field (0x80) and the header CRC (0x15E) are updated. Nothing else changes:
      ARM9/ARM7 code, overlays and the secure area stay byte-identical.
"""
import json
import os
import struct
import sys

ALIGN = 0x200


def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def list_files(rom):
    """Return {path: file_id} from the FNT."""
    fnt_off = struct.unpack_from("<I", rom, 0x40)[0]
    files = {}

    def walk(dir_id, path):
        sub_off, file_id, _ = struct.unpack_from("<IHH", rom, fnt_off + (dir_id & 0xFFF) * 8)
        pos = fnt_off + sub_off
        while True:
            length = rom[pos]
            pos += 1
            if length == 0:
                return
            name = rom[pos:pos + (length & 0x7F)].decode("shift_jis", errors="replace")
            pos += length & 0x7F
            if length & 0x80:
                walk(struct.unpack_from("<H", rom, pos)[0], path + [name])
                pos += 2
            else:
                files["/".join(path + [name])] = file_id
                file_id += 1

    walk(0xF000, [])
    return files


def fat_entry(rom, fat_off, file_id):
    return struct.unpack_from("<II", rom, fat_off + file_id * 8)


def extract(rom_path, out_dir):
    rom = open(rom_path, "rb").read()
    fat_off = struct.unpack_from("<I", rom, 0x48)[0]
    files = list_files(rom)
    for path, fid in files.items():
        start, end = fat_entry(rom, fat_off, fid)
        target = os.path.join(out_dir, *path.split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as f:
            f.write(rom[start:end])
    print("extracted %d files to %s" % (len(files), out_dir))


def code_region(rom, overlay):
    """Return (rom offset, ram address, size) of the ARM9 binary or of one ARM9 overlay."""
    if overlay is None:
        off, _, ram, size = struct.unpack_from("<IIII", rom, 0x20)
        return off, ram, size
    fat_off = struct.unpack_from("<I", rom, 0x48)[0]
    ovt_off, ovt_size = struct.unpack_from("<II", rom, 0x50)
    for i in range(ovt_size // 32):
        ov_id, ram, ram_size, _, _, _, file_id, flags = struct.unpack_from("<8I", rom, ovt_off + i * 32)
        if ov_id == overlay:
            if flags & 0x01000000:
                raise SystemExit("overlay %d is compressed: code patches need it decompressed" % overlay)
            start, end = fat_entry(rom, fat_off, file_id)
            return start, ram, end - start
    raise SystemExit("no overlay %d in this ROM" % overlay)


def apply_patches(rom, patch_path):
    doc = json.load(open(patch_path, encoding="utf-8"))
    for p in doc["patches"]:
        start, ram, size = code_region(rom, p.get("overlay"))
        addr = int(p["address"], 16)
        original, replacement = bytes.fromhex(p["original"]), bytes.fromhex(p["replacement"])
        if len(original) != len(replacement) or not 0 <= addr - ram <= size - len(original):
            raise SystemExit("%s: bad patch at %s" % (patch_path, p["address"]))
        off = start + addr - ram
        current = bytes(rom[off:off + len(original)])
        if current == replacement:
            where = "already applied"
        elif current != original:
            raise SystemExit("%s: at %s expected %s, found %s (wrong ROM or overlay?)"
                             % (patch_path, p["address"], p["original"], current.hex()))
        else:
            rom[off:off + len(replacement)] = replacement
            where = "patched"
        target = "arm9" if p.get("overlay") is None else "ov%03d" % p["overlay"]
        print("%-45s %s %s  %s" % (os.path.basename(patch_path), target, p["address"], where))


def repack(rom_path, mod_dir, out_path, patch_paths=()):
    rom = bytearray(open(rom_path, "rb").read())
    for patch_path in patch_paths:
        apply_patches(rom, patch_path)
    fat_off, fat_size = struct.unpack_from("<II", rom, 0x48)
    used_size = struct.unpack_from("<I", rom, 0x80)[0]
    capacity = 0x20000 << rom[0x14]
    files = list_files(rom)

    # Slot limit of each file = start of the next allocated block in the ROM
    # (FAT entries of overlays included), so in-place writes never overlap.
    starts = sorted({fat_entry(rom, fat_off, i)[0] for i in range(fat_size // 8)} | {used_size})
    free = (used_size + ALIGN - 1) & ~(ALIGN - 1)

    replaced = 0
    for root, _, names in os.walk(mod_dir):
        for name in names:
            full = os.path.join(root, name)
            path = os.path.relpath(full, mod_dir).replace(os.sep, "/")
            if path not in files:
                raise SystemExit("not a file of this ROM: %s" % path)
            data = open(full, "rb").read()
            fid = files[path]
            start, end = fat_entry(rom, fat_off, fid)
            limit = next(s for s in starts if s > start) if any(s > start for s in starts) else used_size
            if start + len(data) <= limit:
                rom[start:limit] = data + b"\xff" * (limit - start - len(data))
                where = "in place"
            else:
                start = free
                if start + len(data) > capacity:
                    raise SystemExit("ROM capacity exceeded by %s" % path)
                if start + len(data) > len(rom):
                    rom += b"\xff" * (start + len(data) - len(rom))
                rom[start:start + len(data)] = data
                free = (start + len(data) + ALIGN - 1) & ~(ALIGN - 1)
                used_size = max(used_size, start + len(data))
                where = "moved to 0x%08x" % start
            struct.pack_into("<II", rom, fat_off + fid * 8, start, start + len(data))
            print("%-45s %8d bytes  %s" % (path, len(data), where))
            replaced += 1

    struct.pack_into("<I", rom, 0x80, used_size)
    struct.pack_into("<H", rom, 0x15E, crc16(rom[:0x15E]))
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(rom)
    print("replaced %d files -> %s" % (replaced, out_path))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "extract" and len(sys.argv) == 4:
        extract(sys.argv[2], sys.argv[3])
    elif cmd == "repack" and len(sys.argv) >= 5:
        repack(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
    else:
        raise SystemExit(__doc__)
