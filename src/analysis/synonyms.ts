// Words for the same contract concept. A question term matches a quote when the quote contains any
// word of the term's concept (see questionTerms.ts). Generic across lease, licence, sale and
// development agreements; not tuned to one document.
//
// Kept narrow on purpose. A word is added only when it names the same thing in every contract type
// it appears in. Left out:
//   advance      "rent payable in advance" would satisfy a deposit question
//   owner, vendor, seller, purchaser, buyer   sale parties would be read as lease roles
// Inflected forms are listed as written; a word is stemmed the same way on both sides first.

export const CONCEPT_GROUPS: Record<string, string[]> = {
  deposit: ['security deposit', 'deposit', 'security'],
  landlord: ['landlord', 'lessor', 'licensor'],
  tenant: ['tenant', 'lessee', 'licensee'],
  ending: [
    'termination', 'terminate', 'terminates', 'terminated', 'terminating',
    'cancellation', 'cancel', 'cancels', 'cancelled',
    'expiry', 'expire', 'expires', 'expired', 'expiration',
  ],
  refund: [
    'refund', 'refunds', 'refunded', 'refundable',
    'repayment', 'repay', 'repaid',
    'return', 'returns', 'returned',
  ],
  notice: ['notice', 'intimation'],
};
