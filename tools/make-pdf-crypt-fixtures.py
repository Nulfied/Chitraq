"""Generate encrypted-PDF fixtures with an implementation that is not ours.

`src/capture/pdf-crypt.js` implements the PDF standard security handler from
the specification. The way that goes wrong is not a crash — it is a key that
is almost right, producing bytes that are almost a content stream, from which
almost-text is extracted and stored as though somebody wrote it.

So it is checked the same way the CCITT decoder is: a document with known
text goes in, pypdf encrypts it, our code decrypts it, and the text that
comes out has to be the text that went in. pypdf shares no code, no tables
and no author with this project.

One lesson carried over from JBIG2. Pillow accepted `compression="jbig2"`,
silently ignored it, and wrote an uncompressed bitmap — a fixture that looked
encoded and was not. So this asserts that each output actually contains an
/Encrypt dictionary and that pypdf itself calls it encrypted, rather than
trusting that asking for encryption produced any.

Every fixture uses an **empty user password** with an owner password set,
which is what the overwhelming majority of real "protected" PDFs are: bank
statements, exam forms, government downloads. They open without a prompt in
any reader and are readable by anyone; the owner password only expresses a
wish about printing and copying.

Usage:  python tools/make-pdf-crypt-fixtures.py
"""

import io
import json
import pathlib
import sys

try:
    from pypdf import PdfReader, PdfWriter
except ImportError:
    sys.exit("This script needs pypdf: pip install pypdf")

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "test" / "fixtures" / "pdf-crypt"

# The sentences the tests assert on. Distinctive enough that a partially
# wrong key cannot produce them by accident.
LINES = [
    "Chitraq decrypts the standard security handler.",
    "The user password is empty and the owner password is not.",
    "Figures that must survive: 1728 columns, 27.26 seconds, 0.35 score.",
]

# The password on the two fixtures that have a real one.
USER_PASSWORD = "open-sesame"

ALGORITHMS = [
    ("rc4-40", "RC4-40"),
    ("rc4-128", "RC4-128"),
    ("aes-128", "AES-128"),
    ("aes-256", "AES-256"),
    ("aes-256-r5", "AES-256-R5"),
]


def plain_pdf() -> bytes:
    """A minimal PDF whose page draws known text.

    Hand-built rather than produced by a library, so the content stream is
    exactly what the test expects to read back out.
    """
    content = "BT /F1 12 Tf 40 240 Td 16 TL\n"
    for line in LINES:
        content += f"({line}) Tj T*\n"
    content += "ET"
    content_bytes = content.encode("latin-1")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(content_bytes)).encode() + b" >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    out = bytearray(b"%PDF-1.7\n")
    offsets = [0]
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += str(i).encode() + b" 0 obj\n" + obj + b"\n"
        if i == 4:
            out += b"stream\n" + content_bytes + b"\nendstream\n"
        out += b"endobj\n"

    xref_at = len(out)
    out += b"xref\n0 " + str(len(objects) + 1).encode() + b"\n"
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        b"trailer\n<< /Size "
        + str(len(objects) + 1).encode()
        + b" /Root 1 0 R >>\nstartxref\n"
        + str(xref_at).encode()
        + b"\n%%EOF"
    )
    return bytes(out)


def encrypt(source: bytes, algorithm: str) -> bytes:
    writer = PdfWriter(clone_from=io.BytesIO(source))
    # Empty user password, owner password set. The common real-world shape.
    writer.encrypt("", owner_password="not-the-user-password", algorithm=algorithm)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    plain = plain_pdf()

    # The unencrypted original is a fixture too: it is what "the same text"
    # is measured against, and it proves the builder produces readable text
    # before encryption is involved at all.
    (OUT / "plain.pdf").write_bytes(plain)
    readable = PdfReader(io.BytesIO(plain)).pages[0].extract_text()
    for line in LINES:
        if line.split(",")[0][:30] not in readable.replace("\n", " "):
            raise ValueError(f"the plain PDF does not contain its own text: {line!r}")
    print(f"plain.pdf            {len(plain):6} bytes, text verified")

    manifest = []
    for name, algorithm in ALGORITHMS:
        data = encrypt(plain, algorithm)

        # Assert it is really encrypted, rather than trusting the request.
        if b"/Encrypt" not in data:
            raise ValueError(f"{name}: no /Encrypt dictionary in the output")
        reader = PdfReader(io.BytesIO(data))
        if not reader.is_encrypted:
            raise ValueError(f"{name}: pypdf does not consider its own output encrypted")

        (OUT / f"{name}.pdf").write_bytes(data)
        manifest.append({"name": name, "algorithm": algorithm, "bytes": len(data)})
        print(f"{name:20} {len(data):6} bytes, /Encrypt present")

    # Two more with a *real* user password, for the refusal path. Without
    # these the suite only proves the happy case, and the failure that
    # matters is the other one: revisions 2 to 4 derive a key from any
    # password at all, so a wrong one decrypted to rubbish and the result
    # was reported as "no text layer, probably a scanned document".
    locked = []
    for name, algorithm in [("user-password-rc4", "RC4-128"), ("user-password-aes", "AES-256")]:
        writer = PdfWriter(clone_from=io.BytesIO(plain))
        writer.encrypt(USER_PASSWORD, owner_password="different-owner", algorithm=algorithm)
        buf = io.BytesIO()
        writer.write(buf)
        (OUT / f"{name}.pdf").write_bytes(buf.getvalue())
        locked.append({"name": name, "algorithm": algorithm, "bytes": len(buf.getvalue())})
        print(f"{name:20} {len(buf.getvalue()):6} bytes, real user password")

    (OUT / "manifest.json").write_text(
        json.dumps(
            {"lines": LINES, "fixtures": manifest, "locked": locked, "password": USER_PASSWORD},
            indent=2,
        )
        + "\n"
    )
    print(f"\n{len(manifest)} encrypted fixtures in {OUT}")


if __name__ == "__main__":
    main()
