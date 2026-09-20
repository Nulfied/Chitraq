"""Generate CCITT test fixtures from a second, independent implementation.

The decoder in `src/capture/ccitt.js` is hand-written from the T.4 and T.6
code tables, and the reason to distrust a hand-written decoder is that a
subtly wrong one produces a page that still looks like a page. So it is not
checked against its own output or against anything it produced. It is checked
against Pillow, which carries libtiff's encoder.

This script draws a bitmap, hands it to Pillow to encode as Group 3 or Group
4, pulls the compressed bytes back out of the TIFF container, and writes them
next to the exact pixels that went in. The test then asserts the decoder turns
one into the other with no differing bit anywhere. That is a real oracle: the
encoder shares no code, no tables and no author with the thing being tested.

Pillow is a development dependency of this one script. It is not imported
anywhere in `src/`, is not in `package.json`, and the fixtures are committed,
so tests and CI run with no Python and no Pillow present. Chitraq still has
zero runtime dependencies.

Usage:
    python tools/make-ccitt-fixtures.py              regenerate the fixtures
    python tools/make-ccitt-fixtures.py --fuzz 1000 7   throwaway corpus,
                                                     then tools/fuzz-ccitt.mjs
"""

import io
import json
import pathlib
import random
import struct
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("This script needs Pillow: pip install Pillow")

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "test" / "fixtures" / "ccitt"

# TIFF tags worth naming.
PHOTOMETRIC = 262
STRIP_OFFSETS = 273
ROWS_PER_STRIP = 278
STRIP_BYTE_COUNTS = 279


def tiff_strip(raw: bytes) -> bytes:
    """Pull the single compressed strip out of a TIFF wrapper.

    Written against the container rather than against Pillow's internals, so
    a Pillow upgrade that reorders tags cannot silently hand back the wrong
    bytes. Anything unexpected raises instead of guessing.
    """
    if raw[:2] == b"II":
        order = "<"
    elif raw[:2] == b"MM":
        order = ">"
    else:
        raise ValueError("not a TIFF")

    (ifd_at,) = struct.unpack_from(order + "I", raw, 4)
    (count,) = struct.unpack_from(order + "H", raw, ifd_at)

    tags = {}
    for i in range(count):
        at = ifd_at + 2 + i * 12
        tag, typ, n = struct.unpack_from(order + "HHI", raw, at)
        if typ in (3, 4) and n == 1:
            tags[tag] = (
                struct.unpack_from(order + "H", raw, at + 8)[0]
                if typ == 3
                else struct.unpack_from(order + "I", raw, at + 8)[0]
            )

    for needed in (STRIP_OFFSETS, STRIP_BYTE_COUNTS):
        if needed not in tags:
            raise ValueError("expected exactly one strip; got a multi-strip TIFF")

    start = tags[STRIP_OFFSETS]
    return raw[start : start + tags[STRIP_BYTE_COUNTS]], tags.get(PHOTOMETRIC, 0)


def pack(image: Image.Image) -> bytes:
    """Pack pixels one bit each, MSB leftmost, rows padded to a byte.

    A set bit means white, which is the PDF default: BlackIs1 false means a 0
    bit is black, and one-bit DeviceGray already reads 0 as black. That is the
    layout the decoder must produce, written here from the specification
    rather than from the decoder, so the comparison is against a stated format
    and not against whatever the decoder happened to do.

    A *sample* of 0 is white here, which is the opposite of how mode "1"
    usually reads, and it is not a choice. libtiff codes sample 0 as a white
    run and the photometric tag has no effect on the codec at all — see
    `check_convention`. The images below are drawn to match, so the picture
    and the encoding agree about which pixels are ink.
    """
    width, height = image.size
    row_bytes = (width + 7) // 8
    out = bytearray(row_bytes * height)
    px = image.load()
    for y in range(height):
        for x in range(width):
            if not px[x, y]:
                out[y * row_bytes + (x >> 3)] |= 0x80 >> (x & 7)
    return bytes(out)


