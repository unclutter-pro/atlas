"""Check whether a PDF has fillable AcroForm fields.

Usage:
  python check_fillable_fields.py <file.pdf>

Prints one of two messages and exits 0. Exits 2 on argument error,
1 on read/parse errors.
"""
import sys
from pypdf import PdfReader


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] in ("-h", "--help"):
        print(__doc__, file=sys.stderr)
        return 2
    try:
        reader = PdfReader(argv[1])
    except Exception as e:
        print(f"error: cannot read {argv[1]}: {e}", file=sys.stderr)
        return 1
    if reader.get_fields():
        print("This PDF has fillable form fields")
    else:
        print("This PDF does not have fillable form fields; you will need to visually determine where to enter data")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
