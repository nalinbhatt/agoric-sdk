// @ts-check
import { AssetKind, makeIssuerKit } from '@agoric/ertp';
import { Nat } from '@agoric/nat';
import { makeScalarMapStore } from '@agoric/store';
import { provide } from '@agoric/store/src/stores/store-utils.js';
import { E, Far } from '@endo/far';
import { makeStorageNode } from '../lib-chainStorage.js';
import { makeNameHubKit } from '../nameHub.js';
import { feeIssuerConfig } from './utils.js';

const { details: X } = assert;

// TODO/TECHDEBT: move to inter-protocol?
const Tokens = harden({
  RUN: {
    name: 'RUN',
    denom: 'urun',
    proposedName: 'Agoric RUN currency',
    assetKind: AssetKind.NAT,
    displayInfo: { decimalPlaces: 6 },
  },
  BLD: {
    name: 'BLD',
    denom: 'ubld',
    proposedName: 'Agoric staking token',
    assetKind: AssetKind.NAT,
    displayInfo: { decimalPlaces: 6 },
  },
});
// These two are inextricably linked with ../../golang/cosmos.
const RESERVE_MODULE_ACCOUNT = 'vbank/reserve';
const RESERVE_ADDRESS = 'agoric1ae0lmtzlgrcnla9xjkpaarq5d5dfez63h3nucl';

/**
 * In golang/cosmos/app/app.go, we define
 * cosmosInitAction with type AG_COSMOS_INIT,
 * with the following shape.
 *
 * The urun supplyCoins value is taken from genesis,
 * thereby authorizing the minting an initial supply of RUN.
 */
// eslint-disable-next-line no-unused-vars
const bootMsgEx = {
  type: 'AG_COSMOS_INIT',
  chainID: 'agoric',
  storagePort: 1,
  supplyCoins: [
    { denom: 'provisionpass', amount: '100' },
    { denom: 'sendpacketpass', amount: '100' },
    { denom: 'ubld', amount: '1000000000000000' },
    { denom: 'urun', amount: '50000000000' },
  ],
  vbankPort: 3,
  vibcPort: 2,
};

/**
 * TODO: review behaviors carefully for powers that go out of scope,
 * since we may want/need them later.
 */

/**
 * @param {BootstrapPowers & {
 *   produce: {vatStore: Producer<VatStore> }
 * }} powers
 *
 * @typedef {{adminNode: any, root: unknown}} VatInfo as from createVatByName
 * @typedef {MapStore<string, Promise<VatInfo>>} VatStore
 */
export const makeVatsFromBundles = ({
  vats,
  devices,
  produce: { vatAdminSvc, loadVat, vatStore },
}) => {
  const svc = E(vats.vatAdmin).createVatAdminService(devices.vatAdmin);
  vatAdminSvc.resolve(svc);

  /** @type {VatStore} */
  const store = makeScalarMapStore();
  vatStore.resolve(store);

  loadVat.resolve(bundleName => {
    return provide(store, bundleName, _k => {
      console.info(`createVatByName(${bundleName})`);
      /** @type { Promise<VatInfo> } */
      const vatInfo = E(svc).createVatByName(bundleName, { name: bundleName });
      return vatInfo;
    }).then(r => r.root);
  });
};
harden(makeVatsFromBundles);

/**
 * @param { BootstrapPowers & {
 *   consume: { loadVat: ERef<VatLoader<ZoeVat>> }
 * }} powers
 *
 * @typedef {ERef<ReturnType<import('../vat-zoe.js').buildRootObject>>} ZoeVat
 */
export const buildZoe = async ({
  consume: { vatAdminSvc, loadVat, client },
  produce: { zoe, feeMintAccess },
}) => {
  const zcfBundleName = 'zcf'; // should match config.bundles.zcf=
  const { zoeService, feeMintAccess: fma } = await E(
    E(loadVat)('zoe'),
  ).buildZoe(vatAdminSvc, feeIssuerConfig, zcfBundleName);

  zoe.resolve(zoeService);

  feeMintAccess.resolve(fma);
  return Promise.all([
    E(client).assignBundle([_addr => ({ zoe: zoeService })]),
  ]);
};
harden(buildZoe);

/**
 * @param {BootstrapPowers & {
 *   consume: { loadVat: ERef<VatLoader<PriceAuthorityVat>>},
 * }} powers
 *
 * @typedef {ERef<ReturnType<import('../vat-priceAuthority.js').buildRootObject>>} PriceAuthorityVat
 */
