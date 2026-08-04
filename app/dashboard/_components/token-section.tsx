'use client';
import React, { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '@/lib/contracts/use-web3';
import Card from '@/components/card';
import TxStatus from '@/components/tx-status';
import { Coins, Send, ShieldCheck, RefreshCw, UserCog, ArrowRightLeft } from 'lucide-react';
import TestTokenArtifact from '@/lib/contracts/TestToken.json';

export default function TokenSection() {
  const { signer, provider, isConnected, address, tokenAddress, sessionManagerAddress, chainId } = useWeb3();
  const [balance, setBalance] = useState('0');
  const [allowance, setAllowance] = useState('0');
  const [tokenOwner, setTokenOwner] = useState('');
  const [mintTo, setMintTo] = useState('');
  const [mintAmount, setMintAmount] = useState('');
  const [approveAmount, setApproveAmount] = useState('');
  const [sendTo, setSendTo] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [txStatus, setTxStatus] = useState<any>({ status: 'idle' });

  const isOwner = !!(address && tokenOwner && address.toLowerCase() === tokenOwner.toLowerCase());

  const getContract = useCallback(() => {
    if (!signer || !tokenAddress) return null;
    return new ethers.Contract(tokenAddress, TestTokenArtifact.abi, signer);
  }, [signer, tokenAddress]);

  const fetchBalances = useCallback(async () => {
    if (!provider || !tokenAddress || !address) return;
    try {
      const contract = new ethers.Contract(tokenAddress, TestTokenArtifact.abi, provider);
      const bal = await contract.balanceOf(address);
      setBalance(ethers.utils.formatEther(bal));
      if (sessionManagerAddress) {
        const allow = await contract.allowance(address, sessionManagerAddress);
        setAllowance(ethers.utils.formatEther(allow));
      }
      const ownerAddr = await contract.owner();
      setTokenOwner(ownerAddr);
    } catch (e: any) {
      console.error('Fetch balance error:', e);
    }
  }, [provider, tokenAddress, address, sessionManagerAddress]);

  useEffect(() => { fetchBalances(); }, [fetchBalances]);

  const handleMint = async () => {
    const contract = getContract();
    if (!contract || !mintAmount) return;
    setTxStatus({ status: 'pending', message: 'Minting points...' });
    try {
      const tx = await contract.mint(mintTo || address, ethers.utils.parseEther(mintAmount));
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Minted ${mintAmount} pts` });
      fetchBalances();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: e?.reason || e?.message || 'Mint failed' });
    }
  };

  const handleSend = async () => {
    const contract = getContract();
    if (!contract || !sendAmount || !ethers.utils.isAddress(sendTo)) return;
    setTxStatus({ status: 'pending', message: 'Sending points...' });
    try {
      const tx = await contract.transfer(sendTo, ethers.utils.parseEther(sendAmount));
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Sent ${sendAmount} pts to ${sendTo}` });
      setSendTo('');
      setSendAmount('');
      fetchBalances();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: e?.reason || e?.message || 'Send failed' });
    }
  };

  const handleTransferOwnership = async () => {
    const contract = getContract();
    if (!contract || !newOwner || !ethers.utils.isAddress(newOwner)) return;
    setTxStatus({ status: 'pending', message: 'Transferring ownership...' });
    try {
      const tx = await contract.transferOwnership(newOwner);
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Ownership transferred to ${newOwner}` });
      setNewOwner('');
      fetchBalances();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: e?.reason || e?.message || 'Transfer ownership failed' });
    }
  };

  const handleApprove = async () => {
    const contract = getContract();
    if (!contract || !approveAmount || !sessionManagerAddress) return;
    setTxStatus({ status: 'pending', message: 'Approving points...' });
    try {
      const tx = await contract.approve(sessionManagerAddress, ethers.utils.parseEther(approveAmount));
      setTxStatus({ status: 'pending', message: 'Waiting for confirmation...', hash: tx.hash });
      await tx.wait();
      setTxStatus({ status: 'success', hash: tx.hash, message: `Approved ${approveAmount} pts for SessionManager` });
      fetchBalances();
    } catch (e: any) {
      setTxStatus({ status: 'error', error: e?.reason || e?.message || 'Approve failed' });
    }
  };

  if (!tokenAddress) {
    return <Card><p className="text-txt-secondary text-sm text-center py-8">Deploy or load TestToken address in the Deploy tab first.</p></Card>;
  }

  return (
    <div className="space-y-4">
      <Card title="Token Balances" icon={<Coins className="w-5 h-5 text-accent" />}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-surface-tertiary rounded-lg p-4">
            <p className="text-xs text-txt-secondary">Your Balance</p>
            <p className="text-2xl font-bold text-accent mt-1">{parseFloat(balance || '0').toFixed(4)}</p>
            <p className="text-xs text-txt-secondary">TEST points</p>
          </div>
          <div className="bg-surface-tertiary rounded-lg p-4">
            <p className="text-xs text-txt-secondary">SessionManager Allowance</p>
            <p className="text-2xl font-bold text-green-400 mt-1">{parseFloat(allowance || '0').toFixed(4)}</p>
            <p className="text-xs text-txt-secondary">TEST points approved</p>
          </div>
        </div>
        <button onClick={fetchBalances} className="mt-3 flex items-center gap-1.5 text-xs text-accent hover:underline">
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card title="Mint Points" icon={<Send className="w-5 h-5 text-accent" />}>
          <p className="text-xs text-txt-secondary mb-1">Owner only \u2014 mint test points to any address.</p>
          {tokenOwner && (
            <p className="text-xs font-mono mb-3 break-all">
              Owner: <span className="text-accent">{tokenOwner}</span>
              {isConnected && address && (
                isOwner ? (
                  <span className="text-green-400 ml-2">(you)</span>
                ) : (
                  <span className="text-red-400 ml-2">(not you \u2014 mint will revert)</span>
                )
              )}
            </p>
          )}
          <div className="space-y-3">
            <div>
              <label className="text-xs text-txt-secondary">Recipient (blank = self)</label>
              <input value={mintTo} onChange={(e) => setMintTo(e.target.value)} placeholder="0x... or leave empty" className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <div>
              <label className="text-xs text-txt-secondary">Amount</label>
              <input value={mintAmount} onChange={(e) => setMintAmount(e.target.value)} placeholder="1000" type="number" className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <button onClick={handleMint} disabled={!isConnected || !mintAmount} className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold py-2.5 rounded-lg text-sm transition-colors">
              Mint Points
            </button>
          </div>
        </Card>

        <Card title="Approve Spending" icon={<ShieldCheck className="w-5 h-5 text-accent" />}>
          <p className="text-xs text-txt-secondary mb-3">Approve SessionManager to spend your points for match entry fees.</p>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-txt-secondary">Amount to Approve</label>
              <input value={approveAmount} onChange={(e) => setApproveAmount(e.target.value)} placeholder="10000" type="number" className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <button onClick={handleApprove} disabled={!isConnected || !approveAmount || !sessionManagerAddress} className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold py-2.5 rounded-lg text-sm transition-colors">
              Approve SessionManager
            </button>
          </div>
        </Card>

        <Card title="Send Points" icon={<ArrowRightLeft className="w-5 h-5 text-accent" />}>
          <p className="text-xs text-txt-secondary mb-3">Transfer points from your balance to any address.</p>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-txt-secondary">Recipient</label>
              <input value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="0x..." className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label className="text-xs text-txt-secondary">Amount</label>
                <button type="button" onClick={() => setSendAmount(balance)} className="text-xs text-accent hover:underline">
                  Max: {parseFloat(balance || '0').toFixed(4)}
                </button>
              </div>
              <input value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} placeholder="100" type="number" className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <button onClick={handleSend} disabled={!isConnected || !sendAmount || !ethers.utils.isAddress(sendTo)} className="w-full bg-accent hover:bg-accent-dark disabled:opacity-40 text-black font-semibold py-2.5 rounded-lg text-sm transition-colors">
              Send Points
            </button>
          </div>
        </Card>
      </div>

      {isOwner && (
        <Card title="Transfer Ownership" icon={<UserCog className="w-5 h-5 text-accent" />}>
          <p className="text-xs text-txt-secondary mb-3">
            Transfer minting rights to a new address. This is irreversible — you will lose owner access unless the new owner transfers it back.
          </p>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-txt-secondary">New Owner Address</label>
              <input value={newOwner} onChange={(e) => setNewOwner(e.target.value)} placeholder="0x..." className="w-full mt-1 bg-surface-tertiary rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <button onClick={handleTransferOwnership} disabled={!isConnected || !ethers.utils.isAddress(newOwner)} className="w-full bg-red-500/90 hover:bg-red-500 disabled:opacity-40 text-black font-semibold py-2.5 rounded-lg text-sm transition-colors">
              Transfer Ownership
            </button>
          </div>
        </Card>
      )}

      <TxStatus {...(txStatus ?? {})} chainId={chainId} />
    </div>
  );
}
