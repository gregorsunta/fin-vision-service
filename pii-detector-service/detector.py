"""
Presidio-based personal name detector for bank statement text (Slovenian and
English statements — e.g. domestic banks vs. Revolut).

Detects PERSON entities via spaCy NER and replaces them with [OSEBA]. ORG and
LOC entities are intentionally preserved — merchant names must remain visible
for AI transaction categorisation.
"""

import re

from langdetect import detect, DetectorFactory, LangDetectException
from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig
from presidio_analyzer.recognizer_result import RecognizerResult

# Deterministic detection — langdetect is otherwise seeded from wall-clock time,
# which would make redaction non-reproducible across identical inputs.
DetectorFactory.seed = 0

_nlp_config = {
    "nlp_engine_name": "spacy",
    "models": [
        {"lang_code": "sl", "model_name": "sl_core_news_sm"},
        {"lang_code": "en", "model_name": "en_core_web_sm"},
    ],
}

_provider = NlpEngineProvider(nlp_configuration=_nlp_config)
_nlp_engine = _provider.create_engine()

analyzer = AnalyzerEngine(
    nlp_engine=_nlp_engine,
    supported_languages=["sl", "en"],
)
anonymizer = AnonymizerEngine()

_PERSON_OPERATOR = {"PERSON": OperatorConfig("replace", {"new_value": "[OSEBA]"})}

# spaCy sl_core_news_sm is trained on news text and generates many false
# positives on bank statement content (merchant names, column headers, codes).
# Only accept detections above this confidence score.
_SCORE_THRESHOLD = 0.75

# Personal names are typically 2–40 characters. Reject spans outside this
# range — single letters and very long spans are almost always false positives.
_MIN_NAME_LEN = 3
_MAX_NAME_LEN = 40

# Month names/abbreviations (Slovenian + English, full and 3-letter forms).
# These get mis-tagged as PERSON often enough to matter — a redacted month
# breaks the AI's date parsing (pdf-ai-parser.ts needs the month to build an
# ISO date), so we protect them explicitly rather than relying on NER score.
_MONTH_NAMES = {
    "jan", "januar", "january",
    "feb", "februar", "february",
    "mar", "marec", "march",
    "apr", "april",
    "maj", "may",
    "jun", "junij", "june",
    "jul", "julij", "july",
    "avg", "aug", "avgust", "august",
    "sep", "sept", "september",
    "okt", "oct", "oktober", "october",
    "nov", "november",
    "dec", "december",
}


# Legal-entity suffixes and Slovenian/generic institutional keyword stems.
# NER regularly confuses municipalities/agencies for PERSON entities (e.g.
# "Občina Podlehnik", a municipality). Keep in sync with
# `INSTITUTIONAL_KEYWORDS` in src/services/bank-statement/pii-filter.ts,
# which uses the same list the other way round (to *require* one of these
# before treating a transfer counterparty as safe to leave unredacted).
_INSTITUTIONAL_KEYWORDS = [
    "d.o.o", "d.d.", "s.p.", "z.o.o", "gmbh", "ltd", "uab", "s.r.o", "plc",
    "obcin", "obč", "ministrstv", "mddsz", "zavod", "zzzs", "furs", "durs",
    "uprav", "davk", "davč", "davc", "prispevk", "neposredn", "placil", "plačil",
    "sklad", "agencij", "banka", "skupnost", "republi",
]


def _plausible_name(span_text: str) -> bool:
    """Return True only for spans that look like actual personal names."""
    stripped = span_text.strip()
    length = len(stripped)
    if length < _MIN_NAME_LEN or length > _MAX_NAME_LEN:
        return False
    # Reject spans that are purely numeric (amounts, dates, codes).
    if stripped.replace(" ", "").replace(".", "").replace(",", "").isdigit():
        return False
    if stripped.rstrip(".").lower() in _MONTH_NAMES:
        return False
    lower = stripped.lower()
    if any(kw in lower for kw in _INSTITUTIONAL_KEYWORDS):
        return False
    return True


