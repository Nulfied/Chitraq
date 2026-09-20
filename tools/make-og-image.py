"""Draw the link-preview card for the landing page.

Every place Chitraq gets shared — a message, a post, a chat — renders whatever
`og:image` points at, and with none set the platform picks something: a blank
rectangle, or the repository owner's avatar. That is the first thing most
people will ever see of this project, so it is worth one script.

Deliberately plain. The card says the name, the one line the project leads
with, and the three claims that are actually checkable, in the same colours
and on the same dark background as the site. No screenshot, because a
screenshot of a memory engine is a screenshot of somebody's notes.

Pillow is a development dependency of this script and of the CCITT fixture
generator. Nothing in `src/` imports it, the PNG is committed, and the
project still declares zero dependencies.

Usage:  python tools/make-og-image.py
"""

import pathlib
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("This script needs Pillow: pip install Pillow")

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "docs" / "og.png"

# Facebook, Slack, Discord, X and LinkedIn all crop toward 1.91:1.
SIZE = (1200, 630)

# The site's own dark palette, so the card and the page it opens agree.
BG = "#0e1014"
FG = "#e7e9ee"
FG_SOFT = "#98a0ac"
ACCENT = "#7aa2f7"
ACCENT_2 = "#f07aa8"
OK = "#56d4a0"
LINE = "#262b34"

# Fonts are found rather than assumed: a script that dies on a machine
# without one specific typeface is a script nobody can regenerate this with.
CANDIDATES = {
    "bold": ["segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf", "Helvetica-Bold.ttf"],
    "semi": ["seguisb.ttf", "segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"],
    "regular": ["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf", "Helvetica.ttf"],
    "mono": ["consola.ttf", "cour.ttf", "DejaVuSansMono.ttf", "Menlo.ttc"],
}
SEARCH = [
    pathlib.Path("C:/Windows/Fonts"),
    pathlib.Path("/usr/share/fonts/truetype/dejavu"),
    pathlib.Path("/usr/share/fonts"),
    pathlib.Path("/Library/Fonts"),
    pathlib.Path("/System/Library/Fonts"),
]


def font(kind, size):
    for name in CANDIDATES[kind]:
        for directory in SEARCH:
            path = directory / name
            if path.exists():
                return ImageFont.truetype(str(path), size)
        # Some systems resolve bare names through fontconfig.
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    raise SystemExit(f"No usable {kind} font found. Looked for: {CANDIDATES[kind]}")


def main():
    image = Image.new("RGB", SIZE, BG)
    d = ImageDraw.Draw(image)

    # A hairline of accent down the left edge, the same gesture the site uses
    # on its section headings.
    d.rectangle([0, 0, 8, SIZE[1]], fill=ACCENT)

    x = 92

    # The mark is drawn, not typed. The site uses ◈ and Segoe UI has no
    # glyph for it, so the first attempt rendered a tofu box — on the one
    # image whose whole job is to be seen before anything else.
    cx, cy, r = x + 30, 146, 30
    d.polygon([(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)], outline=ACCENT, width=4)
    d.polygon(
        [(cx, cy - r // 2), (cx + r // 2, cy), (cx, cy + r // 2), (cx - r // 2, cy)],
        fill=ACCENT,
    )

    d.text((x + 92, 108), "CHITRAQ", font=font("bold", 72), fill=FG)

    d.text((x, 232), "One memory, many intelligences.", font=font("semi", 46), fill=FG)

    d.text(
        (x, 306),
        "Storage answers where the file is.",
        font=font("regular", 32),
        fill=FG_SOFT,
    )
    d.text(
        (x, 350),
        "Memory answers what you know, how you know it, and what changed.",
        font=font("regular", 32),
        fill=FG_SOFT,
    )

    d.line([(x, 438), (SIZE[0] - x, 438)], fill=LINE, width=2)

    # Only claims that can be checked, and only ones that do not expire.
    # The test count was here first and had to go: a number baked into a PNG
    # is a number no checker can grep, and a stale figure in the image every
    # share renders is the same bug that was just fixed in four documents.
    facts = [("Local-first", OK), ("Zero dependencies", ACCENT), ("AGPL-3.0", ACCENT_2)]
    at = x
    small = font("mono", 30)
    gap = 22
    for i, (text, colour) in enumerate(facts):
        if i:
            at += gap
            # Centred on the text's own height rather than sharing its
            # baseline, so the separator sits between the words instead of
            # hanging below them.
            d.ellipse([at, 499, at + 6, 505], fill=FG_SOFT)
            at += 6 + gap
        d.text((at, 486), text, font=small, fill=colour)
        at += int(d.textlength(text, font=small))

    d.text((x, 552), "github.com/Nulfied/Chitraq", font=font("regular", 26), fill=FG_SOFT)

    image.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT}  {SIZE[0]}x{SIZE[1]}  {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
