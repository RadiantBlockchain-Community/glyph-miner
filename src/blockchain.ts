import localforage from "localforage";
import {
  base58AddressToLockingBytecode,
  bigIntToVmNumber,
  encodeDataPush,
  numberToBinUint32LEClamped,
  Opcodes,
  pushNumberOpcodeToNumber,
  swapEndianness,
  vmNumberToBigInt,
} from "@bitauth/libauth";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { Script, Transaction } from "@radiantblockchain/radiantjs";
import { decodeGlyph } from "./glyph";
import {
  accepted,
  balance,
  contract,
  contractsUrl,
  glyph,
  loadingContract,
  mineToAddress,
  miningStatus,
  mintMessage,
  nonces,
  rejected,
  utxos,
  wallet,
  work,
} from "./signals";
import { effect } from "@preact/signals-react";
import { addMessage } from "./message";
import miner, { updateWork } from "./miner";
import { Buffer } from "buffer";
import { arrayChunks, isRef, reverseRef } from "./utils";
import { client } from "./client";
import { ContractGroup, Contract, Work, Utxo, Token } from "./types";

const FEE_PER_KB = 2000000;

export function scriptHash(bytecode: Uint8Array): string {
  return swapEndianness(bytesToHex(sha256(bytecode)));
}

// Consume nonces signal
effect(() => {
  if (nonces.value.length > 0) {
    const values = nonces.value;
    nonces.value = [];
    blockchain.found(values);
  }
});

async function parseContractTx(tx: Transaction, ref: string) {
  const stateScripts: [number, string][] = [];
  const burns: string[] = [];
  const messages: string[] = [];

  tx.outputs.forEach((o, i) => {
    const hex = o.script.toHex();
    const dmint = parseDmintScript(hex);
    if (dmint) {
      return stateScripts.push([i, dmint]);
    }

    const burn = parseBurnScript(hex);
    if (burn) {
      if (burn === ref) {
        burns.push(burn);
      }
      return;
    }

    const msg = parseMessageScript(hex);
    if (msg) {
      // Truncate messages to 80 characters
      messages.push(msg.substring(0, 80));
    }
  });

  const message = messages[0] || "";

  // State script:
  // height OP_PUSHINPUTREF contractRef OP_PUSHINPUTREF tokenRef maxHeight reward target
  const contracts = stateScripts
    .map(([outputIndex, script]) => {
      const opcodes = Script.fromHex(script).toASM().split(" ");
      const [op1, contractRef] = opcodes.splice(1, 2);
      const [op2, tokenRef] = opcodes.splice(1, 2);

      if (
        op1 !== "OP_PUSHINPUTREFSINGLETON" ||
        op2 !== "OP_PUSHINPUTREF" ||
        contractRef !== ref
      ) {
        return;
      }

      const numbers = opcodes.map(opcodeToNum).filter((v) => v !== false);
      if (numbers.length < 4) {
        return;
      }

      const [height, maxHeight, reward, target] = numbers as bigint[];
      return {
        state: "active",
        params: {
          location: tx.id,
          outputIndex,
          height,
          contractRef,
          tokenRef,
          maxHeight,
          reward,
          target,
          script,
          message,
        },
      };
    })
    .filter(Boolean) as { state: "active"; params: Contract }[];

  if (!contracts.length) {
    if (burns.length) {
      return {
        state: "burn" as const,
        ref,
        params: { message },
      };
    }
    console.debug("dmint contract not found");
    return;
  }

  return contracts[0];
}

