#! /usr/bin/env node
const path = require("path");

require("ts-node").register({
  project: path.join(__dirname, "..", "scripts", "tsconfig.json"),
  dir: path.join(__dirname, ".."),
});
require("../scripts/index.ts");
