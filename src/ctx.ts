import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { DfsClient } from "./dfs/client.ts";

export type Ctx = { db: Db; dfs: DfsClient; config: Config };