async function fetchToken(contractRef: string) {
  if (!isRef(contractRef)) {
    console.debug("Not a ref");
    return;
  }

  console.debug(`Fetching ${contractRef}`);
  const refLe = reverseRef(contractRef);

  const refTxids = await fetchRef(contractRef);
  if (!refTxids.length) {
    console.debug("Ref not found:", contractRef);
    return;
  }

  const revealTxid = refTxids[0].tx_hash;
  const revealTx = await fetchTx(revealTxid, false);
  const revealParams = await parseContractTx(revealTx, refLe);

  if (!revealParams || revealParams.state === "burn") {
    return;
  }

  // TODO pick random location that still has tokens available

  const locTxid = refTxids[1].tx_hash;
  const fresh = revealTxid === locTxid;
  const locTx = fresh ? revealTx : await fetchTx(locTxid, true);
  const locParams = fresh ? revealParams : await parseContractTx(locTx, refLe);
  if (!locParams) {
    return;
  }
  const currentParams =
    locParams.state === "burn"
      ? {
          ...revealParams.params,
          height: revealParams.params.maxHeight,
          message: locParams.params.message,
        }
      : locParams.params;

  // Find token script in the reveal tx
  const tokenRefBE = swapEndianness(currentParams.tokenRef);
  const refTxId = tokenRefBE.substring(8);
  const refVout = parseInt(tokenRefBE.substring(0, 8), 10);
  const revealIndex = revealTx.inputs.findIndex(
    (input) =>
      input.prevTxId.toString("hex") === refTxId &&
      input.outputIndex === refVout
  );
  const script = revealIndex >= 0 && revealTx.inputs[revealIndex].script;

  if (!script) {
    console.debug("Glyph script not found");
    return;
  }

  const glyph = decodeGlyph(script);

  if (!glyph) {
    console.debug("Invalid glyph script");
    return;
  }

  return { glyph, contract: currentParams };
}

let subscriptionStatus = "";
let subscriptionCheckTimer: ReturnType<typeof setTimeout>;
let lastMintSubscriptionStatus = "";

async function claimTokens(
  contract: Contract,
  work: Work,
  nonce: string
): Promise<
  { success: true; txid: string } | { success: false; reason: string }
> {
  if (!wallet.value) return { success: false, reason: "" };

  const newHeight = contract.height + 1n;
  const lastMint = newHeight === contract.maxHeight;
  const inputScriptHash = bytesToHex(sha256(sha256(work.inputScript)));
  const outputScriptHash = bytesToHex(sha256(sha256(work.outputScript)));

  const scriptSig = Script.fromASM(
    `${nonce} ${inputScriptHash} ${outputScriptHash} 0`
  );

  const tx = new Transaction();
  tx.feePerKb(FEE_PER_KB);
  const p2pkh = Script.fromAddress(wallet.value.address).toHex();
  const ft = `${Script.fromAddress(mineToAddress.value).toHex()}bdd0${
    contract.tokenRef
  }dec0e9aa76e378e4a269e69d`;
  const privKey = wallet.value.privKey;
  const reward = Number(contract.reward);

  tx.addInput(
    new Transaction.Input({
      prevTxId: contract.location,
      outputIndex: contract.outputIndex,
      script: new Script(),
      output: new Transaction.Output({
        script: contract.script,
        satoshis: 1,
      }),
    })
  );

  // @ts-expect-error ...
  tx.setInputScript(0, () => scriptSig);

  // Consolidate all UTXOs
  utxos.value.forEach((utxo) => {
    tx.from({
      txId: utxo.tx_hash,
      outputIndex: utxo.tx_pos,
      script: p2pkh,
      satoshis: utxo.value,
    });
  });

  if (lastMint) {
    const burn = burnScript(contract.contractRef);
    tx.addOutput(
      new Transaction.Output({
        satoshis: 0,
        script: burn,
      })
    );
  } else {
    const dmint = dMintScript({
      ...contract,
      height: contract.height + 1n,
    });
    tx.addOutput(
      new Transaction.Output({
        satoshis: 1,
        script: dmint,
      })
    );
  }

  tx.addOutput(
    new Transaction.Output({
      satoshis: reward,
      script: ft,
    })
  );

  // Output script is message
  tx.addOutput(
    new Transaction.Output({
      satoshis: 0,
      script: bytesToHex(work.outputScript),
    })
  );
  tx.change(wallet.value.address);
  tx.sign(privKey);
  tx.seal();
  const hex = tx.toString();
  try {
    console.debug("Broadcasting", hex);
    const txid = (await broadcast(hex)) as string;
    console.debug(`txid ${txid}`);

    // Update UTXOs so if there's a mint before subscription updates it can be funded
    // Set a timer that will refresh wallet in case tx was replaced and no subscription received
    startSubscriptionCheckTimer();
    const changeOutputIndex = tx.outputs.length - 1;
    utxos.value = [
      {
        tx_hash: txid,
        tx_pos: changeOutputIndex,
        value: tx.outputs[changeOutputIndex].satoshis,
      },
    ];

    // Also update balance so low balance message can be shown if needed
    balance.value = utxos.value.reduce((a, { value }) => a + value, 0);

    return { success: true, txid };
  } catch (error) {
    console.debug("Broadcast failed", error);

    const msg = ((error as Error).message || "").toLowerCase();

    const isMissingInputs = msg.includes("missing inputs");
    const isFeeNotMet =
      msg.includes("min relay fee not met") ||
      msg.includes("bad-txns-in-belowout");
    const isConflict = msg.includes("txn-mempool-conflict");
    const isContractFail = msg.includes("mandatory-script-verify-flag-failed");

    let reason = "";

    if (isMissingInputs) {
      // This should be caught by subscription and subscriptionCheckTimer, but handle here in case
      reason = "missing inputs";
      console.debug("Missing inputs, updating unspent");
      // Stop miner and wait for UTXOs to update
      clearTimeout(subscriptionCheckTimer);
      miner.stop();
      updateUnspent().then(() => {
        miner.start();
      });
    } else if (isFeeNotMet) {
      // Stop mining if fees can't be paid
      reason = "fee not met";
      miner.stop();
      addMessage({ type: "stop" });
    } else if (isConflict) {
      reason = "mempool conflict";
    } else if (isContractFail) {
      // If this happens then either UTXOs or work need updating
      reason = "contract execution failed";
      miner.stop();
      await updateUnspent().then(() => {
        miner.start();
        miningStatus.value = "change";
      });
    }

    return { success: false, reason };
  }
}

