#!/usr/bin/env node
import "./warnings.js";
import { runCLI } from "./index.js";
process.exitCode = await runCLI(process.argv.slice(2));