export const startPriceAuthority = async ({
  consume: { loadVat, client },
  produce,
}) => {
  const vats = { priceAuthority: E(loadVat)('priceAuthority') };
  const { priceAuthority, adminFacet } = await E(
    vats.priceAuthority,
  ).makePriceAuthorityRegistry();

  produce.priceAuthorityVat.resolve(vats.priceAuthority);
  produce.priceAuthority.resolve(priceAuthority);
  produce.priceAuthorityAdmin.resolve(adminFacet);

  return E(client).assignBundle([_addr => ({ priceAuthority })]);
};
harden(startPriceAuthority);

/**
 * Create inert brands (no mint or issuer) referred to by price oracles.
 *
 * @param {BootstrapPowers} powers
 */
export const makeOracleBrands = async ({
  oracleBrand: { produce: oracleBrandProduce },
}) => {
  const { brand } = makeIssuerKit(
    'USD',
    AssetKind.NAT,
    harden({ decimalPlaces: 6 }),
  );
  oracleBrandProduce.USD.resolve(brand);
};
harden(makeOracleBrands);

/**
 * TODO: rename this to getBoard?
 *
 * @param {BootstrapPowers & {
 *   consume: { loadVat: ERef<VatLoader<BoardVat>>
 * }}} powers
 * @typedef {ERef<ReturnType<import('../vat-board.js').buildRootObject>>} BoardVat
 */
export const makeBoard = async ({
  consume: { loadVat, client },
  produce: {
    board: { resolve: resolveBoard },
  },
}) => {
  const board = await E(E(loadVat)('board')).getBoard();
  resolveBoard(board);
  return E(client).assignBundle([_addr => ({ board })]);
};
harden(makeBoard);

/**
 * Make the agoricNames, namesByAddress name hierarchies.
 *
 * agoricNames are well-known items such as the RUN issuer,
 * available as E(home.agoricNames).lookup('issuer', 'RUN')
 *
 * namesByAddress is a NameHub for each provisioned client,
 * available, for example, as `E(home.namesByAddress).lookup('agoric1...')`.
 * `depositFacet` as in `E(home.namesByAddress).lookup('agoric1...', 'depositFacet')`
 * is reserved for use by the Agoric wallet. Each client
 * is given `home.myAddressNameAdmin`, which they can use to
 * assign (update / reserve) any other names they choose.
 *
 * @param {BootstrapSpace} powers
 */
export const makeAddressNameHubs = async ({
  consume: { agoricNames: agoricNamesP, client },
  produce,
}) => {
  const agoricNames = await agoricNamesP;

  const { nameHub: namesByAddress, nameAdmin: namesByAddressAdmin } =
    makeNameHubKit();
  produce.namesByAddress.resolve(namesByAddress);
  produce.namesByAddressAdmin.resolve(namesByAddressAdmin);

  const perAddress = address => {
    // Create a name hub for this address.
    const { nameHub: myAddressNameHub, nameAdmin: rawMyAddressNameAdmin } =
      makeNameHubKit();

    /** @type {MyAddressNameAdmin} */
    const myAddressNameAdmin = Far('myAddressNameAdmin', {
      ...rawMyAddressNameAdmin,
      getMyAddress: () => address,
    });
    // reserve space for deposit facet
    myAddressNameAdmin.reserve('depositFacet');
    // Register it with the namesByAddress hub.
    namesByAddressAdmin.update(address, myAddressNameHub, myAddressNameAdmin);
    return { agoricNames, namesByAddress, myAddressNameAdmin };
  };

  return E(client).assignBundle([perAddress]);
};
harden(makeAddressNameHubs);

/** @param {BootstrapSpace} powers */
export const makeClientBanks = async ({
  consume: {
    agoricNames,
    board,
    namesByAddress,
    namesByAddressAdmin,
    client,
    chainStorage,
    bankManager,
    zoe,
  },
  installation: {
    consume: { walletFactory },
  },
}) => {
  const STORAGE_PATH = 'wallet';

  const storageNode = await makeStorageNode(chainStorage, STORAGE_PATH);
  const { creatorFacet } = await E(zoe).startInstance(
    walletFactory,
    {},
    { agoricNames, namesByAddress, board },
    { storageNode },
  );
  return E(client).assignBundle([
    address => {
      const bank = E(bankManager).getBankForAddress(address);
      /** @type {ERef<MyAddressNameAdmin>} */
      const myAddressNameAdmin = E(namesByAddressAdmin).lookupAdmin(address);

      const smartWallet = E(creatorFacet).provideSmartWallet(
        address,
        bank,
        myAddressNameAdmin,
      );

      // sets these values in REPL home by way of registerWallet
      return { bank, smartWallet };
    },
  ]);
};
harden(makeClientBanks);