// Sometimes a tx might not get mined and no subscription status is received
// Set a timer to check if subscription changed after mint
function startSubscriptionCheckTimer() {
  lastMintSubscriptionStatus = subscriptionStatus;
  clearTimeout(subscriptionCheckTimer);
  subscriptionCheckTimer = setTimeout(() => {
    if (lastMintSubscriptionStatus === subscriptionStatus && wallet.value) {
      console.debug("No subscription received. Updating unspent.");
      updateUnspent();
    }
  }, 10000);
}

const updateUnspent = async () => {
  if (wallet.value) {
    const p2pkh = base58AddressToLockingBytecode(wallet.value?.address);
    if (typeof p2pkh !== "string") {
      const sh = scriptHash(p2pkh.bytecode);

      console.debug("updateUnspent", sh);
      const response = (await client.request(
        "blockchain.scripthash.listunspent",
        sh
      )) as Utxo[];
      if (response) {
        balance.value = response.reduce((a, { value }) => a + value, 0);
        utxos.value = response;
      }
    }
  }
};

export function subscribeToAddress() {
  console.debug("Subscribing to address");
  const address = wallet.value?.address;
  if (!address) {
    return;
  }

  const p2pkh = base58AddressToLockingBytecode(address);
  if (typeof p2pkh !== "string") {
    console.debug(`Address set to ${address}`);

    const sh = scriptHash(p2pkh.bytecode);
    client.subscribe(
      "blockchain.scripthash",
      (_, newStatus: unknown) => {
        if (newStatus !== subscriptionStatus) {
          console.debug(`Status received ${newStatus}`);
          updateUnspent();
          subscriptionStatus = newStatus as string;
        }
      },
      sh
    );
  }
}

export async function sweepWallet(): Promise<
  { success: true; txid: string } | { success: false; reason: string }
> {
  if (!wallet.value || !mineToAddress.value)
    return { success: false, reason: "" };
  console.debug(`Sweeping ${wallet.value.address} to ${mineToAddress.value}`);

  const tx = new Transaction();
  tx.feePerKb(FEE_PER_KB);
  const from = Script.buildPublicKeyHashOut(wallet.value.address).toHex();
  const privKey = wallet.value.privKey;

  utxos.value.forEach((utxo) => {
    tx.from({
      txId: utxo.tx_hash,
      outputIndex: utxo.tx_pos,
      script: from,
      satoshis: utxo.value,
    });
  });
  tx.change(mineToAddress.value);
  tx.sign(privKey);
  const hex = tx.toString();
  try {
    const txid = await broadcast(hex);
    return { success: true, txid: txid as string };
  } catch (error) {
    const msg = (error as Error).message || "";
    return { success: false, reason: msg };
  }
}

