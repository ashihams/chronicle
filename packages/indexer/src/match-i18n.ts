import type { MatchHit, MatchResultKind } from './match.js';

export const REPLY_LANGS = ['en', 'ta', 'hi'] as const;
export type ReplyLang = (typeof REPLY_LANGS)[number];

export function parseReplyLang(raw: string | undefined | null): ReplyLang {
  if (raw === 'ta' || raw === 'hi' || raw === 'en') return raw;
  return 'en';
}

const NO_MATCH: Record<ReplyLang, string> = {
  en: 'No exact match. Treat as unverified. This does not mean it is forged.',
  ta: 'சரியான பொருத்தம் இல்லை. சரிபார்க்கப்படவில்லை எனக் கருதுங்கள். இது போலியானது என்று அர்த்தமல்ல.',
  hi: 'कोई सटीक मिलान नहीं। इसे अपुष्ट मानें। इसका मतलब यह जाली नहीं है।',
};

const SIMILAR: Record<ReplyLang, string> = {
  en: 'Similar, not identical. Near-match by SimHash (Hamming distance ≤ 3). Treat carefully.',
  ta: 'ஒத்தது, ஒன்றல்ல. SimHash அருகாமைப் பொருத்தம். கவனமாகக் கருதுங்கள்.',
  hi: 'समान, एक जैसा नहीं। SimHash निकट-मिलान। सावधानी से देखें।',
};

function utcDay(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function localizedMatchNote(
  result: MatchResultKind,
  hit: MatchHit | null,
  lang: ReplyLang,
  formatDay: (ts: number) => string = utcDay,
): string {
  if (result === 'no_match' || hit === null) return NO_MATCH[lang];
  if (result === 'similar_match') return SIMILAR[lang];
  if (hit.status === 'current') {
    if (lang === 'ta') return `பதிப்பு ${hit.version_seq} பொருந்தியது; இது தற்போதைய பதிப்பு.`;
    if (lang === 'hi') return `संस्करण ${hit.version_seq} मेल खाता है; यह वर्तमान संस्करण है।`;
    return `Matches version ${hit.version_seq}, which is the current version.`;
  }
  const when = hit.superseded_at === null ? '' : ` on ${formatDay(hit.superseded_at)}`;
  const current = hit.current_seq === null ? 'A later version' : `Version ${hit.current_seq}`;
  if (lang === 'ta') {
    return `பதிப்பு ${hit.version_seq} பொருந்தியது (பின்னர் மாற்றப்பட்டது${when}). ${current} தற்போதையது.`;
  }
  if (lang === 'hi') {
    return `संस्करण ${hit.version_seq} मेल खाता है (बाद में बदला गया${when})। ${current} वर्तमान है।`;
  }
  return `Matches version ${hit.version_seq}, which was superseded${when}. ${current} is current.`;
}

export function forgeryReportNote(distinctCreators: number, lang: ReplyLang): string | null {
  if (distinctCreators <= 0) return null;
  if (lang === 'ta') {
    return `${distinctCreators} தனிப் பதிவாளர்கள் இந்த உள்ளடக்க ஹாஷைக் குறித்து அறிக்கை செய்துள்ளனர்.`;
  }
  if (lang === 'hi') {
    return `${distinctCreators} अलग रिपोर्टर्स ने इस कंटेंट हैश की रिपोर्ट की है।`;
  }
  return `${distinctCreators} independent reporter${distinctCreators === 1 ? '' : 's'} flagged this content hash.`;
}
