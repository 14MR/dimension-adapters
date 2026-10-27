import axios from "axios";
import { PromisePool } from "@supercharge/promise-pool";
import { sleep } from "../utils/utils";

// Provable API v2 is the public Aleo node/indexer RPC: https://docs.provable.com/docs/api/v2/intro
const ALEO_RPC = "https://api.provable.com/v2/mainnet";

// Documented public rate limit is 5 req/s: https://docs.provable.com/docs/api/v2/intro
const CONCURRENCY = 3;

// Retry budget for the transient proxy failures described on aleoGet.
const RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 500;

// `/programs/:programID/latest-calls/paginated` serves the program's full call history, newest
// first, via keyset pagination. The cursor parameters must be spelled exactly `cursor_block_number`
// and `cursor_transition_id` - any other name is silently ignored and the first page is returned
// again. The node rejects a `limit` above 50, so that is the most a page can carry.
const PAGE_SIZE = 50;

// The walk has no natural end other than the cursor running out, so bound it: a cursor that keeps
// advancing without reaching the window would otherwise spin indefinitely. 4000 pages is 200k calls,
// several years of headroom at current volume, and reaching it means something is wrong rather than
// that the history is long.
const MAX_PAGES = 4000;

// Head pages walked while catching up to what is already cached before giving up and starting the
// walk over. Ten pages is 500 calls, far more than arrives between two windows of the same run.
const MAX_HEAD_PAGES = 10;

// `/blocks/transactions` serves at most this many blocks per call, the same cap as snarkOS v4.12's
// route it mirrors (MAX_BLOCK_TRANSACTIONS_RANGE in node/rest/src/routes.rs).
const BLOCKS_TRANSACTIONS_RANGE = 160;

// Mainnet genesis block timestamp, the lower bound of every height search.
const GENESIS_TIMESTAMP = 1725462000;

// A height search interpolates on block time and falls back to bisection, so it needs about
// log2(height) reads at worst. 64 is beyond that for any u32 height; reaching it means the node's
// timestamps are not monotonic, which should fail the run.
const MAX_SEARCH_STEPS = 64;

export interface AleoProgramCall {
  transaction_id: string;
  function_id: string;
  block_number: number;
  block_timestamp: number;
  status: string;
}

/** Raw shapes the node returns, narrowed at the boundary rather than trusted as `any`. */
interface RawProgramCall {
  transaction_id: string;
  function_id: string;
  block_number: number;
  block_timestamp: string | number;
  status: string;
}

interface RawPaginatedCalls {
  calls: RawProgramCall[];
  next_cursor: AleoCursor | null;
  prev_cursor: AleoCursor | null;
}

interface RawTransaction {
  execution?: { transitions?: AleoTransition[] };
}

export interface AleoTransition {
  program: string;
  function: string;
  inputs: { type: string; value?: string }[];
  outputs: { type: string; value?: string }[];
}

/**
 * A transaction as a block confirmed it. A rejected execution or deployment is replaced by a `fee`
 * transaction that only carries its fee, so `transaction.fee` is where every fee is, accepted or not.
 */
export interface AleoConfirmedTransaction {
  status: string;
  type: string;
  transaction: { type: string; id: string; fee?: { transition: AleoTransition } };
}

interface RawBlock {
  header: { metadata: { height: number; timestamp: number } };
}

/** A timeout or dropped socket (no response at all), rate limiting, or a server-side failure. */
function isTransient(e: unknown): boolean {
  if (!axios.isAxiosError(e)) return false;
  const status = e.response?.status;
  return status === undefined || status === 429 || status >= 500;
}

/**
 * The public endpoint sits behind a proxy that intermittently returns 502/522 under load, so each
 * read is retried with a backoff before the error is allowed to fail the run.
 */
async function aleoGet(path: string, attempt = 0): Promise<unknown> {
  try {
    // axios rather than fetchURL: fetchURL rejects a falsy body, and `null` is the node's normal
    // answer for a mapping key that has no entry, which is a value here and not a failure.
    const { data } = await axios.get(`${ALEO_RPC}${path}`, { timeout: 30000 });
    return data ?? null;
  } catch (e) {
    // Five attempts backing off from 500ms doubles to 8s of waiting, which clears the proxy's
    // transient 502/522 bursts; beyond that the endpoint is genuinely down and the run should fail.
    // A 4xx is the node rejecting the request itself, so retrying it only delays the same failure.
    if (!isTransient(e) || attempt >= RETRY_ATTEMPTS - 1) throw e;
    await sleep(RETRY_BASE_MS * 2 ** attempt);
    return aleoGet(path, attempt + 1);
  }
}

