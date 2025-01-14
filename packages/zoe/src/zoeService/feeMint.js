// @ts-check

import { makeIssuerKit } from '@agoric/ertp';

import { makeHandle } from '../makeHandle.js';

/**
 * @param {FeeIssuerConfig} feeIssuerConfig
 * @param {ShutdownWithFailure} shutdownZoeVat
 * @returns {{
 *    feeMintAccess: FeeMintAccess,
 *    getFeeIssuerKit: GetFeeIssuerKit,
 *    feeIssuer: Issuer,
 *    feeBrand: Brand,
 * }}
 */
const createFeeMint = (feeIssuerConfig, shutdownZoeVat) => {
  /** @type {IssuerKit} */
  const feeIssuerKit = makeIssuerKit(
    feeIssuerConfig.name,
    feeIssuerConfig.assetKind,
    feeIssuerConfig.displayInfo,
    shutdownZoeVat,
  );

  /** @type {FeeMintAccess} */
  const feeMintAccess = makeHandle('feeMintAccess');

  /** @type {GetFeeIssuerKit} */
  const getFeeIssuerKit = allegedFeeMintAccess => {
    assert(
      feeMintAccess === allegedFeeMintAccess,
      'The object representing access to the fee brand mint was not provided',
    );
    return feeIssuerKit;
  };

  return harden({
    feeMintAccess,
    getFeeIssuerKit,
    feeIssuer: feeIssuerKit.issuer,
    feeBrand: feeIssuerKit.brand,
  });
};

export { createFeeMint };
