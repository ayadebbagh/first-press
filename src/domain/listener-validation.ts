export const LISTENER_VALIDATION_VERSION = 'spotify-listeners-v1';
export const MAX_OBSERVATION_BYTES = 16_384;
const DAY = 86_400_000;
type RecordValue = Record<string, unknown>;
export interface ObservationInput extends RecordValue {
  artistId: string;
  sourceEventKey: string;
  provider?: unknown;
  metric?: unknown;
  providerArtistId?: unknown;
  listenerCount?: unknown;
  sourceUrl?: unknown;
  evidence?: unknown;
  parserVersion?: unknown;
  observedAt?: unknown;
  fetchedAt?: unknown;
  sourceUpdatedAt?: unknown;
  correctsObservationId?: string;
  reviewReason?: string;
}
export const isRecord = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const shortText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export function observationEnvelope(value: unknown): ObservationInput {
  const fields = ['artistId','sourceEventKey','provider','metric','providerArtistId','listenerCount','sourceUrl','evidence','parserVersion','observedAt','fetchedAt','sourceUpdatedAt','correctsObservationId','reviewReason'];
  if (!isRecord(value) || Object.keys(value).some(key => !fields.includes(key)) ||
    !shortText(value.artistId,200) || !shortText(value.sourceEventKey,200) ||
    (value.correctsObservationId !== undefined && !shortText(value.correctsObservationId,200)) ||
    (value.reviewReason !== undefined && !shortText(value.reviewReason,2000))) throw new Error('Invalid observation envelope.');
  return value as ObservationInput;
}
// Canonical UTC ISO strings prevent ambiguous locales, rolled-over dates and
// timezone-less timestamps. Invalid values remain intact in the raw submission.
function instant(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length !== 24) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date : null;
}
function count(value: unknown): bigint | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 1e12) return null;
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^[1-9]\d{0,12}$/.test(value)) return null;
  const result = BigInt(value);
  return result <= 1_000_000_000_000n ? result : null;
}
export interface ValidationContext {
  now: Date;
  artist: { spotifyArtistId: string; status: string; synthetic: boolean };
  previous?: { listenerCount: bigint; observedAt: Date };
  disputed: boolean;
  correction?: { status: 'accepted'|'quarantined'; reasons: string[] };
}
export function validateListenerObservation(input: ObservationInput, context: ValidationContext) {
  const reasons: string[] = [];
  const add = (condition: boolean, reason: string) => { if (condition) reasons.push(reason); };
  const value = count(input.listenerCount);
  const observed = instant(input.observedAt), fetched = instant(input.fetchedAt);
  const updated = input.sourceUpdatedAt === null || input.sourceUpdatedAt === undefined ? null : instant(input.sourceUpdatedAt);
  add(input.provider !== 'spotify','provider_mismatch');
  add(input.metric !== 'monthly_listeners','metric_mismatch');
  add(input.providerArtistId !== context.artist.spotifyArtistId,'artist_identity_mismatch');
  add(context.artist.status !== 'active' || context.artist.synthetic,'artist_unavailable');
  add(context.disputed,'disputed_history_requires_incident_review');
  add(value === null,'invalid_listener_count');
  add(input.sourceUrl !== `https://open.spotify.com/artist/${context.artist.spotifyArtistId}`,'source_url_mismatch');
  const evidence = input.evidence;
  add(!isRecord(evidence) || Object.keys(evidence).some(key => !['reference','sha256'].includes(key)) ||
    !shortText(evidence.reference,2000) || typeof evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sha256),'invalid_evidence');
  add(!shortText(input.parserVersion,100),'missing_parser_version');
  add(!observed,'invalid_observed_at'); add(!fetched,'invalid_fetched_at');
  add(input.sourceUpdatedAt !== undefined && input.sourceUpdatedAt !== null && !updated,'invalid_source_updated_at');
  if (observed) {
    add(observed > context.now,'future_observation');
    add(context.now.getTime() - observed.getTime() > DAY,'stale_observation');
    if (context.previous) add(observed <= context.previous.observedAt,'out_of_order_observation');
  }
  if (fetched) add(fetched > context.now,'future_fetch');
  if (observed && fetched) add(fetched < observed,'fetch_precedes_observation');
  if (updated && observed) add(updated > observed,'source_update_after_observation');
  if (updated) add(context.now.getTime() - updated.getTime() > DAY,'stale_source_update');
  const prior = context.previous?.listenerCount;
  const outlier = value !== null && prior !== undefined && (value > prior ? value-prior : prior-value)*100n >= prior*50n;
  // A separate successor of a quarantined outlier can record an operator's
  // explicit confirmation. A generic reason can never bypass hard failures.
  const confirmedOutlier = context.correction?.status === 'quarantined' &&
    context.correction.reasons.includes('listener_change_requires_review') &&
    typeof input.reviewReason === 'string' && input.reviewReason.trim().length >= 20;
  add(outlier && !confirmedOutlier,'listener_change_requires_review');
  add(context.correction?.status === 'accepted','accepted_correction_requires_incident_review');
  add(input.reviewReason !== undefined && !input.correctsObservationId,'review_requires_quarantined_parent');
  return { status: reasons.length ? 'quarantined' as const : 'accepted' as const,
    reasons, listenerCount: value, observedAt: observed, fetchedAt: fetched, sourceUpdatedAt: updated };
}