/**
 * Reads a value out of a program mapping. Returns null when the key has no entry - Aleo finalizers
 * distinguish `get` from `get_or_use`, so an absent key is a normal state, not an error.
 */
export async function getAleoMappingValue(programId: string, mapping: string, key: string): Promise<string | null> {
  const value = await aleoGet(`/program/${programId}/mapping/${mapping}/${key}`);
  if (value === null || value === undefined) return null; // absent key, a normal finalizer state
  if (typeof value !== "string") throw new Error(`aleo: ${programId}/${mapping}/${key} is not a plaintext value`);
  return value;
}

interface AleoCursor {
  block_number: number;
  transition_id: string;
}

interface CallWalk {
  calls: AleoProgramCall[]; // newest first
  cursor: AleoCursor | null; // where to resume walking backwards; null once history is exhausted
  pages: number; // pages fetched so far, bounded by MAX_PAGES
  chain: Promise<void>; // serialises concurrent extensions of the same walk
}

// Concurrent first callers must share one head request rather than each starting a rival walk.
const walkInit: Record<string, Promise<CallWalk>> = {};

/** Identity of a call: unique per (block, transaction, function), which the node guarantees. */
const callKey = (call: AleoProgramCall) => `${call.block_number}:${call.transaction_id}:${call.function_id}`;

/** Program calls arrive with block_timestamp as a string; make it a number once, at the edge. */
const normalise = (call: RawProgramCall): AleoProgramCall => ({ ...call, block_timestamp: Number(call.block_timestamp) });

/** One page of a program's call history, plus the cursor that continues it backwards. */
async function fetchPage(programId: string, cursor: AleoCursor | null) {
  const query = cursor
    ? `?limit=${PAGE_SIZE}&cursor_block_number=${cursor.block_number}&cursor_transition_id=${cursor.transition_id}`
    : `?limit=${PAGE_SIZE}`;
  const page = (await aleoGet(`/programs/${programId}/latest-calls/paginated${query}`)) as RawPaginatedCalls | null;
  if (!page || !Array.isArray(page.calls))
    throw new Error(`aleo: unexpected paginated latest-calls response for ${programId}`);
  return { calls: page.calls.map(normalise), next: page.next_cursor ?? null };
}

/**
 * Pulls in calls accepted since the walk was built. The cached head goes stale the moment a new
 * block lands, so every request re-reads the head and stitches the new calls on rather than trusting
 * what it already has. Normally that is a single page.
 */
async function refreshHead(programId: string, walk: CallWalk): Promise<void> {
  const known = new Set(walk.calls.slice(0, PAGE_SIZE * MAX_HEAD_PAGES).map(callKey));
  const fresh: AleoProgramCall[] = [];
  let cursor: AleoCursor | null = null;

  for (let page = 0; page < MAX_HEAD_PAGES; page++) {
    const { calls, next } = await fetchPage(programId, cursor);
    if (!calls.length) break;
    const overlap = calls.findIndex((call) => known.has(callKey(call)));
    fresh.push(...(overlap === -1 ? calls : calls.slice(0, overlap)));
    if (overlap !== -1 || !next) {
      if (fresh.length) walk.calls.unshift(...fresh);
      return;
    }
    cursor = next;
  }

  // More new calls than we are willing to stitch: keep what we just read and walk back from there.
  if (fresh.length) {
    walk.calls = fresh;
    walk.cursor = cursor;
  }
}

/**
 * Accepted + rejected calls to a program back to `sinceTimestamp`, newest first.
 *
 * The node offers no time or block filter, so reaching a window means paging back from the head.
 * The walk is therefore cached per program and extended, not repeated: a run that covers 24 hourly
 * windows pages the history once rather than once per window.
 */
export async function getAleoProgramCallsSince(programId: string, sinceTimestamp: number): Promise<AleoProgramCall[]> {
  if (!walkInit[programId])
    walkInit[programId] = (async () => {
      const first = await fetchPage(programId, null);
      if (!first.calls.length) throw new Error(`aleo: no calls returned for ${programId}`);
      return {
        calls: first.calls,
        cursor: first.next,
        pages: 1,
        chain: Promise.resolve(),
      };
    })().catch((e) => {
      delete walkInit[programId];
      throw e;
    });

  const walk = await walkInit[programId];

  const work = async () => {
    // Newest first: pick up anything added since the walk was built, then reach back as needed.
    await refreshHead(programId, walk);
    while (walk.cursor && walk.calls[walk.calls.length - 1].block_timestamp >= sinceTimestamp) {
      if (walk.pages >= MAX_PAGES)
        throw new Error(
          `aleo: walked ${walk.pages} pages of ${programId} calls without reaching ${sinceTimestamp}`
        );
      const { calls, next } = await fetchPage(programId, walk.cursor);
      walk.pages++;
      if (!calls.length) {
        walk.cursor = null; // reached the program's first call
        break;
      }
      walk.calls.push(...calls);
      walk.cursor = next;
    }
  };

  // Slots run concurrently; keep one walk in flight so pages are not fetched twice.
  walk.chain = walk.chain.then(work, work);
  await walk.chain;
  return walk.calls;
}

