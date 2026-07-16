"""
pdfplumber-based PDF table extractor for bank statements.

Returns per-page header text (for IBAN/period detection) and structured table
rows. Unlike positional whitespace reconstruction, pdfplumber detects implicit
column boundaries from line geometry — reliable for standard A4 bank statement
layouts.
"""

import io
import pdfplumber


def extract_pdf_tables(pdf_bytes: bytes) -> dict:
    """
    Returns:
      {
        "pages": [
          {
            "header": "<raw page text for IBAN/date extraction>",
            "rows": [["cell", "cell", ...], ...]   # non-empty table rows
          },
          ...
        ],
        "page_count": N
      }
    """
    pages = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            # Full page text for the header block (IBAN, account holder, period).
            header_text = page.extract_text(x_tolerance=3, y_tolerance=3) or ""

            tables = page.extract_tables()
            page_rows: list[list[str]] = []
            for table in tables:
                for row in table:
                    # Normalize: None cells → empty string, strip whitespace.
                    clean = [(cell or "").strip() for cell in row]
                    if any(clean):
                        page_rows.append(clean)

            pages.append({"header": header_text, "rows": page_rows})

    return {"pages": pages, "page_count": len(pages)}