// Temporary replacement for fetchContractUtxos
async function fetchCuratedContracts(): Promise<[string, number][]> {
  try {
    const response = await fetch(contractsUrl.value);
    if (!response.ok) {
      return [];
    }
    return (await response.json()) as [string, number][];
  } catch {
    return [];
  }
}

// Needs improvement to remove spam
/*
async function fetchContractUtxos() {
  const cache = await localforage.getItem("unspent");
  if (cache) {
    return cache as Utxo[];
  }

  const unspent = (
    (await client.request(
      "blockchain.codescripthash.listunspent",
      "e8ed45cef15052dbe4b53274cd10a4c55c4065505cbb3420b6d1da20c365dad1" // SHA-256 of mining contract
    )) as Utxo[]
  ).filter(
    (u) => u.refs?.length === 2 && u.refs[0].type === "single" && u.refs[1].type
  );

  localforage.setItem("unspent", unspent);
  return unspent;
}
*/

async function fetchTx(txid: string, fresh: boolean) {
  const cached = fresh ? undefined : await localforage.getItem<string>(txid);
  if (cached) {
    return new Transaction(cached);
  }
  const hex = await client.request("blockchain.transaction.get", txid);
  localforage.setItem(txid, hex);
  return new Transaction(hex);
}

async function broadcast(hex: string) {
  return await client.request("blockchain.transaction.broadcast", hex);
}

async function fetchRef(ref: string) {
  const ids = (await client.request("blockchain.ref.get", ref)) as {
    tx_hash: string;
  }[];
  if (ids.length) {
    return [ids[0], ids[ids.length - 1]];
  }
  return [];
}

const RESULTS_PER_PAGE = 10;
export async function fetchDeployments(
  onProgress: (n: number) => undefined = () => undefined,
  page = 0,
  refresh = false
): Promise<{ contractGroups: ContractGroup[]; pages: number }> {
  if (refresh) {
    await localforage.clear();
  }

  const allKey = "tokens";
  const cacheKey = `tokens-${page}`;
  const pageCache = await localforage.getItem(cacheKey);
  if (pageCache) {
    const contractAddresses = await localforage.getItem<string[]>(allKey);
    if (contractAddresses?.length) {
      const pages = Math.ceil(contractAddresses.length / RESULTS_PER_PAGE);

      // Get each cached group
      const firstRefs = pageCache as string[];
      const contractGroups = (
        await Promise.all(
          firstRefs.map((firstRef) =>
            localforage.getItem<ContractGroup>(`contractGroup.${firstRef}`)
          )
        )
      ).filter(Boolean) as ContractGroup[];

      return { contractGroups, pages };
    }
  }

  // TODO implement pagination in ElectrumX
  const all =
    (await localforage.getItem<[string, number][]>(allKey)) ||
    (await fetchCuratedContracts());
  const contractAddresses = all.slice(
    page * RESULTS_PER_PAGE,
    (page + 1) * RESULTS_PER_PAGE
  );

  const expanded = contractAddresses.flatMap(([singleton, numContracts]) => {
    const txid = singleton.slice(0, 64);
    const vout = parseInt(singleton.slice(65), 16);

    return new Array(numContracts).fill(undefined).map((_, i) => {
      // Add to vout and convert short format to big endian hex
      const buf = Buffer.alloc(36);
      buf.write(txid, 0, 32, "hex");
      buf.writeUInt32BE(vout + i, 32);
      // Save firstVout so we can group by first ref later
      return { firstVout: vout, singleton: buf.toString("hex") };
    });
  });

  const batches = arrayChunks(expanded, 4);
  const contracts: { firstVout: number; token: Token }[] = [];
  let progress = 1;

  // Fetch in batches
  for (const batch of batches) {
    contracts.push(
      ...((
        await Promise.all(
          batch.map(async ({ firstVout, singleton }) => {
            const cachedToken = await localforage.getItem<Token>(singleton);
            const token = cachedToken || (await fetchToken(singleton));
            onProgress((++progress / expanded.length) * 100);
            if (token) {
              localforage.setItem(singleton, token);
              return { firstVout, token };
            }
            return undefined;
          })
        )
      ).filter(Boolean) as { firstVout: number; token: Token }[])
    );
  }

  // Build contract groups
  const contractGroups = new Map<string, ContractGroup>();
  contracts.forEach(({ firstVout, token: contract }) => {
    const txid = contract.contract.contractRef.substring(0, 64);
    // Group by the first ref
    const buf = Buffer.alloc(36);
    buf.write(swapEndianness(txid), 0, 32, "hex");
    buf.writeUInt32BE(firstVout, 32);
    const firstRef = buf.toString("hex");

    if (!contractGroups.has(firstRef)) {
      contractGroups.set(firstRef, {
        glyph: contract.glyph,
        summary: {
          numContracts: 0,
          totalSupply: 0n,
          mintedSupply: 0n,
        },
        contracts: [],
      });
    }
    const token = contractGroups.get(firstRef);
    if (token) {
      token.contracts.push(contract.contract);
      token.summary.numContracts++;
      token.summary.totalSupply +=
        contract.contract.maxHeight * contract.contract.reward;
      token.summary.mintedSupply +=
        contract.contract.height * contract.contract.reward;
    }
  });

  // Cache page refs and contract groups
  for (const [firstRef, g] of contractGroups) {
    localforage.setItem(`contractGroup.${firstRef}`, g);
  }
  const firstRefs = [...contractGroups.keys()];
  localforage.setItem(cacheKey, firstRefs);

  const pages = Math.ceil(all.length / RESULTS_PER_PAGE);
  return { contractGroups: [...contractGroups.values()], pages };
}