def _detect_language(text: str) -> str:
    """Pick the dominant language for the whole document.

    Running the wrong-language model over the *entire* document (as opposed
    to a single embedded name) is what caused the original bug: a small
    spaCy model has no signal for words outside its training language and
    tags boilerplate/merchant text almost at random. So we still pick one
    model for the bulk of the document. Defaults to Slovenian on detection
    failure, matching this service's primary statement source.
    """
    try:
        lang = detect(text)
    except LangDetectException:
        return "sl"
    return "en" if lang == "en" else "sl"


# Text is treated as "shouting" (all-caps, as Slovenian bank PDFs frequently
# render whole statements) when at least this fraction of its letters are
# uppercase. Below that, casing already carries a name signal and forcing it
# through .title() would destroy it (e.g. English "April" / "EUR" get
# capitalised into looking like proper nouns and mis-tagged as PERSON).
#
# NOTE: this is intentionally whole-document, not per-line. Per-line
# shouting detection was tried and reverted — individual transaction lines
# in tabular statements are legitimately mostly-uppercase (merchant name +
# reference codes), so per-line title-casing flipped merchant names like
# "MUELLER" into "Mueller" and got them mis-tagged as PERSON. A single
# all-caps counterparty name embedded in an otherwise normal-case document
# (e.g. Revolut's "Transfer to GREGOR SUNTA") can still slip through this
# way — known gap, needs a structured recognizer, not a broader NER pass.
_SHOUTING_UPPER_RATIO = 0.8


def _is_shouting(text: str) -> bool:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return False
    upper = sum(1 for c in letters if c.isupper())
    return (upper / len(letters)) >= _SHOUTING_UPPER_RATIO


def redact_persons(text: str) -> tuple[str, int]:
    """Return (redacted_text, count_of_redacted_entities)."""
    language = _detect_language(text)
    analysis_text = text.title() if _is_shouting(text) else text
    raw_results: list[RecognizerResult] = analyzer.analyze(
        text=analysis_text,
        language=language,
        entities=["PERSON"],
        score_threshold=_SCORE_THRESHOLD,
    )

    # A PERSON span should never legitimately cross a line break in this
    # tabular statement text — a name is always printed on one physical
    # line. When the NER model does match across a newline anyway (observed:
    # rare but real), clip the span to end at that newline rather than
    # passing it through as-is. Otherwise the anonymizer replaces the whole
    # multi-line span with a single "[OSEBA]" token and silently deletes the
    # line break, merging two transaction rows into one — invisible unless
    # something downstream depends on line structure (which the local
    # bank-statement parsers now do).
    for r in raw_results:
        span = text[r.start:r.end]
        newline_pos = span.find("\n")
        if newline_pos != -1:
            r.end = r.start + newline_pos

    # A PERSON span should never legitimately start with a monetary amount
    # either — a leading digit/./,/space run is a balance or amount value
    # that the model occasionally merges with an adjacent capitalised
    # merchant name into one span (observed: "1.208,06 Lidl Slovenija"
    # matched as a single entity, since the numeric-only guard in
    # _plausible_name only rejects spans that are *purely* numeric, not
    # spans that start numeric and extend into text). Strip any such
    # leading numeric prefix from the span before redacting so the amount
    # survives untouched.
    for r in raw_results:
        span = text[r.start:r.end]
        m = re.match(r"^[\d.,]+\s*", span)
        if m:
            r.start += m.end()

    # Apply plausibility filter on the matched span from the original text.
    results = [
        r for r in raw_results
        if r.start < r.end and _plausible_name(text[r.start:r.end])
    ]

    if not results:
        return text, 0

    anonymized = anonymizer.anonymize(
        text=text,
        analyzer_results=results,
        operators=_PERSON_OPERATOR,
    )
    return anonymized.text, len(results)
