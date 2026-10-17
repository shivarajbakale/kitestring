#!/usr/bin/env node
import { main } from "./commands.js"

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
})
