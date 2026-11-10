"""Builds mixed.pdf: a text PDF with English, Marathi and Hindi pages.

Devanagari pages use an embedded Noto Sans Devanagari (Type0 / Identity-H) with a
ToUnicode CMap, so pdf.js extracts real Unicode text.
"""
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_PATH = "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf"

PAGES = [
    ("eng", [
        "1. Possession",
        "1.1 The Developer shall hand over possession of Unit 12 on or before 31 March 2027.",
        "1.2 The society shall cooperate with the developer during construction.",
    ]),
    ("eng", [
        "2. Maintenance Charges",
        "2.1 The Purchaser shall pay maintenance charges every month to the society.",
        "2.2 Non payment of maintenance is a breach of this agreement.",
    ]),
    ("dev", [
        "३. ताबा आणि पुनर्विकास",
        "३.१ विकासकाने सदस्यांना नवीन घराचा ताबा तीस दिवसांत द्यावा.",
        "३.२ सोसायटीने पुनर्विकासासाठी सर्व आवश्यक कागदपत्रे द्यावीत.",
    ]),
    ("dev", [
        "४. देखभाल शुल्क",
        "४.१ सदस्याने दरमहा देखभाल शुल्क सोसायटीला भरावे.",
        "४.२ देखभाल शुल्क न भरल्यास हा करार भंग होईल.",
    ]),
    ("dev", [
        "५. अनुबंध की अवधि",
        "५.१ यह अनुबंध पंजीकरण की तारीख से लागू होगा।",
        "५.२ सोसाइटी और डेवलपर सभी शर्तों का पालन करेंगे।",
    ]),
]


def parse_cmap(path):
    data = open(path, "rb").read()
    num_tables = struct.unpack(">H", data[4:6])[0]
    tables = {}
    for i in range(num_tables):
        off = 12 + i * 16
        tag = data[off:off + 4].decode("latin-1")
        offset, _length = struct.unpack(">II", data[off + 8:off + 16])
        tables[tag] = offset
    cmap_off = tables["cmap"]
    n = struct.unpack(">H", data[cmap_off + 2:cmap_off + 4])[0]
    best = None
    for i in range(n):
        rec = cmap_off + 4 + i * 8
        plat, enc, sub = struct.unpack(">HHI", data[rec:rec + 8])
        sub_off = cmap_off + sub
        if struct.unpack(">H", data[sub_off:sub_off + 2])[0] == 4 and (plat, enc) in ((3, 1), (0, 3), (0, 4)):
            best = sub_off
            break
    if best is None:
        raise SystemExit("no format 4 cmap")
    seg_x2 = struct.unpack(">H", data[best + 6:best + 8])[0]
    seg = seg_x2 // 2
    ends = struct.unpack(">%dH" % seg, data[best + 14:best + 14 + seg_x2])
    starts_off = best + 16 + seg_x2
    starts = struct.unpack(">%dH" % seg, data[starts_off:starts_off + seg_x2])
    deltas_off = starts_off + seg_x2
    deltas = struct.unpack(">%dh" % seg, data[deltas_off:deltas_off + seg_x2])
    ranges_off = deltas_off + seg_x2
    ranges = struct.unpack(">%dH" % seg, data[ranges_off:ranges_off + seg_x2])
    mapping = {}
    for i in range(seg):
        for c in range(starts[i], ends[i] + 1):
            if c == 0xFFFF:
                continue
            if ranges[i] == 0:
                gid = (c + deltas[i]) & 0xFFFF
            else:
                gi = ranges_off + i * 2 + ranges[i] + (c - starts[i]) * 2
                gid = struct.unpack(">H", data[gi:gi + 2])[0]
                if gid:
                    gid = (gid + deltas[i]) & 0xFFFF
            if gid:
                mapping[c] = gid
    # Widths: hhea.numberOfHMetrics, then hmtx advances.
    hhea = tables["hhea"]
    num_hm = struct.unpack(">H", data[hhea + 34:hhea + 36])[0]
    hmtx = tables["hmtx"]
    head = tables["head"]
    units = struct.unpack(">H", data[head + 18:head + 20])[0]

    def width(gid):
        idx = min(gid, num_hm - 1)
        adv = struct.unpack(">H", data[hmtx + idx * 4:hmtx + idx * 4 + 2])[0]
        return max(1, round(adv * 1000 / units))

    return mapping, data, width


