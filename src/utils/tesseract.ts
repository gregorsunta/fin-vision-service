import { createWorker, OEM, type Worker as TesseractWorker } from 'tesseract.js';
import { getConfig } from '../config/index.js';
import { createLogger } from './logger.js';

const log = createLogger('utils.tesseract');

/**
 * Tesseract workers are heavy: ~50 MB resident per worker and ~3–5 s to
 * initialize (language traineddata download on first run). We keep one
 * language worker and one OSD worker per process, shared across all calls.
 *
 * The OSD worker is separate because `osd` traineddata is incompatible with
 * language traineddata in the same worker instance.
 */

let langWorkerPromise: Promise<TesseractWorker> | null = null;
let osdWorkerPromise: Promise<TesseractWorker> | null = null;

export async function getTesseractWorker(): Promise<TesseractWorker> {
  if (!langWorkerPromise) {
    const langs = getConfig().TESSERACT_LANGS;
    log.info({ langs }, 'initializing tesseract language worker');
    langWorkerPromise = createWorker(langs).catch((err) => {
      langWorkerPromise = null;
      log.error({ err, langs }, 'failed to initialize tesseract language worker');
      throw err;
    });
  }
  return langWorkerPromise;
}

export async function getOsdWorker(): Promise<TesseractWorker> {
  if (!osdWorkerPromise) {
    log.info('initializing tesseract OSD worker');
    osdWorkerPromise = createWorker('osd', OEM.TESSERACT_ONLY).catch((err) => {
      osdWorkerPromise = null;
      log.error({ err }, 'failed to initialize tesseract OSD worker');
      throw err;
    });
  }
  return osdWorkerPromise;
}

/**
 * Terminate any initialized Tesseract workers. Call from graceful shutdown
 * handlers; safe to call multiple times. After shutdown, subsequent getters
 * will re-initialize.
 */
export async function shutdownTesseractWorkers(): Promise<void> {
  const pending: Promise<unknown>[] = [];
  if (langWorkerPromise) {
    pending.push(
      langWorkerPromise
        .then((w) => w.terminate())
        .catch((err) => log.warn({ err }, 'error terminating language worker')),
    );
    langWorkerPromise = null;
  }
  if (osdWorkerPromise) {
    pending.push(
      osdWorkerPromise
        .then((w) => w.terminate())
        .catch((err) => log.warn({ err }, 'error terminating OSD worker')),
    );
    osdWorkerPromise = null;
  }
  await Promise.all(pending);
}
