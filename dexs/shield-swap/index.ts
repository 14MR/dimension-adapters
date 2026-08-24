import { FetchOptions, SimpleAdapter } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";
import { METRIC } from "../../helpers/metrics";
import {
  ALEO_LATEST_CALLS_LIMIT,
  AleoTransition,
  aleoBigInt,
  aleoBool,
  aleoNumber,
  firstPublicOutput,
  futureArguments,
  getAleoMappingValue,
  getAleoProgramCalls,
  getAleoTransactionTransitions,
  parseAleoPlaintext,
} from "../../helpers/aleo";

// Shield Swap is a confidential concentrated-liquidity AMM on Aleo. Swap sizes, routes and pool
// state are public on the ledger, so every number below is read from Aleo chain state.
// https://shield.fi/docs/confidentiality/public-data
const AMM = "shield_swap.aleo";

const SWAP = "swap";
const SWAP_MULTI_HOP = "swap_multi_hop";
const CLAIM = "claim_swap_output";
const CLAIM_NO_REFUND = "claim_swap_output_no_refund";

// The protocol keeps `fee_protocol / PROTOCOL_FEE_DENOMINATOR` of every swap fee; the rest accrues
// to the LP position. `fee_protocol` itself is read per pool from the on-chain `slots` mapping.
// https://shield.fi/docs/reference/constants-and-limits ("The protocol share is fee_protocol / 16")
const PROTOCOL_FEE_DENOMINATOR = 16n;

// Pool `fee` is a u16 count of parts per million (200 => 0.02%), same source as above.
const FEE_PPM_DENOMINATOR = 1_000_000n;

// AMM-side ARC-20 token ids, read off the on-chain `pools` mapping. Aleo carries no decimal
// registry - "The AMM uses native token base units directly. It has no on-chain decimal scale or
// normalization registry." (https://shield.fi/docs/reference/constants-and-limits) - so decimals and
// the price feed are pinned here, matching the Shield Swap TVL adapter.
const TOKENS: Record<string, { symbol: string; decimals: number; coingeckoId: string }> = {
  "724721105858008932013114020280511843613117371369744086165619field": { symbol: "ALEO", decimals: 6, coingeckoId: "aleo" },
  "1926848598207449231969field": { symbol: "ETH", decimals: 18, coingeckoId: "ethereum" },
  "2000279227181771747937field": { symbol: "SOL", decimals: 9, coingeckoId: "solana" },
  "469661199361043738096225field": { symbol: "wBTC", decimals: 8, coingeckoId: "bitcoin" },
  "212707628815602939926313406778312270053663804591730917421274098438979020915field": { symbol: "USDCx", decimals: 6, coingeckoId: "usd-coin" },
  "692801908703609488185757443979064120926167164195545211519073497257699443field": { symbol: "USAD", decimals: 6, coingeckoId: "usd-coin" },
  "469367275872013076623969field": { symbol: "USDC", decimals: 6, coingeckoId: "usd-coin" },
  "549647506080797045256801field": { symbol: "USDT", decimals: 6, coingeckoId: "tether" },
};

interface Pool {
  token0: string;
  token1: string;
  feePpm: bigint;
  feeProtocol: bigint;
}

interface Hop {
  pool: string;
  zeroForOne: boolean;
}

interface Swap {
  swapId: string;
  timestamp: number;
  amountIn: bigint;
  hops: Hop[];
}

interface Claim {
  tokenOut: string;
  amountOut: bigint;
  remainder: bigint;
}

function transitionOf(transitions: AleoTransition[], functionName: string): AleoTransition | undefined {
  return transitions.find((t) => t.program === AMM && t.function === functionName);
}

function parseSwap(transitions: AleoTransition[], timestamp: number): Swap {
  const transition = transitionOf(transitions, SWAP)!;
  // swap(request, token0, token1, swap_id, ...) - the request struct carries pool, direction and size
  const request = futureArguments(transition)[0];
  if (typeof request !== "object" || Array.isArray(request)) throw new Error("shield-swap: malformed swap request");
  return {
    swapId: firstPublicOutput(transition),
    timestamp,
    amountIn: aleoBigInt(request.amount_in),
    hops: [{ pool: request.pool as string, zeroForOne: aleoBool(request.zero_for_one) }],
  };
}

