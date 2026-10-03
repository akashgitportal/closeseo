import { startFakeDfs } from "./fake-dataforseo.ts";
const f = await startFakeDfs({ port: Number(process.env.PORT ?? 4010) });
console.log(`fake DataForSEO on ${f.url}  (credentials fake:fake -> DATAFORSEO_API_KEY=${Buffer.from("fake:fake").toString("base64")})`);
