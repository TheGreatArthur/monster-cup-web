"""Decode / encode the Digimon World Championship save (.sav, 8 KB).

Layout (from ARM9 FUN_02068b90 / FUN_0205323c):
  0x00  "DIGICHMP"
  0x08  u16 start, u16 ~start          offset of the first record (0 = right after the header)
  0x0c  records: u16 flags, u16 len    len == (flags & 0xfffc) ^ 0xfffc, flags & 3 == 1 for the current one
        then len bytes: an NBLC block
NBLC block: "NBLC", u32 raw size, u32 packed size, u32 CRC32 of the packed bytes, then
  u16 packed size[n], u16 BWT index[n] (n = 32 KB chunks), then each chunk (4-byte aligned):
  LZ10-compressed (or stored when packed size == chunk size) Burrows-Wheeler transformed data.

Usage:
  python save_tool.py decode <in.sav> <out.bin>
  python save_tool.py encode <in.bin> <out.sav>
"""
import struct
import sys
import zlib

MAGIC = b"DIGICHMP"
SAVE_SIZE = 0x2000
CHUNK = 0x8000


def lz10_decompress(src):
    assert src[0] == 0x10, "not LZ10"
    size = int.from_bytes(src[1:4], "little")
    out, i = bytearray(), 4
    while len(out) < size:
        flags = src[i]; i += 1
        for bit in range(8):
            if len(out) >= size:
                break
            if flags & (0x80 >> bit):
                b0, b1 = src[i], src[i + 1]; i += 2
                length, disp = (b0 >> 4) + 3, ((b0 & 0xF) << 8 | b1) + 1
                for _ in range(length):
                    out.append(out[-disp])
            else:
                out.append(src[i]); i += 1
    return bytes(out[:size])


def lz10_compress(data):
    out = bytearray([0x10]) + len(data).to_bytes(3, "little")
    i = 0
    while i < len(data):
        flag_pos, flags = len(out), 0
        out.append(0)
        for bit in range(8):
            if i >= len(data):
                break
            best_len, best_disp = 0, 0
            for disp in range(1, min(i, 0x1000) + 1):
                n = 0
                while n < 18 and i + n < len(data) and data[i + n] == data[i - disp + n]:
                    n += 1
                if n > best_len:
                    best_len, best_disp = n, disp
                    if n == 18:
                        break
            if best_len >= 3:
                flags |= 0x80 >> bit
                out += bytes([(best_len - 3) << 4 | (best_disp - 1) >> 8, (best_disp - 1) & 0xFF])
                i += best_len
            else:
                out.append(data[i]); i += 1
        out[flag_pos] = flags
    return bytes(out)


def ibwt(src, index):
    """Inverse transform exactly as the game does it (FUN_0205364c)."""
    order = sorted(range(len(src)), key=lambda k: src[k])   # stable sort of positions by byte
    out, p = bytearray(), order[index]
    for _ in range(len(src)):
        out.append(src[p])
        p = order[p]
    return bytes(out)


def bwt(data):
    # Classic BWT: last column of the sorted rotations, index = row of the original rotation.
    n = len(data)
    rows = sorted(range(n), key=lambda k: data[k:] + data[:k])
    last = bytes(data[(k - 1) % n] for k in rows)
    index = rows.index(0)
    assert ibwt(last, index) == data
    return last, index


def decode_block(blk):
    assert blk[:4] == b"NBLC", "not an NBLC block"
    raw_size, packed_size, crc = struct.unpack_from("<III", blk, 4)
    body = blk[0x10:0x10 + packed_size]
    assert zlib.crc32(body) == crc, "NBLC CRC mismatch"
    n = (raw_size + CHUNK - 1) // CHUNK
    sizes = struct.unpack_from("<%dH" % n, body, 0)
    indexes = struct.unpack_from("<%dH" % n, body, n * 2)
    pos, out, left = n * 4, bytearray(), raw_size
    for size, index in zip(sizes, indexes):
        chunk_len = min(left, CHUNK)
        data = body[pos:pos + size]
        if size != chunk_len:
            data = lz10_decompress(data)
        out += ibwt(data, index)
        pos += (size + 3) & ~3
        left -= chunk_len
    return bytes(out)


def encode_block(raw):
    chunks = [raw[i:i + CHUNK] for i in range(0, len(raw), CHUNK)]
    sizes, indexes, parts = [], [], []
    for c in chunks:
        last, index = bwt(c)
        packed = lz10_compress(last)
        if len(packed) >= len(c):
            packed = last
        sizes.append(len(packed)); indexes.append(index)
        parts.append(packed + b"\0" * (-len(packed) % 4))
    body = struct.pack("<%dH" % len(chunks), *sizes) + struct.pack("<%dH" % len(chunks), *indexes)
    body += b"".join(parts)
    return b"NBLC" + struct.pack("<III", len(raw), len(body), zlib.crc32(body)) + body


def current_record(sav):
    assert sav[:8] == MAGIC, "not a DWC save"
    start, inv = struct.unpack_from("<HH", sav, 8)
    # The records form a ring: the current one may come before the header's start, so scan from
    # the start, then again from the first record.
    for pos in dict.fromkeys((start if start and start == inv ^ 0xFFFF else 0xC, 0xC)):
        while pos + 4 < SAVE_SIZE:
            flags, length = struct.unpack_from("<HH", sav, pos)
            if length & 3 or length != (flags & 0xFFFC) ^ 0xFFFC or pos + 4 + length > SAVE_SIZE:
                pos += 4
                continue
            if flags & 3 == 1:
                return sav[pos + 4:pos + 4 + length]
            pos += 4 + length
    raise SystemExit("no current save record")


def decode(sav):
    return decode_block(current_record(sav))


def encode(raw):
    blk = encode_block(raw)
    blk += b"\0" * (-len(blk) % 4)
    length = len(blk)
    flags = (length ^ 0xFFFC) | 1
    sav = bytearray(b"\xff" * SAVE_SIZE)
    sav[:12] = MAGIC + struct.pack("<HH", 0, 0xFFFF)
    sav[12:16] = struct.pack("<HH", flags, length)
    sav[16:16 + length] = blk
    return bytes(sav)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "decode" and len(sys.argv) == 4:
        open(sys.argv[3], "wb").write(decode(open(sys.argv[2], "rb").read()))
    elif cmd == "encode" and len(sys.argv) == 4:
        open(sys.argv[3], "wb").write(encode(open(sys.argv[2], "rb").read()))
    else:
        raise SystemExit(__doc__)