function parseMultiHopSwap(transitions: AleoTransition[], timestamp: number): Swap {
  const transition = transitionOf(transitions, SWAP_MULTI_HOP)!;
  const request = futureArguments(transition)[0];
  if (typeof request !== "object" || Array.isArray(request)) throw new Error("shield-swap: malformed multi-hop request");
  // Routes are 2 or 3 hops; unused hop slots repeat the previous hop, so only hop_count entries count.
  // https://shield.fi/docs/reference/constants-and-limits
  const hopCount = aleoNumber(request.hop_count);
  const hops: Hop[] = [];
  for (let i = 0; i < hopCount; i++) {
    const hop = request[`hop${i}`];
    if (typeof hop !== "object" || Array.isArray(hop)) throw new Error(`shield-swap: malformed hop${i}`);
    hops.push({ pool: hop.pool as string, zeroForOne: aleoBool(hop.zero_for_one) });
  }
  return {
    swapId: firstPublicOutput(transition),
    timestamp,
    amountIn: aleoBigInt(request.amount_in),
    hops,
  };
}

function parseClaim(transitions: AleoTransition[], functionName: string): [string, Claim] {
  const transition = transitionOf(transitions, functionName)!;
  // claim_swap_output(swap_id, token_in, token_out, amount_out, amount_remaining, ...)
  // amount_out is denominated in token_out, amount_remaining in token_in.
  // claim_swap_output_no_refund has no remainder argument.
  const args = futureArguments(transition);
  const swapId = args[0] as string;
  return [swapId, {
    tokenOut: args[2] as string,
    amountOut: aleoBigInt(args[3]),
    remainder: functionName === CLAIM ? aleoBigInt(args[4]) : 0n,
  }];
}

async function getPool(poolKey: string): Promise<Pool> {
  const [poolState, slot] = await Promise.all([
    getAleoMappingValue(AMM, "pools", poolKey),
    getAleoMappingValue(AMM, "slots", poolKey),
  ]);
  if (!poolState || !slot) throw new Error(`shield-swap: pool ${poolKey} is missing on-chain state`);
  const pool = parseAleoPlaintext(poolState);
  const slotState = parseAleoPlaintext(slot);
  if (typeof pool !== "object" || Array.isArray(pool) || typeof slotState !== "object" || Array.isArray(slotState))
    throw new Error(`shield-swap: malformed state for pool ${poolKey}`);
  return {
    token0: pool.token0 as string,
    token1: pool.token1 as string,
    feePpm: aleoBigInt(pool.fee),
    feeProtocol: aleoBigInt(slotState.fee_protocol),
  };
}

