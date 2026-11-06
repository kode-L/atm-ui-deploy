'use client';
import React from 'react';
import { ARTIFACT_MANIFEST } from '@/lib/contracts/voucher-v2';

// Which build is running: git commit (+ branch, commit time, uncommitted changes), build time, and the
// voucher contract ABIs bundled with it. Values are fixed at build time (next.config.js → env).
const utc = (s?: string) => {
  const ts = Number(s);
  return ts ? `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
};

export default function BuildInfo() {
  const commit = process.env.NEXT_PUBLIC_BUILD_COMMIT || 'unknown';
  const branch = process.env.NEXT_PUBLIC_BUILD_BRANCH || '';
  const committed = utc(process.env.NEXT_PUBLIC_BUILD_COMMIT_TIME);
  const built = utc(process.env.NEXT_PUBLIC_BUILD_TIME);
  const dirty = process.env.NEXT_PUBLIC_BUILD_DIRTY === '1';
  const abi = ARTIFACT_MANIFEST?.gitCommit;
  const text = [
    `Build ${commit}${dirty ? ' +uncommitted changes' : ''}`,
    branch,
    committed && `committed ${committed}`,
    built && `built ${built}`,
    abi && `voucher contracts ABI ${abi}${ARTIFACT_MANIFEST.gitDirty ? '+dirty' : ''}`,
  ].filter(Boolean).join(' · ');
  return (
    <footer className="max-w-[1200px] mx-auto px-4 py-4 text-[11px] text-txt-secondary/70 border-t border-white/5 flex flex-wrap items-center gap-x-2">
      <span className="font-mono">
        Build <b className="text-txt-secondary">{commit}</b>
        {dirty && <span className="text-yellow-300"> +uncommitted changes</span>}
      </span>
      {branch && <span>· {branch}</span>}
      {committed && <span>· committed {committed}</span>}
      {built && <span>· built {built}</span>}
      {abi && <span>· voucher contracts ABI <span className="font-mono">{abi}</span>{ARTIFACT_MANIFEST.gitDirty ? '+dirty' : ''}</span>}
      <button type="button" className="ml-auto text-accent hover:underline" onClick={() => { try { navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ } }}>
        copy
      </button>
    </footer>
  );
}