/** Fetches transactions by id and returns the transitions of each, keyed by transaction id. */
export async function getAleoTransactionTransitions(transactionIds: string[]): Promise<Record<string, AleoTransition[]>> {
  const transitions: Record<string, AleoTransition[]> = {};
  const { errors } = await PromisePool.withConcurrency(CONCURRENCY)
    .for(transactionIds)
    .process(async (id) => {
      const tx = (await aleoGet(`/transaction/${id}`)) as RawTransaction | null;
      transitions[id] = tx?.execution?.transitions ?? [];
    });
  if (errors.length) throw errors[0];
  return transitions;
}

async function getAleoBlockTimestamp(height: number): Promise<number> {
  const block = (await aleoGet(`/block/${height}`)) as RawBlock | null;
  const timestamp = block?.header?.metadata?.timestamp;
  if (typeof timestamp !== "number") throw new Error(`aleo: block ${height} has no timestamp`);
  return timestamp;
}

/**
 * Returns the first block height whose timestamp is at or after `timestamp`. Aleo has no lookup by
 * time, so this searches block timestamps. It throws when the chain has not reached `timestamp`
 * yet, since the block that would bound the window does not exist.
 */
export async function getAleoHeightAtOrAfter(timestamp: number): Promise<number> {
  if (timestamp <= GENESIS_TIMESTAMP) return 0;

  // Invariant: the block at `lo` is before `timestamp` and the block at `hi` is not.
  let lo = 0;
  let loTimestamp = GENESIS_TIMESTAMP;
  let hi = Number(await aleoGet("/block/height/latest"));
  let hiTimestamp = await getAleoBlockTimestamp(hi);
  if (hiTimestamp < timestamp)
    throw new Error(`aleo: chain has not reached ${timestamp} yet (block ${hi} is at ${hiTimestamp})`);

  let bisect = false;
  for (let step = 0; hi - lo > 1; step++) {
    if (step >= MAX_SEARCH_STEPS) throw new Error(`aleo: no block found at ${timestamp} in ${MAX_SEARCH_STEPS} reads`);
    // Block time is close to constant, so interpolating usually lands within a few blocks. When it
    // does not halve the range, the next step bisects so the search never degrades below log2.
    const span = hi - lo;
    const guess = bisect
      ? lo + Math.floor(span / 2)
      : lo + Math.floor(((timestamp - loTimestamp) * span) / Math.max(hiTimestamp - loTimestamp, 1));
    const height = Math.min(Math.max(guess, lo + 1), hi - 1);
    const blockTimestamp = await getAleoBlockTimestamp(height);
    if (blockTimestamp < timestamp) {
      lo = height;
      loTimestamp = blockTimestamp;
    } else {
      hi = height;
      hiTimestamp = blockTimestamp;
    }
    bisect = hi - lo > span / 2;
  }
  return hi;
}

/** Fetches the confirmed transactions of every block in [startHeight, endHeight), in block order. */
export async function getAleoBlocksTransactions(startHeight: number, endHeight: number): Promise<AleoConfirmedTransaction[]> {
  const ranges: [number, number][] = [];
  for (let start = startHeight; start < endHeight; start += BLOCKS_TRANSACTIONS_RANGE)
    ranges.push([start, Math.min(start + BLOCKS_TRANSACTIONS_RANGE, endHeight)]);

  const blocks: AleoConfirmedTransaction[][][] = new Array(ranges.length);
  const { errors } = await PromisePool.withConcurrency(CONCURRENCY)
    .for(ranges)
    .process(async ([start, end], index) => {
      // Without allow_partial the node rejects a range it has not fully indexed, rather than
      // returning the missing heights as empty blocks.
      const response = await aleoGet(`/blocks/transactions?start=${start}&end=${end}`);
      if (!Array.isArray(response) || response.length !== end - start)
        throw new Error(`aleo: expected ${end - start} blocks of transactions for ${start}..${end}`);
      blocks[index] = response as AleoConfirmedTransaction[][];
    });
  if (errors.length) throw errors[0];
  return blocks.flat(2);
}

export type AleoValue = string | AleoValue[] | { [key: string]: AleoValue };

