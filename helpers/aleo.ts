import { PromisePool } from "@supercharge/promise-pool";
import fetchURL from "../utils/fetchURL";
import { sleep } from "../utils/utils";

// Provable API v2 is the public Aleo node/indexer RPC: https://docs.provable.com/docs/api/v2/intro
const ALEO_RPC = "https://api.provable.com/v2/mainnet";

// Documented public rate limit is 5 req/s: https://docs.provable.com/docs/api/v2/intro
const CONCURRENCY = 3;

// `/programs/:programID/latest-calls` returns the most recent calls only; the node caps the page at
// this many entries, so a caller can never look further back than the last LATEST_CALLS_LIMIT calls.
export const ALEO_LATEST_CALLS_LIMIT = 1000;

export interface AleoProgramCall {
  transaction_id: string;
  function_id: string;
  block_number: number;
  block_timestamp: number;
  status: string;
}

export interface AleoTransition {
  program: string;
  function: string;
  inputs: { type: string; value?: string }[];
  outputs: { type: string; value?: string }[];
}

/**
 * The public endpoint sits behind a proxy that intermittently returns 502/522 under load, so each
 * read is retried with a backoff before the error is allowed to fail the run.
 */
async function aleoGet(path: string, attempt = 0): Promise<any> {
  try {
    return await fetchURL(`${ALEO_RPC}${path}`);
  } catch (e) {
    if (attempt >= 4) throw e;
    await sleep(500 * 2 ** attempt);
    return aleoGet(path, attempt + 1);
  }
}

/**
 * Reads a value out of a program mapping. Returns null when the key has no entry - Aleo finalizers
 * distinguish `get` from `get_or_use`, so an absent key is a normal state, not an error.
 */
export async function getAleoMappingValue(programId: string, mapping: string, key: string): Promise<string | null> {
  const value = await aleoGet(`/program/${programId}/mapping/${mapping}/${key}`);
  return value ?? null;
}

/** Accepted + rejected calls to a program, newest first. */
export async function getAleoProgramCalls(programId: string): Promise<AleoProgramCall[]> {
  const calls = await aleoGet(`/programs/${programId}/latest-calls`);
  if (!Array.isArray(calls)) throw new Error(`aleo: unexpected latest-calls response for ${programId}`);
  return calls.map((call: any) => ({ ...call, block_timestamp: Number(call.block_timestamp) }));
}

/** Fetches transactions by id and returns the transitions of each, keyed by transaction id. */
export async function getAleoTransactionTransitions(transactionIds: string[]): Promise<Record<string, AleoTransition[]>> {
  const transitions: Record<string, AleoTransition[]> = {};
  const { errors } = await PromisePool.withConcurrency(CONCURRENCY)
    .for(transactionIds)
    .process(async (id) => {
      const tx = await aleoGet(`/transaction/${id}`);
      transitions[id] = tx?.execution?.transitions ?? [];
    });
  if (errors.length) throw errors[0];
  return transitions;
}

export type AleoValue = string | AleoValue[] | { [key: string]: AleoValue };

const TOKEN = /\s*([{}\[\],:]|[^{}\[\],:\s]+)/;

/**
 * Parses the Aleo plaintext that the RPC returns for mapping values, public inputs/outputs and
 * future arguments: `{ pool: 123field, zero_for_one: true, amount_in: 4500u128 }`.
 */
export function parseAleoPlaintext(plaintext: string): AleoValue {
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < plaintext.length) {
    const match = TOKEN.exec(plaintext.slice(cursor));
    if (!match || match.index !== 0) break;
    tokens.push(match[1]);
    cursor += match[0].length;
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
        if (tokens[position++] !== ":") throw new Error(`aleo: malformed struct in plaintext: ${plaintext}`);
        struct[key] = value();
        if (tokens[position] === ",") position++;
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
      }
      position++;
      return array;
    }
    position++;
    return token;
  };
  return value();
}

/** Strips the Aleo integer suffix (`u8`, `u128`, `i32`, ...) and returns a BigInt. */
export function aleoBigInt(value: AleoValue): bigint {
  if (typeof value !== "string") throw new Error(`aleo: expected a literal, got ${JSON.stringify(value)}`);
  return BigInt(value.replace(/(u|i)\d+$/, ""));
}

export function aleoNumber(value: AleoValue): number {
  return Number(aleoBigInt(value));
}

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
