import { FetchOptions, SimpleAdapter } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";
import { METRIC } from "../../helpers/metrics";
import { getConfig } from "../../helpers/cache";
import fetchURL from "../../utils/fetchURL";
import { aleoBigInt, getAleoMappingValue, parseAleoPlaintext } from "../../helpers/aleo";

// Shield Swap is a confidential concentrated-liquidity AMM on Aleo.
const AMM = "shield_swap.aleo";

// Fee tiers and the protocol fee split are read from Aleo chain state. Traded amounts come from the
// protocol's indexer: swap sizes are public on the ledger, but the Aleo node RPC serves only the most
// recent calls to a program and has no archival program-call history, so a past day cannot be
// reconstructed from the chain. The indexer's daily volume is the sum of the same public per-swap
// amounts (verified leg by leg against the ledger).
const INDEXER = "https://api.swap.shield.fi";

// The protocol keeps `fee_protocol / 16` of every swap fee and the position keeps the rest.
// https://shield.fi/docs/reference/constants-and-limits
const PROTOCOL_FEE_DENOMINATOR = 16;

// Pool `fee` is a u16 count of parts per million (200 => 0.02%), same source as above.
const FEE_PPM_DENOMINATOR = 1e6;

// Aleo has no on-chain decimal registry - "The AMM uses native token base units directly. It has no
// on-chain decimal scale or normalization registry." (link above) - so the price feed for each
// AMM-side ARC-20 token id is pinned here, matching the Shield Swap TVL adapter.
const COINGECKO_IDS: Record<string, string> = {
  "724721105858008932013114020280511843613117371369744086165619field": "aleo",
  "1926848598207449231969field": "ethereum",
  "2000279227181771747937field": "solana",
  "469661199361043738096225field": "bitcoin",
  "212707628815602939926313406778312270053663804591730917421274098438979020915field": "usd-coin",
  "692801908703609488185757443979064120926167164195545211519073497257699443field": "usd-coin",
  "469367275872013076623969field": "usd-coin",
  "549647506080797045256801field": "tether",
};

interface IndexedPool {
  key: string;
  enabled: boolean;
  token0: string;
  token0_info: { symbol: string; decimals: number };
}

interface OhlcvCandle {
  timestamp: number;
  v: string;
}

/**
 * Fee tier and protocol split of a pool, straight out of the AMM program's mappings. Mappings hold
 * current consensus state and are not logs (https://shield.fi/docs/reference/mappings), so the
 * current split is applied to every backfilled day. It has been 5/16 on every pool since the
 * production deployment was verified on 2026-08-12; the days before that carry dust volume only.
 */
async function getPoolFees(poolKey: string) {
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
    feePpm: Number(aleoBigInt(pool.fee)),
    feeProtocol: Number(aleoBigInt(slotState.fee_protocol)),
  };
}

const fetch = async (options: FetchOptions) => {
  const dailyVolume = options.createBalances();
  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances();
  const dailySupplySideRevenue = options.createBalances();

  const { data: pools }: { data: IndexedPool[] } = await getConfig("shield-swap", `${INDEXER}/pools`);

  for (const pool of pools.filter((p) => p.enabled)) {
    // `v` is the fee-bearing notional of the day in token0 base units, matching the sum of the public
    // per-swap amounts the AMM program settled in that pool, multi-hop legs included.
    const { data: candles }: { data: OhlcvCandle[] } = await fetchURL(
      `${INDEXER}/pools/${pool.key}/ohlcv?granularity=1d&from=${options.startOfDay}&to=${options.startOfDay + 86400}`
    );
    const traded = candles.reduce((sum, candle) => sum + Number(candle.v), 0);
    if (!traded) continue;

    const coingeckoId = COINGECKO_IDS[pool.token0];
    if (!coingeckoId) throw new Error(`shield-swap: no price feed for token ${pool.token0}`);

    const { feePpm, feeProtocol } = await getPoolFees(pool.key);
    const notional = traded / 10 ** pool.token0_info.decimals;
    const fees = (notional * feePpm) / FEE_PPM_DENOMINATOR;
    const revenue = (fees * feeProtocol) / PROTOCOL_FEE_DENOMINATOR;

    dailyVolume.addCGToken(coingeckoId, notional);
    dailyFees.addCGToken(coingeckoId, fees, METRIC.SWAP_FEES);
    dailyRevenue.addCGToken(coingeckoId, revenue, METRIC.PROTOCOL_FEES);
    dailySupplySideRevenue.addCGToken(coingeckoId, fees - revenue, METRIC.LP_FEES);
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
  // Version 1: the indexer only exposes daily buckets for a full backfill.
  version: 1,
  fetch,
  chains: [CHAIN.ALEO],
  // The pools were created and first traded on 2026-07-30.
  start: '2026-07-30',
  methodology: {
    Volume: "Amount traded through each Shield Swap pool per day, denominated in the pool's token0 and counted once per hop of a route.",
    Fees: "Swap volume multiplied by each pool's on-chain fee tier (the pools mapping of shield_swap.aleo stores it as parts per million).",
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
