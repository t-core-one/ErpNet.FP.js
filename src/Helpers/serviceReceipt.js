/**
 * Service receipts ("СЛУЖЕБЕН БОН"): free text printed by the fiscal device
 * outside the fiscal memory, e.g. a ПКО/РКО voucher for a cash movement.
 *
 * Legally (Наредба Н-18, as amended by ДВ бр. 80/2018) a registered device may
 * issue service receipts only in expressly listed cases — among them documents
 * certifying service-deposited/withdrawn amounts — and NEVER for a sale or a
 * customer order. Nothing here can enforce that; the caller decides what to
 * print. Keep sale-like content off these.
 *
 * This module is the device-independent half: it turns the request into the
 * physical lines a driver will print. The drivers decide the line width and
 * whether the device aligns text itself.
 */

/** A hard ceiling, so a runaway request cannot unroll the whole paper roll. */
export const MAX_SERVICE_RECEIPT_LINES = 120;

const ALIGNMENTS = { left: 'left', center: 'center', centre: 'center', right: 'right' };

/**
 * Validate and normalise the request into logical lines.
 *
 * Accepts `{ Lines: [...] }` (or `lines`), where each entry is a string or
 * `{ Text, Bold, DoubleHeight, Align }`. Embedded newlines split a string into
 * several lines with the same style.
 *
 * Control characters are removed. They are not cosmetic here: bytes below 0x20
 * frame the ISL protocol, and TAB is the Datecs X family's field separator — a
 * TAB inside the text would silently shift every following parameter.
 *
 * @returns {{ lines?: object[], error?: string }}
 */
export function normalizeServiceReceiptLines(doc) {
  const raw = doc && (doc.Lines || doc.lines);
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Lines is required: a non-empty list of text lines' };
  }
  const lines = [];
  for (const entry of raw) {
    const item = (entry !== null && typeof entry === 'object') ? entry : { Text: entry };
    const text = String(item.Text ?? item.text ?? '');
    const align = ALIGNMENTS[String(item.Align ?? item.align ?? 'left').toLowerCase()] || 'left';
    const style = {
      Bold: Boolean(item.Bold ?? item.bold),
      DoubleHeight: Boolean(item.DoubleHeight ?? item.doubleHeight),
      Align: align,
    };
    for (const part of text.split(/\r\n|\r|\n/)) {
      const clean = part
        .replace(/\t/g, ' ')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1F\x7F]/g, '')
        .replace(/\s+$/, '');
      lines.push({ Text: clean, ...style });
    }
  }
  return { lines };
}

/**
 * Wrap at word boundaries; a single word longer than the line is cut.
 *
 * Runs of spaces inside a line are kept — a voucher's signature line
 * ("Получил:      .........") depends on them.
 */
export function wrapWords(text, width) {
  if (text.length <= width) {
    return [text];
  }
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      out.push(line);
      line = word;
    }
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  out.push(line);
  return out;
}

/**
 * Turn logical lines into the physical lines to print.
 *
 * Every line is wrapped to `width`: the devices TRUNCATE a long free-text line
 * silently (the P/C manual says so outright), and the part lost is the end of
 * the line — on a voucher, the amount. When the device cannot align text itself,
 * centre/right alignment is done here with spaces.
 *
 * @param {object[]} lines        from normalizeServiceReceiptLines
 * @param {number}   width        usable characters per line on this device
 * @param {boolean}  padAlignment true when the device has no alignment of its own
 */
export function layoutServiceReceipt(lines, width, padAlignment) {
  const out = [];
  for (const line of lines) {
    for (const segment of wrapWords(line.Text, width)) {
      let text = segment;
      if (padAlignment && line.Align !== 'left' && text.length < width) {
        const gap = width - text.length;
        text = line.Align === 'right'
          ? ' '.repeat(gap) + text
          : ' '.repeat(Math.floor(gap / 2)) + text;
      }
      out.push({ ...line, Text: text });
    }
  }
  if (out.length > MAX_SERVICE_RECEIPT_LINES) {
    throw new Error(
      `A service receipt may have at most ${MAX_SERVICE_RECEIPT_LINES} printed lines; `
      + `this one needs ${out.length}`,
    );
  }
  return out;
}
