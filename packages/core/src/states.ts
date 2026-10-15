export const OBSERVATION_STATES = [
  'present',
  'changed',
  'first_seen',
  'removed_404',
  'removed_410',
  'redirected',
  'soft_removed',
  'unreachable',
  'delisted',
] as const;
export type ObservationState = (typeof OBSERVATION_STATES)[number];

/** States in which the document is gone from its URL. */
export const REMOVAL_STATES: ReadonlySet<ObservationState> = new Set([
  'removed_404',
  'removed_410',
  'redirected',
  'soft_removed',
  'delisted',
]);

/** States with no usable content, so no raw or normalized hash is recorded. */
export const NO_CONTENT_STATES: ReadonlySet<ObservationState> = new Set([...REMOVAL_STATES, 'unreachable']);

export const SOURCE_KINDS = ['page', 'pdf'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
