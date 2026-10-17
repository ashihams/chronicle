import { ArkivValidationError, type Attrs } from './arkiv/types.js';
import { MAX_STRING_BYTES, MAX_USER_ATTRIBUTES, utf8Length, validateAttrs } from './arkiv/limits.js';
import { sha256Hex } from './hash.js';
import { SCHEMA_V, ObservationBuildError, truncateUtf8 } from './observation.js';
import { linksFingerprint } from './index-links.js';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface IndexSnapshotLink {
  doc_id: string;
  title: string;
}

export interface IndexSnapshotPayload {
  links: IndexSnapshotLink[];
}

export interface IndexSnapshotInput {
  indexId: string;
  indexMode: string;
  observedAt: number;
  links: { docId: string; title: string }[];
}

function fail(msg: string): never {
  throw new ObservationBuildError(msg);
}

function finish(attrs: Attrs): Attrs {
  const n = Object.keys(attrs).length;
  if (n > MAX_USER_ATTRIBUTES) fail(`too many attributes (${n} > ${MAX_USER_ATTRIBUTES})`);
  try {
    validateAttrs(attrs);
  } catch (err) {
    if (err instanceof ArkivValidationError) fail(err.message);
    throw err;
  }
  return attrs;
}

/** Attributes for an `index_snapshot` entity (stretch S2). */
export function buildIndexSnapshotAttrs(input: IndexSnapshotInput): Attrs {
  if (!ID_RE.test(input.indexId)) fail(`index_id "${input.indexId}" must be a lowercase id`);
  if (!MODE_RE.test(input.indexMode)) fail(`index_mode "${input.indexMode}" must be a lowercase slug`);
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) {
    fail('observed_at must be a non-negative integer (unix seconds)');
  }
  const fp = linksFingerprint(input.links);
  const linksSha = sha256Hex(fp);
  if (utf8Length(linksSha) > MAX_STRING_BYTES) fail('links_sha256 too long');
  return finish({
    type: 'index_snapshot',
    schema_v: SCHEMA_V,
    index_id: input.indexId,
    index_mode: truncateUtf8(input.indexMode, MAX_STRING_BYTES),
    observed_at: input.observedAt,
    link_count: input.links.length,
    links_sha256: linksSha,
  });
}

export function buildIndexSnapshotPayload(links: { docId: string; title: string }[]): IndexSnapshotPayload {
  const sorted = [...links].sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));
  return {
    links: sorted.map((l) => ({
      doc_id: l.docId,
      title: l.title.length <= 120 ? l.title : `${l.title.slice(0, 119)}…`,
    })),
  };
}