const fetch = async (options: FetchOptions) => {
  const dailyVolume = options.createBalances();
  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances();
  const dailySupplySideRevenue = options.createBalances();

  const calls = await getAleoProgramCalls(AMM);
  const accepted = calls.filter((call) => call.status === "Accepted");
  if (!accepted.length) throw new Error("shield-swap: no accepted AMM calls returned by the Aleo RPC");

  // The RPC only exposes the last ALEO_LATEST_CALLS_LIMIT calls, so a window that starts before the
  // oldest call it returns cannot be measured. Fail loudly rather than report a partial number.
  const oldestCall = Math.min(...accepted.map((call) => call.block_timestamp));
  if (oldestCall > options.fromTimestamp)
    throw new Error(
      `shield-swap: the Aleo RPC only exposes the last ${ALEO_LATEST_CALLS_LIMIT} calls to ${AMM} (back to ${oldestCall}), which does not cover the window starting at ${options.fromTimestamp}`
    );

  const swapCalls = accepted.filter(
    (call) =>
      (call.function_id === SWAP || call.function_id === SWAP_MULTI_HOP) &&
      call.block_timestamp >= options.fromTimestamp &&
      call.block_timestamp < options.toTimestamp
  );
  // Claims settle a swap and publish the exact filled output and the unspent input. They can land in
  // a later block than the swap, so every claim the RPC still exposes is read, not just in-window ones.
  const claimCalls = accepted.filter((call) => call.function_id === CLAIM || call.function_id === CLAIM_NO_REFUND);

  const transitions = await getAleoTransactionTransitions([
    ...new Set([...swapCalls, ...claimCalls].map((call) => call.transaction_id)),
  ]);

  const claims: Record<string, Claim> = {};
  for (const call of claimCalls) {
    const [swapId, claim] = parseClaim(transitions[call.transaction_id], call.function_id);
    claims[swapId] = claim;
  }

  const swaps = swapCalls.map((call) =>
    call.function_id === SWAP
      ? parseSwap(transitions[call.transaction_id], call.block_timestamp)
      : parseMultiHopSwap(transitions[call.transaction_id], call.block_timestamp)
  );

  const pools: Record<string, Pool> = {};
  for (const poolKey of new Set(swaps.flatMap((swap) => swap.hops.map((hop) => hop.pool))))
    pools[poolKey] = await getPool(poolKey);

  for (const swap of swaps) {
    const claim = claims[swap.swapId];
    // The tick-walk loop is capped, so a swap can fill partially and refund the rest on claim.
    // An unsettled swap has no published refund yet; partial fills are rare enough that treating it
    // as fully filled is the closest available estimate.
    const filledIn = swap.amountIn - (claim?.remainder ?? 0n);
    if (filledIn <= 0n) continue;

    const entryPool = pools[swap.hops[0].pool];
    const entryTokenId = swap.hops[0].zeroForOne ? entryPool.token0 : entryPool.token1;

    for (const [index, hop] of swap.hops.entries()) {
      const pool = pools[hop.pool];

      // Every pool is quoted against a stablecoin, so a route carries the same notional through each
      // of its hops, less the fee taken on the way. The entry leg's exact input therefore sizes the
      // whole route, and the settled output prices the closing hop slightly more precisely.
      const isClosingHop = index === swap.hops.length - 1;
      const [tokenId, amount] =
        index > 0 && isClosingHop && claim ? [claim.tokenOut, claim.amountOut] : [entryTokenId, filledIn];

      const token = TOKENS[tokenId];
      if (!token) throw new Error(`shield-swap: unknown token ${tokenId} in pool ${hop.pool}`);
      const notional = Number(amount) / 10 ** token.decimals;
      if (!Number.isFinite(notional)) throw new Error(`shield-swap: bad ${token.symbol} amount ${amount}`);

      const fees = (Number(pool.feePpm) / Number(FEE_PPM_DENOMINATOR)) * notional;
      const revenue = (Number(pool.feeProtocol) / Number(PROTOCOL_FEE_DENOMINATOR)) * fees;

      dailyVolume.addCGToken(token.coingeckoId, notional);
      dailyFees.addCGToken(token.coingeckoId, fees, METRIC.SWAP_FEES);
      dailyRevenue.addCGToken(token.coingeckoId, revenue, METRIC.PROTOCOL_FEES);
      dailySupplySideRevenue.addCGToken(token.coingeckoId, fees - revenue, METRIC.LP_FEES);
    }
  }

  return {
    dailyVolume,
    dailyFees,
    dailyUserFees: dailyFees,
    dailyRevenue,
    dailyProtocolRevenue: dailyRevenue,
    dailySupplySideRevenue,
  };
};

const adapter: SimpleAdapter = {
  version: 2,
  // Hourly: the Aleo RPC exposes only the most recent calls to a program, and an hour of Shield Swap
  // activity fits inside that page with room to spare.
  pullHourly: true,
  // Forward-only for the same reason - the public Aleo RPC has no archival program-call history, so
  // a past window cannot be reconstructed and the adapter must always be run on the live window.
  runAtCurrTime: true,
  fetch,
  chains: [CHAIN.ALEO],
  start: '2026-07-30',
  methodology: {
    Volume: "Input notional of every accepted swap and swap_multi_hop call to shield_swap.aleo, read from the public swap request on the Aleo ledger and counted once per hop of the route.",
    Fees: "Swap volume multiplied by each pool's on-chain fee tier (the pools mapping stores it as parts per million).",
    UserFees: "Identical to Fees - traders pay the whole swap fee.",
    Revenue: "The protocol's cut of the swap fee, fee_protocol/16 per the pool's on-chain slots entry.",
    ProtocolRevenue: "Same as Revenue; Shield Swap has no token, so none of it is passed to holders.",
    SupplySideRevenue: "The remaining (16 - fee_protocol)/16 of the swap fee, which accrues to the concentrated-liquidity position that provided it.",
  },
  breakdownMethodology: {
    Fees: {
      [METRIC.SWAP_FEES]: "Swap volume times the pool fee tier read from the on-chain pools mapping.",
    },
    UserFees: {
      [METRIC.SWAP_FEES]: "Swap fees paid by traders.",
    },
    Revenue: {
      [METRIC.PROTOCOL_FEES]: "fee_protocol/16 of the swap fee, retained by the protocol.",
    },
    ProtocolRevenue: {
      [METRIC.PROTOCOL_FEES]: "fee_protocol/16 of the swap fee, retained by the protocol.",
    },
    SupplySideRevenue: {
      [METRIC.LP_FEES]: "(16 - fee_protocol)/16 of the swap fee, credited to liquidity positions.",
    },
  },
};

export default adapter;
