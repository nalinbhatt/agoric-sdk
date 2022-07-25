// @ts-check

import { AmountShape } from '@agoric/ertp';
import { M } from '@agoric/store';
import { TimestampValueShape } from '@agoric/swingset-vat';

export const AmountKeywordRecordShape = M.recordOf(M.string(), AmountShape);
export const AmountPatternKeywordRecordShape = M.recordOf(
  M.string(),
  M.pattern(),
);

/**
 * After defaults are filled in
 */
export const ProposalShape = harden({
  want: AmountPatternKeywordRecordShape,
  give: AmountKeywordRecordShape,
  // To accept only one, we could use M.or rather than M.partial,
  // but the error messages would have been worse. Rather,
  // cleanProposal's assertExit checks that there's exactly one.
  exit: M.partial(
    {
      onDemand: null,
      waived: null,
      afterDeadline: {
        timer: M.remotable(),
        deadline: TimestampValueShape,
      },
    },
    {},
  ),
});

export const isOnDemandExitRule = exit => {
  const [exitKey] = Object.getOwnPropertyNames(exit);
  return exitKey === 'onDemand';
};

/**
 * @param {ExitRule} exit
 * @returns {exit is WaivedExitRule}
 */
export const isWaivedExitRule = exit => {
  const [exitKey] = Object.getOwnPropertyNames(exit);
  return exitKey === 'waived';
};

/**
 * @param {ExitRule} exit
 * @returns {exit is AfterDeadlineExitRule}
 */
export const isAfterDeadlineExitRule = exit => {
  const [exitKey] = Object.getOwnPropertyNames(exit);
  return exitKey === 'afterDeadline';
};

export const InvitationElementShape = M.split({
  description: M.string(),
  handle: M.remotable(), // invitationHandle
  instance: M.remotable(),
  installation: M.remotable(),
});
