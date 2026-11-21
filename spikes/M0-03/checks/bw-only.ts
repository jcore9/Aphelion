import { BitwardenClient } from "@bitwarden/sdk-napi";
try { await new BitwardenClient().auth().loginAccessToken("0.x.fake:fake"); } catch (e) { console.log("bitwarden loaded:", String((e as Error).message).slice(0, 60)); }
