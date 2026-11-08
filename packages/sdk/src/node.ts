/** Node-only helpers: local key files and a JSONL recorder. */
import { access, appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { generateKey, isValidAccountId, Near, parseKey } from "near-kit";
import { createByline, type CreateBylineOptions, type CreatedByline } from "./onboard.js";
import { FileKeyStore } from "near-kit/keys/file";
import { nearConfig, type NetworkId, type Recorder } from "./types.js";

/**
 * A near-kit signer backed by `~/.near-credentials/<network>/` (the near-cli layout).
 * Keys stay on disk; nothing is copied into env vars.
 */
export function nearFromCredentials(accountId: string, network: NetworkId, dir = join(homedir(), ".near-credentials")): Near {
  return new Near({ ...nearConfig(network), keyStore: new FileKeyStore(dir, network), defaultSignerId: accountId });
}

/** Appends every SDK event as one JSON line. The indexer reads this file. */
export function jsonlRecorder(path: string): Recorder {
  let ready: Promise<unknown> | undefined;
  return async (event) => {
    ready ??= mkdir(dirname(path), { recursive: true });
    await ready;
    await appendFile(path, JSON.stringify(event) + "\n");
  };
}

/**
 * Generate a key for a new agent account and save it as `<dir>/<network>/<accountId>.json` (mode 600).
 * Returns only the public key, which `registry.createAccount` needs. Refuses to overwrite a key.
 */
export async function generateAgentKey(
  accountId: string,
  network: NetworkId,
  dir = join(homedir(), ".near-credentials"),
): Promise<{ publicKey: string; path: string }> {
  const key = generateKey();
  const publicKey = key.publicKey.toString();
  const path = join(dir, network, `${accountId}.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ account_id: accountId, public_key: publicKey, private_key: key.secretKey }, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  return { publicKey, path };
}

/**
 * Onboard an agent from nothing: generate a key, register gaslessly through the relayer, and save the
 * key as `~/.near-credentials/<network>/<code>.<registry>.json` (mode 600), the near-cli layout.
 *
 * The key is written to disk before anything is sent, so it's never lost even if the network fails.
 * Pass `keyFile` to retry with a key you already have; the same key always maps to the same byline.
 */
export async function createAgentByline(
  opts: Omit<CreateBylineOptions, "keyPair"> & { keyFile?: string; dir?: string },
): Promise<CreatedByline & { keyFile: string }> {
  const dir = join(opts.dir ?? join(homedir(), ".near-credentials"), opts.network);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  let keyFile = opts.keyFile;
  let keyPair;
  if (keyFile) {
    const saved = JSON.parse(await readFile(keyFile, "utf8")) as { private_key: string };
    keyPair = parseKey(saved.private_key);
  } else {
    keyPair = generateKey();
    keyFile = join(dir, `byline-pending-${keyPair.publicKey.toString().slice(8, 20)}.json`);
    await writeFile(keyFile, JSON.stringify({ account_id: null, public_key: keyPair.publicKey.toString(), private_key: keyPair.secretKey }, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
  }

  const created = await createByline({ ...opts, keyPair });
  // The account name becomes a file name: never let it leave the keys directory.
  if (!isValidAccountId(created.accountId) || created.accountId.includes("/")) throw new Error(`Refusing to save a key for an invalid account id: ${created.accountId}`);
  const finalPath = join(dir, `${created.accountId}.json`);
  if (keyFile !== finalPath) {
    const taken = await access(finalPath).then(() => true, () => false);
    if (!taken) {
      await writeFile(keyFile, JSON.stringify({ account_id: created.accountId, public_key: created.publicKey, private_key: keyPair.secretKey }, null, 2), { mode: 0o600 });
      await rename(keyFile, finalPath);
      keyFile = finalPath;
    }
  }
  return { ...created, keyFile };
}
