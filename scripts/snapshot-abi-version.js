const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/**
 * Freezes the current lib/contracts/*.json (abi + bytecode) into
 * lib/contracts/versions/<version>/ so historical ABIs stay available after
 * later contract upgrades. Run this once per deployed version, right after
 * syncing fresh ABIs from smart_contracts/artifacts (see CLAUDE.md section 7).
 *
 * Usage:
 *   node scripts/snapshot-abi-version.js v1 "Initial platform deployment"
 *   FORCE=1 node scripts/snapshot-abi-version.js v1 "Re-snapshot after a fix"
 */
function main() {
  const [, , version, ...labelParts] = process.argv;
  if (!version) {
    throw new Error('Usage: node scripts/snapshot-abi-version.js <version> ["label"]');
  }
  const label = labelParts.join(" ") || "";

  const contractsDir = path.join(__dirname, "..", "lib", "contracts");
  const versionsDir = path.join(contractsDir, "versions");
  const targetDir = path.join(versionsDir, version);

  if (fs.existsSync(targetDir) && !process.env.FORCE) {
    throw new Error(`${targetDir} already exists. Set FORCE=1 to overwrite an existing snapshot.`);
  }
  fs.mkdirSync(targetDir, { recursive: true });

  const abiFiles = fs
    .readdirSync(contractsDir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => fs.statSync(path.join(contractsDir, f)).isFile());

  if (abiFiles.length === 0) {
    throw new Error(`No .json ABI files found in ${contractsDir}`);
  }

  for (const file of abiFiles) {
    fs.copyFileSync(path.join(contractsDir, file), path.join(targetDir, file));
  }

  let gitCommit = "unknown";
  try {
    gitCommit = execSync("git rev-parse HEAD", { cwd: path.join(__dirname, "..") }).toString().trim();
  } catch {
    // not fatal — repo may be shallow or git unavailable
  }

  const manifest = {
    version,
    label,
    date: new Date().toISOString(),
    gitCommit,
    contracts: abiFiles.sort(),
  };
  fs.writeFileSync(path.join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const indexPath = path.join(versionsDir, "index.json");
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : [];
  const withoutThisVersion = index.filter((entry) => entry.version !== version);
  withoutThisVersion.push({ version, label, date: manifest.date, gitCommit });
  fs.writeFileSync(indexPath, JSON.stringify(withoutThisVersion, null, 2));

  console.log(`Snapshotted ${abiFiles.length} ABI file(s) to lib/contracts/versions/${version}/`);
  console.log(`  label:     ${label || "(none)"}`);
  console.log(`  gitCommit: ${gitCommit}`);
}

main();
