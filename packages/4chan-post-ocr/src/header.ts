/**
 * Recognising 4chan post headers in OCR text, and reading them.
 *
 * Every post header ends the same way, whatever the era or theme:
 *
 *   <name> [tripcode] [(ID: xxxx)] 05/09/15(Sat)04:04:25 [UTC-4] No.47900000
 *
 * Two tests with different jobs. `looksLikeHeader` is deliberately loose: it
 * decides WHERE the headers are, and a header whose digits came out wrong is
 * still a header -- measured on the labelled set, finding them is not the
 * hard part (97% of lines), reading them is. `readHeader` is strict: a pair
 * it returns is a claim that these are the characters on the screen.
 */

/** A digit, or a character OCR commonly mistakes for one. */
const DIGITISH = '[\\dOoIl|SB]';
/**
 * Something shaped like `dd/dd/dd`, tolerating the misreads OCR makes in
 * it. Two-digit groups on BOTH sides of both separators: a laxer test
 * ("digits, slash-like, digit") matches inside a thumbnail's file name --
 * `1204563816.jpg` has `38`, `1`, `6` -- and anchored a crop there.
 */
export const LOOSE_DATE = new RegExp(
  `${DIGITISH}{2}\\W?[/1l|]${DIGITISH}{2}\\W?[/1l|]${DIGITISH}{2}`
);
const LOOSE_NO = new RegExp(`N[o0ae]?\\W{0,2}${DIGITISH}{2,}`);

/** Header-shaped: something date-like, then something `No.<digits>`-like. */
export const looksLikeHeader = (text: string): boolean => {
  const date = LOOSE_DATE.exec(text);
  return date !== null && LOOSE_NO.test(text.slice(date.index));
};

export interface HeaderRead {
  postNo: string;
  /** As printed: `MM/DD/YY(Day)HH:MM` with `:SS` when present. */
  date: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Date, then weekday in brackets, then time; a `UTC-4` from the timezone
 * userscript; then the number.
 *
 * Three slots are deliberately looser than what 4chan prints, each for a
 * misread measured on the labelled set:
 *
 *   - the weekday takes ANY short run of word characters -- it is checked
 *     against the date below rather than trusted, so `Fni`, `Due` or `T`
 *     need not sink the read;
 *   - the time takes its digits with any separators (`2342.30`, `23.44.45`):
 *     the format is fixed, so the colons are put back from the digit count;
 *   - `No` may come out `No0` or `N0`. A post number never starts with 0, so
 *     a 0 there is always part of the label.
 */
const STRICT =
  /(\d\d)\/(\d\d)\/(\d\d)\((\w{0,4})\)([\d:.,;]{4,10}?)(?:UTC[+-]\d+)?N[o0]{1,2}[.,]?([1-9]\d*)/;

/**
 * The (post number, date) a header line spells out, or null.
 *
 * Spaces are dropped first: OCR inserts and omits them freely inside
 * `04/12/07(Thu)23:43:59 No. 24400000`, and neither field contains one.
 *
 * The weekday is redundant -- 4chan prints it from the same timestamp as the
 * date -- which makes it a free check. Unreadable, it is rebuilt from the
 * date. A REAL weekday that disagrees with the date means one of the two was
 * misread and nothing says which, so the read is refused rather than guessed.
 */
export const readHeader = (text: string): HeaderRead | null => {
  const m = STRICT.exec(text.replace(/\s+/g, ''));
  if (!m) {
    return null;
  }
  const [, mm, dd, yy, day, rawTime, postNo] = m as unknown as string[];
  const digits = rawTime!.replace(/\D/g, '');
  if (digits.length !== 4 && digits.length !== 6) {
    return null;
  }
  const [hh, mi, ss] = digits.match(/\d\d/g)!.map(Number);
  if (hh! > 23 || mi! > 59 || (ss ?? 0) > 59) {
    return null;
  }
  const time = digits.match(/\d\d/g)!.join(':');
  const when = new Date(
    Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd))
  );
  // Date.UTC rolls 02/31 over to 03/03; a date that does not survive the
  // round trip was misread.
  if (
    when.getUTCMonth() !== Number(mm) - 1 ||
    when.getUTCDate() !== Number(dd)
  ) {
    return null;
  }
  const weekday = WEEKDAYS[when.getUTCDay()]!;
  if (WEEKDAYS.includes(day!) && day !== weekday) {
    return null;
  }
  return { date: `${mm}/${dd}/${yy}(${weekday})${time}`, postNo: postNo! };
};
