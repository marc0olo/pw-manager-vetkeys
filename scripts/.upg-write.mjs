import { execSync } from "node:child_process";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { DefaultEncryptedMapsClient, EncryptedMaps } from "@icp-sdk/vetkeys/encrypted_maps";
import { idlFactory } from "../src/bindings/declarations/backend.did.js";
const st = JSON.parse(execSync("icp network status --json", { encoding: "utf-8" }));
const cid = execSync("icp canister status backend --id-only", { encoding: "utf-8" }).trim();
const rootKey = Uint8Array.from(Buffer.from(st.root_key, "hex"));
const enc = new TextEncoder(), dec = new TextDecoder();
// Fixed seed so the same principal can read this back after the upgrade.
const id = Ed25519KeyIdentity.generate(new Uint8Array(32).fill(7));
const agent = await HttpAgent.create({ identity: id, host: st.api_url, rootKey });
const maps = new EncryptedMaps(new DefaultEncryptedMapsClient(agent, cid));
const api = Actor.createActor(idlFactory, { agent, canisterId: cid });
const me = id.getPrincipal(), N = enc.encode("Upgrade");
const buf = (t) => ({ inner: enc.encode(t) });

await maps.setValue(me, N, enc.encode("k1"), enc.encode("v1"));
await maps.setValue(me, N, enc.encode("k1"), enc.encode("v2"));   // supersedes v1 -> an event
await maps.setValue(me, N, enc.encode("k2"), enc.encode("trash me"));
await maps.removeEncryptedValue(me, N, enc.encode("k2"));          // -> trash
console.log("principal:", me.toText());
console.log("live k1:", dec.decode((await maps.getValuesForMap(me, N)).find(([k]) => dec.decode(k) === "k1")[1]));
console.log("events for k1:", (await api.get_history(me, buf("Upgrade"), buf("k1"))).Ok.length);
console.log("trash rows:", (await api.get_trash(me, buf("Upgrade"))).Ok.length);
