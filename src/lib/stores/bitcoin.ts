import type { AMRAuction, Rocket } from '@/event_helpers/rockets';
import validate from 'bitcoin-address-validation';
import { get, writable } from 'svelte/store';

type BitcoinTip = {
	height: number;
	hash: string;
};

let _b: BitcoinTip = { hash: '', height: 0 };
export const bitcoinTip = writable(_b);

export function BitcoinTipTag(): string[] {
	let tip = get(bitcoinTip);
	let bths: string[] = ['bitcoin', ''];
	if (tip.hash && tip.height) {
		bths = ['bitcoin', tip.height.toString() + ':' + tip.hash];
	}
	return bths;
}

export async function getBitcoinTip() {
	getBitcoinTipBlockstream();
	getBitcoinTipMempool();
}

async function getBitcoinTipBlockstream() {
	try {
		const response = await fetch('https://blockstream.info/api/blocks/tip');
		const _json = await response.json();
		if (_json[0]) {
			let r: BitcoinTip = {
				height: _json[0].height,
				hash: _json[0].id
			};
			if (r.hash && r.height) {
				bitcoinTip.set(r);
				return r;
			}
		}
	} catch {
		return null;
	}
	return null;
}

async function getBitcoinTipMempool() {
	try {
		const response = await fetch('https://mempool.space/api/blocks/tip');
		const _json = await response.json();
		if (_json[0]) {
			let r: BitcoinTip = {
				height: _json[0].height,
				hash: _json[0].id
			};
			if (r.hash && r.height) {
				bitcoinTip.set(r);
				return r;
			}
		}
	} catch {
		return null;
	}
	return null;
}

export async function getBalance(address: string): Promise<number> {
	return new Promise((resolve, reject) => {
		if (!validate(address)) {
			reject('invalid address');
		} else {
			try {
				fetch(`https://blockstream.info/api/address/${address}`)
					.then((response) => {
						if (!response.ok) {
							reject('invalid response from server');
						} else {
							response
								.json()
								.then((j) => {
									let spent = parseInt(j.chain_stats.spent_txo_sum, 10);
									let funded = parseInt(j.chain_stats.funded_txo_sum, 10);
									resolve(funded - spent);
								})
								.catch((x) => reject(x));
						}
					})
					.catch((x) => {
						reject(x);
					});
			} catch {
				reject('failed');
			}
		}
	});
}

export async function getIncomingTransactions(address: string): Promise<JSON> {
	return new Promise((resolve, reject) => {
		if (!validate(address)) {
			reject('invalid address');
		} else {
			try {
				fetch(`https://mempool.space/api/address/${address}/txs`)
					.then((response) => {
						if (!response.ok) {
							reject('invalid response from server');
						} else {
							response
								.json()
								.then((j) => {
									resolve(j);
								})
								.catch((x) => reject(x));
						}
					})
					.catch((x) => {
						reject(x);
					});
			} catch {
				reject('failed');
			}
		}
	});
}

export class txs {
	Address: string;
	LastUpdate: number;
	LastAttempt: number;
	Data: JSON;
	From(): Map<string, txo> {
		let possibles = new Map<string, txo>();
		for (let tx of this.Data) {
			let amount = 0;
			let height = tx.status.block_height ? tx.status.block_height : 0;
			let txid = tx.txid;
			let change: string[] = [];
			for (let vout of tx.vout) {
				let address = vout.scriptpubkey_address;
				if (address && address.trim() == this.Address) {
					let value = vout.value;
					if (value) {
						amount += parseInt(value, 10);
					}
				} else {
					change.push(address);
				}
			}

			for (let vin of tx.vin) {
				let address = vin.prevout.scriptpubkey_address;
				if (address && validate(address)) {
					let t = new txo();
					t.Amount = amount;
					t.Height = height;
					t.From = address;
					t.To = this.Address;
					t.ID = txid;
					if (change.length == 1) {
						t.Change = change[0];
					}
					possibles.set(address, t);
				} else {
					console.log(156, vin);
				}
			}
		}
		return possibles;
	}
	constructor(address: string) {
		this.Address = address.trim();
		this.LastUpdate = 0;
		this.LastAttempt = 0;
		this.Data = JSON.parse('[]');
	}
}

export class txo {
	ID: string;
	From: string;
	To: string;
	Amount: number;
	Height: number;
	Change: string;
	constructor() {}
}

interface PendingSales {
	mainnet: Map<Rocket, AMRAuction[]>;
	testnet: Map<Rocket, AMRAuction[]>;
}

export const transactions = createTransactionsStore();

export function createTransactionsStore() {
	const { subscribe, update } = writable(new Map<string, txs>());

	async function updateTransactionForAddress(address: string, transactions: Map<string, txs>) {
		if (!transactions.has(address)) {
			transactions.set(address, new txs(address));
		}
		let existingTx = transactions.get(address)!;
		const currentTime = Math.floor(Date.now() / 1000);

		if (currentTime > existingTx.LastAttempt + 3) {
			existingTx.LastAttempt = currentTime;
			try {
				const result = await getIncomingTransactions(address);
				if (result) {
					existingTx.LastUpdate = Math.floor(Date.now() / 1000);
					if (result.length > 0) {
						existingTx.Data = result;
						return true;
					}
				}
			} catch (error) {
				console.error(`Error fetching transactions for ${address}:`, error);
			}
		}
		return false;
	}

	async function processNetwork(
		network: 'mainnet' | 'testnet',
		pendingSales: PendingSales,
		transactions: Map<string, txs>
	) {
		let hasUpdates = false;
		for (let [_, sales] of pendingSales[network]) {
			for (let amr of sales) {
				if (await updateTransactionForAddress(amr.RxAddress, transactions)) {
					hasUpdates = true;
				}
			}
		}
		return hasUpdates;
	}

	return {
		subscribe,
		updateTransactions: async (pendingSales: PendingSales) => {
			let hasUpdates = false;
			await update((transactions) => {
				processNetwork('mainnet', pendingSales, transactions).then((updated) => {
					if (updated) hasUpdates = true;
				});
				processNetwork('testnet', pendingSales, transactions).then((updated) => {
					if (updated) hasUpdates = true;
				});
				return transactions;
			});
			if (hasUpdates) {
				update((transactions) => transactions);
			}
		}
	};
}
