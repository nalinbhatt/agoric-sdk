// @ts-check

import { E, Far } from '@endo/far';
import { makeStore } from '@agoric/store';
import { AmountMath } from '@agoric/ertp';
import { handleParamGovernance, ParamTypes } from '@agoric/governance';
import { offerTo } from '@agoric/zoe/src/contractSupport/index.js';

import { AMM_INSTANCE } from './params.js';
import { makeTracer } from '../makeTracer.js';
import { makeMetricsPublisherKit } from '../contractSupport.js';

const { details: X, quote: q } = assert;

const trace = makeTracer('Reserve', false);

const makeLiquidityKeyword = keyword => `${keyword}Liquidity`;

const nonalphanumeric = /[^A-Za-z0-9]/g;

/**
 * @typedef {object} MetricsNotification
 *
 * @property {AmountKeywordRecord} allocations
 * @property {Amount<'nat'>} shortfallBalance shortfall from liquiditation that
 * @property {Amount<'nat'>} totalFeeMinted total RUN minted to date
 * @property {Amount<'nat'>} totalFeeBurned total RUN burned to date
 *   has not yet been compensated.
 */

/**
 * Asset Reserve holds onto assets for the Inter protocol, and can
 * dispense it for various purposes under governance control. It currently
 * supports governance decisions to add liquidity to an AMM pool.
 *
 * This contract has the ability to tokens on the Fee mint provided in its
 * terms. When adding liquidity to an AMM pool, it takes a specified amount of
 * collateral on hand, and mints new fee tokens to accompany it. It then
 * deposits both into an AMM pool by using the AMM's method that allows the pool
 * balance to be determined based on the contributed funds.
 *
 * @param {ZCF<GovernanceTerms<{AmmInstance: 'instance'}> &
 * {
 *   governedApis: ['addLiquidityToAmmPool'],
 * }
 * >} zcf
 * @param {{
 *   feeMintAccess: FeeMintAccess,
 *   initialPoserInvitation: Payment,
 *   marshaller: ERef<Marshaller>,
 *   storageNode: ERef<StorageNode>,
 * }} privateArgs
 */