def check_convention():
    """Prove, rather than assume, that the encoder calls sample 0 white.

    Everything here depends on it, and it is the kind of thing a library
    upgrade changes quietly: fixtures would still be produced, still look
    plausible, and be inverted. A blank page costs almost nothing to code and
    an all-ink page costs more, so the all-zero image being the cheaper of the
    two says which sample value the codec treats as blank.
    """
    zeros, _ = encode(blank(512, 64, 0), "group4")
    ones, _ = encode(blank(512, 64, 1), "group4")
    if len(zeros) >= len(ones):
        raise ValueError(
            f"encoder no longer treats sample 0 as white "
            f"(all-zero page {len(zeros)}B, all-one page {len(ones)}B); "
            f"every fixture would be inverted"
        )
    print(f"convention checked: blank page {len(zeros)}B vs all-ink {len(ones)}B")


def encode(image: Image.Image, compression: str):
    buf = io.BytesIO()
    # One strip, so the fixture is the whole page rather than a fragment.
    image.save(buf, format="TIFF", compression=compression, rowsperstrip=image.size[1])
    return tiff_strip(buf.getvalue())


INK = 1


def blank(width, height, fill=0):
    """A page of the given sample value. 0 is white — see `pack`."""
    return Image.new("1", (width, height), fill)


def case_text():
    im = blank(400, 120)
    d = ImageDraw.Draw(im)
    d.text((10, 10), "CCITT Group 4 decode check", fill=INK)
    d.text((10, 40), "0123456789 the quick brown fox", fill=INK)
    d.text((10, 70), "jumps over the lazy dog again", fill=INK)
    return im


def case_rects():
    random.seed(19)
    im = blank(600, 400)
    d = ImageDraw.Draw(im)
    for _ in range(120):
        x = random.randrange(590)
        y = random.randrange(390)
        d.rectangle([x, y, x + random.randrange(1, 40), y + random.randrange(1, 20)], fill=INK)
    return im


def case_all_white():
    return blank(200, 50, 0)


def case_all_black():
    return blank(200, 50, 1)


def case_hairlines():
    """Single-pixel features, where an off-by-one in b1 shows up immediately."""
    im = blank(300, 200)
    d = ImageDraw.Draw(im)
    for x in range(0, 300, 7):
        d.line([(x, 0), (x, 199)], fill=INK)
    for y in range(0, 200, 11):
        d.line([(0, y), (299, y)], fill=INK)
    return im


def case_edges():
    """Black touching both margins, which is where clamping goes wrong."""
    im = blank(128, 64)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 127, 3], fill=INK)
    d.rectangle([0, 60, 127, 63], fill=INK)
    d.rectangle([0, 10, 5, 50], fill=INK)
    d.rectangle([122, 10, 127, 50], fill=INK)
    return im


def case_long_runs():
    """Runs past 2560 pixels, which is the only path through the shared
    makeup codes above 1728."""
    im = blank(4000, 30)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 10, 3999, 19], fill=INK)
    return im


def case_noise():
    """Dense alternation: worst case for 2D coding and full of horizontal
    mode, which the sparser cases barely exercise."""
    random.seed(23)
    im = blank(256, 128)
    px = im.load()
    for y in range(128):
        for x in range(256):
            px[x, y] = INK if random.random() < 0.45 else 0
    return im


CASES = [
    ("text", case_text, ["group4", "group3"]),
    ("rects", case_rects, ["group4", "group3"]),
    ("all-white", case_all_white, ["group4"]),
    ("all-black", case_all_black, ["group4"]),
    ("hairlines", case_hairlines, ["group4", "group3"]),
    ("edges", case_edges, ["group4"]),
    ("long-runs", case_long_runs, ["group4"]),
    ("noise", case_noise, ["group4", "group3"]),
]

