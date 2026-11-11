"""Dump and rebuild the Digimon World Championship text files (ui/txt/*.dat).

File layout (observed in the USA ROM):
  b"utf-16<>\\n"                      ASCII header (present even in the UTF-8 file _tag.dat)
  b"<count><>\\n"                     ASCII entry count (absent in tag files)
  entries, each = text + b"<>\\n"     (the separator is 3 raw ASCII bytes)
  b"<END>\\n"                         ASCII end marker (absent in tag files)
Text is UTF-16LE, except _tag.dat whose entries are UTF-8 (no NUL bytes at all).
Inside UTF-16 text:
  U+001B followed by one UTF-16 unit  -> control code, dumped as {esc:XXXX}
  "[N]"                                -> placeholder filled by the game (kept as is)
  "\\n" (backslash + n)                -> line break (kept as is)

Usage:
  python txt_tool.py dump  <file.dat> <out.json>
  python txt_tool.py build <in.json>  <file.dat>
  python txt_tool.py check <file.dat>          (dump + rebuild, compare bytes)
"""
import json
import os
import re
import struct
import sys

SEP = b"<>\n"
HEADER = b"utf-16" + SEP
END = b"<END>\n"
ESC = re.compile(r"\{esc:([0-9A-Fa-f]{4})\}")


def parse(raw):
    if not raw.startswith(HEADER):
        raise ValueError("missing utf-16 header")
    pos = len(HEADER)
    count = None
    end = raw.find(SEP, pos)
    if end > pos and raw[pos:end].isdigit():
        count = int(raw[pos:end])
        pos = end + len(SEP)
    has_end = raw.endswith(END)
    body_end = len(raw) - len(END) if has_end else len(raw)
    encoding = "utf-8" if b"\x00" not in raw[pos:body_end] else "utf-16-le"

    entries = []
    while pos < body_end:
        if encoding == "utf-8":
            stop = raw.find(SEP, pos, body_end)
            if stop < 0:
                raise ValueError("unterminated entry at 0x%x" % pos)
            entries.append(raw[pos:stop].decode("utf-8"))
            pos = stop + len(SEP)
            continue
        units = []
        while raw[pos:pos + 3] != SEP:
            if pos + 2 > body_end:
                raise ValueError("unterminated entry at 0x%x" % pos)
            units.append(struct.unpack_from("<H", raw, pos)[0])
            pos += 2
        pos += len(SEP)
        entries.append(decode_units(units))
    return {"count": count, "has_end": has_end, "encoding": encoding, "entries": entries}


def decode_units(units):
    out, i = [], 0
    while i < len(units):
        u = units[i]
        if u == 0x1B and i + 1 < len(units):
            out.append("{esc:%04X}" % units[i + 1])
            i += 2
            continue
        out.append(chr(u))
        i += 1
    return "".join(out)


def encode_text(text, encoding):
    if encoding == "utf-8":
        return text.encode("utf-8")
    data = bytearray()
    pos = 0
    for m in ESC.finditer(text):
        data += text[pos:m.start()].encode("utf-16-le")
        data += struct.pack("<HH", 0x1B, int(m.group(1), 16))
        pos = m.end()
    data += text[pos:].encode("utf-16-le")
    return bytes(data)


def build(doc):
    out = bytearray(HEADER)
    if doc["has_count"]:
        out += str(len(doc["entries"])).encode("ascii") + SEP
    for e in doc["entries"]:
        out += encode_text(e, doc["encoding"]) + SEP
    if doc["has_end"]:
        out += END
    return bytes(out)


def to_doc(parsed):
    return {"has_count": parsed["count"] is not None, "has_end": parsed["has_end"],
            "encoding": parsed["encoding"],
            "entries": parsed["entries"]}


def main():
    cmd = sys.argv[1]
    if cmd == "dump":
        with open(sys.argv[2], "rb") as f:
            parsed = parse(f.read())
        doc = to_doc(parsed)
        doc["entries"] = [{"id": i, "text": t} for i, t in enumerate(doc["entries"])]
        with open(sys.argv[3], "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)
        print("%d entries (header count: %s)" % (len(parsed["entries"]), parsed["count"]))
    elif cmd == "build":
        with open(sys.argv[2], encoding="utf-8") as f:
            doc = json.load(f)
        doc["entries"] = [e["text"] for e in doc["entries"]]
        os.makedirs(os.path.dirname(os.path.abspath(sys.argv[3])), exist_ok=True)
        with open(sys.argv[3], "wb") as f:
            f.write(build(doc))
        print("wrote %d entries" % len(doc["entries"]))
    elif cmd == "check":
        with open(sys.argv[2], "rb") as f:
            raw = f.read()
        parsed = parse(raw)
        same = build(to_doc(parsed)) == raw
        print("%s: %d entries, header count %s, %s, round-trip identical: %s"
              % (sys.argv[2].replace("\\", "/").split("/")[-1], len(parsed["entries"]),
                 parsed["count"], parsed["encoding"], same))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
