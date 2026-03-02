const SUBGRAPH_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL || '';

export type Belief = {
  id: string;
  beliefText: string;
  attester: string;
  totalStaked: string;
  stakerCount: number;
  createdAt: string;
  lastStakedAt: string;
};

/** Result of getBeliefs: success with data, or failure with a message (avoids ambiguous empty array on error). */
export type GetBeliefsResult =
  | { ok: true; beliefs: Belief[] }
  | { ok: false; error: string };

const SUBGRAPH_TIMEOUT_MS = 15_000;

async function subgraphFetch(query: string, variables?: Record<string, unknown>) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SUBGRAPH_TIMEOUT_MS);

  const response = await fetch(SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ query, variables }),
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`Subgraph returned ${response.status}`);
  }

  const json = await response.json();
  if (json.errors) {
    console.error('[subgraph] errors:', json.errors);
  }
  if (json.data?._meta) {
    console.log('[subgraph] indexed block:', json.data._meta.block.number, '| errors:', json.data._meta.hasIndexingErrors);
  }
  return json;
}

export type Stake = {
  id: string;
  staker: string;
  amount: string;
  stakedAt: string;
  unstakedAt: string | null;
  active: boolean;
  transactionHash: string;
  belief?: Belief;
};

/**
 * Fetch all beliefs, sorted by total staked (descending).
 * Returns a result object so callers can distinguish success (possibly empty) from network/API errors.
 */
export async function getBeliefs(): Promise<GetBeliefsResult> {
  if (!SUBGRAPH_URL) {
    console.warn('SUBGRAPH_URL not configured');
    return { ok: false, error: 'Subgraph not configured' };
  }

  const query = `
    query GetBeliefs {
      beliefs(first: 100, where: { totalStaked_gt: "0" }, orderBy: totalStaked, orderDirection: desc) {
        id
        beliefText
        attester
        totalStaked
        stakerCount
        createdAt
        lastStakedAt
      }
      _meta { block { number } hasIndexingErrors }
    }
  `;

  try {
    const json = await subgraphFetch(query);
    if (json.errors?.length) {
      const msg = json.errors[0]?.message ?? 'GraphQL errors';
      console.error('[subgraph] getBeliefs errors:', json.errors);
      return { ok: false, error: msg };
    }
    const beliefs = json.data?.beliefs ?? [];
    return { ok: true, beliefs };
  } catch (error) {
    let message = 'Failed to fetch';
    if (error instanceof Error) {
      message = error.name === 'AbortError' ? 'Request timed out' : error.message;
    }
    console.error('Error fetching beliefs:', error);
    return { ok: false, error: message };
  }
}

/**
 * Fetch a single belief by its attestation UID
 */
export async function getBelief(uid: string): Promise<Belief | null> {
  if (!SUBGRAPH_URL) {
    console.warn('SUBGRAPH_URL not configured');
    return null;
  }

  const query = `
    query GetBelief($id: ID!) {
      belief(id: $id) {
        id
        beliefText
        attester
        totalStaked
        stakerCount
        createdAt
        lastStakedAt
      }
    }
  `;

  try {
    const json = await subgraphFetch(query, { id: uid });
    return json.data?.belief || null;
  } catch (error) {
    console.error('Error fetching belief:', error);
    return null;
  }
}

/**
 * Fetch all stakes for a specific belief
 */
export async function getBeliefStakes(beliefId: string): Promise<Stake[]> {
  if (!SUBGRAPH_URL) {
    console.warn('SUBGRAPH_URL not configured');
    return [];
  }

  const query = `
    query GetBeliefStakes($beliefId: String!) {
      stakes(where: { belief: $beliefId }, orderBy: stakedAt, orderDirection: asc) {
        id
        staker
        amount
        stakedAt
        unstakedAt
        active
        transactionHash
      }
    }
  `;

  try {
    const json = await subgraphFetch(query, { beliefId });
    return json.data?.stakes || [];
  } catch (error) {
    console.error('Error fetching belief stakes:', error);
    return [];
  }
}

/**
 * Fetch all active stakes for a specific address (for account page)
 */
export async function getAccountStakes(address: string): Promise<(Stake & { belief: Belief })[]> {
  if (!SUBGRAPH_URL) {
    console.warn('SUBGRAPH_URL not configured');
    return [];
  }

  const normalizedAddress = address.toLowerCase();

  const query = `
    query GetAccountStakes($staker: Bytes!) {
      stakes(where: { staker: $staker, active: true }, orderBy: stakedAt, orderDirection: desc) {
        id
        staker
        amount
        stakedAt
        unstakedAt
        active
        transactionHash
        belief {
          id
          beliefText
          attester
          totalStaked
          stakerCount
          createdAt
          lastStakedAt
        }
      }
    }
  `;

  try {
    const json = await subgraphFetch(query, { staker: normalizedAddress });
    return json.data?.stakes || [];
  } catch (error) {
    console.error('Error fetching account stakes:', error);
    return [];
  }
}
