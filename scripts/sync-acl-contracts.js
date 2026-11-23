// Copies the ACL contract set (ATMAccessControl, its proxy, ATMAccessControlDAO + proxy, Factory,
// Trader v1.0.5)
// from the tested atm-smart-contract build into lib/contracts/acl/, with a minimal Etherscan
// verification input per contract (only the sources that contract's metadata lists).
//
// Usage: node scripts/sync-acl-contracts.js [path/to/atm-smart-contract]
// Build first in that repo:
//   npx hardhat --config hardhat.fork.config.js compile   (ACL, DAO, DAO proxy, Factory, Trader)
//   npx hardhat --config hardhat.acl.config.js compile    (ACL proxy, Factory proxy)
const fs = require('fs');
const path = require('path');

const repo = path.resolve(process.argv[2] || path.join(process.env.HOME, 'Developer/atm/atm-smart-contract'));
const out = path.join(__dirname, '..', 'lib', 'contracts', 'acl');

const CONTRACTS = [
  ['artifacts-fork', 'contracts/ATMAccessControl.sol', 'ATMAccessControl'],
  ['artifacts-acl', 'contracts/proxy/access_control_proxy.sol', 'ATMAccessControlProxy'],
  ['artifacts-acl', 'contracts/proxy/factory_proxy.sol', 'FactoryPorxy'], // testnet-only test Factory proxy
  ['artifacts-fork', 'contracts/acl/ATMAccessControlDAO.sol', 'ATMAccessControlDAO'],
  ['artifacts-fork', 'contracts/proxy/acl_dao_proxy.sol', 'ATMAccessControlDAOProxy'],
  ['artifacts-fork', 'contracts/factory.sol', 'Factory'],
  ['artifacts-fork', 'contracts/traderV6.sol', 'Trader'],
];

fs.mkdirSync(out, { recursive: true });
const manifest = {};
for (const [dir, file, name] of CONTRACTS) {
  const base = path.join(repo, dir, file, name);
  const art = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
  const dbg = JSON.parse(fs.readFileSync(`${base}.dbg.json`, 'utf8'));
  const info = JSON.parse(fs.readFileSync(path.resolve(path.dirname(base), dbg.buildInfo), 'utf8'));
  const compiled = info.output.contracts[file][name];
  if (`0x${compiled.evm.bytecode.object}` !== art.bytecode) throw new Error(`${name}: artifact and build-info bytecode differ`);
  const meta = JSON.parse(compiled.metadata);
  const sources = Object.fromEntries(Object.keys(meta.sources).map((s) => [s, { content: info.input.sources[s].content }]));
  const input = { language: 'Solidity', sources, settings: { ...info.input.settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } } } };
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ contractName: name, abi: art.abi, bytecode: art.bytecode }, null, 2) + '\n');
  fs.writeFileSync(path.join(out, `${name}.verify.json`), JSON.stringify({ compilerVersion: `v${info.solcLongVersion}`, contractName: `${file}:${name}`, input }) + '\n');
  manifest[name] = { source: file, build: path.basename(dbg.buildInfo), compiler: info.solcLongVersion, sources: Object.keys(sources).length };
  console.log(`${name}: ${Object.keys(sources).length} sources, solc ${info.solcLongVersion}`);
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ from: 'atm-smart-contract', contracts: manifest }, null, 2) + '\n');