const STRUCTURAL = new Set(["{", "}", "[", "]", ",", ":"]);

const TOKEN = /\s*([{}\[\],:]|[^{}\[\],:\s]+)\s*/y;

/**
 * Parses the Aleo plaintext that the RPC returns for mapping values, public inputs/outputs and
 * future arguments: `{ pool: 123field, zero_for_one: true, amount_in: 4500u128 }`.
 */
export function parseAleoPlaintext(plaintext: string): AleoValue {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < plaintext.length) {
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(plaintext);
    // A sticky match that fails, or consumes nothing, means the input is not Aleo plaintext.
    if (!match || TOKEN.lastIndex === at)
      throw new Error(`aleo: unparsable plaintext at offset ${at}: ${plaintext}`);
    tokens.push(match[1]);
  }

  let position = 0;
  const value = (): AleoValue => {
    const token = tokens[position];
    if (token === undefined) throw new Error(`aleo: unexpected end of plaintext: ${plaintext}`);
    if (token === "{") {
      position++;
      const struct: { [key: string]: AleoValue } = {};
      while (tokens[position] !== "}") {
        const key = tokens[position++];
        if (key === undefined) throw new Error(`aleo: unterminated struct in plaintext: ${plaintext}`);
        if (tokens[position++] !== ":") throw new Error(`aleo: malformed struct in plaintext: ${plaintext}`);
        if (Object.prototype.hasOwnProperty.call(struct, key))
          throw new Error(`aleo: duplicate struct key ${key} in plaintext: ${plaintext}`);
        struct[key] = value();
        // Members are comma separated; anything else here means the input is not what we think.
        if (tokens[position] === ",") position++;
        else if (tokens[position] !== "}")
          throw new Error(`aleo: expected ',' or '}' after struct member ${key} in plaintext: ${plaintext}`);
      }
      position++;
      return struct;
    }
    if (token === "[") {
      position++;
      const array: AleoValue[] = [];
      while (tokens[position] !== "]") {
        array.push(value());
        if (tokens[position] === ",") position++;
        else if (tokens[position] !== "]")
          throw new Error(`aleo: expected ',' or ']' after array element in plaintext: ${plaintext}`);
      }
      position++;
      return array;
    }
    // `}`, `]`, `,` and `:` are structure, never values: `{a:]}` must not parse as { a: "]" }.
    if (STRUCTURAL.has(token))
      throw new Error(`aleo: unexpected '${token}' where a value was expected in plaintext: ${plaintext}`);
    position++;
    return token;
  };
  const parsed = value();
  // Trailing tokens mean the input was not a single well-formed value; do not return a partial parse.
  if (position !== tokens.length)
    throw new Error(`aleo: trailing tokens in plaintext after position ${position}: ${plaintext}`);
  return parsed;
}

/** Strips the Aleo integer suffix (`u8`, `u128`, `i32`, ...) and returns a BigInt. */
export function aleoBigInt(value: AleoValue): bigint {
  if (typeof value !== "string") throw new Error(`aleo: expected a literal, got ${JSON.stringify(value)}`);
  return BigInt(value.replace(/(u|i)\d+$/, ""));
}

/** Same as aleoBigInt for values known to fit a JS number, e.g. hop counts and decimals. */
export function aleoNumber(value: AleoValue): number {
  return Number(aleoBigInt(value));
}

/** Aleo plaintext booleans are the bare words `true` and `false`. */
export function aleoBool(value: AleoValue): boolean {
  if (value !== "true" && value !== "false") throw new Error(`aleo: expected a bool, got ${JSON.stringify(value)}`);
  return value === "true";
}

/** The first public output of a transition - Shield Swap returns swap and position ids this way. */
export function firstPublicOutput(transition: AleoTransition): string {
  const output = transition.outputs.find((o) => o.type === "public");
  if (!output?.value) throw new Error(`aleo: ${transition.program}/${transition.function} has no public output`);
  return output.value;
}

/**
 * Arguments of a transition's finalize future, with the nested futures of imported programs dropped
 * so that the remaining entries line up with the finalizer's own parameters.
 */
export function futureArguments(transition: AleoTransition): AleoValue[] {
  const future = transition.outputs.find((o) => o.type === "future");
  if (!future?.value) throw new Error(`aleo: ${transition.program}/${transition.function} has no future output`);
  const parsed = parseAleoPlaintext(future.value);
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`aleo: malformed future output`);
  const args = parsed.arguments;
  if (!Array.isArray(args)) throw new Error(`aleo: malformed future arguments`);
  return args.filter((arg) => !(typeof arg === "object" && !Array.isArray(arg) && "_program_id" in arg));
}