def pdf_escape(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build(pages_spec, out_name="mixed.pdf"):
    cmap, font_bytes, glyph_width = parse_cmap(FONT_PATH)
    used = []
    for lang, lines in pages_spec:
        if lang != "eng":
            for line in lines:
                for ch in line:
                    if ch not in used:
                        used.append(ch)
    missing = [c for c in used if ord(c) not in cmap]
    if missing:
        raise SystemExit("font lacks glyphs: %r" % missing)

    # 1 catalog, 2 pages, 3 Helvetica, 4 Type0, 5 descriptor, 6 font file,
    # 7 ToUnicode, 8 CID font, then page/content pairs.
    objs = []
    objs.append("<< /Type /Catalog /Pages 2 0 R >>")
    objs.append("<< /Type /Pages /Kids [] /Count 0 >>")
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    entries = []
    seen = set()
    for ch in used:
        gid = cmap[ord(ch)]
        if gid in seen:
            continue
        seen.add(gid)
        entries.append("<%04X> <%04X>" % (gid, ord(ch)))

    cmap_stream = (
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
        "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
        "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
    )
    for i in range(0, len(entries), 100):
        part = entries[i:i + 100]
        cmap_stream += "%d beginbfchar\n%s\nendbfchar\n" % (len(part), "\n".join(part))
    cmap_stream += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"

    objs.append(
        "<< /Type /Font /Subtype /Type0 /BaseFont /NotoSansDevanagari /Encoding /Identity-H "
        "/DescendantFonts [8 0 R] /ToUnicode 7 0 R >>"
    )
    objs.append(
        "<< /Type /FontDescriptor /FontName /NotoSansDevanagari /Flags 4 "
        "/FontBBox [0 -1000 2000 2000] /ItalicAngle 0 /Ascent 1000 /Descent -300 "
        "/CapHeight 700 /StemV 80 /FontFile2 6 0 R >>"
    )
    objs.append(
        "<< /Length %d /Length1 %d >>\nstream\n" % (len(font_bytes), len(font_bytes))
        + font_bytes.decode("latin-1")
        + "\nendstream"
    )
    objs.append("<< /Length %d >>\nstream\n%s\nendstream" % (len(cmap_stream.encode("latin-1")), cmap_stream))
    max_gid = max(cmap[ord(ch)] for ch in used)
    widths = [1000] + [0] * max(0, max_gid)
    for ch in used:
        widths[cmap[ord(ch)]] = glyph_width(cmap[ord(ch)])
    w_array = " ".join(str(w) for w in widths[1:])
    objs.append(
        "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /NotoSansDevanagari "
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
        "/FontDescriptor 5 0 R /DW 1000 /W [1 [%s]] /CIDToGIDMap /Identity >>" % w_array
    )

    kids = []
    for lang, lines in pages_spec:
        content = ["BT"]
        if lang != "eng":
            content += ["/F2 12 Tf", "20 TL", "50 760 Td"]
            for line in lines:
                gids = "".join("%04X" % cmap[ord(ch)] for ch in line)
                content.append("<%s> Tj T*" % gids)
        else:
            content += ["/F1 11 Tf", "14 TL", "60 760 Td"]
            content += ["(%s) Tj T*" % pdf_escape(line) for line in lines]
        content.append("ET")
        stream = "\n".join(content)
        page_id = len(objs) + 1
        content_id = page_id + 1
        font_ref = "/F2 4 0 R" if lang != "eng" else "/F1 3 0 R"
        objs.append(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            "/Resources << /Font << %s >> >> /Contents %d 0 R >>" % (font_ref, content_id)
        )
        objs.append("<< /Length %d >>\nstream\n%s\nendstream" % (len(stream.encode("latin-1")), stream))
        kids.append(page_id)

    objs[1] = "<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join("%d 0 R" % k for k in kids), len(kids))

    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for idx, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += ("%d 0 obj\n%s\nendobj\n" % (idx, body)).encode("latin-1")
    xref = len(out)
    out += ("xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)).encode()
    for off in offsets:
        out += ("%010d 00000 n \n" % off).encode()
    out += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)).encode()
    path = os.path.join(HERE, out_name)
    open(path, "wb").write(out)
    print("wrote", path, len(out), "bytes")



TOPICS = {
    "eng": ["possession", "maintenance charges", "rent", "parking", "corpus", "stamp duty", "registration", "arbitration", "notices", "termination"],
    "mar": ["ताबा", "देखभाल शुल्क", "भाडे", "पार्किंग", "कॉर्पस", "मुद्रांक शुल्क", "नोंदणी", "लवाद", "सूचना", "समाप्ती"],
    "hin": ["कब्जा", "रखरखाव शुल्क", "किराया", "पार्किंग", "कोष", "स्टांप शुल्क", "पंजीकरण", "माध्यस्थम्", "सूचना", "समाप्ति"],
}


def big_pages(count=45):
    pages = []
    for i in range(1, count + 1):
        lang = ["eng", "mar", "hin"][(i - 1) % 3]
        topic = TOPICS[lang][(i - 1) % len(TOPICS[lang])]
        lines = []
        if lang == "eng":
            lines.append("%d. Clause %d about %s" % (i, i, topic))
            for k in range(9):
                lines.append("Clause %d provision %d: the society and the developer record the terms for %s in this agreement." % (i, k + 1, topic))
        elif lang == "mar":
            lines.append("कलम %d: %s" % (i, topic))
            for k in range(9):
                lines.append("कलम %d तरतूद %d: सोसायटी आणि विकासक %s बाबतच्या अटी या करारात नमूद करतात." % (i, k + 1, topic))
        else:
            lines.append("धारा %d: %s" % (i, topic))
            for k in range(9):
                lines.append("धारा %d प्रावधान %d: सोसाइटी और डेवलपर %s के बारे में शर्तें इस अनुबंध में दर्ज करते हैं." % (i, k + 1, topic))
        pages.append((lang, lines))
    return pages


if __name__ == "__main__":
    import sys
    if "--big" in sys.argv:
        build(big_pages(), "mixed_big.pdf")
    else:
        build(PAGES)
