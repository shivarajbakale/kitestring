#!/usr/bin/env node
// Generates a stable extension key pair. Writes the private key to keys/bx.pem (gitignored)
// and prints { key, id }: `key` (base64 SPKI DER) goes into packages/extension/package.json
// manifest.key; `id` goes into packages/protocol/src/constants.ts EXTENSION_ID.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pemPath = join(root, "keys", "bx.pem")

let privatePem
if (existsSync(pemPath) && !process.argv.includes("--force")) {
  privatePem = readFileSync(pemPath, "utf8")
} else {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  privatePem = privateKey.export({ type: "pkcs8", format: "pem" })
  mkdirSync(dirname(pemPath), { recursive: true })
  writeFileSync(pemPath, privatePem, { mode: 0o600 })
}

const der = createPublicKey(createPrivateKey(privatePem)).export({ type: "spki", format: "der" })
const hex = createHash("sha256").update(der).digest("hex").slice(0, 32)
const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("")
console.log(JSON.stringify({ key: der.toString("base64"), id }, null, 2))
