"""Generates test PDFs. No third-party packages needed for the text PDF; PIL is used for the scanned one.

  text10.pdf     10 pages, native text layer, numbered clauses (known page map in FIXTURE_PAGES)
  scanned3.pdf   3 pages, image only (no text layer), English text rendered as pixels
  blank_mix.pdf  3 pages: text page, blank page, text page (blank has no text and no image)
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))

FIXTURE_PAGES = {
    1: ["1. Definitions", "1.1 Developer means Example Realty Pvt Ltd.", "1.2 Purchaser means the person named in Schedule A."],
    2: ["2. Possession", "2.1 The Developer shall hand over possession on or before 31 March 2027.", "(a) subject to force majeure;", "(b) subject to payment of all dues."],
    3: ["3. Price", "3.1 The total consideration is Rs. 1,25,00,000 payable as per Schedule B.", "3.1.1 First instalment on booking."],
    4: ["4. Penalty", "4.1 Delay beyond six months attracts interest at 2 percent per month.", "(i) interest shall be paid monthly."],
    5: ["Article 5 Registration", "Clause 5.1 The Purchaser shall register this agreement within 30 days.", "5.2 Stamp duty shall be paid by the Purchaser."],
    6: ["6. Maintenance", "6.1 The Society shall maintain common areas.", "6.2 Maintenance charges are payable monthly."],
    7: ["7. Termination", "7.1 Either party may terminate on 60 days notice.", "7.2 Refund shall be made within 90 days of termination."],
    8: ["8. Dispute Resolution", "8.1 Disputes shall be referred to the Real Estate Regulatory Authority.", "8.2 Governing law is the law of Maharashtra."],
    9: ["9. Notices", "9.1 Notices shall be in writing and sent to the registered address.", "9.2 Email notices are valid when acknowledged."],
    10: ["Schedule A Purchaser Details", "Name: Test Person One. Unit 12, Building B.", "Schedule B Payment Plan", "Instalments as agreed."],
}


def pdf_escape(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_text_pdf(path, pages):
    objs = []
    n = len(pages)
    # object 1 catalog, 2 pages, 3 font, then per page: page obj + content obj
    page_ids = [4 + 2 * i for i in range(n)]
    objs.append("<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>")
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for i, lines in enumerate(pages):
        content_lines = ["BT", "/F1 11 Tf", "14 TL", "60 760 Td"]
        for line in lines:
            content_lines.append(f"({pdf_escape(line)}) Tj T*")
        content_lines.append("ET")
        stream = "\n".join(content_lines)
        content_id = page_ids[i] + 1
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
        )
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for idx, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{idx} 0 obj\n{body}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    with open(path, "wb") as f:
        f.write(out)


def render_page(lines, blank=False):
    img = Image.new("RGB", (1240, 1754), "white")
    if blank:
        return img
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 34) if os.path.exists(
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf") else ImageFont.load_default()
    y = 120
    for line in lines:
        draw.text((120, y), line, fill="black", font=font)
        y += 70
    return img


def make_scanned_pdf(path, pages):
    imgs = [render_page(lines) for lines in pages]
    imgs[0].save(path, "PDF", resolution=200.0, save_all=True, append_images=imgs[1:])


if __name__ == "__main__":
    make_text_pdf(os.path.join(HERE, "text10.pdf"), [FIXTURE_PAGES[i] for i in range(1, 11)])
    make_scanned_pdf(os.path.join(HERE, "scanned3.pdf"), [
        ["Scanned page one. Possession shall be given on time.", "1. Scope of agreement."],
        ["Scanned page two. Price is payable in instalments.", "2. Payment terms apply."],
        ["Scanned page three. Governing law is Maharashtra."],
    ])
    blank = Image.new("RGB", (1240, 1754), "white")
    text_img = render_page(["Blank mix test page one.", "1. Clause one text."])
    text_img2 = render_page(["Blank mix test page three.", "2. Clause two text."])
    text_img.save(os.path.join(HERE, "blank_mix.pdf"), "PDF", resolution=200.0, save_all=True,
                  append_images=[blank, text_img2])
    # Long scanned file for the kill-and-resume test. Generated locally, not committed.
    make_scanned_pdf(os.path.join(HERE, "scanned30.pdf"), [
        [f"Scanned long page {i}. Clause {i} obligation text here.", f"{i}. Heading number {i} for resume test."]
        for i in range(1, 31)
    ])
    print("fixtures written to", HERE)
