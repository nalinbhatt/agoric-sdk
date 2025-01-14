// @ts-check

import { defineDurableKind, provideKindHandle } from '@agoric/vat-data';

/** @typedef {import('@agoric/vat-data').Baggage} Baggage */

/**
 * @template {AssetKind} K
 * @param {Baggage} issuerBaggage
 * @param {string} name
 * @param {() => Brand<K>} getBrand must not be called before the issuerKit is
 * created
 * @returns {() => Payment<K>}
 */
export const vivifyPaymentKind = (issuerBaggage, name, getBrand) => {
  const paymentKindHandle = provideKindHandle(issuerBaggage, `${name} payment`);
  const makePayment = defineDurableKind(paymentKindHandle, () => ({}), {
    getAllegedBrand: getBrand,
  });
  return makePayment;
};
harden(vivifyPaymentKind);