const start = async (zcf, privateArgs) => {
  /**
   * Used to look up the unique keyword for each brand, including Fee brand.
   *
   * @type {MapStore<Brand, Keyword>}
   */
  const keywordForBrand = makeStore('keywords');
  /**
   * Used to look up the brands for keywords, excluding Fee because it's a special case.
   *
   * @type {MapStore<Keyword, Brand>}
   */
  const brandForKeyword = makeStore('brands');
  /**
   * @type {MapStore<Brand, Brand>}
   */
  const liquidityBrandForBrand = makeStore('liquidityBrands');

  /**
   * @param {Brand} brand
   * @param {Keyword} keyword
   */
  const saveBrandKeyword = (brand, keyword) => {
    keywordForBrand.init(brand, keyword);
    brandForKeyword.init(keyword, brand);
  };

  const { augmentPublicFacet, makeGovernorFacet, params } =
    await handleParamGovernance(
      zcf,
      privateArgs.initialPoserInvitation,
      {
        [AMM_INSTANCE]: ParamTypes.INSTANCE,
      },
      privateArgs.storageNode,
      privateArgs.marshaller,
    );

  /** @type {Promise<XYKAMMPublicFacet>} */
  const ammPublicFacet = E(zcf.getZoeService()).getPublicFacet(
    params.getAmmInstance(),
  );

  /** @type {ZCFMint} */
  const feeMint = await zcf.registerFeeMint('Fee', privateArgs.feeMintAccess);
  const feeKit = feeMint.getIssuerRecord();
  saveBrandKeyword(feeKit.brand, 'Fee');
  // no need to saveIssuer() b/c registerFeeMint does it

  /**
   * @param {Issuer} issuer
   * @param {string} keyword
   */
  const addIssuer = async (issuer, keyword) => {
    const brand = await E(issuer).getBrand();
    trace('addIssuer', { brand, keyword });
    assert(
      keyword !== 'Fee' && brand !== feeKit.brand,
      `'Fee' brand is a special case handled by the reserve contract`,
    );

    trace('addIssuer storing', {
      keyword,
      brand,
    });

    saveBrandKeyword(brand, keyword);
    await zcf.saveIssuer(issuer, keyword);
  };

  /**
   * @param {Issuer} baseIssuer on which the liquidity issuer is based
   */
  const addLiquidityIssuer = async baseIssuer => {
    const getBrand = () => {
      try {
        return zcf.getBrandForIssuer(baseIssuer);
      } catch {
        assert.fail(
          `baseIssuer ${baseIssuer} not known; try addIssuer() first`,
        );
      }
    };
    const baseBrand = getBrand();
    const baseKeyword = keywordForBrand.get(baseBrand);
    const liquidityIssuer = E(ammPublicFacet).getLiquidityIssuer(baseBrand);
    const liquidityBrand = await E(liquidityIssuer).getBrand();
    const liquidityKeyword = makeLiquidityKeyword(baseKeyword);

    trace('addLiquidityIssuer', {
      baseBrand,
      baseKeyword,
      liquidityBrand,
      liquidityKeyword,
    });
    saveBrandKeyword(liquidityBrand, liquidityKeyword);
    liquidityBrandForBrand.init(baseBrand, liquidityBrand);

    await zcf.saveIssuer(liquidityIssuer, liquidityKeyword);
  };

  const conjureKeyword = async baseBrand => {
    const allegedName = await E(baseBrand).getAllegedName();
    const safeName = allegedName.replace(nonalphanumeric, '');
    let keyword;
    let keywordNum = 0;
    do {
      // 'R' to guarantee leading uppercase
      keyword = `R${safeName}${keywordNum || ''}`;
      keywordNum += 1;
    } while (brandForKeyword.has(keyword));
    return keyword;
  };

  /**
   * @param {Brand} ammSecondaryBrand
   */
  const addIssuerFromAmm = async ammSecondaryBrand => {
    assert(
      ammSecondaryBrand !== feeKit.brand,
      `${'Fee'} is a special case handled by the reserve contract`,
    );

    const keyword = await conjureKeyword(ammSecondaryBrand);
    trace('addIssuerFromAmm', { ammSecondaryBrand, keyword });
    // validate the AMM has this brand and match its issuer
    const issuer = await E(ammPublicFacet).getSecondaryIssuer(
      ammSecondaryBrand,
    );
    await addIssuer(issuer, keyword);
  };

  const getKeywordForBrand = brand => {
    assert(
      keywordForBrand.has(brand),
      X`Issuer not defined for brand ${q(brand)}; first call addIssuer()`,
    );
    return keywordForBrand.get(brand);
  };

  // We keep the associated liquidity tokens in the same seat
  const { zcfSeat: collateralSeat } = zcf.makeEmptySeatKit();
  const getAllocations = () => {
    return collateralSeat.getCurrentAllocation();
  };

  /**
   * Anyone can deposit any assets to the reserve
   *
   * @param {ZCFSeat} seat
   */
  const addCollateralHook = async seat => {
    const {
      give: { Collateral: amountIn },
    } = seat.getProposal();

    const collateralKeyword = getKeywordForBrand(amountIn.brand);
    seat.decrementBy(harden({ Collateral: amountIn }));
    collateralSeat.incrementBy(harden({ [collateralKeyword]: amountIn }));

    zcf.reallocate(collateralSeat, seat);
    seat.exit();

    trace('received collateral', amountIn);
    return 'added Collateral to the Reserve';
  };

  const makeAddCollateralInvitation = () =>
    zcf.makeInvitation(addCollateralHook, 'Add Collateral');

  const { brand: feeBrand } = await E(feeMint).getIssuerRecord();

  let totalFeeMinted = AmountMath.makeEmpty(feeBrand);
  let totalFeeBurned = AmountMath.makeEmpty(feeBrand);

  // shortfall in Vaults due to liquidations less than debt. This value can be
  // reduced by various actions which burn Fee tokens.
  let shortfallBalance = AmountMath.makeEmpty(feeBrand);

  /** @type {import('../contractSupport.js').MetricsPublisherKit<MetricsNotification>} */
  const { metricsPublication, metricsSubscription } = makeMetricsPublisherKit(
    privateArgs.storageNode,
    privateArgs.marshaller,
  );

  const updateMetrics = () => {
    const metrics = harden({
      allocations: getAllocations(),
      shortfallBalance,
      totalFeeMinted,
      totalFeeBurned,
    });
    metricsPublication.updateState(metrics);
  };
  updateMetrics();

  const increaseLiquidationShortfall = shortfall => {
    shortfallBalance = AmountMath.add(shortfallBalance, shortfall);
    updateMetrics();
  };
  const reduceLiquidationShortfall = reduction => {
    if (AmountMath.isGTE(reduction, shortfallBalance)) {
      shortfallBalance = AmountMath.makeEmptyFromAmount(shortfallBalance);
    } else {
      shortfallBalance = AmountMath.subtract(shortfallBalance, reduction);
    }
    updateMetrics();
  };

  /**
   * Takes collateral from the reserve, mints Fee tokens to accompany it, and uses both
   * to add Liquidity to a pool in the AMM.
   *
   * @param {Amount} collateral
   * @param {Amount} fee
   */
  const addLiquidityToAmmPool = async (collateral, fee) => {
    // verify we have the funds
    const collateralKeyword = getKeywordForBrand(collateral.brand);
    if (
      !AmountMath.isGTE(
        collateralSeat.getCurrentAllocation()[collateralKeyword],
        collateral,
      )
    ) {
      throw new Error('insufficient reserves for that transaction');
    }

    // create the Fee tokens
    const offerToSeat = feeMint.mintGains(harden({ Fee: fee }));
    totalFeeMinted = AmountMath.add(totalFeeMinted, fee);
    offerToSeat.incrementBy(
      collateralSeat.decrementBy(
        harden({
          [collateralKeyword]: collateral,
        }),
      ),
    );
    zcf.reallocate(collateralSeat, offerToSeat);

    // Add Fee tokens and collateral to the AMM
    const invitation = await E(
      ammPublicFacet,
    ).makeAddLiquidityAtRateInvitation();
    const mapping = harden({
      Fee: 'Central',
      [collateralKeyword]: 'Secondary',
    });

    const liqBrand = liquidityBrandForBrand.get(collateral.brand);
    const proposal = harden({
      give: {
        Central: fee,
        Secondary: collateral,
      },
      want: { Liquidity: AmountMath.makeEmpty(liqBrand) },
    });

    // chain await the completion of both the offer and the `deposited` promise
    await E.get(offerTo(zcf, invitation, mapping, proposal, offerToSeat))
      .deposited;

    // transfer from userSeat to LiquidityToken holdings
    const liquidityAmount = offerToSeat.getCurrentAllocation();
    const liquidityKeyword = makeLiquidityKeyword(collateralKeyword);

    offerToSeat.decrementBy(
      harden({
        Liquidity: liquidityAmount.Liquidity,
      }),
    );
    collateralSeat.incrementBy(
      harden({
        [liquidityKeyword]: liquidityAmount.Liquidity,
      }),
    );
    zcf.reallocate(offerToSeat, collateralSeat);
    updateMetrics();
  };

  const burnFeesToReduceShortfall = reduction => {
    reduction = AmountMath.coerce(feeBrand, reduction);
    const feeKeyword = keywordForBrand.get(feeBrand);
    const feeBalance = collateralSeat.getAmountAllocated(feeKeyword);
    const amountToBurn = AmountMath.min(reduction, feeBalance);
    if (AmountMath.isEmpty(amountToBurn)) {
      return;
    }

    feeMint.burnLosses(harden({ [feeKeyword]: amountToBurn }), collateralSeat);
    totalFeeBurned = AmountMath.add(totalFeeBurned, amountToBurn);
    reduceLiquidationShortfall(amountToBurn);
  };

  const makeShortfallReportingInvitation = () => {
    const handleShortfallReportingOffer = () => {
      return Far('shortfallReporter', {
        increaseLiquidationShortfall,
        // currently exposed for testing. Maybe it only gets called internally?
        reduceLiquidationShortfall,
      });
    };

    return zcf.makeInvitation(
      handleShortfallReportingOffer,
      'getFacetForReportingShortfalls',
    );
  };

  const creatorFacet = makeGovernorFacet(
    {
      makeAddCollateralInvitation,
      // add makeRedeemLiquidityTokensInvitation later. For now just store them
      getAllocations,
      addIssuer,
      makeShortfallReportingInvitation,
      getMetrics: () => metricsSubscription,
    },
    {
      addLiquidityToAmmPool,
      burnFeesToReduceShortfall,
    },
  );

  const publicFacet = augmentPublicFacet(
    Far('Collateral Reserve public', {
      makeAddCollateralInvitation,
      addIssuerFromAmm,
      addLiquidityIssuer,
    }),
  );

  return harden({ creatorFacet, publicFacet });
};

harden(start);

export { start };

/**
 * @typedef {object} ShortfallReporter
 * @property {(shortfall: Amount) => void} increaseLiquidationShortfall
 * @property {(shortfall: Amount) => void} reduceLiquidationShortfall
 */

/** @typedef {Awaited<ReturnType<typeof start>>['publicFacet']} AssetReservePublicFacet */
/** @typedef {Awaited<ReturnType<typeof start>>['creatorFacet']} AssetReserveCreatorFacet */
