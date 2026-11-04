import { ethers } from 'ethers';
import { LinkStatus } from './index';
import { isExpired, type LinkRecord } from './indexer';

// How a link looks from one wallet's side — same states/labels/tabs as atm-prod's Consensus
// Connection page (getUIState / getLabelFromState), but derived purely from chain state
// (Link.getLinkInfo/getCloseInfo + expiry) instead of the backend's linkStatus codes.

export type ConnTab = 'active' | 'pending' | 'inactive';
export type ConnState =
  | 'pendingIncoming' | 'pendingOutgoing'
  | 'cancellationRequestIncoming' | 'cancellationRequestOutgoing'
  | 'connected' | 'redeemable'
  | 'cancelledRequest' | 'rejectedRequest' | 'redeemed' | 'redeemedEarly';

export const CONN_LABELS: Record<ConnState, string> = {
  pendingIncoming: 'Incoming request',
  pendingOutgoing: 'Outgoing request',
  cancellationRequestIncoming: 'Disconnect request',
  cancellationRequestOutgoing: 'Disconnect requested',
  connected: 'Connected',
  redeemable: 'Redeemable',
  cancelledRequest: 'Cancelled',
  rejectedRequest: 'Rejected',
  redeemed: 'Redeemed',
  redeemedEarly: 'Early Redemption',
};

export const CONN_ACTIONS: Partial<Record<ConnState, string>> = {
  pendingIncoming: 'Accept (Bulk Approve)',
  pendingOutgoing: 'Cancel (Bulk Disconnect)',
  cancellationRequestIncoming: 'Agree to disconnect (Bulk Disconnect)',
  connected: 'Disconnect (Bulk Disconnect)',
  redeemable: 'Redeem (Bulk Disconnect)',
};

export const CONN_TONE: Record<ConnState, 'good' | 'warn' | 'bad' | 'muted'> = {
  pendingIncoming: 'warn', pendingOutgoing: 'muted', cancellationRequestIncoming: 'warn', cancellationRequestOutgoing: 'muted',
  connected: 'good', redeemable: 'good', cancelledRequest: 'muted', rejectedRequest: 'bad', redeemed: 'muted', redeemedEarly: 'muted',
};

export interface ConnView {
  r: LinkRecord;
  tab: ConnTab;
  state: ConnState;
  label: string;
  direction: 'inbound' | 'outbound'; // outbound = this wallet created it (userA)
  counterparty: string;
  myAmount: ethers.BigNumber;
  otherAmount: ethers.BigNumber;
  total: ethers.BigNumber;
  createdAt: number; // creation time (log timestamp), falling back to startTime
  daysRemaining: number | null; // null until accepted (lock starts on agree)
  pledged: boolean;
}

export function connectionView(r: LinkRecord, wallet: string, nowSec = Date.now() / 1000): ConnView {
  const me = wallet.toLowerCase();
  const isA = r.userA.toLowerCase() === me || (!r.userA && r.creator.toLowerCase() === me);
  const direction = isA ? 'outbound' : 'inbound';
  const amountA = ethers.BigNumber.from(r.amountA || '0');
  const amountB = ethers.BigNumber.from(r.amountB || '0');
  const expired = isExpired(r, nowSec);
  let state: ConnState;
  let tab: ConnTab;

  if (r.status === LinkStatus.INITED) {
    state = isA ? 'pendingOutgoing' : 'pendingIncoming'; tab = 'pending';
  } else if (r.status === LinkStatus.CLOSED) {
    tab = 'inactive';
    if (!r.expiredTime) state = r.closer.toLowerCase() === r.userB.toLowerCase() ? 'rejectedRequest' : 'cancelledRequest'; // never accepted
    else state = r.closeTime >= r.expiredTime ? 'redeemed' : 'redeemedEarly';
  } else if (expired) {
    state = 'redeemable'; tab = 'active';
  } else if (r.status === LinkStatus.AGREED && (r.closeReqA || r.closeReqB)) {
    const mine = isA ? r.closeReqA : r.closeReqB;
    state = mine ? 'cancellationRequestOutgoing' : 'cancellationRequestIncoming'; tab = 'pending';
  } else {
    state = 'connected'; tab = 'active';
  }

  return {
    r, tab, state, label: CONN_LABELS[state], direction,
    counterparty: isA ? r.userB : r.userA,
    myAmount: isA ? amountA : amountB,
    otherAmount: isA ? amountB : amountA,
    total: amountA.add(amountB),
    createdAt: r.createdAt || r.startTime,
    daysRemaining: r.expiredTime ? Math.ceil((r.expiredTime - nowSec) / 86400) : null,
    pledged: r.status === LinkStatus.PLEDGED,
  };
}