export async function getCachedTokenContracts(firstRef: string) {
  return await localforage.getItem<ContractGroup>(`contractGroup.${firstRef}`);
}

function parseDmintScript(script: string): string {
  const pattern =
    /^(.*)bd5175c0c855797ea8597959797ea87e5a7a7eaabc01147f77587f040000000088817600a269a269577ae500a069567ae600a06901d053797e0cdec0e9aa76e378e4a269e69d7eaa76e47b9d547a818b76537a9c537ade789181547ae6939d635279cd01d853797e016a7e886778de519d547854807ec0eb557f777e5379ec78885379eac0e9885379cc519d75686d7551$/;
  const [, stateScript] = script.match(pattern) || [];
  return stateScript;
}

function parseBurnScript(script: string): string {
  const pattern = /^d8([0-9a-f]{64}[0-9]{8})6a$/;
  const [, ref] = script.match(pattern) || [];
  return ref;
}

function parseMessageScript(script: string): string {
  const pattern = /^6a036d7367(.*)$/;
  const [, msg] = script.match(pattern) || [];
  if (!msg) return "";

  const chunks = new Script(msg).chunks as {
    opcodenum: number;
    buf?: Uint8Array;
  }[];

  if (chunks.length === 0 || !chunks[0].buf || chunks[0].buf.byteLength === 0) {
    return "";
  }

  return new TextDecoder().decode(chunks[0].buf);
}

function opcodeToNum(n: string) {
  if (n.startsWith("OP_")) {
    const num = pushNumberOpcodeToNumber(Opcodes[n as keyof typeof Opcodes]);
    if (num === false) return false;
    return BigInt(num);
  }

  const num = vmNumberToBigInt(hexToBytes(n), {
    requireMinimalEncoding: false,
  });

  if (typeof num === "bigint") {
    return num;
  }

  return false;
}

function dMintScript({
  height,
  contractRef,
  tokenRef,
  maxHeight,
  reward,
  target,
}: Contract) {
  return `${push4bytes(
    Number(height)
  )}d8${contractRef}d0${tokenRef}${pushMinimal(maxHeight)}${pushMinimal(
    reward
  )}${pushMinimal(
    target
  )}bd5175c0c855797ea8597959797ea87e5a7a7eaabc01147f77587f040000000088817600a269a269577ae500a069567ae600a06901d053797e0cdec0e9aa76e378e4a269e69d7eaa76e47b9d547a818b76537a9c537ade789181547ae6939d635279cd01d853797e016a7e886778de519d547854807ec0eb557f777e5379ec78885379eac0e9885379cc519d75686d7551`;
}

function burnScript(ref: string) {
  return `d8${ref}6a`;
}

// Push a positive number as a 4 bytes little endian
function push4bytes(n: number) {
  return bytesToHex(encodeDataPush(numberToBinUint32LEClamped(n)));
}

// Push a number with minimal encoding
function pushMinimal(n: bigint | number) {
  return bytesToHex(encodeDataPush(bigIntToVmNumber(BigInt(n))));
}

