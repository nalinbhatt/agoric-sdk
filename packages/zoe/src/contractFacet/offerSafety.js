// @ts-check

import { AmountMath } from '@agoric/ertp';
import { natSafeMath } from '../contractSupport/safeMath.js';

const { entries } = Object;

/**
 * Helper to perform satisfiesWant and satisfiesGive. How many times
 * does the `allocation` satisfy the `giveOrWant`?
 *
 * @param {AmountKeywordRecord} giveOrWant
 * @param {AmountKeywordRecord} allocation
 * @param {bigint} infinity Simply any number big enough that we don't care if
 * the correct answer is even larger, but is misreported as this number instead.
 * @returns {bigint}
 */
const satisfiesInternal = (giveOrWant = {}, allocation, infinity) => {
  /** @type {bigint | undefined} */
  let multiples = infinity;
  for (const [keyword, requiredAmount] of entries(giveOrWant)) {
    if (allocation[keyword] === undefined) {
      return 0n;
    }
    const allocationAmount = allocation[keyword];
    if (!AmountMath.isGTE(allocationAmount, requiredAmount)) {
      return 0n;
    }
    if (typeof requiredAmount.value !== 'bigint') {
      multiples = 1n;
    } else if (requiredAmount.value > 0n) {
      assert.typeof(allocationAmount.value, 'bigint');
      const howMany = natSafeMath.floorDivide(
        allocationAmount.value,
        requiredAmount.value,
      );
      if (multiples > howMany) {
        multiples = howMany;
      }
    }
  }
  return multiples;
};

/**
 * For this allocation to satisfy what the user wanted, their
 * allocated amounts must be greater than or equal to proposal.want.
 * Even if multiples > 1n, this succeeds if it satisfies just one
 * unit of want.
 *
 * @param {ProposalRecord} proposal - the rules that accompanied the
 * escrow of payments that dictate what the user expected to get back
 * from Zoe. A proposal is a record with keys `give`, `want`, and
 * `exit`. `give` and `want` are records with keywords as keys and
 * amounts as values. The proposal is a user's understanding of the
 * contract that they are entering when they make an offer.
 * @param {AmountKeywordRecord} allocation - a record with keywords
 * as keys and amounts as values. These amounts are the reallocation
 * to be given to a user.
 */
export const satisfiesWant = (proposal, allocation) =>
  satisfiesInternal(proposal.want, allocation, 1n) >= 1n;
harden(satisfiesWant);

/**
 * For this allocation to count as a full refund, the allocated
 * amounts must be greater than or equal to what was originally
 * offered (proposal.give).
 *
 * @param  {ProposalRecord} proposal - the rules that accompanied the
 * escrow of payments that dictate what the user expected to get back
 * from Zoe. A proposal is a record with keys `give`, `want`, and
 * `exit`. `give` and `want` are records with keywords as keys and
 * amounts as values. The proposal is a user's understanding of the
 * contract that they are entering when they make an offer.
 * @param  {AmountKeywordRecord} allocation - a record with keywords
 * as keys and amounts as values. These amounts are the reallocation
 * to be given to a user.
 */
// Commented out because not currently used
// const satisfiesGive = (proposal, allocation) =>
//   satisfiesInternal(proposal.give, allocation) >= 1n;

/**
 * `isOfferSafe` checks offer safety for a single offer.
 *
 * Note: This implementation checks whether we fully satisfy
 * `proposal.give` (giving a refund) or whether we fully satisfy
 * `proposal.want`. Both can be fully satisfied.
 *
 * @param  {ProposalRecord} proposal - the rules that accompanied the
 * escrow of payments that dictate what the user expected to get back
 * from Zoe. A proposal is a record with keys `give`, `want`, and
 * `exit`. `give` and `want` are records with keywords as keys and
 * amounts as values. The proposal is a user's understanding of the
 * contract that they are entering when they make an offer.
 * @param  {AmountKeywordRecord} allocation - a record with keywords
 * as keys and amounts as values. These amounts are the reallocation
 * to be given to a user.
 */
export const isOfferSafe = (proposal, allocation) => {
  const { give, want, multiples } = proposal;
  const howMany =
    satisfiesInternal(give, allocation, multiples) +
    satisfiesInternal(want, allocation, multiples);
  return howMany >= multiples;
};
harden(isOfferSafe);
