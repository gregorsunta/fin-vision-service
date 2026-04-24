# ML Fine-Tuning Plan — fin-vision-service

## Trenutno stanje

LLM (Gemini) + prompt engineering. Free tier: 1000 klicev/mesec.

Točnost na raznolikih slovenskih računih: ~82-88%. Preostanek gre v `needs_review` → ročni approve.

Prompt ima: `receiptFormat` deklaracijo, branje `lineTotal` direktno iz računa, date swap heuristiko, razlikovanje stolpec/vrstica za popuste.

---

## Faza 1 — Zbiranje podatkov (zdaj → ~500 popravljenih računov)

Nič posebnega za delati. Sistem že zbira vse kar potrebujemo:

| Vir | Kaj vsebuje |
|---|---|
| `receipt_edit_history` | Vsak popravek uporabnika = labeled correction |
| `reviewStatus = 'reviewed'` | Uporabnik potrdil da je račun pravilen = visokokakovostni primer |
| `editedAt IS NULL` + `reviewStatus = 'not_required'` | AI je pravilno prebral, brez popravkov = pozitiven primer |
| `receiptFormat` v `processingMetadata` | Label formata računa za vsak primer |

**Trigger za prehod v Fazo 2:** ~500 računov z `reviewStatus = 'reviewed'` ali `editedAt IS NOT NULL`.

---

## Faza 2 — Export training dataseta

Skript: `scripts/export-training-data.ts`

```typescript
// Generira training_data.jsonl iz baze
// Par: { imagePath, groundTruth: JSON } za vsak popravljeni/potrjeni račun
// Razmerje: 80% train, 20% validation (drži stran, ne treniraš na tem)
```

Format za Donut (HuggingFace):
```jsonl
{"image": "/path/to/receipt.jpg", "ground_truth": "{\"gt_parse\": {\"merchantName\": \"Hofer\", ...}}"}
```

---

## Faza 3 — Fine-tuning

**Stroj:** MacBook M3 Pro 18GB RAM — dovolj, PyTorch MPS backend.
**Google Colab** ni potreben, je pa alternativa če ne želiš zasesti MacBooka za 8-16 ur.

```bash
# Če MPS dela probleme:
PYTORCH_ENABLE_MPS_FALLBACK=1 python scripts/train_donut.py
```

**Model:** `naver-clova-ix/donut-base` (~200MB, fine-tune na tvojih podatkih)

**Čas:** ~8-16 ur za 500 primerov na M3 Pro

**Strošek:** $0 (lokalno) ali ~$5-10 na RunPod/Colab za hitrejši T4

---

## Faza 4 — Deployment

Fine-tuned model gre na obstoječ Hetzner strežnik — Docker container poleg obstoječih.

RAM zahteve za inference: ~4-6GB (float16). Testirati pred izbiro Hetzner tiera.

Integracija: nov `DonutService` v `src/services/`, ki implementira isti interface kot `AIService`. Zamenjava v `receipt-analysis.ts` je en parameter.

Gemini ostane kot **fallback** za edge case račune (nizka zaupnost Donut outputa).

---

## Pričakovana točnost po fine-tuningu

| | Točnost |
|---|---|
| Zdaj (Gemini + prompt) | ~82-88% |
| Donut fine-tuned (~500 primerov) | ~91-95% |
| Donut fine-tuned (~2000 primerov) | ~94-97% |

Preostanek vedno gre v `needs_review`. 100% avtomatska točnost ne obstaja.

---

## Dolgoročno (opcijsko)

Ko bo dovolj podatkov in vzorcev napak:
- **Few-shot retrieval**: za vsak novi račun poišči 2-3 podobna iz edit_history, vstavi kot primere v prompt (brezplačno, brez infrastrukture)
- **Periodični re-training**: vsake 3-6 mesecev fine-tune z novimi primeri
- **Multi-provider evalvacija**: primerjaj Donut vs Gemini vs Document AI na validation setu, izberi najboljšega per format