export class Blockchain {
  nonces: string[] = [];
  ready: boolean = true;
  subscriptionStatus?: string;

  found(values: string[]) {
    this.nonces.push(...values);

    if (this.ready) {
      this.submit();
    }
  }

  async submit() {
    console.debug("Submitting");
    const nonce = this.nonces.pop();

    if (!contract.value || !work.value || !nonce) {
      return;
    }

    this.ready = false;

    const result = await claimTokens(contract.value, work.value, nonce);
    if (result.success) {
      const { txid } = result;
      accepted.value++;
      this.nonces = [];
      this.ready = true;
      addMessage({
        type: "accept",
        nonce,
        msg: mintMessage.value || "",
        txid,
      });

      // Set the new location now instead of waiting for the subscription
      const height = contract.value.height + 1n;
      if (height === contract.value.maxHeight) {
        // Stop mining. The "minted out" message will be sent after subscription is received
        miningStatus.value = "stop";
      } else {
        console.debug(`Changed location to ${txid}`);
        contract.value = {
          ...contract.value,
          height,
          location: txid,
          outputIndex: 0,
        };
        miningStatus.value = "change";
      }

      if (balance.value < 0.0001 + Number(contract.value.reward) / 100000000) {
        addMessage({ type: "general", msg: "Balance is low" });
        miner.stop();
        addMessage({ type: "stop" });
      }
    } else {
      addMessage({
        type: "reject",
        nonce,
        reason: result.reason,
      });

      rejected.value++;
      if (this.nonces.length) {
        // Failed, try next nonce if there is one
        this.submit();
      } else {
        this.ready = true;
      }
    }
  }

  async changeToken(ref: string) {
    loadingContract.value = true;
    // Unsubscribe from current subscription
    if (work.value?.contractRef) {
      console.debug(
        `Unsubscribing from current contract ${bytesToHex(
          work.value?.contractRef
        )}`
      );
      const sh = scriptHash(work.value?.contractRef);
      // This will cause an error "unsubscribe is unknown method" but seems to work anyway
      client.unsubscribe("blockchain.scripthash", sh);
    }

    const token = await fetchToken(ref);
    loadingContract.value = false;

    if (!token) {
      addMessage({ type: "not-found", ref });
      return;
    }

    contract.value = token.contract;
    glyph.value = token.glyph;
    updateWork();

    if (token.contract.height === token.contract.maxHeight) {
      addMessage({ type: "minted-out", ref, msg: token.contract.message });
      return;
    }

    addMessage({ type: "loaded", ref, msg: token.contract.message });

    if (balance.value < 0.01) {
      addMessage({
        type: "general",
        msg: "Balance is low. Please fund wallet to start mining.",
      });
    }

    if (miningStatus.value === "mining") {
      miningStatus.value = "change";
    }

    // Subscribe to the singleton so we know when the contract moves
    // Change ref to little-endian
    const refLe = reverseRef(ref);
    const sh = scriptHash(hexToBytes(refLe));
    client.subscribe(
      "blockchain.scripthash",
      async (_, status) => {
        if (status !== this.subscriptionStatus) {
          const ids = await fetchRef(ref);
          const location = ids[1]?.tx_hash;
          if (contract.value && location !== contract.value?.location) {
            console.debug(`New contract location ${location}`);
            //contract.value.location = location;
            const locTx = await fetchTx(location, true);
            const parsed = await parseContractTx(locTx, refLe);

            if (parsed?.state && parsed.params.message) {
              addMessage({
                type: "new-location",
                txid: location,
                msg: parsed.params.message,
              });
            }

            if (parsed?.state === "active") {
              contract.value = parsed.params;
              if (miningStatus.value === "mining") {
                miningStatus.value = "change";
              }
            } else if (parsed?.state === "burn") {
              miner.stop();
              addMessage({
                type: "minted-out",
                ref: reverseRef(contract.value.contractRef),
              });

              // No contract data exists in burn output so use existing data and set height to max
              contract.value = {
                ...contract.value,
                height: contract.value.maxHeight,
              };
            }
          }
          this.subscriptionStatus = status as string;
        }
      },
      sh
    );

    return { contract, glyph };
  }
}

export const blockchain = new Blockchain();