/** @param {BootstrapSpace & { devices: { vatAdmin: any }, vatPowers: { D: DProxy }, }} powers */
export const installBootContracts = async ({
  vatPowers: { D },
  devices: { vatAdmin },
  consume: { zoe },
  installation: {
    produce: { centralSupply, mintHolder, walletFactory },
  },
}) => {
  for (const [name, producer] of Object.entries({
    centralSupply,
    mintHolder,
    walletFactory,
  })) {
    // This really wants to be E(vatAdminSvc).getBundleIDByName, but it's
    // good enough to do D(vatAdmin).getBundleIDByName
    const bundleCap = D(vatAdmin).getNamedBundleCap(name);

    const bundle = D(bundleCap).getBundle();
    // TODO (#4374) this should be E(zoe).installBundleID(bundleID);
    const installation = E(zoe).install(bundle);
    producer.resolve(installation);
  }
};

/**
 * Mint RUN genesis supply.
 *
 * @param { BootstrapPowers & {
 *   vatParameters: { argv: { bootMsg?: typeof bootMsgEx }},
 * }} powers
 */
export const mintInitialSupply = async ({
  vatParameters: {
    argv: { bootMsg },
  },
  consume: { feeMintAccess: feeMintAccessP, zoe },
  produce: { initialSupply },
  installation: {
    consume: { centralSupply },
  },
}) => {
  const feeMintAccess = await feeMintAccessP;

  const { supplyCoins = [] } = bootMsg || {};
  const centralBootstrapSupply = supplyCoins.find(
    ({ denom }) => denom === Tokens.RUN.denom,
  ) || { amount: '0' };
  const bootstrapPaymentValue = Nat(BigInt(centralBootstrapSupply.amount));

  /** @type {Awaited<ReturnType<typeof import('../centralSupply.js').start>>} */
  const { creatorFacet } = await E(zoe).startInstance(
    centralSupply,
    {},
    { bootstrapPaymentValue },
    { feeMintAccess },
  );
  const payment = E(creatorFacet).getBootstrapPayment();
  // TODO: shut down the centralSupply contract, now that we have the payment?
  initialSupply.resolve(payment);
};
harden(mintInitialSupply);

/**
 * Add RUN (with initialSupply payment), BLD (with mint) to BankManager.
 *
 * @param { BootstrapSpace & {
 *   consume: { loadVat: ERef<VatLoader<BankVat>> },
 * }} powers
 */
export const addBankAssets = async ({
  consume: { initialSupply, bridgeManager, loadVat, zoe },
  produce: { bankManager, bldIssuerKit },
  installation: {
    consume: { mintHolder },
  },
  issuer: { produce: produceIssuer },
  brand: { produce: produceBrand },
}) => {
  const runIssuer = await E(zoe).getFeeIssuer();
  const [runBrand, payment] = await Promise.all([
    E(runIssuer).getBrand(),
    initialSupply,
  ]);
  const runKit = { issuer: runIssuer, brand: runBrand, payment };

  /** @type {{ creatorFacet: ERef<Mint>, publicFacet: ERef<Issuer> }} */
  // @ts-expect-error cast
  const { creatorFacet: bldMint, publicFacet: bldIssuer } = E.get(
    E(zoe).startInstance(
      mintHolder,
      harden({}),
      harden({
        keyword: Tokens.BLD.name,
        assetKind: AssetKind.NAT,
        displayInfo: Tokens.BLD.displayInfo,
      }),
    ),
  );
  const bldBrand = await E(bldIssuer).getBrand();
  const bldKit = { mint: bldMint, issuer: bldIssuer, brand: bldBrand };
  bldIssuerKit.resolve(bldKit);

  const bankMgr = await E(E(loadVat)('bank')).makeBankManager(bridgeManager);
  bankManager.resolve(bankMgr);

  // Sanity check: the bank manager should have a reserve module account.
  const reserveAddress = await E(bankMgr).getModuleAccountAddress(
    RESERVE_MODULE_ACCOUNT,
  );
  if (reserveAddress !== null) {
    // bridgeManager is available, so we should have a legit reserve address.
    assert.equal(
      reserveAddress,
      RESERVE_ADDRESS,
      X`vbank address for reserve module ${RESERVE_MODULE_ACCOUNT} is ${reserveAddress}; expected ${RESERVE_ADDRESS}`,
    );
  }

  produceIssuer.BLD.resolve(bldKit.issuer);
  produceIssuer.RUN.resolve(runKit.issuer);
  produceBrand.BLD.resolve(bldKit.brand);
  produceBrand.RUN.resolve(runKit.brand);
  return Promise.all([
    E(bankMgr).addAsset(
      Tokens.BLD.denom,
      Tokens.BLD.name,
      Tokens.BLD.proposedName,
      bldKit, // with mint
    ),
    E(bankMgr).addAsset(
      Tokens.RUN.denom,
      Tokens.RUN.name,
      Tokens.RUN.proposedName,
      runKit, // without mint, with payment
    ),
  ]);
};
harden(addBankAssets);
