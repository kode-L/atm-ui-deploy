import { ethers } from 'ethers';

/**
 * createTodaySession/finalizeDailyPoints make a best-effort external call into the
 * GameHub (notifySessionCreated/notifyDayFinalized) that writes fresh storage slots
 * the first time a given dateKey is reported. If the dateKey rolls over between
 * MetaMask's gas estimate and the tx actually mining (easy to hit with a short
 * sessionDuration configured for testing), the estimate reflects the cheap
 * already-reported path while execution hits the expensive first-time path, and the
 * inner hub call can run out of gas — silently before, now surfaced via
 * HubNotifyFailed. Padding the estimated gas limit avoids that race.
 */
export async function sendWithGasBuffer(
  contract: ethers.Contract,
  method: string,
  args: any[],
  bufferMultiplier = 1.3
): Promise<ethers.ContractTransaction> {
  const estimated = await contract.estimateGas[method](...args);
  const gasLimit = estimated.mul(Math.round(bufferMultiplier * 100)).div(100);
  return contract[method](...args, { gasLimit });
}
