import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Generates the dedicated Papertrade wallet and an API token.
// Run this on the deployment VM and paste the output into .env;
// the key is printed once and never written anywhere by this script.
const privateKey = generatePrivateKey();
const { address } = privateKeyToAccount(privateKey);

process.stdout.write(
  [
    `# Papertrade wallet address (fund this via its deposit address): ${address}`,
    `WALLET_PRIVATE_KEY=${privateKey}`,
    `API_TOKEN=${randomBytes(32).toString("hex")}`,
    "",
  ].join("\n"),
);
