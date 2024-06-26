import { effect, signal } from "@preact/signals-react";
import { Contract, Glyph, Message, Utxo, Wallet, Work } from "./types";
import { calcTimeToMine } from "./pow";
import { addMessage } from "./message";

export const servers = signal<string[]>([]);
export const messages = signal<Message[]>([]);
export const hashrate = signal(0);
export const found = signal(0);
export const accepted = signal(0);
export const rejected = signal(0);
export const wallet = signal<Wallet | undefined>(undefined);
export const balance = signal(0);
export const utxos = signal<Utxo[]>([]);
export const gpu = signal<string | undefined>(""); // undefined means unsupported
export const selectedContract = signal("");
export const contract = signal<Contract | undefined>(undefined);
export const glyph = signal<Glyph | undefined>(undefined);
export const work = signal<Work | undefined>(undefined);
export const miningEnabled = signal(false); // The user requested state of the miner
export const miningStatus = signal<"stop" | "change" | "mining" | "ready">( // The actual state of the miner
  "ready"
);
export const loadingContract = signal(false);

// Settings
export const mineToAddress = signal("");
export const mintMessage = signal("");
export const hideMessages = signal(false);
export const contractsUrl = signal("");

let timer = 0;
let done = false;

effect(() => {
  if (done) return;
  if (miningStatus.value === "mining") {
    timer = window.setTimeout(() => {
      if (contract.value) {
        done = true;
        addMessage({
          type: "mint-time",
          seconds: calcTimeToMine(contract.value.target, hashrate.value),
        });
      }
    }, 10000);
  } else {
    clearTimeout(timer);
  }
});
