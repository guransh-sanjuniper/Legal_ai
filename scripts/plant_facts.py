#!/usr/bin/env python3
"""Build a synthetic planted-fact PDF and the matching golden file.

The PDF is generated from synthetic text only. Known facts (amounts, dates,
obligations, a penalty and a contradicting pair of clauses) are inserted at
random numbered clauses. A decoy expectation is added that is deliberately not
planted, so the quality report must show it as missed. A standard clause is
deliberately left out and recorded in "removed".

Example:
  python3 scripts/plant_facts.py --out tests/fixtures/planted.pdf \
      --golden tests/golden/planted.json --pages 12 --facts 10 --seed 7
"""
import argparse
import json
import os
import random

TOPICS = [
    "Payment", "Registration", "Possession", "Maintenance", "Termination",
    "Notices", "Dispute Resolution", "Assignment", "Taxes", "Common Areas",
    "Parking", "Alterations", "Insurance", "Indemnity", "Force Majeure",
    "Default", "Rectification", "Handover", "Amenities", "Records",
]
BODY = [
    "The Parties shall act in accordance with this agreement.",
    "The Developer shall keep proper records of the project.",
    "The Purchaser shall cooperate with the Developer.",
    "Either Party may seek specific performance.",
    "The Society shall maintain the common areas in good repair.",
    "All notices shall be in writing and sent to the registered address.",
]
AMOUNTS = ["1,25,000", "7,50,000", "18,000", "2,40,000", "85,000"]
DATES = ["15 June 2028", "31 March 2029", "1 January 2028", "30 September 2030"]
DEADLINES = ["complete the handover", "execute the conveyance", "form the society", "rectify the defects"]
OBLIGATIONS = [
    "maintain the common areas",
    "provide a fire safety certificate",
    "furnish the occupancy certificate",
    "keep the accounts audited annually",
]


def pdf_escape(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_text_pdf(path, pages):
    objs = []
    n = len(pages)
    page_ids = [4 + 2 * i for i in range(n)]
    objs.append("<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>")
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for i, lines in enumerate(pages):
        content_lines = ["BT", "/F1 10 Tf", "13 TL", "50 760 Td"]
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


def build(pages_count, fact_count, seed):
    rng = random.Random(seed)
    pages = []
    clauses = []  # {no, page, lines}
    no = 0
    for p in range(pages_count):
        lines = [f"Synthetic Real Estate Agreement - page {p + 1}"]
        for _ in range(3):
            no += 1
            topic = TOPICS[(no - 1) % len(TOPICS)]
            heading = f"{no}. {topic}"
            body = f"{no}.1 {BODY[(no - 1) % len(BODY)]}"
            clause = {"no": str(no), "page": p, "lines": [heading, body]}
            clauses.append(clause)
            lines.extend(clause["lines"])
        pages.append(lines)

    expected = []
    removed = []
    chosen = rng.sample(clauses, min(fact_count + 1, len(clauses)))
    cursor = 0

    def add_fact(clause, sentence, token, kind, reason):
        clause["lines"].append(sentence)
        expected.append({"clause": clause["no"], "token": token, "kind": kind, "reason": reason})

    # A contradicting pair: the same obligation, two different amounts.
    c1, c2 = chosen[cursor], chosen[cursor + 1]
    cursor += 2
    a1, a2 = rng.sample(AMOUNTS, 2)
    add_fact(c1, f"The Developer shall pay Rs. {a1} as compensation for delay.", a1, "payment",
             "Planted contradiction: compensation amount A.")
    add_fact(c2, f"The Developer shall pay Rs. {a2} as compensation for delay.", a2, "payment",
             "Planted contradiction: the same compensation has a different amount.")

    # A date, an obligation and a penalty.
    date = rng.choice(DATES)
    c3 = chosen[cursor]
    cursor += 1
    add_fact(c3, f"The Developer shall {rng.choice(DEADLINES)} on or before {date}.", date, "date",
             "Planted fixed date.")

    obligation = rng.choice(OBLIGATIONS)
    c4 = chosen[cursor]
    cursor += 1
    add_fact(c4, f"The Developer shall {obligation} under this agreement.", obligation, "obligation",
             "Planted obligation.")

    penalty = rng.choice(AMOUNTS)
    c5 = chosen[cursor]
    cursor += 1
    add_fact(c5, f"A penalty of Rs. {penalty} shall be payable for delay in handover.", penalty, "risk",
             "Planted penalty (risk).")

    # Optional extra payments/dates, cycling the remaining chosen clauses.
    label = 1
    while cursor < len(chosen) and len(expected) < fact_count:
        clause = chosen[cursor]
        cursor += 1
        if label % 2 == 0:
            amount = rng.choice(AMOUNTS)
            add_fact(clause, f"The Purchaser shall pay Rs. {amount} towards instalment {label}.", amount, "payment",
                     "Planted payment.")
        else:
            when = rng.choice(DATES)
            add_fact(clause, f"The Purchaser shall pay instalment {label} on or before {when}.", when, "date",
                     "Planted payment date.")
        label += 1

    # Deliberately absent standard clause.
    removed.append({
        "clause": "none",
        "token": "insurance",
        "kind": "obligation",
        "reason": "Standard insurance clause deliberately omitted from the synthetic document.",
    })

    # Deliberately wrong fact: never planted anywhere. The report must show it as missed.
    decoy_clause = rng.choice(clauses)["no"]
    expected.append({
        "clause": decoy_clause,
        "token": "9,99,999",
        "kind": "payment",
        "reason": "DECOY: not planted. The scorer must report this expectation as missed.",
    })

    # Rebuild the pages after inserting facts. The initial page text was a copy, so appending
    # to a clause after that point would otherwise be lost.
    pages = [[] for _ in range(pages_count)]
    for clause in clauses:
        pages[clause["page"]].extend(clause["lines"])
    for p, lines in enumerate(pages):
        lines.insert(0, f"Synthetic Real Estate Agreement - page {p + 1}")

    return pages, expected, removed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="tests/fixtures/planted.pdf")
    parser.add_argument("--golden", default="tests/golden/planted.json")
    parser.add_argument("--pages", type=int, default=12)
    parser.add_argument("--facts", type=int, default=10)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--doc", default=None)
    args = parser.parse_args()

    pages, expected, removed = build(args.pages, args.facts, args.seed)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    os.makedirs(os.path.dirname(args.golden) or ".", exist_ok=True)
    make_text_pdf(args.out, pages)
    golden = {
        "doc": args.doc or os.path.basename(args.out),
        "holdout": False,
        "note": (
            "Synthetic planted-fact document. Facts were inserted at random numbered clauses; "
            "the decoy was not planted and the insurance clause is deliberately absent."
        ),
        "pages": len(pages),
        "expected": expected,
        "removed": removed,
    }
    with open(args.golden, "w", encoding="utf-8") as f:
        json.dump(golden, f, indent=2)
        f.write("\n")
    print(f"wrote {args.out} ({len(pages)} pages) and {args.golden} ({len(expected)} expectations)")


if __name__ == "__main__":
    main()
