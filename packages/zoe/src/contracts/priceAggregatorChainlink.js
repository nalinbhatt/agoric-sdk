// @ts-check

import { AmountMath, AssetKind, makeIssuerKit } from '@agoric/ertp';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import { makeNotifierKit } from '@agoric/notifier';
import { makeLegacyMap } from '@agoric/store';
import { Nat, isNat } from '@agoric/nat';
import { TimeMath, toRelativeTime } from '@agoric/swingset-vat';

import {
  calculateMedian,
  natSafeMath,
  makeOnewayPriceAuthorityKit,
} from '../contractSupport';

import '../../tools/types';

const { add, subtract, multiply, floorDivide, ceilDivide, isGTE } = natSafeMath;

/**
 * This contract aggregates price values from a set of oracleStatuses and provides a
 * PriceAuthority for their median.
 *
 * @param {ZCF<{
 * timer: TimerService,
 * maxSubmissionCount: number,
 * minSubmissionCount: number,
 * restartDelay: RelativeTime,
 * timeout: number,
 * minSubmissionValue: number,
 * maxSubmissionValue: number,
 * unitAmountIn: Amount,
 * }>} zcf
 * @param {object} root0
 * @param {ERef<Mint>} [root0.quoteMint]
 */
const start = async (
  zcf,
  { quoteMint = makeIssuerKit('quote', AssetKind.SET).mint } = {},
) => {
  const {
    timer,
    brands: { In: brandIn, Out: brandOut },
    maxSubmissionCount,
    minSubmissionCount,
    restartDelay,
    timeout,
    minSubmissionValue,
    maxSubmissionValue,

    unitAmountIn = AmountMath.make(brandIn, 1n),
  } = zcf.getTerms();

  const unitIn = AmountMath.getValue(brandIn, unitAmountIn);

  // Get the timer's identity.
  const timerPresence = await timer;

  const quoteIssuerRecord = await zcf.saveIssuer(
    E(quoteMint).getIssuer(),
    'Quote',
  );
  const quoteKit = {
    ...quoteIssuerRecord,
    mint: quoteMint,
  };

  /** @type {bigint} */
  let lastValueOutForUnitIn;

  // --- [begin] Chainlink specific values
  /** @type {bigint} */
  let reportingRoundId = 0n;
  const { notifier: roundStartNotifier, updater: roundStartUpdater } =
    makeNotifierKit(
      // Start with the first round.
      add(reportingRoundId, 1),
    );

  /** @type {LegacyMap<OracleKey, ReturnType<typeof makeOracleStatus>>} */
  const oracleStatuses = makeLegacyMap('oracleStatus');

  /** @type {LegacyMap<bigint, ReturnType<typeof makeRound>>} */
  const rounds = makeLegacyMap('rounds');

  /** @type {LegacyMap<bigint, ReturnType<typeof makeRoundDetails>>} */
  const details = makeLegacyMap('details');

  /** @type {bigint} */
  const ROUND_MAX = BigInt(2 ** 32 - 1);

  /** @type {string} */
  const V3_NO_DATA_ERROR = 'No data present';
  // --- [end] Chainlink specific values

  /**
   * @param {number} answer
   * @param {Timestamp} startedAt
   * @param {Timestamp} updatedAt
   * @param {bigint} answeredInRound
   */
  const makeRound = (answer, startedAt, updatedAt, answeredInRound) => {
    return {
      answer,
      startedAt,
      updatedAt,
      answeredInRound,
    };
  };

  /**
   * @param {bigint[]} submissions
   * @param {number} maxSubmissions
   * @param {number} minSubmissions
   * @param {number} roundTimeout
   */
  const makeRoundDetails = (
    submissions,
    maxSubmissions,
    minSubmissions,
    roundTimeout,
  ) => {
    return {
      submissions,
      maxSubmissions,
      minSubmissions,
      roundTimeout,
    };
  };

  /**
   * @param {bigint} startingRound
   * @param {bigint} endingRound
   * @param {bigint} lastReportedRound
   * @param {bigint} lastStartedRound
   * @param {bigint} latestSubmission
   * @param {number} index
   */
  const makeOracleStatus = (
    startingRound,
    endingRound,
    lastReportedRound,
    lastStartedRound,
    latestSubmission,
    index,
  ) => {
    return {
      startingRound,
      endingRound,
      lastReportedRound,
      lastStartedRound,
      latestSubmission,
      index,
    };
  };

  /**
   *
   * @param {PriceQuoteValue} quote
   */
  const authenticateQuote = async quote => {
    const quoteAmount = AmountMath.make(quoteKit.brand, harden(quote));
    const quotePayment = await E(quoteKit.mint).mintPayment(quoteAmount);
    return harden({ quoteAmount, quotePayment });
  };

  // FIXME: We throw away the updater but shouldn't.
  const { notifier } = makeNotifierKit();

  /**
   * @typedef {object} OracleRecord
   * @property {(timestamp: Timestamp) => Promise<void>=} querier
   * @property {number} lastSample
   */

  /**
   * @typedef {{}} OracleKey
   */

  /** @type {LegacyMap<OracleKey, Set<OracleRecord>>} */
  const keyToRecords = makeLegacyMap('oracleKey');

  /**
   * @param {object} param0
   * @param {number} [param0.overrideValueOut]
   * @param {Timestamp} [param0.timestamp]
   */
  const makeCreateQuote = ({ overrideValueOut, timestamp } = {}) =>
    /**
     * @param {PriceQuery} priceQuery
     */
    function createQuote(priceQuery) {
      // Sniff the current baseValueOut.
      const valueOutForUnitIn =
        overrideValueOut === undefined
          ? lastValueOutForUnitIn // Use the latest value.
          : overrideValueOut; // Override the value.
      if (valueOutForUnitIn === undefined) {
        // We don't have a quote, so abort.
        return undefined;
      }

      /**
       * @param {Amount} amountIn the given amountIn
       */
      const calcAmountOut = amountIn => {
        const valueIn = AmountMath.getValue(brandIn, amountIn);
        return AmountMath.make(
          brandOut,
          floorDivide(multiply(valueIn, valueOutForUnitIn), unitIn),
        );
      };

      /**
       * @param {Amount} amountOut the wanted amountOut
       */
      const calcAmountIn = amountOut => {
        const valueOut = AmountMath.getValue(brandOut, amountOut);
        return AmountMath.make(
          brandIn,
          ceilDivide(multiply(valueOut, unitIn), valueOutForUnitIn),
        );
      };

      // Calculate the quote.
      const quote = priceQuery(calcAmountOut, calcAmountIn);
      if (!quote) {
        return undefined;
      }

      const {
        amountIn,
        amountOut,
        timestamp: theirTimestamp = timestamp,
      } = quote;
      AmountMath.coerce(brandIn, amountIn);
      AmountMath.coerce(brandOut, amountOut);
      if (theirTimestamp !== undefined) {
        return authenticateQuote([
          {
            amountIn,
            amountOut,
            timer: timerPresence,
            timestamp: theirTimestamp,
          },
        ]);
      }
      return E(timer)
        .getCurrentTimestamp()
        .then(now =>
          authenticateQuote([
            { amountIn, amountOut, timer: timerPresence, timestamp: now },
          ]),
        );
    };

  const { priceAuthority } = makeOnewayPriceAuthorityKit({
    createQuote: makeCreateQuote(),
    notifier,
    quoteIssuer: quoteKit.issuer,
    timer,
    actualBrandIn: brandIn,
    actualBrandOut: brandOut,
  });

  /**
   * @param {bigint} _roundId
   * @param {Timestamp} blockTimestamp
   */
  const timedOut = (_roundId, blockTimestamp) => {
    if (!details.has(_roundId) || !rounds.has(_roundId)) {
      return false;
    }

    const startedAt = rounds.get(_roundId).startedAt;
    const roundTimeout = details.get(_roundId).roundTimeout;
    // TODO Better would be to make `roundTimeout` a `RelativeTime`
    // everywhere, and to rename it to a name that does not
    // mistakenly imply that it is an absolute time.
    const roundTimeoutDuration = toRelativeTime(roundTimeout);
    const roundTimedOut =
      TimeMath.absValue(startedAt) > 0n &&
      TimeMath.relValue(roundTimeoutDuration) > 0n &&
      TimeMath.compareAbs(
        TimeMath.addAbsRel(startedAt, roundTimeoutDuration),
        blockTimestamp,
      ) < 0;

    return roundTimedOut;
  };

  /**
   * @param {bigint} _roundId
   * @param {Timestamp} blockTimestamp
   */
  const updateTimedOutRoundInfo = (_roundId, blockTimestamp) => {
    // round 0 is non-existent, so we avoid that case -- round 1 is ignored
    // because we can't copy from round 0 in that case
    if (_roundId === 0n || _roundId === 1n) {
      return;
    }

    const roundTimedOut = timedOut(_roundId, blockTimestamp);
    if (!roundTimedOut) return;

    const prevId = subtract(_roundId, 1);

    const round = rounds.get(_roundId);
    round.answer = rounds.get(prevId).answer;
    round.answeredInRound = rounds.get(prevId).answeredInRound;
    round.updatedAt = blockTimestamp;

    details.delete(_roundId);
  };

  /**
   * @param {bigint} _roundId
   */
  const newRound = _roundId => {
    return _roundId === add(reportingRoundId, 1);
  };

  /**
   * @param {bigint} _roundId
   * @param {Timestamp} blockTimestamp
   */
  const initializeNewRound = (_roundId, blockTimestamp) => {
    updateTimedOutRoundInfo(subtract(_roundId, 1), blockTimestamp);

    reportingRoundId = _roundId;
    roundStartUpdater.updateState(reportingRoundId);

    details.init(
      _roundId,
      makeRoundDetails([], maxSubmissionCount, minSubmissionCount, timeout),
    );

    rounds.init(
      _roundId,
      makeRound(
        /* answer = */ 0,
        /* startedAt = */ 0n,
        /* updatedAt = */ 0n,
        /* answeredInRound = */ 0n,
      ),
    );

    rounds.get(_roundId).startedAt = blockTimestamp;
  };

  /**
   * @param {bigint} _roundId
   * @param {OracleKey} _oracle
   * @param {Timestamp} blockTimestamp
   */
  const oracleInitializeNewRound = (_roundId, _oracle, blockTimestamp) => {
    if (!newRound(_roundId)) return;
    const lastStarted = oracleStatuses.get(_oracle).lastStartedRound; // cache storage reads
    if (_roundId <= add(lastStarted, restartDelay) && lastStarted !== 0n)
      return;
    initializeNewRound(_roundId, blockTimestamp);

    oracleStatuses.get(_oracle).lastStartedRound = _roundId;
  };

  /**
   * @param {bigint} _roundId
   */
  const acceptingSubmissions = _roundId => {
    return details.has(_roundId) && details.get(_roundId).maxSubmissions !== 0;
  };

  /**
   * @param {bigint} _submission
   * @param {bigint} _roundId
   * @param {OracleKey} _oracle
   */
  const recordSubmission = (_submission, _roundId, _oracle) => {
    if (!acceptingSubmissions(_roundId)) {
      console.error('round not accepting submissions');
      return false;
    }

    details.get(_roundId).submissions.push(_submission);
    oracleStatuses.get(_oracle).lastReportedRound = _roundId;
    oracleStatuses.get(_oracle).latestSubmission = _submission;
    return true;
  };

  /**
   * @param {bigint} _roundId
   * @param {Timestamp} blockTimestamp
   */
  const updateRoundAnswer = (_roundId, blockTimestamp) => {
    if (
      details.get(_roundId).submissions.length <
      details.get(_roundId).minSubmissions
    ) {
      return [false, 0];
    }

    const newAnswer = calculateMedian(
      details
        .get(_roundId)
        .submissions.filter(sample => isNat(sample) && sample > 0n),
      { add, divide: floorDivide, isGTE },
    );

    rounds.get(_roundId).answer = newAnswer;
    rounds.get(_roundId).updatedAt = blockTimestamp;
    rounds.get(_roundId).answeredInRound = _roundId;

    return [true, newAnswer];
  };

  /**
   * @param {bigint} _roundId
   */
  const deleteRoundDetails = _roundId => {
    if (
      details.get(_roundId).submissions.length <
      details.get(_roundId).maxSubmissions
    )
      return;
    details.delete(_roundId);
  };

  /**
   * @param {bigint} _roundId
   */
  const validRoundId = _roundId => {
    return _roundId <= ROUND_MAX;
  };

  /**
   */
  const oracleCount = () => {
    return oracleStatuses.getSize();
  };

  /**
   * @param {bigint} _roundId
   * @param {Timestamp} blockTimestamp
   */
  const supersedable = (_roundId, blockTimestamp) => {
    return (
      rounds.has(_roundId) &&
      (TimeMath.absValue(rounds.get(_roundId).updatedAt) > 0n ||
        timedOut(_roundId, blockTimestamp))
    );
  };

  /**
   * @param {bigint} _roundId
   * @param {bigint} _rrId
   */
  const previousAndCurrentUnanswered = (_roundId, _rrId) => {
    return add(_roundId, 1) === _rrId && rounds.get(_rrId).updatedAt === 0n;
  };

  /**
   * @param {OracleKey} _oracle
   * @param {bigint} _roundId
   * @param {Timestamp} blockTimestamp
   */
  const validateOracleRound = (_oracle, _roundId, blockTimestamp) => {
    // cache storage reads
    const startingRound = oracleStatuses.get(_oracle).startingRound;
    const rrId = reportingRoundId;

    let canSupersede = true;
    if (_roundId > 1n) {
      canSupersede = supersedable(subtract(_roundId, 1), blockTimestamp);
    }

    if (startingRound === 0n) return 'not enabled oracle';
    if (startingRound > _roundId) return 'not yet enabled oracle';
    if (oracleStatuses.get(_oracle).endingRound < _roundId)
      return 'no longer allowed oracle';
    if (oracleStatuses.get(_oracle).lastReportedRound >= _roundId)
      return 'cannot report on previous rounds';
    if (
      _roundId !== rrId &&
      _roundId !== add(rrId, 1) &&
      !previousAndCurrentUnanswered(_roundId, rrId)
    )
      return 'invalid round to report';
    if (_roundId !== 1n && !canSupersede)
      return 'previous round not supersedable';
    return '';
  };

  /**
   * @param {OracleKey} _oracle
   * @param {bigint} _roundId
   */
  const delayed = (_oracle, _roundId) => {
    const lastStarted = oracleStatuses.get(_oracle).lastStartedRound;
    return _roundId > add(lastStarted, restartDelay) || lastStarted === 0n;
  };

  /**
   * a method to provide all current info oracleStatuses need. Intended only
   * only to be callable by oracleStatuses. Not for use by contracts to read state.
   *
   * @param {OracleKey} _oracle
   * @param {Timestamp} blockTimestamp
   */
  const oracleRoundStateSuggestRound = (_oracle, blockTimestamp) => {
    const oracle = oracleStatuses.get(_oracle);

    const shouldSupersede =
      oracle.lastReportedRound === reportingRoundId ||
      !acceptingSubmissions(reportingRoundId);
    // Instead of nudging oracleStatuses to submit to the next round, the inclusion of
    // the shouldSupersede Boolean in the if condition pushes them towards
    // submitting in a currently open round.
    const canSupersede = supersedable(reportingRoundId, blockTimestamp);

    let roundId;
    let eligibleToSubmit;
    if (canSupersede && shouldSupersede) {
      roundId = add(reportingRoundId, 1);
      eligibleToSubmit = delayed(_oracle, roundId);
    } else {
      roundId = reportingRoundId;
      eligibleToSubmit = acceptingSubmissions(roundId);
    }

    let round;
    let startedAt;
    let roundTimeout;
    if (rounds.has(roundId)) {
      round = rounds.get(roundId);
      startedAt = round.startedAt;
      roundTimeout = details.get(roundId).roundTimeout;
    } else {
      startedAt = 0n;
      roundTimeout = 0;
    }

    const error = validateOracleRound(_oracle, roundId, blockTimestamp);
    if (error.length !== 0) {
      eligibleToSubmit = false;
    }

    return {
      eligibleForSpecificRound: eligibleToSubmit,
      queriedRoundId: roundId,
      oracleStatus: oracle.latestSubmission,
      startedAt,
      roundTimeout,
      oracleCount: oracleCount(),
    };
  };

  /**
   * @param {OracleKey} _oracle
   * @param {bigint} _queriedRoundId
   * @param {Timestamp} blockTimestamp
   */
  const eligibleForSpecificRound = (
    _oracle,
    _queriedRoundId,
    blockTimestamp,
  ) => {
    const error = validateOracleRound(_oracle, _queriedRoundId, blockTimestamp);
    if (TimeMath.absValue(rounds.get(_queriedRoundId).startedAt) > 0n) {
      return acceptingSubmissions(_queriedRoundId) && error.length === 0;
    } else {
      return delayed(_oracle, _queriedRoundId) && error.length === 0;
    }
  };

  /**
   * @param {OracleKey} _oracle
   */
  const getStartingRound = _oracle => {
    const currentRound = reportingRoundId;
    if (
      currentRound !== 0n &&
      currentRound === oracleStatuses.get(_oracle).endingRound
    ) {
      return currentRound;
    }
    return add(currentRound, 1);
  };

  /**
   * @type {Omit<PriceAggregatorCreatorFacet, 'makeOracleInvitation'> & {
   *   getRoundData(_roundId: BigInt): Promise<any>,
   *   oracleRoundState(_oracle: OracleKey, _queriedRoundId: BigInt): Promise<any>
   * }}
   */
  const creatorFacet = Far('PriceAggregatorChainlinkCreatorFacet', {
    deleteOracle: async oracleKey => {
      const records = keyToRecords.get(oracleKey);
      for (const record of records) {
        records.delete(record);
      }

      oracleStatuses.delete(oracleKey);

      // We should remove the entry entirely, as it is empty.
      keyToRecords.delete(oracleKey);
    },

    // unlike the median case, no query argument is passed, since polling behavior is undesired
    async initOracle(oracleInstance) {
      /** @type {OracleKey} */
      const oracleKey = oracleInstance || Far('oracleKey', {});

      /** @type {OracleRecord} */
      const record = { querier: undefined, lastSample: 0 };

      /** @type {Set<OracleRecord>} */
      let records;
      if (keyToRecords.has(oracleKey)) {
        records = keyToRecords.get(oracleKey);
      } else {
        records = new Set();
        keyToRecords.init(oracleKey, records);

        const oracleStatus = makeOracleStatus(
          /* startingRound = */ getStartingRound(oracleKey),
          /* endingRound = */ ROUND_MAX,
          /* lastReportedRound = */ 0n,
          /* lastStartedRound = */ 0n,
          /* latestSubmission = */ 0n,
          /* index = */ oracleStatuses.getSize(),
        );
        oracleStatuses.init(oracleKey, oracleStatus);
      }
      records.add(record);

      const pushResult = async ({
        roundId: _roundIdRaw = undefined,
        data: _submissionRaw,
      }) => {
        const parsedSubmission = Nat(parseInt(_submissionRaw, 10));
        const blockTimestamp = await E(timer).getCurrentTimestamp();

        let roundId;
        if (_roundIdRaw === undefined) {
          const suggestedRound = oracleRoundStateSuggestRound(
            oracleKey,
            blockTimestamp,
          );
          roundId = suggestedRound.eligibleForSpecificRound
            ? suggestedRound.queriedRoundId
            : add(suggestedRound.queriedRoundId, 1);
        } else {
          roundId = Nat(_roundIdRaw);
        }

        const error = validateOracleRound(oracleKey, roundId, blockTimestamp);
        if (!(parsedSubmission >= minSubmissionValue)) {
          console.error('value below minSubmissionValue');
          return;
        }

        if (!(parsedSubmission <= maxSubmissionValue)) {
          console.error('value above maxSubmissionValue');
          return;
        }

        if (!(error.length === 0)) {
          console.error(error);
          return;
        }

        oracleInitializeNewRound(roundId, oracleKey, blockTimestamp);
        const recorded = recordSubmission(parsedSubmission, roundId, oracleKey);
        if (!recorded) {
          return;
        }

        updateRoundAnswer(roundId, blockTimestamp);
        deleteRoundDetails(roundId);
      };

      // Obtain the oracle's publicFacet.
      assert(records.has(record), 'Oracle record is already deleted');

      /** @type {OracleAdmin} */
      const oracleAdmin = {
        async delete() {
          assert(records.has(record), 'Oracle record is already deleted');

          // The actual deletion is synchronous.
          oracleStatuses.delete(oracleKey);
          records.delete(record);

          if (
            records.size === 0 &&
            keyToRecords.has(oracleKey) &&
            keyToRecords.get(oracleKey) === records
          ) {
            // We should remove the entry entirely, as it is empty.
            keyToRecords.delete(oracleKey);
          }
        },
        async pushResult({
          roundId: _roundIdRaw = undefined,
          data: _submissionRaw,
        }) {
          // Sample of NaN, 0, or negative numbers get culled in
          // the median calculation.
          pushResult({
            roundId: _roundIdRaw,
            data: _submissionRaw,
          }).catch(console.error);
        },
      };

      return harden(oracleAdmin);
    },

    /**
     * consumers are encouraged to check
     * that they're receiving fresh data by inspecting the updatedAt and
     * answeredInRound return values.
     * return is: [roundId, answer, startedAt, updatedAt, answeredInRound], where
     * roundId is the round ID for which data was retrieved
     * answer is the answer for the given round
     * startedAt is the timestamp when the round was started. This is 0
     * if the round hasn't been started yet.
     * updatedAt is the timestamp when the round last was updated (i.e.
     * answer was last computed)
     * answeredInRound is the round ID of the round in which the answer
     * was computed. answeredInRound may be smaller than roundId when the round
     * timed out. answeredInRound is equal to roundId when the round didn't time out
     * and was completed regularly.
     *
     * @param {bigint} _roundIdRaw
     */
    async getRoundData(_roundIdRaw) {
      const roundId = Nat(_roundIdRaw);

      assert(rounds.has(roundId), V3_NO_DATA_ERROR);

      const r = rounds.get(roundId);

      assert(r.answeredInRound > 0 && validRoundId(roundId), V3_NO_DATA_ERROR);

      return {
        roundId,
        answer: r.answer,
        startedAt: r.startedAt,
        updatedAt: r.updatedAt,
        answeredInRound: r.answeredInRound,
      };
    },

    /**
     * a method to provide all current info oracleStatuses need. Intended only
     * only to be callable by oracleStatuses. Not for use by contracts to read state.
     *
     * @param {OracleKey} _oracle
     * @param {bigint} _queriedRoundId
     */
    async oracleRoundState(_oracle, _queriedRoundId) {
      const blockTimestamp = await E(timer).getCurrentTimestamp();
      if (_queriedRoundId > 0) {
        const round = rounds.get(_queriedRoundId);
        const detail = details.get(_queriedRoundId);
        return {
          eligibleForSpecificRound: eligibleForSpecificRound(
            _oracle,
            _queriedRoundId,
            blockTimestamp,
          ),
          queriedRoundId: _queriedRoundId,
          oracleStatus: oracleStatuses.get(_oracle).latestSubmission,
          startedAt: round.startedAt,
          roundTimeout: detail.roundTimeout,
          oracleCount: oracleCount(),
        };
      } else {
        return oracleRoundStateSuggestRound(_oracle, blockTimestamp);
      }
    },
  });

  const publicFacet = Far('publicFacet', {
    getPriceAuthority() {
      return priceAuthority;
    },
    getRoundStartNotifier() {
      return roundStartNotifier;
    },
  });

  return harden({ creatorFacet, publicFacet });
};

export { start };
