/**
 * The single place in the repo that imports @arkiv-network/sdk. Everything else goes through
 * the ArkivClient interface; the probe script uses these re-exports for raw experiments.
 */
export {
  createPublicClient,
  createWalletClient,
  ENTITY_EVENTS_ABI,
  ExpirationTime,
  NoEntityFoundError,
  EntityMutationError,
  MAX_ATTRIBUTES,
  MAX_PAYLOAD_BYTES,
  jsonToPayload,
} from '@arkiv-network/sdk';
export type { Entity } from '@arkiv-network/sdk';
export { addr, bool, dec, i32, key, str, u64, u256 } from '@arkiv-network/sdk/attr';
export type { AnyArkivValue, ArkivValue, AttributeInputs } from '@arkiv-network/sdk/attr';
export { webSocket } from 'viem';
export { and, eq, gt, gte, lt, lte, startsWith } from '@arkiv-network/sdk/query';
export type { Expression } from '@arkiv-network/sdk/query';
export { tiramisu } from '@arkiv-network/sdk/chains';

/**
 * Address that emits Arkiv entity events. Copied from the SDK's internal `src/consts.ts`
 * (ARKIV_ADDRESS), which the package does not export. See arkiv/friction.md.
 */
export const ARKIV_PROCESSOR_ADDRESS = '0x4400000000000000000000000000000000000044' as const;
