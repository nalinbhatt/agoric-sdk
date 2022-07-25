// @ts-check

import '@agoric/zoe/src/types.js';

import { AmountMath, AssetKind, makeIssuerKit } from '@agoric/ertp';

import { assert } from '@agoric/assert';
import {
  floorDivideBy,
  makeRatio,
  multiplyRatios,
} from '@agoric/zoe/src/contractSupport/ratio.js';
import { makeFakePriceAuthority } from '@agoric/zoe/tools/fakePriceAuthority.js';
import buildManualTimer from '@agoric/zoe/tools/manualTimer.js';
import { Far } from '@endo/marshal';

import { makePublishKit } from '@agoric/notifier';
import {
  makeFakeMarshaller,
  makeFakeStorage,
} from '@agoric/notifier/tools/testSupports.js';
import { getAmountOut } from '@agoric/zoe/src/contractSupport';
import { E } from '@endo/eventual-send';
import { paymentFromZCFMint } from '../../src/vaultFactory/burn.js';
import { makeVault } from '../../src/vaultFactory/vault.js';

const BASIS_POINTS = 10000n;
const SECONDS_PER_HOUR = 60n * 60n;
const DAY = SECONDS_PER_HOUR * 24n;

const marshaller = makeFakeMarshaller();

/**
 * @param {ZCF} zcf
 * @param {{feeMintAccess: FeeMintAccess}} privateArgs
 */
export async function start(zcf, privateArgs) {
  console.log(`contract started`);
  assert.typeof(privateArgs.feeMintAccess, 'object');

  const collateralKit = makeIssuerKit('Collateral');
  const { brand: collateralBrand } = collateralKit;
  await zcf.saveIssuer(collateralKit.issuer, 'Collateral'); // todo: CollateralETH, etc

  const runMint = await zcf.registerFeeMint(
    'Minted',
    privateArgs.feeMintAccess,
  );
  const { brand: runBrand } = runMint.getIssuerRecord();

  const LIQUIDATION_MARGIN = makeRatio(105n, runBrand);

  const { zcfSeat: vaultFactorySeat } = zcf.makeEmptySeatKit();

  let vaultCounter = 0;

  let currentInterest = makeRatio(5n, runBrand); // 5%
  let compoundedInterest = makeRatio(100n, runBrand); // starts at 1.0, no interest

  const { zcfSeat: stage } = zcf.makeEmptySeatKit();

  const { subscriber: assetSubscriber } = makePublishKit();

  const timer = buildManualTimer(console.log, 0n, DAY);
  const options = {
    actualBrandIn: collateralBrand,
    actualBrandOut: runBrand,
    priceList: [80],
    tradeList: undefined,
    timer,
    quoteMint: makeIssuerKit('quote', AssetKind.SET).mint,
  };
  const priceAuthority = makeFakePriceAuthority(options);
  const maxDebtFor = async collateralAmount => {
    const quoteAmount = await E(priceAuthority).quoteGiven(
      collateralAmount,
      runBrand,
    );
    // floorDivide because we want the debt ceiling lower
    return floorDivideBy(getAmountOut(quoteAmount), LIQUIDATION_MARGIN);
  };

  const reallocateWithFee = (fee, wanted, seat, ...otherSeats) => {
    const toMint = AmountMath.add(wanted, fee);
    runMint.mintGains(harden({ Minted: toMint }), stage);
    try {
      vaultFactorySeat.incrementBy(stage.decrementBy(harden({ Minted: fee })));
      seat.incrementBy(stage.decrementBy(harden({ Minted: wanted })));
      zcf.reallocate(vaultFactorySeat, stage, seat, ...otherSeats);
    } catch (e) {
      stage.clear();
      vaultFactorySeat.clear();
      runMint.burnLosses(harden({ Minted: toMint }), stage);
      throw e;
    } finally {
      assert(
        AmountMath.isEmpty(stage.getAmountAllocated('Minted', runBrand)),
        `Stage should be empty of Minted`,
      );
    }
  };

  const mintAndReallocate = (toMint, fee, seat, ...otherSeats) => {
    const wanted = AmountMath.subtract(toMint, fee);
    reallocateWithFee(fee, wanted, seat, ...otherSeats);
  };

  const burnAndRecord = (toBurn, seat) => {
    runMint.burnLosses(harden({ Minted: toBurn }), seat);
  };

  /** @type {Parameters<typeof makeVault>[1]} */
  const managerMock = Far('vault manager mock', {
    getGovernedParams() {
      return {
        getDebtLimit() {
          throw Error('not implemented');
        },
        getLiquidationMargin() {
          return LIQUIDATION_MARGIN;
        },
        getLiquidationPenalty() {
          throw Error('not implemented');
        },
        getLoanFee() {
          return makeRatio(500n, runBrand, BASIS_POINTS);
        },
        getInterestRate() {
          return currentInterest;
        },
        getChargingPeriod() {
          return DAY;
        },
        getRecordingPeriod() {
          return DAY;
        },
      };
    },
    getCollateralBrand() {
      return collateralBrand;
    },
    getDebtBrand: () => runBrand,

    getAssetSubscriber: () => assetSubscriber,
    maxDebtFor,
    mintAndReallocate,
    burnAndRecord,
    getCollateralQuote() {
      return Promise.reject(Error('Not implemented'));
    },
    getCompoundedInterest: () => compoundedInterest,
    handleBalanceChange: () => {
      console.warn('mock handleBalanceChange does nothing');
    },
    mintforVault: async amount => {
      runMint.mintGains({ Minted: amount });
    },
  });

  const vault = await makeVault(
    zcf,
    managerMock,
    // eslint-disable-next-line no-plusplus
    String(vaultCounter++),
    makeFakeStorage('test.vaultContractWrapper'),
    marshaller,
  );

  const advanceRecordingPeriod = async () => {
    await timer.tick();

    // skip the debt calculation for this mock manager
    const currentInterestAsMultiplicand = makeRatio(
      100n + currentInterest.numerator.value,
      currentInterest.numerator.brand,
    );
    compoundedInterest = multiplyRatios(
      compoundedInterest,
      currentInterestAsMultiplicand,
    );
  };

  const setInterestRate = percent => {
    currentInterest = makeRatio(percent, runBrand);
  };

  zcf.setTestJig(() => ({
    advanceRecordingPeriod,
    collateralKit,
    runMint,
    setInterestRate,
    vault,
  }));

  async function makeHook(seat) {
    const vaultKit = await vault.initVaultKit(
      seat,
      makeFakeStorage('test'),
      marshaller,
    );
    return {
      vault,
      runMint,
      collateralKit,
      actions: Far('vault actions', {
        add() {
          return vaultKit.invitationMakers.AdjustBalances();
        },
      }),
      notifier: vaultKit.publicNotifiers.vault,
    };
  }

  console.log(`makeContract returning`);

  const vaultAPI = Far('vaultAPI', {
    makeAdjustBalancesInvitation() {
      return vault.makeAdjustBalancesInvitation();
    },
    mintRun(amount) {
      return paymentFromZCFMint(zcf, runMint, amount);
    },
  });

  const testInvitation = zcf.makeInvitation(makeHook, 'foo');
  return harden({ creatorInvitation: testInvitation, creatorFacet: vaultAPI });
}
