import { readFileSync } from "node:fs";

export const PROTOCOL_VERSION = "2.0";
export const IMPLEMENTATION_VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
