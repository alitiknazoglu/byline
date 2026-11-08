// Local relayer for development and testnet: the same logic as apps/web/api/register.ts.
//   npm run relayer            → http://localhost:8787/register   (POST signRegistration() output)
//                                http://localhost:8787/status     (sponsor quota)
// Env (.env): RELAYER_NETWORK (default testnet), RELAYER_TESTNET_KEY or RELAYER_MAINNET_KEY,
// optional RELAYER_POW_BITS (default 20) and UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
import http from "node:http";
import { Relayer, memoryRateStore, upstashRateStore } from "../packages/sdk/dist/relay.js";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {}

const network = process.env.RELAYER_NETWORK ?? "testnet";
const privateKey = network === "mainnet" ? process.env.RELAYER_MAINNET_KEY : process.env.RELAYER_TESTNET_KEY;
if (!privateKey) {
  console.error(`Set RELAYER_${network.toUpperCase()}_KEY in .env (a function-call key on the registry limited to register_signed).`);
  process.exit(1);
}
const { UPSTASH_REDIS_REST_URL: upUrl, UPSTASH_REDIS_REST_TOKEN: upToken, RELAYER_POW_BITS: powEnv } = process.env;
const relayer = new Relayer({
  network,
  privateKey,
  registryId: process.env.REGISTRY_CONTRACT_ID || undefined,
  rateStore: upUrl && upToken ? upstashRateStore(upUrl, upToken) : memoryRateStore(),
  powBits: powEnv === undefined ? undefined : Number(powEnv),
});
const port = Number(process.env.RELAYER_PORT ?? 8787);

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
  res.end(JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return send(res, 204, null);
      if (req.method === "GET" && req.url?.startsWith("/status")) {
        return send(res, 200, { network, registry: relayer.registry.contractId, sponsored: await relayer.registry.getSponsorStatus(), pow_bits: relayer.powBits });
      }
      if (req.method === "POST" && req.url?.startsWith("/register")) {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {}
        const r = await relayer.handle(body, req.socket.remoteAddress ?? "unknown");
        console.log(`${new Date().toISOString()} ${r.status} ${r.body.code ?? r.body.error}`);
        return send(res, r.status, r.body);
      }
      send(res, 404, { error: "POST /register or GET /status" });
    } catch (e) {
      send(res, 500, { error: String(e?.message ?? e) });
    }
  })
  .listen(port, () => console.log(`byline relayer on http://localhost:${port} (${network}, registry ${relayer.registry.contractId}, proof-of-work ${relayer.powBits} bits)`));
