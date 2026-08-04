import { ethers } from 'ethers';
import SessionManagerArtifact from '@/lib/contracts/DailySessionManager.json';
import GameHubArtifact from '@/lib/contracts/GameHub.json';

// GameHub shares most error/event names with DailySessionManager (identical selectors),
// so only pull in the handful that are actually unique to it — avoids ethers warning
// about duplicate fragment definitions when building the Interface.
const sessionManagerErrorNames = new Set(
  SessionManagerArtifact.abi.filter((f: any) => f.type === 'error').map((f: any) => f.name)
);
const hubOnlyErrors = GameHubArtifact.abi.filter(
  (f: any) => f.type === 'error' && !sessionManagerErrorNames.has(f.name)
);
const iface = new ethers.utils.Interface([...SessionManagerArtifact.abi, ...hubOnlyErrors]);

// Human-friendly names for known role hashes
const ROLE_NAMES: Record<string, string> = {
  '0x0000000000000000000000000000000000000000000000000000000000000000': 'DEFAULT_ADMIN_ROLE',
  '0x31df88ddf9a414f836ac658da56c3aeddd70c989e9b49be4778df156cdf36f46': 'SESSION_OPERATOR_ROLE',
  '0xb58d5b41fc8d502d82b6e13b07ad5a883760eca56d27dd0d61794831de8c2bab': 'PLATFORM_UPDATER_ROLE',
};

// Map error names to human-friendly messages
const ERROR_MESSAGES: Record<string, string> = {
  InvalidAddress: 'Invalid address (zero address not allowed)',
  InvalidValue: 'Invalid value (out of range)',
  InvalidName: 'Name cannot be empty',
  InvalidDaysCount: 'Invalid days count',
  InvalidAmount: 'Amount must be > 0',
  OperatorAlreadyActive: 'Operator is already registered and active',
  OperatorNotActive: 'Operator is not active or not registered',
  OperatorSlotTaken: 'This SessionManager instance is already bound to a different operator — each instance can only ever serve one operator',
  UpdaterAlreadyActive: 'Updater is already registered',
  UpdaterNotActive: 'Updater is not active or not registered',
  RewardTypeNotFound: 'Reward type does not exist',
  RewardTypeInactive: 'Reward type is inactive',
  RewardTypeNotAllowed: 'Operator is not allowed to use this reward type (check setOperatorRewardRule)',
  SessionNotFound: 'Session does not exist',
  MatchNotFound: 'Match does not exist',
  InvalidSessionStatus: 'Invalid session status for this operation (session must be ACTIVE)',
  InvalidMatchStatus: 'Invalid match status for this operation (match must be CREATED)',
  NotSessionOperator: 'Caller is not the operator of this session',
  SessionAlreadyEnded: 'Session has already ended',
  SessionNotEndedYet: 'Session has not ended yet',
  SessionAlreadyExistsForToday: 'You already have a session for today (one per operator per day)',
  NoSessionForOperatorAndDate: 'No session found for this operator on this date',
  DayAlreadyFinalized: 'All operators for this day have already been finalized (global)',
  DayNotFinalized: 'This day\'s points have not been fully finalized yet — PR boost requires all operators to be finalized',
  GracePeriodExpired: 'Grace period has expired — PR boost can no longer be set for this dateKey (check the configured claim window on the Admin tab)',
  OperatorAlreadyFinalized: 'This operator has already been finalized for this day',
  OperatorNotFinalized: 'This operator has not been finalized for this day yet',
  UpdaterNotLinkedToOperator: 'Your updater wallet is not linked to any operator — register via Admin → Platform Updater Management',
  LengthMismatch: 'Array lengths do not match',
  EmptyArray: 'Array must not be empty',
  DuplicatePlayer: 'Duplicate player address in the list',
  RankedPlayersMismatch: 'Ranked players array must contain exactly all match players',
  PlayerNotInMatch: 'A player in the ranked list is not a registered participant of this match',
  PlayerCountOutOfRange: 'Player count is outside the reward type min/max range',
  PlacementBpsTooHigh: 'Total placement BPS exceeds 10000 (100%)',
  RewardExceedsPot: 'Total positive point deltas exceed the match pot (entryFee × players)',
  MatchAlreadySettled: 'Match has already been settled',
  OnlyTwoPlayersAllowed: 'Exactly 2 players are required per match',
  PointsCannotIncrease: 'Points can only be decreased (downward correction only)',

  EnforcedPause: 'Contract is paused',
  ExpectedPause: 'Contract is not paused (expected paused)',
  AccessControlBadConfirmation: 'Access control: bad confirmation',

  // GameHub-only
  OperatorAlreadyRegistered: 'This operator (or instance) is already registered on the hub',
  InstanceHubMismatch: "This instance's hub variable doesn't point at this GameHub — double-check the instance address",
  NotRegisteredInstance: 'This instance is not registered on the hub (link it via Hub tab → Link Existing Instance)',
  RewardTypeIdMismatch: 'Reward type ID mismatch while replaying the catalog to an instance',
};

export function decodeError(e: any): string {
  // Try to extract raw revert data
  const rawData = e?.error?.data?.data || e?.error?.data || e?.data?.data || e?.data;

  // Empty revert data (0x) usually means ABI mismatch — the function doesn't exist on the deployed contract
  if (rawData === '0x' || rawData === '0x0') {
    return 'Transaction reverted with empty data (0x) — this usually means the contract at this address does not have the called function. Please redeploy the Daily PR Boost Manager contract from the Deploy tab.';
  }

  if (typeof rawData === 'string' && rawData.startsWith('0x') && rawData.length >= 10) {
    try {
      const parsed = iface.parseError(rawData);
      if (parsed) {
        const name = parsed.name;

        // Special handling for AccessControlUnauthorizedAccount
        if (name === 'AccessControlUnauthorizedAccount') {
          const account = parsed.args[0];
          const role = parsed.args[1];
          const roleName = ROLE_NAMES[role?.toLowerCase()] || role;
          return `Access denied: account ${account.slice(0, 10)}... is missing role ${roleName}`;
        }

        // SafeERC20FailedOperation
        if (name === 'SafeERC20FailedOperation') {
          return `ERC20 transfer failed for token ${parsed.args[0]?.slice(0, 10)}... — check balance and approval`;
        }

        // Look up human message
        if (ERROR_MESSAGES[name]) {
          return ERROR_MESSAGES[name];
        }

        // Fallback: return error name
        return `Contract error: ${name}`;
      }
    } catch {
      // Could not parse — fall through
    }
  }

  // Try standard reason string
  if (e?.reason) return e.reason;
  if (e?.error?.reason) return e.error.reason;

  // Try message
  const msg = e?.message || '';

  // Detect user rejection
  if (msg.includes('user rejected') || msg.includes('ACTION_REJECTED')) {
    return 'Transaction rejected by user';
  }

  // Generic revert with hints
  if (msg.includes('execution reverted') || msg.includes('CALL_EXCEPTION')) {
    if (msg.includes('0x') && !msg.includes('0x0')) {
      return 'Transaction reverted — likely a missing role, wrong session status, or insufficient token approval. Check the Admin tab setup.';
    }
    return 'Transaction reverted — this may indicate the contract at the loaded address does not match the expected ABI. Try redeploying the contract from the Deploy tab, or check that you have the correct roles assigned.';
  }

  return msg || 'Unknown error';
}
