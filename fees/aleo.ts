import { FetchOptions, ProtocolType, SimpleAdapter } from "../adapters/types";
import { CHAIN } from "../helpers/chains";
import { METRIC } from "../helpers/metrics";
import {
  AleoConfirmedTransaction,
  aleoBigInt,
  getAleoBlocksTransactions,
  getAleoHeightAtOrAfter,
} from "../helpers/aleo";

// Every Aleo transaction pays a base fee plus an optional priority fee, in microcredits.
// credits.aleo `fee_public`/`fee_private` take both from the payer and credit no one, and snarkVM
// then adds only the priority fees of a block's transactions back into that block's staking reward
// (ledger/src/advance.rs: `priority_fee_amount()` -> `block_reward`). So the priority fee is paid
// to stakers and the base fee is burned. Rejected transactions still pay their fee.
// https://github.com/ProvableHQ/snarkVM/blob/mainnet/ledger/src/advance.rs
// https://github.com/ProvableHQ/snarkVM/blob/mainnet/ledger/block/src/helpers/target.rs
const MICROCREDITS_PER_CREDIT = 1e6;

// Where the base and priority fee sit among each fee function's inputs, as snarkVM reads them
// (Fee::base_amount / Fee::priority_amount). Both are public inputs even in `fee_private`, whose
// first input is the private record the fee is paid from.
// https://github.com/ProvableHQ/snarkVM/blob/mainnet/ledger/block/src/transaction/fee/mod.rs
const FEE_INPUTS: Record<string, { base: number; priority: number }> = {
  fee_public: { base: 0, priority: 1 },
  fee_private: { base: 1, priority: 2 },
};

function feeAmounts({ transaction }: AleoConfirmedTransaction): { base: bigint; priority: bigint } {
  const transition = transaction.fee?.transition;
  // An execution without a fee transition pays nothing, as in Transaction::fee_amount.
  if (!transition) return { base: 0n, priority: 0n };

  const indexes = FEE_INPUTS[transition.function];
  if (transition.program !== "credits.aleo" || !indexes)
    throw new Error(`Unexpected fee transition ${transition.program}/${transition.function} in ${transaction.id}`);

  const input = (index: number) => {
    const value = transition.inputs[index]?.value;
    if (!value) throw new Error(`Fee transition of ${transaction.id} has no public input ${index}`);
    return aleoBigInt(value);
  };
  return { base: input(indexes.base), priority: input(indexes.priority) };
}

const fetch = async (options: FetchOptions) => {
  // A block belongs to the window its timestamp falls in, so the window is the blocks from the
  // first at or after its start to the first at or after its end.
  const [startHeight, endHeight] = await Promise.all([
    getAleoHeightAtOrAfter(options.startTimestamp),
    getAleoHeightAtOrAfter(options.endTimestamp),
  ]);
  const transactions = await getAleoBlocksTransactions(startHeight, endHeight);

  let base = 0n;
  let priority = 0n;
  for (const transaction of transactions) {
    const fees = feeAmounts(transaction);
    base += fees.base;
    priority += fees.priority;
  }

  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances();
  const dailySupplySideRevenue = options.createBalances();

  dailyFees.addCGToken("aleo", Number(base) / MICROCREDITS_PER_CREDIT, METRIC.TRANSACTION_BASE_FEES);
  dailyFees.addCGToken("aleo", Number(priority) / MICROCREDITS_PER_CREDIT, METRIC.TRANSACTION_PRIORITY_FEES);
  dailyRevenue.addCGToken("aleo", Number(base) / MICROCREDITS_PER_CREDIT, METRIC.TRANSACTION_BASE_FEES);
  dailySupplySideRevenue.addCGToken("aleo", Number(priority) / MICROCREDITS_PER_CREDIT, METRIC.TRANSACTION_PRIORITY_FEES);

  return { dailyFees, dailyRevenue, dailyHoldersRevenue: dailyRevenue, dailySupplySideRevenue };
};

const adapter: SimpleAdapter = {
  version: 2,
  pullHourly: true,
  fetch,
  chains: [CHAIN.ALEO],
  // Mainnet genesis block timestamp.
  start: "2024-09-04",
  protocolType: ProtocolType.CHAIN,
  methodology: {
    Fees: "Transaction fees (base fees + priority fees) paid by users, including fees paid by rejected transactions",
    Revenue: "Base fees, which are burned",
    HoldersRevenue: "Base fees, which are burned",
    SupplySideRevenue: "Priority fees, which are added to the block reward and paid to stakers",
  },
  breakdownMethodology: {
    Fees: {
      [METRIC.TRANSACTION_BASE_FEES]: "Base fees paid by users",
      [METRIC.TRANSACTION_PRIORITY_FEES]: "Priority fees paid by users",
    },
    Revenue: {
      [METRIC.TRANSACTION_BASE_FEES]: "Base fees burned",
    },
    HoldersRevenue: {
      [METRIC.TRANSACTION_BASE_FEES]: "Base fees burned",
    },
    SupplySideRevenue: {
      [METRIC.TRANSACTION_PRIORITY_FEES]: "Priority fees paid to stakers through the block reward",
    },
  },
};

export default adapter;
