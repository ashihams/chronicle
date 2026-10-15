import { load } from 'cheerio';
import { normalizeText } from './text.js';

const NOISE_SELECTOR = 'script, style, noscript, nav, header, footer, aside, form, iframe, svg, [aria-hidden=true]';

/**
 * Matched against each class token and the id. `ad-` only counts at the start of a token or after
 * `-`/`_`, so classes like `download-link` or `lead-in` are kept.
 */
const NOISE_TOKEN_RE = /(cookie|banner|advert|(^|[-_])ad-|social|share|breadcrumb|counter|visitor|menu)/i;

const BLOCK_TAGS =
  'p, div, li, tr, td, th, h1, h2, h3, h4, h5, h6, br, section, article, main, table, ul, ol, dl, dt, dd, pre, blockquote, hr';

export const MAX_TITLE_CHARS = 160;

export interface NormalizeHtmlOptions {
  contentSelector?: string;
}

export interface NormalizedHtml {
  text: string;
  title: string | null;
}

function isNoise(classAttr: string | undefined, id: string | undefined): boolean {
  const tokens = [...(classAttr ?? '').split(/\s+/), id ?? ''].filter((t) => t !== '');
  return tokens.some((t) => NOISE_TOKEN_RE.test(t));
}

export function cleanTitle(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const t = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  return t.length > MAX_TITLE_CHARS ? t.slice(0, MAX_TITLE_CHARS) : t;
}

export function normalizeHtml(html: string, opts: NormalizeHtmlOptions = {}): NormalizedHtml {
  const $ = load(html);

  const title = cleanTitle($('title').first().text()) ?? cleanTitle($('h1').first().text());

  let root = opts.contentSelector ? $(opts.contentSelector).first() : $();
  if (root.length === 0) root = $('main').first();
  if (root.length === 0) root = $('article').first();
  if (root.length === 0) root = $('body').first();
  if (root.length === 0) root = $.root();

  root.find(NOISE_SELECTOR).remove();
  root
    .find('[class], [id]')
    .filter((_, el) => isNoise($(el).attr('class'), $(el).attr('id')))
    .remove();

  // Line breaks between blocks keep volatile patterns like `last updated[^.\n]*` from eating
  // the next paragraph.
  root.find(BLOCK_TAGS).each((_, el) => {
    $(el).after('\n');
  });

  return { text: normalizeText(root.text()), title };
}