# Pillow names them; the decoder wants T.4's K.
K_FOR = {"group4": -1, "group3": 0}


def random_page(rng):
    """One arbitrary page, drawn to land on the decoder's awkward cases.

    The widths are chosen around byte boundaries because that is where the
    padding at the end of a row is decided, and the styles range from a blank
    page to near-random ink because 2D coding behaves completely differently
    at the two ends: mostly vertical modes at one, almost all horizontal at
    the other.
    """
    width = rng.choice(
        [1, 3, 7, 8, 9, 15, 16, 17, 31, 63, 64, 100, 127, 128, 255, 300, 511, 1728, 2000]
    )
    height = rng.randrange(1, 40)
    style = rng.choice(["sparse", "dense", "stripes", "blank", "solid", "blobs"])

    im = blank(width, height, 0)
    d = ImageDraw.Draw(im)

    if style == "solid":
        d.rectangle([0, 0, width - 1, height - 1], fill=INK)
    elif style == "stripes":
        step = rng.randrange(1, 9)
        for x in range(0, width, step):
            d.line([(x, 0), (x, height - 1)], fill=INK)
    elif style == "blobs":
        for _ in range(rng.randrange(1, 12)):
            x, y = rng.randrange(width), rng.randrange(height)
            d.rectangle([x, y, x + rng.randrange(0, 50), y + rng.randrange(0, 8)], fill=INK)
    elif style in ("sparse", "dense"):
        p = 0.05 if style == "sparse" else 0.5
        px = im.load()
        for y in range(height):
            for x in range(width):
                if rng.random() < p:
                    px[x, y] = INK

    return im, style


def fuzz(count, seed, out_dir):
    """Write a throwaway corpus for `tools/fuzz-ccitt.mjs` to check.

    STATUS.md claims the decoder was fuzzed against this encoder over several
    thousand pages. A claim nobody else can run is not much of a claim, so
    this is the thing that was run.
    """
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*"):
        stale.unlink()

    rng = random.Random(seed)
    manifest = []
    for i in range(count):
        image, style = random_page(rng)
        expected = pack(image)
        for compression in ("group4", "group3"):
            data, _ = encode(image, compression)
            stem = f"{i:05d}.{compression}"
            (out / f"{stem}.bin").write_bytes(data)
            (out / f"{stem}.expected").write_bytes(expected)
            manifest.append(
                {
                    "name": stem,
                    "width": image.size[0],
                    "height": image.size[1],
                    "k": K_FOR[compression],
                    "style": style,
                }
            )

    (out / "manifest.json").write_text(json.dumps(manifest))
    print(f"{len(manifest)} cases from {count} pages, seed {seed}, in {out}")
    print(f"now run:  node tools/fuzz-ccitt.mjs {out}")


def main():
    if "--fuzz" in sys.argv:
        at = sys.argv.index("--fuzz")
        count = int(sys.argv[at + 1]) if len(sys.argv) > at + 1 else 500
        seed = int(sys.argv[at + 2]) if len(sys.argv) > at + 2 else 1
        return fuzz(count, seed, REPO / ".ccitt-fuzz")

    OUT.mkdir(parents=True, exist_ok=True)
    check_convention()
    manifest = []

    for name, build, encodings in CASES:
        image = build()
        expected = pack(image)
        width, height = image.size

        for compression in encodings:
            data, _photometric = encode(image, compression)
            stem = f"{name}.{compression}"
            (OUT / f"{stem}.bin").write_bytes(data)
            (OUT / f"{stem}.expected").write_bytes(expected)
            manifest.append(
                {
                    "name": stem,
                    "width": width,
                    "height": height,
                    "k": K_FOR[compression],
                    "encodedBytes": len(data),
                    "rawBytes": len(expected),
                }
            )
            print(f"{stem:24} {width}x{height}  {len(data):>7} bytes from {len(expected)}")

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"\n{len(manifest)} fixtures in {OUT}")


if __name__ == "__main__":
    main()
