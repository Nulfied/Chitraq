/**
 * Reading a scanned PDF, by taking it apart and reading the pictures.
 *
 * This provider knows nothing about models. It serves `ocr.document` by pulling
 * the embedded images out of the file and asking whatever serves `ocr.image` to
 * read each one — so it works with a local vision model today and with anything
 * better later, without a line changing here.
 *
 * That delegation is the whole design. A capability that can be composed out of
 * another capability should be, rather than growing its own vendor adapter with
 * its own key and its own failure modes.
 *
 * Two honest limits it carries rather than hides:
 *
 *   - JBIG2-encoded pages (`JBIG2Decode`) cannot be extracted at all, and are
 *     named in the result instead of quietly dropped. CCITT fax pages used to
 *     be in the same sentence and are now decoded.
 *   - Pages come out in file order, which is usually page order and is not
 *     guaranteed to be. A twenty-page contract read out of sequence is still
 *     readable; a twenty-page contract silently missing page nine is not, so
 *     the count of what was read is always reported.
 */

import { Capability } from '../registry.js';
import { extractPdfImages } from '../../capture/pdf-images.js';

/**
 * @param {object} opts
 * @param {(task: {bytes: Buffer, mediaType: string}) => Promise<any>} opts.readImage
 *        how to read one image — normally the router, aimed at `ocr.image`
 * @param {() => boolean|Promise<boolean>} [opts.canReadImages]
 * @param {number} [opts.maxPages]
 * @returns {import('../registry.js').Provider}
 */
export function pdfOcrProvider(opts) {
  const maxPages = opts.maxPages ?? 20;

  return {
    id: 'pdf-pages',
    label: 'Scanned PDF (page images, read by whatever reads images)',
    locality: 'local',
    cost: 'free',
    deterministic: false,

    // Available exactly when something can read an image. On its own this
    // provider can take a PDF apart and do nothing with the pieces.
    available: async () => (opts.canReadImages ? Boolean(await opts.canReadImages()) : true),

    capabilities: {
      [Capability.OcrDocument]: {
        // Below the direct image path: every page is a second reading of a
        // reading, and the errors compound.
        quality: 0.55,
        latencyMs: 60_000,
        costMicros: 0,
        run: async (task) => {
          const bytes = task.bytes ?? task.document;
          if (!bytes?.length) throw new Error('No document to read.');

          const { images, unreadable } = extractPdfImages(bytes, { limit: maxPages });

          if (!images.length) {
            const why = unreadable.length
              ? unreadable.map((u) => u.reason).join(' ')
              : 'No page images could be extracted from this PDF.';
            throw new Error(why);
          }

          /** @type {string[]} */
          const pages = [];
          /** @type {any[]} */
          const failures = [];

          for (const image of images) {
            try {
              const read = await opts.readImage({ bytes: image.data, mediaType: image.mediaType });
              const text = String(read?.text ?? '').trim();
              if (text) pages.push(text);
            } catch (err) {
              // One unreadable page out of twenty should cost that page. A
              // throw here would discard nineteen good ones.
              failures.push({ index: image.index, error: err?.message ?? String(err) });
            }
          }

          const text = pages.join('\n\n');
          if (!text) throw new Error('The page images were extracted but none of them read as text.');

          return {
            text,
            pagesRead: pages.length,
            pagesFound: images.length,
            // Never silent. A reader deciding whether to trust this needs to
            // know the document was longer than what came back.
            pagesUnreadable: unreadable.length,
            failures,
            method: 'page images extracted from the PDF, each read by a vision capability',
            uncertainty:
              `Read from ${pages.length} page image(s) of ${images.length} found` +
              (unreadable.length
                ? `, with ${unreadable.length} more in an encoding that cannot be extracted. `
                : '. ') +
              'This is a model reading pictures of text, twice removed from what was typed. ' +
              'Page order follows the file rather than the document, and numbers are where it fails.',
          };
        },
      },
    },
  };
}
