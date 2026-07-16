from fastapi import FastAPI, UploadFile, File
from pydantic import BaseModel
from detector import redact_persons
from pdf_extractor import extract_pdf_tables

app = FastAPI(title="pii-detector", description="PII redaction and PDF extraction for bank statements")


class RedactRequest(BaseModel):
    text: str


class RedactResponse(BaseModel):
    text: str
    persons: int


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/redact-names", response_model=RedactResponse)
def redact_names(req: RedactRequest) -> RedactResponse:
    text, persons = redact_persons(req.text)
    return RedactResponse(text=text, persons=persons)


@app.post("/extract-pdf")
async def extract_pdf(file: UploadFile = File(...)):
    pdf_bytes = await file.read()
    return extract_pdf_tables(pdf_bytes)
